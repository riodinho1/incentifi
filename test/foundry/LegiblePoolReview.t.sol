// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IncentifiV4LegibleHook} from "../../contracts/v4/legible/IncentifiV4LegibleHook.sol";
import {IncentifiV4LegibleFactory} from "../../contracts/v4/legible/IncentifiV4LegibleFactory.sol";
import {IncentifiFeeConverter} from "../../contracts/v4/legible/IncentifiFeeConverter.sol";
import {GenericV4Bot} from "../../contracts/v4/test-helpers/GenericV4Bot.sol";
import {LossRewardPool} from "../../contracts/LossRewardPool.sol";
import {IncentifiLaunchToken} from "../../contracts/IncentifiLaunchToken.sol";

/**
 * Review fixes for PR #17, one fork test per item (Robinhood mainnet fork, real PoolManager):
 *   #1 convert() cannot be sandwiched in the same block, regardless of the caller's minEthOut
 *   #2 the converter's own swap is fee-free and delivers what the holder's Sold event reported
 *   #3 _inHookOperation is per pool: a reentrant swap on pool B during pool A's graduation is
 *      charged its fee and emits Bought (LegiblePoolReentrancyTest, below)
 *   #4 graduation dust is donated into the graduated position and re-emerges via collect()
 *   #5 post-graduation fee raises are timelocked; a reduction to zero is immediate
 *
 * Run: forge test --match-path test/foundry/LegiblePoolReview.t.sol -vv
 */
abstract contract LegibleReviewBase is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    uint256 constant SUPPLY = 1_000_000_000e18;
    bytes32 constant PM_SWAP_TOPIC = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    bytes32 constant BOUGHT_TOPIC = keccak256("Bought(bytes32,address,uint256,uint256,uint256,uint256)");
    bytes32 constant SOLD_TOPIC = keccak256("Sold(bytes32,address,uint256,uint256,uint256,uint256)");
    bytes32 constant GRAD_LIQ_TOPIC = keccak256("GraduationLiquidityDeployed(bytes32,uint128,uint160,uint256,uint256)");

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

    /// @dev Hash the init code once and iterate cheap keccaks; no code-length probes (each one
    ///      is an RPC round-trip on a fork).
    function mineSalt(uint160 flags, bytes memory initCode) internal view returns (address hookAddress, bytes32 salt) {
        bytes32 initHash = keccak256(initCode);
        for (uint256 i = 0; i < 500_000; i++) {
            salt = bytes32(i);
            hookAddress = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
            if (uint160(hookAddress) & Hooks.ALL_HOOK_MASK == flags) return (hookAddress, salt);
        }
        revert("salt not found");
    }

    function deployTrio(address lossRewardPool) internal {
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
        (address predicted, bytes32 salt) =
            mineSalt(flags, abi.encodePacked(type(IncentifiV4LegibleHook).creationCode, abi.encode(POOL_MANAGER, lossRewardPool, address(this))));
        hook = new IncentifiV4LegibleHook{salt: salt}(POOL_MANAGER, lossRewardPool, address(this));
        assertEq(address(hook), predicted);
        factory = new IncentifiV4LegibleFactory(POOL_MANAGER, hook);
        converter = new IncentifiFeeConverter(POOL_MANAGER, address(hook), lossRewardPool);
        hook.setFactory(address(factory));
        hook.setFeeConverter(address(converter));
        bot = new GenericV4Bot(POOL_MANAGER);
    }

    function launch(string memory name, string memory symbol) internal returns (IncentifiLaunchToken t, PoolKey memory k) {
        vm.startPrank(creator);
        t = new IncentifiLaunchToken(name, symbol, SUPPLY);
        t.approve(address(factory), SUPPLY);
        factory.launchToken(address(t));
        vm.stopPrank();
        k = factory.getPoolKey(address(t));
    }

    function botBuy(PoolKey memory k, IncentifiLaunchToken t, address who, uint256 ethIn) internal returns (uint256 tokensOut) {
        uint256 before = t.balanceOf(who);
        vm.prank(who, who);
        bot.swap{value: ethIn}(k, true, ethIn, 0);
        tokensOut = t.balanceOf(who) - before;
    }

    function botSell(PoolKey memory k, IncentifiLaunchToken t, address who, uint256 tokensIn) internal returns (uint256 ethOut) {
        uint256 before = who.balance;
        vm.startPrank(who, who);
        t.approve(address(bot), tokensIn);
        bot.swap(k, false, tokensIn, 0);
        vm.stopPrank();
        ethOut = who.balance - before;
    }

    function findLog(Vm.Log[] memory logs, address emitter, bytes32 topic0) internal pure returns (Vm.Log memory found, bool ok) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic0) return (logs[i], true);
        }
    }
}

