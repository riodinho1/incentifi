/**
 * INDEXER — DUAL HOOK INGESTION. scripts/evm-indexer.mjs must discover launches from BOTH V4
 * factories (GenericSell 0x4166418C… and legible 0xD4ce8F95…), ingest Bought/Sold from BOTH
 * hooks into the same token_trades_evm / holder_cost_basis rows, tag each token with its hook,
 * treat the legible hook's FeesConverted as plumbing (no trade row), and keep the fail-loud
 * discovery precondition for the legible factory too (the phantom-payout guard).
 *
 * Offline: a local JSON-RPC server serves crafted TokenLaunched / Bought / Sold / FeesConverted
 * logs and answers symbol() / block lookups; Supabase is the in-memory REST mock. The indexer
 * is real and unmodified.
 *
 * Run: node test/indexer-dual-hook.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { encodeAbiParameters, parseAbiParameters, encodeEventTopics, parseAbi, toFunctionSelector, getAddress, pad } from 'viem';
import { createSupabaseRestMock } from './hardhat/support/supabase-rest-mock.mjs';

console.log('======================================================');
console.log('  INDEXER DUAL HOOK INGESTION (GenericSell + legible)');
console.log('======================================================\n');

// ---- addresses (the indexer's defaults) ---------------------------------------------------
const OLD_FACTORY = getAddress('0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0');
const OLD_HOOK = getAddress('0xC5Ef9Cb8c95cd8540E71b6D4c00a90257625a888');
const LEGIBLE_FACTORY = getAddress('0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const LEGIBLE_HOOK = getAddress('0x921d0bE20A21e5A687734b4dF6302EA55BD168C0');
const TOKEN_A = getAddress('0x00000000000000000000000000000000000000AA'); // GenericSell launch
const TOKEN_B = getAddress('0x00000000000000000000000000000000000000BB'); // legible launch
const TRADER_1 = getAddress('0x0000000000000000000000000000000000001111');
const TRADER_2 = getAddress('0x0000000000000000000000000000000000002222');
const POOL_A = '0x' + 'aa'.repeat(32);
const POOL_B = '0x' + 'bb'.repeat(32);
const POOL_UNKNOWN = '0x' + 'cc'.repeat(32);

const OLD_FLOOR = 54_600_000n; // V4_DISCOVERY_FLOOR_BLOCK
const LEGIBLE_FLOOR = 56_911_900n; // LEGIBLE_DISCOVERY_FLOOR_BLOCK
const HEAD = 56_912_400n; // init path: the tick indexes [HEAD-49, HEAD]
const LAUNCH_A_BLOCK = 55_000_010n;
const LAUNCH_B_BLOCK = 56_912_000n;

const EVENTS = parseAbi([
  'event TokenLaunched(address indexed token, address indexed creator, bytes32 poolId)',
  'event Bought(bytes32 indexed poolId, address indexed trader, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event Sold(bytes32 indexed poolId, address indexed trader, uint256 tokensIn, uint256 ethOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event FeesConverted(bytes32 indexed poolId, uint256 tokensIn, uint256 ethOut)',
]);
const hex = (n) => '0x' + BigInt(n).toString(16);
let logIndex = 0;
const mkLog = (address, eventName, args, data, blockNumber, txHash) => ({
  address: address.toLowerCase(),
  topics: encodeEventTopics({ abi: EVENTS, eventName, args }),
  data,
  blockNumber: hex(blockNumber),
  transactionHash: txHash,
  transactionIndex: '0x0',
  blockHash: '0x' + '11'.repeat(32),
  logIndex: hex(logIndex++),
  removed: false,
});
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const E = 10n ** 18n;

const launchA = mkLog(OLD_FACTORY, 'TokenLaunched', { token: TOKEN_A, creator: TRADER_1 }, enc('bytes32', [POOL_A]), LAUNCH_A_BLOCK, '0x' + 'a1'.repeat(32));
const launchB = mkLog(LEGIBLE_FACTORY, 'TokenLaunched', { token: TOKEN_B, creator: TRADER_2 }, enc('bytes32', [POOL_B]), LAUNCH_B_BLOCK, '0x' + 'b1'.repeat(32));
const boughtA = mkLog(OLD_HOOK, 'Bought', { poolId: POOL_A, trader: TRADER_1 }, enc('uint256,uint256,uint256,uint256', [E / 100n, 4_700_000n * E, E / 10_000n, E / 10_000n]), HEAD - 10n, '0x' + 'a2'.repeat(32));
const boughtB = mkLog(LEGIBLE_HOOK, 'Bought', { poolId: POOL_B, trader: TRADER_2 }, enc('uint256,uint256,uint256,uint256', [E / 50n, 9_000_000n * E, E / 5_000n, E / 5_000n]), HEAD - 6n, '0x' + 'b2'.repeat(32));
const soldB = mkLog(LEGIBLE_HOOK, 'Sold', { poolId: POOL_B, trader: TRADER_2 }, enc('uint256,uint256,uint256,uint256', [4_000_000n * E, E / 120n, E / 12_000n, E / 12_000n]), HEAD - 5n, '0x' + 'b3'.repeat(32));
const feesConvertedB = mkLog(LEGIBLE_HOOK, 'FeesConverted', { poolId: POOL_B }, enc('uint256,uint256', [80_000n * E, E / 5_000n]), HEAD - 4n, '0x' + 'b4'.repeat(32));
const boughtUnknown = mkLog(LEGIBLE_HOOK, 'Bought', { poolId: POOL_UNKNOWN, trader: TRADER_1 }, enc('uint256,uint256,uint256,uint256', [E, E, 0n, 0n]), HEAD - 3n, '0x' + 'c1'.repeat(32));
// A GenericSell-shaped Bought for POOL_B emitted by the OLD hook must be ignored (wrong hook for that pool).
const boughtBWrongHook = mkLog(OLD_HOOK, 'Bought', { poolId: POOL_B, trader: TRADER_1 }, enc('uint256,uint256,uint256,uint256', [E, E, 0n, 0n]), HEAD - 2n, '0x' + 'c2'.repeat(32));

const ALL_LOGS = [launchA, launchB, boughtA, boughtB, soldB, feesConvertedB, boughtUnknown, boughtBWrongHook];
const inRange = (log, from, to) => BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to;

const stringResult = (s) => enc('string', [s]);
const rpcState = { getLogsCalls: 0, getLogsByAddress: new Map() };
const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const one = (item) => {
      switch (item.method) {
        case 'eth_chainId': return { jsonrpc: '2.0', id: item.id, result: hex(4663) };
        case 'eth_blockNumber': return { jsonrpc: '2.0', id: item.id, result: hex(HEAD) };
        case 'eth_getBlockByNumber': return { jsonrpc: '2.0', id: item.id, result: { number: item.params[0], timestamp: hex(1_788_800_000n + BigInt(item.params[0] === 'latest' ? HEAD : BigInt(item.params[0])) - HEAD), hash: '0x' + '11'.repeat(32), transactions: [] } };
        case 'eth_getLogs': {
          rpcState.getLogsCalls += 1;
          const f = item.params[0];
          const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase());
          for (const a of addrs) rpcState.getLogsByAddress.set(a, (rpcState.getLogsByAddress.get(a) || 0) + 1);
          const from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
          const topic0 = f.topics?.[0];
          const wanted = topic0 == null ? null : (Array.isArray(topic0) ? topic0 : [topic0]).map((t) => t.toLowerCase());
          const result = ALL_LOGS.filter((l) => addrs.includes(l.address) && inRange(l, from, to) && (!wanted || wanted.includes(l.topics[0].toLowerCase())));
          return { jsonrpc: '2.0', id: item.id, result };
        }
        case 'eth_call': {
          const { to, data } = item.params[0];
          const t = getAddress(to), s = data.slice(0, 10);
          if (s === toFunctionSelector('function symbol()') && t === TOKEN_A) return { jsonrpc: '2.0', id: item.id, result: stringResult('OLDA') };
          if (s === toFunctionSelector('function symbol()') && t === TOKEN_B) return { jsonrpc: '2.0', id: item.id, result: stringResult('LEGB') };
          if (s === toFunctionSelector('function hook()') && t === OLD_FACTORY) return { jsonrpc: '2.0', id: item.id, result: pad(OLD_HOOK.toLowerCase()) };
          return { jsonrpc: '2.0', id: item.id, error: { code: 3, message: 'execution reverted (unmocked call)', data: '0x' } };
        }
        default: return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: `unsupported in fake rpc: ${item.method}` } };
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
process.env.VITE_EVM_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;

// ---- Supabase mock (installed BEFORE the indexer is imported) -------------------------------
function readEnvLocal(key) {
  if (!fs.existsSync('.env.local')) return undefined;
  let v;
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[1] === key) v = m[2].replace(/^['"]|['"]$/g, ''); }
  return v;
}
const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://indexer-dual-hook-test.supabase.co';
process.env.VITE_SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'indexer-dual-hook-test-key';
const mock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, {
  upsertKeys: {
    holder_cost_basis: ['token_address', 'wallet_address'],
    token_trades_evm: ['tx_hash'],
    token_candles_1m: ['symbol', 'bucket_ts'],
    token_market_snapshots_evm: ['token_address'],
    indexer_heartbeats: ['worker_name'],
  },
});
globalThis.fetch = mock.fetchImpl;
// registry rows exist for both tokens (the launch page writes them); no hook tag yet
mock.seed('tokens', [
  { id: 1, mint_address: TOKEN_A.toLowerCase(), symbol: 'OLDA', hook_address: null },
  { id: 2, mint_address: TOKEN_B.toLowerCase(), symbol: 'LEGB', hook_address: null },
]);

const indexer = await import('../scripts/evm-indexer.mjs');
const idx = indexer.createIndexer();

try {
  console.log('[1/5] one tick: discovery over both factories, trades from both hooks');
  const r = await idx.tick();
  assert.equal(r.ok, true, `tick must succeed (got ${r.error})`);
  assert.equal(r.indexedThrough, HEAD);
  const hb = mock.table('indexer_heartbeats').find((x) => x.worker_name === 'evm-indexer');
  assert.equal(hb.status, 'ok');
  assert.equal(indexer.isV4DiscoveryReadyThrough(HEAD), true, 'both factories scanned through head');
  const st = indexer.getV4DiscoveryState();
  assert.equal(st.scannedThrough.genericSell, HEAD);
  assert.equal(st.scannedThrough.legible, HEAD);
  assert.ok(rpcState.getLogsByAddress.get(LEGIBLE_FACTORY.toLowerCase()) >= 1, 'legible factory was scanned');
  assert.ok(rpcState.getLogsByAddress.get(OLD_FACTORY.toLowerCase()) >= 1, 'GenericSell factory was scanned');
  console.log(`  ok; getLogs calls ${rpcState.getLogsCalls} (factory scans ${rpcState.getLogsByAddress.get(OLD_FACTORY.toLowerCase())} + ${rpcState.getLogsByAddress.get(LEGIBLE_FACTORY.toLowerCase())}, hooks ${rpcState.getLogsByAddress.get(OLD_HOOK.toLowerCase())} + ${rpcState.getLogsByAddress.get(LEGIBLE_HOOK.toLowerCase())})\n`);

  console.log('[2/5] both tokens discovered and tagged with their hook');
  assert.equal(st.tokens[TOKEN_A.toLowerCase()], 'OLDA');
  assert.equal(st.tokens[TOKEN_B.toLowerCase()], 'LEGB');
  assert.equal(st.hooks[TOKEN_A.toLowerCase()], OLD_HOOK.toLowerCase());
  assert.equal(st.hooks[TOKEN_B.toLowerCase()], LEGIBLE_HOOK.toLowerCase());
  const rowA = mock.table('tokens').find((t) => t.mint_address === TOKEN_A.toLowerCase());
  const rowB = mock.table('tokens').find((t) => t.mint_address === TOKEN_B.toLowerCase());
  assert.equal(rowA.hook_address, OLD_HOOK.toLowerCase(), 'tokens.hook_address tagged for the GenericSell token');
  assert.equal(rowB.hook_address, LEGIBLE_HOOK.toLowerCase(), 'tokens.hook_address tagged for the legible token');
  // audit 2026-09-08 finding 5: every discovered token is also recorded in indexed_tokens (the worker's second source)
  const idxA = mock.table('indexed_tokens').find((t) => t.mint_address.toLowerCase() === TOKEN_A.toLowerCase());
  const idxB = mock.table('indexed_tokens').find((t) => t.mint_address.toLowerCase() === TOKEN_B.toLowerCase());
  assert.ok(idxA && idxB, 'both discovered tokens recorded in indexed_tokens');
  assert.equal(idxA.venue, 'v4-generic'); assert.equal(idxB.venue, 'legible');
  assert.equal(idxB.hook_address, LEGIBLE_HOOK.toLowerCase());
  assert.ok(idxB.creator_address && idxB.first_block > 0, 'creator + launch block recorded');
  console.log(`  OLDA -> ${rowA.hook_address}\n  LEGB -> ${rowB.hook_address}\n`);

  console.log('[3/5] trades from both hooks landed in token_trades_evm with the same shape');
  const trades = mock.table('token_trades_evm');
  const byTx = new Map(trades.map((t) => [t.tx_hash.split(':')[0], t]));
  const tA = byTx.get(boughtA.transactionHash), tB = byTx.get(boughtB.transactionHash), sB = byTx.get(soldB.transactionHash);
  assert.ok(tA && tB && sB, `expected 3 trade rows, got ${trades.length}: ${JSON.stringify(trades.map((t) => t.tx_hash))}`);
  assert.equal(trades.length, 3, 'exactly the three real holder trades');
  assert.equal(tA.token_address, TOKEN_A.toLowerCase()); assert.equal(tA.side, 'buy'); assert.equal(tA.trader_address, TRADER_1.toLowerCase());
  assert.equal(tB.token_address, TOKEN_B.toLowerCase()); assert.equal(tB.side, 'buy'); assert.equal(tB.trader_address, TRADER_2.toLowerCase());
  assert.equal(sB.token_address, TOKEN_B.toLowerCase()); assert.equal(sB.side, 'sell'); assert.equal(sB.trader_address, TRADER_2.toLowerCase());
  assert.equal(Number(tA.amount_eth), 0.01); assert.equal(Number(tB.amount_eth), 0.02);
  console.log(`  OLDA buy 0.01 ETH / LEGB buy 0.02 ETH / LEGB sell ${sB.amount_token} tokens  OK\n`);

  console.log('[4/5] FeesConverted, an unknown pool, and a wrong-hook Bought produced nothing');
  assert.equal(byTx.has(feesConvertedB.transactionHash), false, 'FeesConverted is not a trade');
  assert.equal(byTx.has(boughtUnknown.transactionHash), false, 'unknown poolId ignored');
  assert.equal(byTx.has(boughtBWrongHook.transactionHash), false, 'a pool is only matched to its own hook');
  const holders = mock.table('holder_cost_basis');
  const hB = holders.find((h) => h.token_address === TOKEN_B.toLowerCase() && h.wallet_address === TRADER_2.toLowerCase());
  assert.ok(hB, 'legible trader has a cost-basis row');
  assert.equal(Number(hB.token_balance), 9_000_000 - 4_000_000, 'balance = bought - sold (FeesConverted did not touch it)');
  const hA = holders.find((h) => h.token_address === TOKEN_A.toLowerCase() && h.wallet_address === TRADER_1.toLowerCase());
  assert.equal(Number(hA.token_balance), 4_700_000);
  console.log(`  holder_cost_basis: OLDA/${TRADER_1.slice(0, 8)}=${hA.token_balance}  LEGB/${TRADER_2.slice(0, 8)}=${hB.token_balance}  OK\n`);

  console.log('[5/5] a second tick with nothing new is a no-op that keeps both cursors');
  const r2 = await idx.tick();
  assert.equal(r2 === undefined || r2.ok === true, true);
  assert.equal(mock.table('token_trades_evm').length, 3);
  console.log('  OK\n');

  console.log('indexer-dual-hook tests passed');
} finally {
  rpc.close();
}
process.exit(0);
