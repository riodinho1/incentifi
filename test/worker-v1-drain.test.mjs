/**
 * WORKER — V1 DRAINS TO DUST EVEN WHEN DEMAND ALWAYS EXCEEDS THE REMAINDER.
 *
 * The case: after the hook is re-pointed to V2, token X still has 0.3 ETH unallocated on V1 and
 * every subsequent epoch demands >= 0.5 ETH. V1 has no withdraw. The rule must publish on V1
 * CAPPED to its unallocated balance while V1 >= dust, then on V2 from the next run.
 *
 * This drives the REAL executeEpochForToken() twice, offline:
 *   - a local JSON-RPC server plays the chain: V3 factory/curve price, holder balances, both
 *     pools' getUnallocatedBalance / epochMerkleRoots, and the FULL write path
 *     (nonce, gas, fees, eth_sendRawTransaction, receipt) — every setEpochMerkleRoot the worker
 *     signs is decoded and applied to the fake pool state, exactly like the contract would
 *     (unallocated -= allocatedAmount; root recorded);
 *   - Supabase is the in-memory REST mock with two underwater holders seeded.
 * Run 1 must publish epoch 1 on V1 for exactly V1's 0.3 ETH (pro-rata, sum of leaves == allocated),
 * leaving V1 at 0 (< dust). Run 2 must publish epoch 2 on V2 at full demand. The operator key is a
 * throwaway test key.
 *
 * Run: node test/worker-v1-drain.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, getAddress, keccak256, parseTransaction, decodeFunctionData, parseAbi } from 'viem';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

const V1 = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const V2 = getAddress('0x00000000000000000000000000000000000000B2');
const V3_FACTORY = getAddress('0xa0143de84fba1753b887e4e32941e4fb342e473f');
const LEGIBLE_FACTORY = getAddress('0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const CURVE = getAddress('0x00000000000000000000000000000000000000CC');
const TOKEN = getAddress('0x00000000000000000000000000000000000000E1');
const H1 = getAddress('0x0000000000000000000000000000000000001111');
const H2 = getAddress('0x0000000000000000000000000000000000002222');
const E = 10n ** 18n;
const ZERO32 = '0x' + '0'.repeat(64);

// fake chain state
const pools = {
  [V1]: { unallocated: (E * 3n) / 10n, roots: new Map() }, // 0.3 ETH
  [V2]: { unallocated: 10n * E, roots: new Map() },
};
const publishes = []; // { pool, token, epochId, root, allocated }
const POOL_ABI = parseAbi(['function setEpochMerkleRoot(address token, uint256 epochId, bytes32 merkleRoot, uint256 allocatedAmount)']);
const sel = (sig) => toFunctionSelector(sig);
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const hex = (n) => '0x' + BigInt(n).toString(16);
const receipts = new Map();
let nonce = 0;
const HEAD = 57_000_000n;

function ethCall(to, data) {
  const t = getAddress(to);
  const s = data.slice(0, 10);
  const argAddr = () => getAddress('0x' + data.slice(34, 74));
  if (t === LEGIBLE_FACTORY && s === sel('function isLaunched(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function isGraduated(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function getBondingCurve(address)')) return enc('address', [CURVE]);
  if (t === CURVE && s === sel('function getCurrentPrice()')) return enc('uint256', [2_000_000_000_000n]); // 2e-6 ETH/token
  if (t === TOKEN && s === sel('function balanceOf(address)')) return enc('uint256', [1_000_000n * E]);
  if (pools[t] && s === sel('function getUnallocatedBalance(address)')) return enc('uint256', [pools[t].unallocated]);
  if (pools[t] && s === sel('function epochMerkleRoots(address,uint256)')) {
    const epochId = BigInt('0x' + data.slice(74, 138));
    return pools[t].roots.get(epochId.toString()) || ZERO32;
  }
  return null;
}

const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const one = (item) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: item.id, result });
      const err = (message) => ({ jsonrpc: '2.0', id: item.id, error: { code: 3, message, data: '0x' } });
      switch (item.method) {
        case 'eth_chainId': return ok(hex(4663));
        case 'eth_blockNumber': return ok(hex(HEAD));
        case 'eth_getBlockByNumber': return ok({ number: hex(HEAD), baseFeePerGas: hex(300_000_000n), gasLimit: hex(30_000_000n), timestamp: hex(1_788_800_000n), hash: '0x' + '11'.repeat(32), transactions: [] });
        case 'eth_maxPriorityFeePerGas': return ok(hex(1_000_000n));
        case 'eth_gasPrice': return ok(hex(301_000_000n));
        case 'eth_getTransactionCount': return ok(hex(nonce));
        case 'eth_estimateGas': return ok(hex(120_000n));
        case 'eth_call': { const out = ethCall(item.params[0].to, item.params[0].data); return out ? ok(out) : err('unmocked call'); }
        case 'eth_sendRawTransaction': {
          const raw = item.params[0];
          const tx = parseTransaction(raw);
          const { functionName, args } = decodeFunctionData({ abi: POOL_ABI, data: tx.data });
          assert.equal(functionName, 'setEpochMerkleRoot');
          const pool = getAddress(tx.to);
          const [token, epochId, root, allocated] = args;
          // exactly what LossRewardPool.setEpochMerkleRoot enforces
          if (allocated > pools[pool].unallocated) return err('InsufficientUnallocatedPool');
          if (pools[pool].roots.has(epochId.toString())) return err('EpochAlreadyPublished');
          pools[pool].unallocated -= allocated;
          pools[pool].roots.set(epochId.toString(), root);
          publishes.push({ pool, token: getAddress(token), epochId, root, allocated });
          nonce += 1;
          const hash = keccak256(raw);
          receipts.set(hash, { transactionHash: hash, status: '0x1', blockNumber: hex(HEAD), blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', gasUsed: hex(100_000n), cumulativeGasUsed: hex(100_000n), effectiveGasPrice: hex(301_000_000n), logs: [], logsBloom: '0x' + '0'.repeat(512), type: '0x2', from: tx.from || '0x' + '0'.repeat(40), to: tx.to, contractAddress: null });
          return ok(hash);
        }
        case 'eth_getTransactionReceipt': return ok(receipts.get(item.params[0]) || null);
        default: return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: `unsupported: ${item.method}` } };
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));

// env BEFORE importing the worker
process.env.VITE_EVM_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
process.env.VITE_LOSS_REWARD_POOL = V1;
process.env.LOSS_REWARD_POOL_V2_ADDRESS = V2;
process.env.OPERATOR_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // throwaway test key (hardhat #1)
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v;
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://worker-v1-drain-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'worker-v1-drain-test-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, { upsertKeys: { holder_cost_basis: ['token_address', 'wallet_address'], indexer_heartbeats: ['worker_name'] } });
globalThis.fetch = mock.fetchImpl;
// two underwater holders: invested 10 ETH each into 1M tokens (cost 1e-5), price now 2e-6 -> loss 8 ETH -> 0.8 ETH reward each -> demand 1.6 ETH >> 0.3 ETH on V1
for (const [i, w] of [H1, H2].entries()) {
  mock.seed('holder_cost_basis', [{ id: i + 1, token_address: TOKEN.toLowerCase(), wallet_address: w.toLowerCase(), token_balance: 1_000_000, total_invested_eth: 10, avg_cost_basis_eth: 1e-5, is_eligible: true, is_underwater_seller: false }]);
}

const worker = await import('../scripts/loss-reward-worker.mjs');

console.log('======================================================');
console.log('  WORKER V1 DRAIN: 0.3 ETH left on V1, every epoch demands 1.6 ETH');
console.log('======================================================\n');
try {
  console.log('[run 1] V1 has 0.3 ETH >= dust, demand 1.6 ETH -> publish on V1 CAPPED to 0.3 ETH');
  const r1 = await worker.executeEpochForToken(TOKEN, { skipFreshnessCheck: true, skipFallbackMonitor: true });
  assert.equal(r1.skipped, undefined, `run 1 must publish (got ${String(r1.reason)})`);
  assert.equal(publishes.length, 1);
  assert.equal(publishes[0].pool, V1, 'published on V1');
  assert.equal(publishes[0].epochId, 1n);
  assert.equal(publishes[0].allocated, (E * 3n) / 10n, 'allocated exactly V1\'s 0.3 ETH remainder');
  assert.equal(pools[V1].unallocated, 0n, 'V1 is emptied to the wei');
  const ep1 = mock.table('reward_epochs').find((e) => e.epoch_number === 1);
  assert.equal(ep1.pool_address, V1.toLowerCase());
  assert.equal(ep1.status, 'published');
  assert.ok(Math.abs(ep1.scaling_factor - 0.3 / 1.6) < 1e-12, `scaling factor 0.3/1.6 (got ${ep1.scaling_factor})`);
  assert.ok(Math.abs(ep1.total_distributed_eth - 0.3) < 1e-12);
  assert.ok(Math.abs(ep1.total_theoretical_reward_eth - 1.6) < 1e-9, 'full theoretical demand is still recorded');
  const rewards1 = mock.table('epoch_holder_rewards').filter((r) => r.epoch_id === ep1.epoch_id);
  assert.equal(rewards1.length, 2);
  const sum1 = rewards1.reduce((a, r) => a + BigInt(Math.round(Number(r.final_reward_eth) * 1e18)), 0n);
  assert.equal(sum1, publishes[0].allocated, 'sum of holder leaves == on-chain allocation (no wei short)');
  for (const r of rewards1) assert.ok(Math.abs(Number(r.final_reward_eth) - 0.15) < 1e-12, 'each holder gets 0.15 ETH (0.8 × 0.3/1.6)');
  const cb1 = mock.table('holder_cost_basis').find((h) => h.wallet_address === H1.toLowerCase());
  assert.ok(Math.abs(Number(cb1.total_invested_eth) - (10 - 0.15)) < 1e-9, 'cost basis depleted by the SCALED reward, not the theoretical one');
  console.log(`  epoch 1 on V1: allocated ${Number(publishes[0].allocated) / 1e18} ETH, scaling ${ep1.scaling_factor.toFixed(4)}, V1 now ${pools[V1].unallocated} wei  OK\n`);

  console.log('[run 2] V1 at 0 (< dust) -> publish on V2 at full demand');
  const r2 = await worker.executeEpochForToken(TOKEN, { skipFreshnessCheck: true, skipFallbackMonitor: true });
  assert.equal(r2.skipped, undefined, `run 2 must publish (got ${String(r2.reason)})`);
  assert.equal(publishes.length, 2);
  assert.equal(publishes[1].pool, V2, 'published on V2');
  assert.equal(publishes[1].epochId, 2n);
  const ep2 = mock.table('reward_epochs').find((e) => e.epoch_number === 2);
  assert.equal(ep2.pool_address, V2.toLowerCase());
  assert.equal(ep2.status, 'published');
  assert.equal(ep2.scaling_factor, 1, 'V2 is funded: no scaling');
  // demand fell slightly because run 1 depleted cost basis by 0.15 each: (10-0.15) - 2 = 7.85 loss -> 0.785 reward each
  assert.ok(Math.abs(Number(publishes[1].allocated) / 1e18 - 1.57) < 1e-9, `full demand allocated on V2 (got ${Number(publishes[1].allocated) / 1e18})`);
  assert.equal(pools[V1].unallocated, 0n, 'V1 untouched at 0');
  assert.equal(pools[V2].unallocated, 10n * E - publishes[1].allocated);
  console.log(`  epoch 2 on V2: allocated ${Number(publishes[1].allocated) / 1e18} ETH; V1 stays at 0, V2 now ${Number(pools[V2].unallocated) / 1e18} ETH  OK\n`);

  console.log('worker-v1-drain tests passed');
} finally {
  await worker.closeV4Module();
  rpc.close();
}
process.exit(0);
