// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {LossRewardPoolV2} from "../contracts/loss-reward/LossRewardPoolV2.sol";
import {ILossRewardPoolV2} from "../contracts/loss-reward/interfaces/ILossRewardPoolV2.sol";

/**
 * Enable or disable LossRewardPoolV2 asset routes (owner only). Disabling makes the asset
 * unselectable for NEW launches and turns every claim on tokens already paying that asset into
 * the ETH fallback (AssetDisabled) — no value moves. Used for routes whose venue lost its TWAP or
 * liquidity (docs/AUDIT_2026-09-08.md finding 7: QUBT, BE).
 *
 * Env: POOL (V2), ASSETS (comma-separated addresses), ENABLED ("true"/"false").
 * Idempotent: an asset already in the requested state is skipped; an asset with no route reverts.
 *
 *   POOL=0x... ASSETS=0xa,0xb ENABLED=false forge script script/SetAssetEnabled.s.sol --rpc-url robinhood --sender <owner> [--broadcast ...]
 */
contract SetAssetEnabled is Script {
    error NoRoute(address asset);

    function run() external {
        address pool = vm.envAddress("POOL");
        address[] memory assets = vm.envAddress("ASSETS", ",");
        bool enabled = vm.envBool("ENABLED");
        runWith(pool, assets, enabled);
    }

    function runWith(address poolAddress, address[] memory assets, bool enabled) public {
        LossRewardPoolV2 pool = LossRewardPoolV2(payable(poolAddress));
        console2.log("pool", poolAddress);
        console2.log("owner", pool.owner());
        console2.log("target enabled =", enabled);

        uint256 changed;
        uint256 skipped;
        vm.startBroadcast();
        for (uint256 i = 0; i < assets.length; i++) {
            ILossRewardPoolV2.AssetRoute memory r = pool.assetRoute(assets[i]);
            if (r.swapper == address(0)) revert NoRoute(assets[i]);
            if (r.enabled == enabled) {
                console2.log("skip (already)", assets[i]);
                skipped++;
                continue;
            }
            pool.setAssetEnabled(assets[i], enabled);
            console2.log(enabled ? "enabled " : "disabled", assets[i]);
            changed++;
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < assets.length; i++) {
            require(pool.assetRoute(assets[i]).enabled == enabled, "read-back mismatch");
            console2.log("read-back", assets[i], "selectable now:", pool.isSelectableAsset(assets[i]));
        }
        console2.log("changed", changed);
        console2.log("skipped", skipped);
    }
}
