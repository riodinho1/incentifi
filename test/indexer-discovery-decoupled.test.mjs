/**
 * INDEXER — trade indexing of known tokens is NOT blocked behind V4 discovery; a late-discovered token
 * is backfilled from its launch block before its live logs are taken (2026-09-09).
 *
 * Production: a rescan from the floors through 429-ing public RPCs kept every tick in "V4 discovery
 * not ready" for hours, so holder_cost_basis of every known token went stale while the worker paid.
 *
 * Offline fake chain (legible factory + legible hook), floors 1000, chunk 2000:
 *   T1 launched @1500 (pool P1)  - already in indexed_tokens (restored at startup), cursors at 4000
 *   T2 launched @5000 (pool P2)  - NOT yet discovered
 *   hook logs: Bought P1 @3000 (U1), Bought P2 @5500 (U2), Bought P1 @7500 (U1)
 *   1. factory getLogs FAIL (discovery cannot advance): tick 1 still indexes P1's two buys (U1 = 2000),
 *      heartbeat ok with a "discovery behind" note, cursor advanced; P2's buy is held back (unknown pool)
 *   2. factory recovers: background discovery finds T2 @5000 <= trade cursor -> queued for backfill;
 *      the next tick backfills P2 from 5000 with a poolId-filtered getLogs (U2 = 1000, once), releases
 *      the pool, heartbeat has no lag note
 *   3. re-running the same windows adds nothing (idempotent), backfill queue empty
 *
 * Run: node test/indexer-discovery-decoupled.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { encodeAbiParameters, parseAbiParameters, getAddress, keccak256, toHex, toFunctionSelector } from 'viem';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';
// NOTE: nothing from scripts/ is imported statically - legiblePool.mjs reads LEGIBLE_DISCOVERY_FLOOR_BLOCK at import time, so the env below must be set first.

const LEGIBLE_FACTORY = getAddress('0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const LEGIBLE_HOOK = getAddress('0x921d0bE20A21e5A687734b4dF6302EA55BD168C0');
const OLD_FACTORY = getAddress('0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0');
const T1 = getAddress('0x00000000000000000000000000000000000000A1');
const T2 = getAddress('0x00000000000000000000000000000000000000A2');
const U1 = getAddress('0x0000000000000000000000000000000000000111');
const U2 = getAddress('0x0000000000000000000000000000000000000222');
const CREATOR = getAddress('0x0000000000000000000000000000000000000CC1');
const P1 = keccak256(toHex('pool-1')); const P2 = keccak256(toHex('pool-2'));
const E = 10n ** 18n;
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const sel = (sig) => toFunctionSelector(sig);
const hex = (n) => '0x' + BigInt(n).toString(16);
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const LAUNCH_TOPIC = keccak256(toHex('TokenLaunched(address,address,bytes32)'));
const BOUGHT_TOPIC = keccak256(toHex('Bought(bytes32,address,uint256,uint256,uint256,uint256)'));

let head = 8000n;
let factoryFail = true;
const getLogsCalls = [];
// all logs the fake chain has ever emitted
const chainLogs = [
  { address: LEGIBLE_FACTORY, topics: [LAUNCH_TOPIC, pad(T1), pad(CREATOR)], data: P1, block: 1500n },
  { address: LEGIBLE_FACTORY, topics: [LAUNCH_TOPIC, pad(T2), pad(CREATOR)], data: P2, block: 5000n },
  { address: LEGIBLE_HOOK, topics: [BOUGHT_TOPIC, P1, pad(U1)], data: enc('uint256, uint256, uint256, uint256', [E, 1000n * E, E / 100n, E / 100n]), block: 3000n },
  { address: LEGIBLE_HOOK, topics: [BOUGHT_TOPIC, P2, pad(U2)], data: enc('uint256, uint256, uint256, uint256', [E, 1000n * E, E / 100n, E / 100n]), block: 5500n },
  { address: LEGIBLE_HOOK, topics: [BOUGHT_TOPIC, P1, pad(U1)], data: enc('uint256, uint256, uint256, uint256', [E, 1000n * E, E / 100n, E / 100n]), block: 7500n },
];
const topicMatch = (filter, topic) => filter === null || filter === undefined || (Array.isArray(filter) ? filter.some((f) => f.toLowerCase() === topic.toLowerCase()) : filter.toLowerCase() === topic.toLowerCase());
const rpc = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const one = (item) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: item.id, result });
      switch (item.method) {
        case 'eth_chainId': return ok(hex(4663));
        case 'eth_blockNumber': return ok(hex(head));
        case 'eth_getBlockByNumber': return ok({ number: item.params[0] === 'latest' ? hex(head) : item.params[0], timestamp: hex(1_788_900_000n), hash: '0x' + '11'.repeat(32), transactions: [] });
        case 'eth_getLogs': {
          const f = item.params[0]; const address = getAddress(f.address); const from = BigInt(f.fromBlock); const to = f.toBlock === 'latest' ? head : BigInt(f.toBlock);
          getLogsCalls.push({ address, from, to, topics: f.topics || [] });
          if (address === LEGIBLE_FACTORY && factoryFail) return { jsonrpc: '2.0', id: item.id, error: { code: 3, message: 'simulated factory getLogs failure', data: '0x' } };
          const out = chainLogs.filter((l) => l.address === address && l.block >= from && l.block <= to && (f.topics || []).every((t, i) => topicMatch(t, l.topics[i] || '')))
            .map((l, i) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data, blockNumber: hex(l.block), transactionHash: keccak256(toHex(`${l.address}-${l.block}-${i}`)), transactionIndex: '0x0', blockHash: '0x' + '66'.repeat(32), logIndex: hex(i), removed: false }));
          return ok(out);
        }
        case 'eth_call': {
          const s = item.params[0].data.slice(0, 10); const to = getAddress(item.params[0].to);
          if (s === sel('function symbol()')) return ok(enc('string', [to === T1 ? 'T1' : 'T2']));
          if (s === sel('function balanceOf(address)')) { const w = getAddress('0x' + item.params[0].data.slice(34, 74)); return ok(enc('uint256', [w === U1 ? 2000n * E : w === U2 ? 1000n * E : 0n])); }
          if (s === sel('function hook()')) return ok(enc('address', [LEGIBLE_HOOK]));
          if (s === sel('function getBondingCurve(address)')) return ok(enc('address', ['0x0000000000000000000000000000000000000000']));
          return ok('0x' + '0'.repeat(64));
        }
        default: return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: `unsupported: ${item.method}` } };
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));

process.env.RPC_URLS = `http://127.0.0.1:${rpc.address().port}`;
process.env.RPC_GETLOGS_MIN_INTERVAL_MS = '0';
process.env.V4_DISCOVERY_FLOOR_BLOCK = '1000';
process.env.LEGIBLE_DISCOVERY_FLOOR_BLOCK = '1000';
process.env.V4_DISCOVERY_CHUNK_BLOCKS = '2000';
process.env.V4_DISCOVERY_BLOCKING = 'false';
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v; for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://indexer-decoupled-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'indexer-decoupled-test-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, { upsertKeys: { indexer_cursors: ['name'], indexed_tokens: ['mint_address'], tokens: ['mint_address'], holder_cost_basis: ['token_address', 'wallet_address'], token_trades_evm: ['tx_hash'], token_candles_1m: ['token_address', 'bucket_ts'], indexer_heartbeats: ['worker_name'], token_market_snapshots_evm: ['token_address'] } });
globalThis.fetch = mock.fetchImpl;
// T1 known from before; cursors at 4000 (so T2 @5000 is still to be discovered); a dummy earlier trade so recovery resumes from 2998
mock.seed('indexed_tokens', [{ mint_address: T1, symbol: 'T1', venue: 'legible', hook_address: LEGIBLE_HOOK.toLowerCase(), factory_address: LEGIBLE_FACTORY.toLowerCase(), pool_id: P1.toLowerCase(), first_block: 1500 }]);
mock.seed('indexer_cursors', [{ name: 'v4_discovery_generic_sell', block: 4000 }, { name: 'v4_discovery_legible', block: 4000 }]);
mock.seed('token_trades_evm', [{ tx_hash: '0xdummy:0', token_address: T1.toLowerCase(), trader_address: U1.toLowerCase(), side: 'buy', amount_token: 0, amount_eth: 0, price_eth: 0, block_number: 2999, block_time: new Date().toISOString(), applied: true }]);

const indexer = await import('../scripts/evm-indexer.mjs');
const cb = (t, w) => mock.table('holder_cost_basis').find((h) => h.token_address === t.toLowerCase() && h.wallet_address === w.toLowerCase());
const hb = () => mock.table('indexer_heartbeats').find((h) => h.worker_name === 'evm-indexer');
const ix = indexer.createIndexer();

console.log('======================================================');
console.log('  INDEXER DECOUPLED: known-token trades indexed while discovery is behind; late token backfilled');
console.log('======================================================\n');
try {
  // 1. discovery cannot advance (factory getLogs fail) - known pool still indexed
  const r1 = await ix.tick();
  assert.equal(r1.ok, true, `tick 1 ok (${r1.error})`);
  assert.equal(Number(cb(T1, U1)?.token_balance), 2000, "T1's two buys indexed although discovery is behind");
  assert.equal(cb(T2, U2), undefined, "P2 unknown yet: its buy is not taken");
  assert.equal(hb().status, 'ok'); assert.match(hb().message, /Indexed through block 7999; V4 discovery behind/);
  assert.equal(ix.lastPolledBlock, 7999n);
  await indexer.whenDiscoveryIdle();
  assert.equal(indexer.isV4DiscoveryReadyThrough(7999n), false, 'discovery really is behind');
  console.log('1. factory getLogs failing -> tick still indexes P1 (U1 = 2000), heartbeat ok + lag note, cursor 7999  OK');

  // 2. factory recovers -> discovery finds T2 (launched 5000 <= cursor 7999) -> backfill on the next tick
  factoryFail = false; head = 8001n;
  await ix.tick();                  // kicks discovery in the background
  await indexer.whenDiscoveryIdle();
  assert.equal(indexer.isV4DiscoveryReadyThrough(8001n), true, 'discovery caught up in the background');
  assert.ok(indexer.pendingBackfills.has(P2.toLowerCase()), 'T2 queued for backfill');
  assert.equal(cb(T2, U2), undefined, 'still nothing for U2 until the backfill runs');
  getLogsCalls.length = 0; head = 8002n;
  const r3 = await ix.tick();
  assert.equal(r3.ok, true);
  assert.equal(indexer.pendingBackfills.size, 0, 'backfill done, pool released');
  assert.equal(Number(cb(T2, U2)?.token_balance), 1000, "T2's buy @5500 backfilled");
  const backfillCalls = getLogsCalls.filter((c) => c.address === LEGIBLE_HOOK && c.topics[1] && c.topics[1].toLowerCase() === P2.toLowerCase());
  assert.ok(backfillCalls.length >= 1, 'backfill used a poolId topic filter'); assert.equal(backfillCalls[0].from, 5000n, 'from the launch block');
  assert.equal(hb().status, 'ok'); assert.doesNotMatch(hb().message, /discovery behind/);
  console.log(`2. discovery caught up in the background; T2 backfilled from block 5000 with ${backfillCalls.length} poolId-filtered getLogs (U2 = 1000); no lag note  OK`);

  // 3. idempotent
  head = 8003n;
  await ix.tick();
  assert.equal(Number(cb(T1, U1).token_balance), 2000); assert.equal(Number(cb(T2, U2).token_balance), 1000);
  assert.equal(mock.table('token_trades_evm').length, 4, 'dummy + 3 real trades, no duplicates');
  console.log('3. further ticks add nothing (idempotent)  OK');

  console.log('\nindexer-discovery-decoupled tests passed');
} finally {
  await indexer.whenDiscoveryIdle();
  rpc.close();
}
process.exit(0);
