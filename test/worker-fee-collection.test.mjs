/**
 * WORKER — LEGIBLE-POOL FEE COLLECTION (collect() + convert() when worth the gas).
 *
 * Production symptom (TESSSS): nobody calls hook.collect()/converter.convert(), so creatorBalances
 * and LossRewardPoolV2.totalDeposited stay 0 despite trades. The worker now, per tick, for legible
 * tokens with recent trades: simulates collect() from state and sends it when ETH fees >= 10x gas;
 * then sends convert(token, 0, 0) when the pending token-side fees' checkpoint value >= 10x gas.
 *
 * Offline: a local JSON-RPC server plays the chain (factory/hook/StateView/converter reads, gas
 * price, estimateGas, and the full signing path — every eth_sendRawTransaction is decoded and
 * applied: collect zeroes the position's fee growth delta and queues token fees in the converter;
 * convert drains them) and a Supabase mock supplies recent trades. Cases:
 *   1. decideFeeAction: the 10x rule at the boundary, zero value, zero gas
 *   2. token A: 0.02 ETH uncollected >> gas -> collect sent with estimate+30% (floor 300k), then
 *      pending token fees worth 0.01 ETH -> convert sent; both logged with the receipt figures
 *   3. token B: 0.00001 ETH uncollected (~1x gas) -> nothing sent, reason names the ratio
 *   4. token C: not legible (V3 launch) -> not even considered; dry run sends nothing
 *   5. gas policy: limit == max(estimate * 1.3, 300k)
 *
 * Run: node test/worker-fee-collection.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, getAddress, keccak256, parseTransaction, decodeFunctionData, parseAbi, encodeEventTopics, toHex, formatEther } from 'viem';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

const LEGIBLE_FACTORY = getAddress('0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const HOOK = getAddress('0x921d0bE20A21e5A687734b4dF6302EA55BD168C0');
const CONVERTER = getAddress('0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
const V3_FACTORY = getAddress('0xa0143de84fba1753b887e4e32941e4fb342e473f');
const OLD_V4_FACTORY = getAddress('0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0');
const ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN_A = getAddress('0x00000000000000000000000000000000000000A1'); // rich fees
const TOKEN_B = getAddress('0x00000000000000000000000000000000000000B1'); // dust fees
const TOKEN_C = getAddress('0x00000000000000000000000000000000000000C1'); // not legible
const OPERATOR = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'); // hardhat #1 (throwaway)
const E = 10n ** 18n;
const Q128 = 1n << 128n;
const L = 48215215764839215328822n; // CURVE_LIQUIDITY
const GAS_PRICE = 300_000_000n; // 0.3 gwei
const COLLECT_GAS = 288_048n;
const CONVERT_GAS = 190_000n;

const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const sel = (sig) => toFunctionSelector(sig);
const hex = (n) => '0x' + BigInt(n).toString(16);
const growthFor = (feesWei) => (feesWei * Q128) / L; // feeGrowthInside such that fees ~= growth * L / 2^128
const feesFor = (growth) => (growth * L) >> 128n; // what the PoolManager formula yields back (floor rounding)

// fake chain state per token
const state = {
  [TOKEN_A]: { legible: true, growth0: growthFor(E / 50n), growth1: growthFor(800_000n * E), last0: 0n, last1: 0n, pending: 0n, checkpointEthPerToken: 12_500_000_000n /* 1.25e-8 ETH/token -> 800k tokens = 0.01 ETH */ },
  [TOKEN_B]: { legible: true, growth0: growthFor(E / 100_000n), growth1: 0n, last0: 0n, last1: 0n, pending: 0n, checkpointEthPerToken: 0n },
  [TOKEN_C]: { legible: false },
};
const poolIdOf = (t) => keccak256(toHex(t.toLowerCase() + 'pool'));
const sent = [];
const receipts = new Map();
let nonce = 0;
const HEAD = 57_300_000n;
const HOOK_ABI = parseAbi(['function collect(address token)', 'event FeesCollected(bytes32 indexed poolId, uint256 ethFees, uint256 tokenFees, uint256 creatorShare, uint256 lossPoolShare)']);
const CONV_ABI = parseAbi(['function convert(address token, uint256 amount, uint256 minEthOut) returns (uint256)', 'event Converted(address indexed token, uint256 tokensIn, uint256 ethOut, uint256 creatorShare, uint256 lossPoolShare)']);
const tokenOfPoolId = (pid) => Object.keys(state).find((t) => poolIdOf(t) === pid);
const tokenOfCalldata = (data) => getAddress('0x' + data.slice(34, 74));

