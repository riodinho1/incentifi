// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";

import {LossRewardPoolV2} from "../../contracts/loss-reward/LossRewardPoolV2.sol";
import {RewardSwapperUniswapV3} from "../../contracts/loss-reward/RewardSwapperUniswapV3.sol";
import {ILossRewardPoolV2} from "../../contracts/loss-reward/interfaces/ILossRewardPoolV2.sol";
import {ConfigureStockRoutes} from "../../script/ConfigureStockRoutes.s.sol";

/**
 * script/ConfigureStockRoutes.s.sol against the COMMITTED config/loss-reward-stock-routes.json on a
 * Robinhood mainnet fork: every route in the file must pass the adapter's canonical-pool check and the
 * pool's StockFactory round-trip (otherwise the script reverts before broadcasting anything), be
 * selectable afterwards, and a second run must be a no-op (idempotent). A fresh V2 + swapper are
 * deployed by the test owner; the script is invoked as that owner.
 */
contract ConfigureStockRoutesTest is Test {
    address constant STOCK_FACTORY = 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046;
    address constant ACCESS_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    /// forge's default broadcast sender: vm.startBroadcast() inside the script sends from this address in
    /// a test, so the pool is deployed with it as owner (pranks and broadcasts cannot be combined).
    address constant BROADCAST_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    string constant ROUTES_FILE = "config/loss-reward-stock-routes.json";

    LossRewardPoolV2 pool;
    RewardSwapperUniswapV3 swapper;
    string json;
    uint256 count;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));
        vm.roll(block.number + 1);
        vm.prank(BROADCAST_SENDER);
        pool = new LossRewardPoolV2(BROADCAST_SENDER, STOCK_FACTORY, ACCESS_REGISTRY);
        swapper = new RewardSwapperUniswapV3(address(pool), WETH, V3_FACTORY);
        assertEq(pool.owner(), BROADCAST_SENDER);
        json = vm.readFile(ROUTES_FILE);
        count = vm.parseJsonUint(json, ".count");
    }

    function _asset(uint256 i) internal view returns (address) {
        return vm.parseJsonAddress(json, string.concat(".routes[", vm.toString(i), "].asset"));
    }

    function _runAsOwner(ConfigureStockRoutes script) internal {
        // explicit inputs (env vars are process-global and leak between parallel tests); no prank: the
        // script's vm.startBroadcast() makes the pool calls from BROADCAST_SENDER (the owner)
        script.runWith(address(pool), address(swapper), ROUTES_FILE);
    }

    function _assertRouteMatchesFile(uint256 i) internal view returns (address asset, bool selectable) {
        asset = _asset(i);
        ILossRewardPoolV2.AssetRoute memory r = pool.assetRoute(asset);
        assertEq(r.swapper, address(swapper), "swapper");
        assertEq(r.pool, vm.parseJsonAddress(json, string.concat(".routes[", vm.toString(i), "].pool")), "pool");
        assertEq(uint256(r.fee), vm.parseJsonUint(json, string.concat(".routes[", vm.toString(i), "].fee")), "fee");
        assertEq(uint256(r.twapWindow), 1800);
        assertEq(uint256(r.maxDeviationBps), 300);
        assertTrue(r.enabled);
        assertTrue(swapper.validateRoute(asset, r.pool, r.fee), "canonical per adapter");
        selectable = pool.isSelectableAsset(asset);
    }

    function test_configuresEveryCommittedRoute_thenIdempotent() public {
        assertGe(count, 3, "file has at least the three Phase-A routes");
        for (uint256 i = 0; i < count; i++) assertFalse(pool.isSelectableAsset(_asset(i)), "nothing selectable before");

        ConfigureStockRoutes script = new ConfigureStockRoutes();
        _runAsOwner(script);

        uint256 selectable;
        uint256 phaseA;
        for (uint256 i = 0; i < count; i++) {
            (address asset, bool sel) = _assertRouteMatchesFile(i);
            if (sel) selectable++;
            if (asset == AAPL || asset == TSLA || asset == NVDA) phaseA++;
        }
        assertEq(phaseA, 3, "Phase-A assets still routed");
        // every routed asset is selectable unless Robinhood paused it (live condition) - require the vast majority
        assertGe(selectable * 10, count * 9, "at least 90% selectable right now");
        console2.log("routes configured", count);
        console2.log("selectable now", selectable);

        // idempotent: a second run must not change anything (no AssetRouteSet events)
        vm.recordLogs();
        _runAsOwner(script);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 routeSet = keccak256("AssetRouteSet(address,address,address,uint24,uint32,uint16,bool)");
        for (uint256 i = 0; i < logs.length; i++) assertTrue(logs[i].topics[0] != routeSet, "second run re-set a route");
    }

    function test_refreshesOnlyTheChangedRoute() public {
        // pre-set AAPL with a stale tolerance: the script must rewrite it and leave a matching route alone
        vm.prank(BROADCAST_SENDER);
        pool.setAssetRoute(
            AAPL,
            ILossRewardPoolV2.AssetRoute({swapper: address(swapper), pool: 0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f, fee: 500, twapWindow: 1800, maxDeviationBps: 500, enabled: true})
        );
        _runAsOwner(new ConfigureStockRoutes());
        assertEq(uint256(pool.assetRoute(AAPL).maxDeviationBps), 300, "stale route refreshed to the file's parameters");
    }

    function test_rejectsANonCanonicalPoolBeforeBroadcast() public {
        // a doctored file (test/fixtures): NVDA pointed at AAPL's pool must revert RouteRejectedByAdapter
        ConfigureStockRoutes script = new ConfigureStockRoutes();
        vm.expectRevert(abi.encodeWithSelector(ConfigureStockRoutes.RouteRejectedByAdapter.selector, "NVDA", NVDA, 0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f, uint24(500)));
        script.runWith(address(pool), address(swapper), "test/fixtures/doctored-stock-routes.json");
        assertFalse(pool.isSelectableAsset(NVDA));
    }
}
