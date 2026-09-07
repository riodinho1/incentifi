// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

import {LegibleReviewBase} from "./LegiblePoolReview.t.sol";
import {IncentifiV4LegibleHook} from "../../contracts/v4/legible/IncentifiV4LegibleHook.sol";
import {IncentifiV4LegibleFactory} from "../../contracts/v4/legible/IncentifiV4LegibleFactory.sol";
import {LossRewardPool} from "../../contracts/LossRewardPool.sol";
import {IncentifiLaunchToken} from "../../contracts/IncentifiLaunchToken.sol";

/**
 * PR #17 pre-merge additions — "make a one-shot pointer changeable":
 *   1. hook.setLossRewardPool(address): owner-only, target must have code, emits, no timelock;
 *      the fee converter follows the pointer (it reads hook.lossRewardPool() at deposit time).
 *   2. factory.launchToken(token, rewardAsset): address(0) = ETH; the factory calls
 *      setRewardAsset on whatever pool the hook points at. Against the V1 pool that is a no-op
 *      for ETH and StockRewardsNotAvailable for a stock; against a V2-shaped pool the asset is set.
 *
 * Run: forge test --match-path test/foundry/LegibleRepointAndRewardAsset.t.sol -vv
 */

/// @dev Minimal stand-in for LossRewardPoolV2's launch-time surface. Mirrors V2's authorisation:
///      only registered setters, write-once, only selectable assets.
contract MockLossRewardPoolV2 {
    address public immutable acceptedAsset;
    mapping(address => bool) public assetSetters;
    mapping(address => address) public rewardAsset;
    mapping(address => bool) public assetSet;
    mapping(address => uint256) public totalDeposited;

    event RewardAssetSet(address indexed token, address indexed asset, address indexed setter);

    error NotAssetSetter();
    error RewardAssetAlreadySet(address token);
    error AssetNotSelectable(address asset);

    constructor(address _acceptedAsset) {
        acceptedAsset = _acceptedAsset;
    }

    function setAssetSetter(address setter, bool allowed) external {
        assetSetters[setter] = allowed;
    }

    function setRewardAsset(address token, address asset) external {
        if (!assetSetters[msg.sender]) revert NotAssetSetter();
        if (assetSet[token]) revert RewardAssetAlreadySet(token);
        if (asset != address(0) && asset != acceptedAsset) revert AssetNotSelectable(asset);
        rewardAsset[token] = asset;
        assetSet[token] = true;
        emit RewardAssetSet(token, asset, msg.sender);
    }

    function depositReward(address token) external payable {
        totalDeposited[token] += msg.value;
    }
}

