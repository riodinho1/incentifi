// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {LossRewardPoolV2} from "../contracts/loss-reward/LossRewardPoolV2.sol";
import {RewardSwapperUniswapV3} from "../contracts/loss-reward/RewardSwapperUniswapV3.sol";
import {ILossRewardPoolV2} from "../contracts/loss-reward/interfaces/ILossRewardPoolV2.sol";

/**
 * Deploys LossRewardPoolV2 + its Uniswap V3 swap adapter and configures the launch allow-list
 * (AAPL, TSLA, NVDA). NOT run as part of this PR. Does NOT touch the hook: re-pointing the hook is
 * a deliberate second action (script/RepointHookLossRewardPool.s.sol).
 *
 * Owner = --sender (hardware-wallet EOA). Operator = OPERATOR (defaults to the live worker key).
 *
 * Usage (dry run first, then broadcast; the operator supplies their own key — never share it):
 *   [OPERATOR=0x...] [ASSET_SETTER=<legible factory>] [MIN_STOCK_REWARD_WEI=2000000000000000] \
 *   forge script script/DeployLossRewardPoolV2.s.sol --rpc-url robinhood --sender <hardware-wallet> [--broadcast --ledger]
 */
contract DeployLossRewardPoolV2 is Script {
    // Robinhood Chain mainnet (chain id 4663) — every address below was verified on-chain in Phase A.
    address constant STOCK_FACTORY = 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046;
    address constant ACCESS_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant UNISWAP_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant DEFAULT_OPERATOR = 0x78a4E4BCC8ab559B6d3B1Cb9eab0A04a2411c726;

    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant AAPL_WETH_POOL = 0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f; // 0.05%
    address constant TSLA_WETH_POOL = 0xA953CA88ff430e9487c60cA34d757414f4efdA07; // 0.30%
    address constant NVDA_WETH_POOL = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C; // 0.05%

    uint32 constant TWAP_WINDOW = 1800;
    uint16 constant MAX_DEVIATION_BPS = 300;

    function run() external {
        address operator = vm.envOr("OPERATOR", DEFAULT_OPERATOR);
        address assetSetter = vm.envOr("ASSET_SETTER", address(0));
        uint256 minStockRewardWei = vm.envOr("MIN_STOCK_REWARD_WEI", uint256(0.002 ether));

        vm.startBroadcast();
        LossRewardPoolV2 pool = new LossRewardPoolV2(operator, STOCK_FACTORY, ACCESS_REGISTRY);
        RewardSwapperUniswapV3 swapper = new RewardSwapperUniswapV3(address(pool), WETH, UNISWAP_V3_FACTORY);
        _route(pool, address(swapper), AAPL, AAPL_WETH_POOL, 500);
        _route(pool, address(swapper), TSLA, TSLA_WETH_POOL, 3000);
        _route(pool, address(swapper), NVDA, NVDA_WETH_POOL, 500);
        if (assetSetter != address(0)) pool.setAssetSetter(assetSetter, true);
        pool.setMinStockReward(minStockRewardWei);
        vm.stopBroadcast();

        require(pool.owner() == msg.sender, "owner mismatch");
        require(pool.operator() == operator, "operator mismatch");
        require(pool.isSelectableAsset(AAPL) && pool.isSelectableAsset(TSLA) && pool.isSelectableAsset(NVDA), "assets not selectable");
        console2.log("LossRewardPoolV2", address(pool));
        console2.log("RewardSwapperUniswapV3", address(swapper));
        console2.log("owner (EOA)", pool.owner());
        console2.log("operator", pool.operator());
        console2.log("assetSetter", assetSetter);
        console2.log("minStockRewardWei", minStockRewardWei);
        console2.log("NEXT (separate, deliberate): script/RepointHookLossRewardPool.s.sol");
    }

    function _route(LossRewardPoolV2 pool, address swapper, address asset, address v3Pool, uint24 fee) internal {
        pool.setAssetRoute(
            asset,
            ILossRewardPoolV2.AssetRoute({
                swapper: swapper, pool: v3Pool, fee: fee, twapWindow: TWAP_WINDOW, maxDeviationBps: MAX_DEVIATION_BPS, enabled: true
            })
        );
    }
}
