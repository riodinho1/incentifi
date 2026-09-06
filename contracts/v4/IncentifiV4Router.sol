// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";

import {IncentifiV4Hook} from "./IncentifiV4Hook.sol";
import {IncentifiV4Factory} from "./IncentifiV4Factory.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

/**
 * @title IncentifiV4Router
 * @notice Purpose-built buy()/sell() entrypoint, mirroring IncentifiSwapRouter.sol's
 *         (v3) ABI shape. Resolves the router-vs-Universal-Router question this
 *         session left open, WITHOUT closing off Universal Router / any generic V4
 *         router as an alternative path — see reasoning below.
 *
 * @dev STATUS: UNTESTED, same standard as the other two v4 contracts. Compiles;
 *      has never called PoolManager.unlock()/swap() for real.
 *
 * @dev ROUTER DECISION (resolved, with reasoning, not silently picked):
 *      Built this rather than relying solely on the real Universal Router, for two
 *      concrete reasons surfaced while writing IncentifiV4Hook.sol:
 *      (1) The graduation-boundary clamp+refund IncentifiBondingCurve.buy() does
 *          (capping an oversized buy exactly at GRADUATION_ETH_TARGET and refunding
 *          the excess) cannot live inside the hook's beforeSwap — V4's full-
 *          absorption custom accounting means partially processing amountSpecified
 *          would leave a remainder for the core pool to handle against liquidity
 *          that doesn't exist pre-graduation, which reverts. It has to happen BEFORE
 *          the swap is ever submitted to PoolManager, which requires a router that
 *          knows Incentifi-specific business logic. Universal Router has no hook for
 *          this — it would need the exact clamped amount already computed by the
 *          time it receives the swap command.
 *      (2) "No fallback to the old bonding curve" (an explicit hard requirement) is
 *          trivially, structurally verifiable by reading this file — there is no
 *          reference to IncentifiBondingCurve anywhere in it. That guarantee is
 *          harder to state with confidence about Universal Router, a large generic
 *          contract capable of executing arbitrary command sequences — not because
 *          it's untrustworthy, but because "no fallback" would then be a property of
 *          which calldata we happen to send it, not a property of the contract we
 *          wrote and can fully audit.
 *
 *      This does NOT make the pool exclusively tradeable through this router. The
 *      pool itself is a real, permissionless V4 pool — the fork test's "generic bot"
 *      check should confirm a raw PoolManager.unlock()/swap() call (or a real
 *      Universal Router V4_SWAP command) works with zero knowledge of this contract,
 *      the same way the v3 fork test proved a raw SwapRouter02 call worked without
 *      going through IncentifiSwapRouter.sol. This router exists for OUR frontend's
 *      UX and the graduation-clamp logic, not as a gatekeeper.
 */
