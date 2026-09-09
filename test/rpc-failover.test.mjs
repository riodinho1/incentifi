/**
 * RPC FAILOVER — scripts/lib/rpcFailover.mjs (and its byte-identical Deno copy in the gateway).
 *
 * Five fake endpoints: A answers `{}` (the body that makes viem 2.55 throw "Cannot read properties of
 * undefined (reading 'error')"), B answers an HTML page with 200, C answers HTTP 503, D never answers,
 * E is healthy. Cases:
 *   1. parseRpcUrls: RPC_URLS list wins, legacy single var, default
 *   2. a request rotates A -> B -> C -> D -> E, logs each switch, succeeds on E; the failed endpoints are
 *      cooling so the next request goes straight to E (no extra fetches)
 *   3. cooldown is exponential per endpoint and expires (fake clock): A is retried after its cooldown
 *   4. HTTP 429, JSON-RPC rate-limit codes, "method not available" and publicnode's archive-token message
 *      rotate; an execution revert (code 3 with data) is FINAL and surfaces as viem's RpcRequestError with
 *      the revert data intact
 *   5. eth_sendRawTransaction: first endpoint answers garbage after (presumably) broadcasting, the next says
 *      "already known" -> the provider returns keccak256(rawTx) instead of throwing
 *   6. through a real viem client: getBlockNumber / readContract-style eth_call work via the transport
 *   7. every endpoint failing -> one final error naming the last reason, after maxAttempts
 *   8. the gateway copy equals the node module except the viem import specifier
 *
 * Run: node test/rpc-failover.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { createPublicClient, keccak256, RpcRequestError } from 'viem';
import { createFailoverRpc, parseRpcUrls, retryableReason } from '../scripts/lib/rpcFailover.mjs';

const hits = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
const eth = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });
function serve(name, handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hits[name]++; handler(JSON.parse(b), res); }); });
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
const A = await serve('A', (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });                     // malformed envelope
const B = await serve('B', (_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>Just a moment...</body></html>'); });
const C = await serve('C', (_q, res) => { res.writeHead(503); res.end('upstream down'); });
const D = await serve('D', () => { /* never answers */ });
let eMode = 'ok';
const E = await serve('E', (q, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (eMode === 'revert' && q.method === 'eth_call') return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' + '00'.repeat(4) } }));
  if (q.method === 'eth_chainId') return res.end(eth(q.id, '0x1237'));
  if (q.method === 'eth_blockNumber') return res.end(eth(q.id, '0x371bde6'));
  if (q.method === 'eth_call') return res.end(eth(q.id, '0x' + '0'.repeat(24) + '78a4e4bcc8ab559b6d3b1cb9eab0a04a2411c726'));
  if (q.method === 'eth_sendRawTransaction') return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'already known' } }));
  res.end(eth(q.id, null));
});
let fMode = 'rate';
const F = await serve('F', (q, res) => {
  res.writeHead(fMode === 'http429' ? 429 : 200, { 'Content-Type': 'application/json' });
  if (fMode === 'http429') return res.end('{"error":"slow down"}');
  if (fMode === 'rate') return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32029, message: 'public rate limit exceeded' } }));
  if (fMode === 'nomethod') return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'the method eth_getLogs does not exist/is not available' } }));
  if (fMode === 'archive') return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32602, message: 'Archive requests require a personal token.' } }));
  if (fMode === 'rawok') return res.end(eth(q.id, '0x' + 'ab'.repeat(32)));
  res.end(eth(q.id, '0x1237'));
});

