/**
 * Enumerate EVERY Robinhood stock token on Robinhood Chain (StockFactory `Deployed` events — the
 * on-chain registry) and, for each, the Uniswap V3 WETH pools that exist (fee tiers 100/500/3000/
 * 10000) with their liquidity and price state, plus the Robinhood API status when reachable.
 * Read-only. Output: JSON to stdout (or --out <file>) consumed by the route-config generator.
 *
 *   node scripts/ops/enumerate-stock-venues.mjs [--out scratch/stock-venues.json] [--rpc URL]
 */
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, parseAbiItem, getAddress, formatUnits } from 'viem';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RPC = arg('--rpc', process.env.VITE_EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com');
const OUT = arg('--out', '');
const REUSE = arg('--reuse', '');
const SKIP_V4 = args.includes('--skip-v4');

const STOCK_FACTORY = getAddress('0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046');
const ACCESS_REGISTRY = getAddress('0xe10b6f6B275de231345c20D14Ab812db62151b00');
const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
const V3_FACTORY = getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
const FEES = [100, 500, 3000, 10000];
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0', Accept: 'application/json' };

const client = createPublicClient({ transport: http(RPC, { timeout: 60_000, retryCount: 0 }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The public RPC answers 429 to bursts: retry with backoff instead of failing the whole run. */
async function withBackoff(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      const msg = String(e?.message || e) + ' ' + String(e?.cause?.message || '');
      if (!/429|Too Many Requests|rate/i.test(msg) || attempt >= 8) throw e;
      const wait = Math.min(30_000, 1500 * 2 ** attempt);
      console.error(`[enumerate] 429 on ${label}; waiting ${wait}ms (attempt ${attempt + 1})`);
      await sleep(wait);
    }
  }
}
const DEPLOYED = parseAbiItem('event Deployed(bytes32 indexed uid, address stock, string name, string symbol)');
const STOCK_ABI = parseAbi(['function symbol() view returns (string)', 'function name() view returns (string)', 'function uid() view returns (bytes32)', 'function uiMultiplier() view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function paused() view returns (bool)']);
const FACTORY_ABI = parseAbi(['function tokenAddress(bytes32 uid) view returns (address)']);
const V3F_ABI = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const POOL_ABI = parseAbi(['function liquidity() view returns (uint128)', 'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)', 'function token0() view returns (address)']);
const ERC20_BAL = parseAbi(['function balanceOf(address) view returns (uint256)']);

async function multicall(contracts) {
  // chunk to keep calldata reasonable
  const out = [];
  for (let i = 0; i < contracts.length; i += 60) {
    out.push(...(await withBackoff(() => client.multicall({ contracts: contracts.slice(i, i + 60), allowFailure: true, multicallAddress: MULTICALL3 }), `multicall ${i}/${contracts.length}`)));
    await sleep(1200); // the public RPC rate-limits bursts
  }
  return out;
}

const head = await withBackoff(() => client.getBlockNumber(), 'blockNumber');
let stocks;
if (REUSE) {
  stocks = JSON.parse(fs.readFileSync(REUSE, 'utf8')).stocks;
  console.error(`[enumerate] reusing ${stocks.length} stocks + V3 pools from ${REUSE}`);
} else {
console.error(`[enumerate] chain head ${head}; scanning StockFactory Deployed events...`);
// Deployed events via Blockscout's indexed logs API (the public RPC 429s on wide log scans), with the
// on-chain StockFactory round-trip below as the authority on every address returned.
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/api/v2';
const DEPLOYED_TOPIC = '0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6'; // Deployed(bytes32,address,string,string)
let logs = [];
{
  let next = null; let pages = 0;
  do {
    const qs = next ? '?' + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)])).toString() : '';
    let j = null;
    for (let attempt = 0; attempt < 6 && !j; attempt++) {
      const res = await fetch(`${BLOCKSCOUT}/addresses/${STOCK_FACTORY}/logs${qs}`, { headers: UA }).catch(() => null);
      if (res && res.ok) j = await res.json();
      else { console.error(`[enumerate] blockscout HTTP ${res ? res.status : 'error'} on page ${pages + 1}; retrying`); await sleep(2000 * (attempt + 1)); }
    }
    if (!j) throw new Error('blockscout logs unavailable after retries');
    for (const it of j.items || []) {
      if ((it.topics?.[0] || '').toLowerCase() !== DEPLOYED_TOPIC.toLowerCase()) continue;
      const params = Object.fromEntries((it.decoded?.parameters || []).map((q) => [q.name, q.value]));
      if (!params.stock) continue;
      logs.push({ args: { uid: params.uid, stock: params.stock, name: params.name, symbol: params.symbol }, blockNumber: BigInt(it.block_number) });
    }
    next = j.next_page_params || null; pages++;
    await new Promise((r) => setTimeout(r, 250));
  } while (next && pages < 50);
  console.error(`[enumerate] blockscout: ${pages} page(s)`);
}
console.error(`[enumerate] ${logs.length} Deployed events`);
stocks = logs.map((l) => ({ uid: l.args.uid, address: getAddress(l.args.stock), name: l.args.name, symbol: l.args.symbol, block: Number(l.blockNumber) }));

