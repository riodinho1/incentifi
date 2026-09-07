// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Minimal view of a Robinhood Stock token (BeaconProxy -> verified `Stock`, ERC-20 + ERC-8056).
///      Balances are RAW; `uiMultiplier()` (1e18-scaled) is display-only. `paused()` is true when
///      the token OR the shared access-controls registry is paused; transfers then revert.
interface IRobinhoodStock {
    function uid() external view returns (bytes32);
    function paused() external view returns (bool);
    function uiMultiplier() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
}

/// @dev The on-chain asset registry: Robinhood's StockFactory (ERC1967 proxy, verified `StockFactory`).
///      `tokenAddress(uid)` is written exactly once per uid by `deploy()` and never cleared, so the
///      canonical check is `tokenAddress(IRobinhoodStock(x).uid()) == x`.
///      Robinhood Chain mainnet: 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046.
interface IRobinhoodStockFactory {
    function tokenAddress(bytes32 uid) external view returns (address);
    function beacon() external view returns (address);
}

/// @dev Shared access-controls registry (also the beacon for every Stock). A blocked address cannot
///      send or receive any stock token. Robinhood Chain mainnet: 0xe10b6f6B275de231345c20D14Ab812db62151b00.
interface IRobinhoodAccessControlsRegistry {
    function isBlocked(address account) external view returns (bool);
    function paused() external view returns (bool);
}
