// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";

import {LossRewardPool} from "../../contracts/LossRewardPool.sol";
import {LossRewardPoolV2} from "../../contracts/loss-reward/LossRewardPoolV2.sol";
import {RewardSwapperUniswapV3} from "../../contracts/loss-reward/RewardSwapperUniswapV3.sol";
import {ILossRewardPoolV2} from "../../contracts/loss-reward/interfaces/ILossRewardPoolV2.sol";
import {IRewardSwapper} from "../../contracts/loss-reward/interfaces/IRewardSwapper.sol";
import {IRobinhoodStock, IRobinhoodStockFactory, IRobinhoodAccessControlsRegistry} from "../../contracts/loss-reward/interfaces/IRobinhoodStock.sol";
import {IUniswapV3PoolMinimal, IWETH9} from "../../contracts/loss-reward/interfaces/IUniswapV3Minimal.sol";

/**
 * LossRewardPoolV2 on a Robinhood mainnet fork: real StockFactory / access registry / stock tokens /
 * Uniswap V3 WETH pools. The test contract plays the operator and the launch factory (asset setter).
 *
 * Run: forge test --match-path test/foundry/LossRewardPoolV2.t.sol -vv
 */
abstract contract V2Base is Test {
    address constant STOCK_FACTORY = 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046;
    address constant ACCESS_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address constant FAKE_AAPL = 0x6aD03BEB497caAa5c559d247500165c8F11d1e18; // "AAPL" not from the factory
    address constant AAPL_POOL = 0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f;
    address constant TSLA_POOL = 0xA953CA88ff430e9487c60cA34d757414f4efdA07;
    address constant NVDA_POOL = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C;

    bytes32 constant REWARD_PAID_TOPIC = keccak256("RewardPaid(address,address,uint256,address,uint256)");
    bytes32 constant FALLBACK_TOPIC = keccak256("RewardPaidInEthFallback(address,address,address,uint8,bytes)");
    bytes32 constant REWARD_CLAIMED_TOPIC = keccak256("RewardClaimed(address,uint256,address,uint256)");

    LossRewardPoolV2 pool;
    RewardSwapperUniswapV3 swapper;

    address tokenEth = address(0xE1E1);
    address tokenAapl = address(0xA1A1);
    address tokenTsla = address(0xB1B1);
    address user = makeAddr("user");
    address user2 = makeAddr("user2");
    address stranger = makeAddr("stranger");

    uint256 constant MIN_STOCK = 0.002 ether;

    function _deployV2() internal {
        pool = new LossRewardPoolV2(address(this), STOCK_FACTORY, ACCESS_REGISTRY);
        swapper = new RewardSwapperUniswapV3(address(pool), WETH, V3_FACTORY);
        _route(AAPL, AAPL_POOL, 500);
        _route(TSLA, TSLA_POOL, 3000);
        _route(NVDA, NVDA_POOL, 500);
        pool.setAssetSetter(address(this), true); // this test plays the launch factory
        pool.setMinStockReward(MIN_STOCK);
        pool.setRewardAsset(tokenEth, address(0));
        pool.setRewardAsset(tokenAapl, AAPL);
        pool.setRewardAsset(tokenTsla, TSLA);
    }

    function _route(address asset, address v3Pool, uint24 fee) internal {
        pool.setAssetRoute(
            asset,
            ILossRewardPoolV2.AssetRoute({swapper: address(swapper), pool: v3Pool, fee: fee, twapWindow: 1800, maxDeviationBps: 300, enabled: true})
        );
    }

    // ---- Merkle helpers (leaf format identical to V1 / the worker) ----
    function leaf(address token, uint256 epochId, address claimant, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount))));
    }

    function pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function publish1(address token, uint256 epochId, address claimant, uint256 amount) internal {
        pool.setEpochMerkleRoot(token, epochId, leaf(token, epochId, claimant, amount), amount);
    }

    /// @dev Two-leaf tree; the proof for each claimant is the other leaf.
    function publish2(address token, uint256 epochId, address c1, uint256 a1, address c2, uint256 a2, uint256 allocated) internal {
        pool.setEpochMerkleRoot(token, epochId, pair(leaf(token, epochId, c1, a1), leaf(token, epochId, c2, a2)), allocated);
    }

    function one(uint256 v) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = v;
    }

    function noProof() internal pure returns (bytes32[][] memory p) {
        p = new bytes32[][](1);
        p[0] = new bytes32[](0);
    }

    function claimAs(address who, address token, uint256 epochId, uint256 amount, uint256 minOut) internal {
        vm.prank(who);
        pool.claimBatchAs(token, one(epochId), one(amount), noProof(), minOut, block.timestamp + 600);
    }

    function findLog(Vm.Log[] memory logs, address emitter, bytes32 topic0) internal pure returns (Vm.Log memory found, bool ok) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic0) return (logs[i], true);
        }
    }

    function fallbackReason(Vm.Log[] memory logs) internal view returns (bool found, ILossRewardPoolV2.FallbackReason reason) {
        (Vm.Log memory l, bool ok) = findLog(logs, address(pool), FALLBACK_TOPIC);
        if (!ok) return (false, ILossRewardPoolV2.FallbackReason.ForcedEth);
        (uint8 r,) = abi.decode(l.data, (uint8, bytes));
        return (true, ILossRewardPoolV2.FallbackReason(r));
    }

    function rewardPaid(Vm.Log[] memory logs) internal view returns (uint256 ethAmount, address asset, uint256 assetAmount) {
        (Vm.Log memory l, bool ok) = findLog(logs, address(pool), REWARD_PAID_TOPIC);
        require(ok, "no RewardPaid");
        asset = address(uint160(uint256(l.topics[3])));
        (ethAmount, assetAmount) = abi.decode(l.data, (uint256, uint256));
    }

    function assertNoCustody() internal view {
        assertEq(IRobinhoodStock(AAPL).balanceOf(address(pool)), 0, "pool holds no AAPL");
        assertEq(IRobinhoodStock(TSLA).balanceOf(address(pool)), 0, "pool holds no TSLA");
        assertEq(IRobinhoodStock(AAPL).balanceOf(address(swapper)), 0, "adapter holds no AAPL");
        assertEq(IRobinhoodStock(TSLA).balanceOf(address(swapper)), 0, "adapter holds no TSLA");
        assertEq(IWETH9(WETH).balanceOf(address(swapper)), 0, "adapter holds no WETH");
        assertEq(address(swapper).balance, 0, "adapter holds no ETH");
        assertEq(IWETH9(WETH).balanceOf(address(pool)), 0, "pool holds no WETH");
    }

    function assertInvariant() internal view {
        uint256 expected = (pool.totalDeposited(tokenEth) - pool.totalClaimed(tokenEth)) + (pool.totalDeposited(tokenAapl) - pool.totalClaimed(tokenAapl))
            + (pool.totalDeposited(tokenTsla) - pool.totalClaimed(tokenTsla));
        assertEq(address(pool).balance, expected, "balance == sum(deposited - claimed)");
    }

    function protocolFloorFor(address v3Pool, uint256 ethIn) internal view returns (uint256 refOut, uint256 floor) {
        bool ok;
        (refOut, ok) = swapper.referenceOut(v3Pool, 1800, ethIn);
        assertTrue(ok, "reference available");
        floor = refOut * (10_000 - 300) / 10_000;
    }
}

