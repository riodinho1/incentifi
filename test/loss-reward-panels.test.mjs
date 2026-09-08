/**
 * TOKEN PAGE PANELS (pure view-model logic, real modules via Vite SSR, no chain):
 *
 *   Loss-Reward panel for stock-paying tokens — src/lib/lossRewardDisplay.ts buildStockClaimDisplay():
 *     1. ETH token -> plain ETH figure
 *     2. stock token, allocation >= 0.002 ETH, quote present -> "≈ N GOOGL" with uiMultiplier applied,
 *        ETH allocation underneath
 *     3. allocation below minStockRewardWei -> "Below 0.002 ETH — paid in ETH" (no stock estimate)
 *     4. no quote -> "≈ ? GOOGL", allocation still shown
 *   Creator-Fees panel — src/lib/legibleFees.ts fee math + creatorFees.hasUncollectedFees():
 *     5. uncollectedFeesFromGrowth == the PoolManager formula incl. 2^256 wrap; splitCollectedFees 50/50
 *     6. hasUncollectedFees drives "Collect & Claim (2 transactions)" vs "Claim"
 *
 * Run: node test/loss-reward-panels.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import { createServer as createViteServer } from 'vite';

const vite = await createViteServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const display = await vite.ssrLoadModule('/src/lib/lossRewardDisplay.ts');
  const fees = await vite.ssrLoadModule('/src/lib/legibleFees.ts');
  const creator = await vite.ssrLoadModule('/src/lib/creatorFees.ts');
  const E = 10n ** 18n;
  const MIN = 2n * 10n ** 15n; // 0.002 ETH
  const MULT = 1_000_566_080_061_092_436n; // GOOGL-like uiMultiplier (1.000566…)

  console.log('======================================================');
  console.log('  TOKEN PAGE PANELS (loss-reward stock display, creator fees)');
  console.log('======================================================\n');

  // 1. ETH token
  const eth = display.buildStockClaimDisplay({ symbol: 'ETH', isStock: false, totalClaimableWei: 12_345n * 10n ** 13n, minStockRewardWei: 0n, quotedRaw: 0n, uiMultiplierWei: E });
  assert.equal(eth.mode, 'eth'); assert.equal(eth.primary, '0.12345 ETH'); assert.equal(eth.secondary, undefined);
  assert.equal(display.buildStockClaimDisplay({ symbol: 'ETH', isStock: false, totalClaimableWei: 0n, minStockRewardWei: 0n, quotedRaw: 0n, uiMultiplierWei: E }).primary, '0.0000 ETH');
  console.log('1. ETH token -> "0.12345 ETH"  OK');

  // 2. stock, above minimum, quoted: raw 0.388 GOOGL -> display raw * mult / 1e18
  const raw = 388_175_229_770_932_655n;
  const stock = display.buildStockClaimDisplay({ symbol: 'GOOGL', isStock: true, totalClaimableWei: 5n * 10n ** 15n, minStockRewardWei: MIN, quotedRaw: raw, uiMultiplierWei: MULT });
  assert.equal(stock.mode, 'stock');
  assert.equal(stock.primary, '≈ 0.388395 GOOGL', 'uiMultiplier applied (0.388175 raw -> 0.388395 shares)');
  assert.match(stock.secondary, /^0\.00500 ETH allocation, spent on GOOGL at claim time/);
  assert.equal(stock.quotedRaw, raw);
  console.log(`2. stock above minimum -> "${stock.primary}" / "${stock.secondary.slice(0, 40)}…"  OK`);

  // 3. below the pool minimum -> paid in ETH, no stock estimate even if a quote exists
  const below = display.buildStockClaimDisplay({ symbol: 'GOOGL', isStock: true, totalClaimableWei: MIN - 1n, minStockRewardWei: MIN, quotedRaw: raw, uiMultiplierWei: MULT });
  assert.equal(below.mode, 'below-min');
  assert.equal(below.primary, 'Below 0.002 ETH — paid in ETH');
  assert.match(below.secondary, /^0\.00200 ETH allocation \(stock payouts start at 0\.002 ETH per claim\)/);
  assert.equal(below.quotedRaw, 0n, 'no stock figure surfaces below the minimum');
  const atMin = display.buildStockClaimDisplay({ symbol: 'GOOGL', isStock: true, totalClaimableWei: MIN, minStockRewardWei: MIN, quotedRaw: raw, uiMultiplierWei: MULT });
  assert.equal(atMin.mode, 'stock', 'exactly the minimum pays stock (pool rule: total < min falls back)');
  console.log(`3. below 0.002 ETH -> "${below.primary}"  OK`);

  // 4. no quote
  const unq = display.buildStockClaimDisplay({ symbol: 'GOOGL', isStock: true, totalClaimableWei: 5n * 10n ** 15n, minStockRewardWei: MIN, quotedRaw: 0n, uiMultiplierWei: MULT });
  assert.equal(unq.mode, 'stock-unquoted'); assert.equal(unq.primary, '≈ ? GOOGL (no quote right now)'); assert.match(unq.secondary, /0\.00500 ETH allocation/);
  console.log('4. no quote -> "≈ ? GOOGL", allocation shown  OK');

  // 5. fee math: fees = (growth - last) * L / 2^128, wrap-safe; split 50/50 with the odd wei to the loss pool
  const L = 48_215_215_764_839_215_328_822n;
  const Q128 = 1n << 128n;
  const g0 = (2_582_000_000_000_000n * Q128) / L + 1n; // ~0.002582 ETH of fee growth
  const r = fees.uncollectedFeesFromGrowth({ liquidity: L, feeGrowthInside0X128: g0, feeGrowthInside1X128: 0n, feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n });
  assert.equal(r.ethFees, (g0 * L) >> 128n); assert.ok(r.ethFees >= 2_582_000_000_000_000n && r.ethFees < 2_582_000_000_000_000n + L, 'formula');
  assert.equal(r.tokenFees, 0n);
  const wrapped = fees.uncollectedFeesFromGrowth({ liquidity: L, feeGrowthInside0X128: 5n, feeGrowthInside1X128: 0n, feeGrowthInside0LastX128: (1n << 256n) - 10n, feeGrowthInside1LastX128: 0n });
  assert.equal(wrapped.ethFees, (15n * L) >> 128n, 'growth counters wrap mod 2^256 like the PoolManager');
  const split = fees.splitCollectedFees(1_001n, 7n);
  assert.deepEqual([split.creatorShare, split.lossPoolShare, split.tokenFeesToConverter], [500n, 501n, 7n], 'creator = ethFees/2, loss pool gets the remainder, tokens to the converter');
  console.log('5. fee math == PoolManager formula (wrap-safe), split 50/50  OK');

  // 6. the button decision
  const base = { source: { kind: 'v4', contract: '0x921d0bE20A21e5A687734b4dF6302EA55BD168C0', scope: 'creator', venue: 'legible' }, creator: '0x0000000000000000000000000000000000000001', isCreator: true, balanceWei: 0n, balanceEth: 0 };
  assert.equal(creator.hasUncollectedFees({ ...base }), false, 'no simulation -> no collect');
  assert.equal(creator.hasUncollectedFees({ ...base, uncollected: { seeded: true, ethFees: 0n, tokenFees: 0n } }), false, 'nothing uncollected -> skip collect');
  assert.equal(creator.hasUncollectedFees({ ...base, uncollected: { seeded: true, ethFees: 1n, tokenFees: 0n } }), true);
  assert.equal(creator.hasUncollectedFees({ ...base, uncollected: { seeded: true, ethFees: 0n, tokenFees: 5n } }), true, 'token-side fees alone still warrant a collect');
  assert.equal(creator.hasUncollectedFees({ ...base, uncollected: { seeded: false, ethFees: 9n, tokenFees: 9n } }), false, 'unseeded curve -> collect would revert');
  console.log('6. hasUncollectedFees -> collect-then-claim only when something is uncollected  OK');

  console.log('\nloss-reward-panels tests passed');
} finally {
  await vite.close();
}