contract LegiblePoolReviewTest is LegibleReviewBase {
    using PoolIdLibrary for PoolKey;

    LossRewardPool pool;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));
        pool = new LossRewardPool(address(this));
        deployTrio(address(pool));
        (token, key) = launch("Review Test", "RVW");
        poolId = key.toId();
        vm.deal(buyer, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // ---------------------------------------------------------------------------------------
    // #1 convert() cannot be sandwiched in the same block, whatever minEthOut says
    // ---------------------------------------------------------------------------------------
    function test_Review1_ConvertRevertsWhenSandwichedInSameBlock() public {
        uint256 bought = botBuy(key, token, buyer, 1 ether);
        botSell(key, token, buyer, bought / 2); // token-side fees accrue
        hook.collect(address(token));
        uint256 pending = converter.pendingTokenFees(address(token));
        assertGt(pending, 0);

        // attacker builds inventory in an earlier block; the checkpoint will be that block's closing price
        uint256 inventory = botBuy(key, token, stranger, 3 ether);
        vm.roll(block.number + 1);

        // same block: dump first (first swap of the block -> checkpoint = pre-dump price), then convert with minEthOut = 0
        botSell(key, token, stranger, inventory);
        vm.prank(stranger, stranger);
        vm.expectPartialRevert(IncentifiFeeConverter.SlippageExceeded.selector);
        converter.convert(address(token), 0, 0);
        assertEq(converter.pendingTokenFees(address(token)), pending, "nothing was converted at the manipulated price");

        // attacker unwinds; the honest checkpoint is still the reference and now agrees with the pool
        botBuy(key, token, stranger, 3 ether);
        vm.prank(stranger, stranger);
        uint256 ethOut = converter.convert(address(token), 0, 0);
        assertGt(ethOut, 0, "conversion succeeds once the price is back within tolerance");
        uint256 implied = converter.checkpointEthValue(address(token), pending);
        assertGe(ethOut, implied * (10_000 - converter.MAX_SLIPPAGE_BPS()) / 10_000, "on-chain floor respected");
    }

    // ---------------------------------------------------------------------------------------
    // #2 the converter's swap is fee-free and delivers what the Sold event reported
    // ---------------------------------------------------------------------------------------
    function test_Review2_ConverterSwapIsFeeFree_andMatchesSoldReport() public {
        uint256 bought = botBuy(key, token, buyer, 1 ether);
        // A SMALL sell (0.5% of the position) so its own price impact is negligible: the Sold event
        // values the token fee at the sell's average price, and the converter sells that fee at the
        // post-sell marginal price; for a large sell those differ by the impact, not by any fee.
        uint256 sellAmount = bought / 200;
        vm.recordLogs();
        botSell(key, token, buyer, sellAmount);
        (Vm.Log memory sold,) = findLog(vm.getRecordedLogs(), address(hook), SOLD_TOPIC);
        (,, uint256 cFee, uint256 lFee) = abi.decode(sold.data, (uint256, uint256, uint256, uint256));
        uint256 reportedFeeEth = cFee + lFee;

        hook.collect(address(token));
        uint256 pending = converter.pendingTokenFees(address(token));
        assertApproxEqRel(pending, sellAmount * 20_000 / 1_000_000, 1e12, "2% of the tokens sold, in tokens");

        // Impact-independent proof of "fee-free": an ordinary seller of the SAME tokens pays 2%,
        // so the converter must receive exactly 1/(1 - 2%) of what that seller gets.
        uint256 snap = vm.snapshotState();
        deal(address(token), stranger, pending);
        uint256 ethRef = botSell(key, token, stranger, pending);
        vm.revertToState(snap);

        uint256 depositedBefore = pool.totalDeposited(address(token));
        uint256 creatorBefore = hook.creatorBalances(creator);
        vm.recordLogs();
        uint256 ethOut = converter.convert(address(token), 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (Vm.Log memory swapLog,) = findLog(logs, address(POOL_MANAGER), PM_SWAP_TOPIC);
        (,,,,, uint24 fee) = abi.decode(swapLog.data, (int128, int128, uint160, uint128, int24, uint24));
        assertEq(fee, 0, "converter's own swap is charged no LP fee");
        assertApproxEqRel(ethOut, ethRef * 1_000_000 / 980_000, 1e12, "converter gets exactly 1/(1-2%) of a fee-paying seller's ETH for the same tokens");
        assertApproxEqRel(ethOut, reportedFeeEth, 5e15, "ETH delivered == fee the Sold event reported (within 0.5%: residual impact of a 0.5% sell)");
        assertEq(pool.totalDeposited(address(token)) - depositedBefore, ethOut - ethOut / 2, "loss pool gets half");
        assertEq(hook.creatorBalances(creator) - creatorBefore, ethOut / 2, "creator gets half");

        hook.collect(address(token));
        assertEq(converter.pendingTokenFees(address(token)), 0, "a fee-free conversion mints no new token fees");
    }

    // ---------------------------------------------------------------------------------------
    // #4 graduation dust is donated into the graduated position and collectable
    // ---------------------------------------------------------------------------------------
    function test_Review4_GraduationDustIsDonatedAndCollectable() public {
        vm.recordLogs();
        botBuy(key, token, buyer, 8 ether);
        (Vm.Log memory deployed, bool ok) = findLog(vm.getRecordedLogs(), address(hook), GRAD_LIQ_TOPIC);
        assertTrue(ok);
        (,, uint256 ethDonated, uint256 tokenDonated) = abi.decode(deployed.data, (uint128, uint160, uint256, uint256));
        assertGt(tokenDonated, 0, "the spacing-10 remainder exists (~0.06% of the reserve)");
        assertEq(token.balanceOf(address(hook)), 0, "...and none of it sits in the hook");
        assertEq(address(hook).balance, hook.creatorBalances(creator), "no ETH beyond the creator's pull-payment");

        uint256 pendingBefore = converter.pendingTokenFees(address(token));
        uint256 depositedBefore = pool.totalDeposited(address(token));
        hook.collect(address(token));
        assertApproxEqRel(converter.pendingTokenFees(address(token)) - pendingBefore, tokenDonated, 1e9, "donated tokens re-emerge as collectable fees");
        assertApproxEqAbs(pool.totalDeposited(address(token)) - depositedBefore, ethDonated - ethDonated / 2, 1e6, "donated ETH split to the loss pool");
        assertEq(token.balanceOf(address(hook)), 0, "hook token balance zero after collect");
    }

    // ---------------------------------------------------------------------------------------
    // #5b fee raises are timelocked; a reduction to zero is immediate
    // ---------------------------------------------------------------------------------------
    function test_Review5_PostGraduationFeeTimelock() public {
        botBuy(key, token, buyer, 8 ether);
        assertTrue(hook.tokenStates(poolId).graduated);

        vm.expectRevert(IncentifiV4LegibleHook.UseTimelock.selector);
        hook.setPostGraduationFee(address(token), 5_000); // a nonzero fee never lands immediately

        hook.proposePostGraduationFee(address(token), 20_000);
        (uint24 pips, uint64 eta) = hook.pendingPostGraduationFee(address(token));
        assertEq(pips, 20_000);
        assertEq(eta, uint64(block.timestamp + hook.FEE_TIMELOCK()));

        vm.expectRevert(IncentifiV4LegibleHook.TimelockNotElapsed.selector);
        hook.executePostGraduationFee(address(token));
        vm.warp(block.timestamp + hook.FEE_TIMELOCK() - 1);
        vm.expectRevert(IncentifiV4LegibleHook.TimelockNotElapsed.selector);
        hook.executePostGraduationFee(address(token));
        assertEq(hook.postGraduationFeePips(address(token)), 0, "still 0 before the delay");

        vm.warp(block.timestamp + 1);
        vm.prank(stranger); // permissionless once due
        hook.executePostGraduationFee(address(token));
        assertEq(hook.postGraduationFeePips(address(token)), 20_000, "raise lands only after the delay");

        hook.setPostGraduationFee(address(token), 0); // immediate
        assertEq(hook.postGraduationFeePips(address(token)), 0, "reduction to zero is immediate");

        hook.proposePostGraduationFee(address(token), 10_000);
        hook.cancelPostGraduationFee(address(token));
        vm.expectRevert(IncentifiV4LegibleHook.NoPendingFee.selector);
        hook.executePostGraduationFee(address(token));

        vm.prank(stranger);
        vm.expectRevert(IncentifiV4LegibleHook.OnlyOwner.selector);
        hook.proposePostGraduationFee(address(token), 10_000);
    }
}

/**
 * #3: a LossRewardPool that re-enters PoolManager during pool A's graduation (the hook calls
 * depositReward while A's in-operation flag is set) and swaps on pool B. B must be charged its
 * normal fee and emit Bought — a global flag would have made it fee-free and silent.
 */
contract ReentrantLossRewardPool {
    IPoolManager public immutable poolManager;
    PoolKey public keyB;
    bool public armed;
    mapping(address => uint256) public totalDeposited;

    constructor(IPoolManager _pm) {
        poolManager = _pm;
    }

    function arm(PoolKey calldata _keyB) external {
        keyB = _keyB;
        armed = true;
    }

    function depositReward(address token) external payable {
        totalDeposited[token] += msg.value;
        if (!armed) return;
        armed = false;
        // The manager is unlocked (we are inside the graduating swap's unlock): swap on B directly.
        BalanceDelta d = poolManager.swap(
            keyB, SwapParams({zeroForOne: true, amountSpecified: -int256(0.01 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}), ""
        );
        poolManager.settle{value: uint256(uint128(-d.amount0()))}();
        poolManager.take(keyB.currency1, address(this), uint256(uint128(d.amount1())));
    }

    function getUnallocatedBalance(address) external pure returns (uint256) {
        return 0;
    }

    receive() external payable {}
}

contract LegiblePoolReentrancyTest is LegibleReviewBase {
    using PoolIdLibrary for PoolKey;

    ReentrantLossRewardPool mockPool;
    IncentifiLaunchToken tokenA;
    IncentifiLaunchToken tokenB;
    PoolKey keyA;
    PoolKey keyB;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));
        mockPool = new ReentrantLossRewardPool(POOL_MANAGER);
        vm.deal(address(mockPool), 1 ether);
        deployTrio(address(mockPool));
        (tokenA, keyA) = launch("A", "AAA");
        (tokenB, keyB) = launch("B", "BBB");
        vm.deal(buyer, 100 ether);
    }

    function test_Review3_HookOperationFlagIsPerPool() public {
        mockPool.arm(keyB);
        vm.recordLogs();
        botBuy(keyA, tokenA, buyer, 8 ether); // graduates A; mockPool re-enters and buys B mid-graduation
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(hook.tokenStates(keyA.toId()).graduated, "A graduated");
        assertFalse(mockPool.armed(), "the reentrant swap on B ran");

        bytes32 idB = PoolId.unwrap(keyB.toId());
        bool sawSwapB;
        bool sawBoughtB;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(POOL_MANAGER) && logs[i].topics[0] == PM_SWAP_TOPIC && logs[i].topics[1] == idB) {
                (,,,,, uint24 fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                assertEq(fee, hook.PRE_GRADUATION_FEE_PIPS(), "B's swap during A's graduation is charged the normal 2%");
                sawSwapB = true;
            }
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == BOUGHT_TOPIC && logs[i].topics[1] == idB) sawBoughtB = true;
        }
        assertTrue(sawSwapB, "Swap on B observed");
        assertTrue(sawBoughtB, "Bought on B emitted (a global flag would have silenced it)");
        assertGt(tokenB.balanceOf(address(mockPool)), 0, "B tokens delivered to the reentrant caller");
    }
}