function ethCall(to, data) {
  const t = getAddress(to); const s = data.slice(0, 10);
  if (t === LEGIBLE_FACTORY && s === sel('function isLaunched(address)')) return enc('bool', [Boolean(state[tokenOfCalldata(data)]?.legible)]);
  if (t === OLD_V4_FACTORY && s === sel('function isLaunched(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function isGraduated(address)')) return enc('bool', [false]);
  if (t === V3_FACTORY && s === sel('function getBondingCurve(address)')) return enc('address', [ZERO]);
  if (t === HOOK && s === sel('function poolIdOf(address)')) return enc('bytes32', [poolIdOf(tokenOfCalldata(data))]);
  if (t === HOOK && s === sel('function tokenStates(bytes32)')) {
    const tok = tokenOfPoolId('0x' + data.slice(10, 74));
    return enc('(address,address,bool,bool,bool,uint256,uint256,uint256,uint256,uint128)', [[tok, OPERATOR, true, true, false, 0n, 0n, 0n, 0n, 0n]]);
  }
  if (t === STATE_VIEW && s === sel('function getPositionInfo(bytes32,address,int24,int24,bytes32)')) {
    const st = state[tokenOfPoolId('0x' + data.slice(10, 74))];
    return enc('uint128,uint256,uint256', [L, st.last0, st.last1]);
  }
  if (t === STATE_VIEW && s === sel('function getFeeGrowthInside(bytes32,int24,int24)')) {
    const st = state[tokenOfPoolId('0x' + data.slice(10, 74))];
    return enc('uint256,uint256', [st.growth0, st.growth1]);
  }
  if (t === CONVERTER && s === sel('function pendingTokenFees(address)')) return enc('uint256', [state[tokenOfCalldata(data)].pending]);
  if (t === CONVERTER && s === sel('function checkpointEthValue(address,uint256)')) {
    const st = state[tokenOfCalldata(data)]; const amount = BigInt('0x' + data.slice(74, 138));
    return enc('uint256', [(amount * st.checkpointEthPerToken) / E]);
  }
  return null;
}

function applyTx(raw) {
  const tx = parseTransaction(raw);
  const to = getAddress(tx.to);
  const logs = [];
  let fn;
  if (to === HOOK) {
    const d = decodeFunctionData({ abi: HOOK_ABI, data: tx.data }); fn = d.functionName;
    const tok = getAddress(d.args[0]); const st = state[tok];
    const ethFees = ((st.growth0 - st.last0) * L) >> 128n; const tokenFees = ((st.growth1 - st.last1) * L) >> 128n;
    st.last0 = st.growth0; st.last1 = st.growth1; st.pending += tokenFees;
    const creator = ethFees / 2n;
    logs.push({ address: HOOK, topics: encodeEventTopics({ abi: HOOK_ABI, eventName: 'FeesCollected', args: { poolId: poolIdOf(tok) } }), data: enc('uint256,uint256,uint256,uint256', [ethFees, tokenFees, creator, ethFees - creator]) });
  } else if (to === CONVERTER) {
    const d = decodeFunctionData({ abi: CONV_ABI, data: tx.data }); fn = d.functionName;
    const tok = getAddress(d.args[0]); const st = state[tok];
    const tokensIn = st.pending; const ethOut = (tokensIn * st.checkpointEthPerToken) / E; st.pending = 0n;
    logs.push({ address: CONVERTER, topics: encodeEventTopics({ abi: CONV_ABI, eventName: 'Converted', args: { token: tok } }), data: enc('uint256,uint256,uint256,uint256', [tokensIn, ethOut, ethOut / 2n, ethOut - ethOut / 2n]) });
  } else throw new Error('unexpected tx target ' + to);
  const hash = keccak256(raw);
  sent.push({ to, fn, gas: tx.gas, hash });
  nonce++;
  receipts.set(hash, { transactionHash: hash, status: '0x1', blockNumber: hex(HEAD), blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', gasUsed: hex(to === HOOK ? 250_000n : 170_000n), cumulativeGasUsed: hex(250_000n), effectiveGasPrice: hex(GAS_PRICE), logs: logs.map((l, i) => ({ ...l, blockNumber: hex(HEAD), blockHash: '0x' + '11'.repeat(32), transactionHash: hash, transactionIndex: '0x0', logIndex: hex(i), removed: false })), logsBloom: '0x' + '0'.repeat(512), type: '0x2', from: OPERATOR, to, contractAddress: null });
  return hash;
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
        case 'eth_gasPrice': return ok(hex(GAS_PRICE));
        case 'eth_maxPriorityFeePerGas': return ok(hex(1_000_000n));
        case 'eth_getBlockByNumber': return ok({ number: hex(HEAD), baseFeePerGas: hex(GAS_PRICE), gasLimit: hex(30_000_000n), timestamp: hex(1_788_900_000n), hash: '0x' + '11'.repeat(32), transactions: [] });
        case 'eth_getTransactionCount': return ok(hex(nonce));
        case 'eth_estimateGas': { const to = getAddress(item.params[0].to); return ok(hex(to === HOOK ? COLLECT_GAS : CONVERT_GAS)); }
        case 'eth_call': { const out = ethCall(item.params[0].to, item.params[0].data); return out ? ok(out) : err('unmocked call ' + item.params[0].to + ' ' + item.params[0].data.slice(0, 10)); }
        case 'eth_sendRawTransaction': return ok(applyTx(item.params[0]));
        case 'eth_getTransactionReceipt': return ok(receipts.get(item.params[0]) || null);
        default: return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: `unsupported: ${item.method}` } };
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));

