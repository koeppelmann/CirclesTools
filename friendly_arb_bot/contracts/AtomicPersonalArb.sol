// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUniV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IERC20Wrapper {
    function unwrap(uint256 amount) external;
}

interface IHub {
    function wrap(address avatar, uint256 amount, uint8 circlesType) external returns (address);
    function operateFlowMatrix(address[] calldata, FlowEdge[] calldata, Stream[] calldata, bytes calldata) external;
    function groupMint(address group, uint256[] calldata collateralAvatars, uint256[] calldata amounts, bytes calldata data) external;
    function setApprovalForAll(address operator, bool approved) external;
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function registerOrganization(string calldata name, bytes32 metadataDigest) external;
    function trust(address trustee, uint96 expiry) external;
}

struct BatchSwapStep {
    bytes32 poolId;
    uint256 assetInIndex;
    uint256 assetOutIndex;
    uint256 amount;
    bytes userData;
}

interface IBalancerVault {
    function swap(
        SingleSwap calldata singleSwap,
        FundManagement calldata funds,
        uint256 limit,
        uint256 deadline
    ) external returns (uint256);
    function batchSwap(
        uint8 kind,
        BatchSwapStep[] calldata swaps,
        address[] calldata assets,
        FundManagement calldata funds,
        int256[] calldata limits,
        uint256 deadline
    ) external returns (int256[] memory);
}

interface IWXDAI {
    function approve(address, uint256) external returns (bool);
}

interface ISDAIVault {
    function deposit(uint256 assets, address receiver) external returns (uint256);
}

interface IUniV2Router {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory);
}

struct SingleSwap {
    bytes32 poolId;
    uint8 kind;
    address assetIn;
    address assetOut;
    uint256 amount;
    bytes userData;
}

struct FundManagement {
    address sender;
    bool fromInternalBalance;
    address payable recipient;
    bool toInternalBalance;
}

struct FlowEdge { uint16 streamSinkId; uint192 amount; }
struct Stream { uint16 sourceCoordinate; uint16[] flowEdgeIds; bytes data; }

