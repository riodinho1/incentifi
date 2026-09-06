import { createClient } from '@supabase/supabase-js';
import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  getAddress,
} from 'viem';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';

// Robust .env.local loader
if (fs.existsSync('.env.local')) {
  const envContent = fs.readFileSync('.env.local', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [k, ...v] = line.split('=');
    const keyName = k.trim();
    let val = v.join('=').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (keyName && val.length > 0) {
      process.env[keyName] = val;
    }
  }
}

// Environment variables
const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL) {
  throw new Error('[FATAL] Missing SUPABASE_URL in environment configuration.');
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    '[FATAL] Missing SUPABASE_SERVICE_ROLE_KEY. The service-role key is required for backend indexer database writes to satisfy PostgreSQL Row-Level Security (RLS) policies. Do not use the publishable anon key for backend indexers.'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const client = createPublicClient({
  transport: http(RPC_URL, { batch: true, retryCount: 3, retryDelay: 1000 }),
});

const FACTORY_ABI = parseAbi([
  'function getBondingCurve(address token) view returns (address)',
  'function isGraduated(address token) view returns (bool)',
  'event BondingCurveCreated(address indexed token, address indexed curve, address indexed creator, uint256 initialInventory)',
]);

const BONDING_CURVE_ABI = parseAbi([
  'function token() view returns (address)',
  'function creator() view returns (address)',
  'function realEthReserve() view returns (uint256)',
  'function realTokenReserve() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function uniswapPool() view returns (address)',
  'function getCurrentPrice() view returns (uint256)',
  'event TokensPurchased(address indexed buyer, address indexed recipient, uint256 ethInGross, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event TokensSold(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 netEthOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event Graduated(address indexed pool, uint256 tokenId, uint256 wethAmount, uint256 tokenAmount)',
]);

const ROUTER_ABI = parseAbi([
  'event IncentifiTrade(address indexed token, address indexed trader, bool indexed isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 creatorFee, uint256 lossPoolFee)',
]);

const UNISWAP_V3_POOL_ABI = parseAbi([
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);

const LOSS_POOL_ABI = parseAbi([
  'function getUnallocatedBalance(address token) view returns (uint256)',
]);

// V4: unlike V3's per-token BondingCurveCreated, there is one shared factory whose
// TokenLaunched event is the only on-chain record of "a V4 token exists" — there is no
// per-token curve contract to independently discover from, so this event IS the discovery
// mechanism (see discoverV4TokensInRange below), not just a convenience.
const V4_FACTORY_ABI = parseAbi([
  'event TokenLaunched(address indexed token, address indexed creator, bytes32 poolId)',
]);
const ERC20_SYMBOL_ABI = parseAbi(['function symbol() view returns (string)']);

const INCENTIFI_BONDING_CURVE_FACTORY = (process.env.VITE_INCENTIFI_BONDING_CURVE_FACTORY || '0xa0143de84fba1753b887e4e32941e4fb342e473f');
const LOSS_REWARD_POOL = (process.env.VITE_LOSS_REWARD_POOL || '0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const INCENTIFI_SWAP_ROUTER = (process.env.VITE_INCENTIFI_SWAP_ROUTER || '0x4c1f4197b5eebb6cc15c37e053f963a56787575e');
const INCENTIFI_V4_FACTORY = (process.env.VITE_INCENTIFI_V4_FACTORY || '0xdEca2efDB578B6E5F298885b97F64d52f92f5Aa9');

// Reference ETH/USD used for price_usd — kept numerically identical to
// src/lib/bondingCurve.ts's REFERENCE_ETH_USD (also 2500) so V3 and V4 rows in
// token_market_snapshots_evm are computed on the same basis.
const REFERENCE_ETH_USD = 2500;

// Conservative floor for the one-time V4 TokenLaunched historical catch-up scan (see
// discoverV4TokensInRange). NOT derived from a binary search on eth_getCode/eth_getBytecode
// — this RPC only retains full state (balances, code) for roughly the last 5,600-6,000
// blocks (empirically measured against real responses; confirmed independently the hard
// way while building test/hardhat/loss-reward-fork.test.ts), so a getCode-based binary
// search for the V4 factory's real deployment block is unreliable for anything older than
// that. getLogs, in contrast, has been repeatedly confirmed to work correctly across much
// older block ranges on this same RPC. This floor was chosen by chunked getLogs scanning
// from a wide starting point and confirming it still finds the real, known TokenLaunched
// events (TESTTT among them) with room to spare — comfortably before the V4 factory's
// actual deployment, not an exact value that could go stale as more blocks pass.
const V4_DISCOVERY_FLOOR_BLOCK = 54_600_000n;

// This process indexes on-chain trade events into `holder_cost_basis` for ALL
// registered tokens in one loop (not one worker per token), so it reports a single
// global heartbeat rather than the per-token pattern used by phase3-indexer.mjs.
// scripts/loss-reward-worker.mjs gates loss-reward snapshots on this heartbeat's
// freshness before trusting `holder_cost_basis` as "not stale".
const EVM_INDEXER_WORKER_NAME = 'evm-indexer';
const EVM_INDEXER_LOOP_MS = 10_000;

async function upsertIndexerHeartbeat(status, message) {
  try {
    const { error } = await supabase.from('indexer_heartbeats').upsert(
      {
        worker_name: EVM_INDEXER_WORKER_NAME,
        symbol: 'ALL',
        mint_address: '0x0000000000000000000000000000000000000000',
        status,
        message: message || '',
        loop_ms: EVM_INDEXER_LOOP_MS,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'worker_name' }
    );
    if (error) {
      console.error('[HEARTBEAT ERROR] Failed to upsert indexer_heartbeats:', error.message);
    }
  } catch (err) {
    console.error('[HEARTBEAT ERROR] Failed to upsert indexer_heartbeats:', err.message);
  }
}

const blockTimeCache = new Map();

async function getBlockTimeIso(blockNumber) {
  const bNum = typeof blockNumber === 'bigint' ? blockNumber : BigInt(blockNumber);
  const cached = blockTimeCache.get(bNum.toString());
  if (cached) return cached;

  try {
    const block = await client.getBlock({ blockNumber: bNum });
    const iso = new Date(Number(block.timestamp) * 1000).toISOString();
    blockTimeCache.set(bNum.toString(), iso);
    if (blockTimeCache.size > 2000) {
      const keys = [...blockTimeCache.keys()].slice(0, 500);
      keys.forEach((k) => blockTimeCache.delete(k));
    }
    return iso;
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Aggregates a single trade into the 1-minute candle table (token_candles_1m).
 */
export async function aggregateCandle1m(symbol, mintAddress, priceEth, volumeEth, blockTimeIso) {
  const tsMs = Date.parse(blockTimeIso);
  const bucketMs = Math.floor(tsMs / 60_000) * 60_000;
  const bucketTs = new Date(bucketMs).toISOString();

  // Query existing candle for this minute bucket
  const { data: existing, error: checkCandleErr } = await supabase
    .from('token_candles_1m')
    .select('*')
    .eq('symbol', symbol.toUpperCase())
    .eq('bucket_ts', bucketTs)
    .maybeSingle();

  if (checkCandleErr) {
    throw new Error(`[DB ERROR] Failed to query token_candles_1m (${symbol} ${bucketTs}): ${checkCandleErr.code} ${checkCandleErr.message}`);
  }

  if (existing) {
    const open = Number(existing.open);
    const high = Math.max(Number(existing.high), priceEth);
    const low = Math.min(Number(existing.low), priceEth);
    const close = priceEth;
    const volumeSol = Number(existing.volume_sol) + volumeEth;

    const { error: upsertCandleErr } = await supabase.from('token_candles_1m').upsert({
      symbol: symbol.toUpperCase(),
      mint_address: mintAddress.toLowerCase(),
      bucket_ts: bucketTs,
      open,
      high,
      low,
      close,
      volume_sol: volumeSol,
      source: 'indexer',
      updated_at: new Date().toISOString(),
    });

    if (upsertCandleErr) {
      throw new Error(`[DB ERROR] Failed to update token_candles_1m (${symbol} ${bucketTs}): ${upsertCandleErr.code} ${upsertCandleErr.message}`);
    }
  } else {
    const { error: insertCandleErr } = await supabase.from('token_candles_1m').upsert({
      symbol: symbol.toUpperCase(),
      mint_address: mintAddress.toLowerCase(),
      bucket_ts: bucketTs,
      open: priceEth,
      high: priceEth,
      low: priceEth,
      close: priceEth,
      volume_sol: volumeEth,
      source: 'indexer',
      updated_at: new Date().toISOString(),
    });

    if (insertCandleErr) {
      throw new Error(`[DB ERROR] Failed to insert token_candles_1m (${symbol} ${bucketTs}): ${insertCandleErr.code} ${insertCandleErr.message}`);
    }
  }
}

/**
 * Process a Buy trade on bonding curve.
 */
export async function processBuyTrade(tokenAddress, symbol, trader, amountToken, amountEth, creatorFee, lossPoolFee, tradeIdentity, blockNumber, blockTime) {
  const token = tokenAddress.toLowerCase();
  const wallet = trader.toLowerCase();
  const priceEth = amountToken > 0 ? (amountEth - creatorFee - lossPoolFee) / amountToken : 0;

  // 1. Deduplication check: if trade already recorded, skip to prevent double-counting
  const { data: existingTrade, error: checkTradeErr } = await supabase
    .from('token_trades_evm')
    .select('tx_hash')
    .eq('tx_hash', tradeIdentity)
    .maybeSingle();

  if (checkTradeErr) {
    throw new Error(`[DB ERROR] Failed to query token_trades_evm (${tradeIdentity}): ${checkTradeErr.code} ${checkTradeErr.message}`);
  }

  if (existingTrade) {
    return;
  }

  // 2. Fetch current cost basis
  const { data: existing, error: fetchHolderErr } = await supabase
    .from('holder_cost_basis')
    .select('*')
    .eq('token_address', token)
    .eq('wallet_address', wallet)
    .maybeSingle();

  if (fetchHolderErr) {
    throw new Error(`[DB ERROR] Failed to query holder_cost_basis (${token} ${wallet}): ${fetchHolderErr.code} ${fetchHolderErr.message}`);
  }

  const prevInvested = existing ? Number(existing.total_invested_eth) : 0;
  const prevBalance = existing ? Number(existing.token_balance) : 0;

  const newInvested = prevInvested + amountEth;
  const newBalance = prevBalance + amountToken;
  const newCostBasis = newBalance > 0 ? newInvested / newBalance : 0;

  // 3. Upsert holder state
  const { error: upsertHolderErr } = await supabase.from('holder_cost_basis').upsert({
    token_address: token,
    wallet_address: wallet,
    token_balance: newBalance,
    total_invested_eth: newInvested,
    avg_cost_basis_eth: newCostBasis,
    is_eligible: true,
    is_underwater_seller: false,
    last_updated_at: new Date().toISOString(),
  });

  if (upsertHolderErr) {
    throw new Error(`[DB ERROR] Failed to upsert holder_cost_basis (${token} ${wallet}): ${upsertHolderErr.code} ${upsertHolderErr.message}`);
  }

  // 4. Upsert trade log
  const { error: insertTradeErr } = await supabase.from('token_trades_evm').upsert({
    tx_hash: tradeIdentity,
    token_address: token,
    trader_address: wallet,
    side: 'buy',
    amount_token: amountToken,
    amount_eth: amountEth,
    price_eth: priceEth,
    creator_fee_eth: creatorFee,
    loss_pool_fee_eth: lossPoolFee,
    is_underwater_sale: false,
    block_number: Number(blockNumber),
    block_time: blockTime,
  });

  if (insertTradeErr) {
    throw new Error(`[DB ERROR] Failed to upsert token_trades_evm (${tradeIdentity}): ${insertTradeErr.code} ${insertTradeErr.message}`);
  }

  // 5. Update 1m candle
  await aggregateCandle1m(symbol, token, priceEth, amountEth, blockTime);

  console.log(`[BUY] ${symbol} by ${wallet.slice(0, 8)}: +${amountToken.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens for ${amountEth.toFixed(4)} ETH (Price: ${priceEth.toExponential(4)} ETH)`);
}

/**
 * Process a Sell trade on bonding curve.
 */
export async function processSellTrade(tokenAddress, symbol, trader, amountToken, amountEth, creatorFee, lossPoolFee, tradeIdentity, blockNumber, blockTime) {
  const token = tokenAddress.toLowerCase();
  const wallet = trader.toLowerCase();
  const priceEth = amountToken > 0 ? amountEth / amountToken : 0;

  // 1. Deduplication check: if trade already recorded, skip to prevent double-counting
  const { data: existingTrade, error: checkTradeErr } = await supabase
    .from('token_trades_evm')
    .select('tx_hash')
    .eq('tx_hash', tradeIdentity)
    .maybeSingle();

  if (checkTradeErr) {
    throw new Error(`[DB ERROR] Failed to query token_trades_evm (${tradeIdentity}): ${checkTradeErr.code} ${checkTradeErr.message}`);
  }

  if (existingTrade) {
    return;
  }

  // 2. Fetch current cost basis
  const { data: existing, error: fetchHolderErr } = await supabase
    .from('holder_cost_basis')
    .select('*')
    .eq('token_address', token)
    .eq('wallet_address', wallet)
    .maybeSingle();

  if (fetchHolderErr) {
    throw new Error(`[DB ERROR] Failed to query holder_cost_basis (${token} ${wallet}): ${fetchHolderErr.code} ${fetchHolderErr.message}`);
  }

  const prevInvested = existing ? Number(existing.total_invested_eth) : 0;
  const prevBalance = existing ? Number(existing.token_balance) : 0;
  const prevCostBasis = existing ? Number(existing.avg_cost_basis_eth) : 0;

  const isUnderwater = priceEth < prevCostBasis;
  const newBalance = Math.max(0, prevBalance - amountToken);

  let newInvested = 0;
  let newCostBasis = prevCostBasis;
  let isEligible = existing ? existing.is_eligible : true;
  let isUnderwaterSeller = existing ? existing.is_underwater_seller : false;

  if (isUnderwater) {
    isEligible = false;
    isUnderwaterSeller = true;
    newInvested = newBalance > 0 ? newBalance * prevCostBasis : 0;
    console.log(`[UNDERWATER SELL] ${wallet.slice(0, 8)} sold at loss (${priceEth.toExponential(4)} < ${prevCostBasis.toExponential(4)} ETH). DISQUALIFIED.`);
  } else {
    newInvested = newBalance > 0 ? newBalance * prevCostBasis : 0;
  }

  // 3. Upsert holder state
  const { error: upsertHolderErr } = await supabase.from('holder_cost_basis').upsert({
    token_address: token,
    wallet_address: wallet,
    token_balance: newBalance,
    total_invested_eth: newInvested,
    avg_cost_basis_eth: newCostBasis,
    is_eligible: isEligible,
    is_underwater_seller: isUnderwaterSeller,
    last_updated_at: new Date().toISOString(),
  });

  if (upsertHolderErr) {
    throw new Error(`[DB ERROR] Failed to upsert holder_cost_basis (${token} ${wallet}): ${upsertHolderErr.code} ${upsertHolderErr.message}`);
  }

  // 4. Upsert trade log
  const { error: insertTradeErr } = await supabase.from('token_trades_evm').upsert({
    tx_hash: tradeIdentity,
    token_address: token,
    trader_address: wallet,
    side: 'sell',
    amount_token: amountToken,
    amount_eth: amountEth,
    price_eth: priceEth,
    creator_fee_eth: creatorFee,
    loss_pool_fee_eth: lossPoolFee,
    is_underwater_sale: isUnderwater,
    block_number: Number(blockNumber),
    block_time: blockTime,
  });

  if (insertTradeErr) {
    throw new Error(`[DB ERROR] Failed to upsert token_trades_evm (${tradeIdentity}): ${insertTradeErr.code} ${insertTradeErr.message}`);
  }

  // 5. Update 1m candle
  await aggregateCandle1m(symbol, token, priceEth, amountEth, blockTime);

  console.log(`[SELL] ${symbol} by ${wallet.slice(0, 8)}: -${amountToken.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens for ${amountEth.toFixed(4)} ETH (Price: ${priceEth.toExponential(4)} ETH)`);
}

/**
 * Updates token_market_snapshots_evm from live curve/pool state.
 */
export async function updateMarketSnapshot(tokenAddress, symbol, curveAddress) {
  try {
    const token = tokenAddress.toLowerCase();
    let priceEth = 0;
    let liquidityEth = 0;
    let marketCapUsd = 0;
    let lossPoolTvlEth = 0;

    if (curveAddress) {
      const [realEthReserve, realTokenReserve, graduated] = await Promise.all([
        client.readContract({ address: curveAddress, abi: BONDING_CURVE_ABI, functionName: 'realEthReserve' }),
        client.readContract({ address: curveAddress, abi: BONDING_CURVE_ABI, functionName: 'realTokenReserve' }),
        client.readContract({ address: curveAddress, abi: BONDING_CURVE_ABI, functionName: 'graduated' }),
      ]);

      const VIRTUAL_ETH = 2.15625;
      const VIRTUAL_TOKEN = 78_125_000;
      const curEth = VIRTUAL_ETH + (Number(realEthReserve) / 1e18);
      const curToken = VIRTUAL_TOKEN + (Number(realTokenReserve) / 1e18);
      priceEth = curEth / curToken;
      liquidityEth = (Number(realEthReserve) / 1e18) * 2;
      marketCapUsd = priceEth * 1_000_000_000 * 2500;
    }

    try {
      const tvl = await client.readContract({
        address: getAddress(LOSS_REWARD_POOL),
        abi: LOSS_POOL_ABI,
        functionName: 'getUnallocatedBalance',
        args: [getAddress(tokenAddress)],
      });
      lossPoolTvlEth = Number(tvl) / 1e18;
    } catch {
      // Ignore
    }

    const { error: snapErr } = await supabase.from('token_market_snapshots_evm').upsert({
      token_address: token,
      symbol: symbol.toUpperCase(),
      price_eth: priceEth,
      price_usd: priceEth * 2500,
      liquidity_eth: liquidityEth,
      market_cap_usd: marketCapUsd,
      loss_pool_tvl_eth: lossPoolTvlEth,
      updated_at: new Date().toISOString(),
    });

    if (snapErr) {
      throw new Error(`[DB ERROR] Failed to upsert token_market_snapshots_evm (${symbol}): ${snapErr.code} ${snapErr.message}`);
    }
  } catch (err) {
    console.warn(`Could not update market snapshot for ${symbol}:`, err.message);
  }
}

// ============================================================================
// V4 token discovery + market snapshot indexing
// ============================================================================
// V4 has no per-token curve contract to read state from directly (unlike V3's
// IncentifiBondingCurve) — every launched token shares one hook instance, keyed by a
// PoolId derived from the token's PoolKey. src/lib/bondingCurveV4.ts's
// fetchV4CurveState() already implements the full pre-/post-graduation state-reading
// logic (hook.curveStates(poolId) pre-graduation, StateView.getSlot0(poolId)
// post-graduation) and is the single, already-verified source of truth for it — reused
// here via Vite's SSR module loader rather than re-derived, so there is exactly one
// implementation of this logic for the whole app to ever drift out of sync with. This
// is heavier than a plain import (a Vite dev server has to spin up once), which is an
// acceptable one-time startup cost for a long-running indexer process; it is NOT
// re-created per call, per tick, or per token.

let v4ModulePromise = null;
async function getV4Module() {
  if (!v4ModulePromise) {
    v4ModulePromise = (async () => {
      const viteServer = await createViteServer({ server: { middlewareMode: true }, appType: 'custom' });
      return viteServer.ssrLoadModule('/src/lib/bondingCurveV4.ts');
    })();
  }
  return v4ModulePromise;
}

// lowercase token address -> symbol, for every V4 token discovered so far this process.
const v4TokenSymbolCache = new Map();
// Block through which V4 TokenLaunched events have been scanned. Starts unset until
// discoverV4TokensInRange's one-time historical catch-up (see runIndexer) has run, so the
// per-tick incremental scan below never fires against an unpopulated cache.
let v4LastScannedBlock = null;

async function getLogsWithRetry(params, { retries = 3, baseDelayMs = 500 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.getLogs(params);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }
}

/**
 * Scans [fromBlock, toBlock] in 5,000-block chunks (this RPC's per-call range cap, same
 * limit already respected everywhere else in this file) for real TokenLaunched events on
 * the V4 factory, resolving and caching each newly-discovered token's real ERC20 symbol()
 * directly from-chain (independent of whatever the `tokens` table may or may not have —
 * that table's row is a best-effort client-side write from the launch flow and can be
 * missing even for a real, successfully-launched token). Retries each chunk on transient
 * RPC failure rather than silently skipping it, since a skipped chunk here would mean
 * permanently missing a real token launch, not just a delayed retry on the next tick (this
 * function is also used for the one-time historical catch-up, where there is no "next
 * tick" to self-heal on).
 */
export async function discoverV4TokensInRange(fromBlock, toBlock, { chunkSize = 5000n } = {}) {
  let from = fromBlock;
  while (from <= toBlock) {
    const to = from + chunkSize > toBlock ? toBlock : from + chunkSize;
    const logs = await getLogsWithRetry({
      address: getAddress(INCENTIFI_V4_FACTORY),
      event: parseAbiItem('event TokenLaunched(address indexed token, address indexed creator, bytes32 poolId)'),
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      const tokenAddr = log.args.token.toLowerCase();
      if (v4TokenSymbolCache.has(tokenAddr)) continue;
      try {
        const symbol = await client.readContract({
          address: getAddress(tokenAddr),
          abi: ERC20_SYMBOL_ABI,
          functionName: 'symbol',
        });
        v4TokenSymbolCache.set(tokenAddr, symbol);
        console.log(`[V4 DISCOVERY] Found V4 token ${symbol} (${tokenAddr}) launched at block ${log.blockNumber}`);
      } catch (err) {
        console.warn(`[V4 DISCOVERY] Could not read symbol() for newly-discovered V4 token ${tokenAddr}: ${err.message}`);
      }
    }

    from = to + 1n;
  }
}

/**
 * Updates token_market_snapshots_evm for a single V4 token from its real, live on-chain
 * state, in the same row shape V3 snapshots use so home/page.tsx's existing
 * snapshot-based rendering picks it up with no V4-specific branching needed there.
 */
export async function updateV4MarketSnapshot(tokenAddress, symbol, fetchV4CurveState) {
  try {
    const state = await fetchV4CurveState(tokenAddress, REFERENCE_ETH_USD);
    const priceEth = state.currentPriceEth || 0;
    // Mirrors V3's own liquidity_eth approximation (real ETH reserve, doubled to
    // represent both sides of the pool) for consistency between V3 and V4 rows in the
    // same table — see updateMarketSnapshot above.
    const liquidityEth = (Number(state.realEthReserve) / 1e18) * 2;

    let lossPoolTvlEth = 0;
    try {
      const tvl = await client.readContract({
        address: getAddress(LOSS_REWARD_POOL),
        abi: LOSS_POOL_ABI,
        functionName: 'getUnallocatedBalance',
        args: [getAddress(tokenAddress)],
      });
      lossPoolTvlEth = Number(tvl) / 1e18;
    } catch {
      // Ignore
    }

    const { error: snapErr } = await supabase.from('token_market_snapshots_evm').upsert({
      token_address: tokenAddress.toLowerCase(),
      symbol: symbol.toUpperCase(),
      price_eth: priceEth,
      price_usd: priceEth * REFERENCE_ETH_USD,
      liquidity_eth: liquidityEth,
      market_cap_usd: state.marketCapUsd || 0,
      loss_pool_tvl_eth: lossPoolTvlEth,
      updated_at: new Date().toISOString(),
    });

    if (snapErr) {
      throw new Error(`[DB ERROR] Failed to upsert token_market_snapshots_evm (V4 ${symbol}): ${snapErr.code} ${snapErr.message}`);
    }
  } catch (err) {
    console.warn(`Could not update V4 market snapshot for ${symbol}:`, err.message);
  }
}

/**
 * Main Indexer Poller Loop
 */
export async function runIndexer() {
  console.log('--- Starting Incentifi EVM Indexer ---');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Factory: ${INCENTIFI_BONDING_CURVE_FACTORY}`);
  console.log(`V4 Factory: ${INCENTIFI_V4_FACTORY}`);

  let lastPolledBlock = 0n;
  const curveAddressCache = new Map();

  // One-time V4 TokenLaunched historical catch-up: without this, the per-tick
  // incremental scan below (which only ever looks at the current tick's small block
  // window) would never see a V4 token launched before this process started — there is
  // no `tokens`-table-style registry this side can fall back on, since the whole point
  // of event-based discovery is to work independently of that (see the V4 section's
  // header comment above for why). Runs once, before the poller loop begins.
  try {
    const catchupEndBlock = await client.getBlockNumber();
    console.log(`[V4 DISCOVERY] Running one-time historical catch-up scan (block ${V4_DISCOVERY_FLOOR_BLOCK} → ${catchupEndBlock})...`);
    await discoverV4TokensInRange(V4_DISCOVERY_FLOOR_BLOCK, catchupEndBlock);
    v4LastScannedBlock = catchupEndBlock;
    console.log(`[V4 DISCOVERY] Historical catch-up complete. Found ${v4TokenSymbolCache.size} V4 token(s) so far.`);
  } catch (err) {
    console.error('[V4 DISCOVERY] Historical catch-up scan failed — V4 tokens will not be indexed until this succeeds on a future restart:', err.message);
  }

  setInterval(async () => {
    try {
      const currentBlock = await client.getBlockNumber();
      if (lastPolledBlock === 0n) {
        // Startup recovery: fetch latest indexed block from token_trades_evm
        const { data: latestTrades, error: latestTradesErr } = await supabase
          .from('token_trades_evm')
          .select('block_number')
          .order('block_number', { ascending: false })
          .limit(1);

        if (latestTradesErr) {
          throw new Error(`[DB ERROR] Failed to query latest block from token_trades_evm: ${latestTradesErr.code} ${latestTradesErr.message}`);
        }

        if (latestTrades && latestTrades.length > 0 && latestTrades[0].block_number > 0) {
          // Re-scan from latest trade block to catch any partial block writes
          lastPolledBlock = BigInt(latestTrades[0].block_number) > 1n ? BigInt(latestTrades[0].block_number) - 1n : 0n;
          console.log(`[INDEXER RECOVERY] Resuming from block ${lastPolledBlock}`);
        } else {
          lastPolledBlock = currentBlock > 50n ? currentBlock - 50n : 0n;
          console.log(`[INDEXER INIT] Starting fresh from block ${lastPolledBlock}`);
        }
      }

      if (currentBlock <= lastPolledBlock) return;

      const fromBlock = lastPolledBlock + 1n;
      // Cap chunk size to 5,000 blocks to prevent RPC timeout/range errors
      const CHUNK_SIZE = 5000n;
      const toBlock = currentBlock > fromBlock + CHUNK_SIZE ? fromBlock + CHUNK_SIZE : currentBlock;

      // V4: independent of the `tokens` table (see the V4 section's header comment) and
      // of whether any V3 tokens exist, so this runs unconditionally every tick, in its
      // own try/catch so a V4-specific hiccup never blocks V3 indexing for this tick.
      if (v4LastScannedBlock !== null) {
        try {
          // Guard against toBlock (bounded by the unrelated V3 cursor's own chunking)
          // ever being behind v4LastScannedBlock — keeps this cursor monotonic even if
          // V3's own cursor is temporarily lagging chain head for some other reason.
          if (toBlock > v4LastScannedBlock) {
            await discoverV4TokensInRange(v4LastScannedBlock + 1n, toBlock);
            v4LastScannedBlock = toBlock;
          }
          if (v4TokenSymbolCache.size > 0) {
            const v4Module = await getV4Module();
            for (const [tokenAddr, symbol] of v4TokenSymbolCache) {
              await updateV4MarketSnapshot(tokenAddr, symbol, v4Module.fetchV4CurveState);
            }
          }
        } catch (err) {
          console.warn('[V4] Discovery/snapshot pass failed this tick (will retry next tick):', err.message);
        }
      }

      // 1. Fetch active tokens
      const { data: tokens, error: tokensErr } = await supabase.from('tokens').select('mint_address, symbol');
      if (tokensErr) {
        throw new Error(`[DB ERROR] Failed to fetch active tokens: ${tokensErr.code} ${tokensErr.message}`);
      }
      if (!tokens || tokens.length === 0) return;

      for (const t of tokens) {
        if (!t.mint_address) continue;
        const tokenAddr = t.mint_address.toLowerCase();

        // Resolve curve address
        let curveAddr = curveAddressCache.get(tokenAddr);
        if (!curveAddr) {
          try {
            const curve = await client.readContract({
              address: getAddress(INCENTIFI_BONDING_CURVE_FACTORY),
              abi: FACTORY_ABI,
              functionName: 'getBondingCurve',
              args: [getAddress(t.mint_address)],
            });
            if (curve && curve !== '0x0000000000000000000000000000000000000000') {
              curveAddr = curve.toLowerCase();
              curveAddressCache.set(tokenAddr, curveAddr);
            }
          } catch {
            // Ignore
          }
        }

        if (curveAddr) {
          // Poll TokensPurchased & TokensSold on the Curve
          const buyLogs = await client.getLogs({
            address: getAddress(curveAddr),
            event: parseAbiItem('event TokensPurchased(address indexed buyer, address indexed recipient, uint256 ethInGross, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)'),
            fromBlock,
            toBlock,
          });

          for (const log of buyLogs) {
            const buyer = log.args.buyer;
            const grossEth = Number(log.args.ethInGross) / 1e18;
            const tokensOut = Number(log.args.tokensOut) / 1e18;
            const creatorFee = Number(log.args.creatorFee) / 1e18;
            const lossPoolFee = Number(log.args.lossPoolFee) / 1e18;
            const blockTime = await getBlockTimeIso(log.blockNumber);
            const tradeId = `${log.transactionHash}:${log.logIndex ?? 0}`;

            await processBuyTrade(tokenAddr, t.symbol, buyer, tokensOut, grossEth, creatorFee, lossPoolFee, tradeId, log.blockNumber, blockTime);
          }

          const sellLogs = await client.getLogs({
            address: getAddress(curveAddr),
            event: parseAbiItem('event TokensSold(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 netEthOut, uint256 creatorFee, uint256 lossPoolFee)'),
            fromBlock,
            toBlock,
          });

          for (const log of sellLogs) {
            const seller = log.args.seller;
            const tokensIn = Number(log.args.tokensIn) / 1e18;
            const netEthOut = Number(log.args.netEthOut) / 1e18;
            const creatorFee = Number(log.args.creatorFee) / 1e18;
            const lossPoolFee = Number(log.args.lossPoolFee) / 1e18;
            const blockTime = await getBlockTimeIso(log.blockNumber);
            const tradeId = `${log.transactionHash}:${log.logIndex ?? 0}`;

            await processSellTrade(tokenAddr, t.symbol, seller, tokensIn, netEthOut, creatorFee, lossPoolFee, tradeId, log.blockNumber, blockTime);
          }

          // Update snapshot
          await updateMarketSnapshot(tokenAddr, t.symbol, curveAddr);
        }
      }

      // Successfully processed all events for range; advance block pointer safely
      lastPolledBlock = toBlock;
      await upsertIndexerHeartbeat('ok', `Indexed through block ${toBlock}`);
    } catch (err) {
      console.error('Indexer loop error (will retry next interval without advancing block):', err.message);
      await upsertIndexerHeartbeat('error', err.message);
    }
  }, EVM_INDEXER_LOOP_MS);
}

if (process.argv[1]?.endsWith('evm-indexer.mjs')) {
  runIndexer();
}