process.env.VITE_EVM_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
process.env.OPERATOR_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // throwaway (hardhat #1)
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v; for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://worker-fee-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'worker-fee-test-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, { upsertKeys: { token_trades_evm: ['tx_hash'] } });
globalThis.fetch = mock.fetchImpl;
const NOW = Date.parse('2026-09-08T12:00:00Z');
mock.seed('token_trades_evm', [
  { tx_hash: '0x01', token_address: TOKEN_A.toLowerCase(), block_time: new Date(NOW - 3600e3).toISOString() },
  { tx_hash: '0x02', token_address: TOKEN_A.toLowerCase(), block_time: new Date(NOW - 7200e3).toISOString() },
  { tx_hash: '0x03', token_address: TOKEN_B.toLowerCase(), block_time: new Date(NOW - 600e3).toISOString() },
  { tx_hash: '0x04', token_address: TOKEN_C.toLowerCase(), block_time: new Date(NOW - 600e3).toISOString() },
  { tx_hash: '0x05', token_address: '0x00000000000000000000000000000000000000d1', block_time: new Date(NOW - 48 * 3600e3).toISOString() }, // too old
]);
mock.seed('tokens', [
  { mint_address: TOKEN_A, hook_address: HOOK.toLowerCase() },
  { mint_address: TOKEN_B, hook_address: null }, // untagged -> checked on-chain
  { mint_address: TOKEN_C, hook_address: null },
]);

const worker = await import('../scripts/loss-reward-worker.mjs');

