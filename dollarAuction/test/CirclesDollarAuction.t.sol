// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CirclesDollarAuction} from "../src/CirclesDollarAuction.sol";
import {MockHub} from "./mocks/MockHub.sol";

contract CirclesDollarAuctionTest is Test {
    MockHub hub;
    CirclesDollarAuction game;

    address owner = address(0xABCD);
    address group = address(0x6011); // the accepted group avatar
    uint256 id; // accepted token id

    uint256 constant SEED = 10_000 ether;
    uint256 constant BID = 100 ether;
    uint256 constant INITIAL_TIMER = 24 hours;
    uint256 constant MIN_TIMER = 5 minutes;
    uint256 constant RNUM = 948;
    uint256 constant RDEN = 1000;

    function setUp() public {
        hub = new MockHub();
        game = new CirclesDollarAuction(
            address(hub), group, owner, "Dollar Auction", SEED, BID, INITIAL_TIMER, MIN_TIMER, RNUM, RDEN
        );
        id = uint256(uint160(group));
    }

    // ───────────────────────── helpers ─────────────────────────

    function _fund(address who, uint256 amount) internal {
        hub.mint(who, id, amount);
    }

    /// @dev `who` sends `amount` of the accepted token to the game (a bid/seed).
    function _send(address who, uint256 amount) internal {
        vm.prank(who);
        hub.safeTransferFrom(who, address(game), id, amount, "");
    }

    function _seed() internal {
        _fund(owner, SEED);
        _send(owner, SEED);
    }

    function _bidder(uint256 i) internal pure returns (address) {
        return address(uint160(0x10000 + i));
    }

    function bal(address a) internal view returns (uint256) {
        return hub.balanceOf(a, id);
    }

    // ───────────────────────── registration ─────────────────────────

    function test_RegistersOrgAndTrustsGroupWithName() public view {
        assertTrue(hub.organizations(address(game)), "not org");
        assertEq(hub.names(address(game)), "Dollar Auction");
        assertGt(hub.trustExpiry(address(game), group), block.timestamp, "group not trusted");
        assertEq(game.ACCEPTED_ID(), id);
        assertEq(game.currentTimer(), INITIAL_TIMER);
    }

    // ───────────────────────── seeding ─────────────────────────

    function test_SeedActivatesGame() public {
        _seed();
        assertTrue(game.seeded());
        assertEq(game.poolNominal(), SEED);
        assertEq(bal(address(game)), SEED);
        assertEq(game.round(), 0); // clock not running until first bid
    }

    function test_AnyoneCanSeedAtOrAbovePrice() public {
        // Seeding is sender-agnostic (path-routing safe); the funder is recorded.
        address stranger = _bidder(1);
        _fund(stranger, SEED);
        _send(stranger, SEED);
        assertTrue(game.seeded());
        assertEq(game.seeder(), stranger);
        assertEq(game.poolNominal(), SEED);
        // ...and the funder can reclaim it back if no one ever bids.
        vm.prank(stranger);
        game.reclaimSeed();
        assertEq(bal(stranger), SEED);
    }

    function test_SeedBelowStartingPriceReverts() public {
        _fund(owner, SEED);
        vm.prank(owner);
        vm.expectRevert();
        hub.safeTransferFrom(owner, address(game), id, SEED - 1, "");
    }

    // ───────────────────────── rejection / refunds ─────────────────────────

    function test_WrongTokenIsRejected() public {
        _seed();
        uint256 otherId = uint256(uint160(address(0xDEAD)));
        address u = _bidder(1);
        hub.mint(u, otherId, BID);
        vm.prank(u);
        vm.expectRevert(); // OnlyHub() used as "wrong token" — transfer reverts, funds stay
        hub.safeTransferFrom(u, address(game), otherId, BID, "");
        assertEq(hub.balanceOf(u, otherId), BID, "funds should be untouched");
    }

    function test_BelowBidIsRejected() public {
        _seed();
        address u = _bidder(1);
        _fund(u, BID);
        vm.prank(u);
        vm.expectRevert();
        hub.safeTransferFrom(u, address(game), id, BID - 1, "");
        assertEq(bal(u), BID, "funds untouched after reject");
    }

    function test_ExcessAboveBidIsRefunded() public {
        _seed();
        address u = _bidder(1);
        _fund(u, BID + 35 ether);
        _send(u, BID + 35 ether);
        // 35 refunded, then as the sole/first bidder 80 of their bid is paid back into
        // their own claim => balance = 35 (refund) + 80 (claim) = 115.
        assertEq(bal(u), 35 ether + 80 ether);
        assertEq(game.round(), 1);
    }

    // ───────────────────────── split + FIFO accounting ─────────────────────────

    function test_FirstBidSplit() public {
        _seed();
        address u1 = _bidder(1);
        _fund(u1, BID);
        _send(u1, BID);

        // 10 -> pool, 10 -> owner, 80 -> u1's own (front) claim.
        assertEq(game.poolNominal(), SEED + 10 ether);
        assertEq(bal(owner), 10 ether); // owner spent its seed entirely, now earns 10
        assertEq(bal(u1), 80 ether);
        assertEq(game.head(), 0);
        assertEq(game.headPaid(), 80 ether);
        assertEq(game.lastBidder(), u1);
        assertEq(game.currentTimer(), INITIAL_TIMER); // no decay on first bid
    }

    function test_SecondBidFillsFirstClaimThenStartsOwn() public {
        _seed();
        address u1 = _bidder(1);
        address u2 = _bidder(2);
        _fund(u1, BID);
        _fund(u2, BID);
        _send(u1, BID);
        _send(u2, BID);

        // u1: 80 then +30 = 110 (fully paid). u2: 50 so far.
        assertEq(bal(u1), 110 ether);
        assertEq(bal(u2), 50 ether);
        assertEq(game.head(), 1); // u1's claim retired
        assertEq(game.headPaid(), 50 ether);
        assertEq(game.poolNominal(), SEED + 20 ether);
        assertEq(bal(owner), 20 ether);

        // timer decayed once: 24h * 948/1000
        assertEq(game.currentTimer(), (INITIAL_TIMER * RNUM) / RDEN);
    }

    // ───────────────────────── timer decay ─────────────────────────

    function test_TimerDecaysAndFloors() public {
        _seed();
        uint256 expected = INITIAL_TIMER;
        for (uint256 i = 1; i <= 200; i++) {
            address u = _bidder(i);
            _fund(u, BID);
            _send(u, BID);
            if (i >= 2) {
                uint256 t = (expected * RNUM) / RDEN;
                expected = t < MIN_TIMER ? MIN_TIMER : t;
            }
            assertEq(game.currentTimer(), expected, "timer mismatch");
        }
        // By 200 bids we are firmly on the floor.
        assertEq(game.currentTimer(), MIN_TIMER);
    }

    // ───────────────────────── claiming the prize ─────────────────────────

    function test_CannotClaimWhileLive() public {
        _seed();
        address u = _bidder(1);
        _fund(u, BID);
        _send(u, BID);
        vm.expectRevert();
        game.claimPrize();
    }

    function test_LastBidderWinsPool() public {
        _seed();
        address u1 = _bidder(1);
        address u2 = _bidder(2);
        _fund(u1, BID);
        _fund(u2, BID);
        _send(u1, BID);
        _send(u2, BID);

        uint256 pool = game.poolNominal();
        // wait out the (decayed) timer of the last bid
        vm.warp(block.timestamp + game.currentTimer());
        assertTrue(game.isClaimable());

        uint256 before = bal(u2);
        game.claimPrize();
        assertTrue(game.finished());
        assertEq(bal(u2) - before, pool, "winner gets pool");
        assertEq(bal(address(game)), 0, "contract drained");
    }

    function test_NoBidsCannotClaim() public {
        _seed();
        vm.warp(block.timestamp + 100 days);
        vm.expectRevert();
        game.claimPrize();
    }

    function test_ReclaimSeedWhenNoBids() public {
        _seed();
        vm.prank(owner);
        game.reclaimSeed();
        assertEq(bal(owner), SEED);
        assertTrue(game.finished());
    }

    function test_CannotReclaimAfterBid() public {
        _seed();
        address u = _bidder(1);
        _fund(u, BID);
        _send(u, BID);
        vm.prank(owner);
        vm.expectRevert();
        game.reclaimSeed();
    }

    // ───────────────────────── large run: 120 rounds ─────────────────────────

    function test_LargeRun_120Bids_Accounting() public {
        uint256 N = 120;
        _seed();
        for (uint256 i = 1; i <= N; i++) {
            address u = _bidder(i);
            _fund(u, BID); // each bidder funded with exactly one bid
            _send(u, BID);
        }

        assertEq(game.round(), N);

        // Pool = seed + 10 per round.
        assertEq(game.poolNominal(), SEED + 10 ether * N);
        assertEq(bal(address(game)), SEED + 10 ether * N);

        // Owner earns 10 per round (spent the whole seed up front).
        assertEq(bal(owner), 10 ether * N);

        // FIFO: fully paid claims = floor(80*N / 110).
        uint256 fully = (80 * N) / 110; // = 87 for N=120
        assertEq(game.head(), fully, "head");
        uint256 distributed = 80 ether * N; // total budget routed to claims
        uint256 expectedHeadPaid = distributed - fully * 110 ether;
        assertEq(game.headPaid(), expectedHeadPaid, "headPaid");

        // Per-bidder repayment: positions < fully got 110, position == fully got the
        // partial remainder, the rest got 0 (each funded with exactly one bid, so
        // their leftover balance equals what their claim was repaid).
        for (uint256 i = 1; i <= N; i++) {
            uint256 pos = i - 1; // 0-indexed claim position
            address u = _bidder(i);
            if (pos < fully) {
                assertEq(bal(u), 110 ether, "fully repaid");
            } else if (pos == fully) {
                assertEq(bal(u), expectedHeadPaid, "partial");
            } else {
                assertEq(bal(u), 0, "not yet repaid");
            }
        }

        // Global conservation: minted == owner + claims paid + pool held.
        uint256 minted = SEED + BID * N;
        uint256 claimsPaid = distributed; // every 80 was pushed out
        assertEq(minted, bal(owner) + claimsPaid + bal(address(game)));

        // Winner (last bidder) takes the whole pool.
        uint256 pool = game.poolNominal();
        vm.warp(block.timestamp + game.currentTimer());
        address winner = _bidder(N);
        uint256 wbBefore = bal(winner);
        game.claimPrize();
        assertEq(bal(winner) - wbBefore, pool, "winner payout");
        assertEq(bal(address(game)), 0);
    }

    // ───────────────────────── hostile recipient does not stall ─────────────────────────

    function test_RejectingClaimantDoesNotStallGame() public {
        _seed();
        Rejecter r = new Rejecter(address(hub));
        hub.mint(address(r), id, BID);
        // r bids first; the 80 push back into r's own claim will fail and be parked.
        r.bid(address(game), id, BID);
        assertEq(game.round(), 1);
        assertEq(game.failedCredits(address(r)), 80 ether, "parked credit");
        assertEq(game.totalFailedCredits(), 80 ether);

        // A normal bidder can still play afterwards.
        address u2 = _bidder(2);
        _fund(u2, BID);
        _send(u2, BID);
        assertEq(game.round(), 2);
        // u2 fills r's remaining 30 (also fails -> parked) and gets 50.
        assertEq(game.failedCredits(address(r)), 110 ether);
        assertEq(bal(u2), 50 ether);

        // Winner payout excludes the parked (failed) credits.
        uint256 pool = game.poolNominal();
        vm.warp(block.timestamp + game.currentTimer());
        uint256 before = bal(u2);
        game.claimPrize();
        assertEq(bal(u2) - before, pool, "winner gets only the pool, not parked credits");
        // Parked credits remain held for recovery.
        assertEq(bal(address(game)), game.totalFailedCredits());
    }

    // ───────────────────────── path payment (operateFlowMatrix) ─────────────────────────

    /// @dev Simulates how a Circles path payment delivers a bid: the receiver's balance
    /// is credited by the flow, then a single batch acceptance check arrives with
    /// `from` = the original payer and the amount split across terminal edges.
    function test_BatchDeliverySumsToOneBid() public {
        _seed();
        address payer = _bidder(1);

        // flow credits the contract the bid amount (split 40/60), before acceptance check
        hub.mint(address(game), id, BID);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory vals = new uint256[](2);
        ids[0] = id;
        ids[1] = id;
        vals[0] = 40 ether;
        vals[1] = 60 ether; // sums to BID (100)

        vm.prank(address(hub)); // the Hub performs the acceptance call
        game.onERC1155BatchReceived(address(0xFEED), payer, ids, vals, "");

        assertEq(game.round(), 1);
        assertEq(game.lastBidder(), payer, "payer is the stream source");
        assertEq(game.poolNominal(), SEED + 10 ether);
        assertEq(bal(owner), 10 ether);
        assertEq(bal(payer), 80 ether); // 80 paid into payer's own front claim
    }

    function test_BatchWithWrongTokenReverts() public {
        _seed();
        uint256[] memory ids = new uint256[](2);
        uint256[] memory vals = new uint256[](2);
        ids[0] = id;
        ids[1] = uint256(uint160(address(0xBAD)));
        vals[0] = 50 ether;
        vals[1] = 50 ether;
        vm.prank(address(hub));
        vm.expectRevert();
        game.onERC1155BatchReceived(address(0), _bidder(1), ids, vals, "");
    }

    // ───────────────────────── ownership transfer ─────────────────────────

    function test_OwnerCanTransferOwnershipAndFeesFollow() public {
        address newOwner = address(0xBEEF);
        vm.prank(owner);
        game.transferOwnership(newOwner);
        assertEq(game.owner(), newOwner);

        // The per-bid cut now goes to the new owner.
        _seed();
        address u = _bidder(1);
        _fund(u, BID);
        _send(u, BID);
        assertEq(bal(newOwner), 10 ether);
    }

    function test_OnlyOwnerCanTransfer() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        game.transferOwnership(address(0xBEEF));
    }

    // ───────────────────────── scaled bid (1 CRC) ─────────────────────────

    function test_ScaledOneCrcBidSplitsProportionally() public {
        // A separate game with BID = 1 CRC, starting price 100 CRC.
        MockHub h = new MockHub();
        CirclesDollarAuction g = new CirclesDollarAuction(
            address(h), group, owner, "Test", 100 ether, 1 ether, 5 minutes, 1 minutes, RNUM, RDEN
        );
        uint256 tid = uint256(uint160(group));
        assertEq(g.BID(), 1 ether);
        assertEq(g.TO_POOL(), 0.1 ether);
        assertEq(g.TO_OWNER(), 0.1 ether);
        assertEq(g.TO_CLAIMS(), 0.8 ether);
        assertEq(g.CLAIM_SIZE(), 1.1 ether);

        // seed 100 CRC from owner
        h.mint(owner, tid, 100 ether);
        vm.prank(owner);
        h.safeTransferFrom(owner, address(g), tid, 100 ether, "");

        // one 1-CRC bid: 0.1 pool, 0.1 owner, 0.8 into the bidder's own claim
        address u = _bidder(1);
        h.mint(u, tid, 1 ether);
        vm.prank(u);
        h.safeTransferFrom(u, address(g), tid, 1 ether, "");
        assertEq(g.poolNominal(), 100 ether + 0.1 ether);
        assertEq(h.balanceOf(owner, tid), 0.1 ether);
        assertEq(h.balanceOf(u, tid), 0.8 ether);
    }

    function test_GameOverRejectsFurtherBids() public {
        _seed();
        address u = _bidder(1);
        _fund(u, BID);
        _send(u, BID);
        vm.warp(block.timestamp + game.currentTimer());
        game.claimPrize();

        address late = _bidder(2);
        _fund(late, BID);
        vm.prank(late);
        vm.expectRevert();
        hub.safeTransferFrom(late, address(game), id, BID, "");
    }
}

/// @dev A contract that always refuses incoming Circles, used to prove a hostile
/// claimant cannot stall the queue. It can still initiate its own bid.
contract Rejecter {
    address immutable hub;

    constructor(address _hub) {
        hub = _hub;
    }

    function bid(address game, uint256 id, uint256 amount) external {
        IHubLike(hub).safeTransferFrom(address(this), game, id, amount, "");
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert("nope");
    }
}

interface IHubLike {
    function safeTransferFrom(address, address, uint256, uint256, bytes calldata) external;
}