// registry round-trip + token state
const rt = await multicall(stocks.map((s) => ({ address: STOCK_FACTORY, abi: FACTORY_ABI, functionName: 'tokenAddress', args: [s.uid] })));
const sym = await multicall(stocks.map((s) => ({ address: s.address, abi: STOCK_ABI, functionName: 'symbol' })));
const mult = await multicall(stocks.map((s) => ({ address: s.address, abi: STOCK_ABI, functionName: 'uiMultiplier' })));
const supply = await multicall(stocks.map((s) => ({ address: s.address, abi: STOCK_ABI, functionName: 'totalSupply' })));
stocks.forEach((s, i) => {
  s.roundTrip = rt[i].status === 'success' && getAddress(rt[i].result) === s.address;
  s.onchainSymbol = sym[i].status === 'success' ? sym[i].result : null;
  s.uiMultiplier = mult[i].status === 'success' ? mult[i].result.toString() : null;
  s.totalSupply = supply[i].status === 'success' ? supply[i].result.toString() : null;
});

// V3 WETH pools per fee tier
const poolCalls = [];
for (const s of stocks) for (const fee of FEES) poolCalls.push({ address: V3_FACTORY, abi: V3F_ABI, functionName: 'getPool', args: [WETH, s.address, fee] });
const pools = await multicall(poolCalls);
const poolAddrs = [];
stocks.forEach((s, i) => {
  s.pools = [];
  FEES.forEach((fee, j) => {
    const r = pools[i * FEES.length + j];
    const p = r.status === 'success' ? getAddress(r.result) : '0x0000000000000000000000000000000000000000';
    if (p !== '0x0000000000000000000000000000000000000000') { s.pools.push({ fee, address: p }); poolAddrs.push({ stock: s, fee, address: p }); }
  });
});
console.error(`[enumerate] ${poolAddrs.length} V3 WETH pools across ${stocks.filter((s) => s.pools.length).length} stocks`);
const liq = await multicall(poolAddrs.map((p) => ({ address: p.address, abi: POOL_ABI, functionName: 'liquidity' })));
const slot = await multicall(poolAddrs.map((p) => ({ address: p.address, abi: POOL_ABI, functionName: 'slot0' })));
const wethBal = await multicall(poolAddrs.map((p) => ({ address: WETH, abi: ERC20_BAL, functionName: 'balanceOf', args: [p.address] })));
const stockBal = await multicall(poolAddrs.map((p) => ({ address: p.stock.address, abi: ERC20_BAL, functionName: 'balanceOf', args: [p.address] })));
poolAddrs.forEach((p, i) => {
  const entry = p.stock.pools.find((x) => x.address === p.address);
  entry.liquidity = liq[i].status === 'success' ? liq[i].result.toString() : null;
  if (slot[i].status === 'success') {
    const s0 = slot[i].result;
    entry.sqrtPriceX96 = s0[0].toString();
    entry.tick = Number(s0[1]);
    entry.observationCardinality = Number(s0[3]);
    entry.initialized = s0[0] !== 0n;
  } else entry.initialized = false;
  entry.wethBalance = wethBal[i].status === 'success' ? formatUnits(wethBal[i].result, 18) : null;
  entry.stockBalance = stockBal[i].status === 'success' ? formatUnits(stockBal[i].result, 18) : null;
});

}
// TWAP availability per V3 WETH pool: the adapter's referenceOut() needs observe([1800,0]) (or the
// 600 s fallback); a pool whose oldest observation is younger than the window reverts 'OLD' and every
// stock claim through it would fall back to ETH (ReferenceUnavailable). Anyone can widen a pool's
// observation ring with increaseObservationCardinalityNext().
{
  const OBS_ABI = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)']);
  const allPools = [];
  for (const st of stocks) for (const p of st.pools) allPools.push(p);
  const o30 = await multicall(allPools.map((p) => ({ address: p.address, abi: OBS_ABI, functionName: 'observe', args: [[1800, 0]] })));
  const o10 = await multicall(allPools.map((p) => ({ address: p.address, abi: OBS_ABI, functionName: 'observe', args: [[600, 0]] })));
  allPools.forEach((p, i) => { p.twap30mAvailable = o30[i].status === 'success'; p.twap10mAvailable = o10[i].status === 'success'; });
  console.error(`[enumerate] TWAP 30m available on ${allPools.filter((p) => p.twap30mAvailable).length}/${allPools.length} V3 WETH pools (10m: ${allPools.filter((p) => p.twap10mAvailable).length})`);
}

