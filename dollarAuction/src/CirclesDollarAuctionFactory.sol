// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {CirclesDollarAuctionHub} from "./CirclesDollarAuctionHub.sol";

/**
 * @title CirclesDollarAuctionFactory
 * @notice Deploys CirclesDollarAuctionHub instances and keeps a registry of them.
 *
 *  Each hub is a perpetual host that runs an unbounded sequence of dollar-auction games for one
 *  group's Circles. The hub registers as a Circles organization and trusts the group IN ITS
 *  CONSTRUCTOR — i.e. during this normal `deploy()` call, NOT inside an ERC-1155 receive
 *  callback. (The reference LotteryFactory deliberately does the same: registering an org while
 *  inside the Hub's operateFlowMatrix acceptance check is unsafe, so deployment is always a
 *  standalone transaction.) Players then start/play games by sending CRC straight to the hub.
 */
contract CirclesDollarAuctionFactory {
    /// @notice Circles v2 Hub on Gnosis Chain.
    address public constant CIRCLES_HUB = 0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8;

    address[] private _hosts;

    event HostDeployed(address indexed host, address indexed creator, address indexed group, string name);

    /// @notice Deploy a new auction host for `group`'s Circles, registered under `name`.
    function deploy(address group, string calldata name) external returns (address host) {
        host = address(new CirclesDollarAuctionHub(CIRCLES_HUB, group, name));
        _hosts.push(host);
        emit HostDeployed(host, msg.sender, group, name);
    }

    function allDeployments() external view returns (address[] memory) {
        return _hosts;
    }

    function deploymentsCount() external view returns (uint256) {
        return _hosts.length;
    }
}
