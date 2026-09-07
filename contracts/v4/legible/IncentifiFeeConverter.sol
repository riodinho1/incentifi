// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ILossRewardPoolMin {
    function depositReward(address token) external payable;
}

interface ILegibleHook {
    function poolKeyOf(address token) external view returns (PoolKey memory);
    function creditCreatorFees(address token) external payable;
}

/**
 * @title IncentifiFeeConverter
 * @notice Turns token-denominated (sell-side) LP fees into ETH for the creator and the
 *         LossRewardPool — design decision A ("convert, do not burn"), so loss-reward funding is
 *         not halved to buy-side fees only.
 * @dev    The hook transfers token fees here and calls notifyTokenFees(). Anyone may then call
 *         convert(): it sells the pending tokens into the SAME pool as an ordinary swap (the hook
 *         recognises this contract as the sender and emits FeesConverted instead of Sold, so the
 *         indexer never sees a phantom holder trade), takes the ETH, and routes it 50/50:
 *         creator half -> hook.creditCreatorFees (pull-payment), loss-pool half ->
 *         LossRewardPool.depositReward. `minEthOut` is the caller's slippage guard. If the pool
 *         cannot absorb the whole amount (price walked off the top of the curve range), the
 *         unconsumed remainder is re-queued rather than lost.
 */
contract IncentifiFeeConverter is IUnlockCallback {
    IPoolManager public immutable poolManager;
    ILegibleHook public immutable hook;
    address public immutable lossRewardPool;

    mapping(address => uint256) public pendingTokenFees;

    event TokenFeesReceived(address indexed token, uint256 amount);
    event Converted(address indexed token, uint256 tokensIn, uint256 ethOut, uint256 creatorShare, uint256 lossPoolShare);

    error OnlyHook();
    error OnlyPoolManager();
    error ZeroAddress();
    error NothingToConvert();
    error SlippageExceeded();
    error TokenTransferFailed();

    constructor(IPoolManager _poolManager, address _hook, address _lossRewardPool) {
        if (address(_poolManager) == address(0) || _hook == address(0) || _lossRewardPool == address(0)) revert ZeroAddress();
        poolManager = _poolManager;
        hook = ILegibleHook(_hook);
        lossRewardPool = _lossRewardPool;
    }

    function notifyTokenFees(address token, uint256 amount) external {
        if (msg.sender != address(hook)) revert OnlyHook();
        pendingTokenFees[token] += amount;
        emit TokenFeesReceived(token, amount);
    }

    function convert(address token, uint256 minEthOut) external returns (uint256 ethOut) {
        uint256 amount = pendingTokenFees[token];
        if (amount == 0) revert NothingToConvert();
        pendingTokenFees[token] = 0;

        bytes memory result = poolManager.unlock(abi.encode(token, amount));
        ethOut = abi.decode(result, (uint256));
        if (ethOut < minEthOut) revert SlippageExceeded();

        uint256 creatorShare = ethOut / 2;
        uint256 lossShare = ethOut - creatorShare;
        if (creatorShare > 0) hook.creditCreatorFees{value: creatorShare}(token);
        if (lossShare > 0) ILossRewardPoolMin(lossRewardPool).depositReward{value: lossShare}(token);
        emit Converted(token, amount - pendingTokenFees[token], ethOut, creatorShare, lossShare);
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (address token, uint256 amount) = abi.decode(data, (address, uint256));
        PoolKey memory key = hook.poolKeyOf(token);

        // Sell tokens (currency1) for ETH (currency0): oneForZero, exact input.
        BalanceDelta delta = poolManager.swap(
            key, SwapParams({zeroForOne: false, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}), ""
        );
        uint256 tokensIn = delta.amount1() < 0 ? uint256(uint128(-delta.amount1())) : 0;
        uint256 ethOut = delta.amount0() > 0 ? uint256(uint128(delta.amount0())) : 0;

        if (tokensIn > 0) {
            poolManager.sync(key.currency1);
            if (!IERC20Min(token).transfer(address(poolManager), tokensIn)) revert TokenTransferFailed();
            poolManager.settle();
        }
        if (ethOut > 0) poolManager.take(key.currency0, address(this), ethOut);
        if (tokensIn < amount) pendingTokenFees[token] += amount - tokensIn; // partial fill: keep the rest queued

        return abi.encode(ethOut);
    }

    receive() external payable {}
}
