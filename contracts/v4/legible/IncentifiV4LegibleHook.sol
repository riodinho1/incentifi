// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Core types are imported through v4-periphery's vendored copy of v4-core so they are the
// SAME types BaseHook itself uses (see IncentifiV4HookGenericSell.sol's header for the
// "Overriding function return types differ" lesson this avoids).
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/SqrtPriceMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface ILossRewardPool {
    function depositReward(address token) external payable;
}

interface IIncentifiFeeConverter {
    function notifyTokenFees(address token, uint256 amount) external;
}

/**
 * @title IncentifiV4LegibleHook
 * @notice The Incentifi bonding curve expressed as ONE real Uniswap V4 range position, so that
 *         generic infrastructure (DexScreener → GMGN / Axiom, any V4 router or quoter) sees a
 *         normal pool: `getLiquidity > 0`, `Swap` events with real amounts, a moving price.
 *
 * @dev    Spec: docs/V4_LEGIBLE_POOL_DESIGN.md (draft PR #17). Summary of what this hook does
 *         and — as importantly — does NOT do:
 *
 *         * The curve is the position. The legacy virtual-reserve curve (VE+E)(VT+T)=K is a
 *           constant-product segment, i.e. exactly a Uniswap range position with liquidity
 *           L = sqrt(K) over [q_g, q_0]. The factory seeds that position at launch; buys walk
 *           the price down through it converting tokens to ETH; at the lower bound it is 100%
 *           ETH, which IS graduation. Numbers: CURVE_LIQUIDITY, TICK_LOWER, TICK_UPPER below —
 *           proven equal to the legacy curve in the design doc (§4).
 *
 *         * Fees are ordinary dynamic LP fees (mechanism A). beforeSwap returns a fee override;
 *           PoolManager accounts for it natively; this hook collect()s the accrued fees from
 *           its own position and splits them 1% creator / 1% loss pool. This hook NEVER returns
 *           a BeforeSwapDelta or an afterSwap delta — it is never a swap counterparty, so there
 *           is nothing for a router or quoter to mis-simulate. Its permission mask is 0x28C0:
 *           beforeInitialize | beforeAddLiquidity | beforeSwap | afterSwap, no *_RETURNS_DELTA.
 *
 *         * Sell-side fees accrue in the token. They are forwarded to IncentifiFeeConverter,
 *           which permissionlessly sells them into this same pool (an ordinary, indexed trade)
 *           and routes the ETH 50/50 the same way — so LossRewardPool funding stays whole
 *           (design decision A: convert, do not burn).
 *
 *         * Liquidity is gated: only this hook may add liquidity, pre-graduation always, and
 *           post-graduation unless governance opens it per token (decision C: gated).
 *
 *         * The fee continues after graduation: postGraduationFeePips defaults to the same 2%
 *           (1% creator / 1% LossRewardPool) from launch, so there is no fee cliff and the
 *           loss-reward pool keeps being funded by post-graduation volume. The owner may set
 *           it anywhere in [0, 2%] per token, effective immediately; it can never exceed the
 *           curve fee (decision D, final).
 *
 *         * Graduation fires inside afterSwap the moment the pool price reaches the curve's
 *           lower bound (position fully converted to ETH), in the same transaction; a
 *           permissionless graduate(token) exists only as a fallback and is idempotent.
 *
 *         * Indexer compatibility: Bought/Sold are emitted from afterSwap with the SAME fields
 *           and semantics as the legacy hooks (trader = tx.origin, ethIn gross, ethOut net,
 *           fees ETH-denominated), and curveStates(poolId) keeps the legacy 6-field shape,
 *           computed from the position — the legacy price formula (VE+E)/(VT+T) stays exact.
 */
