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

interface IIncentifiBondingCurve {
    function graduated() external view returns (bool);
    function buy(uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minEthOut, address payable recipient) external returns (uint256 netEthOut);
    function depositCreatorFee() external payable;
}

interface IBondingCurveFactory {
    function getBondingCurve(address token) external view returns (address);
}

/**
 * @title IncentifiSwapRouter
 * @notice Trading gateway supporting pre-graduation Bonding Curve swaps
 *         and post-graduation Uniswap V3 swaps seamlessly with 1% fee split.
 */
contract IncentifiSwapRouter {
    ISwapRouter02 public immutable uniswapRouter;
    IWETH9 public immutable WETH9;
    ILossRewardPool public immutable lossRewardPool;
    address public immutable bondingCurveFactory;

    uint24 public constant POOL_FEE = 10000; // 1% Uniswap V3 pool fee
    uint256 public constant PROTOCOL_FEE_BPS = 200; // 2.00% total trading fee (200 bps)
    uint256 public constant CREATOR_FEE_BPS = 100; // 1.00% creator share (100 bps)
    uint256 public constant LOSS_REWARD_FEE_BPS = 100; // 1.00% loss reward pool share (100 bps)
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
        address _lossRewardPool,
        address _bondingCurveFactory
    ) {
        if (_uniswapRouter == address(0) || _weth == address(0) || _lossRewardPool == address(0)) {
            revert ZeroAddress();
        }
        uniswapRouter = ISwapRouter02(_uniswapRouter);
        WETH9 = IWETH9(_weth);
        lossRewardPool = ILossRewardPool(_lossRewardPool);
        bondingCurveFactory = _bondingCurveFactory;
    }

    /**
     * @notice Buy Incentifi tokens with native ETH (auto-routes to curve or Uniswap V3).
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

        // Check if token is in pre-graduation bonding curve phase
        if (bondingCurveFactory != address(0)) {
            address curve = IBondingCurveFactory(bondingCurveFactory).getBondingCurve(token);
            if (curve != address(0) && !IIncentifiBondingCurve(curve).graduated()) {
                uint256 balanceBefore = address(this).balance - msg.value;
                amountOut = IIncentifiBondingCurve(curve).buy{value: msg.value}(amountOutMinimum, msg.sender);
                uint256 balanceAfter = address(this).balance;
                if (balanceAfter > balanceBefore) {
                    uint256 refund = balanceAfter - balanceBefore;
                    (bool success, ) = msg.sender.call{value: refund}("");
                    if (!success) revert TransferFailed();
                }
                return amountOut;
            }
        }

        // Post-graduation Uniswap V3 Routing
        uint256 creatorShare = (msg.value * CREATOR_FEE_BPS) / BPS_DENOMINATOR;
        uint256 lossPoolShare = (msg.value * LOSS_REWARD_FEE_BPS) / BPS_DENOMINATOR;
        uint256 fee = creatorShare + lossPoolShare;
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
     * @notice Sell Incentifi tokens for native ETH (auto-routes to curve or Uniswap V3).
     * @param token Address of the ERC20 token to sell.
     * @param tokenAmountIn Amount of tokens to sell.
     * @param minEthOut Minimum net ETH expected after 2% protocol fee.
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

        // Pull tokens from the seller, measuring the actual balance delta
        // rather than trusting `tokenAmountIn` — a fee-on-transfer token
        // delivers less than the nominal amount requested, and approving/
        // swapping the nominal amount would then try to move tokens this
        // router never actually received.
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        if (!IERC20(token).transferFrom(msg.sender, address(this), tokenAmountIn)) {
            revert TransferFailed();
        }
        uint256 actualAmountIn = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (actualAmountIn == 0) revert ZeroAmount();

        // Check if token is in pre-graduation bonding curve phase
        if (bondingCurveFactory != address(0)) {
            address curve = IBondingCurveFactory(bondingCurveFactory).getBondingCurve(token);
            if (curve != address(0) && !IIncentifiBondingCurve(curve).graduated()) {
                IERC20(token).approve(curve, actualAmountIn);
                netEthOut = IIncentifiBondingCurve(curve).sell(actualAmountIn, minEthOut, payable(msg.sender));
                return netEthOut;
            }
        }

        // Post-graduation Uniswap V3 Routing
        IERC20(token).approve(address(uniswapRouter), actualAmountIn);

        // Swap tokens -> WETH
        uint256 grossEth = uniswapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: address(WETH9),
                fee: POOL_FEE,
                recipient: address(this),
                amountIn: actualAmountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        if (grossEth == 0) revert ZeroAmount();

        // Unwrap WETH
        WETH9.withdraw(grossEth);

        // Calculate Fee and Split (2% total: 1% creator, 1% loss pool)
        uint256 creatorShare = (grossEth * CREATOR_FEE_BPS) / BPS_DENOMINATOR;
        uint256 lossPoolShare = (grossEth * LOSS_REWARD_FEE_BPS) / BPS_DENOMINATOR;
        uint256 fee = creatorShare + lossPoolShare;
        netEthOut = grossEth - fee;

        if (netEthOut < minEthOut) revert SlippageExceeded();

        // Route Creator Share
        _sendCreatorFee(token, creatorShare);

        // Route Loss Pool Share
        if (lossPoolShare > 0) {
            lossRewardPool.depositReward{value: lossPoolShare}(token);
        }

        // Transfer net ETH to seller
        (bool success, ) = msg.sender.call{value: netEthOut}("");
        if (!success) revert TransferFailed();

        emit IncentifiTrade(
            token,
            msg.sender,
            false,
            netEthOut,
            actualAmountIn,
            creatorShare,
            lossPoolShare
        );
    }

    function _sendCreatorFee(address token, uint256 amount) internal {
        if (amount == 0) return;

        // Preferred path: every token this router is meant to trade has a registered
        // Incentifi bonding curve (created at launch, still present after graduation).
        // Credit the SAME creatorBalances accounting that curve's own buy()/sell()
        // already use, via depositCreatorFee() — one unified pull-payment claim path
        // (claimCreatorFees() on the curve) regardless of whether a fee was earned
        // pre- or post-graduation. This closes the same DoS buy()/sell() were fixed
        // against: an immediate push here would let a creator address that reverts on
        // receiving ETH block every post-graduation trade on this token.
        if (bondingCurveFactory != address(0)) {
            address curve = IBondingCurveFactory(bondingCurveFactory).getBondingCurve(token);
            if (curve != address(0)) {
                IIncentifiBondingCurve(curve).depositCreatorFee{value: amount}();
                return;
            }
        }

        // Fallback: a token with no registered Incentifi curve is outside this
        // router's documented usage (it's built for Incentifi tokens specifically).
        // No pull-payment path exists for this case, but a failed push here can only
        // affect whoever is already calling this trade themselves — `creator` falls
        // back to `msg.sender` below when the token doesn't implement creator() — not
        // a third party, so it isn't the cross-user DoS this fix targets.
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