contract AtomicPersonalArb {
    address public owner;
    IHub public constant HUB = IHub(0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8);
    address public constant SDAI = 0xaf204776c7245bF4147c2612BF6e5972Ee483701;
    IBalancerVault public constant BAL_VAULT = IBalancerVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    address public uniPool;
    bool private _inSwap;

    address public srcGroupErc20;
    address public tgtAvatar;
    address public tgtErc20;
    bytes32 public balPoolId;

    event Step(uint8 step, uint256 val);

    modifier onlyOwner() { require(msg.sender == owner, "!owner"); _; }

    constructor(address _uniPool, address _owner) {
        owner = _owner;
        uniPool = _uniPool;
    }

    function setup() external onlyOwner {
        HUB.registerOrganization("AtomicPersonalArb", bytes32(0));
        HUB.setApprovalForAll(address(this), true);
    }

    function configure(address _srcGroupErc20, address _tgtAvatar, address _tgtErc20, bytes32 _balPoolId) external onlyOwner {
        srcGroupErc20 = _srcGroupErc20;
        tgtAvatar = _tgtAvatar;
        tgtErc20 = _tgtErc20;
        balPoolId = _balPoolId;
    }

    // minSdaiOut stored to avoid stack depth
    uint256 public minOut;

    function execute(
        uint256 spendAmount,
        uint256 _minSdaiOut,
        address[] calldata flowVertices,
        FlowEdge[] calldata flow,
        Stream[] calldata streams,
        bytes calldata packedCoordinates
    ) external onlyOwner {
        minOut = _minSdaiOut;
        // 1. Pull sDAI
        require(IERC20(SDAI).transferFrom(msg.sender, address(this), spendAmount), "s1");
        emit Step(1, spendAmount);

        // 2. Swap sDAI → group CRC on UniV3
        _inSwap = true;
        IUniV3Pool(uniPool).swap(address(this), true, int256(spendAmount), 4295128740, "");
        _inSwap = false;
        _step3();
        emit Step(3, 1);

        // 4. operateFlowMatrix
        HUB.operateFlowMatrix(flowVertices, flow, streams, packedCoordinates);
        emit Step(4, 1);

        _step567();
    }

    function _step3() internal {
        address _src = srcGroupErc20;
        uint256 groupBal = IERC20(_src).balanceOf(address(this));
        emit Step(2, groupBal);
        require(groupBal > 0, "s3:nobal");
        (bool ok,) = _src.call(abi.encodeWithSelector(0x095ea7b3, address(HUB), groupBal));
        require(ok, "s3:apr");
        IERC20Wrapper(_src).unwrap(groupBal);
    }

    function _step567() internal {
        address _tgt = tgtAvatar;
        uint256 tgtBal = HUB.balanceOf(address(this), uint256(uint160(_tgt)));
        emit Step(5, tgtBal);
        require(tgtBal > 0, "s5:nobal");
        HUB.wrap(_tgt, tgtBal, 1);

        address _tgtErc20 = tgtErc20;
        uint256 erc20Bal = IERC20(_tgtErc20).balanceOf(address(this));
        emit Step(6, erc20Bal);
        require(erc20Bal > 0, "s6:noerc");
        (bool ok,) = _tgtErc20.call(abi.encodeWithSelector(0x095ea7b3, address(BAL_VAULT), erc20Bal));
        require(ok, "s6:apr");
        BAL_VAULT.swap(
            SingleSwap({ poolId: balPoolId, kind: 0, assetIn: _tgtErc20, assetOut: SDAI, amount: erc20Bal, userData: "" }),
            FundManagement({ sender: address(this), fromInternalBalance: false, recipient: payable(address(this)), toInternalBalance: false }),
            0, block.timestamp + 300
        );

        uint256 sdaiFinal = IERC20(SDAI).balanceOf(address(this));
        emit Step(7, sdaiFinal);
        require(sdaiFinal >= minOut, "slip");
        IERC20(SDAI).transfer(msg.sender, sdaiFinal);
    }

    // Stored collateral for groupMint (set before calling executeGroupMint)
    uint256[] public gmCollateralAvatars;
    uint256[] public gmCollateralAmounts;

    function setGroupMintCollateral(uint256[] calldata avatars, uint256[] calldata amounts) external onlyOwner {
        gmCollateralAvatars = avatars;
        gmCollateralAmounts = amounts;
    }

    /// @notice Two-step group arb: flowMatrix to get personal CRC, then groupMint
    function executeGroupMint(
        uint256 spendAmount,
        uint256 _minSdaiOut,
        address[] calldata flowVertices,
        FlowEdge[] calldata flow,
        Stream[] calldata streams,
        bytes calldata packedCoordinates
    ) external onlyOwner {
        minOut = _minSdaiOut;
        // 1. Pull sDAI
        require(IERC20(SDAI).transferFrom(msg.sender, address(this), spendAmount), "s1");

        // 2. Swap sDAI → source group CRC on UniV3
        _inSwap = true;
        IUniV3Pool(uniPool).swap(address(this), true, int256(spendAmount), 4295128740, "");
        _inSwap = false;

        // 3. Unwrap source group CRC (ERC20 → ERC1155)
        _step3();

        // 4. operateFlowMatrix: convert source group CRC → personal CRC (stays at this contract)
        HUB.operateFlowMatrix(flowVertices, flow, streams, packedCoordinates);

        // 5. groupMint: mint target group CRC from personal CRC collateral
        HUB.groupMint(tgtAvatar, gmCollateralAvatars, gmCollateralAmounts, "");

        // 6-8. Wrap target group CRC, sell on Balancer, return sDAI
        _step567();
    }

    // Cross-base: sell CRC for GNO/WETH on Balancer, then swap to WXDAI on SushiSwap, then deposit to sDAI
    address public constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    IUniV2Router public constant SUSHI_ROUTER = IUniV2Router(0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506);
    address public intermediateToken;  // GNO or WETH

    function configureCrossBase(
        address _srcGroupErc20, address _tgtAvatar, address _tgtErc20,
        bytes32 _balPoolId, bytes32 /* _relayPoolId unused */, address _intermediate
    ) external onlyOwner {
        srcGroupErc20 = _srcGroupErc20;
        tgtAvatar = _tgtAvatar;
        tgtErc20 = _tgtErc20;
        balPoolId = _balPoolId;
        intermediateToken = _intermediate;
    }

    function executeCrossBase(
        uint256 spendAmount,
        uint256 _minSdaiOut,
        address[] calldata flowVertices,
        FlowEdge[] calldata flow,
        Stream[] calldata streams,
        bytes calldata packedCoordinates
    ) external onlyOwner {
        minOut = _minSdaiOut;
        // 1. Pull sDAI
        require(IERC20(SDAI).transferFrom(msg.sender, address(this), spendAmount), "s1");
        // 2. Swap sDAI → group CRC on UniV3
        _inSwap = true;
        IUniV3Pool(uniPool).swap(address(this), true, int256(spendAmount), 4295128740, "");
        _inSwap = false;
        // 3. Unwrap group CRC
        _step3();
        // 4. operateFlowMatrix
        HUB.operateFlowMatrix(flowVertices, flow, streams, packedCoordinates);
        // 5-8. Wrap, sell via batchSwap (CRC→intermediate→WXDAI), convert WXDAI→sDAI
        _stepCrossBase();
    }

    function _stepCrossBase() internal {
        // 5. Wrap personal CRC ERC1155 → ERC20
        address _tgt = tgtAvatar;
        uint256 tgtBal = HUB.balanceOf(address(this), uint256(uint160(_tgt)));
        require(tgtBal > 0, "s5:nobal");
        HUB.wrap(_tgt, tgtBal, 1);

        // 6. Sell CRC for GNO/WETH on Balancer
        address _tgtErc20 = tgtErc20;
        uint256 erc20Bal = IERC20(_tgtErc20).balanceOf(address(this));
        require(erc20Bal > 0, "s6:noerc");
        (bool ok,) = _tgtErc20.call(abi.encodeWithSelector(0x095ea7b3, address(BAL_VAULT), erc20Bal));
        require(ok, "s6:apr");
        address _inter = intermediateToken;
        BAL_VAULT.swap(
            SingleSwap({ poolId: balPoolId, kind: 0, assetIn: _tgtErc20, assetOut: _inter, amount: erc20Bal, userData: "" }),
            FundManagement({ sender: address(this), fromInternalBalance: false, recipient: payable(address(this)), toInternalBalance: false }),
            0, block.timestamp + 300
        );

        // 7. Swap GNO/WETH → WXDAI on SushiSwap
        uint256 interBal = IERC20(_inter).balanceOf(address(this));
        IERC20(_inter).approve(address(SUSHI_ROUTER), interBal);
        address[] memory path = new address[](2);
        path[0] = _inter;
        path[1] = WXDAI;
        SUSHI_ROUTER.swapExactTokensForTokens(interBal, 0, path, address(this), block.timestamp + 300);

        // 8. Convert WXDAI → sDAI
        uint256 wxdaiBal = IERC20(WXDAI).balanceOf(address(this));
        IWXDAI(WXDAI).approve(SDAI, wxdaiBal);
        ISDAIVault(SDAI).deposit(wxdaiBal, address(this));

        // 9. Return sDAI
        uint256 sdaiFinal = IERC20(SDAI).balanceOf(address(this));
        require(sdaiFinal >= minOut, "slip");
        IERC20(SDAI).transfer(msg.sender, sdaiFinal);
    }

    function withdrawToken(address token) external onlyOwner {
        uint256 b = IERC20(token).balanceOf(address(this));
        if (b > 0) IERC20(token).transfer(owner, b);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256, bytes calldata) external {
        require(msg.sender == uniPool && _inSwap, "!pool");
        if (amount0Delta > 0) IERC20(SDAI).transfer(msg.sender, uint256(amount0Delta));
    }

    function onERC1155Received(address,address,uint256,uint256,bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
    function onERC1155BatchReceived(address,address,uint256[] calldata,uint256[] calldata,bytes calldata) external pure returns (bytes4) { return 0xbc197c81; }
    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x01ffc9a7 || id == 0x4e2312e0; }

    function trustAvatar(address avatar) external onlyOwner { HUB.trust(avatar, type(uint96).max); }
}