contract IncentifiV4LegibleHook is BaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    // ------------------------------------------------------------------------
    // Curve constants — identical economics to the legacy hooks
    // ------------------------------------------------------------------------
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e18;
    uint256 public constant VIRTUAL_ETH = 2_156_250_000_000_000_000; // 2.15625 ETH
    uint256 public constant VIRTUAL_TOKEN = 78_125_000_000_000_000_000_000_000; // 78,125,000 tokens
    uint256 public constant INVARIANT_K = 2_324_707_031_250_000_000_000_000_000_000_000_000_000_000_000; // VE * (VT + SUPPLY)
    uint256 public constant GRADUATION_ETH_TARGET = 5_853_863_234_375_000_000; // 5.853863234375 ETH

    /// @notice sqrt(INVARIANT_K): the liquidity of the single curve position (~787,740,105 tokens
    ///         over the range below; the ~212,259,895 remainder is held for graduation pairing).
    uint128 public constant CURVE_LIQUIDITY = 48215215764839215328822;
    /// @notice Curve range in Uniswap price space (token per ETH), tick-aligned inward to spacing 10.
    /// @dev tickSpacing 10, not 1, on purpose: a swap that overshoots the curve (a buy larger than
    ///      what is left, or a sell into an emptied pool) walks the tick bitmap word by word to the
    ///      caller's price limit, and generic routers pass MIN/MAX. A bitmap word spans
    ///      256 * tickSpacing ticks, so spacing 1 meant ~4,150 cold SLOADs (~8.7M gas) for the
    ///      graduating buy - measured on a fork. Spacing 10 caps that at ~415 words (<1M gas) for a
    ///      bound-rounding cost of <= 0.07% (lower 174,070 vs 174,063.2; upper 200,310 vs 200,311.2).
    int24 public constant TICK_LOWER = 174070; // graduation price  (q_g ~ 36,231,884 tokens/ETH)
    int24 public constant TICK_UPPER = 200310; // launch price      (q_0 = 500,000,000 tokens/ETH)
    int24 public constant TICK_SPACING = 10;

    /// @notice 2.00% dynamic LP fee while pre-graduation, in pips (1e6 = 100%). Split 1%/1%.
    uint24 public constant PRE_GRADUATION_FEE_PIPS = 20_000;
    /// @notice Post-graduation fee applied from launch: identical to the curve fee, split 1%/1%.
    uint24 public constant DEFAULT_POST_GRADUATION_FEE_PIPS = 20_000;
    /// @notice Ceiling for the post-graduation fee: it can never exceed the curve fee (2%).
    uint24 public constant MAX_POST_GRADUATION_FEE_PIPS = 20_000;

    bytes32 private constant CURVE_SALT = bytes32(0);
    bytes32 private constant GRADUATED_SALT = bytes32(uint256(1));

    // ------------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------------
    /// @notice Where the loss-pool half of every fee is deposited. Re-pointable by the owner
    ///         (setLossRewardPool) so LossRewardPoolV2 can replace the non-upgradeable V1 pool
    ///         without redeploying the hook. Deposits already made never move.
    address public lossRewardPool;
    address public immutable deployer;
    /// @notice Governance for postGraduationFeePips / lpOpen. Starts as the deployer.
    address public owner;
    /// @notice Set once by the deployer (must be a constructor-independent value for CREATE2 salt mining).
    address public factory;
    /// @notice Set once by the deployer. Receives token-denominated (sell-side) fees.
    address public feeConverter;

    struct TokenState {
        address token;
        address creator;
        bool initialized;
        bool curveSeeded;
        bool graduated;
        /// @dev Tokens deposited into the curve position at seeding (≈ 787,903,505.843e18).
        uint256 curveTokens;
        /// @dev Tokens held back in this contract for graduation pairing (≈ 212,096,494.157e18).
        uint256 reserveTokens;
        /// @dev Frozen at graduation, for curveStates()' legacy view.
        uint256 finalEthReserve;
        uint256 finalTokenReserve;
        uint128 graduatedLiquidity;
    }

    mapping(PoolId => TokenState) internal _states;
    mapping(address => PoolKey) internal _poolKeys;
    mapping(address => PoolId) public poolIdOf;
    mapping(address => address) public pendingCreator;
    /// @notice Pull-payment creator fees, global across all of a creator's tokens.
    mapping(address => uint256) public creatorBalances;
    /// @notice Post-graduation fee per token, pips. Set to DEFAULT_POST_GRADUATION_FEE_PIPS (2%)
    ///         at registration; owner-adjustable within [0, MAX_POST_GRADUATION_FEE_PIPS].
    mapping(address => uint24) public postGraduationFeePips;
    /// @notice Whether external LPs may add liquidity after graduation. Default false.
    mapping(address => bool) public lpOpen;
    /// @dev PER POOL: true while this hook performs its own PoolManager operations on that pool
    ///      (seed, collect, graduation's price-fix swap and mint). beforeSwap/afterSwap for THAT
    ///      pool short-circuit then. Per pool, not global: graduation makes external calls
    ///      (LossRewardPool.depositReward, token.transfer, the converter), and a swap on any
    ///      OTHER pool served by this hook during those calls must still be charged its fee and
    ///      emit its events.
    mapping(PoolId => bool) private _inHookOperation;

    /// @notice Pool price as of the END of the previous block in which the pool traded: captured
    ///         on the first swap of each block, BEFORE that swap moves the price. Anything that
    ///         happens later in the same block cannot move it, which is what lets
    ///         IncentifiFeeConverter derive a sandwich-resistant floor for its conversions.
    struct PriceCheckpoint {
        uint160 sqrtPriceX96;
        uint64 blockNumber;
    }
    mapping(PoolId => PriceCheckpoint) public priceCheckpoints;

    enum Op {
        Seed,
        Collect,
        Graduate
    }

    // ------------------------------------------------------------------------
    // Events (Bought/Sold are field-for-field identical to the legacy hooks)
    // ------------------------------------------------------------------------
    event TokenRegistered(address indexed token, address indexed creator);
    event CurveInitialized(address indexed token, address indexed creator, PoolId poolId);
    event CurveSeeded(PoolId indexed poolId, uint128 liquidity, uint256 curveTokens, uint256 reserveTokens);
    event Bought(PoolId indexed poolId, address indexed trader, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee);
    event Sold(PoolId indexed poolId, address indexed trader, uint256 tokensIn, uint256 ethOut, uint256 creatorFee, uint256 lossPoolFee);
    event FeesConverted(PoolId indexed poolId, uint256 tokensIn, uint256 ethOut);
    event FeesCollected(PoolId indexed poolId, uint256 ethFees, uint256 tokenFees, uint256 creatorShare, uint256 lossPoolShare);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event Graduated(PoolId indexed poolId, address indexed token, uint256 finalEthReserve, uint256 finalTokenReserve);
    event GraduationLiquidityDeployed(PoolId indexed poolId, uint128 liquidity, uint160 sqrtPriceX96, uint256 ethDonated, uint256 tokenDonated);
    event PostGraduationFeeSet(address indexed token, uint24 pips);
    event LpOpenSet(address indexed token, bool open);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event LossRewardPoolUpdated(address indexed previousPool, address indexed newPool);

    error OnlyFactory();
    error OnlyOwner();
    error OnlyDeployer();
    error OnlyFeeConverter();
    error OnlyPoolManagerCallback();
    error ZeroAddress();
    error AlreadyPending();
    error TokenNotRegistered();
    error AlreadyInitialized();
    error InsufficientSupply();
    error MustPairWithNativeEth();
    error MustBeDynamicFeePool();
    error WrongTickSpacing();
    error WrongStartingPrice();
    error PoolNotInitialized();
    error CurveNotSeeded();
    error CurveAlreadySeeded();
    error CannotAddLiquidity();
    error NoBalanceToClaim();
    error EthTransferFailed();
    error TokenTransferFailed();
    error FactoryAlreadySet();
    error PoolMustBeAContract(address pool);
    error FeeConverterAlreadySet();
    error FeeConverterNotSet();
    error FeeTooHigh();
    error AlreadyGraduated();
    error NotReadyToGraduate();
    error UnexpectedDelta();

    constructor(IPoolManager _poolManager, address _lossRewardPool, address _deployer) BaseHook(_poolManager) {
        if (_lossRewardPool == address(0) || _deployer == address(0)) revert ZeroAddress();
        if (_lossRewardPool.code.length == 0) revert PoolMustBeAContract(_lossRewardPool);
        lossRewardPool = _lossRewardPool;
        deployer = _deployer;
        owner = _deployer;
        emit OwnershipTransferred(address(0), _deployer);
    }

    // ------------------------------------------------------------------------
    // One-time wiring + governance
    // ------------------------------------------------------------------------
    function setFactory(address _factory) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (_factory == address(0)) revert ZeroAddress();
        factory = _factory;
    }

    function setFeeConverter(address _feeConverter) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (feeConverter != address(0)) revert FeeConverterAlreadySet();
        if (_feeConverter == address(0)) revert ZeroAddress();
        feeConverter = _feeConverter;
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Re-point the loss-reward deposit target (e.g. to LossRewardPoolV2). Owner-only, no
    ///         timelock: every deposit AFTER this call goes to the new pool; nothing already
    ///         deposited moves. The target must be a deployed contract. The fee converter reads
    ///         this pointer at deposit time, so it follows automatically.
    function setLossRewardPool(address newPool) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (newPool == address(0)) revert ZeroAddress();
        if (newPool.code.length == 0) revert PoolMustBeAContract(newPool);
        emit LossRewardPoolUpdated(lossRewardPool, newPool);
        lossRewardPool = newPool;
    }

    /// @notice Decision D (final): the post-graduation fee is 2% by default and can never exceed
    ///         2%, so there is nothing a delay would guard. The owner may set any value in
    ///         [0, MAX_POST_GRADUATION_FEE_PIPS] per token, effective immediately.
    function setPostGraduationFee(address token, uint24 pips) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (pips > MAX_POST_GRADUATION_FEE_PIPS) revert FeeTooHigh();
        postGraduationFeePips[token] = pips;
        emit PostGraduationFeeSet(token, pips);
    }

    /// @notice Decision C: external liquidity after graduation is closed unless opened here.
    function setLpOpen(address token, bool open) external {
        if (msg.sender != owner) revert OnlyOwner();
        lpOpen[token] = open;
        emit LpOpenSet(token, open);
    }

    // ------------------------------------------------------------------------
    // Hook permissions: 0x28C0 — no *_RETURNS_DELTA flags, by design
    // ------------------------------------------------------------------------
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ------------------------------------------------------------------------
    // Launch flow: registerToken (factory) -> PoolManager.initialize -> seedCurve (factory)
    // ------------------------------------------------------------------------
    function registerToken(address token, address creator) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (token == address(0) || creator == address(0)) revert ZeroAddress();
        if (pendingCreator[token] != address(0)) revert AlreadyPending();
        pendingCreator[token] = creator;
        postGraduationFeePips[token] = DEFAULT_POST_GRADUATION_FEE_PIPS; // fee continues after graduation
        emit TokenRegistered(token, creator);
    }

    function _beforeInitialize(address, PoolKey calldata key, uint160 sqrtPriceX96) internal override returns (bytes4) {
        if (!key.currency0.isAddressZero()) revert MustPairWithNativeEth();
        if (!LPFeeLibrary.isDynamicFee(key.fee)) revert MustBeDynamicFeePool();
        if (key.tickSpacing != TICK_SPACING) revert WrongTickSpacing();

        address token = Currency.unwrap(key.currency1);
        address creator = pendingCreator[token];
        if (creator == address(0)) revert TokenNotRegistered();

        PoolId poolId = key.toId();
        TokenState storage state = _states[poolId];
        if (state.initialized) revert AlreadyInitialized();
        if (IERC20(token).balanceOf(address(this)) < TOTAL_SUPPLY) revert InsufficientSupply();
        // PoolManager.initialize is permissionless; only the one correct $5,000 launch price is accepted.
        if (sqrtPriceX96 != launchSqrtPriceX96()) revert WrongStartingPrice();

        state.token = token;
        state.creator = creator;
        state.initialized = true;
        _poolKeys[token] = key;
        poolIdOf[token] = poolId;
        delete pendingCreator[token];

        emit CurveInitialized(token, creator, poolId);
        return BaseHook.beforeInitialize.selector;
    }

    /// @notice Mints the single curve position. Factory-only, once, right after initialize.
    function seedCurve(address token) external {
        if (msg.sender != factory) revert OnlyFactory();
        TokenState storage state = _states[poolIdOf[token]];
        if (!state.initialized) revert PoolNotInitialized();
        if (state.curveSeeded) revert CurveAlreadySeeded();
        poolManager.unlock(abi.encode(Op.Seed, token));
    }

    /// @notice Collects accrued LP fees from this hook's position for `token` and splits them.
    ///         Permissionless: anyone may trigger it (the creator's card, a keeper, a bot).
    function collect(address token) external {
        TokenState storage state = _states[poolIdOf[token]];
        if (!state.curveSeeded) revert CurveNotSeeded();
        poolManager.unlock(abi.encode(Op.Collect, token));
    }

    /// @notice Permissionless graduation fallback. Normally graduation happens inside afterSwap
    ///         of the trade that reaches the curve's lower bound; this only exists in case that
    ///         path ever failed to run. Idempotent; reverts if the curve is not yet exhausted.
    function graduate(address token) external {
        TokenState storage state = _states[poolIdOf[token]];
        if (!state.curveSeeded) revert CurveNotSeeded();
        if (state.graduated) revert AlreadyGraduated();
        if (!_curveExhausted(poolIdOf[token])) revert NotReadyToGraduate();
        poolManager.unlock(abi.encode(Op.Graduate, token));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManagerCallback();
        (Op op, address token) = abi.decode(data, (Op, address));
        PoolKey memory key = _poolKeys[token];
        PoolId poolId = key.toId();
        TokenState storage state = _states[poolId];
        _inHookOperation[poolId] = true;
        if (op == Op.Seed) {
            _seedCurve(key, poolId, state);
        } else if (op == Op.Collect) {
            _collect(key, poolId, state);
        } else {
            _graduate(key, poolId, state);
        }
        _inHookOperation[poolId] = false;
        return "";
    }

    // ------------------------------------------------------------------------
    // Liquidity gating (security-critical): only this hook adds liquidity, ever, unless
    // governance opens a graduated pool. Positions can only be removed by their owner
    // (this hook), so no remove-side guard is needed.
    // ------------------------------------------------------------------------
    function _beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        if (sender == address(this)) return BaseHook.beforeAddLiquidity.selector;
        TokenState storage state = _states[key.toId()];
        if (state.graduated && lpOpen[state.token]) return BaseHook.beforeAddLiquidity.selector;
        revert CannotAddLiquidity();
    }

    // ------------------------------------------------------------------------
    // Swaps: fee override only. ZERO_DELTA always.
    // ------------------------------------------------------------------------
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        if (_inHookOperation[poolId]) {
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
        }
        TokenState storage state = _states[poolId];
        if (!state.initialized) revert PoolNotInitialized();
        if (!state.curveSeeded) revert CurveNotSeeded();
        _checkpointIfNewBlock(poolId);
        if (sender == feeConverter) {
            // The converter selling already-collected fees back into the pool is protocol plumbing:
            // charging it the LP fee would short the creator/loss-pool split relative to what the
            // holder's Sold event reported, and recursively mint new token fees. Fee-free.
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
        }
        uint24 fee = state.graduated ? postGraduationFeePips[state.token] : PRE_GRADUATION_FEE_PIPS;
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev On the first swap of a block, record the pre-swap price — i.e. the price the pool
    ///      ended the previous trading block at. Later swaps in the same block leave it untouched.
    function _checkpointIfNewBlock(PoolId poolId) internal {
        PriceCheckpoint storage cp = priceCheckpoints[poolId];
        if (cp.blockNumber == uint64(block.number)) return;
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        cp.sqrtPriceX96 = sqrtPriceX96;
        cp.blockNumber = uint64(block.number);
    }

    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId poolId = key.toId();
        if (_inHookOperation[poolId]) return (BaseHook.afterSwap.selector, 0);

        TokenState storage state = _states[poolId];
        uint24 fee = state.graduated ? postGraduationFeePips[state.token] : PRE_GRADUATION_FEE_PIPS;

        if (sender == feeConverter) {
            // The converter selling token-side fees back into the pool is protocol plumbing,
            // not a holder trade: keep it out of the indexer's Sold stream.
            emit FeesConverted(poolId, _abs(delta.amount1()), _abs(delta.amount0()));
        } else if (params.zeroForOne) {
            // Buy: ETH in (gross, fee included — the LP fee is charged on the input), tokens out.
            uint256 ethIn = _abs(delta.amount0());
            uint256 tokensOut = _abs(delta.amount1());
            uint256 feeEth = ethIn * fee / LPFeeLibrary.MAX_LP_FEE;
            uint256 creatorFee = feeEth / 2;
            emit Bought(poolId, tx.origin, ethIn, tokensOut, creatorFee, feeEth - creatorFee);
        } else {
            // Sell: tokens in (gross), ETH out (net). The fee was charged in tokens; report its
            // ETH-equivalent at the trade price so the fields stay ETH-denominated as before.
            uint256 tokensIn = _abs(delta.amount1());
            uint256 ethOut = _abs(delta.amount0());
            uint256 feeEthEquivalent = fee == 0 ? 0 : ethOut * fee / (LPFeeLibrary.MAX_LP_FEE - fee);
            uint256 creatorFee = feeEthEquivalent / 2;
            emit Sold(poolId, tx.origin, tokensIn, ethOut, creatorFee, feeEthEquivalent - creatorFee);
        }

        if (!state.graduated && _curveExhausted(poolId)) {
            _inHookOperation[poolId] = true;
            _graduate(key, poolId, state);
            _inHookOperation[poolId] = false;
        }
        return (BaseHook.afterSwap.selector, 0);
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------
    function _seedCurve(PoolKey memory key, PoolId poolId, TokenState storage state) internal {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: int256(uint256(CURVE_LIQUIDITY)), salt: CURVE_SALT}),
            ""
        );
        // Price sits above the range's upper bound at launch, so the position is 100% token.
        if (delta.amount0() != 0 || delta.amount1() >= 0) revert UnexpectedDelta();
        uint256 tokensPaid = _abs(delta.amount1());
        _settleToken(state.token, tokensPaid);

        state.curveSeeded = true;
        state.curveTokens = tokensPaid;
        state.reserveTokens = TOTAL_SUPPLY - tokensPaid;
        // First checkpoint = launch price, so a conversion before any trade has a reference.
        priceCheckpoints[poolId] = PriceCheckpoint({sqrtPriceX96: launchSqrtPriceX96(), blockNumber: uint64(block.number)});
        emit CurveSeeded(poolId, CURVE_LIQUIDITY, tokensPaid, state.reserveTokens);
    }

    function _collect(PoolKey memory key, PoolId poolId, TokenState storage state) internal {
        (int24 tl, int24 tu, bytes32 salt) = state.graduated
            ? (TickMath.minUsableTick(TICK_SPACING), TickMath.maxUsableTick(TICK_SPACING), GRADUATED_SALT)
            : (TICK_LOWER, TICK_UPPER, CURVE_SALT);
        (, BalanceDelta fees) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: tl, tickUpper: tu, liquidityDelta: 0, salt: salt}), ""
        );
        _takeAndDistribute(poolId, state, _abs(fees.amount0()), _abs(fees.amount1()));
    }

    /// @dev Removes the exhausted curve position, distributes its accrued fees, pins the pool
    ///      price to the graduation price if a buy overshot into empty space, then deploys the
    ///      raised ETH + the held-back token reserve as a full-range position owned by this hook.
    ///      Every delta this creates is settled here, inside the same unlock.
    function _graduate(PoolKey memory key, PoolId poolId, TokenState storage state) internal {
        state.graduated = true;

        (BalanceDelta removed, BalanceDelta fees) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: -int256(uint256(CURVE_LIQUIDITY)), salt: CURVE_SALT}),
            ""
        );
        if (removed.amount0() < 0 || removed.amount1() < 0) revert UnexpectedDelta();
        uint256 total0 = _abs(removed.amount0());
        uint256 total1 = _abs(removed.amount1());
        uint256 fee0 = _abs(fees.amount0());
        uint256 fee1 = _abs(fees.amount1());
        // Principal = everything the position held that was not fee income.
        uint256 principalEth = total0 - fee0;
        uint256 principalTokens = total1 - fee1; // ≈ 0 (position fully converted), plus rounding

        if (total0 > 0) poolManager.take(Currency.wrap(address(0)), address(this), total0);
        if (total1 > 0) poolManager.take(Currency.wrap(state.token), address(this), total1);
        _distribute(poolId, state, fee0, fee1);

        // With the only liquidity gone, the price may sit anywhere at or below the curve's lower
        // bound (a buy that overshot walked through empty space). Pin it to the graduation price
        // with a zero-liquidity swap: no amounts move, only slot0.
        uint160 graduationSqrtPriceX96 = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 < graduationSqrtPriceX96) {
            BalanceDelta fix = poolManager.swap(
                key, SwapParams({zeroForOne: false, amountSpecified: -1, sqrtPriceLimitX96: graduationSqrtPriceX96}), ""
            );
            if (fix.amount0() != 0 || fix.amount1() != 0) revert UnexpectedDelta();
            sqrtPriceX96 = graduationSqrtPriceX96;
        }

        uint256 tokensForLp = state.reserveTokens + principalTokens;
        int24 tl = TickMath.minUsableTick(TICK_SPACING);
        int24 tu = TickMath.maxUsableTick(TICK_SPACING);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), principalEth, tokensForLp
        );
        (BalanceDelta minted,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: tl, tickUpper: tu, liquidityDelta: int256(uint256(liquidity)), salt: GRADUATED_SALT}), ""
        );
        if (minted.amount0() > 0 || minted.amount1() > 0) revert UnexpectedDelta();
        uint256 ethDeployed = _abs(minted.amount0());
        uint256 tokensDeployed = _abs(minted.amount1());
        if (ethDeployed > 0) _settleNative(ethDeployed);
        if (tokensDeployed > 0) _settleToken(state.token, tokensDeployed);

        state.graduatedLiquidity = liquidity;
        state.finalEthReserve = principalEth;
        state.finalTokenReserve = tokensForLp;
        state.reserveTokens = 0;

        // Whatever the mint could not pair (the tick-rounding remainder — ~0.06% of the reserve
        // with tickSpacing 10, mostly tokens) is DONATED into the position just minted rather
        // than stranded in this contract: donate() credits it to in-range LPs, which is exactly
        // this hook's full-range position (external LPs are gated), so it re-emerges through
        // collect() as ordinary fees — ETH split 1%/1%, tokens via the converter. No privileged
        // sweep, no key, nothing left behind.
        uint256 ethDust = principalEth - ethDeployed;
        uint256 tokenDust = tokensForLp - tokensDeployed;
        if (ethDust > 0 || tokenDust > 0) {
            BalanceDelta donated = poolManager.donate(key, ethDust, tokenDust, "");
            if (donated.amount0() > 0 || donated.amount1() > 0) revert UnexpectedDelta();
            if (ethDust > 0) _settleNative(ethDust);
            if (tokenDust > 0) _settleToken(state.token, tokenDust);
        }

        emit Graduated(poolId, state.token, principalEth, tokensForLp);
        emit GraduationLiquidityDeployed(poolId, liquidity, sqrtPriceX96, ethDust, tokenDust);
    }

    function _takeAndDistribute(PoolId poolId, TokenState storage state, uint256 ethFees, uint256 tokenFees) internal {
        if (ethFees > 0) poolManager.take(Currency.wrap(address(0)), address(this), ethFees);
        if (tokenFees > 0) poolManager.take(Currency.wrap(state.token), address(this), tokenFees);
        _distribute(poolId, state, ethFees, tokenFees);
    }

    /// @dev ETH fees: 50% creator (pull-payment), 50% LossRewardPool. Token fees: to the converter.
    function _distribute(PoolId poolId, TokenState storage state, uint256 ethFees, uint256 tokenFees) internal {
        uint256 creatorShare = ethFees / 2;
        uint256 lossShare = ethFees - creatorShare;
        if (creatorShare > 0) creatorBalances[state.creator] += creatorShare;
        if (lossShare > 0) ILossRewardPool(lossRewardPool).depositReward{value: lossShare}(state.token);
        if (tokenFees > 0) {
            if (feeConverter == address(0)) revert FeeConverterNotSet();
            if (!IERC20(state.token).transfer(feeConverter, tokenFees)) revert TokenTransferFailed();
            IIncentifiFeeConverter(feeConverter).notifyTokenFees(state.token, tokenFees);
        }
        emit FeesCollected(poolId, ethFees, tokenFees, creatorShare, lossShare);
    }

    /// @notice Called by the fee converter with the creator half of converted sell-side fees.
    function creditCreatorFees(address token) external payable {
        if (msg.sender != feeConverter) revert OnlyFeeConverter();
        TokenState storage state = _states[poolIdOf[token]];
        if (!state.initialized) revert PoolNotInitialized();
        creatorBalances[state.creator] += msg.value;
    }

    function claimCreatorFees() external {
        uint256 amount = creatorBalances[msg.sender];
        if (amount == 0) revert NoBalanceToClaim();
        creatorBalances[msg.sender] = 0;
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert EthTransferFailed();
        emit CreatorFeesClaimed(msg.sender, amount);
    }

    function _curveExhausted(PoolId poolId) internal view returns (bool) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        return sqrtPriceX96 <= TickMath.getSqrtPriceAtTick(TICK_LOWER);
    }

    function _settleNative(uint256 amount) internal {
        poolManager.settle{value: amount}();
    }

    function _settleToken(address token, uint256 amount) internal {
        poolManager.sync(Currency.wrap(token));
        if (!IERC20(token).transfer(address(poolManager), amount)) revert TokenTransferFailed();
        poolManager.settle();
    }

    function _abs(int128 x) internal pure returns (uint256) {
        return x < 0 ? uint256(uint128(-x)) : uint256(uint128(x));
    }

    // ------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------
    function poolKeyOf(address token) external view returns (PoolKey memory) {
        return _poolKeys[token];
    }

    function tokenStates(PoolId poolId) external view returns (TokenState memory) {
        return _states[poolId];
    }

    /**
     * @notice Legacy-shaped view (same 6 fields as the previous hooks' `curveStates` mapping)
     *         computed from the live position, so src/lib/bondingCurveV4.ts and
     *         scripts/loss-reward-worker.mjs keep working unchanged:
     *         realEthReserve = ETH currently inside the curve position (raised so far);
     *         realTokenReserve = tokens not yet sold = unsold tokens in the position + the
     *         held-back reserve. With these, (VIRTUAL_ETH + realEthReserve) / (VIRTUAL_TOKEN +
     *         realTokenReserve) equals the pool's own price exactly (up to rounding), because
     *         the position IS that constant-product curve.
     */
    function curveStates(PoolId poolId)
        external
        view
        returns (address token, address creator, bool initialized, bool graduated, uint256 realEthReserve, uint256 realTokenReserve)
    {
        TokenState storage state = _states[poolId];
        token = state.token;
        creator = state.creator;
        initialized = state.initialized;
        graduated = state.graduated;
        if (!state.curveSeeded) return (token, creator, initialized, graduated, 0, TOTAL_SUPPLY);
        if (state.graduated) return (token, creator, initialized, graduated, state.finalEthReserve, state.finalTokenReserve);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        (uint256 ethInCurve, uint256 tokensInCurve) = _curveAmounts(sqrtPriceX96);
        realEthReserve = ethInCurve;
        realTokenReserve = tokensInCurve + state.reserveTokens;
    }

    /// @dev Token0 (ETH) and token1 (token) currently held by the curve position at `sqrtPriceX96`
    ///      — the standard piecewise range-position formula (all token0 at/below the range, all
    ///      token1 at/above it, split in between).
    function _curveAmounts(uint160 sqrtPriceX96) internal pure returns (uint256 amount0, uint256 amount1) {
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        if (sqrtPriceX96 <= sqrtLower) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, CURVE_LIQUIDITY, false);
        } else if (sqrtPriceX96 < sqrtUpper) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, sqrtUpper, CURVE_LIQUIDITY, false);
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtPriceX96, CURVE_LIQUIDITY, false);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, CURVE_LIQUIDITY, false);
        }
    }

    /// @notice sqrt((VIRTUAL_TOKEN + TOTAL_SUPPLY) / VIRTUAL_ETH) * 2^96 — the $5,000 launch price.
    function launchSqrtPriceX96() public pure returns (uint160) {
        return _computeSqrtPriceX96(VIRTUAL_ETH, VIRTUAL_TOKEN + TOTAL_SUPPLY);
    }

    /// @dev Verbatim from the legacy hooks: sqrt(amount1)/sqrt(amount0) scaled by 2^96. Computing
    ///      sqrt(amount1 * 2^192 / amount0) instead would overflow 256 bits for amount1 ~ 1e27.
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

    receive() external payable {}
}
