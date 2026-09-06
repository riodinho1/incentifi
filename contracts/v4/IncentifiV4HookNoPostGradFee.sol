// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// NOTE: imported via @uniswap/v4-periphery's OWN nested v4-core copy
// (node_modules/@uniswap/v4-periphery/lib/v4-core/), not the top-level
// @uniswap/v4-core package, even though both are byte-for-byte identical
// (confirmed via diff) and the same version (1.0.2). Uniswap/v4-periphery's
// BaseHook.sol resolves ITS @uniswap/v4-core/... imports through its own
// bundled lib/v4-core/ via that package's remappings.txt, so importing the
// top-level copy here produced two structurally-identical but type-DISTINCT
// copies of IPoolManager/Currency/Hooks.Permissions/etc. — real compiler
// errors ("Invalid implicit conversion from contract IPoolManager to contract
// IPoolManager", "Overriding function return types differ") the first time
// this was compiled. Importing through the same nested path BaseHook.sol uses
// makes every type identity match.
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
// LiquidityAmounts is imported from periphery's TOP-LEVEL path (not the nested
// lib/v4-core one everything else here uses) deliberately: it only operates on
// primitive uint160/uint256 values, never on a PoolKey/Currency/IPoolManager
// struct or contract instance, so the type-identity problem documented above
// (why every other import here goes through the nested path) does not apply to
// it — there is no struct/contract type for the two copies to disagree about.
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface ILossRewardPool {
    function depositReward(address token) external payable;
}

/**
 * @title IncentifiV4HookNoPostGradFee
 * @notice The CORE IncentifiV4Hook bonding-curve + graduation logic — mining,
 *         beforeInitialize price gating, beforeAddLiquidity restriction,
 *         beforeSwap full-absorption pricing, and the real V4 liquidity-deposit
 *         graduation — WITHOUT the afterSwap post-graduation fee mechanism.
 *         Four permission flags only (beforeInitialize, beforeAddLiquidity,
 *         beforeSwap, beforeSwapReturnDelta); no afterSwap, no
 *         afterSwapReturnDelta. Once a pool graduates, this hook gets out of
 *         the way entirely (a plain ZERO_DELTA pass-through in beforeSwap) and
 *         the pool trades as a completely standard, fee-free-from-Incentifi
 *         permissionless V4 pool — no 2% protocol fee, no creator fee, no
 *         LossRewardPool deposit on any post-graduation trade. Pre-graduation
 *         economics (2%/1%/1% split, pull-payment creator fees, virtual-reserve
 *         pricing) are unchanged and identical to IncentifiV4Hook.sol.
 *
 * @dev PROVENANCE: there is no separate git commit for "IncentifiV4Hook.sol
 *      before the afterSwap addition" — the whole V4 system landed in one
 *      commit. This file is NOT a from-scratch strip-down of the current
 *      production hook; it is contracts/v4/test-deployment/IncentifiV4HookTestnet.sol's
 *      logic verbatim (that file already IS this exact pre-afterSwap shape —
 *      4 permission flags, no afterSwap, no GraduatedFeeCollected, a plain
 *      pass-through once graduated — proven on a fork AND on real Robinhood
 *      Chain mainnet via scripts/deploy-testnet-mainnet.ts), with ONLY its
 *      economic constants restored to full production scale
 *      (VIRTUAL_ETH/GRADUATION_ETH_TARGET, unscaled — $5,000 launch / $69,000
 *      graduation) and wired to the REAL production LossRewardPool instead of
 *      a throwaway one. Reusing already-proven logic here, rather than hand-
 *      editing IncentifiV4Hook.sol to remove afterSwap, avoids introducing a
 *      fresh, never-tested code combination into a contract meant to touch the
 *      real production LossRewardPool at real production economics.
 *
 * @dev IMPORTANT — this is the FIRST time this exact combination (production
 *      economics + the real production LossRewardPool) has been exercised
 *      anywhere, on a fork or otherwise: the only real-mainnet run of this
 *      logic (this morning) used 1/50-scaled economics and a throwaway pool;
 *      the only run against production economics (v4-hook-deployment.test.ts)
 *      used the SIX-flag hook with afterSwap, and a fork, not this file. The
 *      economics and graduation/liquidity-deposit MECHANICS here are unchanged
 *      from both of those, so the risk is materially lower than deploying the
 *      six-flag hook untested — but "materially lower" is not "zero", and this
 *      specific combination has not itself been fork-tested end-to-end before
 *      real deployment.
 *
 * @dev PAIRING CURRENCY: native ETH (Currency.wrap(address(0))), not WETH. Two reasons:
 *      (1) V4 supports native ETH as a first-class currency, avoiding a wrap/unwrap
 *          round-trip on every trade that the v3 architecture needed.
 *      (2) address(0) is numerically the smallest possible address, so currency0 is
 *          *always* ETH and currency1 is *always* the Incentifi token, for every pool,
 *          unconditionally. This structurally eliminates the "token address < WETH
 *          address" ordering bug class that required a dedicated fix
 *          (_computeSqrtPriceX96 in IncentifiBondingCurve.sol) on the v3 side. There is
 *          no equivalent bug surface here because there is no ordering ambiguity to get
 *          wrong in the first place.
 */
