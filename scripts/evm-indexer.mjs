import { createClient } from '@supabase/supabase-js';
import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  getAddress,
} from 'viem';
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

const INCENTIFI_BONDING_CURVE_FACTORY = (process.env.VITE_INCENTIFI_BONDING_CURVE_FACTORY || '0x9fcea653c6f31c82606582b22da82b39f61f9c0e');
const LOSS_REWARD_POOL = (process.env.VITE_LOSS_REWARD_POOL || '0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const INCENTIFI_SWAP_ROUTER = (process.env.VITE_INCENTIFI_SWAP_ROUTER || '0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf');

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

/**
 * Main Indexer Poller Loop
 */
export async function runIndexer() {
  console.log('--- Starting Incentifi EVM Indexer ---');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Factory: ${INCENTIFI_BONDING_CURVE_FACTORY}`);

  let lastPolledBlock = 0n;
  const curveAddressCache = new Map();

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
