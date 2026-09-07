// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title IRewardSwapper
 * @notice A stateless adapter that turns a claimant's ETH allocation into the selected stock and
 *         delivers it STRAIGHT to the claimant. It never holds stock, and holds ETH/WETH only
 *         inside a single `swap` call frame.
 * @dev    The ETH for the swap is passed as msg.value in the same call that swaps, so a caught
 *         revert returns it to the pool atomically; nothing is ever transferred to the adapter
 *         beforehand. `amountOutMinimum` is enforced INSIDE the swap frame (the pool's transfer to
 *         the claimant is unwound by the revert), which is what makes fallback-on-revert safe:
 *         nothing has moved when the pool catches `InsufficientOutput`.
 */
interface IRewardSwapper {
    /// @dev The swap executed but delivered less than `amountOutMinimum`; the whole frame reverted.
    error InsufficientOutput(uint256 amountOut, uint256 amountOutMinimum);

    /// @notice True iff (pool, fee) is the canonical Uniswap V3 WETH/asset pool for `asset`.
    function validateRoute(address asset, address pool, uint24 fee) external view returns (bool);

    /// @notice Current in-range liquidity of the pool (0 if the call fails).
    function poolLiquidity(address pool) external view returns (uint128);

    /// @notice TWAP-implied output for `ethIn` over `twapWindow` seconds (falls back to a shorter
    ///         window if the ring buffer does not reach back that far). `available == false` when
    ///         no reference could be read at all.
    function referenceOut(address pool, uint32 twapWindow, uint256 ethIn)
        external
        view
        returns (uint256 refOut, bool available);

    /// @notice Wrap msg.value, swap WETH -> asset on `pool`, deliver to `recipient`. Reverts
    ///         `InsufficientOutput` if the delivered amount is below `amountOutMinimum`.
    ///         Callable only by the loss-reward pool.
    function swap(address asset, address pool, uint256 amountOutMinimum, address recipient, uint256 deadline)
        external
        payable
        returns (uint256 assetOut);
}
