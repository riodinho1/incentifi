/**
 * Turn the venue map from enumerate-stock-venues.mjs into the LossRewardPoolV2 route config:
 *
 *   config/loss-reward-stock-routes.json          consumed by script/ConfigureStockRoutes.s.sol
 *   src/lib/stockRewardCandidates.generated.json  the launch dropdown's candidate universe
 *
 * A stock gets a route only when ALL hold (every criterion is something the on-chain adapter or
 * pool would otherwise turn into an ETH fallback or a revert):
 *   - StockFactory round-trip ok (the pool's own AssetNotSelectable check)
 *   - Robinhood API status ACTIVE when the API answered (enrichment; --include-unlisted to skip)
 *   - a Uniswap V3 WETH/asset pool with in-range liquidity > 0 and >= --min-weth WETH in it
 *   - the pool can serve the adapter's TWAP reference (observe over 1800 s, or the 600 s fallback)
 *   - in-range liquidity >= --min-liquidity (raw L, default 1e17 ~ a pool that can absorb a 0.05 ETH
 *     claim inside the 3 % bound) - audit 2026-09-08 finding 7 (BE: L 3e16, 0.98 WETH)
 *   - not listed in config/loss-reward-stock-routes.overrides.json `disabled` (hand-maintained; a
 *     disabled asset stays out even if the census admits it - re-enable on-chain and remove the entry)
 *   - the asset address sorts ABOVE WETH (0x0Bd7D308...): RewardSwapperUniswapV3 only swaps pools where
 *     WETH is token0 (validateRoute rejects the others). 7 of 203 stocks sort below WETH (VTI JNJ TTD
 *     AMC FLY SMH RDDT); they need a token-order-agnostic adapter before they can be routed.
 * Among qualifying fee tiers the one holding the most WETH is chosen.
 *
 *   node scripts/ops/generate-stock-routes.mjs --in scratch/stock-venues.json [--min-weth 1] [--include-unlisted]
 */
import fs from 'node:fs';
import path from 'node:path';
import { getAddress } from 'viem';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in', '');
if (!IN) { console.error('usage: --in <stock-venues.json> [--min-weth 1] [--include-unlisted] [--routes-out path] [--candidates-out path]'); process.exit(2); }
const MIN_WETH = Number(arg('--min-weth', '1'));
const MIN_LIQUIDITY = BigInt(arg('--min-liquidity', '100000000000000000')); // raw in-range L
const OVERRIDES_FILE = arg('--overrides', 'config/loss-reward-stock-routes.overrides.json');
const overrides = fs.existsSync(OVERRIDES_FILE) ? JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')) : { disabled: [] };
const disabledByAsset = new Map((overrides.disabled || []).map((d) => [String(d.asset).toLowerCase(), d]));
const INCLUDE_UNLISTED = args.includes('--include-unlisted');
const ROUTES_OUT = arg('--routes-out', 'config/loss-reward-stock-routes.json');
const CANDIDATES_OUT = arg('--candidates-out', 'src/lib/stockRewardCandidates.generated.json');
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const TWAP_WINDOW = 1800;
const MAX_DEVIATION_BPS = 300;

