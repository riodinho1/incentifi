/**
 * INDEXER V4 DISCOVERY RETRY TEST — scripts/evm-indexer.mjs createIndexer().tick()
 *
 * Reproduces the 2026-09-07 failure mode and proves the fix:
 *   BEFORE: the V4 TokenLaunched catch-up ran ONCE at startup; if it threw (RPC rate limit),
 *           V4 trade indexing was silently disabled for the process lifetime while V3 indexing
 *           continued and the heartbeat stayed "ok" — so the loss-reward worker's freshness gate
 *           kept passing and it paid a wallet that had fully sold.
 *   AFTER:  V4 discovery is a hard precondition of every tick, resumable per 5,000-block chunk.
 *           While it is not ready the tick fails loudly: heartbeat status "error" (the gate treats
 *           that as stale → epochs blocked) and the cursor does NOT advance; once the RPC recovers
 *           the next tick completes and reports "ok". An empty `tokens` registry no longer
 *           suppresses the heartbeat either.
 *
 * Offline: a tiny local JSON-RPC server stands in for the chain (eth_blockNumber / eth_getLogs),
 * failing eth_getLogs while `phase = 'failing'`; Supabase REST is the in-memory mock used by the
 * fork tests. The indexer module itself is real and unmodified.
 *
 * Run: node test/indexer-v4-discovery-retry.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

console.log('======================================================');
console.log('  INDEXER V4 DISCOVERY RETRY TEST');
console.log('======================================================\n');

// ---- fake chain -----------------------------------------------------------------------------
const FLOOR = 54_600_000n; // must equal V4_DISCOVERY_FLOOR_BLOCK in scripts/evm-indexer.mjs
const HEAD = FLOOR + 12_000n; // 3 discovery chunks (5000/5000/2000) — exercises resumability
const rpcState = { phase: 'failing', getLogsCalls: 0, failAtChunk: 2, chunkSeen: 0 };
const hex = (n) => '0x' + BigInt(n).toString(16);
const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const one = (item) => {
      switch (item.method) {
        case 'eth_chainId': return { jsonrpc: '2.0', id: item.id, result: hex(4663) };
        case 'eth_blockNumber': return { jsonrpc: '2.0', id: item.id, result: hex(HEAD) };
        // PR #21 added a legible-factory isLaunched()/hook() read to discovery; answer every view call
        // with a zero word (false / address(0)) so discovery exercises only the getLogs path under test.
        case 'eth_call': return { jsonrpc: '2.0', id: item.id, result: '0x' + '0'.repeat(64) };
        case 'eth_getLogs': {
          rpcState.getLogsCalls += 1;
          rpcState.chunkSeen += 1;
          // Fail from the Nth chunk on while "failing" — chunk 1 succeeds so progress is committed.
          if (rpcState.phase === 'failing' && rpcState.chunkSeen >= rpcState.failAtChunk) {
            return { jsonrpc: '2.0', id: item.id, error: { code: -32000, message: 'rate limited (test)' } };
          }
          return { jsonrpc: '2.0', id: item.id, result: [] };
        }
        default: return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: `unsupported in fake rpc: ${item.method}` } };
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
const RPC_URL = `http://127.0.0.1:${rpcServer.address().port}`;
process.env.RPC_GETLOGS_MIN_INTERVAL_MS = '0'; // no getLogs pacing in tests
process.env.VITE_EVM_RPC_URL = RPC_URL; // .env.local does not define this key, so it survives the indexer's loader
process.env.V4_DISCOVERY_CHUNK_BLOCKS = '5000';
process.env.V4_DISCOVERY_BLOCKING = 'true'; // this test asserts the blocking precondition; the default is now decoupled (see indexer-discovery-decoupled.test.mjs) // this test's chunk arithmetic (3 chunks of 5,000/5,000/2,000) predates the 2,000 default

// ---- Supabase mock (installed BEFORE the indexer is imported) ---------------------------------
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v;
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://indexer-retry-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'indexer-retry-test-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, { upsertKeys: { indexer_heartbeats: ['worker_name'] } });
globalThis.fetch = mock.fetchImpl;
// tokens registry EMPTY on purpose (see "no early return" fix); no prior trades → INIT path (head - 50)

const indexer = await import('../scripts/evm-indexer.mjs');
const idx = indexer.createIndexer();
const heartbeat = () => mock.table('indexer_heartbeats').find((r) => r.worker_name === 'evm-indexer');

// ---- Tick 1: RPC failing mid-catch-up -----------------------------------------------------------
console.log('Testing [1/4] Tick while V4 discovery cannot complete: heartbeat=error, cursor frozen...');
const r1 = await idx.tick();
assert.equal(r1.ok, false, 'tick must report failure');
assert.match(r1.error, /V4 discovery not ready/, 'failure must name V4 discovery as the cause');
const hb1 = heartbeat();
assert.ok(hb1, 'a heartbeat row must still be written on failure');
assert.equal(hb1.status, 'error', 'heartbeat status must be "error" so the freshness gate blocks the worker');
assert.match(hb1.message, /V4 discovery not ready/);
const cursorAfterFail = idx.lastPolledBlock; // INIT set it to HEAD-50; the failed tick must not advance past it
assert.equal(cursorAfterFail, HEAD - 50n, 'cursor must stay at its initial value after a failed tick');
console.log(`  ✓ tick.ok=false; heartbeat status=${hb1.status} "${hb1.message.slice(0, 70)}…"; cursor=${cursorAfterFail}\n`);

console.log('Testing [2/4] Resumability: progress from the chunk that DID succeed is kept...');
assert.equal(indexer.isV4DiscoveryReadyThrough(FLOOR + 5000n), true, 'first 5,000-block chunk must be committed');
assert.equal(indexer.isV4DiscoveryReadyThrough(FLOOR + 5001n), false, 'nothing beyond the failed chunk may be marked scanned');
assert.equal(indexer.isV4DiscoveryReadyThrough(HEAD), false);
console.log(`  ✓ scanned through ${FLOOR + 5000n}, not beyond (getLogs calls so far: ${rpcState.getLogsCalls})\n`);

// ---- Tick 2: RPC recovered ------------------------------------------------------------------------
console.log('Testing [3/4] Next tick after the RPC recovers: discovery completes, heartbeat=ok, cursor advances...');
rpcState.phase = 'healthy';
const callsBefore = rpcState.getLogsCalls;
const r2 = await idx.tick();
assert.equal(r2.ok, true, `tick must succeed once the RPC is healthy (got ${r2.error})`);
assert.equal(r2.indexedThrough, HEAD);
assert.equal(indexer.isV4DiscoveryReadyThrough(HEAD), true, 'discovery must now cover the head');
const hb2 = heartbeat();
assert.equal(hb2.status, 'ok');
assert.match(hb2.message, new RegExp(`Indexed through block ${HEAD}`));
assert.equal(idx.lastPolledBlock, HEAD, 'cursor must advance to the tick window end');
console.log(`  ✓ heartbeat ok "${hb2.message}"; cursor=${idx.lastPolledBlock}; resumed with only ${rpcState.getLogsCalls - callsBefore} more getLogs call(s) (remaining chunks, not a restart from the floor)\n`);

console.log('Testing [4/4] Empty `tokens` registry no longer suppresses the heartbeat (tick 2 above ran with zero V3 tokens)...');
assert.equal(mock.table('tokens').length, 0);
assert.equal(hb2.status, 'ok');
console.log('  ✓ heartbeat written with zero registered V3 tokens\n');

rpcServer.close();
console.log('======================================================');
console.log('  ALL 4/4 INDEXER V4 DISCOVERY RETRY TESTS PASSED');
console.log('======================================================');
process.exit(0);
