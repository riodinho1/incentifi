// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {IncentifiV4LegibleHook} from "../contracts/v4/legible/IncentifiV4LegibleHook.sol";
import {IncentifiV4LegibleFactory} from "../contracts/v4/legible/IncentifiV4LegibleFactory.sol";
import {IncentifiFeeConverter} from "../contracts/v4/legible/IncentifiFeeConverter.sol";

/**
 * Mainnet deploy script for the V4 legible-pool trio. NOT run as part of this PR.
 *
 * HARD REQUIREMENT — governance owner must be a multisig, never an EOA:
 *   the hook owner can propose a post-graduation fee of up to 10% on any token (timelocked,
 *   2 days) and open external LP on graduated pools. One hot key holding that power is not
 *   acceptable. This script refuses to run unless OWNER_MULTISIG is a deployed CONTRACT
 *   (extcodesize > 0) and transfers ownership to it as its last step. Deploying with a
 *   different `--sender` still ends with the multisig as owner.
 *
 * Usage (dry run first, then broadcast; the operator supplies their own key — never share it):
 *   OWNER_MULTISIG=0x... LOSS_REWARD_POOL=0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF \
 *   forge script script/DeployLegiblePool.s.sol --rpc-url robinhood --sender <deployer> [--broadcast]
 *
 * CREATE2: forge routes `new X{salt: s}` through the canonical CREATE2 proxy
 * 0x4e59b44847b379578588920cA78FbF26c0B4956C, so the hook salt is mined against THAT deployer.
 */
contract DeployLegiblePool is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951); // Robinhood Chain

    error OwnerMustBeAContract(address owner);
    error SaltNotFound();

    function run() external {
        address ownerMultisig = vm.envAddress("OWNER_MULTISIG");
        address lossRewardPool = vm.envAddress("LOSS_REWARD_POOL");
        if (ownerMultisig.code.length == 0) revert OwnerMustBeAContract(ownerMultisig);

        address deployer = msg.sender; // --sender; becomes hook.deployer (setFactory/setFeeConverter) and initial owner
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
        bytes memory initCode = abi.encodePacked(type(IncentifiV4LegibleHook).creationCode, abi.encode(POOL_MANAGER, lossRewardPool, deployer));
        (address predicted, bytes32 salt) = _mine(flags, initCode);
        console2.log("hook (predicted)", predicted);

        vm.startBroadcast();
        IncentifiV4LegibleHook hook = new IncentifiV4LegibleHook{salt: salt}(POOL_MANAGER, lossRewardPool, deployer);
        require(address(hook) == predicted, "hook address mismatch");
        IncentifiV4LegibleFactory factory = new IncentifiV4LegibleFactory(POOL_MANAGER, hook);
        IncentifiFeeConverter converter = new IncentifiFeeConverter(POOL_MANAGER, address(hook), lossRewardPool);
        hook.setFactory(address(factory));
        hook.setFeeConverter(address(converter));
        // Last step, unconditionally: governance goes to the multisig.
        hook.transferOwnership(ownerMultisig);
        vm.stopBroadcast();

        require(hook.owner() == ownerMultisig, "owner is not the multisig");
        console2.log("hook", address(hook));
        console2.log("factory", address(factory));
        console2.log("feeConverter", address(converter));
        console2.log("owner (multisig)", hook.owner());
    }

    function _mine(uint160 flags, bytes memory initCode) internal pure returns (address hookAddress, bytes32 salt) {
        bytes32 initHash = keccak256(initCode);
        for (uint256 i = 0; i < 1_000_000; i++) {
            salt = bytes32(i);
            hookAddress = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initHash)))));
            if (uint160(hookAddress) & Hooks.ALL_HOOK_MASK == flags) return (hookAddress, salt);
        }
        revert SaltNotFound();
    }
}