/// @dev Re-enters the pool from receive(); `swallow` decides whether the inner failure is propagated.
contract ReentrantClaimant {
    LossRewardPoolV2 immutable pool;
    address immutable token;
    bool public swallow;
    bytes public innerError;
    uint256 public entries;

    constructor(LossRewardPoolV2 _pool, address _token) {
        pool = _pool;
        token = _token;
    }

    function setSwallow(bool s) external {
        swallow = s;
    }

    function claim(uint256 epochId, uint256 amount) external {
        uint256[] memory ids = new uint256[](1);
        ids[0] = epochId;
        uint256[] memory amts = new uint256[](1);
        amts[0] = amount;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);
        pool.claimBatchAs(token, ids, amts, proofs, 0, block.timestamp + 600);
    }

    receive() external payable {
        entries++;
        if (entries > 1) return;
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory amts = new uint256[](1);
        amts[0] = msg.value;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);
        try pool.claimBatchAs(token, ids, amts, proofs, 0, block.timestamp + 600) {
            revert("re-entry succeeded");
        } catch (bytes memory err) {
            innerError = err;
            if (!swallow) revert("propagate");
        }
    }
}

contract LossRewardPoolV2Test is V2Base {
    LossRewardPool v1;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));
        v1 = new LossRewardPool(address(this));
        _deployV2();
        vm.deal(address(this), 200 ether);
    }

    receive() external payable {}

    // ---------------------------------------------------------------------------------------
    // ETH reward: byte-for-byte parity with V1
    // ---------------------------------------------------------------------------------------
    function test_EthClaim_ParityWithV1() public {
        v1.depositReward{value: 1 ether}(tokenEth);
        pool.depositReward{value: 1 ether}(tokenEth);
        uint256 amount = 0.05 ether;
        bytes32 root = leaf(tokenEth, 1, user, amount);
        v1.setEpochMerkleRoot(tokenEth, 1, root, amount);
        pool.setEpochMerkleRoot(tokenEth, 1, root, amount);
        assertEq(v1.epochMerkleRoots(tokenEth, 1), pool.epochMerkleRoots(tokenEth, 1));

        uint256 before = user.balance;
        vm.recordLogs();
        vm.prank(user);
        v1.claimBatch(tokenEth, one(1), one(amount), noProof());
        (Vm.Log memory c1,) = findLog(vm.getRecordedLogs(), address(v1), REWARD_CLAIMED_TOPIC);
        uint256 afterV1 = user.balance;

        vm.recordLogs();
        vm.prank(user);
        pool.claimBatch(tokenEth, one(1), one(amount), noProof());
        (Vm.Log memory c2,) = findLog(vm.getRecordedLogs(), address(pool), REWARD_CLAIMED_TOPIC);

        assertEq(afterV1 - before, amount);
        assertEq(user.balance - afterV1, amount, "V2 pays the same ETH");
        assertEq(c1.topics[1], c2.topics[1]);
        assertEq(c1.topics[2], c2.topics[2]);
        assertEq(c1.topics[3], c2.topics[3]);
        assertEq(keccak256(c1.data), keccak256(c2.data), "RewardClaimed identical");
        assertEq(v1.hasClaimed(tokenEth, 1, user), pool.hasClaimed(tokenEth, 1, user));
        assertEq(v1.totalClaimed(tokenEth), pool.totalClaimed(tokenEth));
        assertEq(v1.getUnallocatedBalance(tokenEth), pool.getUnallocatedBalance(tokenEth));
        // V1-signature single claim also unchanged
        publish1(tokenEth, 2, user, amount);
        vm.prank(user);
        pool.claimReward(tokenEth, 2, amount, new bytes32[](0));
        assertTrue(pool.hasClaimed(tokenEth, 2, user));
        assertInvariant();
    }

    // ---------------------------------------------------------------------------------------
    // AAPL reward: claim receives AAPL, ETH allocation consumed, nobody but the user holds stock
    // ---------------------------------------------------------------------------------------
    function test_StockClaim_AAPL() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        uint256 amount = 0.05 ether;
        publish1(tokenAapl, 1, user, amount);
        (uint256 refOut,) = protocolFloorFor(AAPL_POOL, amount);
        uint256 userMin = refOut * 99 / 100;

        uint256 poolBefore = address(pool).balance;
        uint256 ethBefore = user.balance;
        vm.recordLogs();
        uint256 g0 = gasleft();
        claimAs(user, tokenAapl, 1, amount, userMin);
        console2.log("gas: claimBatchAs (1 epoch, AAPL)", g0 - gasleft());
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (uint256 ethAmount, address asset, uint256 assetAmount) = rewardPaid(logs);
        assertEq(asset, AAPL);
        assertEq(ethAmount, amount);
        assertGt(assetAmount, userMin);
        assertEq(IRobinhoodStock(AAPL).balanceOf(user), assetAmount, "user received exactly the reported AAPL");
        assertEq(user.balance, ethBefore, "no ETH paid on the stock path");
        assertEq(poolBefore - address(pool).balance, amount, "ETH allocation consumed by the swap");
        assertEq(pool.totalClaimed(tokenAapl), amount);
        assertTrue(pool.hasClaimed(tokenAapl, 1, user));
        (bool fb,) = fallbackReason(logs);
        assertFalse(fb, "no fallback");
        assertNoCustody();
        assertInvariant();

        // gas baseline for the ETH path with the same shape
        pool.depositReward{value: 1 ether}(tokenEth);
        publish1(tokenEth, 1, user, amount);
        g0 = gasleft();
        claimAs(user, tokenEth, 1, amount, 0);
        console2.log("gas: claimBatchAs (1 epoch, ETH)", g0 - gasleft());
    }

    // ---------------------------------------------------------------------------------------
    // Two tokens, two assets, same block: no cross-contamination
    // ---------------------------------------------------------------------------------------
    function test_TwoAssets_SameBlock_NoCrossContamination() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        pool.depositReward{value: 2 ether}(tokenTsla);
        publish1(tokenAapl, 1, user, 0.05 ether);
        publish1(tokenTsla, 1, user, 0.07 ether);

        vm.recordLogs();
        claimAs(user, tokenAapl, 1, 0.05 ether, 0);
        (uint256 e1, address a1, uint256 out1) = rewardPaid(vm.getRecordedLogs());
        vm.recordLogs();
        claimAs(user, tokenTsla, 1, 0.07 ether, 0);
        (uint256 e2, address a2, uint256 out2) = rewardPaid(vm.getRecordedLogs());

        assertEq(a1, AAPL);
        assertEq(a2, TSLA);
        assertEq(e1, 0.05 ether);
        assertEq(e2, 0.07 ether);
        assertEq(IRobinhoodStock(AAPL).balanceOf(user), out1);
        assertEq(IRobinhoodStock(TSLA).balanceOf(user), out2);
        assertEq(pool.totalClaimed(tokenAapl), 0.05 ether);
        assertEq(pool.totalClaimed(tokenTsla), 0.07 ether);
        assertEq(pool.totalDeposited(tokenAapl), 1 ether);
        assertEq(pool.totalDeposited(tokenTsla), 2 ether);
        assertEq(pool.tokenVault(tokenAapl), 0.95 ether);
        assertEq(pool.tokenVault(tokenTsla), 1.93 ether);
        assertNoCustody();
        assertInvariant();
    }

    // ---------------------------------------------------------------------------------------
    // Authorisation and registry validation
    // ---------------------------------------------------------------------------------------
    function test_SetRewardAsset_Authorisation() public {
        address t = address(0xC1C1);
        vm.prank(stranger);
        vm.expectRevert(ILossRewardPoolV2.NotAssetSetter.selector);
        pool.setRewardAsset(t, AAPL);

        pool.setRewardAsset(t, AAPL);
        (address a, bool set, bool forced) = pool.rewardAsset(t);
        assertEq(a, AAPL);
        assertTrue(set);
        assertFalse(forced);

        vm.expectRevert(abi.encodeWithSelector(ILossRewardPoolV2.RewardAssetAlreadySet.selector, t));
        pool.setRewardAsset(t, TSLA); // "creator of A cannot set B's" at the pool: a token's asset is write-once
        vm.expectRevert(abi.encodeWithSelector(ILossRewardPoolV2.RewardAssetAlreadySet.selector, tokenAapl));
        pool.setRewardAsset(tokenAapl, address(0));
    }

    function test_NonRegistryAssetRejected() public {
        address t = address(0xC2C2);
        vm.expectRevert(abi.encodeWithSelector(ILossRewardPoolV2.AssetNotSelectable.selector, FAKE_AAPL));
        pool.setRewardAsset(t, FAKE_AAPL);
        vm.expectRevert(abi.encodeWithSelector(ILossRewardPoolV2.AssetNotSelectable.selector, stranger));
        pool.setRewardAsset(t, stranger);
        vm.expectRevert(abi.encodeWithSelector(ILossRewardPoolV2.AssetNotSelectable.selector, MSFT));
        pool.setRewardAsset(t, MSFT); // canonical but no route (deferred)
        assertFalse(pool.isSelectableAsset(MSFT));
        assertTrue(pool.isSelectableAsset(AAPL));

        // routes: only canonical Uniswap V3 WETH/asset pools, only canonical assets
        ILossRewardPoolV2.AssetRoute memory r = ILossRewardPoolV2.AssetRoute({swapper: address(swapper), pool: TSLA_POOL, fee: 500, twapWindow: 1800, maxDeviationBps: 300, enabled: true});
        vm.expectRevert(ILossRewardPoolV2.InvalidRoute.selector);
        pool.setAssetRoute(AAPL, r); // wrong pool for the asset
        r.pool = AAPL_POOL;
        r.fee = 3000;
        vm.expectRevert(ILossRewardPoolV2.InvalidRoute.selector);
        pool.setAssetRoute(AAPL, r); // wrong fee tier
        r.fee = 500;
        vm.expectRevert(abi.encodeWithSelector(ILossRewardPoolV2.AssetNotSelectable.selector, FAKE_AAPL));
        pool.setAssetRoute(FAKE_AAPL, r);
        vm.prank(stranger);
        vm.expectRevert(ILossRewardPoolV2.Unauthorized.selector);
        pool.setAssetRoute(AAPL, r);
        vm.expectRevert(abi.encodeWithSelector(ILossRewardPoolV2.RouteNotConfigured.selector, MSFT));
        pool.setAssetEnabled(MSFT, true);
    }

    // ---------------------------------------------------------------------------------------
    // Valid at launch, invalid at claim -> ETH fallback + event
    // ---------------------------------------------------------------------------------------
    function test_RegistryInvalidAtClaim_FallsBackToEth() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);
        bytes32 uid = IRobinhoodStock(AAPL).uid();
        vm.mockCall(STOCK_FACTORY, abi.encodeCall(IRobinhoodStockFactory.tokenAddress, (uid)), abi.encode(address(0)));

        uint256 before = user.balance;
        vm.recordLogs();
        claimAs(user, tokenAapl, 1, 0.05 ether, 0);
        (bool fb, ILossRewardPoolV2.FallbackReason reason) = fallbackReason(vm.getRecordedLogs());
        assertTrue(fb);
        assertEq(uint8(reason), uint8(ILossRewardPoolV2.FallbackReason.RegistryMismatch));
        assertEq(user.balance - before, 0.05 ether, "paid in ETH");
        assertEq(IRobinhoodStock(AAPL).balanceOf(user), 0);
        assertNoCustody();
        assertInvariant();
    }

    function test_PausedAtClaim_FallsBackToEth() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);
        vm.mockCall(AAPL, abi.encodeCall(IRobinhoodStock.paused, ()), abi.encode(true));

        uint256 before = user.balance;
        vm.recordLogs();
        claimAs(user, tokenAapl, 1, 0.05 ether, 0);
        (bool fb, ILossRewardPoolV2.FallbackReason reason) = fallbackReason(vm.getRecordedLogs());
        assertTrue(fb);
        assertEq(uint8(reason), uint8(ILossRewardPoolV2.FallbackReason.AssetPaused));
        assertEq(user.balance - before, 0.05 ether);
        // and a paused asset is not selectable for new launches
        vm.expectRevert(abi.encodeWithSelector(ILossRewardPoolV2.AssetNotSelectable.selector, AAPL));
        pool.setRewardAsset(address(0xC3C3), AAPL);
        assertNoCustody();
    }

    function test_ClaimantBlocked_FallsBackToEth() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);
        vm.mockCall(ACCESS_REGISTRY, abi.encodeCall(IRobinhoodAccessControlsRegistry.isBlocked, (user)), abi.encode(true));
        uint256 before = user.balance;
        vm.recordLogs();
        claimAs(user, tokenAapl, 1, 0.05 ether, 0);
        (bool fb, ILossRewardPoolV2.FallbackReason reason) = fallbackReason(vm.getRecordedLogs());
        assertTrue(fb);
        assertEq(uint8(reason), uint8(ILossRewardPoolV2.FallbackReason.ClaimantBlocked));
        assertEq(user.balance - before, 0.05 ether);
        assertNoCustody();
    }

    function test_ThinLiquidity_FallsBackWithoutSwapping() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);
        vm.mockCall(AAPL_POOL, abi.encodeCall(IUniswapV3PoolMinimal.liquidity, ()), abi.encode(uint128(0)));
        uint256 before = user.balance;
        vm.recordLogs();
        claimAs(user, tokenAapl, 1, 0.05 ether, 0);
        (bool fb, ILossRewardPoolV2.FallbackReason reason) = fallbackReason(vm.getRecordedLogs());
        assertTrue(fb);
        assertEq(uint8(reason), uint8(ILossRewardPoolV2.FallbackReason.NoLiquidity));
        assertEq(user.balance - before, 0.05 ether);
        assertEq(IRobinhoodStock(AAPL).balanceOf(user), 0, "no swap attempted");
        assertNoCustody();
    }

    function test_AssetDisabled_FallsBack() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);
        pool.setAssetEnabled(AAPL, false);
        vm.recordLogs();
        claimAs(user, tokenAapl, 1, 0.05 ether, 0);
        (bool fb, ILossRewardPoolV2.FallbackReason reason) = fallbackReason(vm.getRecordedLogs());
        assertTrue(fb);
        assertEq(uint8(reason), uint8(ILossRewardPoolV2.FallbackReason.AssetDisabled));
    }

    // ---------------------------------------------------------------------------------------
    // Bounds: user-binding -> revert; protocol-binding -> fallback; distinguishable
    // ---------------------------------------------------------------------------------------
    function test_UserBoundBinding_RevertsMinOutNotMet() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);
        (uint256 refOut,) = protocolFloorFor(AAPL_POOL, 0.05 ether);
        uint256 userMin = refOut * 2; // above the protocol floor, so the user's bound is the binding one
        vm.prank(user);
        vm.expectPartialRevert(ILossRewardPoolV2.MinOutNotMet.selector);
        pool.claimBatchAs(tokenAapl, one(1), one(0.05 ether), noProof(), userMin, block.timestamp + 600);
        assertFalse(pool.hasClaimed(tokenAapl, 1, user), "whole claim reverted");
        assertEq(pool.totalClaimed(tokenAapl), 0);
        assertEq(IRobinhoodStock(AAPL).balanceOf(user), 0);
        assertNoCustody();
    }

    /// @dev Pushes the AAPL/WETH pool far off its 30-minute TWAP inside this block.
    function _manipulateAapl(uint256 ethIn) internal {
        IWETH9(WETH).deposit{value: ethIn}();
        _expected = AAPL_POOL;
        IUniswapV3PoolMinimal(AAPL_POOL).swap(address(this), true, int256(ethIn), 4295128740, "");
        _expected = address(0);
    }

    address private _expected;

    function uniswapV3SwapCallback(int256 amount0Delta, int256, bytes calldata) external {
        require(msg.sender == _expected, "bad callback");
        IWETH9(WETH).transfer(msg.sender, uint256(amount0Delta));
    }

    function test_ProtocolBoundBinding_FallsBack_and_UserBoundStillReverts() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);
        publish1(tokenAapl, 2, user, 0.05 ether);
        (, uint256 floor) = protocolFloorFor(AAPL_POOL, 0.05 ether);

        _manipulateAapl(60 ether); // spot now well below the TWAP-implied output
        (uint256 refAfter,) = swapper.referenceOut(AAPL_POOL, 1800, 0.05 ether);
        assertApproxEqAbs(refAfter, floor * 10_000 / 9_700, 1, "TWAP unchanged within the block");

        // protocol floor binding (userMin = 0, a buggy frontend): fallback, not a revert
        uint256 before = user.balance;
        vm.recordLogs();
        claimAs(user, tokenAapl, 1, 0.05 ether, 0);
        (bool fb, ILossRewardPoolV2.FallbackReason reason) = fallbackReason(vm.getRecordedLogs());
        assertTrue(fb, "fell back");
        assertEq(uint8(reason), uint8(ILossRewardPoolV2.FallbackReason.BelowProtocolBound));
        assertEq(user.balance - before, 0.05 ether, "paid in ETH");
        assertEq(IRobinhoodStock(AAPL).balanceOf(user), 0, "swap unwound, no stock delivered");
        assertTrue(pool.hasClaimed(tokenAapl, 1, user));

        // user bound binding (userMin > protocol floor): the claim reverts instead
        vm.prank(user);
        vm.expectPartialRevert(ILossRewardPoolV2.MinOutNotMet.selector);
        pool.claimBatchAs(tokenAapl, one(2), one(0.05 ether), noProof(), floor + 1, block.timestamp + 600);
        assertFalse(pool.hasClaimed(tokenAapl, 2, user));
        assertNoCustody();
        assertInvariant();
    }

    // ---------------------------------------------------------------------------------------
    // Minimum reward applies to the BATCH TOTAL
    // ---------------------------------------------------------------------------------------
    function test_MinimumReward_BatchTotal() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        uint256 small = 0.001 ether; // below 0.002 alone
        publish1(tokenAapl, 1, user, small);
        publish1(tokenAapl, 2, user, small);
        publish1(tokenAapl, 3, user, small);

        // one small epoch alone -> ETH (BelowMinimum)
        uint256 before = user.balance;
        vm.recordLogs();
        claimAs(user, tokenAapl, 1, small, 0);
        (bool fb, ILossRewardPoolV2.FallbackReason reason) = fallbackReason(vm.getRecordedLogs());
        assertTrue(fb);
        assertEq(uint8(reason), uint8(ILossRewardPoolV2.FallbackReason.BelowMinimum));
        assertEq(user.balance - before, small);

        // two small epochs combined reach the minimum -> stock
        uint256[] memory ids = new uint256[](2);
        ids[0] = 2;
        ids[1] = 3;
        uint256[] memory amts = new uint256[](2);
        amts[0] = small;
        amts[1] = small;
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = new bytes32[](0);
        proofs[1] = new bytes32[](0);
        vm.recordLogs();
        vm.prank(user);
        pool.claimBatchAs(tokenAapl, ids, amts, proofs, 0, block.timestamp + 600);
        (uint256 eth, address asset, uint256 out) = rewardPaid(vm.getRecordedLogs());
        assertEq(asset, AAPL);
        assertEq(eth, 2 * small);
        assertEq(IRobinhoodStock(AAPL).balanceOf(user), out);
        assertGt(out, 0);
        assertNoCustody();
        assertInvariant();
    }

    // ---------------------------------------------------------------------------------------
    // V1 signatures on a stock token
    // ---------------------------------------------------------------------------------------
    function test_V1Signatures_OnStockToken() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);  // above minimum -> effective payout is AAPL
        publish1(tokenAapl, 2, user, 0.001 ether); // below minimum -> effective payout is ETH anyway

        vm.prank(user);
        vm.expectRevert(ILossRewardPoolV2.UseClaimAs.selector);
        pool.claimBatch(tokenAapl, one(1), one(0.05 ether), noProof());
        vm.prank(user);
        vm.expectRevert(ILossRewardPoolV2.UseClaimAs.selector);
        pool.claimReward(tokenAapl, 1, 0.05 ether, new bytes32[](0));
        assertFalse(pool.hasClaimed(tokenAapl, 1, user));

        uint256 before = user.balance;
        vm.prank(user);
        pool.claimReward(tokenAapl, 2, 0.001 ether, new bytes32[](0)); // below minimum: allowed, pays ETH
        assertEq(user.balance - before, 0.001 ether);

        pool.forceEthPayout(tokenAapl);
        before = user.balance;
        vm.prank(user);
        pool.claimBatch(tokenAapl, one(1), one(0.05 ether), noProof()); // forced: allowed, pays ETH
        assertEq(user.balance - before, 0.05 ether);
        assertInvariant();
    }

    // ---------------------------------------------------------------------------------------
    // Reentrancy
    // ---------------------------------------------------------------------------------------
    function test_Reentrancy_RevertsAndNeverDoublePays() public {
        pool.depositReward{value: 1 ether}(tokenEth);
        ReentrantClaimant attacker = new ReentrantClaimant(pool, tokenEth);
        publish1(tokenEth, 1, address(attacker), 0.05 ether);

        // (a) re-entry failure propagated: the whole claim reverts, nothing paid, nothing marked
        vm.expectRevert(ILossRewardPoolV2.EthTransferFailed.selector);
        attacker.claim(1, 0.05 ether);
        assertFalse(pool.hasClaimed(tokenEth, 1, address(attacker)));
        assertEq(address(attacker).balance, 0);

        // (b) re-entry failure swallowed: paid exactly once, inner call rejected by the guard
        attacker.setSwallow(true);
        attacker.claim(1, 0.05 ether);
        assertEq(address(attacker).balance, 0.05 ether, "paid once");
        assertEq(pool.totalClaimed(tokenEth), 0.05 ether);
        assertEq(bytes4(attacker.innerError()), ILossRewardPoolV2.ReentrancyGuardReentrantCall.selector);
        assertInvariant();
    }

    // ---------------------------------------------------------------------------------------
    // forceEthPayout
    // ---------------------------------------------------------------------------------------
    function test_ForceEthPayout() public {
        vm.prank(stranger);
        vm.expectRevert(ILossRewardPoolV2.Unauthorized.selector);
        pool.forceEthPayout(tokenAapl);

        vm.expectEmit(true, true, false, true, address(pool));
        emit ILossRewardPoolV2.EthPayoutForced(tokenAapl, AAPL);
        pool.forceEthPayout(tokenAapl);
        (address a,, bool forced) = pool.rewardAsset(tokenAapl);
        assertEq(a, AAPL, "the selection is remembered");
        assertTrue(forced);
        assertEq(pool.effectivePayoutAsset(tokenAapl), address(0));

        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);
        uint256 before = user.balance;
        vm.recordLogs();
        claimAs(user, tokenAapl, 1, 0.05 ether, 0);
        (bool fb, ILossRewardPoolV2.FallbackReason reason) = fallbackReason(vm.getRecordedLogs());
        assertTrue(fb);
        assertEq(uint8(reason), uint8(ILossRewardPoolV2.FallbackReason.ForcedEth));
        assertEq(user.balance - before, 0.05 ether);
        // irreversible: there is no function that clears forcedEth; calling again is a no-op
        pool.forceEthPayout(tokenAapl);
        (,, forced) = pool.rewardAsset(tokenAapl);
        assertTrue(forced);
    }

    // ---------------------------------------------------------------------------------------
    // Accounting across a mixed batch
    // ---------------------------------------------------------------------------------------
    function test_Accounting_MixedBatch() public {
        pool.depositReward{value: 1 ether}(tokenEth);
        pool.depositReward{value: 1 ether}(tokenAapl);
        pool.depositReward{value: 1 ether}(tokenTsla);
        publish2(tokenEth, 1, user, 0.03 ether, user2, 0.04 ether, 0.07 ether);
        publish2(tokenAapl, 1, user, 0.05 ether, user2, 0.001 ether, 0.051 ether);
        publish2(tokenTsla, 1, user, 0.06 ether, user2, 0.06 ether, 0.12 ether);

        uint256 ethPaid;
        uint256 ethSwapped;
        vm.recordLogs();
        // ETH token, both users, V1 signature
        vm.prank(user);
        pool.claimBatch(tokenEth, one(1), one(0.03 ether), _proof(leaf(tokenEth, 1, user2, 0.04 ether)));
        vm.prank(user2);
        pool.claimBatch(tokenEth, one(1), one(0.04 ether), _proof(leaf(tokenEth, 1, user, 0.03 ether)));
        // AAPL token: user -> stock; user2 -> below minimum -> ETH
        vm.prank(user);
        pool.claimBatchAs(tokenAapl, one(1), one(0.05 ether), _proof(leaf(tokenAapl, 1, user2, 0.001 ether)), 0, block.timestamp + 600);
        vm.prank(user2);
        pool.claimBatchAs(tokenAapl, one(1), one(0.001 ether), _proof(leaf(tokenAapl, 1, user, 0.05 ether)), 0, block.timestamp + 600);
        // TSLA token: user -> stock; user2 -> paused at claim time -> ETH fallback
        vm.prank(user);
        pool.claimBatchAs(tokenTsla, one(1), one(0.06 ether), _proof(leaf(tokenTsla, 1, user2, 0.06 ether)), 0, block.timestamp + 600);
        vm.mockCall(TSLA, abi.encodeCall(IRobinhoodStock.paused, ()), abi.encode(true));
        vm.prank(user2);
        pool.claimBatchAs(tokenTsla, one(1), one(0.06 ether), _proof(leaf(tokenTsla, 1, user, 0.06 ether)), 0, block.timestamp + 600);
        vm.clearMockedCalls();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 paidCount;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(pool) || logs[i].topics[0] != REWARD_PAID_TOPIC) continue;
            paidCount++;
            address asset = address(uint160(uint256(logs[i].topics[3])));
            (uint256 ethAmount,) = abi.decode(logs[i].data, (uint256, uint256));
            if (asset == address(0)) ethPaid += ethAmount;
            else ethSwapped += ethAmount;
        }
        assertEq(paidCount, 6);
        assertEq(ethPaid, 0.03 ether + 0.04 ether + 0.001 ether + 0.06 ether);
        assertEq(ethSwapped, 0.05 ether + 0.06 ether);
        uint256 claimedAll = pool.totalClaimed(tokenEth) + pool.totalClaimed(tokenAapl) + pool.totalClaimed(tokenTsla);
        assertEq(ethPaid + ethSwapped, claimedAll, "paid + swapped == claimed");
        assertEq(address(pool).balance, 3 ether - claimedAll, "remaining == deposited - (paid + swapped)");
        assertEq(pool.tokenVault(tokenEth), 1 ether - 0.07 ether);
        assertEq(pool.tokenVault(tokenAapl), 1 ether - 0.051 ether);
        assertEq(pool.tokenVault(tokenTsla), 1 ether - 0.12 ether);
        assertGt(IRobinhoodStock(AAPL).balanceOf(user), 0);
        assertGt(IRobinhoodStock(TSLA).balanceOf(user), 0);
        assertEq(IRobinhoodStock(TSLA).balanceOf(user2), 0);
        assertNoCustody();
        assertInvariant();
    }

    function _proof(bytes32 sibling) internal pure returns (bytes32[][] memory p) {
        p = new bytes32[][](1);
        p[0] = new bytes32[](1);
        p[0][0] = sibling;
    }

    // ---------------------------------------------------------------------------------------
    // Strictness: per-epoch cap, bare ETH, deadline, adapter entrypoint
    // ---------------------------------------------------------------------------------------
    function test_EpochOverClaimed_PerTokenAccountingIsEnforced() public {
        pool.depositReward{value: 1 ether}(tokenEth);
        pool.depositReward{value: 1 ether}(tokenAapl);
        // a root whose leaves sum to more than the epoch's allocation (a buggy or hostile worker)
        publish2(tokenEth, 1, user, 0.5 ether, user2, 0.5 ether, 0.5 ether);
        vm.prank(user);
        pool.claimBatch(tokenEth, one(1), one(0.5 ether), _proof(leaf(tokenEth, 1, user2, 0.5 ether)));
        vm.prank(user2);
        vm.expectRevert(ILossRewardPoolV2.EpochOverClaimed.selector);
        pool.claimBatch(tokenEth, one(1), one(0.5 ether), _proof(leaf(tokenEth, 1, user, 0.5 ether)));
        assertEq(pool.tokenVault(tokenAapl), 1 ether, "the other token's ETH is untouchable");
        assertInvariant();
    }

    function test_BareEthRejected() public {
        (bool ok,) = address(pool).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(pool).balance, 0);
    }

    function test_DeadlineExpired() public {
        pool.depositReward{value: 1 ether}(tokenAapl);
        publish1(tokenAapl, 1, user, 0.05 ether);
        vm.prank(user);
        vm.expectRevert(ILossRewardPoolV2.DeadlineExpired.selector);
        pool.claimBatchAs(tokenAapl, one(1), one(0.05 ether), noProof(), 0, block.timestamp - 1);
    }

    function test_AdapterSwapOnlyByPool() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(RewardSwapperUniswapV3.OnlyLossRewardPool.selector);
        swapper.swap{value: 0.01 ether}(AAPL, AAPL_POOL, 0, stranger, block.timestamp + 600);
        (bool ok,) = address(swapper).call{value: 1}("");
        assertFalse(ok, "adapter rejects bare ETH");
    }
}
