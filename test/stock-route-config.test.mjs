/**
 * STOCK ROUTE CONFIG — scripts/ops/generate-stock-routes.mjs and the committed outputs.
 *   1. generator on a fixture venue map: selection criteria + named exclusion reasons + best tier
 *   2. committed config/loss-reward-stock-routes.json is internally consistent and still carries the
 *      three Phase-A routes at the pools the design doc verified
 *   3. committed src/lib/stockRewardCandidates.generated.json mirrors the routes 1:1
 *
 * Run: node test/stock-route-config.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getAddress } from 'viem';

const pool = (fee, weth, liq = '1000000000000000000', twap30 = true, twap10 = true, initialized = true) => ({ fee, address: `0x${(fee + 1000).toString(16).padStart(40, '0')}`, initialized, liquidity: liq, wethBalance: String(weth), twap30mAvailable: twap30, twap10mAvailable: twap10 });
const stock = (symbol, address, extra = {}) => ({ symbol, name: `${symbol} • Robinhood Token`, address, roundTrip: true, apiStatus: 'ASSET_STATUS_ACTIVE', pools: [], usdgPools: [], v4Pools: [], ...extra });
const fixture = {
  chainHead: 1, generatedAt: '2026-09-07T00:00:00.000Z',
  stocks: [
    stock('AAAA', '0xa0000000000000000000000000000000000000a1', { pools: [pool(500, 2), pool(3000, 40), pool(10000, 0.1)] }), // best tier = 3000 (most WETH)
    stock('BBBB', '0xa0000000000000000000000000000000000000b1', { pools: [pool(3000, 0.4)] }),                              // below min-weth
    stock('CCCC', '0xa0000000000000000000000000000000000000c1', { pools: [pool(3000, 9, '0')] }),                          // no in-range liquidity
    stock('DDDD', '0xa0000000000000000000000000000000000000d1', { pools: [pool(3000, 9, '1000000000000000000', false, false)] }), // no TWAP
    stock('JJJJ', '0xa000000000000000000000000000000000000ff3', { pools: [pool(3000, 9, '30000000000000000')] }),             // in-range L 3e16 < 1e17 (audit: BE)
    stock('KKKK', '0xa000000000000000000000000000000000000ff4', { pools: [pool(3000, 9)] }),                                 // healthy but manually disabled (overrides)
    stock('EEEE', '0xa0000000000000000000000000000000000000e1', { pools: [pool(3000, 9)], apiStatus: null }),              // not in API list
    stock('FFFF', '0xa0000000000000000000000000000000000000f1', { pools: [pool(3000, 9)], roundTrip: false }),             // registry mismatch
    stock('GGGG', '0xa000000000000000000000000000000000000ff1', { usdgPools: [{ fee: 3000, address: '0x00000000000000000000000000000000000000ee', liquidity: '7' }] }), // USDG only
    stock('HHHH', '0xa000000000000000000000000000000000000ff2', { pools: [pool(3000, 9)], apiStatus: 'ASSET_STATUS_INACTIVE' }),
    stock('IIII', '0x0000000000000000000000000000000000000001', { pools: [pool(3000, 9)] }),                                 // sorts below WETH -> asset would be token0
  ],
};
const committedRoutesForTokenOrder = () => JSON.parse(fs.readFileSync('config/loss-reward-stock-routes.json', 'utf8')).routes;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-routes-'));
const inFile = path.join(tmp, 'venues.json'); fs.writeFileSync(inFile, JSON.stringify(fixture));
const routesOut = path.join(tmp, 'routes.json'); const candOut = path.join(tmp, 'cands.json');
const overridesFile = path.join(tmp, 'overrides.json');
fs.writeFileSync(overridesFile, JSON.stringify({ disabled: [{ symbol: 'KKKK', asset: '0xa000000000000000000000000000000000000ff4', since: '2026-09-08', reason: 'test override' }] }));

console.log('======================================================');
console.log('  STOCK ROUTE CONFIG (generator + committed outputs)');
console.log('======================================================\n');

// 1. generator
execFileSync(process.execPath, ['scripts/ops/generate-stock-routes.mjs', '--in', inFile, '--min-weth', '1', '--overrides', overridesFile, '--routes-out', routesOut, '--candidates-out', candOut], { stdio: ['ignore', 'ignore', 'inherit'] });
const gen = JSON.parse(fs.readFileSync(routesOut, 'utf8'));
assert.equal(gen.count, 1); assert.equal(gen.routes.length, 1);
assert.equal(gen.routes[0].symbol, 'AAAA'); assert.equal(gen.routes[0].fee, 3000, 'tier with the most WETH wins');
assert.equal(gen.routes[0].asset, getAddress('0xa0000000000000000000000000000000000000a1'), 'checksummed');
assert.equal(gen.twapWindow, 1800); assert.equal(gen.maxDeviationBps, 300);
const ex = Object.fromEntries(gen.excluded.map((e) => [e.symbol, e]));
assert.match(ex.BBBB.reasons[0], /holds 0\.400 WETH < 1/);
assert.match(ex.CCCC.reasons[0], /no in-range liquidity/);
assert.match(ex.DDDD.reasons[0], /cannot serve a 30 m \/ 10 m TWAP/);
assert.match(ex.EEEE.reasons[0], /not in the Robinhood API list/);
assert.match(ex.FFFF.reasons[0], /StockFactory round-trip failed/);
assert.match(ex.GGGG.reasons[0], /no Uniswap V3 WETH pool/); assert.equal(ex.GGGG.otherVenues.v3UsdgLiquid, true, 'the two-hop candidate is flagged');
assert.match(ex.HHHH.reasons[0], /API status ASSET_STATUS_INACTIVE/);
assert.match(ex.IIII.reasons[0], /sorts below WETH/);
assert.match(ex.JJJJ.reasons[0], /in-range liquidity 30000000000000000 < 100000000000000000/, 'audit finding 7: thin in-range liquidity is excluded');
assert.match(ex.KKKK.reasons[0], /manually disabled \(.*since 2026-09-08\): test override/, 'overrides file excludes a healthy asset');
assert.deepEqual(gen.disabled.map((d) => d.symbol), ['KKKK'], 'the disabled list is carried into the routes file');
assert.equal(gen.criteria.minInRangeLiquidity, '100000000000000000');
for (const r of committedRoutesForTokenOrder()) assert.ok(BigInt(r.asset) > BigInt('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'), `${r.symbol}: WETH must be token0 for the adapter`);
const cands = JSON.parse(fs.readFileSync(candOut, 'utf8'));
assert.deepEqual(cands.candidates, [{ symbol: 'AAAA', name: 'AAAA • Robinhood Token', address: gen.routes[0].asset }]);
// --include-unlisted admits EEEE
execFileSync(process.execPath, ['scripts/ops/generate-stock-routes.mjs', '--in', inFile, '--min-weth', '1', '--include-unlisted', '--overrides', overridesFile, '--routes-out', routesOut, '--candidates-out', candOut], { stdio: ['ignore', 'ignore', 'inherit'] });
assert.deepEqual(JSON.parse(fs.readFileSync(routesOut, 'utf8')).routes.map((r) => r.symbol), ['AAAA', 'EEEE']);
console.log('1. generator: criteria, best tier, named exclusion reasons, --include-unlisted  OK');

// 2. committed route config
const committed = JSON.parse(fs.readFileSync('config/loss-reward-stock-routes.json', 'utf8'));
assert.equal(committed.count, committed.routes.length);
assert.ok(committed.count >= 3);
const seen = new Set();
for (const r of committed.routes) {
  assert.equal(r.asset, getAddress(r.asset), `${r.symbol} asset checksummed`);
  assert.equal(r.pool, getAddress(r.pool), `${r.symbol} pool checksummed`);
  assert.ok([100, 500, 3000, 10000].includes(r.fee), `${r.symbol} fee tier`);
  assert.ok(!seen.has(r.asset.toLowerCase()), `${r.symbol} duplicate asset`); seen.add(r.asset.toLowerCase());
}
assert.equal(committed.twapWindow, 1800); assert.equal(committed.maxDeviationBps, 300);
const by = Object.fromEntries(committed.routes.map((r) => [r.symbol, r]));
// Phase A venues (docs §A2), still the chosen tiers
assert.deepEqual([by.AAPL.asset, by.AAPL.pool, by.AAPL.fee], ['0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', '0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f', 500]);
assert.deepEqual([by.TSLA.asset, by.TSLA.pool, by.TSLA.fee], ['0x322F0929c4625eD5bAd873c95208D54E1c003b2d', '0xA953CA88ff430e9487c60cA34d757414f4efdA07', 3000]);
assert.deepEqual([by.NVDA.asset, by.NVDA.pool, by.NVDA.fee], ['0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', '0x62AB521f71431f78ac374CdbadC6cda3c8916b6C', 500]);
assert.deepEqual(committed.routes.map((r) => r.symbol), [...committed.routes.map((r) => r.symbol)].sort(), 'sorted by symbol');
// audit 2026-09-08 finding 7: QUBT and BE are disabled via the overrides file and must not be routed / offered
const overrides = JSON.parse(fs.readFileSync('config/loss-reward-stock-routes.overrides.json', 'utf8'));
assert.deepEqual(overrides.disabled.map((d) => d.symbol).sort(), ['BE', 'QUBT']);
for (const d of overrides.disabled) {
  assert.ok(!committed.routes.some((r) => r.symbol === d.symbol || r.asset.toLowerCase() === d.asset.toLowerCase()), `${d.symbol} must not be routed while disabled`);
  assert.ok(committed.excluded.some((e) => e.symbol === d.symbol && e.reasons.some((x) => /manually disabled/.test(x))), `${d.symbol} excluded with the override reason`);
}
assert.deepEqual(committed.disabled.map((d) => d.symbol), overrides.disabled.map((d) => d.symbol));
console.log(`2. committed config: ${committed.count} routes, consistent, Phase-A pools intact  OK`);

// 3. candidates mirror the routes
const committedCands = JSON.parse(fs.readFileSync('src/lib/stockRewardCandidates.generated.json', 'utf8'));
assert.deepEqual(committedCands.candidates.map((c) => [c.symbol, c.address]), committed.routes.map((r) => [r.symbol, r.asset]));
console.log('3. generated candidates mirror the routes 1:1  OK');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nstock-route-config tests passed');