const venues = JSON.parse(fs.readFileSync(IN, 'utf8'));
const routes = [];
const excluded = [];
for (const s of venues.stocks) {
  const why = [];
  if (!s.roundTrip) why.push('StockFactory round-trip failed');
  if (s.apiStatus !== null && s.apiStatus !== undefined && s.apiStatus !== 'ASSET_STATUS_ACTIVE') why.push(`API status ${s.apiStatus}`);
  if ((s.apiStatus === null || s.apiStatus === undefined) && !INCLUDE_UNLISTED) why.push('not in the Robinhood API list');
  if (BigInt(s.address) < BigInt(WETH)) why.push('asset address sorts below WETH (asset would be token0); RewardSwapperUniswapV3 requires WETH as token0 - needs a token-order-agnostic adapter');
  const override = disabledByAsset.get(String(s.address).toLowerCase());
  if (override) why.push(`manually disabled (${OVERRIDES_FILE}, since ${override.since || '?'}): ${override.reason || 'no reason given'}`);
  const qualifying = (s.pools || []).filter((p) => p.initialized && BigInt(p.liquidity || 0) >= MIN_LIQUIDITY && Number(p.wethBalance || 0) >= MIN_WETH && (p.twap30mAvailable || p.twap10mAvailable));
  if (!qualifying.length) {
    if (!(s.pools || []).length) why.push('no Uniswap V3 WETH pool');
    else {
      const best = [...s.pools].sort((a, b) => Number(b.wethBalance || 0) - Number(a.wethBalance || 0))[0];
      if (BigInt(best.liquidity || 0) === 0n) why.push('V3 WETH pool has no in-range liquidity');
      else if (BigInt(best.liquidity || 0) < MIN_LIQUIDITY) why.push(`V3 WETH pool in-range liquidity ${best.liquidity} < ${MIN_LIQUIDITY} (too thin for the 3 % bound)`);
      else if (Number(best.wethBalance || 0) < MIN_WETH) why.push(`V3 WETH pool holds ${Number(best.wethBalance).toFixed(3)} WETH < ${MIN_WETH}`);
      else why.push('V3 WETH pool cannot serve a 30 m / 10 m TWAP yet (widen with increaseObservationCardinalityNext)');
    }
  }
  if (why.length) { excluded.push({ symbol: s.symbol, address: s.address, reasons: why, otherVenues: { v3UsdgLiquid: (s.usdgPools || []).some((p) => BigInt(p.liquidity || 0) > 0n), v4Liquid: (s.v4Pools || []).some((p) => BigInt(p.liquidity || 0) > 0n) } }); continue; }
  const best = qualifying.sort((a, b) => Number(b.wethBalance || 0) - Number(a.wethBalance || 0))[0];
  routes.push({ symbol: s.symbol, name: s.name, asset: getAddress(s.address), pool: getAddress(best.address), fee: best.fee, wethInPool: Number(best.wethBalance).toFixed(3), twap30m: Boolean(best.twap30mAvailable) });
}
routes.sort((a, b) => a.symbol.localeCompare(b.symbol));

const routesJson = {
  generatedAt: new Date().toISOString(),
  source: { venuesFile: path.basename(IN), chainHead: venues.chainHead, generatedAt: venues.generatedAt },
  criteria: { minWethInPool: MIN_WETH, minInRangeLiquidity: MIN_LIQUIDITY.toString(), requireTwap: true, requireApiActive: !INCLUDE_UNLISTED, overridesFile: OVERRIDES_FILE },
  disabled: (overrides.disabled || []).map((d) => ({ symbol: d.symbol, asset: d.asset, since: d.since, reason: d.reason })),
  twapWindow: TWAP_WINDOW,
  maxDeviationBps: MAX_DEVIATION_BPS,
  count: routes.length,
  routes,
  excluded,
};
fs.mkdirSync(path.dirname(ROUTES_OUT), { recursive: true });
fs.writeFileSync(ROUTES_OUT, JSON.stringify(routesJson, null, 2) + '\n');
fs.writeFileSync(CANDIDATES_OUT, JSON.stringify({ generatedAt: routesJson.generatedAt, candidates: routes.map((r) => ({ symbol: r.symbol, name: r.name, address: r.asset })) }, null, 2) + '\n');
console.error(`[routes] ${routes.length} routes -> ${ROUTES_OUT}; ${excluded.length} excluded; candidates -> ${CANDIDATES_OUT}`);
console.log(routes.map((r) => `${r.symbol.padEnd(6)} fee ${String(r.fee).padStart(5)}  ${r.wethInPool.padStart(9)} WETH  twap30m=${r.twap30m}  ${r.pool}`).join('\n'));
