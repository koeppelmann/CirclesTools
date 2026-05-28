// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {IHubV2} from "./IHubV2.sol";

/**
 * @title CirclesDollarAuction
 * @notice A dollar-auction variant played entirely in a single Circles group currency.
 *
 *  ──────────────────────────── Rules ────────────────────────────
 *  The contract registers itself as a Circles *organization* and trusts exactly one
 *  group avatar, so it only ever accepts that group's Circles ("the accepted token").
 *
 *  • The owner seeds the prize pool with a fixed STARTING_PRICE (e.g. 10000 CRC).
 *  • Each bid is exactly BID (100 CRC), sent by transferring the accepted token here.
 *      - Anything that is NOT the accepted token, or is below BID, is rejected (the
 *        transfer reverts, so funds never leave the sender).
 *      - Anything above BID is accepted as a single bid and the excess is returned.
 *  • A 100 CRC bid is split: TO_POOL (10) stays as prize, TO_OWNER (10) goes to the
 *    owner, TO_CLAIMS (80) pays down a FIFO queue of 110-CRC claims. Every bid also
 *    appends a fresh CLAIM_SIZE (110) claim for the bidder at the back of that queue.
 *  • The last bidder wins the whole pool if no one bids for `currentTimer` seconds.
 *    The timer starts at `initialTimer` (24h) and decays geometrically per bid
 *    (half-life ≈ 13 bids with the default 948/1000 ratio) down to `minTimer` (5min).
 *
 *  Claim payouts and the owner cut are pushed out immediately, so the contract only
 *  ever *holds* the prize pool (which, like all Circles, demurrages over time). A
 *  recipient that refuses the push (e.g. a reverting contract) does not stall the
 *  game: the amount is parked in `failedCredits` and can be recovered later.
 */
