/**
 * WORKER — DUAL-POOL SELECTION (drain-then-switch, per token).
 * scripts/loss-reward-worker.mjs resolveEpochPool(): which pool a token's NEXT epoch goes to.
 *   V2 unset                            -> V1 (status quo)
 *   V1 unallocated >= demand            -> V1 (keep draining)
 *   V1 unallocated >= dust but < demand -> V1, CAPPED to V1 unallocated (drain to the wei; V2 next run)
 *   V1 unallocated <  dust              -> V2 (drained)
 *   V1 read fails                       -> V1 (fail to the status quo, never throw)
 * Three tokens with different V1 balances resolve independently in the same run.
 *
 * Offline: a local JSON-RPC server answers getUnallocatedBalance per (pool, token).
 * Run: node test/worker-dual-pool.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, getAddress } from 'viem';

process.env.VITE_SUPABASE_URL ||= 'https://worker-dual-pool-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'worker-dual-pool-test-key';

const V1 = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const V2 = getAddress('0x00000000000000000000000000000000000000B2');
const TOKEN_RICH = getAddress('0x00000000000000000000000000000000000000A1'); // V1 still funds whole epochs
const TOKEN_THIN = getAddress('0x00000000000000000000000000000000000000A2'); // V1 above dust, below demand
const TOKEN_DRAINED = getAddress('0x00000000000000000000000000000000000000A3'); // V1 below dust
const TOKEN_BROKEN = getAddress('0x00000000000000000000000000000000000000A4'); // V1 read reverts
const E = 10n ** 18n;
const balances = {
  [`${V1}:${TOKEN_RICH}`]: E / 20n, // 0.05 ETH
  [`${V1}:${TOKEN_THIN}`]: E / 500n, // 0.002 ETH
  [`${V1}:${TOKEN_DRAINED}`]: 5_000_000_000_000n, // 0.000005 ETH < dust (1e13 wei)
};
const SEL = toFunctionSelector('function getUnallocatedBalance(address)');
const calls = [];
const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const one = (item) => {
      if (item.method === 'eth_chainId') return { jsonrpc: '2.0', id: item.id, result: '0x1237' };
      if (item.method === 'eth_call') {
        const { to, data } = item.params[0];
        const pool = getAddress(to);
        const token = getAddress('0x' + data.slice(34, 74));
        calls.push(`${pool}:${token}`);
        if (data.slice(0, 10) !== SEL) return { jsonrpc: '2.0', id: item.id, error: { code: 3, message: 'unmocked', data: '0x' } };
        if (token === TOKEN_BROKEN) return { jsonrpc: '2.0', id: item.id, error: { code: 3, message: 'execution reverted (test)', data: '0x' } };
        const bal = balances[`${pool}:${token}`] ?? 0n;
        return { jsonrpc: '2.0', id: item.id, result: encodeAbiParameters(parseAbiParameters('uint256'), [bal]) };
      }
      return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: `unsupported: ${item.method}` } };
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
process.env.VITE_EVM_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
process.env.VITE_LOSS_REWARD_POOL = V1;
process.env.LOSS_REWARD_POOL_V2_ADDRESS = V2;

const { resolveEpochPool, MIN_EPOCH_PAYOUT_WEI } = await import('../scripts/loss-reward-worker.mjs');

console.log('======================================================');
console.log('  WORKER DUAL-POOL SELECTION (drain V1, then V2)');
console.log('======================================================\n');
try {
  const demand = E / 100n; // 0.01 ETH epoch

  const rich = await resolveEpochPool(TOKEN_RICH, demand);
  assert.equal(rich.address, V1); assert.equal(rich.version, 'v1'); assert.equal(rich.reason, 'v1_can_fund'); assert.equal(rich.capToV1, false);
  assert.equal(rich.v1UnallocatedWei, E / 20n);
  console.log(`rich token:    V1 has 0.05 ETH >= 0.01 demand -> ${rich.version} (${rich.reason})  OK`);

  const thin = await resolveEpochPool(TOKEN_THIN, demand);
  assert.equal(thin.address, V1); assert.equal(thin.version, 'v1'); assert.equal(thin.reason, 'v1_drain_capped');
  assert.equal(thin.capToV1, true, 'the epoch is published on V1 capped to its 0.002 ETH');
  console.log(`thin token:    V1 has 0.002 ETH (>= dust, < demand) -> ${thin.version} CAPPED (${thin.reason})  OK`);

  // ...but with a smaller epoch that V1 CAN fund, the same token keeps draining V1
  const thinSmall = await resolveEpochPool(TOKEN_THIN, E / 1000n);
  assert.equal(thinSmall.version, 'v1'); assert.equal(thinSmall.reason, 'v1_can_fund'); assert.equal(thinSmall.capToV1, false);
  console.log(`thin token:    smaller 0.001 ETH epoch -> ${thinSmall.version} (${thinSmall.reason})  OK`);

  const drained = await resolveEpochPool(TOKEN_DRAINED, demand);
  assert.equal(drained.address, V2); assert.equal(drained.reason, 'v1_drained'); assert.equal(drained.capToV1, false);
  assert.ok(drained.v1UnallocatedWei < MIN_EPOCH_PAYOUT_WEI);
  console.log(`drained token: V1 has 0.000005 ETH (< dust ${MIN_EPOCH_PAYOUT_WEI} wei) -> ${drained.version} (${drained.reason})  OK`);

  const broken = await resolveEpochPool(TOKEN_BROKEN, demand);
  assert.equal(broken.address, V1); assert.equal(broken.reason, 'v1_read_failed');
  console.log(`broken read:   RPC revert -> ${broken.version} (${broken.reason}), no throw  OK`);

  const noV2 = await resolveEpochPool(TOKEN_DRAINED, demand, { v2: '' });
  assert.equal(noV2.address, V1); assert.equal(noV2.reason, 'v2_not_configured');
  console.log(`V2 unset:      drained token still -> ${noV2.version} (${noV2.reason}) — status quo  OK`);

  // zero demand (no-holder / dust epochs) only needs V1 to be above dust
  const zero = await resolveEpochPool(TOKEN_THIN, 0n);
  assert.equal(zero.version, 'v1'); assert.equal(zero.capToV1, false);

  // pure pro-rata cap: sum of leaves == available, never a wei over
  const { capAllocationsToAvailable } = await import('../scripts/loss-reward-worker.mjs');
  const cap = capAllocationsToAvailable([800_000_000_000_000_000n, 800_000_000_000_000_000n], 300_000_000_000_000_000n);
  assert.equal(cap.allocatedWei, 300_000_000_000_000_000n);
  assert.deepEqual(cap.finalWei, [150_000_000_000_000_000n, 150_000_000_000_000_000n]);
  assert.ok(Math.abs(cap.scalingFactor - 0.1875) < 1e-15);
  const odd = capAllocationsToAvailable([1n, 1n, 1n], 2n);
  assert.equal(odd.allocatedWei, 0n, 'shares that floor to 0 wei allocate nothing (never over)');
  const full = capAllocationsToAvailable([5n, 7n], 100n);
  assert.deepEqual(full.finalWei, [5n, 7n]); assert.equal(full.scalingFactor, 1); assert.equal(full.allocatedWei, 12n);

  assert.ok(calls.every((c) => c.startsWith(V1)), 'only V1 is read to decide (V2 balance is irrelevant to the switch)');
  console.log('\nworker-dual-pool tests passed');
} finally {
  rpc.close();
}
