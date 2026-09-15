/**
 * OPS — scripts/ops/v4-legacy-sell.mjs plans a UniversalRouter sell for a legacy V4 token (2026-09-15).
 *
 *   1. its UniversalRouter calldata is byte-identical to src/lib/legiblePool.ts encodeUniversalRouterV4Swap
 *      (the encoding a mined mainnet transaction validated on 2026-09-07)
 *   2. against a fake chain (V4MAINTEST's real pool key, graduated hook, quoter), the plan quotes the full
 *      balance, computes minOut from the slippage, reports both approvals missing, prints three cast
 *      commands with --account (never --interactive / never a key), and skips the simulation until approvals
 *      exist; with approvals in place it simulates the swap and prints only the sell command
 *
 * Run: node test/v4-legacy-sell.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer as createViteServer } from 'vite';
import { createPublicClient, getAddress, parseAbi, encodeAbiParameters, parseAbiParameters, toFunctionSelector, keccak256, toHex, encodeFunctionResult } from 'viem';
import { encodeUniversalRouterV4Swap, planLegacySell, PERMIT2, UNIVERSAL_ROUTER, V4_QUOTER, V4_STATE_VIEW } from '../scripts/ops/v4-legacy-sell.mjs';
import { createFailoverRpc } from '../scripts/lib/rpcFailover.mjs';

const TOKEN = getAddress('0x5e7ccb5bb351018918427a7a4fa05f33103e33a0');
const W = getAddress('0x78a4E4BCC8ab559B6d3B1Cb9eab0A04a2411c726');
const HOOK = getAddress('0x76E8A2883379fA6507329d91f298D479Ba636888');
const FACTORY = getAddress('0xe003e8db9d8db61dbf3e7fa813eebf51029ada27');
const poolKey = { currency0: '0x0000000000000000000000000000000000000000', currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK };
const POOL_ID = '0x43efd091fecbeab71b182586cd9e37319f1bf169696c213ccae990d653f8cae3';
const E = 10n ** 18n;
const BAL = 787903505842634516283669812n;
const QUOTE_FULL = 92245587305136695n;

console.log('======================================================');
console.log('  V4 LEGACY SELL PLANNER');
console.log('======================================================\n');
// 1. encoding parity with the frontend
const vite = await createViteServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const fe = await vite.ssrLoadModule('/src/lib/legiblePool.ts');
  for (const [zfo, amt, min, dl] of [[false, BAL, QUOTE_FULL * 98n / 100n, 1_790_000_000n], [true, 5n * E, 1n, 1n]]) {
    assert.equal(encodeUniversalRouterV4Swap(poolKey, zfo, amt, min, dl), fe.encodeUniversalRouterV4Swap(poolKey, zfo, amt, min, dl), 'calldata identical to src/lib/legiblePool.ts');
  }
  console.log('1. UniversalRouter V4_SWAP calldata byte-identical to the frontend encoder  OK');
} finally { await vite.close(); }

// 2. fake chain
let approvals = { erc20: 0n, permit: [0n, 0, 0] }; const calls = [];
const sel = (s) => toFunctionSelector(s); const enc = (t, v) => encodeAbiParameters(parseAbiParameters(t), v); const hex = (n) => '0x' + BigInt(n).toString(16);
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)')); const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const LAUNCH_TX = '0x' + '77'.repeat(32);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const q = JSON.parse(b);
    const one = (it) => {
      const ok = (r) => ({ jsonrpc: '2.0', id: it.id, result: r });
      switch (it.method) {
        case 'eth_chainId': return ok('0x1237');
        case 'eth_blockNumber': return ok(hex(58_000_000n));
        case 'eth_getBalance': return ok(hex(17948215672792418n));
        case 'eth_getCode': return ok(BigInt(it.params[1]) >= 54_147_151n ? '0x6001' : '0x');
        case 'eth_getLogs': {
          const f = it.params[0]; const from = f.topics?.[1];
          if (from && from.toLowerCase() === pad('0x0000000000000000000000000000000000000000')) return ok([{ address: TOKEN.toLowerCase(), topics: [TRANSFER, pad('0x0000000000000000000000000000000000000000'), pad(W)], data: enc('uint256', [10n ** 27n]), blockNumber: hex(54_147_151n), transactionHash: '0x' + '11'.repeat(32), logIndex: '0x0', transactionIndex: '0x0', blockHash: '0x' + '22'.repeat(32), removed: false }]);
          if (!from && BigInt(f.fromBlock) <= 54_147_400n && BigInt(f.toBlock) >= 54_147_400n) return ok([{ address: TOKEN.toLowerCase(), topics: [TRANSFER, pad(W), pad(FACTORY)], data: enc('uint256', [10n ** 27n]), blockNumber: hex(54_147_400n), transactionHash: LAUNCH_TX, logIndex: '0x1', transactionIndex: '0x0', blockHash: '0x' + '22'.repeat(32), removed: false }]);
          return ok([]);
        }
        case 'eth_getTransactionReceipt': return ok({ transactionHash: LAUNCH_TX, status: '0x1', blockNumber: hex(54_147_400n), blockHash: '0x' + '22'.repeat(32), transactionIndex: '0x0', from: W, to: FACTORY, gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', logsBloom: '0x' + '0'.repeat(512), type: '0x2', contractAddress: null, logs: [
          { address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', topics: [keccak256(toHex('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')), POOL_ID, pad(poolKey.currency0), pad(TOKEN)], data: enc('uint24, int24, address, uint160, int24', [0, 200, HOOK, 12527072453314647027124934294894320n, 239433]), blockNumber: hex(54_147_400n), transactionHash: LAUNCH_TX, logIndex: '0x2', transactionIndex: '0x0', blockHash: '0x' + '22'.repeat(32), removed: false },
          { address: FACTORY.toLowerCase(), topics: [keccak256(toHex('TokenLaunched(address,address,bytes32)')), pad(TOKEN), pad(W)], data: POOL_ID, blockNumber: hex(54_147_400n), transactionHash: LAUNCH_TX, logIndex: '0x3', transactionIndex: '0x0', blockHash: '0x' + '22'.repeat(32), removed: false },
        ] });
        case 'eth_call': {
          const { to, data, from } = it.params[0]; const s = data.slice(0, 10); const t = getAddress(to);
          calls.push({ to: t, s, from });
          if (t === TOKEN && s === sel('function symbol()')) return ok(enc('string', ['V4MAINTEST']));
          if (t === TOKEN && s === sel('function decimals()')) return ok(enc('uint8', [18]));
          if (t === TOKEN && s === sel('function balanceOf(address)')) return ok(enc('uint256', [BAL]));
          if (t === TOKEN && s === sel('function allowance(address,address)')) return ok(enc('uint256', [approvals.erc20]));
          if (t === getAddress(PERMIT2)) return ok(enc('uint160, uint48, uint48', approvals.permit));
          if (t === FACTORY && s === sel('function getPoolKey(address)')) return ok(enc('(address, address, uint24, int24, address)', [[poolKey.currency0, TOKEN, 0, 200, HOOK]]));
          if (t === HOOK) return ok(enc('address, address, bool, bool, uint256, uint256', [TOKEN, W, true, true, 117077264687500000n, 212096494157365483716330188n]));
          if (t === getAddress(V4_STATE_VIEW) && s === sel('function getSlot0(bytes32)')) return ok(enc('uint160, int24, uint24, uint24', [3372174538980268890922385959285643n, 213185, 0, 0]));
          if (t === getAddress(V4_STATE_VIEW)) return ok(enc('uint128', [4983139309857917729631n]));
          if (t === getAddress(V4_QUOTER)) { const amt = BigInt('0x' + data.slice(10 + 64 * 7, 10 + 64 * 8)); /* word 7: offset(1) + poolKey(5) + zeroForOne(1) */ return ok(enc('uint256, uint256', [amt === BAL ? QUOTE_FULL : amt * QUOTE_FULL / BAL * 3n, 40976n])); } // 10%/1% quote better than linear share
          if (t === getAddress(UNIVERSAL_ROUTER)) return ok('0x');
          return { jsonrpc: '2.0', id: it.id, error: { code: 3, message: 'unmocked', data: '0x' } };
        }
        default: return { jsonrpc: '2.0', id: it.id, error: { code: -32601, message: it.method } };
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}`;
const rpc = createFailoverRpc([url], { log: () => {}, paceMs: {} });
const client = createPublicClient({ transport: rpc.transport, cacheTime: 0 });
try {
  const lines = [];
  const plan = await planLegacySell({ client, rpc, token: TOKEN, wallet: W, slippagePct: 2, deadlineHours: 24, account: 'incentifi-owner', log: (m) => lines.push(m) });
  assert.equal(plan.symbol, 'V4MAINTEST'); assert.equal(plan.amountIn, BAL); assert.equal(plan.graduated, true); assert.equal(plan.factory.toLowerCase(), FACTORY.toLowerCase());
  assert.deepEqual(plan.poolKey, poolKey); assert.equal(plan.poolId, POOL_ID);
  assert.equal(plan.quotedOut, QUOTE_FULL); assert.equal(plan.minOut, QUOTE_FULL * 9800n / 10000n, '2% slippage');
  assert.equal(plan.needErc20, true); assert.equal(plan.needPermit, true); assert.match(plan.simulation, /skipped/);
  assert.equal(plan.commands.length, 3);
  for (const c of plan.commands) { assert.match(c.cmd, /^cast send /); assert.match(c.cmd, / --account incentifi-owner/); assert.doesNotMatch(c.cmd, /--interactive|--private-key|0x[0-9a-f]{64}(?![0-9a-f])/i); }
  assert.match(plan.commands[0].cmd, new RegExp(`cast send ${TOKEN} "approve\\(address,uint256\\)" ${PERMIT2} `));
  assert.match(plan.commands[1].cmd, new RegExp(`cast send ${PERMIT2} "approve\\(address,address,uint160,uint48\\)" ${TOKEN} ${UNIVERSAL_ROUTER} `));
  assert.ok(plan.commands[2].cmd.startsWith(`cast send ${UNIVERSAL_ROUTER} ${plan.calldata}`), 'sell command carries the exact calldata');
  assert.equal(plan.calldata, encodeUniversalRouterV4Swap(poolKey, false, BAL, plan.minOut, plan.deadline), 'token -> ETH means zeroForOne = false (token is currency1)');
  assert.ok(lines.some((l) => /quote requested\s+787903505\.842634516283669812 V4MAINTEST -> 0\.092245587305136695 ETH/.test(l)), lines.join('\n'));
  console.log('2. approvals missing -> 3 cast commands (approve, Permit2 approve, sell), --account, exact calldata, 2% minOut, simulation deferred  OK');

  approvals = { erc20: (1n << 256n) - 1n, permit: [(1n << 160n) - 1n, Math.floor(Date.now() / 1000) + 86400, 0] };
  calls.length = 0;
  const plan2 = await planLegacySell({ client, rpc, token: TOKEN, wallet: W, slippagePct: 2, log: () => {} });
  assert.equal(plan2.simulation, 'SUCCESS'); assert.equal(plan2.commands.length, 1); assert.match(plan2.commands[0].step, /^sell /);
  assert.ok(calls.some((c) => c.to === getAddress(UNIVERSAL_ROUTER) && c.from && c.from.toLowerCase() === W.toLowerCase()), 'swap simulated from the holder');
  console.log('3. approvals in place -> swap simulated from the wallet, only the sell command remains  OK');
  console.log('\nv4-legacy-sell tests passed');
} finally { srv.close(); }
process.exit(0);