contract CirclesDollarAuction {
    // ───────────────────────────── Immutable config ─────────────────────────────

    IHubV2 public immutable HUB;
    /// @notice The group avatar whose Circles are accepted.
    address public immutable GROUP;
    /// @notice ERC-1155 token id of the accepted group Circles = uint256(uint160(GROUP)).
    uint256 public immutable ACCEPTED_ID;
    /// @notice Fee recipient (receives TO_OWNER per bid). Mutable — see transferOwnership.
    address public owner;

    /// @notice Minimum seed that activates the game (the "starting price").
    uint256 public immutable STARTING_PRICE;

    // Bid economics, derived from BID at construction (BID must be a multiple of 10
    // so the 10% splits are exact). For BID=100: 10 pool / 10 owner / 80 claims / 110 claim.
    uint256 public immutable BID;
    uint256 public immutable TO_POOL; // BID * 10%
    uint256 public immutable TO_OWNER; // BID * 10%
    uint256 public immutable TO_CLAIMS; // BID * 80%
    uint256 public immutable CLAIM_SIZE; // BID * 110%

    // Timer schedule.
    uint256 public immutable initialTimer; // seconds granted to bid #1 (e.g. 24h)
    uint256 public immutable minTimer; // floor (e.g. 5min)
    uint256 public immutable ratioNum; // per-bid decay numerator (e.g. 948)
    uint256 public immutable ratioDen; // per-bid decay denominator (e.g. 1000)

    // ───────────────────────────── Game state ─────────────────────────────

    bool public seeded; // pool has been funded
    bool public finished; // prize has been claimed
    address public seeder; // who funded the pool (refund target if never bid on)
    uint256 public poolNominal; // nominal prize pool (held balance; demurrages)
    address public lastBidder; // current front-runner / prospective winner
    uint256 public lastBidTime; // timestamp of the most recent bid
    uint256 public round; // number of bids placed
    uint256 public currentTimer; // window (s) granted to the most recent bid

    // FIFO claim queue.
    address[] public claimants; // claim i belongs to claimants[i]
    uint256 public head; // index of the front (oldest unpaid) claim
    uint256 public headPaid; // amount already paid into claimants[head]

    // Fixed-size ring buffer of the last 5 bids (for the UI; O(1), never grows).
    address[5] private _rbAddr;
    uint40[5] private _rbTime;

    // Failed pushes (recipient refused the transfer); recoverable later.
    mapping(address => uint256) public failedCredits;
    uint256 public totalFailedCredits;

    uint256 private _locked = 1;

    // ───────────────────────────── Events ─────────────────────────────

    event Seeded(address indexed owner, uint256 amount);
    event BidPlaced(
        address indexed bidder, uint256 indexed round, uint256 claimIndex, uint256 newTimer, uint256 poolNominal
    );
    event ClaimPaid(address indexed claimant, uint256 indexed claimIndex, uint256 amount);
    event OwnerPaid(uint256 amount);
    event Refunded(address indexed to, uint256 amount);
    event PushFailed(address indexed to, uint256 amount);
    event CreditRecovered(address indexed to, uint256 amount);
    event GameWon(address indexed winner, uint256 prize, uint256 totalRounds);
    event SeedReclaimed(address indexed owner, uint256 amount);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    // ───────────────────────────── Errors ─────────────────────────────

    error OnlyHub();
    error NotActive();
    error GameOver();
    error BelowBid();
    error BadSeed();
    error NotOwner();
    error AlreadySeeded();
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
     * @param _hub          Circles v2 Hub (Gnosis: 0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8).
     * @param _group        The group avatar whose Circles are accepted (e.g. the Gnosis group).
     * @param _owner        Fee recipient that earns TO_OWNER per bid (mutable afterwards).
     * @param _name         Org name registered on Circles (<=32 chars, NameRegistry charset).
     * @param _startingPrice Minimum seed to activate the game (e.g. 10000 ether).
     * @param _bid          Bid size (e.g. 100 ether); must be a multiple of 10 wei.
     * @param _initialTimer First-bid window in seconds (e.g. 86400).
     * @param _minTimer     Timer floor in seconds (e.g. 300).
     * @param _ratioNum     Per-bid decay numerator (e.g. 948).
     * @param _ratioDen     Per-bid decay denominator (e.g. 1000).
     */
    constructor(
        address _hub,
        address _group,
        address _owner,
        string memory _name,
        uint256 _startingPrice,
        uint256 _bid,
        uint256 _initialTimer,
        uint256 _minTimer,
        uint256 _ratioNum,
        uint256 _ratioDen
    ) {
        require(_ratioDen != 0 && _ratioNum <= _ratioDen, "bad ratio");
        require(_minTimer != 0 && _minTimer <= _initialTimer, "bad timers");
        require(_owner != address(0), "zero owner");
        require(_bid != 0 && _bid % 10 == 0, "bad bid");
        require(_startingPrice >= _bid, "seed < bid");
        HUB = IHubV2(_hub);
        GROUP = _group;
        ACCEPTED_ID = uint256(uint160(_group));
        owner = _owner;
        STARTING_PRICE = _startingPrice;
        BID = _bid;
        TO_POOL = _bid / 10;
        TO_OWNER = _bid / 10;
        TO_CLAIMS = (_bid * 8) / 10;
        CLAIM_SIZE = (_bid * 11) / 10;
        initialTimer = _initialTimer;
        minTimer = _minTimer;
        ratioNum = _ratioNum;
        ratioDen = _ratioDen;
        currentTimer = _initialTimer;

        // Register as a Circles organization with a name, and trust only the group.
        HUB.registerOrganization(_name, bytes32(0));
        HUB.trust(_group, uint96(block.timestamp + 100 * 365 days));
    }

    // ───────────────────────────── ERC-1155 receiver ─────────────────────────────

    /// @notice Single-transfer entrypoint. All game flow happens here.
    function onERC1155Received(address, address from, uint256 id, uint256 value, bytes calldata)
        external
        nonReentrant
        returns (bytes4)
    {
        if (msg.sender != address(HUB)) revert OnlyHub();
        _handle(from, id, value);
        return this.onERC1155Received.selector;
    }

    /// @notice Batch entrypoint. Circles path payments (operateFlowMatrix) deliver the
    /// net amount to a receiver as a batch of terminal flow edges — multiple chunks of
    /// the accepted group token, with `from` set to the original payer. We sum them and
    /// treat the total as a single bid/seed (mirrors the proven Lottery pattern).
    function onERC1155BatchReceived(
        address,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata
    ) external nonReentrant returns (bytes4) {
        if (msg.sender != address(HUB)) revert OnlyHub();
        uint256 total;
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] != ACCEPTED_ID) revert OnlyHub(); // wrong token in the batch
            total += values[i];
        }
        _handle(from, ACCEPTED_ID, total);
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // ERC165 + ERC1155Receiver
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x4e2312e0;
    }

    // ───────────────────────────── Core logic ─────────────────────────────

    function _handle(address from, uint256 id, uint256 value) internal {
        // Reject anything that is not the accepted group token. Reverting leaves the
        // sender's funds untouched (i.e. "fully sent back").
        if (id != ACCEPTED_ID) revert OnlyHub(); // wrong token

        // If the game is already settled, don't revert — bounce the funds back so a
        // late payer (e.g. a path payment that landed after settlement) is made whole.
        if (finished) {
            _push(from, value);
            emit Refunded(from, value);
            return;
        }

        if (!seeded) {
            // The first deposit of at least the starting price activates the game.
            // Sender-agnostic on purpose: Gnosis-app payments may be path-routed, so
            // `from` is not relied upon (in practice the owner seeds). The actual
            // funder is recorded so it — not the fee recipient — is refunded on reclaim.
            if (value < STARTING_PRICE) revert BadSeed();
            seeded = true;
            seeder = from;
            poolNominal = value; // entire seed is the prize pool
            emit Seeded(from, value);
            return;
        }

        // If the deadline for the last bid has passed, this transfer arrived too late:
        // settle the auction to the winner and return the late funds to the sender,
        // rather than reverting or accepting a stale bid.
        if (round != 0 && block.timestamp >= lastBidTime + currentTimer) {
            _settle();
            _push(from, value);
            emit Refunded(from, value);
            return;
        }

        // A bid. Must be at least one BID; reject smaller transfers outright.
        if (value < BID) revert BelowBid();

        // Refund anything above a single bid.
        uint256 excess = value - BID;
        if (excess != 0) {
            _push(from, excess);
            emit Refunded(from, excess);
        }

        _placeBid(from);
    }

    function _placeBid(address bidder) internal {
        // Decay the timer for every bid after the first, then register this bid.
        if (round != 0) {
            uint256 t = (currentTimer * ratioNum) / ratioDen;
            currentTimer = t < minTimer ? minTimer : t;
        }
        round += 1;
        lastBidder = bidder;
        lastBidTime = block.timestamp;

        // record into the last-5 ring buffer (O(1))
        uint256 slot = (round - 1) % 5;
        _rbAddr[slot] = bidder;
        _rbTime[slot] = uint40(block.timestamp);

        // 10 stays as prize.
        poolNominal += TO_POOL;

        // 10 to the owner.
        _push(owner, TO_OWNER);
        emit OwnerPaid(TO_OWNER);

        // Append this bidder's 110 claim, then pay 80 down the FIFO queue.
        uint256 claimIndex = claimants.length;
        claimants.push(bidder);
        emit BidPlaced(bidder, round, claimIndex, currentTimer, poolNominal);

        _payClaims(TO_CLAIMS);
    }

    /// @dev Distributes `budget` across the front of the FIFO queue. Because
    /// TO_CLAIMS (80) < CLAIM_SIZE (110) and every bid adds 110 of capacity, the
    /// budget always fits and this touches at most two claims per bid.
    function _payClaims(uint256 budget) internal {
        while (budget != 0) {
            uint256 remaining = CLAIM_SIZE - headPaid;
            uint256 pay = remaining < budget ? remaining : budget;
            address claimant = claimants[head];
            uint256 idx = head;

            // Effects before interaction.
            if (pay == remaining) {
                head += 1;
                headPaid = 0;
            } else {
                headPaid += pay;
            }
            budget -= pay;

            _push(claimant, pay);
            emit ClaimPaid(claimant, idx, pay);
        }
    }

    /// @dev Pushes `amt` of the accepted token to `to`. On failure the amount is
    /// parked in `failedCredits` so a hostile recipient cannot stall the game.
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

    /// @notice Pays the prize pool to the last bidder once the timer has elapsed.
    /// Permissionless: anyone may settle. (A late bid also settles automatically.)
    function claimPrize() external nonReentrant {
        if (!seeded) revert NotActive();
        if (finished) revert GameOver();
        if (round == 0) revert NoBids();
        if (block.timestamp < lastBidTime + currentTimer) revert StillLive();
        _settle();
    }

    /// @dev Settles the auction: pays the prize pool to the last bidder and ends the game.
    /// Pushed via _push so a hostile winner cannot block settlement (or a late refund);
    /// the prize is parked in failedCredits if the winner refuses it.
    function _settle() internal {
        finished = true;
        address winner = lastBidder;

        // Prize is the nominal pool, capped by what is actually withdrawable (held
        // balance minus funds owed to failed-push recipients, accounting for demurrage).
        // Note: any not-yet-processed incoming funds in `balance` are never given to the
        // winner because the cap is min(poolNominal, withdrawable) and poolNominal tracks
        // only the prize, not deposits awaiting refund.
        uint256 prize = poolNominal;
        uint256 bal = HUB.balanceOf(address(this), ACCEPTED_ID);
        uint256 withdrawable = bal > totalFailedCredits ? bal - totalFailedCredits : 0;
        if (prize > withdrawable) prize = withdrawable;
        poolNominal = 0;

        _push(winner, prize);
        emit GameWon(winner, prize, round);
    }

    /// @notice Hand the fee-recipient role to a new address. Only the current owner.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert NotOwner();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice The funder (or owner on their behalf) can reclaim the seed if the game
    /// was funded but never bid on. Funds return to the recorded seeder.
    function reclaimSeed() external nonReentrant {
        if (msg.sender != owner && msg.sender != seeder) revert NotOwner();
        if (!seeded) revert NotActive();
        if (round != 0) revert AlreadyStarted();
        if (finished) revert GameOver();
        finished = true;
        uint256 amount = poolNominal;
        poolNominal = 0;
        uint256 bal = HUB.balanceOf(address(this), ACCEPTED_ID);
        if (amount > bal) amount = bal;
        if (amount != 0) {
            HUB.safeTransferFrom(address(this), seeder, ACCEPTED_ID, amount, "");
        }
        emit SeedReclaimed(seeder, amount);
    }

    /// @notice Re-attempt a previously failed push. Reverts (restoring the credit)
    /// if the recipient still refuses the funds.
    function recoverFailedCredit(address to) external nonReentrant {
        uint256 amt = failedCredits[to];
        if (amt == 0) revert NothingToRecover();
        failedCredits[to] = 0;
        totalFailedCredits -= amt;
        HUB.safeTransferFrom(address(this), to, ACCEPTED_ID, amt, "");
        emit CreditRecovered(to, amt);
    }

    // ───────────────────────────── Views (UI helpers) ─────────────────────────────

    /// @notice Seconds until the prize becomes claimable (0 if claimable now / not live).
    function timeLeft() external view returns (uint256) {
        if (!seeded || finished || round == 0) return 0;
        uint256 deadline = lastBidTime + currentTimer;
        return block.timestamp >= deadline ? 0 : deadline - block.timestamp;
    }

    /// @notice True once the timer has elapsed and `claimPrize` would succeed.
    function isClaimable() external view returns (bool) {
        return seeded && !finished && round != 0 && block.timestamp >= lastBidTime + currentTimer;
    }

    /// @notice Number of claims currently outstanding (created but not fully paid).
    function outstandingClaims() external view returns (uint256) {
        return claimants.length - head;
    }

    function queueLength() external view returns (uint256) {
        return claimants.length;
    }

    /// @notice The last (up to) 5 bids, most-recent first. O(1) — fixed ring buffer.
    function recentBids() external view returns (address[] memory bidders, uint256[] memory times) {
        uint256 n = round < 5 ? round : 5;
        bidders = new address[](n);
        times = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 slot = (round - 1 - i) % 5;
            bidders[i] = _rbAddr[slot];
            times[i] = uint256(_rbTime[slot]);
        }
    }

    /// @notice One-shot snapshot for the front-end.
    function gameInfo()
        external
        view
        returns (
            bool _seeded,
            bool _finished,
            address _lastBidder,
            uint256 _round,
            uint256 _poolNominal,
            uint256 _balance,
            uint256 _lastBidTime,
            uint256 _currentTimer,
            uint256 _timeLeft,
            uint256 _head,
            uint256 _headPaid,
            uint256 _queueLength
        )
    {
        uint256 tl;
        if (seeded && !finished && round != 0) {
            uint256 deadline = lastBidTime + currentTimer;
            tl = block.timestamp >= deadline ? 0 : deadline - block.timestamp;
        }
        return (
            seeded,
            finished,
            lastBidder,
            round,
            poolNominal,
            HUB.balanceOf(address(this), ACCEPTED_ID),
            lastBidTime,
            currentTimer,
            tl,
            head,
            headPaid,
            claimants.length
        );
    }
}
