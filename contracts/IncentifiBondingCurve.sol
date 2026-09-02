// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface ILossRewardPool {
    function depositReward(address token) external payable;
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        );

    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/**
 * @title SafeTransferLib
 * @dev Safe ERC20 and ETH transfer operations.
 */
library SafeTransferLib {
    error TransferFailed();
    error ETHTransferFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function safeTransferETH(address to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        if (!success) {
            revert ETHTransferFailed();
        }
    }
}

/**
 * @title IncentifiBondingCurve
 * @notice Native bonding curve pricing with deterministic initial market cap ($5,000)
 *         and automatic graduation to Uniswap V3 at $69,000 market cap.
 *         Enforces 1.0% fee split: 0.5% creator, 0.5% LossRewardPool in native ETH.
 *         Maintains donation-resistant internal tracked reserves and atomically burns V3 LP NFT.
 */
contract IncentifiBondingCurve {
    using SafeTransferLib for address;

    // ------------------------------------------------------------------------
    // Immutables & Config
    // ------------------------------------------------------------------------
    address public immutable token;
    address public immutable creator;
    address public immutable lossRewardPool;
    address public immutable weth;
    address public immutable positionManager;
    address public immutable uniswapFactory;

    // ------------------------------------------------------------------------
    // Authoritative Verified Constants
    // ------------------------------------------------------------------------
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e18; // 1 Billion Tokens (18 decimals)
    uint256 public constant VIRTUAL_ETH = 2156250000000000000; // 2.15625 ETH
    uint256 public constant VIRTUAL_TOKEN = 78125000000000000000000000; // 78,125,000 Tokens (18 decimals)
    uint256 public constant INVARIANT_K = 2324707031250000000000000000000000000000000000; // 2.32470703125e45
    uint256 public constant GRADUATION_ETH_TARGET = 5853863234375000000; // 5.853863234375 ETH in wei
    uint160 public constant GRADUATION_SQRT_PRICE_X96 = 476897496634883656268812375606081; // Exact V3 graduation sqrtPriceX96
    int24 public constant TICK_LOWER = -887200;
    int24 public constant TICK_UPPER = 887200;
    uint24 public constant POOL_FEE = 10000; // 1.00% Uniswap V3 fee tier
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // Protocol Fee Constants (2.0% Total: 1.0% Creator / 1.0% LossRewardPool)
    uint256 public constant PROTOCOL_FEE_BPS = 200; // 2.00% total trading fee
    uint256 public constant CREATOR_FEE_BPS = 100; // 1.00% creator fee
    uint256 public constant LOSS_REWARD_FEE_BPS = 100; // 1.00% LossRewardPool fee
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ------------------------------------------------------------------------
    // Tracked State
    // ------------------------------------------------------------------------
    uint256 public realEthReserve;
    uint256 public realTokenReserve;
    bool public initialized;
    bool public graduated;
    uint256 public lpTokenId;
    address public uniswapPool;

    // Reentrancy Guard
    uint256 private _status;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------
    event Initialized(address indexed token, address indexed creator, uint256 initialSupply);
    event TokensPurchased(
        address indexed buyer,
        address indexed recipient,
        uint256 ethInGross,
        uint256 tokensOut,
        uint256 creatorFee,
        uint256 lossPoolFee
    );
    event TokensSold(
        address indexed seller,
        address indexed recipient,
        uint256 tokensIn,
        uint256 netEthOut,
        uint256 creatorFee,
        uint256 lossPoolFee
    );
    event Graduated(
        address indexed pool,
        uint256 tokenId,
        uint256 wethAmount,
        uint256 tokenAmount
    );

    // ------------------------------------------------------------------------
    // Custom Errors
    // ------------------------------------------------------------------------
    error AlreadyInitialized();
    error NotInitialized();
    error AlreadyGraduated();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientSupply();
    error SlippageExceeded();
    error InsufficientReserve();
    error Reentrancy();
    error NotAuthorized();

    modifier nonReentrant() {
        if (_status == _ENTERED) revert Reentrancy();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    constructor(
        address _token,
        address _creator,
        address _lossRewardPool,
        address _weth,
        address _positionManager,
        address _uniswapFactory
    ) {
        if (
            _token == address(0) ||
            _creator == address(0) ||
            _lossRewardPool == address(0) ||
            _weth == address(0) ||
            _positionManager == address(0) ||
            _uniswapFactory == address(0)
        ) {
            revert ZeroAddress();
        }

        token = _token;
        creator = _creator;
        lossRewardPool = _lossRewardPool;
        weth = _weth;
        positionManager = _positionManager;
        uniswapFactory = _uniswapFactory;
        _status = _NOT_ENTERED;
    }

    /**
     * @notice Initializes the bonding curve once 1B real tokens have been deposited.
     */
    function initialize() external {
        if (initialized) revert AlreadyInitialized();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < TOTAL_SUPPLY) revert InsufficientSupply();

        realTokenReserve = TOTAL_SUPPLY;
        realEthReserve = 0;
        initialized = true;

        emit Initialized(token, creator, TOTAL_SUPPLY);
    }

    /**
     * @notice Buy tokens with native ETH.
     * @param minTokensOut Minimum tokens expected (slippage protection).
     * @param recipient Address to receive purchased tokens.
     */
    function buy(uint256 minTokensOut, address recipient) external payable nonReentrant returns (uint256 tokensOut) {
        if (!initialized) revert NotInitialized();
        if (graduated) revert AlreadyGraduated();
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 grossEth = msg.value;
        {
            uint256 maxNetEth = GRADUATION_ETH_TARGET - realEthReserve;
            uint256 maxGrossEth = 100 * (maxNetEth / 98) + (maxNetEth % 98);
            if (grossEth > maxGrossEth) {
                uint256 refund = grossEth - maxGrossEth;
                grossEth = maxGrossEth;
                SafeTransferLib.safeTransferETH(msg.sender, refund);
            }
        }

        uint256 creatorFee = grossEth / 100; // 1.00%
        uint256 lossPoolFee = grossEth / 100; // 1.00%
        uint256 netEth = grossEth - creatorFee - lossPoolFee; // 98.00%

        // Pay creator fee in native ETH if non-zero
        if (creatorFee > 0) {
            creator.safeTransferETH(creatorFee);
        }

        // Deposit loss reward pool fee in native ETH if non-zero
        if (lossPoolFee > 0) {
            ILossRewardPool(lossRewardPool).depositReward{value: lossPoolFee}(token);
        }

        // Calculate token output from invariant
        {
            uint256 newEth = VIRTUAL_ETH + realEthReserve + netEth;
            tokensOut = (VIRTUAL_TOKEN + realTokenReserve) - (INVARIANT_K / newEth);
        }

        if (tokensOut < minTokensOut) revert SlippageExceeded();
        if (tokensOut > realTokenReserve) revert InsufficientReserve();

        realEthReserve += netEth;
        realTokenReserve -= tokensOut;

        token.safeTransfer(recipient, tokensOut);

        emit TokensPurchased(msg.sender, recipient, grossEth, tokensOut, creatorFee, lossPoolFee);

        // Check for graduation trigger
        if (realEthReserve >= GRADUATION_ETH_TARGET) {
            _graduate();
        }
    }

    /**
     * @notice Sell tokens for native ETH.
     * @param tokensIn Amount of tokens to sell.
     * @param minEthOut Minimum net ETH expected (slippage protection).
     * @param recipient Address to receive net ETH.
     */
    function sell(uint256 tokensIn, uint256 minEthOut, address payable recipient) external nonReentrant returns (uint256 netEthOut) {
        if (!initialized) revert NotInitialized();
        if (graduated) revert AlreadyGraduated();
        if (tokensIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        // Transfer tokens from seller into curve vault
        token.safeTransferFrom(msg.sender, address(this), tokensIn);

        // Calculate gross ETH output from invariant
        uint256 currentEth = VIRTUAL_ETH + realEthReserve;
        uint256 currentToken = VIRTUAL_TOKEN + realTokenReserve;

        uint256 newToken = currentToken + tokensIn;
        uint256 newEth = INVARIANT_K / newToken;
        uint256 grossEthOut = currentEth - newEth;

        if (grossEthOut > realEthReserve) revert InsufficientReserve();

        uint256 creatorFee = grossEthOut / 100; // 1.00%
        uint256 lossPoolFee = grossEthOut / 100; // 1.00%
        netEthOut = grossEthOut - creatorFee - lossPoolFee; // 98.00%

        if (netEthOut < minEthOut) revert SlippageExceeded();

        realEthReserve -= grossEthOut;
        realTokenReserve += tokensIn;

        // Pay creator fee in native ETH
        if (creatorFee > 0) {
            creator.safeTransferETH(creatorFee);
        }

        // Deposit loss reward pool fee in native ETH
        if (lossPoolFee > 0) {
            ILossRewardPool(lossRewardPool).depositReward{value: lossPoolFee}(token);
        }

        // Pay net ETH to seller
        SafeTransferLib.safeTransferETH(recipient, netEthOut);

        emit TokensSold(msg.sender, recipient, tokensIn, netEthOut, creatorFee, lossPoolFee);
    }

    /**
     * @dev Executes atomic graduation to Uniswap V3.
     */
    function _graduate() internal {
        graduated = true;

        uint256 wethDeposit = realEthReserve;
        uint256 tokenDeposit = realTokenReserve;

        // Wrap exact accumulated real ETH into WETH
        IWETH9(weth).deposit{value: wethDeposit}();

        // Determine token0 / token1 ordering for Uniswap V3
        address token0 = weth < token ? weth : token;
        address token1 = weth < token ? token : weth;
        uint256 amount0Desired = weth < token ? wethDeposit : tokenDeposit;
        uint256 amount1Desired = weth < token ? tokenDeposit : wethDeposit;

        // Approve PositionManager for exact deposits
        IERC20(weth).approve(positionManager, wethDeposit);
        IERC20(token).approve(positionManager, tokenDeposit);

        // Create and initialize pool at exact graduation sqrtPriceX96
        uniswapPool = INonfungiblePositionManager(positionManager).createAndInitializePoolIfNecessary(
            token0,
            token1,
            POOL_FEE,
            GRADUATION_SQRT_PRICE_X96
        );

        // Mint full-range LP position
        (uint256 tokenId, , , ) = INonfungiblePositionManager(positionManager).mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        lpTokenId = tokenId;

        // Permanently burn LP NFT by sending to dead address
        INonfungiblePositionManager(positionManager).safeTransferFrom(
            address(this),
            DEAD_ADDRESS,
            tokenId
        );

        emit Graduated(uniswapPool, tokenId, wethDeposit, tokenDeposit);
    }

    // ------------------------------------------------------------------------
    // View Functions & Quoting
    // ------------------------------------------------------------------------

    function getAmountOutTokens(uint256 grossEthIn) external view returns (
        uint256 tokensOut,
        uint256 creatorFee,
        uint256 lossPoolFee
    ) {
        if (grossEthIn == 0 || graduated) return (0, 0, 0);

        uint256 maxNetEth = GRADUATION_ETH_TARGET > realEthReserve ? GRADUATION_ETH_TARGET - realEthReserve : 0;
        if (maxNetEth == 0) return (0, 0, 0);

        uint256 k = maxNetEth / 98;
        uint256 r = maxNetEth % 98;
        uint256 maxGrossEth = 100 * k + r;

        uint256 grossEth = grossEthIn > maxGrossEth ? maxGrossEth : grossEthIn;

        creatorFee = grossEth / 100;
        lossPoolFee = grossEth / 100;
        uint256 netEth = grossEth - creatorFee - lossPoolFee;

        uint256 currentEth = VIRTUAL_ETH + realEthReserve;
        uint256 currentToken = VIRTUAL_TOKEN + realTokenReserve;

        uint256 newEth = currentEth + netEth;
        uint256 newToken = INVARIANT_K / newEth;
        tokensOut = currentToken - newToken;
        if (tokensOut > realTokenReserve) {
            tokensOut = realTokenReserve;
        }
    }

    /**
     * @dev ERC721 Receiver hook to accept LP NFT minting from PositionManager.
     */
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function getAmountOutEth(uint256 tokensIn) external view returns (
        uint256 netEthOut,
        uint256 creatorFee,
        uint256 lossPoolFee
    ) {
        if (tokensIn == 0 || graduated) return (0, 0, 0);

        uint256 currentEth = VIRTUAL_ETH + realEthReserve;
        uint256 currentToken = VIRTUAL_TOKEN + realTokenReserve;

        uint256 newToken = currentToken + tokensIn;
        uint256 newEth = INVARIANT_K / newToken;
        uint256 grossEthOut = currentEth - newEth;
        if (grossEthOut > realEthReserve) {
            grossEthOut = realEthReserve;
        }

        creatorFee = grossEthOut / 100;
        lossPoolFee = grossEthOut / 100;
        netEthOut = grossEthOut - creatorFee - lossPoolFee;
    }

    /**
     * @notice Returns current spot price in wei ETH per 1 Token (1e18 scaled).
     */
    function getCurrentPrice() external view returns (uint256) {
        uint256 currentEth = VIRTUAL_ETH + realEthReserve;
        uint256 currentToken = VIRTUAL_TOKEN + realTokenReserve;
        // Price = (currentEth * 1e18) / currentToken
        return (currentEth * 1e18) / currentToken;
    }

    /**
     * @notice Returns progress to graduation in basis points (0 to 10000 bps).
     */
    function getProgressBps() external view returns (uint256) {
        if (graduated || realEthReserve >= GRADUATION_ETH_TARGET) return 10000;
        return (realEthReserve * 10000) / GRADUATION_ETH_TARGET;
    }

    receive() external payable {}
}
