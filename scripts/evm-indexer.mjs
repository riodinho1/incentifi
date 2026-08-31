import { createClient } from '@supabase/supabase-js';
import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  getAddress,
  decodeEventLog,
} from 'viem';

// Environment variables
const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'http://127.0.0.1:8545';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in environment.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const client = createPublicClient({
  transport: http(RPC_URL),
});

const ERC20_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address account) view returns (uint256)',
]);

const ROUTER_ABI = parseAbi([
  'event IncentifiTrade(address indexed token, address indexed trader, bool indexed isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 creatorFee, uint256 lossPoolFee)',
]);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
]);

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

const WETH_ADDRESS = (process.env.VITE_WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase();
const UNISWAP_V3_FACTORY = (process.env.VITE_UNISWAP_V3_FACTORY || '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
const INCENTIFI_SWAP_ROUTER = (process.env.VITE_INCENTIFI_SWAP_ROUTER || process.env.INCENTIFI_SWAP_ROUTER || '0xC04E781fFF1dDEbC874B2A7B5490a6eaE3922c2f');
const POOL_FEE = 10000;

/**
 * Fetch Uniswap V3 Pool address for token.
 */
export async function getPoolAddress(tokenAddress) {
  try {
    const token = getAddress(tokenAddress);
    const weth = getAddress(WETH_ADDRESS);
    const pool = await client.readContract({
      address: UNISWAP_V3_FACTORY,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [token, weth, POOL_FEE],
    });
    if (!pool || pool === '0x0000000000000000000000000000000000000000') return null;
    return pool.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Fetch 30-min TWAP price (or slot0 fallback) in ETH per token.
 */
export async function getPoolTwapPriceEth(tokenAddress) {
  try {
    const token = getAddress(tokenAddress);
    const weth = getAddress(WETH_ADDRESS);
    const poolAddress = await client.readContract({
      address: UNISWAP_V3_FACTORY,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [token, weth, POOL_FEE],
    });

    if (!poolAddress || poolAddress === '0x0000000000000000000000000000000000000000') {
      return 0;
    }

    const isToken0 = BigInt(token) < BigInt(weth);

    // Try 30-min (1800s) observe
    try {
      const [tickCumulatives] = await client.readContract({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: 'observe',
        args: [[1800, 0]],
      });
      const tickDelta = Number(tickCumulatives[1] - tickCumulatives[0]);
      const avgTick = Math.round(tickDelta / 1800);
      const ratio = 1.0001 ** (avgTick / 2);
      const price1Per0 = ratio * ratio;
      return isToken0 ? price1Per0 : 1 / price1Per0;
    } catch {
      // Fallback to slot0 instantaneous if pool history < 1800s
      const slot0 = await client.readContract({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: 'slot0',
      });
      const sqrtPriceX96 = Number(slot0[0]) / 2 ** 96;
      const price1Per0 = sqrtPriceX96 * sqrtPriceX96;
      return isToken0 ? price1Per0 : 1 / price1Per0;
    }
  } catch (err) {
    console.error(`Error fetching TWAP for ${tokenAddress}:`, err.message);
    return 0;
  }
}

/**
 * Process a Buy trade for a holder.
 */
export async function processBuyTrade(tokenAddress, trader, amountToken, amountEth, creatorFee, lossPoolFee, txHash, blockNumber, blockTime) {
  const token = tokenAddress.toLowerCase();
  const wallet = trader.toLowerCase();
  const priceEth = amountToken > 0 ? amountEth / amountToken : 0;

  // 1. Fetch current cost basis
  const { data: existing } = await supabase
    .from('holder_cost_basis')
    .select('*')
    .eq('token_address', token)
    .eq('wallet_address', wallet)
    .single();

  const prevInvested = existing ? Number(existing.total_invested_eth) : 0;
  const prevBalance = existing ? Number(existing.token_balance) : 0;

  const newInvested = prevInvested + amountEth;
  const newBalance = prevBalance + amountToken;
  const newCostBasis = newBalance > 0 ? newInvested / newBalance : 0;

  // 2. Upsert holder state (Buy re-establishes eligibility)
  await supabase.from('holder_cost_basis').upsert({
    token_address: token,
    wallet_address: wallet,
    token_balance: newBalance,
    total_invested_eth: newInvested,
    avg_cost_basis_eth: newCostBasis,
    is_eligible: true,
    is_underwater_seller: false,
    last_updated_at: new Date().toISOString(),
  });

  // 3. Record trade log
  await supabase.from('token_trades_evm').upsert({
    tx_hash: txHash,
    token_address: token,
    trader_address: wallet,
    side: 'buy',
    amount_token: amountToken,
    amount_eth: amountEth,
    price_eth: priceEth,
    creator_fee_eth: creatorFee,
    loss_pool_fee_eth: lossPoolFee,
    is_underwater_sale: false,
    block_number: blockNumber,
    block_time: blockTime,
  });

  console.log(`[BUY] ${wallet.slice(0, 8)} bought ${amountToken.toFixed(2)} tokens for ${amountEth.toFixed(4)} ETH. Cost Basis: ${newCostBasis.toFixed(6)} ETH`);
}

/**
 * Process a Sell trade for a holder.
 */
export async function processSellTrade(tokenAddress, trader, amountToken, amountEth, creatorFee, lossPoolFee, txHash, blockNumber, blockTime) {
  const token = tokenAddress.toLowerCase();
  const wallet = trader.toLowerCase();
  const priceEth = amountToken > 0 ? amountEth / amountToken : 0;

  // 1. Fetch current cost basis
  const { data: existing } = await supabase
    .from('holder_cost_basis')
    .select('*')
    .eq('token_address', token)
    .eq('wallet_address', wallet)
    .single();

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
    // UNDERWATER SELL: Disqualify remaining position
    isEligible = false;
    isUnderwaterSeller = true;
    newInvested = newBalance > 0 ? newBalance * prevCostBasis : 0;
    console.log(`[UNDERWATER SELL] ${wallet.slice(0, 8)} sold at loss (${priceEth.toFixed(6)} < ${prevCostBasis.toFixed(6)}). DISQUALIFIED.`);
  } else {
    // PROFITABLE SELL: Maintain cost basis and eligibility
    newInvested = newBalance > 0 ? newBalance * prevCostBasis : 0;
    console.log(`[PROFITABLE SELL] ${wallet.slice(0, 8)} sold in profit (${priceEth.toFixed(6)} >= ${prevCostBasis.toFixed(6)}). Remains eligible.`);
  }

  // 2. Upsert holder state
  await supabase.from('holder_cost_basis').upsert({
    token_address: token,
    wallet_address: wallet,
    token_balance: newBalance,
    total_invested_eth: newInvested,
    avg_cost_basis_eth: newCostBasis,
    is_eligible: isEligible,
    is_underwater_seller: isUnderwaterSeller,
    last_updated_at: new Date().toISOString(),
  });

  // 3. Record trade log
  await supabase.from('token_trades_evm').upsert({
    tx_hash: txHash,
    token_address: token,
    trader_address: wallet,
    side: 'sell',
    amount_token: amountToken,
    amount_eth: amountEth,
    price_eth: priceEth,
    creator_fee_eth: creatorFee,
    loss_pool_fee_eth: lossPoolFee,
    is_underwater_sale: isUnderwater,
    block_number: blockNumber,
    block_time: blockTime,
  });
}

/**
 * Process ERC20 Transfer between two wallets or with Uniswap V3 Pool.
 */
export async function processTransfer(tokenAddress, from, to, amountToken, blockTime) {
  const token = tokenAddress.toLowerCase();
  const fromAddr = from.toLowerCase();
  const toAddr = to.toLowerCase();

  // 1. Ignore mints from zero address
  if (fromAddr === '0x0000000000000000000000000000000000000000') return;

  // 2. Ignore transfers to/from IncentifiSwapRouter (already processed via IncentifiTrade)
  const routerAddr = INCENTIFI_SWAP_ROUTER.toLowerCase();
  if (fromAddr === routerAddr || toAddr === routerAddr) return;

  const poolAddr = (await getPoolAddress(token)) || '';

  // 3. Case A: Direct Uniswap Sell (Tokens transferred directly into the pool outside IncentifiSwapRouter)
  if (poolAddr && toAddr === poolAddr) {
    const { data: senderData } = await supabase
      .from('holder_cost_basis')
      .select('*')
      .eq('token_address', token)
      .eq('wallet_address', fromAddr)
      .single();

    if (senderData && Number(senderData.token_balance) > 0) {
      const senderCostBasis = Number(senderData.avg_cost_basis_eth || 0);
      const twap = await getPoolTwapPriceEth(token);
      const isUnderwater = senderCostBasis > 0 && twap < senderCostBasis;
      const senderPrevBalance = Number(senderData.token_balance);
      const senderNewBalance = Math.max(0, senderPrevBalance - amountToken);
      const senderNewInvested = senderNewBalance * senderCostBasis;

      let isEligible = senderData.is_eligible;
      let isUnderwaterSeller = senderData.is_underwater_seller;

      if (isUnderwater) {
        isEligible = false;
        isUnderwaterSeller = true;
        console.log(`[UNROUTED UNDERWATER SELL] ${fromAddr.slice(0, 8)} sold directly to Uniswap pool below cost basis (${twap.toFixed(6)} < ${senderCostBasis.toFixed(6)}). DISQUALIFIED.`);
      }

      await supabase.from('holder_cost_basis').upsert({
        token_address: token,
        wallet_address: fromAddr,
        token_balance: senderNewBalance,
        total_invested_eth: senderNewInvested,
        avg_cost_basis_eth: senderCostBasis,
        is_eligible: isEligible,
        is_underwater_seller: isUnderwaterSeller,
        last_updated_at: new Date().toISOString(),
      });
    }
    return;
  }

  // 4. Case B: Direct Uniswap Buy (Tokens transferred directly from the pool to a user)
  if (poolAddr && fromAddr === poolAddr) {
    console.log(`[DIRECT UNISWAP BUY] ${toAddr.slice(0, 8)} bought ${amountToken.toFixed(2)} tokens directly from Uniswap pool (0 fee paid, no Incentifi cost basis recorded).`);
    return;
  }

  // 5. Case C: Ordinary Wallet-to-Wallet Transfer
  const { data: senderData } = await supabase
    .from('holder_cost_basis')
    .select('*')
    .eq('token_address', token)
    .eq('wallet_address', fromAddr)
    .single();

  const senderCostBasis = senderData ? Number(senderData.avg_cost_basis_eth) : 0;
  const senderPrevBalance = senderData ? Number(senderData.token_balance) : 0;
  const senderNewBalance = Math.max(0, senderPrevBalance - amountToken);
  const senderNewInvested = senderNewBalance * senderCostBasis;

  if (senderData) {
    await supabase.from('holder_cost_basis').upsert({
      token_address: token,
      wallet_address: fromAddr,
      token_balance: senderNewBalance,
      total_invested_eth: senderNewInvested,
      avg_cost_basis_eth: senderCostBasis,
      is_eligible: senderData.is_eligible,
      is_underwater_seller: senderData.is_underwater_seller,
      last_updated_at: new Date().toISOString(),
    });
  }

  if (toAddr !== '0x0000000000000000000000000000000000000000' && toAddr !== '0x000000000000000000000000000000000000dead') {
    const twap = await getPoolTwapPriceEth(token);
    const transferCostBasis = senderCostBasis > 0 ? Math.min(senderCostBasis, twap) : 0;

    if (transferCostBasis > 0) {
      const { data: recipientData } = await supabase
        .from('holder_cost_basis')
        .select('*')
        .eq('token_address', token)
        .eq('wallet_address', toAddr)
        .single();

      const recipPrevInvested = recipientData ? Number(recipientData.total_invested_eth) : 0;
      const recipPrevBalance = recipientData ? Number(recipientData.token_balance) : 0;

      const recipNewInvested = recipPrevInvested + (amountToken * transferCostBasis);
      const recipNewBalance = recipPrevBalance + amountToken;
      const recipNewCostBasis = recipNewBalance > 0 ? recipNewInvested / recipNewBalance : 0;

      await supabase.from('holder_cost_basis').upsert({
        token_address: token,
        wallet_address: toAddr,
        token_balance: recipNewBalance,
        total_invested_eth: recipNewInvested,
        avg_cost_basis_eth: recipNewCostBasis,
        is_eligible: true,
        is_underwater_seller: false,
        last_updated_at: new Date().toISOString(),
      });

      console.log(`[TRANSFER] ${amountToken.toFixed(2)} tokens from ${fromAddr.slice(0, 8)} to ${toAddr.slice(0, 8)} (Transfer Basis: ${transferCostBasis.toFixed(6)} ETH)`);
    } else {
      console.log(`[UNTRACKED TRANSFER] ${amountToken.toFixed(2)} tokens from ${fromAddr.slice(0, 8)} to ${toAddr.slice(0, 8)} (Sender has 0 basis, recipient receives 0 basis).`);
    }
  }
}

/**
 * Main Indexer Poller Loop
 */
export async function runIndexer() {
  console.log('--- Starting Incentifi EVM Indexer ---');
  console.log(`Connected RPC: ${RPC_URL}`);

  let lastPolledBlock = 0n;

  setInterval(async () => {
    try {
      const currentBlock = await client.getBlockNumber();
      if (lastPolledBlock === 0n) {
        lastPolledBlock = currentBlock > 50n ? currentBlock - 50n : 0n;
      }
      if (currentBlock <= lastPolledBlock) return;

      const fromBlock = lastPolledBlock + 1n;
      const toBlock = currentBlock;
      lastPolledBlock = currentBlock;

      // 1. Fetch active tokens from Supabase
      const { data: tokens } = await supabase.from('tokens').select('mint_address, symbol');
      if (!tokens || tokens.length === 0) return;

      const tokenSet = new Set(tokens.map((t) => (t.mint_address || '').toLowerCase()));

      // 2. Poll IncentifiTrade logs from Router
      if (INCENTIFI_SWAP_ROUTER) {
        try {
          const tradeLogs = await client.getLogs({
            address: getAddress(INCENTIFI_SWAP_ROUTER),
            fromBlock,
            toBlock,
          });

          for (const log of tradeLogs) {
            try {
              const decoded = decodeEventLog({
                abi: ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });

              if (decoded.eventName === 'IncentifiTrade') {
                const token = (decoded.args.token || '').toLowerCase();
                if (!tokenSet.has(token)) continue;

                const trader = (decoded.args.trader || '').toLowerCase();
                const isBuy = Boolean(decoded.args.isBuy);
                const ethAmount = Number(decoded.args.ethAmount) / 1e18;
                const tokenAmount = Number(decoded.args.tokenAmount) / 1e18;
                const creatorFee = Number(decoded.args.creatorFee) / 1e18;
                const lossPoolFee = Number(decoded.args.lossPoolFee) / 1e18;
                const txHash = log.transactionHash;
                const blockNum = Number(log.blockNumber);
                const blockTime = new Date().toISOString();

                if (isBuy) {
                  await processBuyTrade(token, trader, tokenAmount, ethAmount, creatorFee, lossPoolFee, txHash, blockNum, blockTime);
                } else {
                  await processSellTrade(token, trader, tokenAmount, ethAmount, creatorFee, lossPoolFee, txHash, blockNum, blockTime);
                }
              }
            } catch {
              // Log not matching ROUTER_ABI
            }
          }
        } catch (err) {
          console.error('Error fetching trade logs:', err.message);
        }
      }

      // 3. Poll ERC20 Transfer logs for active tokens
      for (const t of tokens) {
        if (!t.mint_address) continue;
        try {
          const transferLogs = await client.getLogs({
            address: getAddress(t.mint_address),
            event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
            fromBlock,
            toBlock,
          });

          for (const log of transferLogs) {
            const from = (log.args.from || '').toLowerCase();
            const to = (log.args.to || '').toLowerCase();
            const amountToken = Number(log.args.value || 0n) / 1e18;
            const blockTime = new Date().toISOString();
            await processTransfer(t.mint_address, from, to, amountToken, blockTime);
          }
        } catch {
          // Skip if log query error on transfer
        }
      }

      // 4. Update market snapshots for all tokens
      for (const t of tokens) {
        if (!t.mint_address) continue;
        const twap = await getPoolTwapPriceEth(t.mint_address);

        await supabase.from('token_market_snapshots_evm').upsert({
          token_address: t.mint_address.toLowerCase(),
          symbol: t.symbol,
          price_eth: twap,
          market_cap_usd: twap * 1_000_000_000 * 2500, // 1B supply * price * ETH USD
          updated_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('Indexer loop error:', err.message);
    }
  }, 10_000);
}

if (process.argv[1]?.endsWith('evm-indexer.mjs')) {
  runIndexer();
}