contract IncentifiV4HookNoPostGradFee is BaseHook {
    using PoolIdLibrary for PoolKey;

    // ------------------------------------------------------------------------
    // Economic constants — FULL PRODUCTION SCALE, identical to
    // IncentifiV4Hook.sol. Unlike IncentifiV4HookTestnet.sol (this file's logic
    // source), these are NOT scaled down: real $5,000 starting market cap, real
    // $69,000 graduation target.
    // ------------------------------------------------------------------------
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e18;
    uint256 public constant VIRTUAL_ETH = 2_156_250_000_000_000_000; // 2.15625 ETH
    uint256 public constant VIRTUAL_TOKEN = 78_125_000_000_000_000_000_000_000; // 78,125,000 tokens
    uint256 public constant INVARIANT_K = 2_324_707_031_250_000_000_000_000_000_000_000_000_000_000_000; // 2.32470703125e45
    uint256 public constant GRADUATION_ETH_TARGET = 5_853_863_234_375_000_000; // 5.853863234375 ETH

    uint256 public constant PROTOCOL_FEE_BPS = 200; // 2.00% total (pre-graduation only)
    uint256 public constant CREATOR_FEE_BPS = 100; // 1.00%
    uint256 public constant LOSS_REWARD_FEE_BPS = 100; // 1.00%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Deliberately oversized exact-input magnitude for _graduate()'s
    /// corrective swap, so the swap is always bounded by its sqrtPriceLimitX96
    /// (the actual target price) rather than by this nominal amount — the
    /// standard "swap up to a price limit" pattern. Never actually paid in full;
    /// the real, much smaller amount that PoolManager actually consumes is read
    /// back from the swap's returned delta and settled exactly.
    int256 private constant _GRADUATION_SWAP_SENTINEL = type(int128).max;

    // ------------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------------

    /// @notice The only address permitted to call registerToken() — validation of
    /// creator identity / total-supply / etc. lives in the factory, mirroring how
    /// IncentifiBondingCurveFactory.sol validates before deploying a v3 curve.
    /// @dev NOT immutable, and deliberately not a constructor param — a genuine
    /// circular dependency, not a test convenience: this hook's own deployment
    /// address must be mined via CREATE2 to satisfy the permission-bit requirement
    /// BEFORE IncentifiV4Factory (which takes this hook's address as its own
    /// constructor arg) can be deployed. If `factory` were a constructor param here,
    /// neither contract could be deployed first. Resolved with the standard pattern
    /// for this exact problem: deploy the hook, deploy the factory (now that the
    /// hook exists to reference), then wire them together with one one-time call —
    /// not a per-launch admin step, a one-time system bootstrap step.
    address public factory;
    address public immutable lossRewardPool;
    /// @dev The only address allowed to call setFactory() once. Not an ongoing admin
    /// role: setFactory() is one-time-only (reverts if `factory` is already set), so
    /// this has no power after bootstrap.
    /// @dev Passed explicitly as a constructor arg rather than recorded from
    /// `msg.sender` — this hook is deployed via CREATE2 through the standard
    /// singleton deployer factory (0x4e59b44847b379578588920cA78FbF26c0B4956C,
    /// confirmed deployed on Robinhood Chain), which means `msg.sender` during this
    /// constructor's execution would be that FACTORY PROXY, not the actual deployer's
    /// EOA. Recording `msg.sender` here would make setFactory() permanently
    /// uncallable by anyone with a private key. Caught by reasoning through the
    /// deployment path before attempting it, not from a failed deployment.
    address public immutable deployer;

    // ------------------------------------------------------------------------
    // Per-pool state (shared-hook model)
    // ------------------------------------------------------------------------
    struct TokenCurveState {
        address token;
        address creator;
        bool initialized;
        bool graduated;
        uint256 realEthReserve;
        uint256 realTokenReserve;
    }

    mapping(PoolId => TokenCurveState) public curveStates;

    /// @notice Pull-payment creator balances, GLOBAL across every token this hook
    /// serves (keyed by creator address, not by pool) — a single creator who
    /// launches multiple tokens accrues into one claimable balance, and claims once
    /// via claimCreatorFees() regardless of which of their tokens earned the fee.
    mapping(address => uint256) public creatorBalances;

    /// @notice token => creator, set by the factory via registerToken() before it
    /// calls PoolManager.initialize(). Consumed and cleared by _beforeInitialize().
    mapping(address => address) public pendingCreator;

    /// @notice Leftover ETH/token from _graduate()'s reserve-ratio-vs-marginal-
    /// price mismatch (see _graduate()'s doc comment), keyed by PoolId so it is
    /// never confused with any other pool's dust or claim. Written once, at
    /// graduation, alongside the GraduationLiquidityDeployed event — the event is
    /// history; these mappings are the live, queryable record.
    ///
    /// @dev Deliberately kept SEPARATE from creatorBalances, even though both are
    /// "real ETH sitting in this contract, not yet spent anywhere": creatorBalances
    /// is a claimable entitlement (someone can withdraw it via claimCreatorFees()),
    /// while ethDustBalances/tokenDustBalances are only a bookkeeping record of
    /// value that has NO withdrawal path today (see the token-dust question this
    /// was raised over) — merging them into one ledger would make an unclaimed
    /// creator fee and an unspendable dust remainder indistinguishable from a
    /// single mapping read, which is exactly the "hard to account for" risk this
    /// pair of mappings exists to close off. tokenDustBalances is close to
    /// redundant with IERC20(token).balanceOf(address(this)) post-graduation
    /// (nothing else touches that balance once graduated — see the _beforeSwap
    /// pass-through), but is recorded anyway for parity with ethDustBalances,
    /// which has no such convenient equivalent (native ETH is one pooled balance
    /// shared across every token this hook serves, unlike each token's own
    /// self-isolating ERC20 balance).
    mapping(PoolId => uint256) public ethDustBalances;
    mapping(PoolId => uint256) public tokenDustBalances;

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------
    event TokenRegistered(address indexed token, address indexed creator);
    event CurveInitialized(address indexed token, address indexed creator, PoolId poolId);
    event Bought(PoolId indexed poolId, address indexed trader, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee);
    event Sold(PoolId indexed poolId, address indexed trader, uint256 tokensIn, uint256 ethOut, uint256 creatorFee, uint256 lossPoolFee);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event Graduated(PoolId indexed poolId, address indexed token, uint256 finalEthReserve, uint256 finalTokenReserve);
    /// @param ethDust,tokenDust Real, honestly-reported leftover from the reserve-
    /// ratio-vs-marginal-price mismatch inherent to migrating a virtual-offset
    /// bonding curve into a real concentrated-liquidity position — see the long
    /// comment on _graduate() for why this isn't (and can't cheaply be) zero.
    event GraduationLiquidityDeployed(
        PoolId indexed poolId,
        uint128 bootstrapLiquidity,
        uint128 finalLiquidity,
        uint160 correctedSqrtPriceX96,
        uint256 ethDust,
        uint256 tokenDust
    );

    // ------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------
    error OnlyFactory();
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyPending();
    error TokenNotRegistered();
    error AlreadyInitialized();
    error InsufficientSupply();
    error MustPairWithNativeEth();
    error WrongStartingPrice();
    error PoolNotInitialized();
    error OnlyExactInputSupported();
    error InsufficientReserve();
    error SlippageExceeded();
    error NoBalanceToClaim();
    error CannotAddLiquidity();
    error EthTransferFailed();
    error TokenTransferFailed();
    error OnlyDeployer();
    error FactoryAlreadySet();
    // Graduation-liquidity-specific — see _graduate()'s doc comment. Both would
    // indicate a real accounting bug in the corrective-swap/mint math, not a
    // condition expected to ever actually trigger.
    error GraduationSwapDirectionInvalid();
    error GraduationMintUnexpectedCredit();

    constructor(IPoolManager _poolManager, address _lossRewardPool, address _deployer) BaseHook(_poolManager) {
        if (_lossRewardPool == address(0) || _deployer == address(0)) revert ZeroAddress();
        lossRewardPool = _lossRewardPool;
        deployer = _deployer;
    }

    /// @notice One-time wiring of the factory address, called once immediately after
    /// both this hook and IncentifiV4Factory are deployed. Not callable again once
    /// set, and not callable by anyone other than whoever deployed this specific
    /// hook instance — see the `factory` field's doc comment for why this exists.
    function setFactory(address _factory) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (_factory == address(0)) revert ZeroAddress();
        factory = _factory;
    }

    // ------------------------------------------------------------------------
    // Hook permissions
    // ------------------------------------------------------------------------
    /**
     * @dev Four flags — NOT the six IncentifiV4Hook.sol declares. No afterSwap:
     *      - BEFORE_INITIALIZE: validate + finalize a pending token registration at
     *        the correct starting price before the pool exists.
     *      - BEFORE_ADD_LIQUIDITY: revert unless caller == address(this) — blocks
     *        every external LP pre-graduation, protecting the internal reserve
     *        accounting exactly the way Doppler's own beforeAddLiquidity does
     *        (pattern studied, not copied — Doppler is BUSL-1.1, this is an
     *        independent ~3-line reimplementation of an obvious idea).
     *      - BEFORE_SWAP + BEFORE_SWAP_RETURNS_DELTA: the actual custom-accounting
     *        override, pre-graduation only. All economics (pricing, fee split,
     *        settlement, reserve updates, graduation trigger) happen inside
     *        _beforeSwap. Post-graduation, _beforeSwap returns ZERO_DELTA — a
     *        pure pass-through, no fee, no custom accounting of any kind.
     *      AFTER_SWAP is deliberately NOT set: since every pre-graduation swap is
     *      fully absorbed (100% custom accounting) inside beforeSwap, and every
     *      post-graduation swap is fully passed through untouched, there is
     *      nothing left for afterSwap to do in either regime.
     */
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ------------------------------------------------------------------------
    // Permissionless launch registration (called by IncentifiV4Factory)
    // ------------------------------------------------------------------------
    /**
     * @notice Records `creator` as the pending creator for `token`, ahead of the
     *         factory calling PoolManager.initialize() for that token's pool.
     * @dev Gated to `factory` only — this contract trusts the factory to have
     *      already validated token.creator() / total supply / etc., mirroring
     *      IncentifiBondingCurveFactory.registerExistingToken()'s validation.
     *      The factory must transfer the token's full TOTAL_SUPPLY to this hook
     *      BEFORE calling PoolManager.initialize() — _beforeInitialize checks for
     *      that balance and reverts if it isn't there yet.
     */
    function registerToken(address token, address creator) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (token == address(0) || creator == address(0)) revert ZeroAddress();
        if (pendingCreator[token] != address(0)) revert AlreadyPending();

        pendingCreator[token] = creator;
        emit TokenRegistered(token, creator);
    }

    function _beforeInitialize(address, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override
        returns (bytes4)
    {
        if (!key.currency0.isAddressZero()) revert MustPairWithNativeEth();

        address token = Currency.unwrap(key.currency1);
        address creator = pendingCreator[token];
        if (creator == address(0)) revert TokenNotRegistered();

        PoolId poolId = key.toId();
        TokenCurveState storage state = curveStates[poolId];
        if (state.initialized) revert AlreadyInitialized();

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < TOTAL_SUPPLY) revert InsufficientSupply();

        // Defend against anyone initializing at a wrong price: PoolManager.initialize()
        // is permissionless at the PoolManager level, so without this check a
        // front-runner could initialize this exact PoolKey at an arbitrary price before
        // the factory's own initialize() call lands. Only the one correct $5,000
        // starting price (VIRTUAL_TOKEN / VIRTUAL_ETH ratio) is accepted.
        if (sqrtPriceX96 != launchSqrtPriceX96()) revert WrongStartingPrice();

        state.token = token;
        state.creator = creator;
        state.initialized = true;
        state.realEthReserve = 0;
        state.realTokenReserve = TOTAL_SUPPLY;

        delete pendingCreator[token];

        emit CurveInitialized(token, creator, poolId);
        return BaseHook.beforeInitialize.selector;
    }

    /// @dev Pre-graduation, liquidity may ONLY come from this hook itself (the
    ///      _graduate() mint below) — an external LP adding liquidity while the
    ///      curve is still active would corrupt the full-absorption invariant this
    ///      hook depends on (a real, non-zero-liquidity core pool would start
    ///      partially filling swaps itself, which _beforeSwap's OnlyExactInputSupported
    ///      / full-absorption math does not account for). Once graduated, this
    ///      pool is a genuine, permanently-real AMM pool with no more curve
    ///      invariant to protect — so, unlike the permanently-hook-only v3 LP
    ///      position (minted once, then burned/locked forever), this DOES open up
    ///      to any external LP after graduation, same as a completely standard,
    ///      permissionless V4 pool. Flagging this as a deliberate departure from
    ///      v3's parity, not an oversight.
    function _beforeAddLiquidity(address caller, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        if (caller != address(this) && !curveStates[key.toId()].graduated) revert CannotAddLiquidity();
        return BaseHook.beforeAddLiquidity.selector;
    }

    // ------------------------------------------------------------------------
    // Core custom-accounting swap logic
    // ------------------------------------------------------------------------
    /**
     * @dev Delta-application semantics below are transcribed from the ACTUAL
     *      Hooks.sol I read (v4-core 1.0.2), not assumed:
     *
     *        amountToSwap = params.amountSpecified;
     *        amountToSwap += hookReturn.getSpecifiedDelta();
     *        revert if (exactInput && amountToSwap > 0)   // exactInput = original amountSpecified < 0
     *
     *      We only support exact-input swaps (amountSpecified < 0) — this hook has
     *      no real liquidity backing it, so any amount left for the "core" pool to
     *      process after our delta would hit a liquidity-less pool and revert
     *      anyway; full absorption is the only valid mode, and OnlyExactInputSupported
     *      documents that as a deliberate constraint, not an oversight.
     *
     *      Setting hookDeltaSpecified = -params.amountSpecified makes amountToSwap
     *      land at exactly 0 — the core pool does nothing, all economics are ours.
     *
     *      Router's own final delta (from Hooks.afterSwap: swapDelta = coreDelta -
     *      hookDelta, and coreDelta is (0,0) here since amountToSwap is 0) works out
     *      to -hookDelta. Confirmed sign convention from Hooks.sol/CurrencySettler.sol
     *      (test-path reference, read but not imported): positive hook delta = hook
     *      take()s that amount FROM the PoolManager; negative = hook settle()s
     *      (pays) that amount INTO the PoolManager.
     *
     *      BUY (zeroForOne, ETH -> TOKEN): specified = currency0 (ETH). We take() the
     *      buyer's incoming ETH (hookDeltaSpecified > 0), and settle() the token
     *      output (hookDeltaUnspecified < 0) so the router can take() it out for the
     *      buyer. SELL is the mirror image with the specified/unspecified currencies
     *      swapped and native-ETH settle() replacing ERC20 settle().
     *
     * @dev KNOWN GAP vs. IncentifiBondingCurve.buy(): the v3 contract clamps grossEth
     *      to the graduation boundary and refunds any excess directly from within
     *      buy() itself, because it holds msg.value directly. That refund mechanism
     *      does not translate here: a hook that only partially absorbs
     *      amountSpecified leaves the remainder for the core (liquidity-less) pool to
     *      process, which would revert. This version does NOT clamp/refund — an
     *      overshooting buy is accepted in full, and any excess beyond the exact
     *      graduation target is carried into the reserve that gets migrated at
     *      graduation rather than refunded to the buyer. Clamping with a refund
     *      happens one layer up, in IncentifiV4Router (compute the clamped amount
     *      via a view call before ever submitting the swap, refund any excess
     *      before calling PoolManager.unlock()).
     */
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        TokenCurveState storage state = curveStates[poolId];
        if (!state.initialized) revert PoolNotInitialized();

        // POST-GRADUATION PASS-THROUGH: once _graduate() has deposited real
        // concentrated liquidity into the core pool, this hook gets out of the
        // way entirely and lets the core AMM execute the trade against that real
        // liquidity — returning ZERO_DELTA here means "the hook claims none of the
        // swap amount", so the core pool processes 100% of it normally, exactly as
        // if this were an ordinary hookless (or no-op-hook) pool. No fee of any
        // kind (protocol, creator, or LossRewardPool) is taken on any
        // post-graduation trade — this is the deliberate difference from
        // IncentifiV4Hook.sol's afterSwap-based post-graduation fee mechanism.
        //
        // beforeSwap is a MANDATORY hook once BEFORE_SWAP_FLAG is set — PoolManager
        // calls it on every single swap for this pool's lifetime, with no way to
        // "turn it off". An earlier iteration of this logic unconditionally
        // reverted here once graduated, which would have permanently bricked the
        // pool for trading the moment graduation completed — caught while
        // implementing the real liquidity deposit, not by inspection beforehand.
        if (state.graduated) {
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        if (params.amountSpecified >= 0) revert OnlyExactInputSupported();

        uint256 amountIn = uint256(-params.amountSpecified);
        if (amountIn == 0) revert ZeroAmount();

        int128 hookDeltaSpecified = int128(-params.amountSpecified);
        int128 hookDeltaUnspecified;

        if (params.zeroForOne) {
            // BUY: ETH in (specified, currency0), TOKEN out (unspecified, currency1)
            uint256 tokensOut = _executeBuy(state, poolId, key, amountIn);
            hookDeltaUnspecified = -_toInt128(tokensOut);
        } else {
            // SELL: TOKEN in (specified, currency1), ETH out (unspecified, currency0)
            uint256 netEthOut = _executeSell(state, poolId, amountIn);
            hookDeltaUnspecified = -_toInt128(netEthOut);
        }

        BeforeSwapDelta delta = toBeforeSwapDelta(hookDeltaSpecified, hookDeltaUnspecified);
        return (BaseHook.beforeSwap.selector, delta, 0);
    }

    /// @dev Mirrors IncentifiBondingCurve.buy() exactly (minus the clamp/refund — see
    ///      the KNOWN GAP note above), executed as V4 settlement instead of a direct
    ///      payable call. Fee-on-transfer safety for the token leg comes from V4's
    ///      own sync()/settle() semantics (balance measured before/after, not a
    ///      trusted nominal amount) — the same principle as the v3 fix, provided by
    ///      the platform this time instead of hand-rolled.
    function _executeBuy(TokenCurveState storage state, PoolId poolId, PoolKey calldata key, uint256 grossEth) internal returns (uint256 tokensOut) {
        uint256 creatorFee = grossEth / 100;
        uint256 lossPoolFee = grossEth / 100;
        uint256 netEth = grossEth - creatorFee - lossPoolFee;

        uint256 newEth = VIRTUAL_ETH + state.realEthReserve + netEth;
        tokensOut = (VIRTUAL_TOKEN + state.realTokenReserve) - (INVARIANT_K / newEth);
        if (tokensOut > state.realTokenReserve) revert InsufficientReserve();

        // Take the buyer's ETH from the PoolManager (settled in by the router).
        _takeNative(grossEth);

        state.realEthReserve += netEth;
        state.realTokenReserve -= tokensOut;

        if (creatorFee > 0) creatorBalances[state.creator] += creatorFee;
        if (lossPoolFee > 0) ILossRewardPool(lossRewardPool).depositReward{value: lossPoolFee}(state.token);

        // Settle the token output to the PoolManager so the router can take() it for
        // the buyer. Measures our own balance delta around the transfer — real
        // fee-on-transfer safety on the outbound leg too, not just trusted on the
        // strength of V4's own sync/settle for the inbound leg.
        _settleToken(state.token, tokensOut);

        emit Bought(poolId, tx.origin, grossEth, tokensOut, creatorFee, lossPoolFee);

        if (state.realEthReserve >= GRADUATION_ETH_TARGET && !state.graduated) {
            _graduate(state, poolId, key);
        }
    }

    /// @dev Mirrors IncentifiBondingCurve.sell() exactly.
    function _executeSell(TokenCurveState storage state, PoolId poolId, uint256 tokensIn) internal returns (uint256 netEthOut) {
        // Take the seller's tokens from the PoolManager (settled in by the router),
        // measuring the actual amount received rather than trusting `tokensIn` —
        // fee-on-transfer safety on the inbound leg, matching the v3 fix's pattern.
        uint256 actualTokensIn = _takeToken(state.token, tokensIn);
        if (actualTokensIn == 0) revert ZeroAmount();

        uint256 currentEth = VIRTUAL_ETH + state.realEthReserve;
        uint256 currentToken = VIRTUAL_TOKEN + state.realTokenReserve;
        uint256 newToken = currentToken + actualTokensIn;
        uint256 newEth = INVARIANT_K / newToken;
        uint256 grossEthOut = currentEth - newEth;
        if (grossEthOut > state.realEthReserve) revert InsufficientReserve();

        uint256 creatorFee = grossEthOut / 100;
        uint256 lossPoolFee = grossEthOut / 100;
        netEthOut = grossEthOut - creatorFee - lossPoolFee;

        state.realEthReserve -= grossEthOut;
        state.realTokenReserve += actualTokensIn;

        if (creatorFee > 0) creatorBalances[state.creator] += creatorFee;
        if (lossPoolFee > 0) ILossRewardPool(lossRewardPool).depositReward{value: lossPoolFee}(state.token);

        _settleNative(netEthOut);

        emit Sold(poolId, tx.origin, actualTokensIn, netEthOut, creatorFee, lossPoolFee);
    }

    // ------------------------------------------------------------------------
    // Pull-payment creator claims — same accounting shape as
    // IncentifiBondingCurve.claimCreatorFees(), just global across pools instead
    // of scoped to one curve's fixed creator.
    // ------------------------------------------------------------------------
    function claimCreatorFees() external {
        uint256 amount = creatorBalances[msg.sender];
        if (amount == 0) revert NoBalanceToClaim();

        creatorBalances[msg.sender] = 0;
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert EthTransferFailed();

        emit CreatorFeesClaimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------------
    // Graduation — real V4 liquidity deposit. Identical to IncentifiV4Hook.sol's
    // _graduate() — this part of the logic is unaffected by the afterSwap
    // question, since it runs exactly once, at the graduation boundary, before
    // any post-graduation trade (fee-bearing or not) ever occurs.
    //
    // THE PROBLEM THIS SOLVES (genuinely V4-specific — there is no v3 equivalent
    // to copy): v3's _graduate() creates its Uniswap V3 pool for the FIRST TIME
    // at graduation, computing that pool's initial sqrtPriceX96 directly FROM the
    // exact real reserve amounts being deposited — so there is no pre-existing
    // on-chain price to reconcile, by construction. This V4 hook's pool, by
    // contrast, was already initialized and tradeable at PoolManager.initialize()
    // time. So by the time graduation is reached, PoolManager's slot0 for this
    // pool is STILL sitting at the original $5,000-market-cap launch price,
    // while the curve's real economics have moved the fair price far below that.
    // Mint a real liquidity position at that stale price with no correction, and
    // the very first post-graduation swapper gets a massive, structural
    // arbitrage against the newly seeded liquidity — a real solvency bug.
    //
    // THE FIX: mint a small bootstrap position at the stale price (just enough
    // real liquidity to trade against), execute one real, hook-bypassed
    // corrective swap that walks the core pool's tracked price down to the
    // curve's true final marginal price (bounded exactly by sqrtPriceLimitX96,
    // so it cannot overshoot), then mint the bulk of the remaining reserves as a
    // second position at the now-correct price. Both positions are full-range
    // and use the same salt, so they merge into a single combined position.
    // ------------------------------------------------------------------------
    function _graduate(TokenCurveState storage state, PoolId poolId, PoolKey calldata key) internal {
        state.graduated = true;

        uint256 ethAvailable = state.realEthReserve;
        uint256 tokensAvailable = state.realTokenReserve;

        emit Graduated(poolId, state.token, ethAvailable, tokensAvailable);

        if (ethAvailable == 0 || tokensAvailable == 0) {
            // Nothing real to seed as liquidity. Not expected to trigger given
            // GRADUATION_ETH_TARGET > 0 and the curve's invariant guaranteeing
            // some unsold supply remains at that target — but the state flip
            // above still stands regardless; explicitly not treated as an error.
            return;
        }

        int24 tickSpacing = key.tickSpacing;
        int24 tickLower = TickMath.minUsableTick(tickSpacing);
        int24 tickUpper = TickMath.maxUsableTick(tickSpacing);
        uint160 sqrtPriceLowerX96 = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtPriceUpperX96 = TickMath.getSqrtPriceAtTick(tickUpper);
        bytes32 salt = bytes32(0);

        // --- Step 1: small bootstrap position at the pool's current (stale)
        // tracked price, purely so the corrective swap below has real liquidity
        // to trade against. Sized as 0.1% of the real reserves.
        uint256 bootstrapEth = ethAvailable / 1000;
        uint256 bootstrapTokens = tokensAvailable / 1000;
        uint160 stalePriceX96 = launchSqrtPriceX96(); // == this pool's actual current slot0, by construction

        uint128 bootstrapLiquidity = LiquidityAmounts.getLiquidityForAmounts(
            stalePriceX96, sqrtPriceLowerX96, sqrtPriceUpperX96, bootstrapEth, bootstrapTokens
        );
        (BalanceDelta bootstrapDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(bootstrapLiquidity)),
                salt: salt
            }),
            ""
        );
        // Capture what the bootstrap mint ACTUALLY cost, not the nominal
        // allocation — LiquidityAmounts.getLiquidityForAmounts conservatively
        // rounds down, so any rounding "savings" flow into the final mint's
        // available balance instead of becoming untracked residue.
        (uint256 bootstrapEthPaid, uint256 bootstrapTokensPaid) = _settleMintDelta(state.token, bootstrapDelta);

        // --- Step 2: corrective swap. zeroForOne = true (pay ETH, receive
        // token) moves price DOWN, which is the correct direction here — this
        // curve's price (tokens per ETH) only ever falls as more ETH comes in.
        // Bounded by sqrtPriceLimitX96 = the curve's actual final marginal price.
        uint160 targetSqrtPriceX96 = _computeSqrtPriceX96(VIRTUAL_ETH + ethAvailable, VIRTUAL_TOKEN + tokensAvailable);

        BalanceDelta correctiveDelta = poolManager.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -_GRADUATION_SWAP_SENTINEL, sqrtPriceLimitX96: targetSqrtPriceX96}),
            ""
        );
        int128 correctiveEthDelta = correctiveDelta.amount0();
        int128 correctiveTokenDelta = correctiveDelta.amount1();

        // Sanity: this self-swap must cost us ETH and pay us tokens, matching
        // the zeroForOne=true direction requested — never the reverse.
        if (correctiveEthDelta > 0 || correctiveTokenDelta < 0) revert GraduationSwapDirectionInvalid();

        uint256 ethSpentOnCorrection = uint256(uint128(-correctiveEthDelta));
        uint256 tokensReceivedFromCorrection = uint256(uint128(correctiveTokenDelta));
        _settleNative(ethSpentOnCorrection);
        uint256 actualTokensReceived = _takeToken(state.token, tokensReceivedFromCorrection);

        // --- Step 3: final position, using everything not already committed to
        // the bootstrap mint or spent/received in the corrective swap, minted at
        // the now-corrected price.
        uint256 ethRemaining = ethAvailable - bootstrapEthPaid - ethSpentOnCorrection;
        uint256 tokensRemaining = tokensAvailable - bootstrapTokensPaid + actualTokensReceived;

        uint128 finalLiquidity = LiquidityAmounts.getLiquidityForAmounts(
            targetSqrtPriceX96, sqrtPriceLowerX96, sqrtPriceUpperX96, ethRemaining, tokensRemaining
        );
        (BalanceDelta finalDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(finalLiquidity)),
                salt: salt
            }),
            ""
        );
        (uint256 ethDeployed, uint256 tokensDeployed) = _settleMintDelta(state.token, finalDelta);

        // Whatever's left in the hook's own balance after both mints is honest,
        // reported dust — not deposited anywhere.
        uint256 ethDust = ethRemaining - ethDeployed;
        uint256 tokenDust = tokensRemaining - tokensDeployed;
        ethDustBalances[poolId] = ethDust;
        tokenDustBalances[poolId] = tokenDust;

        emit GraduationLiquidityDeployed(poolId, bootstrapLiquidity, finalLiquidity, targetSqrtPriceX96, ethDust, tokenDust);
    }

    /// @dev Settles a modifyLiquidity() mint's negative (owed-to-pool) deltas. A
    /// plain mint should never return a positive delta (that would mean the pool
    /// owes US on a pure add) — a positive value here reverts loudly rather than
    /// being silently take()n. Returns the exact (ETH, token) amounts actually paid in.
    function _settleMintDelta(address token, BalanceDelta delta) internal returns (uint256 ethPaid, uint256 tokensPaid) {
        int128 ethDelta = delta.amount0();
        int128 tokenDelta = delta.amount1();
        if (ethDelta > 0 || tokenDelta > 0) revert GraduationMintUnexpectedCredit();
        ethPaid = uint256(uint128(-ethDelta));
        tokensPaid = uint256(uint128(-tokenDelta));
        if (ethPaid > 0) _settleNative(ethPaid);
        if (tokensPaid > 0) _settleToken(token, tokensPaid);
    }

    // ------------------------------------------------------------------------
    // Settlement helpers — reimplemented directly against IPoolManager (the
    // reference pattern in v4-core's test/utils/CurrencySettler.sol is
    // test-only and not meant to be imported into production contracts; this is
    // an independent implementation of the same publicly-documented
    // sync/transfer/settle and take mechanics, not a copy).
    // ------------------------------------------------------------------------
    function _takeNative(uint256 amount) internal {
        poolManager.take(Currency.wrap(address(0)), address(this), amount);
    }

    function _settleNative(uint256 amount) internal {
        poolManager.settle{value: amount}();
    }

    /// @return actualReceived The measured balance delta on the PoolManager, not
    /// the nominal `amount` — fee-on-transfer safe by construction.
    function _takeToken(address token, uint256 amount) internal returns (uint256 actualReceived) {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        poolManager.take(Currency.wrap(token), address(this), amount);
        actualReceived = IERC20(token).balanceOf(address(this)) - balanceBefore;
    }

    function _settleToken(address token, uint256 amount) internal {
        poolManager.sync(Currency.wrap(token));
        bool success = IERC20(token).transfer(address(poolManager), amount);
        if (!success) revert TokenTransferFailed();
        poolManager.settle();
    }

    // ------------------------------------------------------------------------
    // Math helpers
    // ------------------------------------------------------------------------

    /// @dev sqrtPriceX96 for a pool where amount0 = amount of currency0 (native ETH)
    ///      and amount1 = amount of currency1 (the Incentifi token) at the target
    ///      price. Computed as sqrt(amount1) * 2^96 / sqrt(amount0) rather than the
    ///      more direct sqrt(amount1 * 2^192 / amount0), to avoid the 512-bit
    ///      intermediate multiplication that direct form would need.
    /// @notice The single source of truth for the correct $5,000-market-cap starting
    ///         price, exposed publicly so IncentifiV4Factory calls this directly
    ///         instead of recomputing the same math independently.
    function launchSqrtPriceX96() public pure returns (uint160) {
        return _computeSqrtPriceX96(VIRTUAL_ETH, VIRTUAL_TOKEN + TOTAL_SUPPLY);
    }

    function _computeSqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 sqrtAmount0 = _sqrt(amount0);
        uint256 sqrtAmount1 = _sqrt(amount1);
        return uint160((sqrtAmount1 << 96) / sqrtAmount0);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function _toInt128(uint256 x) internal pure returns (int128) {
        require(x <= uint256(uint128(type(int128).max)), "overflow");
        return int128(uint128(x));
    }

    receive() external payable {}
}
