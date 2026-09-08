// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {LossRewardPool} from "../../contracts/LossRewardPool.sol";
import {LossRewardPoolV2} from "../../contracts/loss-reward/LossRewardPoolV2.sol";
import {RewardSwapperUniswapV3} from "../../contracts/loss-reward/RewardSwapperUniswapV3.sol";
import {ILossRewardPoolV2} from "../../contracts/loss-reward/interfaces/ILossRewardPoolV2.sol";
import {SetOperator} from "../../script/SetOperator.s.sol";
import {SetAssetEnabled} from "../../script/SetAssetEnabled.s.sol";

/**
 * The two owner scripts from the 2026-09-08 audit remediation, on a Robinhood mainnet fork with
 * fresh pools owned by forge's default broadcast sender (vm.startBroadcast() in a test sends from
 * it; pranks and broadcasts cannot be combined):
 *   - SetOperator: both pools move to the new operator, refuses the owner / zero address, idempotent
 *   - SetAssetEnabled: disables and re-enables routes, skips already-in-state, reverts on no route,
 *     and a disabled asset is no longer selectable
 */
contract AuditOwnerScriptsTest is Test {
    address constant BROADCAST_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;
    address constant STOCK_FACTORY = 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046;
    address constant ACCESS_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant AAPL_POOL = 0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant TSLA_POOL = 0xA953CA88ff430e9487c60cA34d757414f4efdA07;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    LossRewardPool v1;
    LossRewardPoolV2 v2;
    RewardSwapperUniswapV3 swapper;
    address newOperator = makeAddr("new-operator");

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));
        vm.roll(block.number + 1);
        vm.startPrank(BROADCAST_SENDER);
        v1 = new LossRewardPool(BROADCAST_SENDER);
        v2 = new LossRewardPoolV2(BROADCAST_SENDER, STOCK_FACTORY, ACCESS_REGISTRY);
        swapper = new RewardSwapperUniswapV3(address(v2), WETH, V3_FACTORY);
        v2.setAssetRoute(AAPL, ILossRewardPoolV2.AssetRoute({swapper: address(swapper), pool: AAPL_POOL, fee: 500, twapWindow: 1800, maxDeviationBps: 300, enabled: true}));
        v2.setAssetRoute(TSLA, ILossRewardPoolV2.AssetRoute({swapper: address(swapper), pool: TSLA_POOL, fee: 3000, twapWindow: 1800, maxDeviationBps: 300, enabled: true}));
        vm.stopPrank();
        assertEq(v1.owner(), BROADCAST_SENDER);
        assertEq(v2.owner(), BROADCAST_SENDER);
    }

    function test_setOperator_movesBothPools_andIsIdempotent() public {
        assertEq(v1.operator(), BROADCAST_SENDER);
        assertEq(v2.operator(), BROADCAST_SENDER);
        SetOperator s = new SetOperator();
        s.runWith(newOperator, address(v1), address(v2));
        assertEq(v1.operator(), newOperator, "V1 operator moved");
        assertEq(v2.operator(), newOperator, "V2 operator moved");
        assertEq(v1.owner(), BROADCAST_SENDER, "owner untouched");
        assertEq(v2.owner(), BROADCAST_SENDER, "owner untouched");
        // second run: nothing to send, still consistent
        s.runWith(newOperator, address(v1), address(v2));
        assertEq(v1.operator(), newOperator);
        // the new operator can publish, the old one cannot
        vm.prank(newOperator);
        v2.setEpochMerkleRoot(address(0xBEEF), 1, bytes32(uint256(1)), 0);
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        v2.setEpochMerkleRoot(address(0xBEEF), 2, bytes32(uint256(1)), 0);
    }

    function test_setOperator_nonOwnerSenderReverts() public {
        // pools owned by someone else: the broadcast sender is not their owner -> the pool reverts
        vm.startPrank(address(0xABCD));
        LossRewardPoolV2 other = new LossRewardPoolV2(address(0xABCD), STOCK_FACTORY, ACCESS_REGISTRY);
        LossRewardPool otherV1 = new LossRewardPool(address(0xABCD));
        vm.stopPrank();
        SetOperator s = new SetOperator();
        vm.expectRevert();
        s.runWith(newOperator, address(otherV1), address(other));
        assertEq(other.operator(), address(0xABCD), "nothing changed");
    }

    function test_setOperator_refusesOwnerAndZero() public {
        SetOperator s = new SetOperator();
        vm.expectRevert(abi.encodeWithSelector(SetOperator.NewOperatorIsOwner.selector, BROADCAST_SENDER));
        s.runWith(BROADCAST_SENDER, address(v1), address(v2));
        vm.expectRevert(SetOperator.ZeroAddress.selector);
        s.runWith(address(0), address(v1), address(v2));
        assertEq(v1.operator(), BROADCAST_SENDER, "nothing changed");
    }

    function test_setAssetEnabled_disable_reenable_skip_revert() public {
        assertTrue(v2.isSelectableAsset(AAPL));
        assertTrue(v2.isSelectableAsset(TSLA));
        SetAssetEnabled s = new SetAssetEnabled();
        address[] memory assets = new address[](2);
        assets[0] = AAPL;
        assets[1] = TSLA;
        s.runWith(address(v2), assets, false);
        assertFalse(v2.assetRoute(AAPL).enabled);
        assertFalse(v2.isSelectableAsset(AAPL), "disabled -> not selectable for new launches");
        assertFalse(v2.isSelectableAsset(TSLA));
        // idempotent: already disabled -> skipped, no revert
        s.runWith(address(v2), assets, false);
        // re-enable only AAPL
        address[] memory one = new address[](1);
        one[0] = AAPL;
        s.runWith(address(v2), one, true);
        assertTrue(v2.isSelectableAsset(AAPL));
        assertFalse(v2.isSelectableAsset(TSLA));
        // no route -> reverts before any change
        address[] memory none = new address[](1);
        none[0] = NVDA;
        vm.expectRevert(abi.encodeWithSelector(SetAssetEnabled.NoRoute.selector, NVDA));
        s.runWith(address(v2), none, false);
    }
}
