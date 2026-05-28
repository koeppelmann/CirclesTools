// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

/// @notice Minimal surface of the Circles v2 Hub used by the auction.
/// Full Hub: https://github.com/aboutcircles/circles-contracts-v2 (Hub.sol)
interface IHubV2 {
    /// @notice Registers the caller as a Circles organization with a custom name.
    /// @param _name custom name (<=32 bytes, see NameRegistry.isValidName).
    /// @param _metadataDigest IPFS CIDv0 digest, or bytes32(0) for none.
    function registerOrganization(string calldata _name, bytes32 _metadataDigest) external;

    /// @notice Directional trust. Trusting a group's avatar means accepting its group Circles.
    /// @param _trustReceiver avatar (here: the group) being trusted.
    /// @param _expiry unix timestamp until which trust is valid.
    function trust(address _trustReceiver, uint96 _expiry) external;

    /// @notice ERC-1155 transfer of Circles. Direct transfers are NOT trust/flow gated;
    /// only `value` and operator-approval are checked (Hub holders can move balances freely).
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external;

    /// @notice Demurraged balance of `account` for token `id` as of today.
    function balanceOf(address account, uint256 id) external view returns (uint256);

    /// @notice Casts an avatar address to its ERC-1155 token id: uint256(uint160(avatar)).
    function toTokenId(address _avatar) external pure returns (uint256);
}
