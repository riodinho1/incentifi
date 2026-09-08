/**
 * INDEXER — V4 discovery warm-up resumes from persisted state (2026-09-08).
 *
 * Before: the scanned-through cursor lived in memory, so every restart rescanned from block
 * 54,600,000 in 5,000-block getLogs chunks through a rate-limited public RPC. Now each chunk's cursor
 * is upserted into `indexer_cursors`, every discovered token is in `indexed_tokens`, and a fresh
 * process rebuilds its caches from those two tables and continues from the cursor.
 *
 * Offline: a fake RPC serves TokenLaunched logs (one GenericSell token, one legible token) and counts
 * eth_getLogs calls; the Supabase mock plays both tables. Floors and chunk size are set through env
 * (V4_DISCOVERY_FLOOR_BLOCK=1000, LEGIBLE_DISCOVERY_FLOOR_BLOCK=2000, chunk 2000).
 *   1. run 1 (head 6000): getLogs chunks are 2,000 blocks; cursors persisted after every chunk; both
 *      tokens recorded with pool_id
 *   2. "restart": in-memory state dropped; advanceV4Discovery(6000) makes ZERO getLogs calls, the
 *      caches come back from indexed_tokens, discovery is ready through 6000
 *   3. head moves to 8000: only 6001-8000 is scanned (one chunk per factory), cursors advance
 *   4. an incomplete indexed_tokens row (no pool_id) -> cursors ignored, full rescan (correctness first)
 *   5. no indexer_cursors table -> behaves as before (scans from the floors), warns once
 *   6. an indexed_tokens upsert FAILS for a discovered token -> the cursor is NOT advanced past it
 *      (in-memory discovery still completes; a restart rescans from the last good cursor)
 *
 * Run: node test/indexer-discovery-resume.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { encodeAbiParameters, parseAbiParameters, getAddress, keccak256, toHex, toFunctionSelector } from 'viem';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

const OLD_FACTORY = getAddress('0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0');
const OLD_HOOK = getAddress('0xC5Ef9Cb8c95cd8540E71b6D4c00a90257625a888');
const LEGIBLE_FACTORY = getAddress('0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const LEGIBLE_HOOK = getAddress('0x921d0bE20A21e5A687734b4dF6302EA55BD168C0');
const TOKEN_G = getAddress('0x00000000000000000000000000000000000000A1'); // GenericSell, launched at block 1500
const TOKEN_L = getAddress('0x00000000000000000000000000000000000000B1'); // legible, launched at block 2500
const CREATOR = getAddress('0x0000000000000000000000000000000000000CC1');
const POOL_G = keccak256(toHex('pool-g')); const POOL_L = keccak256(toHex('pool-l'));
const LAUNCH_TOPIC = keccak256(toHex('TokenLaunched(address,address,bytes32)'));
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const sel = (sig) => toFunctionSelector(sig);
const hex = (n) => '0x' + BigInt(n).toString(16);
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();

let head = 6000n;
const getLogsCalls = []; // { address, from, to }
const rpc = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const one = (item) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: item.id, result });
      switch (item.method) {
        case 'eth_chainId': return ok(hex(4663));
        case 'eth_blockNumber': return ok(hex(head));
        case 'eth_getLogs': {
          const f = item.params[0]; const from = BigInt(f.fromBlock); const to = BigInt(f.toBlock); const address = getAddress(f.address);
          getLogsCalls.push({ address, from, to });
          const logs = [];
          const mk = (token, blk, poolId) => ({ address: address.toLowerCase(), topics: [LAUNCH_TOPIC, pad(token), pad(CREATOR)], data: poolId, blockNumber: hex(blk), transactionHash: '0x' + '55'.repeat(32), transactionIndex: '0x0', blockHash: '0x' + '66'.repeat(32), logIndex: '0x0', removed: false });
          if (address === OLD_FACTORY && from <= 1500n && to >= 1500n) logs.push(mk(TOKEN_G, 1500n, POOL_G));
          if (address === LEGIBLE_FACTORY && from <= 2500n && to >= 2500n) logs.push(mk(TOKEN_L, 2500n, POOL_L));
          return ok(logs);
        }
        case 'eth_call': {
          const s = item.params[0].data.slice(0, 10); const to = getAddress(item.params[0].to);
          if (s === sel('function symbol()')) return ok(enc('string', [to === TOKEN_G ? 'GEN' : 'LEG']));
          if (s === sel('function hook()')) return ok(enc('address', [OLD_HOOK]));
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
process.env.V4_DISCOVERY_FLOOR_BLOCK = '1000';
process.env.LEGIBLE_DISCOVERY_FLOOR_BLOCK = '2000';
process.env.V4_DISCOVERY_CHUNK_BLOCKS = '2000';
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v; for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://indexer-resume-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'indexer-resume-test-key';
let mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, { upsertKeys: { indexer_cursors: ['name'], indexed_tokens: ['mint_address'], tokens: ['mint_address'] } });
// supabase-js captures `fetch` when the client is created (at indexer import), so fault injection has to be
// wired in NOW: `fault(url, init)` may return a Response to short-circuit a REST call, else the mock answers.
let fault = null;
globalThis.fetch = async (url, init) => { const r = fault ? await fault(url, init) : null; return r || mock.fetchImpl(url, init); };

const indexer = await import('../scripts/evm-indexer.mjs');
console.log('======================================================');
console.log('  INDEXER DISCOVERY RESUME (persisted cursors + indexed_tokens)');
console.log('======================================================\n');
try {
  // 1. first run
  await indexer.advanceV4Discovery(head);
  const chunks = getLogsCalls.map((c) => `${c.address === OLD_FACTORY ? 'G' : 'L'}:${c.from}-${c.to}`);
  assert.deepEqual(chunks, ['G:1000-3000', 'G:3001-5001', 'G:5002-6000', 'L:2000-4000', 'L:4001-6000'], '2,000-block chunks from each floor');
  const cursors = Object.fromEntries(mock.table('indexer_cursors').map((r) => [r.name, r.block]));
  assert.deepEqual(cursors, { v4_discovery_generic_sell: 6000, v4_discovery_legible: 6000 }, 'cursors persisted through the head');
  const idx = mock.table('indexed_tokens');
  assert.equal(idx.length, 2);
  const rowL = idx.find((r) => r.mint_address === TOKEN_L);
  assert.equal(rowL.venue, 'legible'); assert.equal(rowL.pool_id, POOL_L.toLowerCase()); assert.equal(rowL.hook_address, LEGIBLE_HOOK.toLowerCase()); assert.equal(rowL.first_block, 2500);
  assert.ok(indexer.isV4DiscoveryReadyThrough(6000n));
  console.log('1. run 1: 5 chunks of <= 2,000 blocks, cursors persisted (6000/6000), 2 tokens in indexed_tokens with pool ids  OK');

  // 2. restart: fresh in-memory state, same DB -> no rescan
  indexer._resetDiscoveryStateForTests();
  assert.equal(indexer.isV4DiscoveryReadyThrough(6000n), false, 'fresh process knows nothing yet');
  getLogsCalls.length = 0;
  const restored = await indexer.restoreDiscoveryState();
  assert.equal(restored.restored, true); assert.equal(restored.tokens, 2);
  await indexer.advanceV4Discovery(head);
  assert.equal(getLogsCalls.length, 0, 'NO getLogs after a restart with persisted state');
  assert.ok(indexer.isV4DiscoveryReadyThrough(6000n), 'ready through the persisted cursor');
  const st = indexer.getV4DiscoveryState();
  assert.equal(st.tokens[TOKEN_L.toLowerCase()], 'LEG'); assert.equal(st.tokens[TOKEN_G.toLowerCase()], 'GEN');
  assert.equal(st.pools[POOL_L.toLowerCase()], TOKEN_L.toLowerCase(), 'poolId -> token cache restored (trade indexing depends on it)');
  assert.equal(st.hooks[TOKEN_G.toLowerCase()], OLD_HOOK.toLowerCase());
  console.log('2. restart: caches rebuilt from indexed_tokens, 0 getLogs, ready through 6000  OK');

  // 3. head advances: only the new range is scanned
  head = 8000n;
  await indexer.advanceV4Discovery(head);
  assert.deepEqual(getLogsCalls.map((c) => `${c.address === OLD_FACTORY ? 'G' : 'L'}:${c.from}-${c.to}`), ['G:6001-8000', 'L:6001-8000']);
  assert.deepEqual(Object.fromEntries(mock.table('indexer_cursors').map((r) => [r.name, r.block])), { v4_discovery_generic_sell: 8000, v4_discovery_legible: 8000 });
  console.log('3. head 6000 -> 8000: exactly 6001-8000 scanned per factory, cursors advanced  OK');

  // 4. incomplete indexed_tokens row -> cursors ignored, full rescan
  indexer._resetDiscoveryStateForTests();
  const rowG = mock.table('indexed_tokens').find((r) => r.mint_address === TOKEN_G); const savedPool = rowG.pool_id; rowG.pool_id = null;
  getLogsCalls.length = 0;
  const r4 = await indexer.restoreDiscoveryState();
  assert.equal(r4.restored, false); assert.match(r4.reason, /incomplete/);
  await indexer.advanceV4Discovery(head);
  assert.equal(getLogsCalls[0].from, 1000n, 'rescan from the floor when the cache cannot be trusted');
  assert.ok(indexer.isV4DiscoveryReadyThrough(8000n));
  rowG.pool_id = savedPool;
  console.log('4. indexed_tokens row without pool_id -> cursors ignored, full rescan (correctness first)  OK');

  // 5. no cursors table -> old behaviour, no throw
  indexer._resetDiscoveryStateForTests();
  let cursorHits = 0;
  fault = (url) => { if (String(url).includes('/indexer_cursors')) { cursorHits++; return new Response(JSON.stringify({ message: 'relation "public.indexer_cursors" does not exist', code: '42P01' }), { status: 404, headers: { 'Content-Type': 'application/json' } }); } return null; };
  getLogsCalls.length = 0;
  const r5 = await indexer.restoreDiscoveryState();
  assert.equal(r5.restored, false); assert.match(r5.reason, /does not exist/);
  await indexer.advanceV4Discovery(head); // persist attempts fail silently (warn once), discovery still completes
  assert.ok(getLogsCalls.length >= 2 && indexer.isV4DiscoveryReadyThrough(8000n));
  assert.ok(cursorHits >= 3, `restore read + per-chunk writes all hit the missing table (${cursorHits})`);
  fault = null;
  console.log('5. indexer_cursors missing -> scans from the floors, warns once, never throws  OK');

  // 6. indexed_tokens write fails for the legible token -> cursors must not move past block 2500
  indexer._resetDiscoveryStateForTests();
  mock.table('indexer_cursors').length = 0; mock.table('indexed_tokens').length = 0;
  fault = (url, init) => {
    if (String(url).includes('/indexed_tokens') && init && init.method && init.method !== 'GET' && String(init.body || '').toLowerCase().includes(TOKEN_L.toLowerCase())) {
      return new Response(JSON.stringify({ message: 'simulated write failure' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return null;
  };
  getLogsCalls.length = 0;
  await indexer.advanceV4Discovery(head);
  assert.ok(indexer.isV4DiscoveryReadyThrough(8000n), 'in-memory discovery still completes');
  const c6 = Object.fromEntries(mock.table('indexer_cursors').map((r) => [r.name, r.block]));
  assert.equal(c6.v4_discovery_generic_sell, 8000, 'generic-sell scan finished before the failure and was persisted');
  assert.ok(c6.v4_discovery_legible === undefined || c6.v4_discovery_legible < 2500, `legible cursor must stay below the unrecorded token (got ${c6.v4_discovery_legible})`);
  fault = null;
  // restart: the legible token is rediscovered
  indexer._resetDiscoveryStateForTests(); getLogsCalls.length = 0;
  await indexer.advanceV4Discovery(head);
  assert.ok(getLogsCalls.some((c) => c.address === LEGIBLE_FACTORY && c.from <= 2500n && c.to >= 2500n), 'restart rescans the range holding the unrecorded token');
  assert.equal(mock.table('indexed_tokens').length, 2, 'both tokens recorded after the retry');
  console.log('6. indexed_tokens write failure -> cursor frozen before the token; restart rediscovers it  OK');

  console.log('\nindexer-discovery-resume tests passed');
} finally {
  rpc.close();
}
process.exit(0);