// ---------------------------------------------------------------------------------------------
// Other venues: Uniswap V3 pools against USDG, and Uniswap V4 pools (native ETH / WETH / USDG vs
// stock) from PoolManager Initialize events (Blockscout v1 logs API, split by block range until
// each range returns < 1000 rows), with live liquidity from StateView.
// ---------------------------------------------------------------------------------------------
const USDG = getAddress('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
const POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
const NATIVE = '0x0000000000000000000000000000000000000000';
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'; // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
const STATE_VIEW_ABI = parseAbi(['function getLiquidity(bytes32 poolId) view returns (uint128)', 'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']);
const stockSet = new Map(stocks.map((s) => [s.address.toLowerCase(), s]));

// V3 USDG pools
if (!REUSE || !stocks[0].usdgPools) {
  const calls = [];
  for (const s of stocks) for (const fee of FEES) calls.push({ address: V3_FACTORY, abi: V3F_ABI, functionName: 'getPool', args: [USDG, s.address, fee] });
  const res = await multicall(calls);
  const found = [];
  stocks.forEach((s, i) => {
    s.usdgPools = [];
    FEES.forEach((fee, j) => {
      const r = res[i * FEES.length + j];
      const p = r.status === 'success' ? getAddress(r.result) : NATIVE;
      if (p !== NATIVE) { const e = { fee, address: p }; s.usdgPools.push(e); found.push({ s, e }); }
    });
  });
  const liq2 = await multicall(found.map((f) => ({ address: f.e.address, abi: POOL_ABI, functionName: 'liquidity' })));
  const usdgBal = await multicall(found.map((f) => ({ address: USDG, abi: ERC20_BAL, functionName: 'balanceOf', args: [f.e.address] })));
  found.forEach((f, i) => { f.e.liquidity = liq2[i].status === 'success' ? liq2[i].result.toString() : null; f.e.usdgBalance = usdgBal[i].status === 'success' ? formatUnits(usdgBal[i].result, 6) : null; });
  console.error(`[enumerate] ${found.length} V3 USDG pools across ${stocks.filter((s) => s.usdgPools.length).length} stocks`);
}

// V4 Initialize events (adaptive block-range split; the v1 API caps at 1000 rows)
async function v4Logs(fromBlock, toBlock, depth = 0) {
  const url = `https://robinhoodchain.blockscout.com/api?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${POOL_MANAGER}&topic0=${INIT_TOPIC}`;
  let j = null;
  for (let attempt = 0; attempt < 8 && !j; attempt++) {
    const res = await fetch(url, { headers: UA }).catch(() => null);
    if (res && res.ok) { const body = await res.json(); if (body && (body.status === '1' || /No (records|logs) found/i.test(body.message || ''))) j = body; }
    if (!j) { console.error(`[enumerate] v4 logs ${fromBlock}-${toBlock}: HTTP ${res ? res.status : 'error'}; retrying`); await sleep(2000 * (attempt + 1)); }
  }
  if (!j) throw new Error(`v4 Initialize logs unavailable for ${fromBlock}-${toBlock}`);
  const rows = Array.isArray(j.result) ? j.result : [];
  if (rows.length >= 1000 && toBlock > fromBlock && depth < 16) {
    const mid = Math.floor((fromBlock + toBlock) / 2);
    return [...(await v4Logs(fromBlock, mid, depth + 1)), ...(await v4Logs(mid + 1, toBlock, depth + 1))];
  }
  console.error(`[enumerate] v4 logs ${fromBlock}-${toBlock}: ${rows.length}`);
  await sleep(400);
  return rows;
}
let initRows = [];
let v4Complete = true;
if (SKIP_V4) { v4Complete = false; console.error('[enumerate] --skip-v4: keeping any V4 data from the reused file'); }
else {
  try { initRows = await v4Logs(0, Number(head)); }
  catch (e) { v4Complete = false; console.error(`[enumerate] V4 Initialize scan unavailable (${e.message}); keeping any V4 data from the reused file`); }
}
console.error(`[enumerate] ${initRows.length} V4 Initialize events`);
const v4Pools = [];
for (const r of initRows) {
  const c0 = getAddress('0x' + r.topics[2].slice(26)); const c1 = getAddress('0x' + r.topics[3].slice(26));
  const words = r.data.slice(2).match(/.{64}/g) || [];
  const fee = parseInt(words[0], 16); const tickSpacing = Number(BigInt.asIntN(24, BigInt('0x' + words[1]))); const hooks = getAddress('0x' + words[2].slice(24));
  const stock = stockSet.get(c1.toLowerCase()) || stockSet.get(c0.toLowerCase());
  if (!stock) continue;
  const quote = [c0, c1].find((c) => c.toLowerCase() !== stock.address.toLowerCase());
  const quoteName = quote === NATIVE ? 'ETH' : quote.toLowerCase() === WETH.toLowerCase() ? 'WETH' : quote.toLowerCase() === USDG.toLowerCase() ? 'USDG' : quote;
  v4Pools.push({ stock, pool: { poolId: r.topics[1], quote: quoteName, quoteAddress: quote, fee, tickSpacing, hooks, block: parseInt(r.blockNumber, 16) } });
}
const v4Liq = await multicall(v4Pools.map((p) => ({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [p.pool.poolId] })));
const v4Slot = await multicall(v4Pools.map((p) => ({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [p.pool.poolId] })));
if (v4Complete) for (const s of stocks) s.v4Pools = []; else for (const s of stocks) s.v4Pools = s.v4Pools || [];
v4Pools.forEach((p, i) => {
  p.pool.liquidity = v4Liq[i].status === 'success' ? v4Liq[i].result.toString() : null;
  if (v4Slot[i].status === 'success') { p.pool.sqrtPriceX96 = v4Slot[i].result[0].toString(); p.pool.tick = Number(v4Slot[i].result[1]); p.pool.lpFee = Number(v4Slot[i].result[3]); }
  p.stock.v4Pools.push(p.pool);
});
console.error(`[enumerate] ${v4Pools.length} V4 stock pools across ${stocks.filter((s) => s.v4Pools.length).length} stocks`);

// Robinhood API (optional enrichment)
let api = null;
try {
  const res = await fetch('https://api.robinhood.com/rhj/assets', { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  const j = await res.json();
  api = new Map();
  for (const a of j.assets || []) for (const d of a.deployments || []) if (Number(d.chainId) === 4663) api.set(getAddress(d.contractAddress), { status: a.status, tokenSymbol: a.tokenSymbol, tokenName: a.tokenName });
} catch (e) { console.error(`[enumerate] API unreachable: ${e.message}`); }
for (const s of stocks) { const a = api?.get(s.address); s.apiStatus = a?.status ?? null; s.apiSymbol = a?.tokenSymbol ?? null; }

const summary = {
  chainHead: Number(head),
  v4Complete,
  generatedAt: new Date().toISOString(),
  totals: {
    stocks: stocks.length,
    roundTripOk: stocks.filter((s) => s.roundTrip).length,
    apiActive: stocks.filter((s) => s.apiStatus === 'ASSET_STATUS_ACTIVE').length,
    withAnyV3WethPool: stocks.filter((s) => s.pools.length).length,
    withInitializedPool: stocks.filter((s) => s.pools.some((p) => p.initialized)).length,
    withLiquidPool: stocks.filter((s) => s.pools.some((p) => p.initialized && BigInt(p.liquidity || 0) > 0n)).length,
    withWethGte0_5: stocks.filter((s) => s.pools.some((p) => Number(p.wethBalance || 0) >= 0.5)).length,
    withWethGte5: stocks.filter((s) => s.pools.some((p) => Number(p.wethBalance || 0) >= 5)).length,
    withV3UsdgPool: stocks.filter((s) => s.usdgPools.length).length,
    withLiquidV3UsdgPool: stocks.filter((s) => s.usdgPools.some((p) => BigInt(p.liquidity || 0) > 0n)).length,
    withV4Pool: stocks.filter((s) => s.v4Pools.length).length,
    withLiquidV4Pool: stocks.filter((s) => s.v4Pools.some((p) => BigInt(p.liquidity || 0) > 0n)).length,
    withLiquidV4EthPool: stocks.filter((s) => s.v4Pools.some((p) => (p.quote === 'ETH' || p.quote === 'WETH') && BigInt(p.liquidity || 0) > 0n)).length,
    withAnyLiquidVenue: stocks.filter((s) => s.pools.some((p) => BigInt(p.liquidity || 0) > 0n) || s.usdgPools.some((p) => BigInt(p.liquidity || 0) > 0n) || s.v4Pools.some((p) => BigInt(p.liquidity || 0) > 0n)).length,
    withV3WethTwap30m: stocks.filter((s) => s.pools.some((p) => p.twap30mAvailable && BigInt(p.liquidity || 0) > 0n)).length,
    withNoVenueAtAll: stocks.filter((s) => !s.pools.length && !s.usdgPools.length && !s.v4Pools.length).length,
  },
  stocks,
};
const json = JSON.stringify(summary, null, 2);
if (OUT) { fs.writeFileSync(OUT, json); console.error(`[enumerate] wrote ${OUT}`); } else console.log(json);
console.error(JSON.stringify(summary.totals));
