// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IncentifiV4LegibleHook} from "../contracts/v4/legible/IncentifiV4LegibleHook.sol";
import {LossRewardPoolV2} from "../contracts/loss-reward/LossRewardPoolV2.sol";

/**
 * The DELIBERATE SECOND ACTION of the LossRewardPoolV2 rollout: point the legible hook's
 * loss-reward deposits at V2. Run only after V2 is deployed, verified on Blockscout, the worker
 * is in dual-pool mode and the DB migration is applied (docs/LOSS_REWARD_ASSET_DESIGN.md §B6).
 * Nothing already deposited moves; every deposit after this transaction lands in V2.
 *
 * Usage:
 *   HOOK=0x... NEW_POOL=0x... forge script script/RepointHookLossRewardPool.s.sol --rpc-url robinhood --sender <hook owner> [--broadcast --ledger]
 */
contract RepointHookLossRewardPool is Script {
    error NotHookOwner(address owner, address sender);
    error NewPoolHasNoCode(address pool);
    error NewPoolNotConfigured(address pool);

    function run() external {
        IncentifiV4LegibleHook hook = IncentifiV4LegibleHook(payable(vm.envAddress("HOOK")));
        address newPool = vm.envAddress("NEW_POOL");

        if (hook.owner() != msg.sender) revert NotHookOwner(hook.owner(), msg.sender);
        if (newPool.code.length == 0) revert NewPoolHasNoCode(newPool);
        LossRewardPoolV2 v2 = LossRewardPoolV2(payable(newPool));
        if (v2.operator() == address(0) || v2.owner() == address(0)) revert NewPoolNotConfigured(newPool);

        address before = hook.lossRewardPool();
        console2.log("hook", address(hook));
        console2.log("lossRewardPool BEFORE", before);
        console2.log("lossRewardPool AFTER (requested)", newPool);

        vm.startBroadcast();
        hook.setLossRewardPool(newPool);
        vm.stopBroadcast();

        require(hook.lossRewardPool() == newPool, "re-point did not take");
        console2.log("re-pointed; converter now deposits to", newPool);
    }
}
