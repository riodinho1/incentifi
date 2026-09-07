// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/FixedPoint96.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ILossRewardPoolMin {
    function depositReward(address token) external payable;
}

interface ILegibleHook {
    function poolKeyOf(address token) external view returns (PoolKey memory);
    function poolIdOf(address token) external view returns (PoolId);
    function priceCheckpoints(PoolId poolId) external view returns (uint160 sqrtPriceX96, uint64 blockNumber);
    function creditCreatorFees(address token) external payable;
}

/**
 * @title IncentifiFeeConverter
 * @notice Turns token-denominated (sell-side) LP fees into ETH for the creator and the
 *         LossRewardPool — design decision A ("convert, do not burn").
 * @dev    The hook transfers token fees here and calls notifyTokenFees(). Anyone may then call
 *         convert(): it sells (part of) the pending tokens into the SAME pool as an ordinary swap
 *         — fee-free, and tagged FeesConverted rather than Sold by the hook — takes the ETH, and
 *         routes it 50/50: creator half -> hook.creditCreatorFees (pull-payment), loss-pool half
 *         -> LossRewardPool.depositReward.
 *
 *         Sandwich resistance: convert() is permissionless, so the caller's `minEthOut` is treated
 *         ONLY as an extra constraint, never as the protection. The floor is derived on-chain from
 *         the hook's price checkpoint — the pool price at the end of the previous block the pool
 *         traded in, captured before the first swap of the current block — so nothing done earlier
 *         in the same block (a front-running sell) can move the reference. The conversion must
 *         deliver at least (1 - MAX_SLIPPAGE_BPS) of the checkpoint-implied ETH for the tokens it
 *         actually sold. Fee batches are tiny relative to the curve (2% of trades against a
 *         ~1e9-token virtual reserve), so honest conversions sit far inside the tolerance; a
 *         manipulation that survives the check is bounded to MAX_SLIPPAGE_BPS of one batch, and a
 *         multi-block manipulation has to hold a mispriced position across blocks against arbitrage.
 *         If the pool cannot absorb the whole amount (partial fill), the unconsumed remainder is
 *         re-queued rather than lost; callers can also convert in chunks via `amount`.
 */
contract IncentifiFeeConverter is IUnlockCallback {
    IPoolManager public immutable poolManager;
    ILegibleHook public immutable hook;
    address public immutable lossRewardPool;

    /// @notice Max shortfall vs the checkpoint-implied value, in basis points (3%).
    uint256 public constant MAX_SLIPPAGE_BPS = 300;

    mapping(address => uint256) public pendingTokenFees;

    event TokenFeesReceived(address indexed token, uint256 amount);
    event Converted(address indexed token, uint256 tokensIn, uint256 ethOut, uint256 creatorShare, uint256 lossPoolShare);

    error OnlyHook();
    error OnlyPoolManager();
    error ZeroAddress();
    error NothingToConvert();
    error NoPriceCheckpoint();
    error SlippageExceeded(uint256 ethOut, uint256 floor);
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

    /// @notice ETH the checkpoint price implies for `tokenAmount` (no fee, no impact): the reference
    ///         the on-chain floor is derived from. q = tokens per ETH = sqrtP^2 / 2^192, so
    ///         eth = tokens / q = tokens * 2^96 / sqrtP * 2^96 / sqrtP.
    function checkpointEthValue(address token, uint256 tokenAmount) public view returns (uint256) {
        (uint160 sqrtPriceX96,) = hook.priceCheckpoints(hook.poolIdOf(token));
        if (sqrtPriceX96 == 0) revert NoPriceCheckpoint();
        uint256 step = FullMath.mulDiv(tokenAmount, FixedPoint96.Q96, sqrtPriceX96);
        return FullMath.mulDiv(step, FixedPoint96.Q96, sqrtPriceX96);
    }

    /// @param amount tokens to convert; 0 = everything pending.
    /// @param minEthOut caller's own additional floor; the on-chain floor applies regardless.
    function convert(address token, uint256 amount, uint256 minEthOut) external returns (uint256 ethOut) {
        uint256 pending = pendingTokenFees[token];
        if (amount == 0 || amount > pending) amount = pending;
        if (amount == 0) revert NothingToConvert();
        pendingTokenFees[token] = pending - amount;

        bytes memory result = poolManager.unlock(abi.encode(token, amount));
        uint256 tokensSold;
        (ethOut, tokensSold) = abi.decode(result, (uint256, uint256));

        // On-chain floor on what was ACTUALLY sold (a partial fill re-queues the rest above).
        uint256 floor = checkpointEthValue(token, tokensSold) * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;
        if (minEthOut > floor) floor = minEthOut;
        if (ethOut < floor) revert SlippageExceeded(ethOut, floor);

        uint256 creatorShare = ethOut / 2;
        uint256 lossShare = ethOut - creatorShare;
        if (creatorShare > 0) hook.creditCreatorFees{value: creatorShare}(token);
        if (lossShare > 0) ILossRewardPoolMin(lossRewardPool).depositReward{value: lossShare}(token);
        emit Converted(token, tokensSold, ethOut, creatorShare, lossShare);
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

        return abi.encode(ethOut, tokensIn);
    }

    receive() external payable {}
}
