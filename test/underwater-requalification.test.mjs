/**
 * UNDERWATER-SELLER RE-QUALIFICATION TEST — scripts/evm-indexer.mjs processBuyTrade().
 *
 * Rule under test: a wallet disqualified by an underwater sell (is_underwater_seller=true,
 * is_eligible=false) is re-qualified by a later buy ONLY if it had fully exited the position
 * first. A buy while still holding part of the disqualified position must NOT clear the flags.
 *
 * Before this rule, processBuyTrade upserted is_eligible:true / is_underwater_seller:false on
 * EVERY buy — so a dust-sized re-buy after a partial loss-sale re-qualified the retained
 * position, and the loss-reward worker (which filters on these two flags plus
 * avg_cost_basis_eth > benchmark) would pay 10% of that position's unrealized loss.
 *
 * These run the REAL exported processBuyTrade/processSellTrade against the same in-memory
 * PostgREST mock the fork tests use (test/hardhat/support/supabase-rest-mock.mjs), so the
 * real dedup/read/upsert code path executes; only the database is mocked. Trade events are
 * synthetic inputs here (the real mainnet TESTINGG fixture in test/v4-trade-replay.test.mjs
 * only contains FULL exits, which this rule deliberately allows — see scenario 2).
 *
 * Run: node test/underwater-requalification.test.mjs   (offline; part of `npm test`)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

console.log('======================================================');
console.log('  UNDERWATER-SELLER RE-QUALIFICATION TEST');
console.log('======================================================\n');

// The indexer's own .env.local loader overwrites SUPABASE_URL at import; mirror it so the
// mock's "unexpected host" warning stays quiet. The mock intercepts by path regardless of
// host, so no call can reach a real project either way.
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://requalification-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'requalification-test-service-role-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, {
  upsertKeys: {
    holder_cost_basis: ['token_address', 'wallet_address'],
    token_trades_evm: ['tx_hash'],
    token_candles_1m: ['symbol', 'bucket_ts'],
  },
});
globalThis.fetch = mock.fetchImpl;

const { processBuyTrade, processSellTrade, FULL_EXIT_DUST_TOKENS } = await import('../scripts/evm-indexer.mjs');

const TOKEN = '0x00000000000000000000000000000000000000aa';
const SYMBOL = 'RQT';
let seq = 0;
const nextId = () => `0x${(++seq).toString(16).padStart(64, '0')}:0`;
const T0 = Date.parse('2026-09-06T00:00:00.000Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
// Real-mechanics helper: buys pass GROSS eth (fees included) exactly as Bought.ethIn /
// TokensPurchased.ethInGross do; 1% creator + 1% loss-pool fee, as on-chain.
const buy = (wallet, tokens, grossEth, minute) => processBuyTrade(TOKEN, SYMBOL, wallet, tokens, grossEth, grossEth * 0.01, grossEth * 0.01, nextId(), 1_000_000 + seq, at(minute));
const sell = (wallet, tokens, netEth, minute) => processSellTrade(TOKEN, SYMBOL, wallet, tokens, netEth, netEth * 0.01, netEth * 0.01, nextId(), 1_000_000 + seq, at(minute));
const row = (wallet) => mock.table('holder_cost_basis').find((r) => r.wallet_address === wallet && r.token_address === TOKEN);
const flags = (wallet) => { const r = row(wallet); return { eligible: r.is_eligible, underwater: r.is_underwater_seller, balance: r.token_balance }; };

// ----------------------------------------------------------------------------
// Scenario 1 — THE FIX: partial underwater sell, then a dust buy -> STAYS disqualified.
// ----------------------------------------------------------------------------
console.log('Testing [1/5] Partial underwater sell, then a tiny buy: disqualification must SURVIVE...');
{
  const W = '0x0000000000000000000000000000000000000001';
  await buy(W, 100, 10, 0);                 // basis 0.1 ETH/token
  await sell(W, 50, 50 * 0.05, 1);          // sells HALF at 0.05 < 0.1 -> underwater -> disqualified, 50 tokens retained
  assert.deepEqual(flags(W), { eligible: false, underwater: true, balance: 50 }, 'partial underwater sell disqualifies');
  await buy(W, 1, 1 * 0.05, 2);             // dust re-buy while still holding 50
  const f = flags(W);
  assert.equal(f.underwater, true, 'a buy while still holding the disqualified position must NOT clear is_underwater_seller');
  assert.equal(f.eligible, false, '…nor re-enable is_eligible');
  assert.equal(f.balance, 51);
  console.log(`  ✓ after dust buy: eligible=${f.eligible} underwater_seller=${f.underwater} balance=${f.balance} (was: re-qualified on any buy)\n`);
}

// ----------------------------------------------------------------------------
// Scenario 2 — the allowed case: FULL exit, then a fresh buy -> re-qualified.
// (This is exactly what the real W1 wallet did on TESTINGG — every disqualifying sell was a
//  full exit — which is why the mainnet replay fixture does NOT flip under this rule.)
// ----------------------------------------------------------------------------
console.log('Testing [2/5] Full exit after an underwater sell, then a fresh buy: re-qualified...');
{
  const W = '0x0000000000000000000000000000000000000002';
  await buy(W, 100, 10, 0);
  await sell(W, 100, 100 * 0.05, 1);        // sells EVERYTHING at a loss
  assert.deepEqual(flags(W), { eligible: false, underwater: true, balance: 0 }, 'full underwater exit disqualifies');
  await buy(W, 10, 10 * 0.05, 2);           // fresh entry
  const f = flags(W);
  assert.deepEqual({ eligible: f.eligible, underwater: f.underwater }, { eligible: true, underwater: false }, 'a fresh entry after a full exit starts clean');
  console.log(`  ✓ after fresh buy: eligible=${f.eligible} underwater_seller=${f.underwater} balance=${f.balance}\n`);
}

// ----------------------------------------------------------------------------
// Scenario 3 — no false positives: a PROFITABLE partial sell never disqualifies, and a
// later buy keeps the wallet eligible.
// ----------------------------------------------------------------------------
console.log('Testing [3/5] Profitable partial sell then buy: stays eligible throughout...');
{
  const W = '0x0000000000000000000000000000000000000003';
  await buy(W, 100, 10, 0);                 // basis 0.1
  await sell(W, 50, 50 * 0.2, 1);           // sells half at 0.2 > 0.1 -> NOT underwater
  assert.deepEqual(flags(W), { eligible: true, underwater: false, balance: 50 });
  await buy(W, 5, 5 * 0.2, 2);
  const f = flags(W);
  assert.deepEqual({ eligible: f.eligible, underwater: f.underwater }, { eligible: true, underwater: false });
  console.log(`  ✓ eligible=${f.eligible} underwater_seller=${f.underwater} balance=${f.balance}\n`);
}

// ----------------------------------------------------------------------------
// Scenario 4 — the disqualification stays sticky across MULTIPLE partial buys, and only a
// genuine full exit (sell the remainder) followed by a buy clears it.
// ----------------------------------------------------------------------------
console.log('Testing [4/5] Sticky across repeated partial buys; cleared only after a genuine full exit...');
{
  const W = '0x0000000000000000000000000000000000000004';
  await buy(W, 100, 10, 0);
  await sell(W, 40, 40 * 0.05, 1);          // partial underwater -> disqualified, 60 retained
  await buy(W, 1, 0.05, 2);
  await buy(W, 2, 0.10, 3);
  await buy(W, 3, 0.15, 4);
  let f = flags(W);
  assert.deepEqual({ eligible: f.eligible, underwater: f.underwater, balance: f.balance }, { eligible: false, underwater: true, balance: 66 }, 'three partial buys must not clear it');
  await sell(W, 66, 66 * 0.05, 5);          // full exit (still at a loss)
  assert.equal(flags(W).balance, 0);
  await buy(W, 10, 0.5, 6);                 // fresh entry
  f = flags(W);
  assert.deepEqual({ eligible: f.eligible, underwater: f.underwater }, { eligible: true, underwater: false }, 'cleared only after the genuine full exit');
  console.log(`  ✓ three partial buys: still disqualified; after full exit + buy: eligible=${f.eligible} underwater_seller=${f.underwater}\n`);
}

// ----------------------------------------------------------------------------
// Scenario 5 — float residue: two buys, one sell of the exact wei SUM. In JS Numbers the
// balance can come out as ~1e-9 tokens instead of 0; that must still count as a full exit
// (FULL_EXIT_DUST_TOKENS), or the wallet would be locked out forever.
// ----------------------------------------------------------------------------
console.log('Testing [5/5] Float-residue full exit still counts as exited...');
{
  const W = '0x0000000000000000000000000000000000000005';
  // Realistic 18-decimal amounts, converted exactly the way the indexer converts log args.
  const aWei = 2420055506429361700355514n;
  const bWei = 9615470796367437101671498n;
  const a = Number(aWei) / 1e18;
  const b = Number(bWei) / 1e18;
  const sum = Number(aWei + bWei) / 1e18;
  await buy(W, a, 0.005, 0);
  await buy(W, b, 0.0198, 1);
  await sell(W, sum, 0.01, 2);              // sells the exact wei sum at a loss
  const residue = flags(W).balance;
  console.log(`  float residue after exact-sum sell: ${residue} tokens (dust threshold ${FULL_EXIT_DUST_TOKENS})`);
  assert.ok(residue <= FULL_EXIT_DUST_TOKENS, 'residue must be within the dust threshold');
  await buy(W, 1000, 0.002, 3);
  const f = flags(W);
  assert.deepEqual({ eligible: f.eligible, underwater: f.underwater }, { eligible: true, underwater: false }, 'a residue-only balance must count as fully exited');
  console.log(`  ✓ after re-buy: eligible=${f.eligible} underwater_seller=${f.underwater}`);

  // The wei-exact case above can (and here does) land on exactly 0, which exercises nothing
  // beyond scenario 2. Force a GUARANTEED nonzero IEEE-754 residue: 0.1 + 0.2 - 0.3 != 0.
  const W6 = '0x0000000000000000000000000000000000000006';
  await buy(W6, 0.1, 0.001, 0);
  await buy(W6, 0.2, 0.002, 1);
  await sell(W6, 0.3, 0.0005, 2);           // exits "everything" at a loss
  const residue6 = flags(W6).balance;
  console.log(`  forced float residue after 0.1 + 0.2 - 0.3 sell: ${residue6} tokens`);
  assert.ok(residue6 > 0, 'this case must leave a NONZERO residue, or the tolerance branch is still untested');
  assert.ok(residue6 <= FULL_EXIT_DUST_TOKENS, 'residue must be within the dust threshold');
  assert.deepEqual({ eligible: flags(W6).eligible, underwater: flags(W6).underwater }, { eligible: false, underwater: true }, 'the exit itself was underwater -> disqualified');
  await buy(W6, 5, 0.01, 3);
  const f6 = flags(W6);
  assert.deepEqual({ eligible: f6.eligible, underwater: f6.underwater }, { eligible: true, underwater: false }, 'a nonzero-but-dust residue must still count as fully exited');
  console.log(`  ✓ nonzero residue ${residue6} treated as exited; after re-buy: eligible=${f6.eligible} underwater_seller=${f6.underwater}\n`);
}

console.log('======================================================');
console.log('  ALL 5/5 UNDERWATER-SELLER RE-QUALIFICATION TESTS PASSED');
console.log('======================================================');
