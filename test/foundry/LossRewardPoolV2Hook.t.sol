// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

import {LegibleReviewBase} from "./LegiblePoolReview.t.sol";
import {IncentifiV4LegibleFactory} from "../../contracts/v4/legible/IncentifiV4LegibleFactory.sol";
import {LossRewardPool} from "../../contracts/LossRewardPool.sol";
import {LossRewardPoolV2} from "../../contracts/loss-reward/LossRewardPoolV2.sol";
import {RewardSwapperUniswapV3} from "../../contracts/loss-reward/RewardSwapperUniswapV3.sol";
import {ILossRewardPoolV2} from "../../contracts/loss-reward/interfaces/ILossRewardPoolV2.sol";
import {IRobinhoodStock} from "../../contracts/loss-reward/interfaces/IRobinhoodStock.sol";
import {IncentifiLaunchToken} from "../../contracts/IncentifiLaunchToken.sol";

/**
 * LossRewardPoolV2 wired to the real launch path (legible hook + factory + converter, PR #17):
 *   - factory.launchToken(token, AAPL) against V2 records the asset; against V1 it reverts
 *   - fees collected by the hook land in V2 as depositReward; a stock claim then pays AAPL and
 *     the creator's ETH pull-payment is untouched
 *
 * Run: forge test --match-path test/foundry/LossRewardPoolV2Hook.t.sol -vv
 */
contract LossRewardPoolV2HookTest is LegibleReviewBase {
    using PoolIdLibrary for PoolKey;

    address constant STOCK_FACTORY = 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046;
    address constant ACCESS_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address constant AAPL_POOL = 0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f;
    bytes32 constant REWARD_PAID_TOPIC = keccak256("RewardPaid(address,address,uint256,address,uint256)");

    LossRewardPoolV2 v2;
    RewardSwapperUniswapV3 swapper;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));
        v2 = new LossRewardPoolV2(address(this), STOCK_FACTORY, ACCESS_REGISTRY);
        swapper = new RewardSwapperUniswapV3(address(v2), WETH, V3_FACTORY);
        v2.setAssetRoute(
            AAPL, ILossRewardPoolV2.AssetRoute({swapper: address(swapper), pool: AAPL_POOL, fee: 500, twapWindow: 1800, maxDeviationBps: 300, enabled: true})
        );
        v2.setMinStockReward(0.002 ether);
        deployTrio(address(v2));
        v2.setAssetSetter(address(factory), true);
        vm.deal(buyer, 100 ether);
    }

    function _newToken(string memory sym) internal returns (IncentifiLaunchToken t) {
        vm.startPrank(creator);
        t = new IncentifiLaunchToken(sym, sym, SUPPLY);
        t.approve(address(factory), SUPPLY);
        vm.stopPrank();
    }

    function test_FactoryLaunchWithRewardAsset_AgainstV2_SetsIt() public {
        IncentifiLaunchToken t = _newToken("APL");
        vm.prank(creator);
        factory.launchToken(address(t), AAPL);
        (address asset, bool set, bool forced) = v2.rewardAsset(address(t));
        assertEq(asset, AAPL);
        assertTrue(set);
        assertFalse(forced);

        // V2's own validation is surfaced by the factory: MSFT has no route yet
        IncentifiLaunchToken m = _newToken("MSF");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ILossRewardPoolV2.AssetNotSelectable.selector, MSFT));
        factory.launchToken(address(m), MSFT);

        // only the factory can set: the creator cannot bypass it, nor can a stranger
        vm.prank(creator);
        vm.expectRevert(ILossRewardPoolV2.NotAssetSetter.selector);
        v2.setRewardAsset(address(m), AAPL);
        vm.prank(stranger);
        vm.expectRevert(ILossRewardPoolV2.NotAssetSetter.selector);
        v2.setRewardAsset(address(t), address(0));
    }

    function test_FactoryLaunchWithRewardAsset_AgainstV1_Reverts() public {
        LossRewardPool v1 = new LossRewardPool(address(this));
        hook.setLossRewardPool(address(v1));
        IncentifiLaunchToken t = _newToken("APL");
        vm.prank(creator);
        vm.expectRevert(IncentifiV4LegibleFactory.StockRewardsNotAvailable.selector);
        factory.launchToken(address(t), AAPL);
        // ETH still launches fine against V1
        vm.prank(creator);
        factory.launchToken(address(t), address(0));
        assertTrue(factory.isLaunched(address(t)));
    }

    function test_HookFeesFundV2_StockClaim_CreatorEthUntouched() public {
        IncentifiLaunchToken t = _newToken("APL");
        vm.prank(creator);
        factory.launchToken(address(t), AAPL);
        PoolKey memory k = factory.getPoolKey(address(t));

        botBuy(k, t, buyer, 2 ether);
        hook.collect(address(t));
        uint256 deposited = v2.totalDeposited(address(t));
        assertApproxEqAbs(deposited, 0.02 ether, 1e6, "1% of 2 ETH deposited into V2 by the hook");
        uint256 creatorEth = hook.creatorBalances(creator);
        assertApproxEqAbs(creatorEth, 0.02 ether, 1e6, "creator's 1% sits in the hook");

        // operator publishes an epoch for the buyer (this test is the operator)
        uint256 reward = 0.01 ether;
        bytes32 l = keccak256(bytes.concat(keccak256(abi.encode(address(t), uint256(1), buyer, reward))));
        v2.setEpochMerkleRoot(address(t), 1, l, reward);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory amts = new uint256[](1);
        amts[0] = reward;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);
        uint256 buyerEth = buyer.balance;
        vm.recordLogs();
        vm.prank(buyer);
        v2.claimBatchAs(address(t), ids, amts, proofs, 0, block.timestamp + 600);
        (Vm.Log memory paid, bool ok) = findLog(vm.getRecordedLogs(), address(v2), REWARD_PAID_TOPIC);
        assertTrue(ok);
        assertEq(address(uint160(uint256(paid.topics[3]))), AAPL);
        (uint256 ethAmount, uint256 assetAmount) = abi.decode(paid.data, (uint256, uint256));
        assertEq(ethAmount, reward);
        assertEq(IRobinhoodStock(AAPL).balanceOf(buyer), assetAmount, "buyer received AAPL");
        assertGt(assetAmount, 0);
        assertEq(buyer.balance, buyerEth, "no ETH paid on the stock path");
        assertEq(v2.totalClaimed(address(t)), reward);
        assertEq(address(v2).balance, deposited - reward);
        assertEq(hook.creatorBalances(creator), creatorEth, "creator ETH unaffected by the claim");
        assertEq(IRobinhoodStock(AAPL).balanceOf(address(v2)), 0);
        assertEq(IRobinhoodStock(AAPL).balanceOf(address(swapper)), 0);
        assertEq(IRobinhoodStock(AAPL).balanceOf(address(hook)), 0);
        // and the creator can still pull their ETH
        uint256 before = creator.balance;
        vm.prank(creator);
        hook.claimCreatorFees();
        assertEq(creator.balance - before, creatorEth);
    }
}
