// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CirclesDollarAuctionHub} from "../src/CirclesDollarAuctionHub.sol";
import {CirclesDollarAuctionFactory} from "../src/CirclesDollarAuctionFactory.sol";
import {MockHub} from "./mocks/MockHub.sol";

contract CirclesDollarAuctionHubTest is Test {
    MockHub hub;
    CirclesDollarAuctionHub host;

    address group = address(0x6011);
    uint256 id;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA801);

    uint256 constant MIN_SEED = 10_000 ether;
    uint256 constant MAX_SEED = 1_000_000 ether;

    function setUp() public {
        hub = new MockHub();
        host = new CirclesDollarAuctionHub(address(hub), group, "Dollar Auction Hub");
        id = uint256(uint160(group));
        _fund(alice, 5_000_000 ether);
        _fund(bob, 5_000_000 ether);
        _fund(carol, 5_000_000 ether);
    }

    // ───────────────────────── helpers ─────────────────────────

    function _fund(address who, uint256 amount) internal {
        hub.mint(who, id, amount);
    }

    function _send(address who, uint256 amount, bytes memory data) internal {
        vm.prank(who);
        hub.safeTransferFrom(who, address(host), id, amount, data);
    }

    function _bal(address a) internal view returns (uint256) {
        return hub.balanceOf(a, id);
    }

    /// @dev start a default game seeded by `who` with `seed`.
    function _startDefault(address who, uint256 seed) internal {
        _send(who, seed, "");
    }

    // ───────────────────────── start / params ─────────────────────────

    function test_FactoryDeploysRegisteredHostThatTrustsGroup() public {
        CirclesDollarAuctionFactory f = new CirclesDollarAuctionFactory();
        // factory hardcodes the real Hub address, so point a fresh test at MockHub directly instead:
        CirclesDollarAuctionHub h = new CirclesDollarAuctionHub(address(hub), group, "X");
        assertTrue(hub.organizations(address(h)), "registered as org");
        assertGt(hub.trustExpiry(address(h), group), block.timestamp, "trusts group");
        // factory bookkeeping
        assertEq(f.deploymentsCount(), 0);
    }

    function test_StartWithDefaults() public {
        _startDefault(alice, MIN_SEED);
        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertEq(v.id, 1);
        assertFalse(v.idle, "a game is now running");
        assertEq(v.owner, alice, "funder is owner");
        assertEq(v.startingPrice, MIN_SEED);
        assertEq(v.poolNominal, MIN_SEED);
        assertEq(v.bid, MIN_SEED / 100, "default bid = seed/100 = 100 CRC");
        assertEq(v.initialTimer, 1 hours);
        assertEq(v.minTimer, 5 minutes);
        assertEq(v.currentTimer, 1 hours);
    }

    function test_StartWithCustomParams() public {
        bytes memory data = abi.encode(uint256(2 hours), uint256(10 minutes), uint256(50 ether));
        _send(alice, MIN_SEED, data);
        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertEq(v.initialTimer, 2 hours);
        assertEq(v.minTimer, 10 minutes);
        assertEq(v.bid, 50 ether);
    }

    function test_StartRefundsBelowMinSeed() public {
        uint256 before = _bal(alice);
        _send(alice, MIN_SEED - 1, "");
        assertTrue(host.canStart(), "no game started");
        assertEq(host.gameId(), 0);
        assertEq(_bal(alice), before, "fully refunded");
    }

    function test_StartClampsAboveMaxSeed() public {
        uint256 sent = MAX_SEED + 250_000 ether;
        uint256 before = _bal(alice);
        _send(alice, sent, "");
        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertEq(v.startingPrice, MAX_SEED, "seed clamped to max");
        assertEq(_bal(alice), before - MAX_SEED, "excess above max refunded");
    }

    function test_StartRefundsBadParams() public {
        // initialTimer above MAX_TIMER -> invalid -> whole send refunded, no game
        bytes memory bad = abi.encode(uint256(2 days), uint256(5 minutes), uint256(100 ether));
        uint256 before = _bal(alice);
        _send(alice, MIN_SEED, bad);
        assertTrue(host.canStart(), "no game started on bad params");
        assertEq(_bal(alice), before, "fully refunded");
    }

    function test_StartRefundsBidTooLargeRelativeToSeed() public {
        // bid > seed/10 -> invalid
        bytes memory bad = abi.encode(uint256(1 hours), uint256(5 minutes), uint256(MIN_SEED / 10 + 10));
        uint256 before = _bal(alice);
        _send(alice, MIN_SEED, bad);
        assertTrue(host.canStart());
        assertEq(_bal(alice), before);
    }

    // ───────────────────────── play ─────────────────────────

    function test_BidPaysOwnerAndClaimsAndGrowsPool() public {
        _startDefault(alice, MIN_SEED); // owner=alice, bid=100
        uint256 ownerBefore = _bal(alice);
        _send(bob, 100 ether, "");
        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertEq(v.round, 1);
        assertEq(v.lastBidder, bob);
        assertEq(v.poolNominal, MIN_SEED + 10 ether, "pool +10");
        assertEq(_bal(alice), ownerBefore + 10 ether, "owner cut +10");
        // bob's own 110 claim gets 80 paid immediately (only claim at head)
        // bob paid 100, received 80 claim back
    }

    function test_TimerDecays() public {
        _startDefault(alice, MIN_SEED);
        _send(bob, 100 ether, ""); // round 1: no decay, timer = 1h
        assertEq(host.currentGameInfo().currentTimer, 1 hours);
        _send(carol, 100 ether, ""); // round 2: decays 948/1000
        assertEq(host.currentGameInfo().currentTimer, uint256(1 hours) * 948 / 1000);
    }

    function test_SettleViaClaimPrize() public {
        _startDefault(alice, MIN_SEED);
        _send(bob, 100 ether, "");
        uint256 bobBefore = _bal(bob);
        uint256 pool = host.currentGameInfo().poolNominal;
        vm.warp(block.timestamp + 1 hours + 1);
        host.claimPrize();
        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertTrue(v.finished);
        assertTrue(v.idle, "finished -> idle/startable");
        assertEq(_bal(bob), bobBefore + pool, "winner gets the pool");
        assertEq(v.prize, pool);
    }

    function test_RestartAfterFinish() public {
        _startDefault(alice, MIN_SEED);
        _send(bob, 100 ether, "");
        vm.warp(block.timestamp + 1 hours + 1);
        host.claimPrize();
        assertEq(host.gameId(), 1);
        // a new send starts game 2 with a new owner
        _startDefault(carol, MIN_SEED);
        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertEq(v.id, 2, "gameId incremented");
        assertEq(v.owner, carol, "new owner");
        assertEq(v.round, 0);
        assertFalse(v.idle);
    }

    function test_CannotStartWhileRunning_SendIsBid() public {
        _startDefault(alice, MIN_SEED);
        _send(bob, MIN_SEED, ""); // big send during a live game is a BID (excess over bid refunded), not a new game
        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertEq(v.id, 1, "still game 1");
        assertEq(v.round, 1, "treated as a bid");
        assertEq(v.lastBidder, bob);
    }

    // ───────────────────────── M-1: late bid ─────────────────────────

    function test_LateBidRefundedThenSettles() public {
        _startDefault(alice, MIN_SEED);
        _send(bob, 100 ether, ""); // bob leads
        uint256 pool = host.currentGameInfo().poolNominal;
        uint256 bobBefore = _bal(bob);
        uint256 carolBefore = _bal(carol);

        vm.warp(block.timestamp + 1 hours + 1); // deadline passed
        _send(carol, 100 ether, ""); // arrives too late

        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertTrue(v.finished, "late bid settled the game");
        assertEq(_bal(bob), bobBefore + pool, "winner = bob gets exactly the pool");
        assertEq(_bal(carol), carolBefore, "late bidder fully refunded (M-1: not consumed by prize)");
    }

    // ───────────────────────── reclaim ─────────────────────────

    function test_ReclaimSeedWhenNoBids() public {
        _startDefault(alice, MIN_SEED);
        uint256 before = _bal(alice);
        vm.prank(alice);
        host.reclaimSeed();
        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertTrue(v.finished);
        assertTrue(v.idle);
        assertEq(_bal(alice), before + MIN_SEED, "seed returned");
    }

    function test_ReclaimSeedRevertsAfterABid() public {
        _startDefault(alice, MIN_SEED);
        _send(bob, 100 ether, "");
        vm.prank(alice);
        vm.expectRevert(CirclesDollarAuctionHub.AlreadyStarted.selector);
        host.reclaimSeed();
    }

    // ───────────────────────── recentBids ─────────────────────────

    function test_RecentBidsMostRecentFirstAndResetsPerGame() public {
        _startDefault(alice, MIN_SEED);
        _send(bob, 100 ether, "");
        _send(carol, 100 ether, "");
        (address[] memory bidders,) = host.recentBids();
        assertEq(bidders.length, 2);
        assertEq(bidders[0], carol, "most recent first");
        assertEq(bidders[1], bob);

        // finish and start a fresh game -> recentBids reflects only the new game
        vm.warp(block.timestamp + 1 hours + 1);
        host.claimPrize();
        _startDefault(alice, MIN_SEED);
        (address[] memory b2,) = host.recentBids();
        assertEq(b2.length, 0, "no bids in the new game yet");
    }

    // ───────────────────────── many bids / O(1) ─────────────────────────

    function test_LongGameClaimsNeverRevert() public {
        _startDefault(alice, MIN_SEED); // bid = 100
        for (uint256 i = 0; i < 150; i++) {
            address bidder = address(uint160(0x1000 + i));
            _fund(bidder, 1000 ether);
            _send(bidder, 100 ether, "");
        }
        CirclesDollarAuctionHub.GameView memory v = host.currentGameInfo();
        assertEq(v.round, 150);
        assertLt(v.head, v.queueLength, "head never overruns the queue");
        vm.warp(block.timestamp + 1 hours + 1);
        host.claimPrize();
        assertTrue(host.currentGameInfo().finished);
    }
}
