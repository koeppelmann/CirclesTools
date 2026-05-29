// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CirclesDollarAuctionFactory} from "../src/CirclesDollarAuctionFactory.sol";

/// @notice Deploys the factory, then a perpetual auction hub through it.
contract DeployHub is Script {
    address constant GNOSIS_GROUP = 0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address group = vm.envOr("GROUP", GNOSIS_GROUP);
        string memory name = vm.envOr("NAME", string("Dollar Auction Hub"));

        vm.startBroadcast(pk);
        CirclesDollarAuctionFactory factory = new CirclesDollarAuctionFactory();
        address host = factory.deploy(group, name);
        vm.stopBroadcast();

        console2.log("Factory:", address(factory));
        console2.log("Hub:    ", host);
        console2.log("Group:  ", group);
    }
}
