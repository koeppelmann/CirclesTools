// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {IHubV2} from "./IHubV2.sol";

/**
 * @title CirclesDollarAuctionHub
 * @notice A perpetual host for dollar-auction games played in a single Circles group currency.
 *
 *  The hub registers itself ONCE as a Circles organization and trusts exactly one group
 *  avatar, so it only ever accepts that group's Circles ("the accepted token"). It then runs
 *  an unbounded sequence of games in place — there is always at most one game live, and a
 *  pointer (`gameId`) to the current one.
 *
 *  ─────────────────────────── Starting a game ───────────────────────────
 *  Whenever no game is running (none yet, or the last one finished) ANYONE can start the
 *  next game by simply sending the accepted group CRC to this contract:
 *    • The amount becomes the prize pool (clamped to [MIN_SEED, MAX_SEED] = [10k, 1m] CRC;
 *      below MIN_SEED is refunded, above MAX_SEED the excess is refunded).
 *    • The sender becomes that game's `owner` (collects the per-bid fee).
 *    • Game parameters are read from the ERC-1155 transfer `data` as
 *      abi.encode(initialTimer, minTimer, bid):
 *        - initialTimer / minTimer ("start"/"end" bid windows): each in [5min, 1day], end<=start;
 *        - bid: a multiple of 10 wei, at most 1/10 of the seed.
 *      If `data` is empty (e.g. a plain wallet transfer that can't set it) sensible defaults
 *      are used (1h start, 5min end, bid = seed/100). Bad custom params refund the whole send.
 *
 *  ─────────────────────────── Playing a game ───────────────────────────
 *  Identical economics to the standalone CirclesDollarAuction: each bid splits 10% to the pool,
 *  10% to the game owner, 80% down a FIFO queue of 110%-claims, and mints the bidder a fresh
 *  110% claim. The timer decays geometrically per bid from `initialTimer` to `minTimer`. The
 *  last bidder wins the pool once the timer elapses; a bid that lands too late settles the game
 *  and is refunded. Payouts are pushed immediately, so the hub only ever holds the live pool.
 *
 *  Incorporates two fixes from the security audit of the standalone contract:
 *    M-1: in the late-bid path the late funds are refunded BEFORE settling, so they can never
 *         inflate the winner's prize under demurrage.
 *    L-1: recoverFailedCredit caps to the available balance instead of reverting.
 */
