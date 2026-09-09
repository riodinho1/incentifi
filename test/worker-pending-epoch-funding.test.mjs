/**
 * WORKER — pending epochs with funds in the pool get published (incident 2026-09-08, INCENTIFI/NVDA).
 *
 * Production state reproduced offline: LossRewardPoolV2 holds 0.292292038450749286 ETH unallocated for
 * the token; reward_epochs has #4 (0.3024 ETH) and #5 (0.2479 ETH) as `pending_funding` with their
 * per-holder rows and proofs, and holder_cost_basis was already depleted by those full amounts. The
 * old worker read the balance correctly but required the FULL 0.3024 for #4 before anything could
 * publish (FIFO), so both sat forever and every new epoch was parked the same way.
 *
 * This drives the REAL executeEpochForToken() against a fake chain (eth_call answers for the pools,
 * factory and token; eth_sendRawTransaction decodes setEpochMerkleRoot and enforces the contract's
 * InsufficientUnallocatedPool / EpochAlreadyPublished) and the in-memory Supabase mock.
 *   0. pool read fails on every attempt -> token skipped, no tx, no rows ("retried, not treated as zero")
 *   1. pool read fails twice then succeeds -> run 1 publishes #4 on V2 for the whole 0.2923 ETH, pro
 *      rata from the STORED allocations (no re-snapshot): allocation == sum of the rewritten leaves,
 *      every rewritten proof verifies against the new root, scaling recorded, unpaid depletion given
 *      back to holder_cost_basis; #5 stays pending; NO new epoch #6 is computed
 *   2. pool now ~0 -> nothing published, nothing computed, no tx
 *   3. #5's root appears on-chain out of band (crash between tx and DB) and fees arrive -> #5 is
 *      reconciled in the DB without a tx, then a NEW epoch #6 is computed and published capped to the
 *      remaining balance (published, not pending), cost basis depleted by the SCALED amount only
 *   4. pool read fails for the new-epoch gate -> skipped, no tx, no row
 *
 * Run: node test/worker-pending-epoch-funding.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, getAddress, keccak256, parseTransaction, decodeFunctionData, parseAbi, concat } from 'viem';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

const V1 = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const V2 = getAddress('0x5d94246CD31064Da02E953DB357F0001F0E9A631');
const V3_FACTORY = getAddress('0xa0143de84fba1753b887e4e32941e4fb342e473f');
const LEGIBLE_FACTORY = getAddress('0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const CURVE = getAddress('0x00000000000000000000000000000000000000CC');
const TOKEN = getAddress('0xb1aE1bF55389a3E011fD456CA0eA7E8625307195');
const A = getAddress('0x0000000000000000000000000000000000000AAA');
const B = getAddress('0x0000000000000000000000000000000000000BBB');
const C = getAddress('0x0000000000000000000000000000000000000CCC');
const E = 10n ** 18n;
const ZERO32 = '0x' + '0'.repeat(64);
const POOL_BAL = 292292038450749286n; // 0.292292038450749286 ETH, the production V2 unallocated balance

const pools = { [V1]: { unallocated: 0n, roots: new Map(), allocated: new Map() }, [V2]: { unallocated: POOL_BAL, roots: new Map(), allocated: new Map() } };
const publishes = [];
const POOL_ABI = parseAbi(['function setEpochMerkleRoot(address token, uint256 epochId, bytes32 merkleRoot, uint256 allocatedAmount)']);
const sel = (sig) => toFunctionSelector(sig);
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const hex = (n) => '0x' + BigInt(n).toString(16);
const receipts = new Map();
let nonce = 0; const HEAD = 58_084_677n;
let failUnallocatedReads = 0; // >0: fail that many getUnallocatedBalance calls; Infinity: always
let unallocatedCalls = 0;

function ethCall(to, data) {
  const t = getAddress(to); const s = data.slice(0, 10);
  if (t === LEGIBLE_FACTORY && s === sel('function isLaunched(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function isGraduated(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function getBondingCurve(address)')) return enc('address', [CURVE]);
  if (t === CURVE && s === sel('function getCurrentPrice()')) return enc('uint256', [4_813_827_373n]); // 4.81e-9 ETH/token
  if (t === TOKEN && s === sel('function balanceOf(address)')) return enc('uint256', [1_000_000n * E]);
  if (pools[t] && s === sel('function getUnallocatedBalance(address)')) {
    unallocatedCalls++;
    if (failUnallocatedReads > 0) { failUnallocatedReads--; return 'FAIL'; }
    return enc('uint256', [pools[t].unallocated]);
  }
  if (pools[t] && s === sel('function epochMerkleRoots(address,uint256)')) return pools[t].roots.get(BigInt('0x' + data.slice(74, 138)).toString()) || ZERO32;
  if (pools[t] && s === sel('function epochAllocatedAmounts(address,uint256)')) return enc('uint256', [pools[t].allocated.get(BigInt('0x' + data.slice(74, 138)).toString()) || 0n]);
  return null;
}
const rpc = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const one = (item) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: item.id, result });
      const err = (message) => ({ jsonrpc: '2.0', id: item.id, error: { code: 3, message, data: '0x' } });
      switch (item.method) {
        case 'eth_chainId': return ok(hex(4663));
        case 'eth_blockNumber': return ok(hex(HEAD));
        case 'eth_getBlockByNumber': return ok({ number: hex(HEAD), baseFeePerGas: hex(300_000_000n), gasLimit: hex(30_000_000n), timestamp: hex(1_788_900_000n), hash: '0x' + '11'.repeat(32), transactions: [] });
        case 'eth_maxPriorityFeePerGas': return ok(hex(1_000_000n));
        case 'eth_gasPrice': return ok(hex(301_000_000n));
        case 'eth_getTransactionCount': return ok(hex(nonce));
        case 'eth_estimateGas': return ok(hex(180_000n));
        case 'eth_call': { const out = ethCall(item.params[0].to, item.params[0].data); if (out === 'FAIL') return err('simulated node failure'); return out ? ok(out) : err('unmocked call'); }
        case 'eth_sendRawTransaction': {
          const raw = item.params[0]; const tx = parseTransaction(raw);
          const { functionName, args } = decodeFunctionData({ abi: POOL_ABI, data: tx.data });
          assert.equal(functionName, 'setEpochMerkleRoot');
          const pool = getAddress(tx.to); const [token, epochId, root, allocated] = args;
          if (allocated > pools[pool].unallocated) return err('InsufficientUnallocatedPool');
          if (pools[pool].roots.has(epochId.toString())) return err('EpochAlreadyPublished');
          if (root === ZERO32) return err('InvalidMerkleRoot');
          pools[pool].unallocated -= allocated; pools[pool].roots.set(epochId.toString(), root); pools[pool].allocated.set(epochId.toString(), allocated);
          publishes.push({ pool, token: getAddress(token), epochId, root, allocated });
          nonce += 1; const hash = keccak256(raw);
          receipts.set(hash, { transactionHash: hash, status: '0x1', blockNumber: hex(HEAD), blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', gasUsed: hex(150_000n), cumulativeGasUsed: hex(150_000n), effectiveGasPrice: hex(301_000_000n), logs: [], logsBloom: '0x' + '0'.repeat(512), type: '0x2', from: tx.from || '0x' + '0'.repeat(40), to: tx.to, contractAddress: null });
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

process.env.RPC_URLS = `http://127.0.0.1:${rpc.address().port}`;
process.env.VITE_LOSS_REWARD_POOL = V1;
process.env.LOSS_REWARD_POOL_V2_ADDRESS = V2;
process.env.OPERATOR_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // throwaway test key (hardhat #1)
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v; for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://worker-pending-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'worker-pending-test-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, { upsertKeys: { holder_cost_basis: ['token_address', 'wallet_address'], indexer_heartbeats: ['worker_name'] } });
globalThis.fetch = mock.fetchImpl;

const worker = await import('../scripts/loss-reward-worker.mjs');
const { MerkleTree, hashLeaf } = worker;
const SLACK = worker.LEAF_STABILIZE_SLACK_WEI * 2n; // leaf stabilisation may hold back up to one slack (1e-12 ETH)
const tok = TOKEN.toLowerCase();

// ---- seed: two pending epochs exactly like production (stored amounts, proofs, depleted cost basis)
const ep4 = [[A, 0.15], [B, 0.10], [C, 0.0524126688391798]]; // 0.3024126688391798 ETH
const ep5 = [[A, 0.15], [B, 0.0979301042094015]];            // 0.2479301042094015 ETH
let rowId = 600;
function seedPending(epochId, epochNumber, holders) {
  const wei = holders.map(([, eth]) => BigInt(Math.round(eth * 1e18)));
  const tree = new MerkleTree(holders.map(([w], i) => hashLeaf(tok, epochNumber, w, wei[i])));
  const total = holders.reduce((a, [, e]) => a + e, 0);
  mock.seed('reward_epochs', [{ epoch_id: epochId, token_address: tok, epoch_number: epochNumber, pool_price_eth: 2e-8, pool_twap_price_eth: 2e-8, total_theoretical_reward_eth: total, available_pool_eth: 0.23869143619975786, scaling_factor: 1, total_distributed_eth: total, merkle_root: tree.getRoot(), onchain_tx_hash: null, status: 'pending_funding', pool_address: V2.toLowerCase(), created_at: '2026-09-08T22:08:30Z' }]);
  mock.seed('epoch_holder_rewards', holders.map(([w, eth], i) => ({ id: rowId++, epoch_id: epochId, token_address: tok, wallet_address: w.toLowerCase(), token_balance: 1_000_000, cost_basis_eth: 3e-8, unrealized_loss_eth: eth * 10, theoretical_reward_eth: eth, final_reward_eth: eth, merkle_proof: tree.getProof(i), claimed: false })));
  return tree.getRoot();
}
for (let n = 1; n <= 3; n++) mock.seed('reward_epochs', [{ epoch_id: 2800 + n, token_address: tok, epoch_number: n, pool_price_eth: 5e-8, pool_twap_price_eth: 5e-8, total_theoretical_reward_eth: 0, available_pool_eth: 0, scaling_factor: 1, total_distributed_eth: 0, merkle_root: ZERO32, status: 'completed_empty', pool_address: V2.toLowerCase(), created_at: '2026-09-08T21:28:15Z' }]);
seedPending(2824, 4, ep4);
const root5 = seedPending(2875, 5, ep5);
// cost basis already depleted by the FULL pending rewards (A: 0.15+0.15, B: 0.10+0.098, C: 0.052) from an original 1.0 ETH each
const invested0 = { [A.toLowerCase()]: 1 - 0.30, [B.toLowerCase()]: 1 - 0.1979301042094015, [C.toLowerCase()]: 1 - 0.0524126688391798 };
for (const [i, w] of [A, B, C].entries()) mock.seed('holder_cost_basis', [{ id: i + 1, token_address: tok, wallet_address: w.toLowerCase(), token_balance: 1_000_000, total_invested_eth: invested0[w.toLowerCase()], avg_cost_basis_eth: invested0[w.toLowerCase()] / 1_000_000, is_eligible: true, is_underwater_seller: false }]);

const verifyProof = (leaf, proof, root) => proof.reduce((h, p) => (h <= p ? keccak256(concat([h, p])) : keccak256(concat([p, h]))), leaf.toLowerCase()).toLowerCase() === root.toLowerCase();
const epochRow = (n) => mock.table('reward_epochs').find((e) => e.epoch_number === n);
const rewardRows = (epochId) => mock.table('epoch_holder_rewards').filter((r) => r.epoch_id === epochId);
const cb = (w) => mock.table('holder_cost_basis').find((h) => h.wallet_address === w.toLowerCase());
const opts = { skipFreshnessCheck: true, skipFallbackMonitor: true, poolRead: { retryDelayMs: 0 } };

console.log('======================================================');
console.log('  WORKER PENDING EPOCHS: V2 holds 0.2923 ETH, #4 (0.3024) and #5 (0.2479) pending');
console.log('======================================================\n');
try {
  // 0. pool read fails on every attempt -> skipped, nothing sent, nothing written
  failUnallocatedReads = Infinity; unallocatedCalls = 0;
  const r0 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r0.skipped, true); assert.equal(r0.reason, 'pending_resolution_failed');
  assert.equal(publishes.length, 0); assert.equal(epochRow(4).status, 'pending_funding');
  assert.ok(unallocatedCalls >= worker.POOL_READ_ATTEMPTS, `read retried ${unallocatedCalls} times`);
  console.log(`0. pool read failing every time -> token skipped after ${unallocatedCalls} attempts, no tx, no rows  OK`);

  // 1. two failures then success -> #4 published pro rata for the whole pool
  failUnallocatedReads = 2;
  const r1 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r1.skipped, true); assert.equal(r1.reason, 'pending_epochs_unfunded', 'no NEW epoch while #5 is still pending');
  assert.equal(publishes.length, 1, 'exactly one publish');
  assert.equal(publishes[0].pool, V2); assert.equal(publishes[0].epochId, 4n);
  assert.ok(publishes[0].allocated <= POOL_BAL && publishes[0].allocated >= POOL_BAL - SLACK, `allocated the whole pool minus rounding slack (${publishes[0].allocated})`);
  assert.equal(pools[V2].unallocated, POOL_BAL - publishes[0].allocated);
  const e4 = epochRow(4);
  assert.equal(e4.status, 'published'); assert.ok(e4.onchain_tx_hash?.startsWith('0x'));
  assert.equal(e4.merkle_root, publishes[0].root, 'DB root == on-chain root');
  assert.ok(Math.abs(e4.scaling_factor - Number(POOL_BAL) / 1e18 / 0.3024126688391798) < 1e-9, `scaling ${e4.scaling_factor}`);
  assert.ok(Math.abs(e4.total_distributed_eth - Number(publishes[0].allocated) / 1e18) < 1e-15);
  const rows4 = rewardRows(2824);
  const sum4 = rows4.reduce((a, r) => a + BigInt(Math.round(Number(r.final_reward_eth) * 1e18)), 0n);
  assert.equal(sum4, publishes[0].allocated, 'sum of rewritten leaves == on-chain allocation');
  for (const r of rows4) {
    const leaf = hashLeaf(tok, 4, r.wallet_address, BigInt(Math.round(Number(r.final_reward_eth) * 1e18)));
    assert.ok(verifyProof(leaf, r.merkle_proof, publishes[0].root), `rewritten proof verifies for ${r.wallet_address}`);
  }
  // ratios preserved: A got 0.15/0.3024 of the pool
  const paidA4 = Number(rows4.find((r) => r.wallet_address === A.toLowerCase()).final_reward_eth);
  assert.ok(Math.abs(paidA4 - 0.15 * Number(POOL_BAL) / 1e18 / 0.3024126688391798) < 1e-12, 'pro-rata share from the STORED allocation');
  // cost basis: unpaid part of #4's depletion given back (A was depleted 0.15 for #4, paid paidA4)
  assert.ok(Math.abs(Number(cb(A).total_invested_eth) - (invested0[A.toLowerCase()] + (0.15 - paidA4))) < 1e-12, 'unpaid depletion restored for A');
  assert.equal(epochRow(5).status, 'pending_funding', '#5 waits');
  assert.equal(epochRow(6), undefined, 'no epoch #6 computed while #5 is pending');
  console.log(`1. #4 published on V2 for ${Number(publishes[0].allocated) / 1e18} ETH (${(e4.scaling_factor * 100).toFixed(2)}% of 0.3024) from stored allocations; proofs rewritten and verified; unpaid depletion restored; #5 pending; no #6  OK`);

  // 2. pool ~0 -> nothing happens
  const r2 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r2.reason, 'pending_epochs_unfunded'); assert.equal(publishes.length, 1); assert.equal(epochRow(5).status, 'pending_funding'); assert.equal(epochRow(6), undefined);
  console.log('2. pool below dust -> #5 waits, no tx, no new epoch  OK');

  // 3. #5's root lands on-chain out of band (crash after tx) + fees arrive -> reconcile #5, then a new capped epoch #6
  const alloc5 = BigInt(Math.round(0.2479301042094015 * 1e18));
  pools[V2].unallocated += 300_000_000_000_000_000n; // +0.3 ETH of fees
  pools[V2].unallocated -= alloc5; pools[V2].roots.set('5', root5); pools[V2].allocated.set('5', alloc5);
  const before6 = pools[V2].unallocated;
  const r3 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r3.skipped, undefined, `run 3 must compute a new epoch (got ${r3.reason})`);
  assert.equal(epochRow(5).status, 'published'); assert.equal(epochRow(5).onchain_tx_hash, null, 'reconciled without a new tx'); assert.equal(epochRow(5).merkle_root, root5); assert.equal(epochRow(5).scaling_factor, 1);
  assert.equal(publishes.length, 2, 'one NEW publish (epoch #6), none for #5');
  assert.equal(publishes[1].epochId, 6n); assert.equal(publishes[1].pool, V2);
  assert.equal(publishes[1].allocated <= before6 && publishes[1].allocated >= before6 - SLACK, true, 'epoch #6 capped to the remaining balance');
  const e6 = epochRow(6);
  assert.equal(e6.status, 'published', 'capped, published - NOT pending_funding'); assert.ok(e6.scaling_factor < 1);
  const rows6 = rewardRows(e6.epoch_id);
  assert.equal(rows6.reduce((a, r) => a + BigInt(Math.round(Number(r.final_reward_eth) * 1e18)), 0n), publishes[1].allocated);
  // depletion for #6 == the SCALED amount paid (A's invested went down by exactly what A was paid in #6)
  const cbA_after1 = invested0[A.toLowerCase()] + (0.15 - paidA4);
  const paidA6 = Number(rows6.find((r) => r.wallet_address === A.toLowerCase()).final_reward_eth);
  assert.ok(Math.abs(Number(cb(A).total_invested_eth) - (cbA_after1 - paidA6)) < 1e-12, 'cost basis depleted by the paid (scaled) amount only');
  console.log(`3. #5 reconciled from chain (no tx); new epoch #6 published capped to ${Number(publishes[1].allocated) / 1e18} ETH (scaling ${e6.scaling_factor.toFixed(4)})  OK`);

  // 4. new-epoch gate: pool read fails every time -> skipped, no tx, no row
  failUnallocatedReads = Infinity;
  const r4 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r4.skipped, true); assert.equal(r4.reason, 'pool_read_failed');
  assert.equal(publishes.length, 2); assert.equal(epochRow(7), undefined);
  failUnallocatedReads = 0;
  console.log('4. new-epoch pool read failing -> skipped (fail closed), no tx, no row  OK');

  console.log('\nworker-pending-epoch-funding tests passed');
} finally {
  await worker.closeV4Module();
  rpc.close();
}
process.exit(0);
