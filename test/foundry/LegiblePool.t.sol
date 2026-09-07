// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";

import {IncentifiV4LegibleHook} from "../../contracts/v4/legible/IncentifiV4LegibleHook.sol";
import {IncentifiV4LegibleFactory} from "../../contracts/v4/legible/IncentifiV4LegibleFactory.sol";
import {IncentifiFeeConverter} from "../../contracts/v4/legible/IncentifiFeeConverter.sol";
import {GenericV4Bot} from "../../contracts/v4/test-helpers/GenericV4Bot.sol";
import {LossRewardPool} from "../../contracts/LossRewardPool.sol";
import {IncentifiLaunchToken} from "../../contracts/IncentifiLaunchToken.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/**
 * Foundry fork suite for the V4 "legible pool" (docs/V4_LEGIBLE_POOL_DESIGN.md).
 *
 * Everything on-chain is REAL Robinhood Chain mainnet state: the production PoolManager,
 * UniversalRouter, V4 Quoter and Permit2. Only our own contracts are freshly deployed on the
 * fork (hook via CREATE2 at a mined address, factory, fee converter, a throwaway LossRewardPool,
 * a throwaway launch token). Nothing here is deployed to mainnet.
 *
 * Run: forge test --match-path test/foundry/LegiblePool.t.sol -vv
 */
