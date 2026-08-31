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
    function withdraw(uint256) external;
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

interface ILossRewardPool {
    function depositReward(address token) external payable;
}

interface IIncentifiToken {
    function creator() external view returns (address);
}

/**
 * @title IncentifiSwapRouter
 * @notice Trading gateway wrapping Uniswap V3 SwapRouter02.
 *         Deducts the 1.0% creator trading fee on every buy/sell in native ETH:
 *         - 50% (0.5%) forwarded directly to the token creator in native ETH.
 *         - 50% (0.5%) deposited into LossRewardPool for the token.
 */
contract IncentifiSwapRouter {
    ISwapRouter02 public immutable uniswapRouter;
    IWETH9 public immutable WETH9;
    ILossRewardPool public immutable lossRewardPool;

    uint24 public constant POOL_FEE = 10000; // 1% Uniswap V3 pool fee
    uint256 public constant CREATOR_FEE_BPS = 100; // 1.0% creator trading fee (100 bps)
    uint256 public constant BPS_DENOMINATOR = 10000;

    event IncentifiTrade(
        address indexed token,
        address indexed trader,
        bool indexed isBuy,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 creatorFee,
        uint256 lossPoolFee
    );

    error Expired();
    error ZeroAmount();
    error ZeroAddress();
    error SlippageExceeded();
    error TransferFailed();

    constructor(
        address _uniswapRouter,
        address _weth,
        address _lossRewardPool
    ) {
        if (_uniswapRouter == address(0) || _weth == address(0) || _lossRewardPool == address(0)) {
            revert ZeroAddress();
        }
        uniswapRouter = ISwapRouter02(_uniswapRouter);
        WETH9 = IWETH9(_weth);
        lossRewardPool = ILossRewardPool(_lossRewardPool);
    }

    /**
     * @notice Buy Incentifi tokens with native ETH.
     * @param token Address of the ERC20 token to buy.
     * @param amountOutMinimum Minimum tokens required out (slippage protection).
     * @param deadline Unix timestamp after which the trade will revert.
     */
    function buyToken(
        address token,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external payable returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroAmount();
        if (token == address(0)) revert ZeroAddress();

        uint256 fee = (msg.value * CREATOR_FEE_BPS) / BPS_DENOMINATOR;
        uint256 creatorShare = fee / 2;
        uint256 lossPoolShare = fee - creatorShare;
        uint256 swapEthAmount = msg.value - fee;

        // 1. Send Creator Share
        _sendCreatorFee(token, creatorShare);

        // 2. Deposit Loss Pool Share
        if (lossPoolShare > 0) {
            lossRewardPool.depositReward{value: lossPoolShare}(token);
        }

        // 3. Wrap remaining ETH and swap on Uniswap V3
        WETH9.deposit{value: swapEthAmount}();
        WETH9.approve(address(uniswapRouter), swapEthAmount);

        amountOut = uniswapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(WETH9),
                tokenOut: token,
                fee: POOL_FEE,
                recipient: msg.sender,
                amountIn: swapEthAmount,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        emit IncentifiTrade(
            token,
            msg.sender,
            true,
            swapEthAmount,
            amountOut,
            creatorShare,
            lossPoolShare
        );
    }

    /**
     * @notice Sell Incentifi tokens for native ETH.
     * @param token Address of the ERC20 token to sell.
     * @param tokenAmountIn Amount of tokens to sell.
     * @param minEthOut Minimum net ETH expected after 1% creator fee.
     * @param deadline Unix timestamp after which the trade will revert.
     */
    function sellToken(
        address token,
        uint256 tokenAmountIn,
        uint256 minEthOut,
        uint256 deadline
    ) external returns (uint256 netEthOut) {
        if (block.timestamp > deadline) revert Expired();
        if (tokenAmountIn == 0) revert ZeroAmount();
        if (token == address(0)) revert ZeroAddress();

        // 1. Pull tokens and approve Uniswap
        if (!IERC20(token).transferFrom(msg.sender, address(this), tokenAmountIn)) {
            revert TransferFailed();
        }
        IERC20(token).approve(address(uniswapRouter), tokenAmountIn);

        // 2. Swap tokens -> WETH
        uint256 grossEth = uniswapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: address(WETH9),
                fee: POOL_FEE,
                recipient: address(this),
                amountIn: tokenAmountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        if (grossEth == 0) revert ZeroAmount();

        // 3. Unwrap WETH
        WETH9.withdraw(grossEth);

        // 4. Calculate Fee and Split
        uint256 fee = (grossEth * CREATOR_FEE_BPS) / BPS_DENOMINATOR;
        uint256 creatorShare = fee / 2;
        uint256 lossPoolShare = fee - creatorShare;
        netEthOut = grossEth - fee;

        if (netEthOut < minEthOut) revert SlippageExceeded();

        // 5. Route Creator Share
        _sendCreatorFee(token, creatorShare);

        // 6. Route Loss Pool Share
        if (lossPoolShare > 0) {
            lossRewardPool.depositReward{value: lossPoolShare}(token);
        }

        // 7. Transfer net ETH to seller
        (bool success, ) = msg.sender.call{value: netEthOut}("");
        if (!success) revert TransferFailed();

        emit IncentifiTrade(
            token,
            msg.sender,
            false,
            netEthOut,
            tokenAmountIn,
            creatorShare,
            lossPoolShare
        );
    }

    function _sendCreatorFee(address token, uint256 amount) internal {
        if (amount == 0) return;
        address creator = address(0);
        try IIncentifiToken(token).creator() returns (address c) {
            creator = c;
        } catch {}
        if (creator == address(0)) {
            creator = msg.sender;
        }
        (bool success, ) = creator.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    receive() external payable {}
}