contract CirclesDollarAuctionHub {
    // ───────────────────────────── Config ─────────────────────────────

    IHubV2 public immutable HUB;
    address public immutable GROUP;
    uint256 public immutable ACCEPTED_ID; // uint256(uint160(GROUP))

    // Start-time bounds (the website surfaces these).
    uint256 public constant MIN_SEED = 10_000 ether; // minimum pool to start a game
    uint256 public constant MAX_SEED = 1_000_000 ether; // maximum pool
    uint256 public constant MIN_TIMER = 5 minutes; // timer floor / ceiling bounds
    uint256 public constant MAX_TIMER = 1 days;
    uint256 public constant RATIO_NUM = 948; // per-bid timer decay (≈13-bid half-life)
    uint256 public constant RATIO_DEN = 1000;

    // ───────────────────────────── Games ─────────────────────────────

    struct Game {
        address owner; // fee recipient = whoever funded this game
        uint256 bid; // bid size (multiple of 10 wei)
        uint256 initialTimer; // "start" window
        uint256 minTimer; // "end" window (floor)
        uint256 startingPrice; // seed = initial pool
        uint256 poolNominal; // nominal prize pool (demurrages while held)
        address lastBidder; // current leader / prospective winner
        uint256 lastBidTime;
        uint256 round; // bids placed in this game
        uint256 currentTimer; // window granted to the most recent bid
        uint256 head; // FIFO claim cursor
        uint256 headPaid; // amount paid into the head claim
        bool finished; // settled or reclaimed
        uint256 prize; // prize actually sent to the winner (for the UI after the fact)
    }

    uint256 public gameId; // current game id; 0 = none started yet
    mapping(uint256 => Game) public games;
    mapping(uint256 => address[]) private _claimants; // per-game FIFO claim queue

    // Fixed-size ring buffer of the last 5 bids of the CURRENT game (O(1); recentBids() bounds
    // its read by the current game's round, so stale slots from a prior game are never returned).
    address[5] private _rbAddr;
    uint40[5] private _rbTime;

    // Failed pushes (recipient refused the transfer); recoverable later. Global across games.
    mapping(address => uint256) public failedCredits;
    uint256 public totalFailedCredits;

    uint256 private _locked = 1;

    // ───────────────────────────── Events ─────────────────────────────

    event GameStarted(
        uint256 indexed gameId, address indexed owner, uint256 seed, uint256 bid, uint256 initialTimer, uint256 minTimer
    );
    event BidPlaced(
        uint256 indexed gameId, address indexed bidder, uint256 round, uint256 claimIndex, uint256 newTimer, uint256 poolNominal
    );
    event ClaimPaid(uint256 indexed gameId, address indexed claimant, uint256 claimIndex, uint256 amount);
    event OwnerPaid(uint256 indexed gameId, address indexed owner, uint256 amount);
    event Refunded(address indexed to, uint256 amount);
    event PushFailed(address indexed to, uint256 amount);
    event CreditRecovered(address indexed to, uint256 amount);
    event GameWon(uint256 indexed gameId, address indexed winner, uint256 prize, uint256 totalRounds);
    event SeedReclaimed(uint256 indexed gameId, address indexed owner, uint256 amount);

    // ───────────────────────────── Errors ─────────────────────────────

    error OnlyHub();
    error NotActive();
    error GameOver();
    error BelowBid();
    error NotOwner();
    error NoBids();
    error StillLive();
    error AlreadyStarted();
    error Reentrancy();
    error NothingToRecover();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    /**
     * @param _hub   Circles v2 Hub (Gnosis: 0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8).
     * @param _group The group avatar whose Circles are accepted.
     * @param _name  Org name registered on Circles (<=32 chars, NameRegistry charset).
     */
    constructor(address _hub, address _group, string memory _name) {
        HUB = IHubV2(_hub);
        GROUP = _group;
        ACCEPTED_ID = uint256(uint160(_group));
        HUB.registerOrganization(_name, bytes32(0));
        HUB.trust(_group, uint96(block.timestamp + 100 * 365 days));
    }

    // ───────────────────────────── ERC-1155 receiver ─────────────────────────────

    function onERC1155Received(address, address from, uint256 id, uint256 value, bytes calldata data)
        external
        nonReentrant
        returns (bytes4)
    {
        if (msg.sender != address(HUB)) revert OnlyHub();
        if (id != ACCEPTED_ID) revert OnlyHub(); // wrong token → revert, funds never move
        _handle(from, value, data);
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external nonReentrant returns (bytes4) {
        if (msg.sender != address(HUB)) revert OnlyHub();
        uint256 total;
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] != ACCEPTED_ID) revert OnlyHub();
            total += values[i];
        }
        _handle(from, total, data);
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x4e2312e0;
    }

    // ───────────────────────────── Core ─────────────────────────────

    function _handle(address from, uint256 value, bytes calldata data) internal {
        Game storage g = games[gameId];

        // Idle (nothing started yet, or the last game finished) → this send starts a new game.
        if (gameId == 0 || g.finished) {
            _startOrRefund(from, value, data);
            return;
        }

        // A game is live. If its deadline passed, this transfer arrived too late: refund the
        // sender FIRST (so the late funds can't inflate the prize under demurrage), then settle.
        if (g.round != 0 && block.timestamp >= g.lastBidTime + g.currentTimer) {
            _push(from, value);
            emit Refunded(from, value);
            _settle(gameId);
            return;
        }

        // Otherwise it's a bid. Below one bid → revert (funds never leave the sender).
        if (value < g.bid) revert BelowBid();
        uint256 excess = value - g.bid;
        if (excess != 0) {
            _push(from, excess);
            emit Refunded(from, excess);
        }
        _placeBid(gameId, from);
    }

    /// @dev Starts the next game from `value`, or refunds if it can't.
    function _startOrRefund(address from, uint256 value, bytes calldata data) internal {
        if (value < MIN_SEED) {
            // Not enough to start a game — bounce it back.
            _push(from, value);
            emit Refunded(from, value);
            return;
        }
        uint256 seed = value > MAX_SEED ? MAX_SEED : value;
        (uint256 it, uint256 mt, uint256 bid, bool ok) = _params(data, seed);
        if (!ok) {
            // Custom parameters were supplied but invalid — refund the whole send.
            _push(from, value);
            emit Refunded(from, value);
            return;
        }
        uint256 excess = value - seed; // refund anything above the max
        if (excess != 0) {
            _push(from, excess);
            emit Refunded(from, excess);
        }

        uint256 id = ++gameId;
        Game storage g = games[id];
        g.owner = from;
        g.bid = bid;
        g.initialTimer = it;
        g.minTimer = mt;
        g.startingPrice = seed;
        g.poolNominal = seed;
        g.currentTimer = it;
        emit GameStarted(id, from, seed, bid, it, mt);
    }

    /// @dev Decodes (initialTimer, minTimer, bid) from `data`, or returns defaults if `data` is
    /// empty. `ok` is false when custom params are present but out of bounds.
    function _params(bytes calldata data, uint256 seed)
        internal
        pure
        returns (uint256 it, uint256 mt, uint256 bid, bool ok)
    {
        if (data.length == 96) {
            (it, mt, bid) = abi.decode(data, (uint256, uint256, uint256));
            ok = it >= MIN_TIMER && it <= MAX_TIMER && mt >= MIN_TIMER && mt <= MAX_TIMER && mt <= it && bid > 0
                && bid % 10 == 0 && bid <= seed / 10;
        } else {
            // Defaults for plain transfers that can't carry calldata.
            it = 1 hours;
            mt = 5 minutes;
            bid = seed / 100; // ≤ seed/10
            bid -= bid % 10; // floor to a multiple of 10
            if (bid < 10) bid = 10;
            ok = true;
        }
    }

    function _placeBid(uint256 id, address bidder) internal {
        Game storage g = games[id];
        if (g.round != 0) {
            uint256 t = (g.currentTimer * RATIO_NUM) / RATIO_DEN;
            g.currentTimer = t < g.minTimer ? g.minTimer : t;
        }
        g.round += 1;
        g.lastBidder = bidder;
        g.lastBidTime = block.timestamp;

        uint256 slot = (g.round - 1) % 5;
        _rbAddr[slot] = bidder;
        _rbTime[slot] = uint40(block.timestamp);

        uint256 toPool = g.bid / 10;
        uint256 toOwner = g.bid / 10;
        g.poolNominal += toPool;

        _push(g.owner, toOwner);
        emit OwnerPaid(id, g.owner, toOwner);

        address[] storage cl = _claimants[id];
        uint256 claimIndex = cl.length;
        cl.push(bidder);
        emit BidPlaced(id, bidder, g.round, claimIndex, g.currentTimer, g.poolNominal);

        _payClaims(id, (g.bid * 8) / 10);
    }

    /// @dev Pays `budget` down the FIFO queue. Because TO_CLAIMS (0.8·bid) < CLAIM_SIZE (1.1·bid)
    /// and every bid adds 1.1·bid of capacity, the budget always fits and head never overruns the
    /// queue; touches at most two claims per bid (O(1)).
    function _payClaims(uint256 id, uint256 budget) internal {
        Game storage g = games[id];
        address[] storage cl = _claimants[id];
        uint256 claimSize = (g.bid * 11) / 10;
        while (budget != 0) {
            uint256 remaining = claimSize - g.headPaid;
            uint256 pay = remaining < budget ? remaining : budget;
            address claimant = cl[g.head];
            uint256 idx = g.head;
            if (pay == remaining) {
                g.head += 1;
                g.headPaid = 0;
            } else {
                g.headPaid += pay;
            }
            budget -= pay;
            _push(claimant, pay);
            emit ClaimPaid(id, claimant, idx, pay);
        }
    }

    function _push(address to, uint256 amt) internal {
        if (amt == 0) return;
        try HUB.safeTransferFrom(address(this), to, ACCEPTED_ID, amt, "") {}
        catch {
            failedCredits[to] += amt;
            totalFailedCredits += amt;
            emit PushFailed(to, amt);
        }
    }

    // ───────────────────────────── End game ─────────────────────────────

    /// @notice Settle the current game once its timer has elapsed. Permissionless.
    function claimPrize() external nonReentrant {
        Game storage g = games[gameId];
        if (gameId == 0) revert NotActive();
        if (g.finished) revert GameOver();
        if (g.round == 0) revert NoBids();
        if (block.timestamp < g.lastBidTime + g.currentTimer) revert StillLive();
        _settle(gameId);
    }

    function _settle(uint256 id) internal {
        Game storage g = games[id];
        g.finished = true;
        address winner = g.lastBidder;

        uint256 prize = g.poolNominal;
        uint256 bal = HUB.balanceOf(address(this), ACCEPTED_ID);
        uint256 withdrawable = bal > totalFailedCredits ? bal - totalFailedCredits : 0;
        if (prize > withdrawable) prize = withdrawable;
        g.poolNominal = 0;
        g.prize = prize;

        _push(winner, prize);
        emit GameWon(id, winner, prize, g.round);
    }

    /// @notice The owner of the current game can reclaim the seed if it was never bid on.
    function reclaimSeed() external nonReentrant {
        Game storage g = games[gameId];
        if (gameId == 0) revert NotActive();
        if (msg.sender != g.owner) revert NotOwner();
        if (g.round != 0) revert AlreadyStarted();
        if (g.finished) revert GameOver();
        g.finished = true;
        uint256 amount = g.poolNominal;
        g.poolNominal = 0;
        g.prize = amount;
        uint256 bal = HUB.balanceOf(address(this), ACCEPTED_ID);
        if (amount > bal) amount = bal;
        if (amount != 0) {
            HUB.safeTransferFrom(address(this), g.owner, ACCEPTED_ID, amount, "");
        }
        emit SeedReclaimed(gameId, g.owner, amount);
    }

    /// @notice Re-attempt a previously failed push. Caps to the available balance (audit L-1).
    function recoverFailedCredit(address to) external nonReentrant {
        uint256 amt = failedCredits[to];
        if (amt == 0) revert NothingToRecover();
        uint256 bal = HUB.balanceOf(address(this), ACCEPTED_ID);
        uint256 pay = amt > bal ? bal : amt;
        if (pay == 0) revert NothingToRecover();
        failedCredits[to] -= pay;
        totalFailedCredits -= pay;
        HUB.safeTransferFrom(address(this), to, ACCEPTED_ID, pay, "");
        emit CreditRecovered(to, pay);
    }

    // ───────────────────────────── Views ─────────────────────────────

    /// @notice True when there is no running game and the next send would start one.
    function canStart() public view returns (bool) {
        return gameId == 0 || games[gameId].finished;
    }

    /// @notice The last (up to) 5 bids of the current game, most-recent first. O(1).
    function recentBids() external view returns (address[] memory bidders, uint256[] memory times) {
        uint256 r = games[gameId].round;
        uint256 n = r < 5 ? r : 5;
        bidders = new address[](n);
        times = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 slot = (r - 1 - i) % 5;
            bidders[i] = _rbAddr[slot];
            times[i] = uint256(_rbTime[slot]);
        }
    }

    struct GameView {
        uint256 id;
        bool idle; // no running game → a send starts one
        bool finished;
        address owner;
        uint256 bid;
        uint256 claimSize; // 1.1·bid
        uint256 toClaims; // 0.8·bid
        uint256 startingPrice;
        address lastBidder;
        uint256 round;
        uint256 poolNominal;
        uint256 prize; // prize sent to winner (after settle)
        uint256 balance; // live (demurraged) contract balance
        uint256 lastBidTime;
        uint256 currentTimer;
        uint256 timeLeft;
        uint256 head;
        uint256 queueLength;
        uint256 initialTimer;
        uint256 minTimer;
    }

    /// @notice One-shot snapshot of the current game for the front-end.
    function currentGameInfo() external view returns (GameView memory v) {
        uint256 id = gameId;
        Game storage g = games[id];
        v.id = id;
        v.idle = canStart();
        v.finished = g.finished;
        v.owner = g.owner;
        v.bid = g.bid;
        v.claimSize = (g.bid * 11) / 10;
        v.toClaims = (g.bid * 8) / 10;
        v.startingPrice = g.startingPrice;
        v.lastBidder = g.lastBidder;
        v.round = g.round;
        v.poolNominal = g.poolNominal;
        v.prize = g.prize;
        v.balance = HUB.balanceOf(address(this), ACCEPTED_ID);
        v.lastBidTime = g.lastBidTime;
        v.currentTimer = g.currentTimer;
        v.head = g.head;
        v.queueLength = _claimants[id].length;
        v.initialTimer = g.initialTimer;
        v.minTimer = g.minTimer;
        if (id != 0 && !g.finished && g.round != 0) {
            uint256 deadline = g.lastBidTime + g.currentTimer;
            v.timeLeft = block.timestamp >= deadline ? 0 : deadline - block.timestamp;
        }
    }
}
