// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

/**
 * @title HookMinerCheck
 * @notice TEST-ONLY. Exposes HookMiner.computeAddress() (a single pair of keccak256
 *         calls — cheap, not the brute-force find() loop) so an off-chain salt search
 *         can be cross-checked against the REAL, actual HookMiner library this repo
 *         depends on, instead of trusting a from-scratch JS reimplementation of the
 *         same formula on its own say-so. Not part of contracts/v4/'s production set;
 *         lives under test-helpers/ deliberately.
 */
contract HookMinerCheck {
    function computeAddress(address deployer, uint256 salt, bytes memory creationCodeWithArgs)
        external
        pure
        returns (address)
    {
        return HookMiner.computeAddress(deployer, salt, creationCodeWithArgs);
    }
}
