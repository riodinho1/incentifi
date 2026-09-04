// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title GenericV4Bot
 * @notice TEST-ONLY. A minimal, standalone caller written against nothing but
 *         the PUBLIC Uniswap V4 core interfaces (IPoolManager, IUnlockCallback,
 *         PoolKey, SwapParams, ModifyLiquidityParams, Currency) — no import of,
 *         and no reference to, IncentifiV4Hook, IncentifiV4Factory, or
 *         IncentifiV4Router anywhere in this file. Stands in for "any generic
 *         V4-aware bot, router, or LP, with zero Incentifi-specific knowledge,
 *         that discovers this pool via its PoolKey/PoolId alone" — proving the
 *         pool is genuinely permissionless, both for trading (swap()) and,
 *         once graduated, for providing liquidity (addLiquidity()).
 *
 * @dev HONEST LIMITATION vs. the v3 fork test's equivalent check: the v3 suite's
 *      "generic bot" call went through SwapRouter02 — a real, already-deployed
 *      Uniswap periphery contract nobody at Incentifi wrote. No equivalent real,
 *      pre-deployed generic V4 router/UniversalRouter/PositionManager address
 *      was found on this chain/fork to call the same way, so this is a
 *      from-scratch reference implementation of the same "generic caller"
 *      property, built only from Uniswap's published V4 interfaces, rather than
 *      a call against a real pre-existing generic contract. Flagged rather than
 *      overstated.
 */