console.log('======================================================');
console.log('  RPC FAILOVER');
console.log('======================================================\n');
try {
  // 1. url parsing
  assert.deepEqual(parseRpcUrls({ RPC_URLS: ' https://a , https://b,https://a ' }), ['https://a', 'https://b']);
  assert.deepEqual(parseRpcUrls({ VITE_EVM_RPC_URL: 'https://x' }), ['https://x']);
  assert.deepEqual(parseRpcUrls({ EVM_RPC_URL: 'https://y' }), ['https://y']);
  assert.deepEqual(parseRpcUrls({}), ['https://rpc.mainnet.chain.robinhood.com']);
  assert.equal(retryableReason({ jsonError: { code: 3, message: 'execution reverted', data: '0x1234' } }), null, 'revert is final');
  assert.equal(retryableReason({ jsonError: { code: -32000, message: 'execution reverted', data: '0x08c379a0' } }), null, '-32000 WITH data is an execution error');
  assert.match(retryableReason({ jsonError: { code: -32000, message: 'header not found' } }), /rpc error -32000/, '-32000 without data is retryable');
  console.log('1. parseRpcUrls + retryableReason classification  OK');

  // 2. rotation A -> B -> C -> D -> E
  const logs = [];
  let clock = 1_000_000;
  const rpc = createFailoverRpc([A.url, B.url, C.url, D.url, E.url], { timeoutMs: 400, log: (m) => logs.push(m), now: () => clock, sleep: async (ms) => { clock += ms; }, cooldownBaseMs: 2000, name: 'test' });
  const r1 = await rpc.provider.request({ method: 'eth_chainId', params: [] });
  assert.equal(r1, '0x1237');
  assert.deepEqual([hits.A, hits.B, hits.C, hits.D, hits.E], [1, 1, 1, 1, 1], 'each endpoint tried once, in order');
  assert.equal(rpc.state.activeUrl, E.url);
  assert.equal(rpc.state.switches, 4);
  const switchLines = logs.filter((l) => l.includes('-> switching to'));
  assert.equal(switchLines.length, 4);
  assert.match(switchLines[0], /malformed response: not a JSON-RPC envelope/);
  assert.match(switchLines[1], /malformed response: non-JSON body: <html>/);
  assert.match(switchLines[2], /HTTP 503/);
  assert.match(switchLines[3], /timeout/);
  assert.ok(logs.some((l) => /using .*\(5 endpoint\(s\) configured\)/.test(l)), 'announces the active endpoint');
  // next request: A-D cooling -> straight to E
  await rpc.provider.request({ method: 'eth_blockNumber', params: [] });
  assert.deepEqual([hits.A, hits.B, hits.C, hits.D, hits.E], [1, 1, 1, 1, 2], 'cooling endpoints are skipped');
  console.log('2. A(malformed) -> B(html) -> C(503) -> D(timeout) -> E; switches logged; cooling endpoints skipped  OK');

  // 3. cooldown expiry + exponential growth
  clock += 2001; // A's first cooldown (2s) expired; B/C/D still cooling? they also had 2s -> all expired
  await rpc.provider.request({ method: 'eth_blockNumber', params: [] });
  assert.equal(hits.E, 3, 'stays on the endpoint that works (current) even when others are back');
  // force a failure on E to observe rotation back to A, which fails again -> cooldown doubles to 4s
  eMode = 'revert'; // reverts are final, not rotations - so use A directly: rebuild a 2-endpoint rpc [A, E]
  const rpc2 = createFailoverRpc([A.url, E.url], { timeoutMs: 400, log: () => {}, now: () => clock, sleep: async (ms) => { clock += ms; }, cooldownBaseMs: 2000, name: 't2' });
  eMode = 'ok';
  await rpc2.provider.request({ method: 'eth_chainId', params: [] }); // A fails (cooldown 2s) -> E
  assert.equal(rpc2.state.consecutiveFailures[0], 1);
  clock += 2500; // A's cooldown expired; current is E, so E is used (no rotation back unless E fails)
  await rpc2.provider.request({ method: 'eth_chainId', params: [] });
  assert.equal(rpc2.state.activeUrl, E.url);
  // make E "fail" via a timeout-class endpoint swap is not possible; instead verify the doubling arithmetic directly
  rpc2.state.current = 0; // pretend we are back on A
  await rpc2.provider.request({ method: 'eth_chainId', params: [] }); // A fails again -> failures 2 -> cooldown 4s
  assert.equal(rpc2.state.consecutiveFailures[0], 2);
  assert.equal(rpc2.state.cooldownUntil[0] - clock, 4000, 'second consecutive failure -> 4s cooldown');
  console.log('3. cooldown expires with the clock and doubles per consecutive failure  OK');

  // 4. rotate on 429 / rate-limit code / method-not-available / archive token; revert is final with data
  for (const [mode, expect] of [['http429', /HTTP 429/], ['rate', /rpc rate limit|rpc error -32029/], ['nomethod', /endpoint cannot serve|rpc error -32601/], ['archive', /endpoint cannot serve request: Archive requests/]]) {
    fMode = mode; const l = [];
    const r = createFailoverRpc([F.url, E.url], { timeoutMs: 400, log: (m) => l.push(m), now: () => clock, sleep: async (ms) => { clock += ms; }, name: mode });
    assert.equal(await r.provider.request({ method: 'eth_chainId', params: [] }), '0x1237', mode);
    assert.ok(l.some((x) => expect.test(x)), `${mode}: rotation reason logged (${l.join(' | ')})`);
  }
  eMode = 'revert';
  const rr = createFailoverRpc([E.url], { timeoutMs: 400, log: () => {}, now: () => clock, sleep: async () => {}, name: 'revert' });
  await assert.rejects(rr.provider.request({ method: 'eth_call', params: [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest'] }), (e) => {
    assert.ok(e instanceof RpcRequestError, 'viem RpcRequestError so revert data still decodes');
    assert.equal(e.code, 3); assert.match(String(e.data), /^0x08c379a0/);
    return true;
  });
  assert.equal(hits.E > 0 && rr.state.switches, 0, 'a revert never rotates');
  eMode = 'ok';
  console.log('4. 429 / rate-limit / method-not-available / archive-token rotate; execution revert is final with data  OK');

  // 5. eth_sendRawTransaction: malformed on A (may have broadcast), "already known" on E -> hash returned
  const raw = '0x02f86d82123701843b9aca00843b9aca0a82520894000000000000000000000000000000000000dead8080c001a0' + '11'.repeat(32) + 'a0' + '22'.repeat(32);
  const rpc5 = createFailoverRpc([A.url, E.url], { timeoutMs: 400, log: () => {}, now: () => clock, sleep: async (ms) => { clock += ms; }, name: 'raw' });
  const h = await rpc5.provider.request({ method: 'eth_sendRawTransaction', params: [raw] });
  assert.equal(h, keccak256(raw), 'already-known after a garbage first answer -> the tx hash');
  // ...but a fresh "already known" with no earlier attempt is a real error
  const rpc5b = createFailoverRpc([E.url], { timeoutMs: 400, log: () => {}, now: () => clock, sleep: async () => {}, name: 'raw2' });
  await assert.rejects(rpc5b.provider.request({ method: 'eth_sendRawTransaction', params: [raw] }), (e) => e instanceof RpcRequestError);
  fMode = 'rawok';
  const rpc5c = createFailoverRpc([F.url], { timeoutMs: 400, log: () => {}, now: () => clock, sleep: async () => {}, name: 'raw3' });
  assert.equal(await rpc5c.provider.request({ method: 'eth_sendRawTransaction', params: [raw] }), '0x' + 'ab'.repeat(32), 'normal send returns the node hash');
  console.log('5. eth_sendRawTransaction: re-send after garbage, "already known" -> keccak256(raw)  OK');

  // 6. real viem client over the transport
  const client = createPublicClient({ transport: createFailoverRpc([A.url, C.url, E.url], { timeoutMs: 400, log: () => {}, now: () => clock, sleep: async (ms) => { clock += ms; } }).transport });
  assert.equal(await client.getBlockNumber(), 0x371bde6n);
  assert.equal(await client.getChainId(), 4663);
  console.log('6. viem createPublicClient({ transport }) works through the rotation  OK');

  // 7. everything failing -> final error
  const dead = createFailoverRpc([A.url, C.url], { timeoutMs: 400, maxAttempts: 4, log: () => {}, now: () => clock, sleep: async (ms) => { clock += ms; }, name: 'dead' });
  await assert.rejects(dead.provider.request({ method: 'eth_chainId', params: [] }), /failed on every endpoint after 4 attempts \(last: (malformed response|HTTP 503)/);
  console.log('7. all endpoints failing -> one final error after maxAttempts  OK');

  // 7b. a response carrying another request's id is malformed -> rotate; requestVia hits one endpoint only
  let gMode = 'wrong-id';
  const G = await serve('F', (q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); if (gMode === 'wrong-id') return res.end(JSON.stringify({ jsonrpc: '2.0', id: 999999, result: '0xdead' })); res.end(eth(q.id, '0x1237')); });
  const l7 = [];
  const r7 = createFailoverRpc([G.url, E.url], { timeoutMs: 400, log: (m) => l7.push(m), now: () => clock, sleep: async (ms) => { clock += ms; }, name: 'ids' });
  assert.equal(await r7.provider.request({ method: 'eth_chainId', params: [] }), '0x1237', 'the mismatched answer is never returned');
  assert.ok(l7.some((x) => /does not match request id/.test(x)), `id mismatch logged as malformed (${l7.join(' | ')})`);
  assert.equal(r7.state.activeUrl, E.url);
  // requestVia: one specific endpoint, no rotation, no cooldown bookkeeping
  gMode = 'ok';
  const hitsBefore = { ...hits };
  assert.equal(await r7.requestVia(0, { method: 'eth_chainId', params: [] }), '0x1237');
  assert.equal(hits.F, hitsBefore.F + 1, 'requestVia(0) hit endpoint 0 only'); assert.equal(hits.E, hitsBefore.E);
  assert.equal(r7.state.activeUrl, E.url, 'requestVia does not move the active endpoint');
  gMode = 'wrong-id';
  await assert.rejects(r7.requestVia(0, { method: 'eth_chainId', params: [] }), /does not match request id/, 'requestVia throws instead of rotating');
  eMode = 'revert';
  await assert.rejects(r7.requestVia(1, { method: 'eth_call', params: [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest'] }), (e) => e instanceof RpcRequestError && e.code === 3, 'final errors surface as RpcRequestError');
  eMode = 'ok';
  G.s.close();
  console.log('7b. response with a foreign id -> malformed + rotate; requestVia targets one endpoint and throws on failure  OK');

  // 8. gateway copy in sync
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/from 'npm:viem@2\.55\.2';/, "from 'viem';");
  assert.equal(norm(fs.readFileSync('supabase/functions/loss-reward-gateway/rpc-failover.mjs', 'utf8')), norm(fs.readFileSync('scripts/lib/rpcFailover.mjs', 'utf8')), 'gateway copy identical except the viem import');
  console.log('8. gateway copy of the module is in sync  OK');

  console.log('\nrpc-failover tests passed');
} finally {
  for (const x of [A, B, C, D, E, F]) x.s.close();
}
process.exit(0);
