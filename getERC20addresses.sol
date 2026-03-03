// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ILift {
    /// @dev Returns the ERC20 token address for a given circles type and avatar.
    /// circlesType 0 returns the demurraged ERC20 token,
    /// and circlesType 1 returns the static ERC20 token.
    function erc20Circles(
        uint8 circlesType,
        address avatar
    ) external view returns (address);
}

/// @title AvatarERC20Getter
/// @notice This contract fetches the two potential ERC20 token addresses for a list of avatars.
contract AvatarERC20Getter {
    // Hardcoded lift contract address.
    address public constant LIFT_ADDRESS =
        0x5F99a795dD2743C36D63511f0D4bc667e6d3cDB5;

    /// @notice Holds the two ERC20 addresses for an avatar.
    struct AvatarERC20 {
        address staticERC20;
        address demurragedERC20;
    }

    /// @notice Returns the two potential ERC20 token addresses for each provided avatar.
    /// @param avatars An array of avatar addresses.
    /// @return tokens An array of AvatarERC20 structures containing the token addresses.
    function getAvatarsERC20(
        address[] calldata avatars
    ) external view returns (AvatarERC20[] memory tokens) {
        tokens = new AvatarERC20[](avatars.length);
        ILift lift = ILift(LIFT_ADDRESS);

        for (uint256 i = 0; i < avatars.length; i++) {
            tokens[i].demurragedERC20 = lift.erc20Circles(0, avatars[i]);
            tokens[i].staticERC20 = lift.erc20Circles(1, avatars[i]);
        }
    }
}
