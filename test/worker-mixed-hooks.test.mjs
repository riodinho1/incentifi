/**
 * WORKER — MIXED HOOK SET. scripts/loss-reward-worker.mjs getTokenBenchmarkPriceEth() must
 * resolve the right benchmark for each of the three coexisting venues, per token:
 *   * a LEGIBLE-pool token (PR #17)  -> the pool's own slot0 price, source 'v4_legible_slot0'
 *   * a V3 curve token                -> curve.getCurrentPrice(), source 'bonding_curve'
 *   * a GenericSell V4 token          -> the older Vite-loaded path, source 'v4_hook_curve'
 * The legible branch must not disturb the other two (it is one factory read per token).
 *
 * Offline: a local JSON-RPC server answers every eth_call by (to, selector). The worker and the
 * frontend module it loads through Vite are real and unmodified; VITE_EVM_RPC_URL points both
 * at the fake chain.
 *
 * Run: node test/worker-mixed-hooks.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, getAddress } from 'viem';

process.env.VITE_SUPABASE_URL ||= 'https://worker-mixed-hooks-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'worker-mixed-hooks-test-key';
process.env.VITE_SUPABASE_ANON_KEY ||= 'worker-mixed-hooks-anon';

// ---- addresses (the worker's defaults) ----------------------------------------------------------
const LEGIBLE_FACTORY = getAddress('0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const LEGIBLE_HOOK = getAddress('0x921d0bE20A21e5A687734b4dF6302EA55BD168C0');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
const V3_FACTORY = getAddress('0xa0143de84fba1753b887e4e32941e4fb342e473f');
const OLD_V4_FACTORY = getAddress('0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0');
const OLD_V4_HOOK = getAddress('0xC5Ef9Cb8c95cd8540E71b6D4c00a90257625a888');
const TOKEN_LEGIBLE = getAddress('0x00000000000000000000000000000000000000A1');
const TOKEN_V3 = getAddress('0x00000000000000000000000000000000000000B3');
const TOKEN_GENERIC = getAddress('0x00000000000000000000000000000000000000C4');
const V3_CURVE = getAddress('0x00000000000000000000000000000000000000CC');
const ZERO = '0x0000000000000000000000000000000000000000';

const sel = (sig) => toFunctionSelector(sig);
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const addr32 = (a) => enc('address', [a]);
const bool32 = (b) => enc('bool', [b]);
const u256 = (v) => enc('uint256', [v]);

// legible pool fixture: sqrtP for ~2e-9 ETH/token (like SMK95868 after a small buy)
const SQRT_P = 1767481963123206458708907005982244n;
const expectedLegiblePrice = 1 / (Number(SQRT_P) / 2 ** 96) ** 2;
const poolKey = { currency0: ZERO, currency1: TOKEN_LEGIBLE, fee: 8388608, tickSpacing: 10, hooks: LEGIBLE_HOOK };
const poolKeyEnc = enc('(address,address,uint24,int24,address)', [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]]);
const curveStatesEnc = (token, graduated) => enc('address,address,bool,bool,uint256,uint256', [token, ZERO, true, graduated, 4_888_890_840_044_903n, 997_561_377_023_353_667_689_729_335n]);
const genericPoolKeyEnc = enc('(address,address,uint24,int24,address)', [[ZERO, TOKEN_GENERIC, 10000, 1, OLD_V4_HOOK]]);

const calls = [];
function answer(to, data) {
  const t = getAddress(to);
  const s = data.slice(0, 10);
  calls.push(`${t}:${s}`);
  // legible factory
  if (t === LEGIBLE_FACTORY && s === sel('function isLaunched(address)')) return bool32(data.toLowerCase().includes(TOKEN_LEGIBLE.slice(2).toLowerCase()));
  if (t === LEGIBLE_FACTORY && s === sel('function getPoolKey(address)')) return poolKeyEnc;
  if (t === LEGIBLE_HOOK && s === sel('function curveStates(bytes32)')) return curveStatesEnc(TOKEN_LEGIBLE, false);
  if (t === STATE_VIEW && s === sel('function getSlot0(bytes32)')) return enc('uint160,int24,uint24,uint24', [SQRT_P, 200264, 0, 0]);
  if (t === STATE_VIEW && s === sel('function getLiquidity(bytes32)')) return enc('uint128', [48215215764839215328822n]);
  // V3 factory + curve
  if (t === V3_FACTORY && s === sel('function isGraduated(address)')) return bool32(false);
  if (t === V3_FACTORY && s === sel('function getBondingCurve(address)')) return addr32(data.toLowerCase().includes(TOKEN_V3.slice(2).toLowerCase()) ? V3_CURVE : ZERO);
  if (t === V3_CURVE && s === sel('function getCurrentPrice()')) return u256(3_000_000_000n); // 3e-9 ETH
  // GenericSell factory + hook (the older Vite-loaded frontend path)
  if (t === OLD_V4_FACTORY && s === sel('function isLaunched(address)')) return bool32(data.toLowerCase().includes(TOKEN_GENERIC.slice(2).toLowerCase()));
  if (t === OLD_V4_FACTORY && s === sel('function getPoolKey(address)')) return genericPoolKeyEnc;
  if (t === OLD_V4_HOOK && s === sel('function curveStates(bytes32)')) return enc('address,address,bool,bool,uint256,uint256', [TOKEN_GENERIC, ZERO, true, false, 1_000_000_000_000_000_000n, 900_000_000_000_000_000_000_000_000n]);
  return null;
}

const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const one = (item) => {
      switch (item.method) {
        case 'eth_chainId': return { jsonrpc: '2.0', id: item.id, result: '0x1237' };
        case 'eth_blockNumber': return { jsonrpc: '2.0', id: item.id, result: '0x3650000' };
        case 'eth_call': {
          const { to, data } = item.params[0];
          const out = answer(to, data);
          return out ? { jsonrpc: '2.0', id: item.id, result: out } : { jsonrpc: '2.0', id: item.id, error: { code: 3, message: 'execution reverted (unmocked call)', data: '0x' } };
        }
        default: return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: `unsupported in fake rpc: ${item.method}` } };
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
process.env.VITE_EVM_RPC_URL = `http://127.0.0.1:${rpc.address().port}`; // both the worker and the Vite-loaded frontend module read this

const worker = await import('../scripts/loss-reward-worker.mjs');

console.log('======================================================');
console.log('  WORKER MIXED HOOK SET (legible / V3 / GenericSell)');
console.log('======================================================\n');

try {
  console.log('[1/3] legible token -> slot0 benchmark');
  const legible = await worker.getTokenBenchmarkPriceEth(TOKEN_LEGIBLE);
  assert.equal(legible.source, 'v4_legible_slot0');
  assert.equal(legible.isGraduated, false);
  assert.ok(Math.abs(legible.priceEth - expectedLegiblePrice) / expectedLegiblePrice < 1e-12, `price must be 1/sqrtP^2 (got ${legible.priceEth}, want ${expectedLegiblePrice})`);
  assert.ok(!calls.some((c) => c.startsWith(V3_FACTORY)), 'the legible branch must not touch the V3 factory for a legible token');
  console.log(`  source=${legible.source} price=${legible.priceEth.toExponential(6)} ETH  OK\n`);

  console.log('[2/3] V3 curve token -> curve price (unchanged path)');
  calls.length = 0;
  const v3 = await worker.getTokenBenchmarkPriceEth(TOKEN_V3);
  assert.equal(v3.source, 'bonding_curve');
  assert.equal(v3.priceEth, 3e-9);
  assert.ok(calls.some((c) => c === `${LEGIBLE_FACTORY}:${sel('function isLaunched(address)')}`), 'exactly one legible factory read precedes the older paths');
  console.log(`  source=${v3.source} price=${v3.priceEth}  OK\n`);

  console.log('[3/3] GenericSell V4 token -> the older hook-curve path (unchanged)');
  const generic = await worker.getTokenBenchmarkPriceEth(TOKEN_GENERIC);
  assert.equal(generic.source, 'v4_hook_curve', `expected the older V4 path, got ${generic.source}`);
  assert.ok(generic.priceEth > 0);
  console.log(`  source=${generic.source} price=${generic.priceEth.toExponential(6)} ETH  OK\n`);

  console.log('worker-mixed-hooks tests passed');
} finally {
  await worker.closeV4Module();
  rpc.close();
}
