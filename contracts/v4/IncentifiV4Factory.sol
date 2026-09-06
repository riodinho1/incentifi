// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Imported through @uniswap/v4-periphery's own nested v4-core copy — same reasoning
// as IncentifiV4Hook.sol: type identity must match what IncentifiV4Hook itself uses.
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";

import {IncentifiV4Hook} from "./IncentifiV4Hook.sol";

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IIncentifiToken {
    function creator() external view returns (address);
}

/**
 * @title IncentifiV4Factory
 * @notice Permissionless launch entrypoint for the V4 side: registers an already-
 *         deployed token with the shared IncentifiV4Hook, pulls its full supply into
 *         the hook, and initializes its V4 pool at the correct $5,000-market-cap
 *         starting price — one transaction, no manual pool creation, no manual
 *         liquidity seeding, no admin step.
 *
 * @dev STATUS: UNTESTED, same standard as IncentifiV4Hook.sol — compiles (verified),
 *      has never executed against a real PoolManager.
 *
 * @dev HARD DEPENDENCY NOT YET BUILT: `hook` (the constructor param) must already be
 *      deployed at an address whose low 14 bits satisfy the permission flags
 *      IncentifiV4Hook.getHookPermissions() declares (beforeInitialize,
 *      beforeAddLiquidity, beforeSwap, beforeSwapReturnDelta). That requires mining a
 *      CREATE2 salt off-chain (via periphery's HookMiner — confirmed real and gas-
 *      prohibitive to run on-chain, see the planning notes from before this file was
 *      written) and deploying the hook through a CREATE2 factory with that salt, once,
 *      before this factory is deployed at all. No such deployment script exists in
 *      this repo yet. If `hook`'s address doesn't have the right bits,
 *      `poolManager.initialize()` below reverts for every single launch — this isn't
 *      a per-launch concern, but it is an unaddressed gap between "this compiles" and
 *      "this can launch a single real token," and it's the very next thing the fork
 *      test will hit.
 */
contract IncentifiV4Factory {
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e18;

    /**
     * @dev OPEN DESIGN QUESTION — not resolved here: what should the PoolKey's fee
     *      actually be?
     *
     *      Set to 0 for now. Reasoning: during the bonding-curve phase there is no
     *      real liquidity and no external LPs (beforeAddLiquidity blocks everyone but
     *      the hook itself), so there is no one for a native Uniswap LP fee to pay —
     *      our own 2%/1%/1% split is handled entirely inside the hook, independent of
     *      this field. beforeSwap always returns a 0 fee override (no dynamic-fee
     *      flag requested), so this value is static for the pool's lifetime.
     *
     *      The question I'm NOT resolving: once _graduate() actually deposits real
     *      liquidity (currently a stub), does that liquidity ever need a nonzero
     *      native LP fee? Since beforeAddLiquidity restricts liquidity provision to
     *      the hook itself FOREVER (not just pre-graduation), the hook may end up
     *      being the sole liquidity provider even post-graduation — in which case
     *      "graduation" might mean switching from virtual-reserve pricing to a real
     *      concentrated-liquidity curve while STILL handling the protocol fee via
     *      custom accounting, rather than literally reproducing v3's "hand off to a
     *      normal Uniswap pool with a standard fee tier" model. That's a real fork in
     *      the graduation design, not something to decide as a side effect of picking
     *      a PoolKey constant now.
     */
    uint24 public constant POOL_FEE = 0;

    /// @dev Only meaningful once _graduate() deposits real liquidity (still a stub).
    ///      200 chosen for consistency with the v3 side's TICK_LOWER/TICK_UPPER
    ///      (-887200/887200, both exact multiples of 200), not for any V4-specific
    ///      reason — revisit when graduation is actually implemented.
    int24 public constant TICK_SPACING = 200;

    IPoolManager public immutable poolManager;
    IncentifiV4Hook public immutable hook;

    mapping(address => bool) public isLaunched;

    event TokenLaunched(address indexed token, address indexed creator, PoolId poolId);

    error ZeroAddress();
    error AlreadyLaunched();
    error NotTokenCreator();
    error InvalidTotalSupply();
    error TransferFailed();

    constructor(IPoolManager _poolManager, IncentifiV4Hook _hook) {
        if (address(_poolManager) == address(0) || address(_hook) == address(0)) revert ZeroAddress();
        poolManager = _poolManager;
        hook = _hook;
    }

    /**
     * @notice Deterministically reconstructs the PoolKey for `token`'s pool. Public so
     *         a fork test, frontend, or router can compute it independently without
     *         duplicating the fee/tickSpacing/hook constants.
     * @dev currency0 is always native ETH (address(0)) and currency1 is always
     *      `token` — always correctly ordered without a sort branch, since address(0)
     *      is numerically the smallest possible address. Same reasoning already
     *      documented in IncentifiV4Hook.sol for why native ETH was chosen over WETH.
     */
    function getPoolKey(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    /**
     * @notice Registers `token` with the shared hook and initializes its V4 pool.
     * @dev Deliberately does NOT deploy the token itself — mirrors
     *      IncentifiBondingCurveFactory.registerExistingToken()'s pattern of
     *      registering an already-deployed token, for two concrete reasons:
     *      (1) IncentifiLaunchToken.sol's constructor sets `creator = msg.sender`,
     *          so if THIS factory deployed the token via `new IncentifiLaunchToken(...)`,
     *          `creator` would incorrectly become the factory's own address, not the
     *          real human creator's wallet — a real bug, not a style preference.
     *      (2) Keeps IncentifiLaunchToken.sol completely untouched, consistent with
     *          not modifying existing v3 production contracts.
     *      The creator must deploy IncentifiLaunchToken directly (same as the current
     *      v3 frontend flow already does) and approve() this factory for the full
     *      supply before calling this function — the same two-transaction shape v3
     *      already has, not a new burden, but also not yet a single click.
     *
     * @dev OPEN QUESTION, not resolved here: this factory does not check whether
     *      `token` was already registered with the V3 IncentifiBondingCurveFactory
     *      (or vice versa) — a token could in principle end up with both a v3 curve
     *      and a v4 pool simultaneously. Whether that should be blocked, allowed, or
     *      whether the two systems need a shared registry is a cross-system question
     *      I'm flagging rather than guessing at.
     */
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

        // Pull the full supply from the creator into the hook BEFORE registering —
        // IncentifiV4Hook._beforeInitialize checks its own balance against
        // TOTAL_SUPPLY and reverts if this hasn't already happened.
        if (!IERC20(token).transferFrom(creator, address(hook), supply)) revert TransferFailed();

        hook.registerToken(token, creator);

        PoolKey memory key = getPoolKey(token);
        poolManager.initialize(key, hook.launchSqrtPriceX96());

        poolId = key.toId();
        emit TokenLaunched(token, creator, poolId);
    }
}
