import { encodeEventTopics, decodeEventLog, parseAbi, getAddress } from 'viem';
import { getEvmProvider } from './evmNetwork';
import { WETH_ADDRESS } from './uniswapAddresses';

const SWAP_EVENT_ABI = parseAbi([
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);

export type PoolTrade = {
  id: string;
  timestamp: number;
  side: 'buy' | 'sell';
  priceEth: number;
  tokenAmount: number;
  ethAmount: number;
  txHash: string;
};

export type PoolCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const call = async (method: string, params: unknown[]) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Wallet provider not available.');
  return provider.request({ method, params });
};

const priceInEth = (sqrtPriceX96: bigint, tokenIsToken0: boolean): number => {
  const Q96 = 2 ** 96;
  const sqrtPrice = Number(sqrtPriceX96) / Q96;
  const price0in1 = sqrtPrice * sqrtPrice; // token1 per token0
  return tokenIsToken0 ? 1 / price0in1 : price0in1;
};

// Alchemy's free tier caps eth_getLogs to a 10-block range per call, so pull
// recent history in small chunks instead of one large request. Upgrading the
// Alchemy plan later would let this look back much further in one call.
const CHUNK_SIZE = 10;
const PARALLEL_CHUNKS = 8;

const fetchLogsInChunks = async (
  poolAddress: string,
  topics: string[],
  fromBlock: number,
  toBlock: number
): Promise<any[]> => {
  const ranges: Array<[number, number]> = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    ranges.push([start, Math.min(start + CHUNK_SIZE - 1, toBlock)]);
  }

  const allLogs: any[] = [];
  for (let i = 0; i < ranges.length; i += PARALLEL_CHUNKS) {
    const batch = ranges.slice(i, i + PARALLEL_CHUNKS);
    const results = await Promise.all(
      batch.map(([start, end]) =>
        call('eth_getLogs', [
          {
            address: poolAddress,
            topics,
            fromBlock: `0x${start.toString(16)}`,
            toBlock: `0x${end.toString(16)}`,
          },
        ]).catch(() => [])
      )
    );
    for (const logs of results) allLogs.push(...(logs as any[]));
  }
  return allLogs;
};

export const fetchPoolHistory = async (
  poolAddress: string,
  tokenAddress: string,
  tokenDecimals: number,
  blockRange = 500
): Promise<{ trades: PoolTrade[]; candles: PoolCandle[] }> => {
  const token = getAddress(tokenAddress);
  const weth = getAddress(WETH_ADDRESS);
  const tokenIsToken0 = BigInt(token) < BigInt(weth);

  const topics = encodeEventTopics({ abi: SWAP_EVENT_ABI, eventName: 'Swap' });

  const latestBlockHex = (await call('eth_blockNumber', [])) as string;
  const latestBlock = Number(BigInt(latestBlockHex));
  const fromBlock = Math.max(0, latestBlock - blockRange);

  const logs = await fetchLogsInChunks(poolAddress, topics as string[], fromBlock, latestBlock);

  if (!logs.length) return { trades: [], candles: [] };

  const uniqueBlocks = [...new Set(logs.map((log) => log.blockNumber as string))];
  const blockResults = await Promise.all(
    uniqueBlocks.map((bn) => call('eth_getBlockByNumber', [bn, false]))
  );
  const timestampByBlock = new Map<string, number>();
  uniqueBlocks.forEach((bn, i) => {
    const ts = (blockResults[i] as any)?.timestamp;
    if (ts) timestampByBlock.set(bn, Number(BigInt(ts)) * 1000);
  });

  const trades: PoolTrade[] = [];
  for (const log of logs) {
    try {
      const decoded: any = decodeEventLog({ abi: SWAP_EVENT_ABI, data: log.data, topics: log.topics });
      const amount0 = decoded.args.amount0 as bigint;
      const amount1 = decoded.args.amount1 as bigint;
      const sqrtPriceX96 = decoded.args.sqrtPriceX96 as bigint;
      const timestamp = timestampByBlock.get(log.blockNumber) || Date.now();

      const tokenDelta = tokenIsToken0 ? amount0 : amount1;
      const ethDelta = tokenIsToken0 ? amount1 : amount0;
      // Pool's token balance decreasing (negative delta) means a trader bought it.
      const side: 'buy' | 'sell' = tokenDelta < 0n ? 'buy' : 'sell';

      const tokenAmount = Math.abs(Number(tokenDelta)) / 10 ** tokenDecimals;
      const ethAmount = Math.abs(Number(ethDelta)) / 1e18;
      const price = priceInEth(sqrtPriceX96, tokenIsToken0);

      trades.push({
        id: `${log.transactionHash}-${log.logIndex}`,
        timestamp,
        side,
        priceEth: price,
        tokenAmount,
        ethAmount,
        txHash: log.transactionHash,
      });
    } catch {
      // Not a decodable Swap log - skip.
    }
  }

  trades.sort((a, b) => a.timestamp - b.timestamp);

  const bucketMs = 60_000;
  const buckets = new Map<number, PoolTrade[]>();
  for (const trade of trades) {
    const key = Math.floor(trade.timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(key) || [];
    bucket.push(trade);
    buckets.set(key, bucket);
  }

  const candles: PoolCandle[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, bucketTrades]) => {
      const prices = bucketTrades.map((t) => t.priceEth);
      const volume = bucketTrades.reduce((sum, t) => sum + t.ethAmount, 0);
      return {
        timestamp,
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        volume,
      };
    });

  return { trades: trades.reverse(), candles };
};
