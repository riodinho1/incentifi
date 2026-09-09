/**
 * WORKER — legacy pending_funding epochs are rebuilt from fresh chain reads, funded pro rata, and
 * their earlier cost-basis depletion is reversed (2026-09-09; supersedes the PR #31 behaviour that
 * republished the STORED per-holder amounts, which came from stale/double-counted holder rows).
 *
 * Production state reproduced offline: LossRewardPoolV2 holds 0.292292038450749286 ETH unallocated;
 * reward_epochs has #4 (0.3024 ETH) and #5 (0.2479 ETH) as `pending_funding` with per-holder rows and
 * proofs; holder_cost_basis was already depleted by those full amounts. Holders A and B still hold
 * 1,000,000 tokens; C has fully sold (chain 0) although the DB still says 1,000,000.
 *   1. run 1: BOTH pending epochs' rows are discarded and every holder's depletion reversed (A, B, C back
 *      to their pre-pending investment); #4 is rebuilt in place from confirmed chain reads: A and B paid,
 *      C (sold out) gets nothing; funded in full (demand < pool), status published on the SAME epoch_id;
 *      #5 stays pending (rows gone); no new epoch number is created
 *   2. run 2: #5 rebuilt in place, capped pro rata to what the pool has left (published, not pending)
 *   3. run 3: pool ~0 -> a NEW epoch #6 is recorded as completed_dust, nothing depleted, no tx
 *   4. pool read fails on every attempt -> skipped, no tx, no rows
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
const POOL_BAL = 292292038450749286n; // the production V2 unallocated balance
const PRICE = 4_813_827_373n; // 4.81e-9 ETH/token (production slot0 at the time)
const truth = { [A]: 1_000_000n * E, [B]: 1_000_000n * E, [C]: 0n };

const pools = { [V1]: { unallocated: 0n, roots: new Map(), allocated: new Map() }, [V2]: { unallocated: POOL_BAL, roots: new Map(), allocated: new Map() } };
const publishes = [];
const POOL_ABI = parseAbi(['function setEpochMerkleRoot(address token, uint256 epochId, bytes32 merkleRoot, uint256 allocatedAmount)']);
const sel = (sig) => toFunctionSelector(sig);
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const hex = (n) => '0x' + BigInt(n).toString(16);
const receipts = new Map();
let nonce = 0; const HEAD = 58_084_677n;
let failUnallocatedReads = 0;

function ethCall(to, data) {
  const t = getAddress(to); const s = data.slice(0, 10);
  if (t === LEGIBLE_FACTORY && s === sel('function isLaunched(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function isGraduated(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function getBondingCurve(address)')) return enc('address', [CURVE]);
  if (t === CURVE && s === sel('function getCurrentPrice()')) return enc('uint256', [PRICE]);
  if (t === TOKEN && s === sel('function balanceOf(address)')) return enc('uint256', [truth[getAddress('0x' + data.slice(34, 74))] ?? 0n]);
  if (pools[t] && s === sel('function getUnallocatedBalance(address)')) { if (failUnallocatedReads > 0) { failUnallocatedReads--; return 'FAIL'; } return enc('uint256', [pools[t].unallocated]); }
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
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, { upsertKeys: { holder_cost_basis: ['token_address', 'wallet_address'], indexer_heartbeats: ['worker_name'], reward_epochs: ['token_address', 'epoch_number'] } });
globalThis.fetch = mock.fetchImpl;

const worker = await import('../scripts/loss-reward-worker.mjs');
const { MerkleTree, hashLeaf } = worker;
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
}
for (let n = 1; n <= 3; n++) mock.seed('reward_epochs', [{ epoch_id: 2800 + n, token_address: tok, epoch_number: n, pool_price_eth: 5e-8, pool_twap_price_eth: 5e-8, total_theoretical_reward_eth: 0, available_pool_eth: 0, scaling_factor: 1, total_distributed_eth: 0, merkle_root: ZERO32, status: 'completed_empty', pool_address: V2.toLowerCase(), created_at: '2026-09-08T21:28:15Z' }]);
seedPending(2824, 4, ep4);
seedPending(2875, 5, ep5);
// cost basis already depleted by the FULL pending rewards from an original 1.0 ETH each (C still shows 1,000,000 in the DB although it sold)
const depleted = { [A]: 0.30, [B]: 0.1979301042094015, [C]: 0.0524126688391798 };
for (const [i, w] of [A, B, C].entries()) mock.seed('holder_cost_basis', [{ id: i + 1, token_address: tok, wallet_address: w.toLowerCase(), token_balance: 1_000_000, total_invested_eth: 1 - depleted[w], avg_cost_basis_eth: (1 - depleted[w]) / 1_000_000, is_eligible: true, is_underwater_seller: false }]);

const verifyProof = (leaf, proof, root) => proof.reduce((h, p) => (h <= p ? keccak256(concat([h, p])) : keccak256(concat([p, h]))), leaf.toLowerCase()).toLowerCase() === root.toLowerCase();
const epochRow = (n) => mock.table('reward_epochs').find((e) => e.epoch_number === n);
const rewardRows = (epochId) => mock.table('epoch_holder_rewards').filter((r) => r.epoch_id === epochId);
const cb = (w) => mock.table('holder_cost_basis').find((h) => h.wallet_address === w.toLowerCase());
const opts = { skipFreshnessCheck: true, skipFallbackMonitor: true, poolRead: { retryDelayMs: 0 }, balanceRead: { delayMs: 0 } };
const price = Number(PRICE) / 1e18; const lossOn1 = 1 - 1_000_000 * price; // loss per holder on a restored 1.0 ETH investment

console.log('======================================================');
console.log('  WORKER PENDING EPOCHS: V2 holds 0.2923 ETH, #4 (0.3024) and #5 (0.2479) pending; C sold out');
console.log('======================================================\n');
try {
  // 1. reversal + rebuild of #4 from chain
  const r1 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r1.skipped, undefined, `run 1 must publish (got ${r1.reason}: ${r1.detail})`);
  assert.equal(r1.rebuilt, true); assert.equal(r1.epochNumber, 4, 'the oldest pending epoch is rebuilt, no new number');
  assert.equal(mock.table('epoch_holder_rewards').filter((r) => r.epoch_id === 2875).length, 0, "#5's stored rows discarded");
  assert.equal(publishes.length, 1); assert.equal(publishes[0].epochId, 4n); assert.equal(publishes[0].pool, V2);
  const e4 = epochRow(4);
  assert.equal(e4.epoch_id, 2824, 'rebuilt IN PLACE (same epoch_id)'); assert.equal(e4.status, 'published'); assert.ok(e4.onchain_tx_hash?.startsWith('0x'));
  assert.equal(e4.merkle_root, publishes[0].root); assert.equal(e4.scaling_factor, 1, 'demand (2 x 10% of ~0.995) < pool: funded in full');
  const rows4 = rewardRows(2824);
  assert.deepEqual(rows4.map((r) => r.wallet_address).sort(), [A, B].map((w) => w.toLowerCase()).sort(), 'A and B paid; C (sold out on chain) gets nothing');
  for (const r of rows4) {
    assert.ok(Math.abs(Number(r.final_reward_eth) - 0.1 * lossOn1) < 1e-9, `reward = 10% of the loss on the RESTORED 1.0 ETH investment (${r.final_reward_eth})`);
    assert.ok(verifyProof(hashLeaf(tok, 4, r.wallet_address, BigInt(Math.round(Number(r.final_reward_eth) * 1e18))), r.merkle_proof, publishes[0].root), 'proof verifies');
  }
  assert.equal(rows4.reduce((a, r) => a + BigInt(Math.round(Number(r.final_reward_eth) * 1e18)), 0n), publishes[0].allocated, 'allocation == sum of leaves');
  assert.ok(Math.abs(Number(cb(C).total_invested_eth) - 1.0) < 1e-12, "C's depletion reversed (0.0524 given back) and NOT depleted again");
  assert.ok(Math.abs(Number(cb(A).total_invested_eth) - (1.0 - 0.1 * lossOn1)) < 1e-9, 'A: 0.30 given back, then depleted by what #4 actually paid');
  assert.equal(epochRow(5).status, 'pending_funding', '#5 waits for the next run'); assert.equal(epochRow(6), undefined, 'no new epoch number while a pending one exists');
  console.log(`1. reversal (A +0.30, B +0.198, C +0.052) then #4 rebuilt in place from chain: A,B paid ${(0.1 * lossOn1).toFixed(6)} each, C excluded, published  OK`);

  // 2. #5 rebuilt, capped to the pool remainder
  const left = pools[V2].unallocated;
  const r2 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r2.skipped, undefined, `run 2 must publish (${r2.reason})`); assert.equal(r2.epochNumber, 5); assert.equal(r2.rebuilt, true);
  assert.equal(publishes.length, 2); assert.equal(publishes[1].epochId, 5n);
  const e5 = epochRow(5);
  assert.equal(e5.epoch_id, 2875); assert.equal(e5.status, 'published', 'capped and PUBLISHED, not pending'); assert.ok(e5.scaling_factor < 1 && e5.scaling_factor > 0);
  assert.ok(publishes[1].allocated <= left && publishes[1].allocated >= left - worker.LEAF_STABILIZE_SLACK_WEI * 2n, 'epoch #5 takes what the pool has left');
  assert.equal(rewardRows(2875).length, 2);
  console.log(`2. #5 rebuilt in place, capped to ${Number(publishes[1].allocated) / 1e18} ETH (scaling ${e5.scaling_factor.toFixed(4)}), published  OK`);

  // 3. pool ~0 -> new epoch #6 is dust, nothing depleted, no tx
  const invA = Number(cb(A).total_invested_eth);
  const r3 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r3.reason, 'dust_payout'); assert.equal(r3.epochNumber, 6); assert.equal(r3.rebuilt, false);
  assert.equal(epochRow(6).status, 'completed_dust'); assert.equal(publishes.length, 2); assert.equal(Number(cb(A).total_invested_eth), invA, 'no depletion for a dust epoch');
  console.log('3. pool empty -> new epoch #6 recorded as completed_dust, no tx, no depletion  OK');

  // 4. pool read fails on every attempt -> skipped
  failUnallocatedReads = Infinity;
  const r4 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r4.skipped, true); assert.equal(r4.reason, 'pool_read_failed'); assert.equal(publishes.length, 2); assert.equal(epochRow(7), undefined);
  failUnallocatedReads = 0;
  console.log('4. pool read failing every time -> skipped (fail closed), no tx, no row  OK');

  console.log('\nworker-pending-epoch-funding tests passed');
} finally {
  await worker.closeV4Module();
  rpc.close();
}
process.exit(0);