contract LegibleRepointAndRewardAssetTest is LegibleReviewBase {
    using PoolIdLibrary for PoolKey;

    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    bytes32 constant REWARD_ASSET_SET_TOPIC = keccak256("RewardAssetSet(address,address,address)");
    bytes32 constant POOL_UPDATED_TOPIC = keccak256("LossRewardPoolUpdated(address,address)");

    LossRewardPool v1;
    MockLossRewardPoolV2 v2;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));
        v1 = new LossRewardPool(address(this));
        deployTrio(address(v1));
        v2 = new MockLossRewardPoolV2(AAPL);
        vm.deal(buyer, 100 ether);
    }

    function _newToken(string memory sym) internal returns (IncentifiLaunchToken t) {
        vm.startPrank(creator);
        t = new IncentifiLaunchToken(sym, sym, SUPPLY);
        t.approve(address(factory), SUPPLY);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------
    // 2. launchToken(token, rewardAsset)
    // ---------------------------------------------------------------------------------------
    function test_LaunchEthAgainstV1Succeeds_bothSignatures() public {
        IncentifiLaunchToken a = _newToken("ETHA");
        vm.prank(creator);
        factory.launchToken(address(a));
        assertTrue(factory.isLaunched(address(a)));

        IncentifiLaunchToken b = _newToken("ETHB");
        vm.prank(creator);
        factory.launchToken(address(b), address(0));
        assertTrue(factory.isLaunched(address(b)), "explicit ETH against V1 is a no-op, launch proceeds");
    }

    function test_LaunchStockAgainstV1Reverts() public {
        IncentifiLaunchToken t = _newToken("STK");
        vm.prank(creator);
        vm.expectRevert(IncentifiV4LegibleFactory.StockRewardsNotAvailable.selector);
        factory.launchToken(address(t), AAPL);
        assertFalse(factory.isLaunched(address(t)), "whole launch reverted, nothing half-launched");
        assertEq(t.balanceOf(creator), SUPPLY, "supply never left the creator");
    }

    function test_LaunchStockAgainstV2SetsAsset() public {
        hook.setLossRewardPool(address(v2));
        v2.setAssetSetter(address(factory), true);

        IncentifiLaunchToken t = _newToken("APL");
        vm.recordLogs();
        vm.prank(creator);
        factory.launchToken(address(t), AAPL);
        assertEq(v2.rewardAsset(address(t)), AAPL, "asset recorded on the V2 pool");
        assertTrue(v2.assetSet(address(t)));
        (Vm.Log memory set, bool ok) = findLog(vm.getRecordedLogs(), address(v2), REWARD_ASSET_SET_TOPIC);
        assertTrue(ok);
        assertEq(address(uint160(uint256(set.topics[1]))), address(t));
        assertEq(address(uint160(uint256(set.topics[2]))), AAPL);
        assertEq(address(uint160(uint256(set.topics[3]))), address(factory), "setter is the factory");

        // ETH is recorded too (write-once for every launched token)
        IncentifiLaunchToken e = _newToken("ETH0");
        vm.prank(creator);
        factory.launchToken(address(e), address(0));
        assertTrue(v2.assetSet(address(e)));
        assertEq(v2.rewardAsset(address(e)), address(0));

        // V2's own rejection is surfaced verbatim, not masked as StockRewardsNotAvailable
        IncentifiLaunchToken x = _newToken("TSL");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MockLossRewardPoolV2.AssetNotSelectable.selector, TSLA));
        factory.launchToken(address(x), TSLA);
    }

    function test_NonFactoryCannotSetAsset() public {
        hook.setLossRewardPool(address(v2));
        v2.setAssetSetter(address(factory), true);
        IncentifiLaunchToken t = _newToken("APL");

        vm.prank(stranger);
        vm.expectRevert(MockLossRewardPoolV2.NotAssetSetter.selector);
        v2.setRewardAsset(address(t), AAPL);

        vm.prank(creator); // even the creator cannot set it directly — only through their own launch
        vm.expectRevert(MockLossRewardPoolV2.NotAssetSetter.selector);
        v2.setRewardAsset(address(t), AAPL);

        vm.prank(creator);
        factory.launchToken(address(t), address(0));
        // and the factory cannot be made to write twice: the token is launched, the pool is write-once
        vm.prank(creator);
        vm.expectRevert(IncentifiV4LegibleFactory.AlreadyLaunched.selector);
        factory.launchToken(address(t), AAPL);
        assertEq(v2.rewardAsset(address(t)), address(0), "creator of a launched token cannot change its asset");
    }

    // ---------------------------------------------------------------------------------------
    // 1. setLossRewardPool
    // ---------------------------------------------------------------------------------------
    function test_SetLossRewardPool_authAndTarget() public {
        vm.prank(stranger);
        vm.expectRevert(IncentifiV4LegibleHook.OnlyOwner.selector);
        hook.setLossRewardPool(address(v2));

        vm.expectRevert(IncentifiV4LegibleHook.ZeroAddress.selector);
        hook.setLossRewardPool(address(0));

        vm.expectRevert(abi.encodeWithSelector(IncentifiV4LegibleHook.PoolMustBeAContract.selector, stranger));
        hook.setLossRewardPool(stranger);

        vm.recordLogs();
        hook.setLossRewardPool(address(v2));
        assertEq(hook.lossRewardPool(), address(v2));
        (Vm.Log memory upd, bool ok) = findLog(vm.getRecordedLogs(), address(hook), POOL_UPDATED_TOPIC);
        assertTrue(ok);
        assertEq(address(uint160(uint256(upd.topics[1]))), address(v1));
        assertEq(address(uint160(uint256(upd.topics[2]))), address(v2));
        assertEq(converter.lossRewardPool(), address(v2), "converter follows the hook pointer");
    }

    function test_SetLossRewardPool_depositsFollowPointer_hookAndConverter() public {
        (token, key) = launch("Repoint", "RPT");
        poolId = key.toId();

        // before: fees land in V1
        botBuy(key, token, buyer, 1 ether);
        hook.collect(address(token));
        uint256 v1Before = v1.totalDeposited(address(token));
        assertApproxEqAbs(v1Before, 0.01 ether, 1e6, "1% of 1 ETH into V1 before the re-point");

        hook.setLossRewardPool(address(v2));

        // after: hook deposits go to V2, V1 untouched
        botBuy(key, token, buyer, 1 ether);
        hook.collect(address(token));
        assertEq(v1.totalDeposited(address(token)), v1Before, "V1 receives nothing after the re-point");
        assertApproxEqAbs(v2.totalDeposited(address(token)), 0.01 ether, 1e6, "hook deposit went to V2");

        // ...and so do the converter's (token-side fees sold back to ETH)
        uint256 v2Before = v2.totalDeposited(address(token));
        botSell(key, token, buyer, token.balanceOf(buyer) / 10);
        hook.collect(address(token));
        assertGt(converter.pendingTokenFees(address(token)), 0);
        vm.roll(block.number + 1);
        converter.convert(address(token), 0, 0);
        assertGt(v2.totalDeposited(address(token)), v2Before, "converter deposit went to V2");
        assertEq(v1.totalDeposited(address(token)), v1Before, "still nothing new in V1");
    }
}