console.log('======================================================');
console.log('  WORKER FEE COLLECTION: collect() + convert() when worth the gas');
console.log('======================================================\n');
try {
  // 1. the decision rule
  const cost = COLLECT_GAS * GAS_PRICE; // 8.64e13 wei
  assert.equal(worker.decideFeeAction({ valueWei: cost * 10n, gasEstimate: COLLECT_GAS, gasPriceWei: GAS_PRICE, minMultiple: 10 }).send, true, 'exactly 10x -> send');
  assert.equal(worker.decideFeeAction({ valueWei: cost * 10n - 1n, gasEstimate: COLLECT_GAS, gasPriceWei: GAS_PRICE, minMultiple: 10 }).send, false, 'just under 10x -> hold');
  assert.equal(worker.decideFeeAction({ valueWei: 0n, gasEstimate: COLLECT_GAS, gasPriceWei: GAS_PRICE }).send, false);
  assert.equal(worker.decideFeeAction({ valueWei: 1n, gasEstimate: 0n, gasPriceWei: GAS_PRICE }).send, true, 'zero cost -> send');
  assert.match(worker.decideFeeAction({ valueWei: cost * 3n, gasEstimate: COLLECT_GAS, gasPriceWei: GAS_PRICE }).reason, /3\.0x gas \(< 10x\)/);
  assert.equal(worker.feeTxGasLimit(COLLECT_GAS), (COLLECT_GAS * 130n) / 100n, 'estimate + 30% when above the floor');
  assert.equal(worker.feeTxGasLimit(100_000n), 300_000n, 'floor 300k');
  console.log('1. decideFeeAction 10x boundary + gas limit policy  OK');

  // 2-4. a full pass
  const logs = [];
  const results = await worker.collectLegibleFees({ log: (m) => logs.push(m), alert: async () => {}, now: () => NOW, lookbackHours: 24 });
  const byToken = Object.fromEntries(results.map((r) => [r.token, r]));
  assert.deepEqual(Object.keys(byToken).sort(), [TOKEN_A, TOKEN_B].sort(), 'only legible tokens with trades in the last 24h are considered (C is not legible, D too old)');

  // token A: collect then convert
  const a = byToken[TOKEN_A];
  assert.equal(a.collect.sent, true, 'A: collect sent');
  const ethA = feesFor(growthFor(E / 50n)); const tokA = feesFor(growthFor(800_000n * E));
  assert.ok(ethA > E / 50n - 10n ** 9n && ethA <= E / 50n, 'fixture ~0.02 ETH');
  assert.equal(BigInt(a.collect.ethFees), ethA, 'ethFees from the FeesCollected receipt == simulated');
  assert.equal(BigInt(a.collect.creatorShare), ethA / 2n); assert.equal(BigInt(a.collect.lossPoolShare), ethA - ethA / 2n);
  assert.equal(BigInt(a.collect.tokenFees), tokA);
  assert.equal(a.convert.sent, true, 'A: convert sent (pending 800k tokens ~ 0.01 ETH >> gas)');
  assert.equal(BigInt(a.convert.tokensIn), tokA); assert.equal(BigInt(a.convert.ethOut), (tokA * state[TOKEN_A].checkpointEthPerToken) / E);
  assert.equal(state[TOKEN_A].pending, 0n, 'converter drained');
  const txA = sent.filter((t) => true);
  assert.deepEqual(txA.map((t) => t.fn), ['collect', 'convert'], 'exactly collect then convert, nothing for B');
  assert.equal(txA[0].gas, (COLLECT_GAS * 130n) / 100n, 'collect gas limit = estimate + 30%');
  assert.equal(txA[1].gas, 300_000n, 'convert gas limit = floor 300k (estimate 190k * 1.3 = 247k < 300k)');
  const collectLog = logs.find((l) => l.includes(`[FEE COLLECT] ${TOKEN_A}: collect() sent`));
  assert.ok(collectLog && collectLog.includes(`creator ${formatEther(ethA / 2n)}`) && collectLog.includes(`loss pool ${formatEther(ethA - ethA / 2n)}`), `collect logged with the split: ${collectLog}`);
  const convertLog = logs.find((l) => l.includes(`[FEE CONVERT] ${TOKEN_A}: convert() sent`));
  assert.ok(convertLog && convertLog.includes(`-> ${formatEther(BigInt(a.convert.ethOut))} ETH`), `convert logged with ethOut: ${convertLog}`);
  console.log('2. token A: 0.02 ETH uncollected -> collect (gas 288,048*1.3), then 800k tokens ~0.01 ETH -> convert (gas floor 300k)  OK');

  // token B: dust
  const b = byToken[TOKEN_B];
  assert.equal(b.collect.sent, false);
  assert.match(b.collect.reason, /value only 0\.1x gas \(< 10x\)/, 'B: 0.00001 ETH vs 0.0000864 ETH gas -> 0.1x');
  assert.equal(b.convert.sent, false); assert.equal(b.convert.reason, 'nothing pending');
  assert.equal(state[TOKEN_B].last0, 0n, 'B: nothing collected');
  console.log('3. token B: fees ~0.1x gas -> held, reason names the ratio  OK');

  // second pass: A has nothing left -> nothing sent
  const again = await worker.collectLegibleFees({ log: () => {}, alert: async () => {}, now: () => NOW, tokens: [TOKEN_A] });
  assert.equal(again[0].collect.sent, false); assert.equal(again[0].collect.reason, 'nothing to collect');
  assert.equal(again[0].convert.reason, 'nothing pending');
  assert.equal(sent.length, 2, 'no new transactions');
  // dry run with fresh fees on A: decided but not sent
  state[TOKEN_A].growth0 += growthFor(E / 10n);
  const dry = await worker.collectLegibleFees({ log: () => {}, alert: async () => {}, dryRun: true, tokens: [TOKEN_A] });
  assert.equal(dry[0].collect.sent, false); assert.equal(dry[0].collect.reason, 'dry run');
  assert.equal(sent.length, 2, 'dry run sends nothing');
  console.log('4. idempotent second pass; dry run decides without sending; non-legible token never considered  OK');

  console.log('\nworker-fee-collection tests passed');
} finally {
  await worker.closeV4Module();
  rpc.close();
}
process.exit(0);