contract LegiblePoolTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Real Robinhood Chain deployments (developers.uniswap.org/docs/protocols/v4/deployments, chain 4663)
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint8 constant UR_V4_SWAP = 0x10; // UniversalRouter Commands.V4_SWAP

    uint256 constant SUPPLY = 1_000_000_000e18;
    uint256 constant VE = 2_156_250_000_000_000_000;
    uint256 constant VT = 78_125_000e18;
    uint256 constant K = 2_324_707_031_250_000_000_000_000_000_000_000_000_000_000_000;
    uint256 constant GRAD_ETH = 5_853_863_234_375_000_000;

    bytes32 constant PM_SWAP_TOPIC = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    bytes32 constant BOUGHT_TOPIC = keccak256("Bought(bytes32,address,uint256,uint256,uint256,uint256)");
    bytes32 constant SOLD_TOPIC = keccak256("Sold(bytes32,address,uint256,uint256,uint256,uint256)");
    bytes32 constant FEES_CONVERTED_TOPIC = keccak256("FeesConverted(bytes32,uint256,uint256)");
    bytes32 constant GRADUATED_TOPIC = keccak256("Graduated(bytes32,address,uint256,uint256)");
    bytes32 constant GRAD_LIQ_TOPIC = keccak256("GraduationLiquidityDeployed(bytes32,uint128,uint160,uint256,uint256)");

    LossRewardPool pool;
    IncentifiV4LegibleHook hook;
    IncentifiV4LegibleFactory factory;
    IncentifiFeeConverter converter;
    GenericV4Bot bot;
    IncentifiLaunchToken token;
    PoolKey key;
    PoolId poolId;

    address creator = makeAddr("creator");
    address buyer = makeAddr("buyer");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));

        pool = new LossRewardPool(address(this));

        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
        assertEq(flags, 0x28C0, "permission mask per design doc section 3.7");
        (address predicted, bytes32 salt) = mineSalt(
            flags, abi.encodePacked(type(IncentifiV4LegibleHook).creationCode, abi.encode(POOL_MANAGER, address(pool), address(this)))
        );
        hook = new IncentifiV4LegibleHook{salt: salt}(POOL_MANAGER, address(pool), address(this));
        assertEq(address(hook), predicted, "CREATE2 hook address must carry the mined flags");

        factory = new IncentifiV4LegibleFactory(POOL_MANAGER, hook);
        converter = new IncentifiFeeConverter(POOL_MANAGER, address(hook), address(pool));
        hook.setFactory(address(factory));
        hook.setFeeConverter(address(converter));
        bot = new GenericV4Bot(POOL_MANAGER);

        vm.startPrank(creator);
        token = new IncentifiLaunchToken("Legible Test", "LGBL", SUPPLY);
        token.approve(address(factory), SUPPLY);
        poolId = factory.launchToken(address(token));
        vm.stopPrank();
        key = factory.getPoolKey(address(token));

        vm.deal(buyer, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // ------------------------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------------------------
    /// @dev Same search as periphery's HookMiner.find, but hashes the (16 KB) init code ONCE and
    ///      iterates 85-byte keccaks — HookMiner re-hashes the whole init code per candidate,
    ///      which made setUp take minutes in the EVM and let the fork's RPC state expire mid-run
    ///      (this RPC keeps ~6k blocks of state; the chain moves ~44 blocks/s).
    ///      Also: NO `code.length` probe inside the loop — on a fork every EXTCODESIZE of an unseen
    ///      address is an RPC round-trip, which is what actually made mining take minutes.
    function mineSalt(uint160 flags, bytes memory initCode) internal view returns (address hookAddress, bytes32 salt) {
        bytes32 initHash = keccak256(initCode);
        uint160 mask = Hooks.ALL_HOOK_MASK;
        for (uint256 i = 0; i < 500_000; i++) {
            salt = bytes32(i);
            hookAddress = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
            if (uint160(hookAddress) & mask == flags) {
                require(hookAddress.code.length == 0, "mined address already has code");
                return (hookAddress, salt);
            }
        }
        revert("salt not found");
    }

    function legacyTokensOut(uint256 grossEth, uint256 realEth, uint256 realToken) internal pure returns (uint256) {
        uint256 net = grossEth - grossEth / 100 - grossEth / 100;
        uint256 newEth = VE + realEth + net;
        return (VT + realToken) - (K / newEth);
    }

    function curvePositionLiquidity() internal view returns (uint128) {
        return POOL_MANAGER.getPositionLiquidity(poolId, Position.calculatePositionKey(address(hook), hook.TICK_LOWER(), hook.TICK_UPPER(), bytes32(0)));
    }

    function graduatedPositionLiquidity() internal view returns (uint128) {
        return POOL_MANAGER.getPositionLiquidity(
            poolId, Position.calculatePositionKey(address(hook), TickMath.minUsableTick(hook.TICK_SPACING()), TickMath.maxUsableTick(hook.TICK_SPACING()), bytes32(uint256(1)))
        );
    }

    function sqrtPrice() internal view returns (uint160 p) {
        (p,,,) = POOL_MANAGER.getSlot0(poolId);
    }

    function botBuy(address who, uint256 ethIn) internal returns (uint256 tokensOut) {
        uint256 before = token.balanceOf(who);
        vm.prank(who, who);
        bot.swap{value: ethIn}(key, true, ethIn, 0);
        tokensOut = token.balanceOf(who) - before;
    }

    function botSell(address who, uint256 tokensIn) internal returns (uint256 ethOut) {
        uint256 before = who.balance;
        vm.startPrank(who, who);
        token.approve(address(bot), tokensIn);
        bot.swap(key, false, tokensIn, 0);
        vm.stopPrank();
        ethOut = who.balance - before;
    }

    function urInputs(bool zeroForOne, uint128 amountIn, uint128 minOut) internal view returns (bytes memory commands, bytes[] memory inputs) {
        bytes memory actions = abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(IV4Router.ExactInputSingleParams({poolKey: key, zeroForOne: zeroForOne, amountIn: amountIn, amountOutMinimum: minOut, hookData: ""}));
        params[1] = abi.encode(zeroForOne ? key.currency0 : key.currency1, amountIn);
        params[2] = abi.encode(zeroForOne ? key.currency1 : key.currency0, minOut);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        commands = abi.encodePacked(UR_V4_SWAP);
    }

    function urBuy(address who, uint256 ethIn) internal returns (uint256 tokensOut) {
        (bytes memory commands, bytes[] memory inputs) = urInputs(true, uint128(ethIn), 0);
        uint256 before = token.balanceOf(who);
        vm.prank(who, who);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: ethIn}(commands, inputs, block.timestamp + 300);
        tokensOut = token.balanceOf(who) - before;
    }

    function urSell(address who, uint256 tokensIn) internal returns (uint256 ethOut) {
        vm.startPrank(who, who);
        token.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(address(token), UNIVERSAL_ROUTER, uint160(tokensIn), uint48(block.timestamp + 1 days));
        (bytes memory commands, bytes[] memory inputs) = urInputs(false, uint128(tokensIn), 0);
        uint256 before = who.balance;
        IUniversalRouter(UNIVERSAL_ROUTER).execute(commands, inputs, block.timestamp + 300);
        vm.stopPrank();
        ethOut = who.balance - before;
    }

    function findLog(Vm.Log[] memory logs, address emitter, bytes32 topic0) internal pure returns (Vm.Log memory found, bool ok) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic0) return (logs[i], true);
        }
    }

    function tokenState() internal view returns (IncentifiV4LegibleHook.TokenState memory) {
        return hook.tokenStates(poolId);
    }

    // ------------------------------------------------------------------------------------------
    // 1. Launch: exactly one real position with L = sqrt(K); the pool is legible from block one
    // ------------------------------------------------------------------------------------------
    function test_LaunchSeedsSingleCurvePosition() public view {
        // getLiquidity() is IN-RANGE liquidity: at launch the price sits exactly at the range's upper
        // bound, so it reads 0 until the first trade steps into the range (asserted in test 2). The
        // position itself carries L from block one:
        assertEq(uint256(POOL_MANAGER.getLiquidity(poolId)), 0, "no in-range liquidity until the first trade");
        assertEq(uint256(curvePositionLiquidity()), uint256(hook.CURVE_LIQUIDITY()), "hook-owned curve position == L");
        assertEq(sqrtPrice(), hook.launchSqrtPriceX96(), "initialized at the legacy launch price");
        (, int24 tick,, uint24 lpFee) = POOL_MANAGER.getSlot0(poolId);
        assertEq(tick, 200311, "launch tick");
        assertEq(lpFee, 0, "dynamic-fee pool starts at 0; the hook overrides per swap");

        IncentifiV4LegibleHook.TokenState memory s = tokenState();
        uint256 expectedCurveTokens = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(hook.TICK_LOWER()), TickMath.getSqrtPriceAtTick(hook.TICK_UPPER()), hook.CURVE_LIQUIDITY(), true
        );
        assertEq(s.curveTokens, expectedCurveTokens, "tokens in the curve position");
        assertApproxEqRel(s.curveTokens, 787_903_505.843e18, 1e15, "~ 787.9M tokens (design doc; spacing-10 bounds shift it by < 0.1%)");
        assertApproxEqRel(s.reserveTokens, 212_096_494.157e18, 4e15, "~ 212.1M tokens held for graduation (spacing-10 bounds shift it by < 0.4%)");
        assertEq(s.curveTokens + s.reserveTokens, SUPPLY, "nothing lost");
        assertEq(token.balanceOf(address(POOL_MANAGER)), s.curveTokens, "PoolManager holds exactly the curve tokens");
        assertEq(token.balanceOf(address(hook)), s.reserveTokens, "hook holds exactly the reserve");

        (,, bool initialized, bool graduated, uint256 realEth, uint256 realToken) = hook.curveStates(poolId);
        assertTrue(initialized);
        assertFalse(graduated);
        assertEq(realEth, 0, "legacy view: nothing raised yet");
        assertApproxEqAbs(realToken, SUPPLY, 2, "legacy view: full supply unsold");
    }

    // ------------------------------------------------------------------------------------------
    // 2. A buy through a GENERIC caller matches the legacy curve to 0.01% and emits a real Swap
    // ------------------------------------------------------------------------------------------
    function test_BuyMatchesLegacyCurveMath_andEmitsRealSwap() public {
        vm.recordLogs();
        uint256 tokensOut = botBuy(buyer, 1 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 expected = legacyTokensOut(1 ether, 0, SUPPLY);
        assertApproxEqRel(tokensOut, expected, 1e15, "tokens out vs legacy curve (bound rounding <= 0.07%)");

        (Vm.Log memory swapLog, bool ok) = findLog(logs, address(POOL_MANAGER), PM_SWAP_TOPIC);
        assertTrue(ok, "PoolManager must emit Swap");
        (int128 a0, int128 a1, uint160 p, uint128 liq,, uint24 fee) = abi.decode(swapLog.data, (int128, int128, uint160, uint128, int24, uint24));
        assertEq(a0, -int128(int256(1 ether)), "Swap.amount0 = real ETH in");
        assertEq(uint256(uint128(a1)), tokensOut, "Swap.amount1 = real tokens out");
        assertEq(uint256(liq), uint256(hook.CURVE_LIQUIDITY()), "Swap.liquidity is the real position");
        assertEq(uint256(POOL_MANAGER.getLiquidity(poolId)), uint256(hook.CURVE_LIQUIDITY()), "in-range liquidity == L after the first trade");
        assertEq(fee, hook.PRE_GRADUATION_FEE_PIPS(), "Swap.fee shows the 2% dynamic fee");
        assertLt(p, hook.launchSqrtPriceX96(), "price moved");
        assertEq(sqrtPrice(), p, "slot0 moved with it");

        (Vm.Log memory bought, bool ok2) = findLog(logs, address(hook), BOUGHT_TOPIC);
        assertTrue(ok2, "hook emits Bought");
        assertEq(address(uint160(uint256(bought.topics[2]))), buyer, "trader = tx.origin");
        (uint256 ethIn, uint256 tOut, uint256 cFee, uint256 lFee) = abi.decode(bought.data, (uint256, uint256, uint256, uint256));
        assertEq(ethIn, 1 ether);
        assertEq(tOut, tokensOut);
        assertEq(cFee, 0.01 ether);
        assertEq(lFee, 0.01 ether);

        // legacy view stays exact: (VE + E)/(VT + T) == pool price
        (,,,, uint256 realEth, uint256 realToken) = hook.curveStates(poolId);
        assertApproxEqRel(realEth, 0.98 ether, 1e12, "raised = net ETH after 2% fee");
        assertApproxEqRel(realToken, SUPPLY - tokensOut, 1e12, "unsold = supply - bought");
        // Compare in Uniswap price space q = tokens per ETH: legacy q = (VT+T)/(VE+E); pool q = p^2 / 2^192.
        uint256 legacyQ = FullMath.mulDiv(VT + realToken, 1e18, VE + realEth);
        uint256 poolQ = FullMath.mulDiv(FullMath.mulDiv(uint256(sqrtPrice()), uint256(sqrtPrice()), 1 << 96), 1e18, 1 << 96);
        // The position's virtual reserves are anchored at the tick-rounded upper bound (200,310 vs the
        // exact 200,311.2), so the pool price sits ~0.012% from the legacy formula by construction.
        assertApproxEqRel(legacyQ, poolQ, 2e14, "legacy formula == pool price (within the 0.012% bound rounding)");
    }

    // ------------------------------------------------------------------------------------------
    // 3. Fees accrue as ORDINARY LP fees; collect() splits them 1% creator / 1% loss pool
    // ------------------------------------------------------------------------------------------
    function test_FeesAccrueAsLpFees_andCollectSplits() public {
        botBuy(buyer, 1 ether);
        assertEq(pool.totalDeposited(address(token)), 0, "nothing reaches the pool until collected");
        assertEq(hook.creatorBalances(creator), 0);

        vm.prank(stranger); // permissionless
        hook.collect(address(token));
        assertApproxEqAbs(pool.totalDeposited(address(token)), 0.01 ether, 1e6, "loss pool gets 1% of ETH in");
        assertApproxEqAbs(hook.creatorBalances(creator), 0.01 ether, 1e6, "creator gets 1% of ETH in");
        assertEq(address(hook).balance, hook.creatorBalances(creator), "hook holds only the creator's unclaimed pull-payment");

        uint256 before = pool.totalDeposited(address(token));
        hook.collect(address(token));
        assertEq(pool.totalDeposited(address(token)), before, "second collect finds nothing new");

        uint256 cb = creator.balance;
        vm.prank(creator);
        hook.claimCreatorFees();
        assertApproxEqAbs(creator.balance - cb, 0.01 ether, 1e6, "creator pull-payment works");
    }

    // ------------------------------------------------------------------------------------------
    // 4. Sell through the REAL UniversalRouter (Permit2); token-side fees are converted to ETH
    // ------------------------------------------------------------------------------------------
    function test_SellViaUniversalRouter_TokenFeesConvertedToEth() public {
        uint256 bought = botBuy(buyer, 1 ether);
        uint256 half = bought / 2;

        vm.recordLogs();
        uint256 ethOut = urSell(buyer, half);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(ethOut, 0, "UR sell pays ETH");
        (Vm.Log memory sold, bool ok) = findLog(logs, address(hook), SOLD_TOPIC);
        assertTrue(ok, "Sold emitted");
        assertEq(address(uint160(uint256(sold.topics[2]))), buyer, "trader = tx.origin, not the router");
        (uint256 tIn, uint256 eOut, uint256 cFee, uint256 lFee) = abi.decode(sold.data, (uint256, uint256, uint256, uint256));
        assertEq(tIn, half);
        assertEq(eOut, ethOut);
        assertApproxEqRel(cFee + lFee, ethOut * 20_000 / 980_000, 1e9, "fee reported as ETH-equivalent of the 2% token fee");

        // token fees accrued in the position -> collect -> converter
        vm.prank(stranger);
        hook.collect(address(token));
        uint256 pending = converter.pendingTokenFees(address(token));
        assertApproxEqRel(pending, half * 20_000 / 1_000_000, 1e12, "~ 2% of tokens sold, in tokens");
        assertEq(token.balanceOf(address(converter)), pending, "converter custodies them");

        uint256 depositedBefore = pool.totalDeposited(address(token));
        uint256 creatorBefore = hook.creatorBalances(creator);
        vm.recordLogs();
        vm.prank(stranger); // permissionless
        uint256 converted = converter.convert(address(token), 0, 0);
        logs = vm.getRecordedLogs();
        assertGt(converted, 0);
        assertEq(pool.totalDeposited(address(token)) - depositedBefore, converted - converted / 2, "loss pool gets half");
        assertEq(hook.creatorBalances(creator) - creatorBefore, converted / 2, "creator gets half");
        (, bool convertedEvt) = findLog(logs, address(hook), FEES_CONVERTED_TOPIC);
        (, bool soldEvt) = findLog(logs, address(hook), SOLD_TOPIC);
        assertTrue(convertedEvt, "converter's swap is tagged FeesConverted");
        assertFalse(soldEvt, "...and never as a holder Sold (indexer stays clean)");
        assertEq(converter.pendingTokenFees(address(token)), 0, "fully consumed");
    }

    // ------------------------------------------------------------------------------------------
    // 5. Liquidity gating (security): only the hook adds liquidity unless governance opens it
    // ------------------------------------------------------------------------------------------
    function test_LiquidityGated() public {
        int24 tl = TickMath.minUsableTick(hook.TICK_SPACING());
        int24 tu = TickMath.maxUsableTick(hook.TICK_SPACING());
        uint128 before = POOL_MANAGER.getLiquidity(poolId);
        vm.prank(stranger);
        vm.expectRevert();
        bot.addLiquidity{value: 1 ether}(key, tl, tu, 1e15, bytes32(uint256(7)));
        assertEq(POOL_MANAGER.getLiquidity(poolId), before, "pre-graduation: external add rejected");

        botBuy(buyer, 8 ether); // graduates (overshoot)
        assertTrue(tokenState().graduated);
        before = POOL_MANAGER.getLiquidity(poolId);
        vm.prank(stranger);
        vm.expectRevert();
        bot.addLiquidity{value: 1 ether}(key, tl, tu, 1e15, bytes32(uint256(7)));
        assertEq(POOL_MANAGER.getLiquidity(poolId), before, "post-graduation: still gated by default (decision C)");

        vm.prank(stranger);
        vm.expectRevert(IncentifiV4LegibleHook.OnlyOwner.selector);
        hook.setLpOpen(address(token), true);

        hook.setLpOpen(address(token), true); // owner (this test contract)
        botBuy(stranger, 0.5 ether); // a full-range position needs tokens as well as ETH
        vm.startPrank(stranger);
        token.approve(address(bot), type(uint256).max);
        bot.addLiquidity{value: 1 ether}(key, tl, tu, 1e15, bytes32(uint256(7)));
        vm.stopPrank();
        assertGt(POOL_MANAGER.getLiquidity(poolId), before, "governance-opened: external add accepted");
    }

    // ------------------------------------------------------------------------------------------
    // 6. Graduation inside afterSwap: an overshooting buy exhausts the curve in one trade
    // ------------------------------------------------------------------------------------------
    function test_GraduationFiresInAfterSwap_onOvershootBuy() public {
        IncentifiV4LegibleHook.TokenState memory s0 = tokenState();
        vm.recordLogs();
        uint256 tokensOut = botBuy(buyer, 8 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        IncentifiV4LegibleHook.TokenState memory s = tokenState();
        assertTrue(s.graduated, "graduated in the same tx");
        (Vm.Log memory swapLog,) = findLog(logs, address(POOL_MANAGER), PM_SWAP_TOPIC);
        (int128 a0,,,,,) = abi.decode(swapLog.data, (int128, int128, uint160, uint128, int24, uint24));
        uint256 ethConsumed = uint256(uint128(-a0));
        assertApproxEqRel(ethConsumed, GRAD_ETH * 1_000_000 / 980_000, 2e15, "ETH consumed = graduation target / (1 - 2%), within the 0.07% bound rounding");
        assertLt(ethConsumed, 8 ether, "the rest of the 8 ETH was not taken (partial fill)");
        assertApproxEqRel(tokensOut, s0.curveTokens, 1e12, "buyer received the whole curve");

        // price pinned to the graduation tick, curve position gone, full-range position live
        assertEq(sqrtPrice(), TickMath.getSqrtPriceAtTick(hook.TICK_LOWER()), "price pinned to P_g");
        assertEq(uint256(curvePositionLiquidity()), 0, "curve position removed");
        assertGt(uint256(s.graduatedLiquidity), 0);
        assertEq(uint256(graduatedPositionLiquidity()), uint256(s.graduatedLiquidity), "full-range position owned by hook");
        assertEq(uint256(POOL_MANAGER.getLiquidity(poolId)), uint256(s.graduatedLiquidity), "it is the only liquidity");

        // principal and fees
        (Vm.Log memory grad, bool ok) = findLog(logs, address(hook), GRADUATED_TOPIC);
        assertTrue(ok);
        (uint256 finalEth, uint256 finalTokens) = abi.decode(grad.data, (uint256, uint256));
        assertApproxEqRel(finalEth, GRAD_ETH, 2e15, "raised ~ 5.853863234 ETH");
        assertApproxEqRel(finalTokens, s0.reserveTokens, 1e12, "reserve paired");
        assertApproxEqAbs(pool.totalDeposited(address(token)), ethConsumed / 100, 1e9, "loss pool got 1% (fees collected at graduation)");
        assertApproxEqAbs(hook.creatorBalances(creator), ethConsumed / 100, 1e9, "creator got 1%");
        // Nothing is stranded: the tick-rounding remainder was DONATED into the graduated position
        // (see GraduationLiquidityDeployed), so the hook holds only the creator's pull-payment and no tokens.
        assertEq(address(hook).balance, hook.creatorBalances(creator), "hook ETH == creator's unclaimed pull-payment only");
        assertEq(token.balanceOf(address(hook)), 0, "hook holds no tokens after graduation");
        (Vm.Log memory deployed, bool okD) = findLog(logs, address(hook), GRAD_LIQ_TOPIC);
        assertTrue(okD);
        (,, uint256 ethDonated, uint256 tokenDonated) = abi.decode(deployed.data, (uint128, uint160, uint256, uint256));
        assertLt(tokenDonated, s0.reserveTokens / 500, "token remainder < 0.2% of the reserve (spacing-10 rounding)");
        assertLt(ethDonated, 1e15, "ETH remainder < 0.001 ETH");

        // legacy view after graduation
        (,,, bool graduated, uint256 realEth, uint256 realToken) = hook.curveStates(poolId);
        assertTrue(graduated);
        assertEq(realEth, finalEth);
        assertEq(realToken, finalTokens);

        // post-graduation trading works through the full-range position; the 2% fee continues
        uint256 depositedBefore = pool.totalDeposited(address(token));
        vm.recordLogs();
        uint256 out2 = botBuy(buyer, 0.1 ether);
        logs = vm.getRecordedLogs();
        assertGt(out2, 0, "post-graduation buy fills");
        (Vm.Log memory bought,) = findLog(logs, address(hook), BOUGHT_TOPIC);
        (,, uint256 cFee, uint256 lFee) = abi.decode(bought.data, (uint256, uint256, uint256, uint256));
        assertEq(cFee, 0.001 ether, "post-graduation buy: 1% creator");
        assertEq(lFee, 0.001 ether, "post-graduation buy: 1% loss pool");
        hook.collect(address(token));
        assertApproxEqAbs(pool.totalDeposited(address(token)) - depositedBefore, 0.001 ether, 1e6, "1% of the post-graduation buy reaches the loss pool");
        uint256 sellOut = botSell(buyer, out2);
        assertGt(sellOut, 0, "post-graduation sell fills");
    }

    // ------------------------------------------------------------------------------------------
    // 7. Graduation across two trades (the second only slightly overshoots)
    // ------------------------------------------------------------------------------------------
    function test_GraduationAcrossTwoTrades() public {
        botBuy(buyer, 3 ether);
        assertFalse(tokenState().graduated);
        (,,,, uint256 realEth,) = hook.curveStates(poolId);
        assertApproxEqRel(realEth, 2.94 ether, 1e12, "3 ETH gross -> 2.94 net raised");

        botBuy(stranger, 3.1 ether);
        IncentifiV4LegibleHook.TokenState memory s = tokenState();
        assertTrue(s.graduated, "second buy crosses the bound");
        assertEq(sqrtPrice(), TickMath.getSqrtPriceAtTick(hook.TICK_LOWER()));
        assertEq(uint256(POOL_MANAGER.getLiquidity(poolId)), uint256(s.graduatedLiquidity));
        assertApproxEqRel(s.finalEthReserve, GRAD_ETH, 2e15);
    }

    // ------------------------------------------------------------------------------------------
    // 8. Permissionless fallback is safe: cannot graduate early, cannot graduate twice
    // ------------------------------------------------------------------------------------------
    function test_PermissionlessGraduateFallback() public {
        botBuy(buyer, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(IncentifiV4LegibleHook.NotReadyToGraduate.selector);
        hook.graduate(address(token));

        botBuy(buyer, 8 ether);
        assertTrue(tokenState().graduated);
        vm.prank(stranger);
        vm.expectRevert(IncentifiV4LegibleHook.AlreadyGraduated.selector);
        hook.graduate(address(token));
    }

    // ------------------------------------------------------------------------------------------
    // 9. Post-graduation fee (decision D, final): 2% by default from launch, split 1%/1%, capped
    //    at 2%, owner-adjustable within [0, 2%] effective immediately, no timelock
    // ------------------------------------------------------------------------------------------
    function test_PostGraduationFee_TwoPercentByDefault_CappedAtTwoPercent() public {
        uint24 twoPct = hook.PRE_GRADUATION_FEE_PIPS();
        assertEq(hook.MAX_POST_GRADUATION_FEE_PIPS(), twoPct, "the cap IS the curve fee");
        assertEq(hook.postGraduationFeePips(address(token)), twoPct, "on by default from launch");

        botBuy(buyer, 8 ether);
        assertTrue(tokenState().graduated);
        assertEq(hook.postGraduationFeePips(address(token)), twoPct, "no fee cliff at graduation");

        vm.prank(stranger);
        vm.expectRevert(IncentifiV4LegibleHook.OnlyOwner.selector);
        hook.setPostGraduationFee(address(token), 0);

        uint24 tooHigh = twoPct + 1;
        vm.expectRevert(IncentifiV4LegibleHook.FeeTooHigh.selector);
        hook.setPostGraduationFee(address(token), tooHigh);

        hook.collect(address(token)); // flush fees accrued up to graduation
        uint256 before = pool.totalDeposited(address(token));
        uint256 creatorBefore = hook.creatorBalances(creator);
        vm.recordLogs();
        botBuy(buyer, 1 ether);
        (Vm.Log memory swapLog,) = findLog(vm.getRecordedLogs(), address(POOL_MANAGER), PM_SWAP_TOPIC);
        (,,,,, uint24 fee) = abi.decode(swapLog.data, (int128, int128, uint160, uint128, int24, uint24));
        assertEq(fee, twoPct, "post-graduation swap charged 2%");
        hook.collect(address(token));
        assertApproxEqAbs(pool.totalDeposited(address(token)) - before, 0.01 ether, 1e6, "1% of 1 ETH reaches the loss pool");
        assertApproxEqAbs(hook.creatorBalances(creator) - creatorBefore, 0.01 ether, 1e6, "1% of 1 ETH to the creator");

        hook.setPostGraduationFee(address(token), 0); // immediate, no proposal step exists
        assertEq(hook.postGraduationFeePips(address(token)), 0);
        before = pool.totalDeposited(address(token));
        botBuy(buyer, 1 ether);
        hook.collect(address(token));
        assertEq(pool.totalDeposited(address(token)), before, "at 0: nothing accrues");

        hook.setPostGraduationFee(address(token), twoPct); // back up to the cap, also immediate
        assertEq(hook.postGraduationFeePips(address(token)), twoPct);
    }

    // ------------------------------------------------------------------------------------------
    // 10. The canonical V4 Quoter and UniversalRouter agree to the wei - nothing to mis-simulate
    // ------------------------------------------------------------------------------------------
    function test_QuoterMatchesUniversalRouterExecution() public {
        (uint256 quotedBuy,) = IV4Quoter(QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: true, exactAmount: 0.5 ether, hookData: ""})
        );
        uint256 gotBuy = urBuy(buyer, 0.5 ether);
        assertEq(gotBuy, quotedBuy, "buy: UR execution == Quoter");

        uint256 sellAmount = gotBuy / 3;
        (uint256 quotedSell,) = IV4Quoter(QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: false, exactAmount: uint128(sellAmount), hookData: ""})
        );
        uint256 gotSell = urSell(buyer, sellAmount);
        assertEq(gotSell, quotedSell, "sell: UR execution == Quoter");
    }

    // ------------------------------------------------------------------------------------------
    // 11. Hostile initialize attempts are rejected by the hook
    // ------------------------------------------------------------------------------------------
    function test_HostileInitializeRejected() public {
        vm.prank(stranger);
        IncentifiLaunchToken other = new IncentifiLaunchToken("Other", "OTH", SUPPLY);
        PoolKey memory k = factory.getPoolKey(address(other));
        uint160 launchPrice = hook.launchSqrtPriceX96();
        vm.expectRevert(); // TokenNotRegistered, wrapped by PoolManager
        POOL_MANAGER.initialize(k, launchPrice);

        PoolKey memory badFee = PoolKey({currency0: k.currency0, currency1: k.currency1, fee: 3000, tickSpacing: 10, hooks: IHooks(address(hook))});
        vm.expectRevert(); // MustBeDynamicFeePool
        POOL_MANAGER.initialize(badFee, launchPrice);
    }
}
