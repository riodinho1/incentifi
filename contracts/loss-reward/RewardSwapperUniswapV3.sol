// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TickMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/FullMath.sol";

import {IRewardSwapper} from "./interfaces/IRewardSwapper.sol";
import {IUniswapV3PoolMinimal, IUniswapV3FactoryMinimal, IWETH9} from "./interfaces/IUniswapV3Minimal.sol";

/**
 * @title RewardSwapperUniswapV3
 * @notice Stateless adapter for LossRewardPoolV2: wraps the ETH it is sent, swaps WETH -> asset on
 *         the canonical Uniswap V3 pool with `recipient = claimant`, and pays the pool's WETH in
 *         the callback. The stock flows from the Uniswap pool straight to the claimant; this
 *         contract never holds it. It holds ETH/WETH only inside one `swap` frame and asserts a
 *         zero residual before returning.
 * @dev    `amountOutMinimum` is enforced inside the frame: if the delivered amount is short the
 *         whole frame (delivery included) reverts with `InsufficientOutput`, which is what lets
 *         the pool fall back to ETH safely - nothing has moved.
 *         Only the loss-reward pool may call `swap` (the ETH is its own custody).
 */
contract RewardSwapperUniswapV3 is IRewardSwapper {
    address public immutable lossRewardPool;
    IWETH9 public immutable weth;
    IUniswapV3FactoryMinimal public immutable v3Factory;

    /// @dev TickMath.MIN_SQRT_PRICE + 1: "sell WETH for as much asset as the pool will give".
    uint160 internal constant SQRT_PRICE_LIMIT_ZERO_FOR_ONE = 4295128740;
    /// @notice Secondary TWAP window when the primary one reaches past the observation ring.
    uint32 public constant FALLBACK_TWAP_WINDOW = 600;
    uint256 internal constant Q96 = 2 ** 96;

    address private _expectedPool;

    error OnlyLossRewardPool();
    error DeadlineExpired();
    error UnexpectedCallback();
    error ResidualBalance();
    error ZeroAddress();

    constructor(address _lossRewardPool, address _weth, address _v3Factory) {
        if (_lossRewardPool == address(0) || _weth == address(0) || _v3Factory == address(0)) revert ZeroAddress();
        lossRewardPool = _lossRewardPool;
        weth = IWETH9(_weth);
        v3Factory = IUniswapV3FactoryMinimal(_v3Factory);
    }

    // ------------------------------------------------------------------ views
    function validateRoute(address asset, address pool, uint24 fee) external view returns (bool) {
        if (asset == address(0) || pool == address(0) || pool.code.length == 0) return false;
        if (v3Factory.getPool(address(weth), asset, fee) != pool) return false;
        // WETH must be token0 so the swap direction (zeroForOne) and the price maths below hold.
        return IUniswapV3PoolMinimal(pool).token0() == address(weth) && IUniswapV3PoolMinimal(pool).token1() == asset;
    }

    function poolLiquidity(address pool) external view returns (uint128) {
        try IUniswapV3PoolMinimal(pool).liquidity() returns (uint128 l) {
            return l;
        } catch {
            return 0;
        }
    }

    /// @dev The reference is net of the pool's fee tier, so the pool's `maxDeviationBps` measures
    ///      price impact + drift only and means what it says (a 0.30% pool with a 3% tolerance
    ///      tolerates 3% of impact, not 2.7%).
    function referenceOut(address pool, uint32 twapWindow, uint256 ethIn) external view returns (uint256 refOut, bool available) {
        (int24 tick, bool ok) = _meanTick(pool, twapWindow);
        if (!ok && twapWindow > FALLBACK_TWAP_WINDOW) (tick, ok) = _meanTick(pool, FALLBACK_TWAP_WINDOW);
        if (!ok) return (0, false);
        // token1 per token0 = (sqrtP / 2^96)^2 ; WETH is token0, asset is token1.
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        uint256 ethInNetOfFee = ethIn - FullMath.mulDiv(ethIn, IUniswapV3PoolMinimal(pool).fee(), 1_000_000);
        refOut = FullMath.mulDiv(FullMath.mulDiv(ethInNetOfFee, sqrtP, Q96), sqrtP, Q96);
        available = true;
    }

    /// @dev Arithmetic-mean tick over `window`, V3 rounding (toward negative infinity).
    function _meanTick(address pool, uint32 window) internal view returns (int24 tick, bool ok) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        ago[1] = 0;
        try IUniswapV3PoolMinimal(pool).observe(ago) returns (int56[] memory tickCumulatives, uint160[] memory) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            int56 w = int56(uint56(window));
            int24 t = int24(delta / w);
            if (delta < 0 && (delta % w != 0)) t--;
            return (t, true);
        } catch {
            return (0, false);
        }
    }

    // ------------------------------------------------------------------ swap
    function swap(address asset, address pool, uint256 amountOutMinimum, address recipient, uint256 deadline)
        external
        payable
        returns (uint256 assetOut)
    {
        if (msg.sender != lossRewardPool) revert OnlyLossRewardPool();
        if (block.timestamp > deadline) revert DeadlineExpired();
        asset; // the route was validated against the factory when it was set; token1 is the asset

        weth.deposit{value: msg.value}();
        _expectedPool = pool;
        (, int256 amount1) = IUniswapV3PoolMinimal(pool).swap(
            recipient, true, int256(msg.value), SQRT_PRICE_LIMIT_ZERO_FOR_ONE, ""
        );
        _expectedPool = address(0);
        assetOut = uint256(-amount1);
        if (assetOut < amountOutMinimum) revert InsufficientOutput(assetOut, amountOutMinimum);
        // Post-swap checks may only assert invariants (stock has already moved): no residual custody.
        if (weth.balanceOf(address(this)) != 0 || address(this).balance != 0) revert ResidualBalance();
    }

    /// @dev Pays the pool its WETH. Only the pool named in the in-flight swap may call this.
    function uniswapV3SwapCallback(int256 amount0Delta, int256, bytes calldata) external {
        if (msg.sender != _expectedPool || _expectedPool == address(0)) revert UnexpectedCallback();
        if (amount0Delta <= 0) revert UnexpectedCallback();
        if (!weth.transfer(msg.sender, uint256(amount0Delta))) revert ResidualBalance();
    }
}
