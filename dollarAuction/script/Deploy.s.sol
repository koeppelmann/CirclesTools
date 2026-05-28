// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CirclesDollarAuction} from "../src/CirclesDollarAuction.sol";

/**
 * @notice Deploys CirclesDollarAuction to Gnosis Chain with the agreed parameters.
 *
 *  Required env vars:
 *    PRIVATE_KEY   deployer key
 *    GROUP         the accepted group avatar (e.g. the Gnosis group)
 *    OWNER         pool seeder / fee recipient (defaults to deployer if unset)
 *
 *  Defaults: 10000 CRC starting price, 24h initial timer, 5min floor,
 *  per-bid decay 948/1000 (half-life ≈ 13 bids).
 *
 *  Example:
 *    forge script script/Deploy.s.sol --rpc-url https://rpc.gnosischain.com --broadcast
 *
 *  After deploy, the OWNER seeds the pool by sending >= 10000 group CRC to the contract.
 */
contract Deploy is Script {
    address constant HUB = 0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8; // Circles v2 Hub (Gnosis)
    address constant GNOSIS_GROUP = 0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c; // accepted group

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address group = vm.envOr("GROUP", GNOSIS_GROUP);
        // OWNER collects the per-bid cut (mutable afterwards via transferOwnership).
        // It is NOT the gas-paying deployer; set it explicitly to your Circles account.
        address owner = vm.envOr("OWNER", vm.addr(pk));
        string memory name = vm.envOr("NAME", string("Dollar Auction"));
        uint256 startingPrice = vm.envOr("STARTING_PRICE", uint256(10_000 ether));
        uint256 bid = vm.envOr("BID", uint256(100 ether));
        uint256 initialTimer = vm.envOr("INITIAL_TIMER", uint256(24 hours));
        uint256 minTimer = vm.envOr("MIN_TIMER", uint256(5 minutes));
        uint256 ratioNum = vm.envOr("RATIO_NUM", uint256(948)); // ┐ half-life ≈ 13 bids
        uint256 ratioDen = vm.envOr("RATIO_DEN", uint256(1000)); // ┘

        vm.startBroadcast(pk);
        CirclesDollarAuction game = new CirclesDollarAuction(
            HUB, group, owner, name, startingPrice, bid, initialTimer, minTimer, ratioNum, ratioDen
        );
        vm.stopBroadcast();

        console2.log("CirclesDollarAuction:", address(game));
        console2.log("Accepted token id:   ", game.ACCEPTED_ID());
        console2.log("Owner:               ", owner);
        console2.log("Group:               ", group);
        console2.log("Bid / StartingPrice: ", bid, startingPrice);
        console2.log("Timer init / floor:  ", initialTimer, minTimer);
    }
}
