// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {LossRewardPoolV2} from "../contracts/loss-reward/LossRewardPoolV2.sol";
import {ILossRewardPoolV2} from "../contracts/loss-reward/interfaces/ILossRewardPoolV2.sol";
import {IRewardSwapper} from "../contracts/loss-reward/interfaces/IRewardSwapper.sol";

/**
 * Configures (or refreshes) a LossRewardPoolV2 asset route for EVERY stock in
 * config/loss-reward-stock-routes.json — the file scripts/ops/generate-stock-routes.mjs writes from
 * the live venue map (scripts/ops/enumerate-stock-venues.mjs). Idempotent: a route that already
 * matches on-chain is skipped, so re-running after the venue map changes only touches what moved.
 *
 * Every route is validated by the adapter (canonical Uniswap V3 WETH/asset pool for that fee tier)
 * and by the pool (StockFactory round-trip) inside setAssetRoute; a bad entry reverts the run
 * before anything is broadcast.
 *
 * Env: POOL (LossRewardPoolV2), SWAPPER (RewardSwapperUniswapV3; defaults to the swapper of the
 * first already-configured route), ROUTES_FILE (default config/loss-reward-stock-routes.json).
 *
 *   POOL=0x... forge script script/ConfigureStockRoutes.s.sol --rpc-url robinhood --sender <owner> [--broadcast ...]
 */
contract ConfigureStockRoutes is Script {
    error NoSwapper();
    error RouteRejectedByAdapter(string symbol, address asset, address pool, uint24 fee);

    function run() external {
        runWith(vm.envAddress("POOL"), vm.envOr("SWAPPER", address(0)), vm.envOr("ROUTES_FILE", string("config/loss-reward-stock-routes.json")));
    }

    /// @dev Same as run() with explicit inputs (tests call this directly; env vars are process-global and
    ///      would leak between forge's parallel test threads).
    function runWith(address poolAddress, address swapperOverride, string memory file) public {
        LossRewardPoolV2 pool = LossRewardPoolV2(payable(poolAddress));
        string memory json = vm.readFile(file);

        uint256 count = vm.parseJsonUint(json, ".count");
        uint32 twapWindow = uint32(vm.parseJsonUint(json, ".twapWindow"));
        uint16 maxDeviationBps = uint16(vm.parseJsonUint(json, ".maxDeviationBps"));

        address swapper = swapperOverride;
        if (swapper == address(0)) {
            for (uint256 i = 0; i < count && swapper == address(0); i++) {
                swapper = pool.assetRoute(vm.parseJsonAddress(json, _key(i, "asset"))).swapper;
            }
        }
        if (swapper == address(0)) revert NoSwapper();
        require(swapper.code.length > 0, "swapper has no code");
        // Ownership is enforced by the pool itself: setAssetRoute reverts OnlyOwner for any other
        // sender, in simulation as well, so a wrong --sender can never reach --broadcast.
        console2.log("pool owner", pool.owner());

        console2.log("pool", address(pool));
        console2.log("swapper", swapper);
        console2.log("routes in file", count);
        console2.log("twapWindow / maxDeviationBps", twapWindow, maxDeviationBps);

        uint256 set;
        uint256 skipped;
        vm.startBroadcast();
        for (uint256 i = 0; i < count; i++) {
            address asset = vm.parseJsonAddress(json, _key(i, "asset"));
            address v3Pool = vm.parseJsonAddress(json, _key(i, "pool"));
            uint24 fee = uint24(vm.parseJsonUint(json, _key(i, "fee")));
            string memory symbol = vm.parseJsonString(json, _key(i, "symbol"));

            ILossRewardPoolV2.AssetRoute memory cur = pool.assetRoute(asset);
            if (
                cur.swapper == swapper && cur.pool == v3Pool && cur.fee == fee && cur.twapWindow == twapWindow
                    && cur.maxDeviationBps == maxDeviationBps && cur.enabled
            ) {
                skipped++;
                continue;
            }
            if (!IRewardSwapper(swapper).validateRoute(asset, v3Pool, fee)) revert RouteRejectedByAdapter(symbol, asset, v3Pool, fee);
            pool.setAssetRoute(
                asset,
                ILossRewardPoolV2.AssetRoute({
                    swapper: swapper, pool: v3Pool, fee: fee, twapWindow: twapWindow, maxDeviationBps: maxDeviationBps, enabled: true
                })
            );
            console2.log(string.concat("set   ", symbol), asset, v3Pool, fee);
            set++;
        }
        vm.stopBroadcast();

        // post-condition: every listed asset is selectable now (a paused asset is the only benign exception)
        uint256 notSelectable;
        for (uint256 i = 0; i < count; i++) {
            address asset = vm.parseJsonAddress(json, _key(i, "asset"));
            if (!pool.isSelectableAsset(asset)) {
                notSelectable++;
                console2.log("NOT selectable after configuration (paused or registry changed):", vm.parseJsonString(json, _key(i, "symbol")), asset);
            }
        }
        console2.log("routes set", set);
        console2.log("routes already current (skipped)", skipped);
        console2.log("not selectable", notSelectable);
    }

    function _key(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".routes[", vm.toString(i), "].", field);
    }
}
