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

/// @dev Subset of LossRewardPoolV2. The V1 pool has no such function.
interface ILossRewardPoolAssetSetter {
    function setRewardAsset(address token, address rewardAsset) external;
}

/**
 * @title IncentifiV4LegibleFactory
 * @notice Launches a token as a DYNAMIC-fee, tickSpacing-10 V4 pool bound to IncentifiV4LegibleHook
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
    /// @dev A nonzero reward asset was requested but the hook's loss-reward pool is the V1 pool
    ///      (no setRewardAsset). The launch reverts rather than silently producing an ETH-only token.
    error StockRewardsNotAvailable();

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

    /// @notice Launch paying loss rewards in ETH (the only option against the V1 pool).
    function launchToken(address token) external returns (PoolId poolId) {
        return _launch(token, address(0));
    }

    /// @notice Launch with a loss-reward payout asset: address(0) = ETH, otherwise a Robinhood stock
    ///         token accepted by the LossRewardPoolV2 the hook currently points at. The parameter
    ///         exists NOW because hook.setFactory is one-shot: this factory must never need
    ///         redeploying when the V2 pool arrives. Only the token's creator can launch, so only
    ///         the creator ever picks the asset, and the pool refuses a second write.
    function launchToken(address token, address rewardAsset) external returns (PoolId poolId) {
        return _launch(token, rewardAsset);
    }

    function _launch(address token, address rewardAsset) internal returns (PoolId poolId) {
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
        _setRewardAsset(token, rewardAsset);

        PoolKey memory key = getPoolKey(token);
        poolManager.initialize(key, hook.launchSqrtPriceX96());
        hook.seedCurve(token);

        poolId = key.toId();
        emit TokenLaunched(token, creator, poolId);
    }

    /// @dev Against LossRewardPoolV2 the call records the asset (V2 validates it against the
    ///      Robinhood StockFactory and reverts if it is not selectable; that revert is surfaced
    ///      verbatim). Against the V1 pool the selector does not exist, so the call reverts with
    ///      empty data: a no-op for ETH launches, StockRewardsNotAvailable for stock launches.
    function _setRewardAsset(address token, address rewardAsset) internal {
        address pool = hook.lossRewardPool();
        bool ok;
        bytes memory err;
        if (pool.code.length != 0) {
            (ok, err) = pool.call(abi.encodeCall(ILossRewardPoolAssetSetter.setRewardAsset, (token, rewardAsset)));
        }
        if (ok) return;
        if (rewardAsset == address(0)) return;
        if (err.length > 0) {
            assembly ("memory-safe") {
                revert(add(err, 32), mload(err))
            }
        }
        revert StockRewardsNotAvailable();
    }
}