contract GenericV4Bot is IUnlockCallback {
    IPoolManager public immutable poolManager;

    error OnlyPoolManager();
    error SlippageExceeded();
    error UnknownCall();

    enum CallKind {
        Swap,
        AddLiquidity
    }

    struct SwapCall {
        PoolKey key;
        SwapParams params;
        uint256 minAmountOut;
        address trader;
    }

    struct LPCall {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
        address trader;
        uint256 ethProvided;
    }

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    /// @notice Exact-input swap against `key`, with zero knowledge of what hook
    /// (if any) is attached — exactly what a generic bot would do armed with
    /// nothing but a PoolKey and the standard V4 ABI. For a currency0 (native
    /// ETH) input, send exactly `amountIn` as msg.value.
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut)
        external
        payable
        returns (uint256 amountOut)
    {
        // A real swap against real liquidity (as opposed to one a full-absorption
        // hook reduces to a zero-amount no-op for the core pool, which never
        // reaches this validation at all) requires a genuinely bounded price
        // limit — Pool.sol rejects 0 outright (PriceLimitOutOfBounds, since 0 is
        // always <= TickMath.MIN_SQRT_PRICE). Use the widest valid limit in each
        // direction, i.e. "no meaningful limit", matching ordinary router
        // behavior for an exact-input trade with no explicit price bound.
        uint160 sqrtPriceLimitX96 = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        bytes memory result = poolManager.unlock(
            abi.encode(
                CallKind.Swap,
                abi.encode(
                    SwapCall({
                        key: key,
                        params: SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: sqrtPriceLimitX96}),
                        minAmountOut: minAmountOut,
                        trader: msg.sender
                    })
                )
            )
        );
        amountOut = abi.decode(result, (uint256));
    }

    /// @notice Adds real liquidity to `key` at [tickLower, tickUpper], with zero
    /// Incentifi-specific knowledge — proving a genuine third party, not just
    /// the hook itself, can provide liquidity once a pool allows it (which
    /// IncentifiV4Hook only ever does post-graduation; pre-graduation this will
    /// revert inside the hook's own beforeAddLiquidity, exactly as intended).
    /// Caller must send generous ETH (refunded if unused) and have approved
    /// this contract for a generous token amount beforehand — the exact amount
    /// actually required is computed by the real pool math inside the callback,
    /// not predicted here.
    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)
        external
        payable
        returns (uint256 ethUsed, uint256 tokenUsed)
    {
        bytes memory result = poolManager.unlock(
            abi.encode(
                CallKind.AddLiquidity,
                abi.encode(
                    LPCall({
                        key: key,
                        tickLower: tickLower,
                        tickUpper: tickUpper,
                        liquidityDelta: liquidityDelta,
                        salt: salt,
                        trader: msg.sender,
                        ethProvided: msg.value
                    })
                )
            )
        );
        (ethUsed, tokenUsed) = abi.decode(result, (uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (CallKind kind, bytes memory payload) = abi.decode(data, (CallKind, bytes));
        if (kind == CallKind.Swap) {
            return abi.encode(_executeSwap(abi.decode(payload, (SwapCall))));
        } else if (kind == CallKind.AddLiquidity) {
            (uint256 ethUsed, uint256 tokenUsed) = _executeAddLiquidity(abi.decode(payload, (LPCall)));
            return abi.encode(ethUsed, tokenUsed);
        }
        revert UnknownCall();
    }

    function _executeSwap(SwapCall memory call) internal returns (uint256 amountOut) {
        BalanceDelta delta = poolManager.swap(call.key, call.params, "");

        (Currency inCurrency, Currency outCurrency, int128 inDelta, int128 outDelta) = call.params.zeroForOne
            ? (call.key.currency0, call.key.currency1, delta.amount0(), delta.amount1())
            : (call.key.currency1, call.key.currency0, delta.amount1(), delta.amount0());

        amountOut = uint256(uint128(outDelta));
        if (amountOut < call.minAmountOut) revert SlippageExceeded();

        uint256 amountIn = uint256(uint128(-inDelta));
        if (inCurrency.isAddressZero()) {
            poolManager.settle{value: amountIn}();
        } else {
            poolManager.sync(inCurrency);
            IERC20Min(Currency.unwrap(inCurrency)).transferFrom(call.trader, address(poolManager), amountIn);
            poolManager.settle();
        }

        poolManager.take(outCurrency, call.trader, amountOut);
    }

    /// @dev Mint-only (liquidityDelta expected positive). Settles whatever the
    /// real pool math says is owed for each currency, pulling ETH from the
    /// generous msg.value already forwarded into this contract and tokens via
    /// transferFrom on the trader (who must have approved this contract). Any
    /// leftover ETH beyond what was actually owed is refunded to the trader.
    function _executeAddLiquidity(LPCall memory call) internal returns (uint256 ethUsed, uint256 tokenUsed) {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            call.key,
            ModifyLiquidityParams({
                tickLower: call.tickLower,
                tickUpper: call.tickUpper,
                liquidityDelta: call.liquidityDelta,
                salt: call.salt
            }),
            ""
        );

        ethUsed = _settleOrTake(call.key.currency0, delta.amount0(), call.trader, true);
        tokenUsed = _settleOrTake(call.key.currency1, delta.amount1(), call.trader, false);

        if (call.ethProvided > ethUsed) {
            (bool ok,) = call.trader.call{value: call.ethProvided - ethUsed}("");
            require(ok, "refund failed");
        }
    }

    /// @dev amount < 0: the mint owes this currency to the pool — settle it,
    /// pulling from the trader (tokens) or from this contract's own balance
    /// (ETH, already forwarded via msg.value). amount > 0: pool owes it back
    /// (rare for a plain mint, but handled rather than assumed away) — take()
    /// it and forward to the trader directly.
    function _settleOrTake(Currency currency, int128 amount, address trader, bool isNative) internal returns (uint256 used) {
        if (amount < 0) {
            used = uint256(uint128(-amount));
            if (isNative) {
                poolManager.settle{value: used}();
            } else {
                poolManager.sync(currency);
                IERC20Min(Currency.unwrap(currency)).transferFrom(trader, address(poolManager), used);
                poolManager.settle();
            }
        } else if (amount > 0) {
            uint256 owed = uint256(uint128(amount));
            poolManager.take(currency, trader, owed);
            used = 0;
        }
    }

    receive() external payable {}
}
