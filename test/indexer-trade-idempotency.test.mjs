/**
 * INDEXER — trade application is idempotent and holder balances reconcile from chain (2026-09-09).
 *
 * Production: holder 0x6e5e24f8… of INCENTIFI had ONE buy on chain and ONE trade row, but a DB
 * balance of exactly 2x. processBuyTrade updated holder_cost_basis BEFORE writing the trade row, so a
 * failure in between re-applied the buy on the next rescan. Now the trade row is claimed first
 * (applied = false), the holder is updated, then applied = true; a rescan re-applies only rows that
 * are still applied = false.
 *   1. the same buy processed twice -> counted once (one trade row, applied = true)
 *   2. a claimed-but-unapplied row (crash between claim and holder update) -> applied exactly once
 *   3. a sell processed twice -> counted once; is_underwater_sale filled in when applied
 *   4. reconcileHolderBalances at a pinned block: DB 2x chain -> lowered to chain with invested scaled
 *      (average cost preserved) + audit row; disputed read (A: 0, B: real) -> untouched; chain above DB ->
 *      logged only; every read pinned to the requested block
 *
 * Run: node test/indexer-trade-idempotency.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, getAddress } from 'viem';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

const TOKEN = getAddress('0x00000000000000000000000000000000000000E3');
const H1 = getAddress('0x0000000000000000000000000000000000000111');
const H2 = getAddress('0x0000000000000000000000000000000000000222');
const H3 = getAddress('0x0000000000000000000000000000000000000333');
const H4 = getAddress('0x0000000000000000000000000000000000000444');
const E = 10n ** 18n;
const sel = (sig) => toFunctionSelector(sig);
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const hex = (n) => '0x' + BigInt(n).toString(16);
const truth = { [H1]: 1300n * E, [H2]: 4000n * E, [H3]: 5000n * E, [H4]: 9000n * E };
const balanceCalls = [];
function serve(endpoint) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        const one = (item) => {
          const ok = (result) => ({ jsonrpc: '2.0', id: item.id, result });
          switch (item.method) {
            case 'eth_chainId': return ok(hex(4663));
            case 'eth_blockNumber': return ok(hex(58_120_000n));
            case 'eth_call': {
              const { to, data } = item.params[0];
              if (getAddress(to) === TOKEN && data.slice(0, 10) === sel('function balanceOf(address)')) {
                const wallet = getAddress('0x' + data.slice(34, 74));
                balanceCalls.push({ endpoint, wallet, blockTag: item.params[1] });
                if (wallet === H3 && endpoint === 'A') return ok(enc('uint256', [0n])); // A lies about H3
                return ok(enc('uint256', [truth[wallet] ?? 0n]));
              }
              return { jsonrpc: '2.0', id: item.id, error: { code: 3, message: 'unmocked call', data: '0x' } };
            }
            default: return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: `unsupported: ${item.method}` } };
          }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const A = await serve('A'); const B = await serve('B');
process.env.RPC_URLS = `${A.url},${B.url}`;
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v; for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://indexer-idempotency-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'indexer-idempotency-test-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, { upsertKeys: { holder_cost_basis: ['token_address', 'wallet_address'], token_trades_evm: ['tx_hash'], token_candles_1m: ['token_address', 'bucket_ts'], indexer_heartbeats: ['worker_name'] } });
globalThis.fetch = mock.fetchImpl;

const indexer = await import('../scripts/evm-indexer.mjs');
const tok = TOKEN.toLowerCase();
const cb = (w) => mock.table('holder_cost_basis').find((h) => h.token_address === tok && h.wallet_address === w.toLowerCase());
const trade = (id) => mock.table('token_trades_evm').find((t) => t.tx_hash === id);
const now = new Date().toISOString();
const logs = [];

console.log('======================================================');
console.log('  INDEXER TRADE IDEMPOTENCY + HOLDER RECONCILIATION');
console.log('======================================================\n');
try {
  // 1. same buy twice
  await indexer.processBuyTrade(TOKEN, 'TST', H1, 1000, 1.0, 0.01, 0.01, '0xaaa:1', 100n, now);
  await indexer.processBuyTrade(TOKEN, 'TST', H1, 1000, 1.0, 0.01, 0.01, '0xaaa:1', 100n, now);
  assert.equal(Number(cb(H1).token_balance), 1000, 'buy counted once'); assert.equal(Number(cb(H1).total_invested_eth), 1.0);
  assert.equal(mock.table('token_trades_evm').filter((t) => t.tx_hash === '0xaaa:1').length, 1, 'one trade row'); assert.equal(trade('0xaaa:1').applied, true);
  console.log('1. the same buy processed twice -> balance 1000, one trade row, applied=true  OK');

  // 2. claimed but never applied (crash between claim and holder update)
  mock.seed('token_trades_evm', [{ tx_hash: '0xbbb:0', token_address: tok, trader_address: H1.toLowerCase(), side: 'buy', amount_token: 500, amount_eth: 0.5, price_eth: 0.00098, creator_fee_eth: 0.005, loss_pool_fee_eth: 0.005, is_underwater_sale: false, block_number: 101, block_time: now, applied: false }]);
  await indexer.processBuyTrade(TOKEN, 'TST', H1, 500, 0.5, 0.005, 0.005, '0xbbb:0', 101n, now);
  assert.equal(Number(cb(H1).token_balance), 1500, 'half-applied row applied exactly once'); assert.equal(trade('0xbbb:0').applied, true);
  await indexer.processBuyTrade(TOKEN, 'TST', H1, 500, 0.5, 0.005, 0.005, '0xbbb:0', 101n, now);
  assert.equal(Number(cb(H1).token_balance), 1500, 'and never again');
  console.log('2. claimed-but-unapplied row -> applied once, then ignored  OK');

  // 3. sell twice (price above cost: not underwater)
  await indexer.processSellTrade(TOKEN, 'TST', H1, 200, 0.4, 0.004, 0.004, '0xccc:2', 102n, now);
  await indexer.processSellTrade(TOKEN, 'TST', H1, 200, 0.4, 0.004, 0.004, '0xccc:2', 102n, now);
  assert.equal(Number(cb(H1).token_balance), 1300, 'sell counted once'); assert.equal(trade('0xccc:2').applied, true); assert.equal(trade('0xccc:2').is_underwater_sale, false, 'underwater flag filled in at apply time');
  console.log('3. the same sell processed twice -> balance 1300, is_underwater_sale recorded  OK');

  // 4. reconciliation at a pinned block
  for (const [i, [w, bal, inv]] of [[H2, 8000, 8], [H3, 5000, 5], [H4, 6000, 6]].entries()) mock.seed('holder_cost_basis', [{ id: 100 + i, token_address: tok, wallet_address: w.toLowerCase(), token_balance: bal, total_invested_eth: inv, avg_cost_basis_eth: inv / bal, is_eligible: true, is_underwater_seller: false }]);
  balanceCalls.length = 0;
  const summary = await indexer.reconcileHolderBalances({ tokens: [TOKEN], blockNumber: 58_119_000n, log: (m) => logs.push(m), read: { delayMs: 0 } });
  assert.equal(summary.holders, 4); assert.equal(summary.lowered, 1); assert.equal(summary.disputed, 1); assert.equal(summary.chainHigher, 1); assert.equal(summary.errors, 0);
  assert.equal(Number(cb(H1).token_balance), 1300, 'H1 matches chain: untouched');
  assert.equal(Number(cb(H2).token_balance), 4000, 'H2 lowered from the doubled 8000 to the chain 4000'); assert.equal(Number(cb(H2).total_invested_eth), 4, 'invested scaled by the same ratio (cost basis preserved)');
  assert.equal(Number(cb(H3).token_balance), 5000, 'H3 disputed (A: 0, B: 5000): untouched'); assert.equal(Number(cb(H3).total_invested_eth), 5);
  assert.equal(Number(cb(H4).token_balance), 6000, 'H4: chain 9000 > DB 6000 -> only logged');
  const audit = mock.table('holder_balance_reconciliations');
  assert.equal(audit.length, 1); assert.equal(audit[0].wallet_address, H2.toLowerCase()); assert.equal(audit[0].db_balance, 8000); assert.equal(audit[0].chain_balance, 4000); assert.equal(audit[0].block_number, 58_119_000); assert.equal(audit[0].action, 'lowered');
  assert.ok(logs.some((l) => /DISPUTED read/.test(l) && l.includes(H3.toLowerCase())), 'disputed logged');
  assert.ok(logs.some((l) => /missed buy/.test(l) && l.includes(H4.toLowerCase())), 'chain-higher logged');
  assert.ok(balanceCalls.every((c) => c.blockTag === hex(58_119_000n)), 'every read pinned to the requested block');
  assert.deepEqual(balanceCalls.filter((c) => c.wallet === H2).map((c) => c.endpoint), ['A', 'B'], 'the decrease of H2 was confirmed on B');
  assert.deepEqual(balanceCalls.filter((c) => c.wallet === H4).map((c) => c.endpoint), ['A'], 'no confirmation needed when chain >= DB');
  console.log('4. reconcile @ pinned block: 2x row lowered + audited, disputed untouched, chain-higher logged  OK');

  console.log('\nindexer-trade-idempotency tests passed');
} finally {
  A.srv.close(); B.srv.close();
}
process.exit(0);
