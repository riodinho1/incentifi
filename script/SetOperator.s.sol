// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface ILossRewardPoolAdmin {
    function owner() external view returns (address);
    function operator() external view returns (address);
    function setOperator(address newOperator) external;
}

/**
 * Split the operator role off the owner key (docs/AUDIT_2026-09-08.md finding 1): after this, the
 * worker's OPERATOR_PRIVATE_KEY on Railway is a key that can ONLY publish epochs (setEpochMerkleRoot
 * on V1 and V2), never re-point the hook, change routes or transfer ownership. Run from the OWNER.
 *
 * Env: NEW_OPERATOR (address), POOL_V1 (default the live V1), POOL_V2 (default the live V2).
 * Refuses a zero address, the current owner, and a NEW_OPERATOR that already is the operator on
 * both pools (nothing to do). Reads both pools back and prints the exact Railway change.
 *
 *   NEW_OPERATOR=0x... forge script script/SetOperator.s.sol --rpc-url robinhood --sender <owner> [--broadcast ...]
 */
contract SetOperator is Script {
    error ZeroAddress();
    error NewOperatorIsOwner(address owner);
    error ReadBackMismatch(address pool, address expected, address actual);

    function run() external {
        address newOperator = vm.envAddress("NEW_OPERATOR");
        address v1 = vm.envOr("POOL_V1", 0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF);
        address v2 = vm.envOr("POOL_V2", 0x5d94246CD31064Da02E953DB357F0001F0E9A631);
        runWith(newOperator, v1, v2);
    }

    function runWith(address newOperator, address v1, address v2) public {
        if (newOperator == address(0)) revert ZeroAddress();
        address[2] memory pools = [v1, v2];
        for (uint256 i = 0; i < 2; i++) {
            ILossRewardPoolAdmin pool = ILossRewardPoolAdmin(pools[i]);
            address owner = pool.owner();
            if (newOperator == owner) revert NewOperatorIsOwner(owner);
            // Ownership is enforced by the pools: setOperator reverts Unauthorized for any other sender,
            // in simulation too, so a wrong --sender never reaches --broadcast.
            console2.log(i == 0 ? "V1" : "V2", pools[i]);
            console2.log("  owner           ", owner);
            console2.log("  operator BEFORE ", pool.operator());
            console2.log("  operator AFTER  ", newOperator);
        }

        vm.startBroadcast();
        for (uint256 i = 0; i < 2; i++) {
            ILossRewardPoolAdmin pool = ILossRewardPoolAdmin(pools[i]);
            if (pool.operator() != newOperator) pool.setOperator(newOperator);
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < 2; i++) {
            address actual = ILossRewardPoolAdmin(pools[i]).operator();
            if (actual != newOperator) revert ReadBackMismatch(pools[i], newOperator, actual);
        }
        console2.log("operator split done: both pools now publish from", newOperator);
        console2.log("RAILWAY (worker service): set OPERATOR_PRIVATE_KEY to the private key of", newOperator);
        console2.log("  - the OWNER key must no longer be present in any Railway variable");
        console2.log("  - fund the new operator (epoch publish ~80k gas, collect ~180k, convert ~250k per action)");
    }
}
