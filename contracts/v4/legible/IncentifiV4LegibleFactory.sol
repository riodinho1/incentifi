// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/LPFeeLibrary.sol";

import {IncentifiV4LegibleHook} from "./IncentifiV4LegibleHook.sol";

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IIncentifiToken {
    function creator() external view returns (address);
}

/**
 * @title IncentifiV4LegibleFactory
 * @notice Launches a token as a DYNAMIC-fee, tickSpacing-1 V4 pool bound to IncentifiV4LegibleHook
 *         and seeds the hook's single curve position — after which the pool is a normal,
 *         indexable Uniswap V4 pool. Same launch flow and `TokenLaunched` event as the previous
 *         factory (scripts/evm-indexer.mjs discovers tokens from it unchanged).
 * @dev    No router is deployed alongside this factory (design decision B): trading goes through
 *         UniversalRouter like every other V4 pool on the chain.
 */
contract IncentifiV4LegibleFactory {
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e18;
    /// @notice Dynamic-fee pool: the hook sets the LP fee per swap (2% pre-graduation, governed after).
    uint24 public constant POOL_FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG;
    /// @dev Must equal IncentifiV4LegibleHook.TICK_SPACING (see its comment for why 10, not 1).
    int24 public constant TICK_SPACING = 10;

    IPoolManager public immutable poolManager;
    IncentifiV4LegibleHook public immutable hook;

    mapping(address => bool) public isLaunched;

    event TokenLaunched(address indexed token, address indexed creator, PoolId poolId);

    error ZeroAddress();
    error AlreadyLaunched();
    error NotTokenCreator();
    error InvalidTotalSupply();
    error TransferFailed();

    constructor(IPoolManager _poolManager, IncentifiV4LegibleHook _hook) {
        if (address(_poolManager) == address(0) || address(_hook) == address(0)) revert ZeroAddress();
        poolManager = _poolManager;
        hook = _hook;
    }

    function getPoolKey(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function launchToken(address token) external returns (PoolId poolId) {
        if (token == address(0)) revert ZeroAddress();
        if (isLaunched[token]) revert AlreadyLaunched();

        address creator = msg.sender;
        try IIncentifiToken(token).creator() returns (address tokenCreator) {
            if (tokenCreator != creator) revert NotTokenCreator();
        } catch {
            revert NotTokenCreator();
        }

        uint256 supply = IERC20(token).totalSupply();
        if (supply != TOTAL_SUPPLY) revert InvalidTotalSupply();

        isLaunched[token] = true;

        // Full supply into the hook BEFORE registering: the hook's beforeInitialize checks its own balance.
        if (!IERC20(token).transferFrom(creator, address(hook), supply)) revert TransferFailed();

        hook.registerToken(token, creator);

        PoolKey memory key = getPoolKey(token);
        poolManager.initialize(key, hook.launchSqrtPriceX96());
        hook.seedCurve(token);

        poolId = key.toId();
        emit TokenLaunched(token, creator, poolId);
    }
}
