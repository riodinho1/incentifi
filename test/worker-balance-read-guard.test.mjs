/**
 * WORKER — a balance read below the DB is confirmed on a second endpoint; a disputed read SKIPS the
 * holder (never zeroes, never pays), a read that fails everywhere skips the TOKEN (2026-09-09).
 *
 * Production report: the balance guard logged "on-chain 0" for a wallet holding 21.4M tokens. viem
 * throws on empty/short data and every endpoint answers the same value today, so the only way an
 * RPC can produce that line is a well-formed zero word from a node serving stale or foreign state.
 * This test builds exactly that: endpoint A answers balanceOf(X) = 0 while B answers the truth.
 *
 * Fake chain with TWO endpoints (RPC_URLS = A,B; the failover starts on A). Holders X, Y, Z each
 * hold 1,000,000 tokens in the DB, bought for 10 ETH (cost 1e-5), price now 2e-6 -> all underwater.
 * Chain truth: X 1,000,000; Y 1,000,000; Z 500,000 (sold half). A lies about X only.
 *   1. run 1: X disputed (A: 0, B: 1,000,000) -> SKIPPED: no leaf, no depletion, DB row untouched, loud
 *      log; Y paid in full; Z's decrease is confirmed by B and paid on 500,000. All balance reads are
 *      pinned to one block (hex block tag, never "latest").
 *   2. run 2: balanceOf(X) throws on BOTH endpoints -> the token is skipped: throws, no tx, no epoch row
 *   3. run 3: both endpoints say X = 0 (a real full exit) -> X excluded without dispute, epoch published
 *
 * Run: node test/worker-balance-read-guard.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, getAddress, keccak256, parseTransaction, decodeFunctionData, parseAbi } from 'viem';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

const V1 = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const V2 = getAddress('0x5d94246CD31064Da02E953DB357F0001F0E9A631');
const V3_FACTORY = getAddress('0xa0143de84fba1753b887e4e32941e4fb342e473f');
const LEGIBLE_FACTORY = getAddress('0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const CURVE = getAddress('0x00000000000000000000000000000000000000CC');
const TOKEN = getAddress('0x00000000000000000000000000000000000000E2');
const X = getAddress('0x0000000000000000000000000000000000000AAA');
const Y = getAddress('0x0000000000000000000000000000000000000BBB');
const Z = getAddress('0x0000000000000000000000000000000000000CCC');
const E = 10n ** 18n;
const ZERO32 = '0x' + '0'.repeat(64);
const HEAD = 58_120_000n;

const truth = { [X]: 1_000_000n * E, [Y]: 1_000_000n * E, [Z]: 500_000n * E };
const pools = { [V1]: { unallocated: 0n, roots: new Map() }, [V2]: { unallocated: 10n * E, roots: new Map() } };
const publishes = [];
const POOL_ABI = parseAbi(['function setEpochMerkleRoot(address token, uint256 epochId, bytes32 merkleRoot, uint256 allocatedAmount)']);
const sel = (sig) => toFunctionSelector(sig);
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const hex = (n) => '0x' + BigInt(n).toString(16);
const receipts = new Map();
let nonce = 0;
let mode = 'A-lies-about-X'; // 'throw-for-X' | 'X-really-zero'
const balanceCalls = []; // { endpoint, wallet, blockTag }

function ethCall(endpoint, to, data, blockTag) {
  const t = getAddress(to); const s = data.slice(0, 10);
  if (t === LEGIBLE_FACTORY && s === sel('function isLaunched(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function isGraduated(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function getBondingCurve(address)')) return enc('address', [CURVE]);
  if (t === CURVE && s === sel('function getCurrentPrice()')) return enc('uint256', [2_000_000_000_000n]); // 2e-6 ETH/token
  if (t === TOKEN && s === sel('function balanceOf(address)')) {
    const wallet = getAddress('0x' + data.slice(34, 74));
    balanceCalls.push({ endpoint, wallet, blockTag });
    if (wallet === X) {
      if (mode === 'throw-for-X') return 'FAIL';
      if (mode === 'X-really-zero') return enc('uint256', [0n]);
      if (endpoint === 'A') return enc('uint256', [0n]); // the lie
    }
    return enc('uint256', [truth[wallet] ?? 0n]);
  }
  if (pools[t] && s === sel('function getUnallocatedBalance(address)')) return enc('uint256', [pools[t].unallocated]);
  if (pools[t] && s === sel('function epochMerkleRoots(address,uint256)')) return pools[t].roots.get(BigInt('0x' + data.slice(74, 138)).toString()) || ZERO32;
  if (pools[t] && s === sel('function epochAllocatedAmounts(address,uint256)')) return enc('uint256', [0n]);
  return null;
}
function serve(endpoint) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
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
            case 'eth_call': { const out = ethCall(endpoint, item.params[0].to, item.params[0].data, item.params[1]); if (out === 'FAIL') return err('simulated node failure'); return out ? ok(out) : err('unmocked call'); }
            case 'eth_sendRawTransaction': {
              const raw = item.params[0]; const tx = parseTransaction(raw);
              const { functionName, args } = decodeFunctionData({ abi: POOL_ABI, data: tx.data });
              assert.equal(functionName, 'setEpochMerkleRoot');
              const pool = getAddress(tx.to); const [token, epochId, root, allocated] = args;
              if (allocated > pools[pool].unallocated) return err('InsufficientUnallocatedPool');
              if (pools[pool].roots.has(epochId.toString())) return err('EpochAlreadyPublished');
              pools[pool].unallocated -= allocated; pools[pool].roots.set(epochId.toString(), root);
              publishes.push({ endpoint, pool, token: getAddress(token), epochId, root, allocated });
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
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const A = await serve('A');
const B = await serve('B');

process.env.RPC_URLS = `${A.url},${B.url}`;
process.env.VITE_LOSS_REWARD_POOL = V1;
process.env.LOSS_REWARD_POOL_V2_ADDRESS = V2;
process.env.OPERATOR_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // throwaway test key (hardhat #1)
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v; for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://worker-balance-guard-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'worker-balance-guard-test-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, { upsertKeys: { holder_cost_basis: ['token_address', 'wallet_address'], indexer_heartbeats: ['worker_name'], reward_epochs: ['token_address', 'epoch_number'] } });
globalThis.fetch = mock.fetchImpl;
const tok = TOKEN.toLowerCase();
for (const [i, w] of [X, Y, Z].entries()) mock.seed('holder_cost_basis', [{ id: i + 1, token_address: tok, wallet_address: w.toLowerCase(), token_balance: 1_000_000, total_invested_eth: 10, avg_cost_basis_eth: 1e-5, is_eligible: true, is_underwater_seller: false }]);

const worker = await import('../scripts/loss-reward-worker.mjs');
const logs = [];
const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { logs.push(a.join(' ')); }; console.warn = (...a) => { logs.push(a.join(' ')); }; console.error = (...a) => { logs.push(a.join(' ')); };
const restore = () => { console.log = origLog; console.warn = origWarn; console.error = origError; };
const cb = (w) => mock.table('holder_cost_basis').find((h) => h.wallet_address === w.toLowerCase());
const rows = (epochId) => mock.table('epoch_holder_rewards').filter((r) => r.epoch_id === epochId);
const opts = { skipFreshnessCheck: true, skipFallbackMonitor: true, poolRead: { retryDelayMs: 0 }, balanceRead: { delayMs: 0 } };

origLog('======================================================');
origLog('  WORKER BALANCE READ GUARD: endpoint A says X holds 0, endpoint B says 1,000,000');
origLog('======================================================\n');
try {
  // 1. disputed -> skipped; confirmed decrease -> capped; pinned block
  const r1 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r1.skipped, undefined, `run 1 must publish (got ${r1.reason}: ${r1.detail})`);
  assert.equal(publishes.length, 1);
  assert.deepEqual(r1.skippedHolders.map((s) => s.wallet), [X.toLowerCase()], 'X skipped');
  const ep1 = mock.table('reward_epochs').find((e) => e.epoch_number === 1);
  const rows1 = rows(ep1.epoch_id);
  assert.deepEqual(rows1.map((r) => r.wallet_address).sort(), [Y, Z].map((w) => w.toLowerCase()).sort(), 'Y and Z paid, X absent');
  assert.equal(Number(cb(X).total_invested_eth), 10, 'X not depleted'); assert.equal(Number(cb(X).token_balance), 1_000_000, 'X not zeroed');
  const zRow = rows1.find((r) => r.wallet_address === Z.toLowerCase());
  assert.equal(zRow.token_balance, 500_000, 'Z paid on the CONFIRMED lower balance');
  assert.ok(Math.abs(zRow.final_reward_eth - 0.1 * (5 - 500_000 * 2e-6)) < 1e-9, 'Z reward = 10% of loss on 500k tokens with invested scaled to 5 ETH');
  assert.ok(Math.abs(Number(cb(Y).total_invested_eth) - (10 - 0.1 * (10 - 1_000_000 * 2e-6))) < 1e-9, 'Y depleted by its paid reward');
  const disputedLine = logs.find((l) => /DISPUTED balance for 0x0000000000000000000000000000000000000aaa/i.test(l));
  assert.ok(disputedLine, 'loud DISPUTED log line'); assert.ok(disputedLine.startsWith(`[${tok}]`), 'log line prefixed with the token address');
  assert.ok(logs.some((l) => /1 holder\(s\) SKIPPED this epoch/.test(l)));
  const xCalls = balanceCalls.filter((c) => c.wallet === X);
  assert.deepEqual(xCalls.map((c) => c.endpoint), ['A', 'B'], 'X: primary read on A, confirmation on B');
  const zCalls = balanceCalls.filter((c) => c.wallet === Z);
  assert.deepEqual(zCalls.map((c) => c.endpoint), ['A', 'B'], 'Z: decrease confirmed on B');
  assert.equal(balanceCalls.filter((c) => c.wallet === Y).length, 1, 'Y: no confirmation needed (>= DB)');
  const tags = new Set(balanceCalls.map((c) => c.blockTag));
  assert.equal(tags.size, 1, 'every balance read pinned to the same block'); assert.ok(/^0x[0-9a-f]+$/.test([...tags][0]), `hex block tag, not latest (${[...tags][0]})`);
  assert.equal(BigInt([...tags][0]), HEAD - 1n);
  assert.ok(logs.every((l) => !l.startsWith('[') || l.startsWith(`[${tok}]`) || /^\[RPC\]|^\[POOL READ\]|^\[PENDING\]/.test(l)), 'run lines carry the token prefix');
  origLog('1. X disputed -> skipped (not paid, not zeroed, loud log); Z confirmed on B and capped; reads pinned to one hex block  OK');

  // 2. read fails on every endpoint -> token skipped (throws), nothing written
  mode = 'throw-for-X'; balanceCalls.length = 0;
  const epochsBefore = mock.table('reward_epochs').length; const rowsBefore = mock.table('epoch_holder_rewards').length;
  await assert.rejects(worker.executeEpochForToken(TOKEN, opts), /BALANCE GUARD.*refusing to compute epoch on unverified holder data/);
  assert.equal(publishes.length, 1, 'no tx'); assert.equal(mock.table('reward_epochs').length, epochsBefore, 'no epoch row'); assert.equal(mock.table('epoch_holder_rewards').length, rowsBefore);
  assert.equal(Number(cb(Y).total_invested_eth) > 0 && Number(cb(X).total_invested_eth), 10, 'nothing depleted');
  origLog('2. balanceOf(X) failing on A and B -> token skipped, no tx, no rows  OK');

  // 3. both endpoints agree X is 0 -> real exit, no dispute, epoch published for Y and Z
  mode = 'X-really-zero'; balanceCalls.length = 0;
  const r3 = await worker.executeEpochForToken(TOKEN, opts);
  assert.equal(r3.skipped, undefined, `run 3 must publish (${r3.reason})`); assert.equal(r3.skippedHolders.length, 0, 'no dispute when both agree');
  assert.equal(publishes.length, 2);
  const ep2 = mock.table('reward_epochs').find((e) => e.epoch_number === 2);
  assert.deepEqual(rows(ep2.epoch_id).map((r) => r.wallet_address).sort(), [Y, Z].map((w) => w.toLowerCase()).sort(), 'X (sold out) gets nothing');
  assert.deepEqual(balanceCalls.filter((c) => c.wallet === X).map((c) => c.endpoint), ['A', 'B'], 'the zero was confirmed on B before being believed');
  origLog('3. A and B both say 0 -> X excluded as a real exit, epoch published  OK');

  restore();
  console.log('\nworker-balance-read-guard tests passed');
} catch (err) {
  restore();
  console.log('--- captured logs (last 25) ---'); for (const l of logs.slice(-25)) console.log(l);
  throw err;
} finally {
  await worker.closeV4Module();
  A.srv.close(); B.srv.close();
}
process.exit(0);
