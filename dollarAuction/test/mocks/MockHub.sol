// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

/// @dev Minimal Circles-Hub-like ERC1155 for tests. No demurrage (deterministic),
/// but otherwise mirrors the bits the auction relies on: org/trust registration,
/// balance bookkeeping, and onERC1155Received acceptance checks on transfer.
contract MockHub {
    mapping(uint256 => mapping(address => uint256)) public balances;
    mapping(address => bool) public organizations;
    mapping(address => mapping(address => uint96)) public trustExpiry;
    mapping(address => string) public names;

    event RegisterOrganization(address indexed org, string name);
    event Trust(address indexed truster, address indexed trustee, uint96 expiry);

    function registerOrganization(string calldata _name, bytes32) external {
        require(!organizations[msg.sender], "already org");
        organizations[msg.sender] = true;
        names[msg.sender] = _name;
        emit RegisterOrganization(msg.sender, _name);
    }

    function trust(address _trustReceiver, uint96 _expiry) external {
        trustExpiry[msg.sender][_trustReceiver] = _expiry;
        emit Trust(msg.sender, _trustReceiver, _expiry);
    }

    function toTokenId(address _avatar) external pure returns (uint256) {
        return uint256(uint160(_avatar));
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return balances[id][account];
    }

    /// @dev test helper to fund accounts
    function mint(address to, uint256 id, uint256 amount) external {
        balances[id][to] += amount;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external {
        // In these tests the holder always initiates its own transfers.
        require(from == msg.sender, "not owner/approved");
        require(balances[id][from] >= value, "insufficient");
        balances[id][from] -= value;
        balances[id][to] += value;
        if (to.code.length > 0) {
            bytes4 ret = IERC1155Receiver(to).onERC1155Received(msg.sender, from, id, value, data);
            require(ret == IERC1155Receiver.onERC1155Received.selector, "receiver rejected");
        }
    }
}

interface IERC1155Receiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4);
}