contract IncentifiV4Router is IUnlockCallback {
    IPoolManager public immutable poolManager;
    IncentifiV4Hook public immutable hook;
    IncentifiV4Factory public immutable factory;

    error Expired();
    error ZeroAmount();
    error ZeroAddress();
    error PoolGraduated();
    error SlippageExceeded();
    error OnlyPoolManager();
    error EthTransferFailed();
    error TokenTransferFailed();
    error UnknownAction();

    enum Action {
        Buy,
        Sell
    }

    struct CallbackData {
        Action action;
        address token;
        address trader;
        uint256 amountIn; // clamped ETH (buy) or actual tokens received (sell)
        uint256 minOut;
    }

    constructor(IPoolManager _poolManager, IncentifiV4Hook _hook, IncentifiV4Factory _factory) {
        if (address(_poolManager) == address(0) || address(_hook) == address(0) || address(_factory) == address(0)) {
            revert ZeroAddress();
        }
        poolManager = _poolManager;
        hook = _hook;
        factory = _factory;
    }

    /**
     * @notice Buy `token` with native ETH.
     * @dev Clamps `msg.value` to the graduation boundary and refunds any excess
     *      BEFORE ever calling PoolManager.unlock() — see the ROUTER DECISION note
     *      above for why this can't happen inside the hook. Reproduces
     *      IncentifiBondingCurve.buy()'s exact clamp formula.
     */
    function buyToken(address token, uint256 minTokensOut, uint256 deadline) external payable returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroAmount();

        PoolId poolId = factory.getPoolKey(token).toId();
        (, , , bool graduated, uint256 realEthReserve,) = hook.curveStates(poolId);
        if (graduated) revert PoolGraduated();

        uint256 grossEth = msg.value;
        uint256 maxNetEth = hook.GRADUATION_ETH_TARGET() - realEthReserve;
        uint256 maxGrossEth = 100 * (maxNetEth / 98) + (maxNetEth % 98);
        if (grossEth > maxGrossEth) {
            uint256 refund = grossEth - maxGrossEth;
            grossEth = maxGrossEth;
            (bool success,) = msg.sender.call{value: refund}("");
            if (!success) revert EthTransferFailed();
        }

        bytes memory result = poolManager.unlock(
            abi.encode(CallbackData({action: Action.Buy, token: token, trader: msg.sender, amountIn: grossEth, minOut: minTokensOut}))
        );
        tokensOut = abi.decode(result, (uint256));
    }

    /**
     * @notice Sell `token` for native ETH. Requires a prior approve() of this router
     *         for at least `tokenAmountIn`, same as IncentifiSwapRouter.sol (v3).
     * @dev Pulls tokens from the seller and measures the actual balance delta before
     *      forwarding into the swap — fee-on-transfer safety, same convention already
     *      established and fixed on the v3 router.
     */
    function sellToken(address token, uint256 tokenAmountIn, uint256 minEthOut, uint256 deadline) external returns (uint256 netEthOut) {
        if (block.timestamp > deadline) revert Expired();
        if (tokenAmountIn == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        if (!IERC20(token).transferFrom(msg.sender, address(this), tokenAmountIn)) revert TokenTransferFailed();
        uint256 actualAmountIn = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (actualAmountIn == 0) revert ZeroAmount();

        bytes memory result = poolManager.unlock(
            abi.encode(CallbackData({action: Action.Sell, token: token, trader: msg.sender, amountIn: actualAmountIn, minOut: minEthOut}))
        );
        netEthOut = abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();

        CallbackData memory cb = abi.decode(data, (CallbackData));
        PoolKey memory key = factory.getPoolKey(cb.token);

        if (cb.action == Action.Buy) {
            return abi.encode(_executeBuy(key, cb));
        } else if (cb.action == Action.Sell) {
            return abi.encode(_executeSell(key, cb));
        }
        revert UnknownAction();
    }

    /// @dev zeroForOne = true: swapping currency0 (native ETH) for currency1 (token).
    ///      Router's own final delta (after the hook fully absorbs the trade, per the
    ///      sign derivation documented in IncentifiV4Hook._beforeSwap) is negative on
    ///      amount0 (router owes ETH — settle) and positive on amount1 (router is
    ///      owed token — take).
    function _executeBuy(PoolKey memory key, CallbackData memory cb) internal returns (uint256 tokensOut) {
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(cb.amountIn), sqrtPriceLimitX96: 0}),
            ""
        );

        int128 ethDelta = delta.amount0();
        int128 tokenDelta = delta.amount1();
        if (ethDelta > 0 || tokenDelta < 0) revert UnknownAction(); // sanity: buy must owe ETH, be owed token

        tokensOut = uint256(uint128(tokenDelta));
        if (tokensOut < cb.minOut) revert SlippageExceeded();

        poolManager.settle{value: uint256(uint128(-ethDelta))}();
        poolManager.take(key.currency1, cb.trader, tokensOut);
    }

    /// @dev zeroForOne = false: swapping currency1 (token) for currency0 (native ETH).
    ///
    /// @dev ORDERING BUG FIXED (found via real fork test, not by inspection): unlike
    ///      _executeBuy, this cannot settle the token leg AFTER calling swap(). On a
    ///      buy, the hook's mid-swap take() of native ETH succeeds even before the
    ///      router's later settle{value}() call physically arrives, because
    ///      PoolManager already holds a real ETH balance from all its OTHER pools'
    ///      liquidity — the hook is effectively borrowing against that shared
    ///      reserve for the instant before the router repays it. A freshly-launched
    ///      Incentifi token has no such shared reserve: PoolManager has never held a
    ///      single unit of it. So when the hook's beforeSwap (running synchronously
    ///      inside this contract's poolManager.swap() call, below) tries to
    ///      take() the seller's tokens out of PoolManager before this router has
    ///      ever deposited them, the underlying ERC20 transfer reverts for real
    ///      insufficient balance — confirmed by the actual revert trace the first
    ///      time this was run against the fork (PoolManager -> hook.beforeSwap ->
    ///      hook._takeToken -> a real "balance" revert from the token contract).
    ///      Fix: settle the tokens INTO PoolManager BEFORE calling swap(), so real
    ///      backing already exists when the hook's take() executes. The router's own
    ///      pre-paid token credit and the swap's resulting token debit then net to
    ///      exactly zero automatically (see the tokenDelta == 0 assertion below) —
    ///      no post-swap token settlement is needed or correct anymore.
    function _executeSell(PoolKey memory key, CallbackData memory cb) internal returns (uint256 netEthOut) {
        poolManager.sync(key.currency1);
        bool success = _tokenAt(key).transfer(address(poolManager), cb.amountIn);
        if (!success) revert TokenTransferFailed();
        poolManager.settle();

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(cb.amountIn), sqrtPriceLimitX96: 0}),
            ""
        );

        int128 tokenDelta = delta.amount1();
        int128 ethDelta = delta.amount0();
        // CORRECTED (found via the same real fork test, by logging the actual
        // returned delta): swap()'s returned delta is only THIS call's own
        // contribution to the router's ledger, not a running cumulative total — the
        // pre-funding settle() above already posted its own separate +cb.amountIn
        // credit to the router's token delta a moment earlier. So this swap's own
        // token delta should read exactly -cb.amountIn (the hook fully absorbing
        // what was just paid in); added together, the router's cumulative token
        // delta lands on exactly zero by the time unlock() finishes, which
        // PoolManager itself enforces independently of this check. A mismatch here
        // means the hook received a different amount of tokens than this router
        // paid in — a real accounting bug, not something to silently tolerate.
        if (tokenDelta != -int128(int256(cb.amountIn))) revert UnknownAction();
        if (ethDelta < 0) revert UnknownAction(); // sanity: sell must be owed ETH, never owe it

        netEthOut = uint256(uint128(ethDelta));
        if (netEthOut < cb.minOut) revert SlippageExceeded();

        poolManager.take(key.currency0, cb.trader, netEthOut);
    }

    function _tokenAt(PoolKey memory key) internal pure returns (IERC20) {
        return IERC20(Currency.unwrap(key.currency1));
    }

    receive() external payable {}
}
