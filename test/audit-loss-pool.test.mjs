/**
 * OPS — scripts/ops/audit-loss-pool.mjs reconciles pool events against pool state (chain-only mode).
 *
 * Fake chain: V1 and V2 "deployed" at block 1000; token A has 2 deposits, 2 published epochs and 1 claim
 * on V2 with one RewardPaid in stock and one BelowMinimum fallback; token B has one deposit on V1. State
 * counters match the events, pool balances equal unallocated + owed, so the audit prints a 0-wei gap.
 * Then the V2 balance is made 1 wei too high and the run must flag the gap. Runs with --no-db.
 *
 * Run: node test/audit-loss-pool.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { encodeAbiParameters, parseAbiParameters, getAddress, keccak256, toHex, toFunctionSelector, encodeEventTopics, parseAbi } from 'viem';

const V1 = getAddress('0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF'), V2 = getAddress('0x5d94246CD31064Da02E953DB357F0001F0E9A631');
const A = getAddress('0x00000000000000000000000000000000000000A1'), B = getAddress('0x00000000000000000000000000000000000000B1');
const H1 = getAddress('0x0000000000000000000000000000000000000111'), OP = getAddress('0x743F4fD6ca1C65654e6825a2E0fC7147c17531E3'), NVDA = getAddress('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
const E = 10n ** 18n; const enc = (t, v) => encodeAbiParameters(parseAbiParameters(t), v); const sel = (s) => toFunctionSelector(s); const hex = (n) => '0x' + BigInt(n).toString(16); const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const EV = parseAbi(['event RewardDeposited(address indexed token, address indexed sender, uint256 amount)', 'event EpochRootPublished(address indexed token, uint256 indexed epochId, bytes32 merkleRoot, uint256 allocatedAmount)', 'event RewardClaimed(address indexed token, uint256 indexed epochId, address indexed claimant, uint256 amount)', 'event RewardPaid(address indexed token, address indexed claimant, uint256 ethAmount, address indexed asset, uint256 assetAmount)', 'event RewardPaidInEthFallback(address indexed claimant, address indexed token, address indexed asset, uint8 reason, bytes data)', 'event OperatorUpdated(address indexed previousOperator, address indexed newOperator)']);
const topic = (name) => encodeEventTopics({ abi: EV, eventName: name })[0];
// A on V2: deposits 1 + 2 ETH; epochs 1 (0.5) and 2 (0.25); claim epoch 1 0.5 paid in NVDA; a fallback event for a second (tiny) claim path is emitted without a claim to keep sums simple
const state = { [V2]: { [A]: { dep: 3n * E, alloc: 75n * E / 100n, claimed: 5n * E / 10n } }, [V1]: { [B]: { dep: 7n * E / 10n, alloc: 0n, claimed: 0n } } };
let v2Extra = 0n;
const poolEth = (p) => Object.values(state[p]).reduce((a, s) => a + s.dep - s.claimed, 0n) + (p === V2 ? v2Extra : 0n);
const L = (address, topics, data, block) => ({ address: address.toLowerCase(), topics, data, blockNumber: hex(block), transactionHash: keccak256(toHex(`${address}-${block}-${topics[0]}`)), transactionIndex: '0x0', blockHash: '0x' + '22'.repeat(32), logIndex: '0x0', removed: false });
const logs = {
  [V2]: [L(V2, [topic('OperatorUpdated'), pad('0x0000000000000000000000000000000000000000'), pad(OP)], '0x', 1001), L(V2, [topic('RewardDeposited'), pad(A), pad(OP)], enc('uint256', [E]), 1100), L(V2, [topic('RewardDeposited'), pad(A), pad(OP)], enc('uint256', [2n * E]), 1200), L(V2, [topic('EpochRootPublished'), pad(A), '0x' + '1'.padStart(64, '0')], enc('bytes32, uint256', ['0x' + 'ab'.repeat(32), 5n * E / 10n]), 1300), L(V2, [topic('EpochRootPublished'), pad(A), '0x' + '2'.padStart(64, '0')], enc('bytes32, uint256', ['0x' + 'cd'.repeat(32), 25n * E / 100n]), 1400), L(V2, [topic('RewardClaimed'), pad(A), '0x' + '1'.padStart(64, '0'), pad(H1)], enc('uint256', [5n * E / 10n]), 1500), L(V2, [topic('RewardPaid'), pad(A), pad(H1), pad(NVDA)], enc('uint256, uint256', [5n * E / 10n, 3n * E]), 1500), L(V2, [topic('RewardPaidInEthFallback'), pad(H1), pad(A), pad(NVDA)], enc('uint8, bytes', [7, '0x']), 1600)],
  [V1]: [L(V1, [topic('RewardDeposited'), pad(B), pad(OP)], enc('uint256', [7n * E / 10n]), 1050)],
};
const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const q = JSON.parse(b); const one = (it) => { const ok = (r) => ({ jsonrpc: '2.0', id: it.id, result: r }); switch (it.method) {
  case 'eth_chainId': return ok('0x1237'); case 'eth_blockNumber': return ok(hex(20_000)); case 'eth_gasPrice': return ok(hex(100_000_000n));
  case 'eth_getBlockByNumber': return ok({ number: it.params[0] === 'latest' ? hex(20_000) : it.params[0], timestamp: hex(1_790_000_000n + BigInt(it.params[0] === 'latest' ? 20_000 : parseInt(it.params[0], 16))), hash: '0x' + '11'.repeat(32), transactions: [] });
  case 'eth_getCode': { const bn = BigInt(it.params[1]); return ok(bn >= 1000n ? '0x6001' : '0x'); }
  case 'eth_getBalance': { const a = getAddress(it.params[0]); return ok(hex(a === V1 || a === V2 ? poolEth(a) : a === OP ? 10n ** 12n : 0n)); }
  case 'eth_getTransactionCount': return ok(hex(67));
  case 'eth_getLogs': { const f = it.params[0]; const a = getAddress(f.address); const from = BigInt(f.fromBlock), to = BigInt(f.toBlock); return ok((logs[a] || []).filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to)); }
  case 'eth_getTransactionReceipt': return ok({ transactionHash: it.params[0], status: '0x1', blockNumber: hex(1400), blockHash: '0x' + '22'.repeat(32), transactionIndex: '0x0', from: OP, to: V2, gasUsed: hex(80_000), cumulativeGasUsed: hex(80_000), effectiveGasPrice: hex(100_000_000n), logs: [], logsBloom: '0x' + '0'.repeat(512), type: '0x2', contractAddress: null });
  case 'eth_getTransactionByHash': return ok({ hash: it.params[0], from: OP, to: V2, nonce: '0x5', blockNumber: hex(1400), blockHash: '0x' + '22'.repeat(32), transactionIndex: '0x0', value: '0x0', input: '0x', gas: hex(100_000), gasPrice: hex(100_000_000n), type: '0x2', chainId: '0x1237', v: '0x0', r: '0x0', s: '0x0', maxFeePerGas: hex(100_000_000n), maxPriorityFeePerGas: '0x0', accessList: [] });
  case 'eth_call': { const { to, data } = it.params[0]; const t = getAddress(to); const s = data.slice(0, 10);
    if (t === getAddress('0xcA11bde05977b3631167028862bE2a173976CA11')) { // aggregate3: decode calls, answer each
      const dec = decodeAgg3(data); return ok(enc('(bool, bytes)[]', [dec.map((c) => [true, answer(getAddress(c.target), c.callData)])])); }
    const out = answer(t, data); return out ? ok(out) : { jsonrpc: '2.0', id: it.id, error: { code: 3, message: 'unmocked ' + s, data: '0x' } }; }
  default: return { jsonrpc: '2.0', id: it.id, error: { code: -32601, message: it.method } }; } };
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q))); }); });
function answer(t, data) { const s = data.slice(0, 10); const tok = data.length >= 74 ? getAddress('0x' + data.slice(34, 74)) : null;
  if (t === A || t === B || t === NVDA) { if (s === sel('function symbol()')) return enc('string', [t === A ? 'AAA' : t === B ? 'BBB' : 'NVDA']); return enc('uint256', [0n]); }
  if (t === V1 || t === V2) { const st = (state[t] || {})[tok] || { dep: 0n, alloc: 0n, claimed: 0n };
    if (s === sel('function totalDeposited(address)')) return enc('uint256', [st.dep]); if (s === sel('function totalAllocated(address)')) return enc('uint256', [st.alloc]); if (s === sel('function totalClaimed(address)')) return enc('uint256', [st.claimed]); if (s === sel('function getUnallocatedBalance(address)')) return enc('uint256', [st.dep - st.alloc]);
    if (s === sel('function operator()')) return enc('address', [OP]); if (s === sel('function owner()')) return enc('address', [OP]); if (s === sel('function minStockRewardWei()')) return enc('uint256', [2n * E / 1000n]);
    if (s === sel('function rewardAsset(address)')) return enc('address, bool, bool', [tok === A ? NVDA : '0x0000000000000000000000000000000000000000', tok === A, false]); }
  return null; }
function decodeAgg3(data) { // aggregate3((address,bool,bytes)[]) — minimal decoder
  const words = (i) => data.slice(10 + i * 64, 10 + (i + 1) * 64); const arrOff = Number(BigInt('0x' + words(0))) / 32; const n = Number(BigInt('0x' + words(arrOff))); const out = [];
  for (let i = 0; i < n; i++) { const off = arrOff + 1 + Number(BigInt('0x' + words(arrOff + 1 + i))) / 32; const target = '0x' + words(off).slice(24); const cdOff = off + Number(BigInt('0x' + words(off + 2))) / 32; const len = Number(BigInt('0x' + words(cdOff))); out.push({ target, callData: '0x' + data.slice(10 + (cdOff + 1) * 64, 10 + (cdOff + 1) * 64 + len * 2) }); } return out; }
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}`;
// async spawn: the fake RPC server lives in THIS process, so a blocking spawnSync would starve it
const run = () => new Promise((resolve) => { fs.rmSync('.audit-cache-test', { recursive: true, force: true }); let out = ''; const child = spawn(process.execPath, ['scripts/ops/audit-loss-pool.mjs', '--no-db', '--json', '.audit-cache-test/out.json'], { env: { ...process.env, RPC_URLS: url, RPC_GETLOGS_MIN_INTERVAL_MS: '0', RPC_TIMEOUT_MS: '5000', AUDIT_CACHE_DIR: '.audit-cache-test' } }); child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d)); child.on('close', (status) => resolve({ status, out, json: fs.existsSync('.audit-cache-test/out.json') ? JSON.parse(fs.readFileSync('.audit-cache-test/out.json', 'utf8')) : null })); });
console.log('======================================================');
console.log('  AUDIT LOSS POOL (chain-only, fake chain)');
console.log('======================================================\n');
try {
  const r1 = await run(); assert.equal(r1.status, 0, r1.out.slice(-1500));
  console.log('   tokens:', JSON.stringify(r1.json.tokens.map((t) => [t.pool, t.symbol, t.token])), '| flags:', JSON.stringify(r1.json.flags)); if (!r1.json.tokens.length) console.log(r1.out.slice(-2500));
  const a = r1.json.tokens.find((t) => t.symbol === 'AAA' && t.pool === 'V2'); const b = r1.json.tokens.find((t) => t.symbol === 'BBB' && t.pool === 'V1');
  assert.equal(a.events.deposits, 2); assert.equal(a.events.depositedSum, (3n * E).toString()); assert.equal(a.events.published, 2); assert.equal(a.events.allocatedSum, (75n * E / 100n).toString()); assert.equal(a.events.claims, 1); assert.equal(a.state.stillOwed, (25n * E / 100n).toString()); assert.equal(a.state.unallocated, (225n * E / 100n).toString());
  assert.equal(a.rewardAsset.symbol, 'NVDA'); assert.equal(a.payouts.stock, 1); assert.equal(a.payouts.fallbacks, 1); assert.deepEqual(a.payouts.reasons, { BelowMinimum: 1 });
  assert.equal(b.events.deposits, 1); assert.equal(b.state.unallocated, (7n * E / 10n).toString());
  assert.equal(r1.json.pools.V2.reconciliation.gapWei, '0'); assert.equal(r1.json.pools.V1.reconciliation.gapWei, '0');
  assert.equal(r1.json.lastPublishAnywhere.epoch, 2); assert.equal(r1.json.operator.canPublish, false, '1e12 wei < one publish at 0.1 gwei');
  assert.ok(r1.json.flags.some((f) => /publishing has stopped/.test(f)), r1.json.flags.join('\n'));
  assert.ok(!r1.json.flags.some((f) => /differs from unallocated/.test(f)));
  assert.match(r1.out, /gap 0 wei/); assert.match(r1.out, /pays NVDA/);
  console.log('1. event sums == state, stillOwed/unallocated right, stock payout + BelowMinimum fallback decoded, 0-wei gap, operator flagged  OK');
  v2Extra = 1n; const r2 = await run(); assert.equal(r2.status, 0, r2.out.slice(-800));
  assert.equal(r2.json.pools.V2.reconciliation.gapWei, '1'); assert.ok(r2.json.flags.some((f) => /V2: pool ETH balance differs from unallocated \+ owed by 1 wei/.test(f)), r2.json.flags.join('\n'));
  console.log('2. a 1-wei surplus in the pool is flagged  OK');
  console.log('\naudit-loss-pool tests passed');
} finally { srv.close(); fs.rmSync('.audit-cache-test', { recursive: true, force: true }); }
process.exit(0);
