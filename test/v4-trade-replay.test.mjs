/**
 * V4 TRADE REPLAY TEST — Fix 1 (scripts/evm-indexer.mjs indexV4TradesInRange).
 *
 * Replays the REAL, already-mined TESTINGG trades on Robinhood Chain mainnet through the
 * real, unmodified indexer code path (discoverV4TokensInRange -> indexV4TradesInRange ->
 * processBuyTrade/processSellTrade -> aggregateCandle1m) and asserts that what lands in
 * token_trades_evm / holder_cost_basis / token_candles_1m matches the on-chain facts.
 *
 * Why a replay against mainnet history rather than a Hardhat fork: the only chain access
 * this code path needs is eth_getLogs + eth_getBlockByNumber for blocks that are already
 * final — immutable history that a fork would simply proxy to the same RPC. Reading it
 * directly is the more faithful test (no EDR fork-block quirks in between) and is strictly
 * read-only. The ONLY thing mocked is Supabase: every "/rest/v1/*" call is captured
 * in-memory by test/hardhat/support/supabase-rest-mock.mjs, so nothing here can write to
 * the real project even though scripts/evm-indexer.mjs loads real credentials from
 * .env.local at import time (see that mock's REST_PATH_MARKER comment for why this is
 * host-independent by design).
 *
 * The fixture below is NOT hand-typed from memory: it was pulled from mainnet with a
 * chunked getLogs over the new hook 0xC5Ef9Cb8… for TESTINGG's poolId, and every value
 * was cross-checked against the tx receipts. Notably, 7 of the 8 trades were routed through
 * the third-party bot contract 0xEd090594… (tx.to), and one buy through IncentifiV4Router —
 * the hook emits tx.origin as `trader`, so every reconstructed trader MUST be the wallet,
 * never the bot contract.
 *
 * Run: node test/v4-trade-replay.test.mjs   (needs network access to the Robinhood RPC)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

console.log('======================================================');
console.log('  V4 TRADE REPLAY TEST (real TESTINGG mainnet trades)');
console.log('======================================================\n');

// ---------------------------------------------------------------------------
// 0. Install the Supabase mock BEFORE the indexer is imported (postgrest-js captures
//    `fetch` at createClient() time, which is module-evaluation time of evm-indexer.mjs).
// ---------------------------------------------------------------------------
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}
// The indexer's own .env.local loader will win if that file exists; mirror it here so the
// mock's "unexpected host" warning stays quiet. The mock intercepts by path regardless.
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://v4-replay-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'v4-replay-test-service-role-key';

const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, {
  upsertKeys: {
    holder_cost_basis: ['token_address', 'wallet_address'],
    token_trades_evm: ['tx_hash'],
    token_candles_1m: ['symbol', 'bucket_ts'],
    token_market_snapshots_evm: ['token_address'],
    indexer_heartbeats: ['worker_name'],
  },
});
globalThis.fetch = mock.fetchImpl;

const indexer = await import('../scripts/evm-indexer.mjs');

// ---------------------------------------------------------------------------
// 1. Fixture — the real TESTINGG history on the GenericSell hook.
// ---------------------------------------------------------------------------
const TOKEN = '0x7f9b8a09877f6e8096b0b8c6027dc49580b05474'; // TESTINGG
const SYMBOL = 'TESTINGG';
const LAUNCH_BLOCK = 56_230_887n; // TokenLaunched tx 0xa15d6525…
const W1 = '0xba69ca72cd2b87113471c4c38f08928761edb5ce'; // creator wallet
const W2 = '0xd2df2a28cd90f7ac5beac82d00e9c03772b75096'; // second buyer
const BOT_CONTRACT = '0xed090594a014208a177bb23fbb921aa3997eb1f9';
const V4_ROUTER = '0x762b4d9e514e4b19e54e99b62e7b731ce37ff1e6';

// amounts as decimal strings exactly as decoded from the logs (18 decimals)
const FIXTURE = [
  { side: 'buy',  block: 56231325, logIndex: 319, time: '2026-09-06T19:34:50.000Z', tx: '0x63295180da0a67a38d9f38d840287e9a4dc70c398dad8c720a334acfa5fb08eb', txTo: BOT_CONTRACT, wallet: W1, eth: '0.00495',              tokens: '2420055.506429361700355514',  creatorFee: '0.0000495',             lossPoolFee: '0.0000495' },
  { side: 'sell', block: 56231361, logIndex: 87,  time: '2026-09-06T19:34:54.000Z', tx: '0x52e0d606a6013b8829211eb63ec9c73c7a32b49e7be6215acd003366a9b0df5c', txTo: BOT_CONTRACT, wallet: W1, eth: '0.00475398',           tokens: '2420055.506429361700355514',  creatorFee: '0.00004851',            lossPoolFee: '0.00004851' },
  { side: 'buy',  block: 56234852, logIndex: 18,  time: '2026-09-06T19:40:45.000Z', tx: '0xda30e5c617e474e9a0edff07809c3926f3df82934e56416828d49b9fe491fd6c', txTo: BOT_CONTRACT, wallet: W1, eth: '0.0198',               tokens: '9615470.796367437101671498',  creatorFee: '0.000198',              lossPoolFee: '0.000198' },
  { side: 'sell', block: 56234943, logIndex: 660, time: '2026-09-06T19:40:57.000Z', tx: '0xacf9f4b35c330ca1ddbf882f4180b95768acf751211126e6dd4a09b4fcb4244e', txTo: BOT_CONTRACT, wallet: W1, eth: '0.01901592',           tokens: '9615470.796367437101671498',  creatorFee: '0.00019404',            lossPoolFee: '0.00019404' },
  { side: 'buy',  block: 56235055, logIndex: 3,   time: '2026-09-06T19:41:08.000Z', tx: '0x115c2fd604a4bd3e6d8506bcd4567193f861db650c055775a0d06897804e0810', txTo: BOT_CONTRACT, wallet: W1, eth: '0.099',                tokens: '46421284.400005325593470823', creatorFee: '0.00099',               lossPoolFee: '0.00099' },
  { side: 'buy',  block: 56235814, logIndex: 170, time: '2026-09-06T19:42:22.000Z', tx: '0x681a271e6efb26371629da965fc0e1e1779a12541f39175fd69871cf5418ca96', txTo: V4_ROUTER,    wallet: W2, eth: '0.08',                 tokens: '34689973.839797047812714444', creatorFee: '0.0008',                lossPoolFee: '0.0008' },
  { side: 'sell', block: 56236323, logIndex: 109, time: '2026-09-06T19:43:14.000Z', tx: '0x22a14694708ebb8c50ac0bd5414f45627d60b1f3202e0399516f2758c6b08d94', txTo: BOT_CONTRACT, wallet: W1, eth: '0.101658782016710998', tokens: '46421284.400005325593470823', creatorFee: '0.001037334510374602',  lossPoolFee: '0.001037334510374602' },
  { side: 'sell', block: 56239787, logIndex: 25,  time: '2026-09-06T19:49:02.000Z', tx: '0xa1744015f97c53bffa59a8fe9d9c6a35213d0d27bf9c5e23bea1220690237a29', txTo: BOT_CONTRACT, wallet: W2, eth: '0.070252817983289004', tokens: '34689973.839797047812714444', creatorFee: '0.000716865489625397',  lossPoolFee: '0.000716865489625397' },
];

// Two consecutive poller windows, each within the RPC's 5,000-block getLogs cap, exactly
// as the tick loop would hand them over. Window A holds the launch + trades 1-4; window B
// holds trades 5-8. The 5,000 boundary at 56,235,000 splits the history, which is the point.
const WINDOW_A = [56_230_000n, 56_235_000n];
const WINDOW_B = [56_235_001n, 56_240_000n];

const approx = (actual, expected, label, rel = 1e-9) => {
  const a = Number(actual);
  const e = Number(expected);
  const tol = Math.max(Math.abs(e) * rel, 1e-18);
  assert.ok(Math.abs(a - e) <= tol, `${label}: expected ${e}, got ${a}`);
};

// ---------------------------------------------------------------------------
// 2. Discovery over window A must find TESTINGG from the real TokenLaunched event.
// ---------------------------------------------------------------------------
console.log(`Testing [1/7] Discovery finds TESTINGG from the real TokenLaunched at block ${LAUNCH_BLOCK}...`);
await indexer.discoverV4TokensInRange(WINDOW_A[0], WINDOW_A[1]);
// Trade indexing with an empty cache is a no-op returning 0; a non-zero count below is
// therefore also proof discovery populated the poolId map.
console.log('  ✓ discoverV4TokensInRange completed over window A\n');

// ---------------------------------------------------------------------------
// 3. Replay window A, then window B.
// ---------------------------------------------------------------------------
console.log('Testing [2/7] indexV4TradesInRange over window A reconstructs trades 1-4...');
const matchedA = await indexer.indexV4TradesInRange(WINDOW_A[0], WINDOW_A[1]);
assert.equal(matchedA, 4, 'window A must match exactly the 4 TESTINGG trades mined in it');
console.log(`  ✓ matched ${matchedA} hook events in window A\n`);

console.log('Testing [3/7] indexV4TradesInRange over window B reconstructs trades 5-8...');
const matchedB = await indexer.indexV4TradesInRange(WINDOW_B[0], WINDOW_B[1]);
assert.equal(matchedB, 4, 'window B must match exactly the 4 TESTINGG trades mined in it');
console.log(`  ✓ matched ${matchedB} hook events in window B\n`);

// ---------------------------------------------------------------------------
// 4. token_trades_evm rows == on-chain facts (Recent Trades display).
// ---------------------------------------------------------------------------
console.log('Testing [4/7] token_trades_evm matches the 8 real trades field-by-field...');
const trades = [...mock.table('token_trades_evm')].sort((a, b) => a.block_number - b.block_number || a.tx_hash.localeCompare(b.tx_hash));
assert.equal(trades.length, FIXTURE.length, `expected ${FIXTURE.length} trade rows, got ${trades.length}`);
for (let i = 0; i < FIXTURE.length; i += 1) {
  const f = FIXTURE[i];
  const r = trades[i];
  const label = `trade #${i + 1} (${f.side} @ ${f.block})`;
  assert.equal(r.tx_hash, `${f.tx}:${f.logIndex}`, `${label} tx_hash`);
  assert.equal(r.token_address, TOKEN, `${label} token_address`);
  assert.equal(r.side, f.side, `${label} side`);
  assert.equal(r.trader_address, f.wallet, `${label} trader must be the wallet (tx.origin)`);
  assert.notEqual(r.trader_address, BOT_CONTRACT, `${label} trader must NOT be the bot contract`);
  assert.notEqual(r.trader_address, V4_ROUTER, `${label} trader must NOT be the router`);
  approx(r.amount_token, f.tokens, `${label} amount_token`);
  approx(r.amount_eth, f.eth, `${label} amount_eth`);
  approx(r.creator_fee_eth, f.creatorFee, `${label} creator_fee_eth`);
  approx(r.loss_pool_fee_eth, f.lossPoolFee, `${label} loss_pool_fee_eth`);
  assert.equal(r.block_number, f.block, `${label} block_number`);
  assert.equal(r.block_time, f.time, `${label} block_time (real block timestamp, not "now")`);
  const expectedPrice = f.side === 'buy'
    ? (Number(f.eth) - Number(f.creatorFee) - Number(f.lossPoolFee)) / Number(f.tokens)
    : Number(f.eth) / Number(f.tokens);
  approx(r.price_eth, expectedPrice, `${label} price_eth`);
  console.log(`  ✓ #${i + 1} ${f.side.padEnd(4)} block ${f.block} via ${f.txTo === BOT_CONTRACT ? 'bot contract' : 'V4 router  '} trader=${r.trader_address.slice(0, 10)}… ${Number(f.tokens).toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(11)} tokens / ${Number(f.eth).toFixed(6)} ETH  price=${r.price_eth.toExponential(4)}`);
}
console.log('');

// ---------------------------------------------------------------------------
// 5. holder_cost_basis (cost-basis display + loss-reward eligibility), re-derived here
//    independently from the fixture using the rule processBuyTrade/processSellTrade
//    implement: buys add GROSS eth to invested; a sell below avg cost basis flags the wallet
//    (is_eligible=false, is_underwater_seller=true); and a subsequent BUY clears those flags
//    ONLY if the position had been fully exited first (balance <= FULL_EXIT_DUST_TOKENS) —
//    a buy while still holding part of a disqualified position keeps it disqualified (see
//    test/underwater-requalification.test.mjs for the partial-sell cases). Every one of W1's
//    disqualifying sells on TESTINGG was a FULL exit, so W1's re-buys are fresh entries and
//    W1 legitimately ends re-qualified here.
// ---------------------------------------------------------------------------
console.log('Testing [5/7] holder_cost_basis is reconstructed per wallet from the replayed trades...');
const expectedHolders = new Map();
const expectedUnderwater = [];
for (const f of FIXTURE) {
  const h = expectedHolders.get(f.wallet) || { balance: 0, invested: 0, basis: 0, eligible: true, underwaterSeller: false };
  const tokens = Number(f.tokens);
  const eth = Number(f.eth);
  if (f.side === 'buy') {
    const fullyExited = h.balance <= 1e-6; // FULL_EXIT_DUST_TOKENS
    h.invested += eth;
    h.balance += tokens;
    h.basis = h.balance > 0 ? h.invested / h.balance : 0;
    if (fullyExited) { h.eligible = true; h.underwaterSeller = false; }
  } else {
    const price = eth / tokens;
    const underwater = price < h.basis;
    expectedUnderwater.push(underwater);
    h.balance = Math.max(0, h.balance - tokens);
    h.invested = h.balance > 0 ? h.balance * h.basis : 0;
    if (underwater) { h.eligible = false; h.underwaterSeller = true; }
  }
  expectedHolders.set(f.wallet, h);
}
// Hardcoded expectation for the four sells, so a slip in the re-derivation above can't
// silently agree with a slip in the indexer: W1 sold at a loss twice (#2, #4), then W2's
// 0.08 ETH buy pushed the curve up so W1's third sell (#7) was ABOVE its basis; W2's own
// sell (#8) after that was at a loss.
assert.deepEqual(expectedUnderwater, [true, true, false, true], 'fixture-derived underwater flags');
const sells = trades.filter((t) => t.side === 'sell');
assert.deepEqual(sells.map((t) => t.is_underwater_sale), [true, true, false, true], 'is_underwater_sale per sell row');
console.log('  ✓ is_underwater_sale per sell = [true, true, false, true] (sell #7 was profitable, correctly not flagged)');

// Hardcoded end-states, for the same reason as above: W1's sells #2 and #4 were underwater
// but each sold the ENTIRE balance (2,420,055.51 -> 0; 9,615,470.80 -> 0), so buys #3 and #5
// were fresh entries after full exits and legitimately re-qualify; sell #7 was profitable.
// W2's only sell (#8) was underwater and nothing followed, so W2 stays flagged.
const w1BalanceBeforeBuy5 = (() => { let b = 0; for (const f of FIXTURE.slice(0, 4)) if (f.wallet === W1) b = f.side === 'buy' ? b + Number(f.tokens) : Math.max(0, b - Number(f.tokens)); return b; })();
assert.equal(w1BalanceBeforeBuy5, 0, 'fixture fact: W1 had fully exited before buy #5 (so this fixture exercises the full-exit branch, not the partial-sell one)');
assert.equal(expectedHolders.get(W1).eligible, true, 'fixture-derived: W1 ends eligible (fresh entry after a full exit)');
assert.equal(expectedHolders.get(W1).underwaterSeller, false, 'fixture-derived: W1 underwater flag cleared by the full-exit re-entry');
assert.equal(expectedHolders.get(W2).eligible, false, 'fixture-derived: W2 ends ineligible');
assert.equal(expectedHolders.get(W2).underwaterSeller, true, 'fixture-derived: W2 flagged underwater');

const holders = mock.table('holder_cost_basis');
assert.equal(holders.length, 2, `expected 2 holder rows (W1, W2), got ${holders.length}`);
for (const [wallet, exp] of expectedHolders) {
  const row = holders.find((h) => h.wallet_address === wallet && h.token_address === TOKEN);
  assert.ok(row, `holder row for ${wallet}`);
  approx(row.token_balance, exp.balance, `${wallet} token_balance`, 1e-9);
  assert.equal(row.is_eligible, exp.eligible, `${wallet} is_eligible`);
  assert.equal(row.is_underwater_seller, exp.underwaterSeller, `${wallet} is_underwater_seller`);
  console.log(`  ✓ ${wallet.slice(0, 10)}… balance=${Number(row.token_balance)} eligible=${row.is_eligible} underwater_seller=${row.is_underwater_seller}`);
}
console.log('');

// ---------------------------------------------------------------------------
// 6. token_candles_1m (chart): one bucket per distinct minute, OHLC/volume aggregated.
// ---------------------------------------------------------------------------
console.log('Testing [6/7] token_candles_1m has one correctly-aggregated bucket per trade minute...');
const expectedBuckets = new Map();
for (const f of FIXTURE) {
  const bucket = new Date(Math.floor(Date.parse(f.time) / 60_000) * 60_000).toISOString();
  const price = f.side === 'buy'
    ? (Number(f.eth) - Number(f.creatorFee) - Number(f.lossPoolFee)) / Number(f.tokens)
    : Number(f.eth) / Number(f.tokens);
  const b = expectedBuckets.get(bucket) || { open: price, high: -Infinity, low: Infinity, close: price, volume: 0 };
  b.high = Math.max(b.high, price);
  b.low = Math.min(b.low, price);
  b.close = price;
  b.volume += Number(f.eth);
  expectedBuckets.set(bucket, b);
}
const candles = mock.table('token_candles_1m');
assert.equal(candles.length, expectedBuckets.size, `expected ${expectedBuckets.size} candle buckets, got ${candles.length}`);
assert.equal(expectedBuckets.size, 6, 'fixture spans 6 distinct minutes (19:34, 19:40, 19:41, 19:42, 19:43, 19:49)');
for (const [bucket, exp] of expectedBuckets) {
  const c = candles.find((x) => x.bucket_ts === bucket);
  assert.ok(c, `candle bucket ${bucket}`);
  assert.equal(c.symbol, SYMBOL, `${bucket} symbol`);
  assert.equal(c.mint_address, TOKEN, `${bucket} mint_address`);
  approx(c.open, exp.open, `${bucket} open`);
  approx(c.high, exp.high, `${bucket} high`);
  approx(c.low, exp.low, `${bucket} low`);
  approx(c.close, exp.close, `${bucket} close`);
  approx(c.volume_sol, exp.volume, `${bucket} volume`);
  console.log(`  ✓ ${bucket.slice(11, 16)}Z  o=${c.open.toExponential(3)} h=${c.high.toExponential(3)} l=${c.low.toExponential(3)} c=${c.close.toExponential(3)} vol=${c.volume_sol.toFixed(6)} ETH`);
}
console.log('');

// ---------------------------------------------------------------------------
// 7. Idempotency: replaying the same windows (a restart re-scanning from the last trade
//    block, or a retried tick) must not double-count anything.
// ---------------------------------------------------------------------------
console.log('Testing [7/7] Replaying both windows again is idempotent (dedup by tx_hash:logIndex)...');
const holdersBefore = JSON.stringify(mock.table('holder_cost_basis').map((h) => [h.wallet_address, h.token_balance, h.total_invested_eth, h.is_eligible]));
const candlesBefore = JSON.stringify(mock.table('token_candles_1m').map((c) => [c.bucket_ts, c.open, c.high, c.low, c.close, c.volume_sol]));
await indexer.indexV4TradesInRange(WINDOW_A[0], WINDOW_A[1]);
await indexer.indexV4TradesInRange(WINDOW_B[0], WINDOW_B[1]);
assert.equal(mock.table('token_trades_evm').length, FIXTURE.length, 'trade rows unchanged after replay');
assert.equal(JSON.stringify(mock.table('holder_cost_basis').map((h) => [h.wallet_address, h.token_balance, h.total_invested_eth, h.is_eligible])), holdersBefore, 'holder rows unchanged after replay');
assert.equal(JSON.stringify(mock.table('token_candles_1m').map((c) => [c.bucket_ts, c.open, c.high, c.low, c.close, c.volume_sol])), candlesBefore, 'candles unchanged after replay');
console.log('  ✓ 8 trades / 2 holders / 6 candles — unchanged\n');

// Safety net: every Supabase call this process made went to the mock, and only to tables
// this code path is supposed to touch.
const touched = [...new Set(mock.calls.map((c) => c.tableName))].sort();
assert.deepEqual(touched, ['holder_cost_basis', 'token_candles_1m', 'token_trades_evm'], `unexpected tables touched: ${touched.join(', ')}`);

console.log('======================================================');
console.log('  ALL 7/7 V4 TRADE REPLAY TESTS PASSED');
console.log(`  (${mock.calls.length} Supabase REST calls, all intercepted in-memory; tables: ${touched.join(', ')})`);
console.log('======================================================');
