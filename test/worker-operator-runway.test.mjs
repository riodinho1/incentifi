/**
 * WORKER — operator runway alert + token universe (audit 2026-09-08 findings 2 and 5).
 *
 *   1. estimateOperatorRunway: cadence floor (288 publishes/day), observed cadence, collects/converts
 *   2. checkOperatorRunway against a fake chain + Supabase mock: alerts below 3 days with the figures,
 *      re-alerts only after the interval, no alert when healthy
 *   3. listWorkerTokens: tokens ∪ indexed_tokens (deleted tokens row still seen via the index), hidden
 *      rows included, indexed_tokens table missing -> tokens only, no throw
 *
 * Run: node test/worker-operator-runway.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { getAddress, parseEther } from 'viem';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

const OPERATOR = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const GAS_PRICE = 260_000_000n; // 0.26 gwei (measured)
let balance = parseEther('0.0095');  // the audit-day balance
const hex = (n) => '0x' + BigInt(n).toString(16);
const rpc = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const one = (item) => {
      switch (item.method) {
        case 'eth_chainId': return { jsonrpc: '2.0', id: item.id, result: hex(4663) };
        case 'eth_gasPrice': return { jsonrpc: '2.0', id: item.id, result: hex(GAS_PRICE) };
        case 'eth_getBalance': return { jsonrpc: '2.0', id: item.id, result: hex(balance) };
        default: return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: `unsupported: ${item.method}` } };
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
process.env.VITE_EVM_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v; for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://worker-runway-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'worker-runway-test-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch);
globalThis.fetch = mock.fetchImpl;
const NOW = Date.parse('2026-09-08T12:00:00Z');
// 33 publishes in the last 24h (TESSSS today), 5 older
for (let i = 0; i < 38; i++) mock.seed('reward_epochs', [{ epoch_id: i + 1, token_address: '0xt', epoch_number: i, status: 'published', created_at: new Date(NOW - (i < 33 ? 3600e3 : 48 * 3600e3)).toISOString() }]);
mock.seed('reward_epochs', [{ epoch_id: 99, token_address: '0xt', epoch_number: 99, status: 'completed_dust', created_at: new Date(NOW - 60e3).toISOString() }]);

const worker = await import('../scripts/loss-reward-worker.mjs');
console.log('======================================================');
console.log('  WORKER OPERATOR RUNWAY + TOKEN UNIVERSE');
console.log('======================================================\n');
try {
  // 1. pure estimate
  const floor = worker.estimateOperatorRunway({ balanceWei: parseEther('0.0095'), gasPriceWei: GAS_PRICE, publishes24h: 33 });
  assert.equal(floor.publishes, 288, 'quiet day -> floored at one continuously-underwater token');
  assert.equal(floor.dailyGas, 288n * worker.PUBLISH_GAS_ESTIMATE);
  assert.equal(floor.dailyCostWei, 288n * worker.PUBLISH_GAS_ESTIMATE * GAS_PRICE); // ~0.006 ETH
  assert.ok(floor.runwayDays > 1.5 && floor.runwayDays < 1.7, `audit-day balance ~1.58 days (got ${floor.runwayDays})`);
  const busy = worker.estimateOperatorRunway({ balanceWei: parseEther('1'), gasPriceWei: GAS_PRICE, publishes24h: 900, collects24h: 10, converts24h: 10 });
  assert.equal(busy.publishes, 900, 'observed cadence above the floor is used');
  assert.equal(busy.dailyGas, 900n * worker.PUBLISH_GAS_ESTIMATE + 10n * worker.COLLECT_GAS_ESTIMATE + 10n * worker.CONVERT_GAS_ESTIMATE);
  assert.equal(worker.estimateOperatorRunway({ balanceWei: 1n, gasPriceWei: 0n }).runwayDays, Infinity);
  console.log(`1. estimateOperatorRunway: 0.0095 ETH @ 0.26 gwei -> ${floor.runwayDays.toFixed(2)} days (floor 288 publishes/day); busy cadence honoured  OK`);

  // 2. live-shaped check with the fake chain + DB
  const alerts = [];
  let t = NOW;
  const r1 = await worker.checkOperatorRunway({ operatorAddress: OPERATOR, alert: async (m) => alerts.push(m), now: () => t, minRunwayDays: 3, alertIntervalMs: 6 * 3600e3 });
  assert.equal(r1.publishes24h, 33, 'only published rows of the last 24h are counted');
  assert.equal(r1.low, true);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /LOW: 0\.0095 ETH = 1\.\d+ days of runway/);
  assert.match(alerts[0], /288 publishes\/day/);
  t += 3600e3;
  await worker.checkOperatorRunway({ operatorAddress: OPERATOR, alert: async (m) => alerts.push(m), now: () => t, minRunwayDays: 3, alertIntervalMs: 6 * 3600e3 });
  assert.equal(alerts.length, 1, 'no re-alert within the interval');
  t += 6 * 3600e3;
  await worker.checkOperatorRunway({ operatorAddress: OPERATOR, alert: async (m) => alerts.push(m), now: () => t, minRunwayDays: 3, alertIntervalMs: 6 * 3600e3 });
  assert.equal(alerts.length, 2, 're-alerts after the interval while still low');
  balance = parseEther('0.5');
  const r2 = await worker.checkOperatorRunway({ operatorAddress: OPERATOR, alert: async (m) => alerts.push(m), now: () => t + 7 * 3600e3, minRunwayDays: 3 });
  assert.equal(r2.low, false); assert.equal(alerts.length, 2, 'healthy -> no alert');
  console.log('2. checkOperatorRunway: alert below 3 days with the figures, throttled re-alert, quiet when funded  OK');

  // 3. token universe
  mock.seed('tokens', [{ mint_address: '0x00000000000000000000000000000000000000A1', hidden: false }, { mint_address: '0x00000000000000000000000000000000000000A2', hidden: true }]);
  mock.seed('indexed_tokens', [{ mint_address: '0x00000000000000000000000000000000000000A1', venue: 'legible' }, { mint_address: '0x00000000000000000000000000000000000000A3', venue: 'legible' }, { mint_address: '0x00000000000000000000000000000000000000A4', venue: 'v4-generic' }]);
  const universe = await worker.listWorkerTokens({});
  assert.deepEqual(universe.map((t) => t.mint_address.toLowerCase()).sort(), ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2', '0x00000000000000000000000000000000000000a3', '0x00000000000000000000000000000000000000a4']);
  assert.equal(universe.find((t) => t.mint_address.endsWith('A1')).source, 'tokens', 'tokens row wins when both exist');
  assert.equal(universe.find((t) => t.mint_address.endsWith('A3')).source, 'indexed_tokens', 'a token with no tokens row (deleted) is still processed');
  assert.ok(universe.some((t) => t.mint_address.endsWith('A2')), 'hidden tokens are included (hiding is a listing decision, not a funds decision)');
  // indexed_tokens missing entirely -> tokens only, no throw
  const dbNoIndex = { from: (table) => (table === 'indexed_tokens' ? { select: async () => ({ data: null, error: { message: 'relation "indexed_tokens" does not exist' } }) } : { select: async () => ({ data: [{ mint_address: '0x00000000000000000000000000000000000000B1' }], error: null }) }) };
  const only = await worker.listWorkerTokens({ db: dbNoIndex });
  assert.deepEqual(only.map((t) => t.mint_address), ['0x00000000000000000000000000000000000000B1']);
  console.log('3. listWorkerTokens = tokens ∪ indexed_tokens (deleted row still seen; hidden included; missing table tolerated)  OK');

  console.log('\nworker-operator-runway tests passed');
} finally {
  await worker.closeV4Module();
  rpc.close();
}
process.exit(0);
