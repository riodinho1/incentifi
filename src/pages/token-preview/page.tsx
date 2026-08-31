import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createSeriesMarkers,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import WalletButton from '../../components/WalletButton';
import { supabase } from '../../lib/supabase';
import {
  EVM_ADDRESS_URL,
  EVM_CHAIN_NAME,
  EVM_NATIVE_SYMBOL,
  EVM_TX_URL,
  getEvmProvider,
} from '../../lib/evmNetwork';
import {
  fetchIndexedCandles,
  fetchIndexerHeartbeat,
  fetchIndexedSnapshot,
  fetchIndexedTrades,
} from '../../lib/marketData';
import { buyToken, sellToken, getPoolMarketState } from '../../lib/swap';
import { fetchPoolHistory } from '../../lib/poolHistory';
import { fetchChatMessages, postChatMessage, type ChatMessage } from '../../lib/chat';
import { getWalletAccount } from '../../lib/walletAccount';
import { describeError } from '../../lib/errors';
import { encodeFunctionData, parseAbi, getAddress } from 'viem';
import {
  getHolderCostBasis,
  calculateUnrealizedLossStats,
  getClaimableRewards,
  claimBatchRewards,
  getLossRewardPoolTVL,
  type HolderCostBasis,
  type UnrealizedLossStats,
  type ClaimableRewardsState,
} from '../../lib/lossReward';

type TokenData = {
  tokenName: string;
  tokenSymbol: string;
  description?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  initialLiquidity?: string;
  mintAddress?: string;
  chain?: 'evm';
};

type ChartPoint = {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isUp: boolean;
};

type TradeSide = 'buy' | 'sell';

type Trade = {
  id: string;
  time: string;

  timestamp: number;
  side: TradeSide;
  price: number;
  amountToken: number;
  amountSol: number;
  feeSol: number;
  signature?: string;
};

type Position = {
  tokens: number;
  investedSol: number;
  avgEntry: number;
  realizedPnl: number;
};

type CurveState = {
  virtualSolReserves: number;
  virtualTokenReserves: number;
  realSolReserves: number;
  initialVirtualTokenReserves: number;
  completed: boolean;
};

type PersistedMarketState = {
  version: 1;
  curve: CurveState;
  chartData: ChartPoint[];
  trades: Trade[];
  position: Position;
};

type Timeframe = '1m' | '5m' | '15m' | '1h';

type OnchainBalances = {
  walletSol: number;
  tokenBalance: number;
  loading: boolean;
};

type OnchainMintInfo = {
  decimals: number;
  symbol: string;
};
type FeedStatus = 'disconnected' | 'connecting' | 'live' | 'error';
type MarketSnapshot = {
  priceSol: number;
  liquiditySol: number;
  volume24hSol: number;
  marketCapUsd: number;
  fdvUsd: number;
  priceChange24hPct: number;
  updatedAt: number;
};
type LivePoolState = {
  priceEth: number;
  liquidityEth: number;
  updatedAt: number;
};
type TxPhase = 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error';

const TOTAL_SUPPLY = 1_000_000_000;
const CURVE_TOKENS = 800_000_000;
const TRADE_FEE_RATE = 0.01;
const MIN_BUY_SOL = 0.001;
const MIN_SELL_SOL_OUT = 0.0001;
// Fallback ETH/USD price used only if the live price fetch fails.
const FALLBACK_ETH_USD = 1840;

const formatNum = (value: number, digits = 4) => {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs < 0.0001) return '0';
  if (abs < 1) return value.toLocaleString(undefined, { maximumFractionDigits: digits });
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
};

const formatPercent = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) < 1) return '0';
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
};

const formatPrice = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 8,
    maximumFractionDigits: 10,
  });
};

const formatSol = (value: number) => {
  if (!Number.isFinite(value)) return '0';
  if (value === 0) return '0';
  if (value < 0.000001) return '<0.000001';
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
};

const formatTokenAmount = (value: number, decimals = 6) => {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toLocaleString(undefined, {
    maximumFractionDigits: Math.min(8, Math.max(2, decimals)),
  });
};

const formatCurrencyCompact = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return '<$0.01';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
};

const parseMetadataSymbol = (bytes: Uint8Array) => {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 1 + 32 + 32;
    const readStr = () => {
      if (offset + 4 > bytes.byteLength) return '';
      const len = view.getUint32(offset, true);
      offset += 4;
      if (offset + len > bytes.byteLength) return '';
      const value = new TextDecoder().decode(bytes.slice(offset, offset + len));
      offset += len;
      return value.replace(/\0/g, '').trim();
    };
    readStr(); // name
    const symbol = readStr();
    return symbol;
  } catch {
    return '';
  }
};

const normalizeLoadedChartData = (data: ChartPoint[]): ChartPoint[] => {
  if (!data.length) return data;

  const now = Date.now();
  const fallbackStart = now - data.length * 60_000;
  let lastTs = 0;

  return data.map((point, index) => {
    const rawTs = Number(point.timestamp);
    const safeTs = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : fallbackStart + index * 60_000;
    const ts = safeTs <= lastTs ? lastTs + 60_000 : safeTs;
    lastTs = ts;

    return {
      ...point,
      timestamp: ts,
      time: new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
  });
};

const aggregateCandles = (data: ChartPoint[], minutes: number): ChartPoint[] => {
  if (minutes <= 1) return data;
  const bucketMs = minutes * 60 * 1000;
  const buckets = new Map<number, ChartPoint[]>();

  for (const row of data) {
    const key = Math.floor(row.timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(key) || [];
    bucket.push(row);
    buckets.set(key, bucket);
  }

  const aggregated: ChartPoint[] = [];
  for (const [bucketTs, rows] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const high = Math.max(...rows.map((r) => r.high));
    const low = Math.min(...rows.map((r) => r.low));
    const volume = rows.reduce((sum, r) => sum + r.volume, 0);
    aggregated.push({
      time: new Date(bucketTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: bucketTs,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      isUp: last.close >= first.open,
    });
  }

  return aggregated.slice(-70);
};

const shortSig = (sig: string) => `${sig.slice(0, 8)}...${sig.slice(-8)}`;

const extractOwnerSolDelta = (tx: any, owner: string) => {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const ownerIndex = keys.findIndex((k: any) => {
    const key = typeof k === 'string' ? k : (k?.pubkey?.toString?.() ?? k?.toString?.() ?? '');
    return key === owner;
  });
  if (ownerIndex < 0) return 0;
  const pre = tx?.meta?.preBalances?.[ownerIndex] ?? 0;
  const post = tx?.meta?.postBalances?.[ownerIndex] ?? 0;
  return (post - pre) / 1_000_000_000;
};

const extractOwnerTokenDelta = (tx: any, owner: string, mint: string) => {
  const toAmount = (entry: any) =>
    Number(entry?.uiTokenAmount?.uiAmountString ?? entry?.uiTokenAmount?.uiAmount ?? 0) || 0;
  let pre = 0;
  let post = 0;

  for (const row of tx?.meta?.preTokenBalances ?? []) {
    if (row?.owner === owner && row?.mint === mint) pre += toAmount(row);
  }
  for (const row of tx?.meta?.postTokenBalances ?? []) {
    if (row?.owner === owner && row?.mint === mint) post += toAmount(row);
  }

  return post - pre;
};

const parseNumberLike = (...values: unknown[]) => {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return 0;
};

const parseLiveTrade = (payload: any, mint: string) => {
  const msg = payload?.data ?? payload;
  if (!msg || typeof msg !== 'object') return null;
  const eventMint = String(msg.mint ?? msg.token ?? msg.tokenAddress ?? msg.address ?? '').trim();
  if (eventMint && eventMint !== mint) return null;

  const rawSide = String(msg.txType ?? msg.side ?? msg.type ?? '').toLowerCase();
  const side: TradeSide =
    rawSide.includes('buy') || rawSide === 'b' ? 'buy' : rawSide.includes('sell') || rawSide === 's' ? 'sell' : 'buy';
  const signature = String(msg.signature ?? msg.txSignature ?? msg.txHash ?? msg.hash ?? '').trim();
  const amountSol = Math.abs(
    parseNumberLike(msg.solAmount, msg.sol_amount, msg.sol, msg.amountSol, msg.amount_sol)
  );
  const amountToken = Math.abs(
    parseNumberLike(msg.tokenAmount, msg.token_amount, msg.tokens, msg.amountToken, msg.amount_token)
  );
  const price = parseNumberLike(msg.priceSol, msg.price, msg.priceInSol, amountToken > 0 ? amountSol / amountToken : 0);
  const tsRaw = parseNumberLike(msg.timestamp, msg.blockTime, msg.time, Date.now());
  const timestamp = tsRaw > 1_000_000_000_000 ? tsRaw : tsRaw * 1000;

  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    side,
    signature: signature || undefined,
    amountSol,
    amountToken,
    price,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
  };
};

const parseHistoricalTrade = (row: any, fallbackPriceSol: number) => {
  const attrs = row?.attributes ?? {};
  const txHash = String(
    attrs?.tx_hash ?? attrs?.txHash ?? attrs?.transaction_hash ?? row?.id ?? ''
  ).trim();
  const rawSide = String(
    attrs?.kind ?? attrs?.side ?? attrs?.tx_type ?? attrs?.trade_type ?? ''
  ).toLowerCase();
  const side: TradeSide =
    rawSide.includes('sell') ? 'sell' : rawSide.includes('buy') ? 'buy' : 'buy';

  const amountToken = Math.abs(
    parseNumberLike(
      attrs?.base_token_amount,
      attrs?.token_amount,
      attrs?.amount_token,
      attrs?.from_token_amount,
      attrs?.to_token_amount
    )
  );
  const amountSol = Math.abs(
    parseNumberLike(
      attrs?.quote_token_amount,
      attrs?.sol_amount,
      attrs?.amount_sol,
      attrs?.from_quote_amount,
      attrs?.to_quote_amount
    )
  );
  const explicitPrice = parseNumberLike(
    attrs?.price_in_quote_token,
    attrs?.price_quote,
    attrs?.price,
    attrs?.price_native
  );
  const price =
    explicitPrice > 0
      ? explicitPrice
      : amountToken > 0 && amountSol > 0
        ? amountSol / amountToken
        : fallbackPriceSol;

  const tsSource =
    attrs?.block_timestamp ??
    attrs?.block_time ??
    attrs?.created_at ??
    attrs?.timestamp ??
    Date.now();
  const tsValue = Date.parse(String(tsSource));
  const timestamp = Number.isFinite(tsValue)
    ? tsValue
    : (() => {
        const raw = parseNumberLike(tsSource, Date.now());
        return raw > 1_000_000_000_000 ? raw : raw * 1000;
      })();

  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    id: txHash || `hist-${timestamp}`,
    time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp,
    side,
    price,
    amountToken: Math.max(0, amountToken),
    amountSol: Math.max(0, amountSol),
    feeSol: 0,
    signature: txHash || undefined,
  } as Trade;
};

const TradingViewChart = ({
  data,
  trades,
}: {
  data: ChartPoint[];
  trades: Trade[];
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markerApiRef = useRef<ReturnType<typeof createSeriesMarkers> | null>(null);
  const livePriceLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const didInitialFitRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        textColor: '#9CB0D4',
        background: { type: ColorType.Solid, color: '#0B1120' },
      },
      grid: {
        vertLines: { color: '#16243F' },
        horzLines: { color: '#16243F' },
      },
      rightPriceScale: {
        borderColor: '#233658',
      },
      timeScale: {
        borderColor: '#233658',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 14,
      },
      localization: {
        priceFormatter: (price: number) => formatPrice(price),
      },
      crosshair: {
        mode: 1,
        vertLine: {
          visible: true,
          color: '#2A4677',
          width: 1,
          labelBackgroundColor: '#1E355B',
        },
        horzLine: {
          visible: true,
          color: '#2A4677',
          width: 1,
          labelBackgroundColor: '#1E355B',
        },
      },
      handleScroll: true,
      handleScale: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#24D08E',
      downColor: '#F04452',
      borderVisible: false,
      wickUpColor: '#24D08E',
      wickDownColor: '#F04452',
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineWidth: 2,
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.82,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    markerApiRef.current = createSeriesMarkers(candleSeries, []);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !chartRef.current) return;
      chartRef.current.applyOptions({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markerApiRef.current = null;
      livePriceLineRef.current = null;
      didInitialFitRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    const bySecond = new Map<number, ChartPoint>();
    for (const point of data) {
      const second = Math.floor(point.timestamp / 1000);
      const existing = bySecond.get(second);
      if (!existing) {
        bySecond.set(second, point);
        continue;
      }

      // Merge same-second candles to avoid lightweight-charts time collisions.
      bySecond.set(second, {
        ...point,
        open: existing.open,
        high: Math.max(existing.high, point.high),
        low: Math.min(existing.low, point.low),
        close: point.close,
        volume: existing.volume + point.volume,
        isUp: point.close >= existing.open,
      });
    }

    const normalized = [...bySecond.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, point]) => point);

    const candles: CandlestickData[] = normalized.map((point) => ({
      time: Math.floor(point.timestamp / 1000) as UTCTimestamp,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
    }));

    const volumes: HistogramData[] = normalized.map((point) => ({
      time: Math.floor(point.timestamp / 1000) as UTCTimestamp,
      value: point.volume,
      color: point.isUp ? 'rgba(36, 208, 142, 0.45)' : 'rgba(240, 68, 82, 0.45)',
    }));

    try {
      candleSeriesRef.current.setData(candles);
      volumeSeriesRef.current.setData(volumes);
      if (!didInitialFitRef.current) {
        chartRef.current?.timeScale().fitContent();
        didInitialFitRef.current = true;
      } else {
        chartRef.current?.timeScale().scrollToRealTime();
      }

      if (candles.length > 0 && candleSeriesRef.current) {
        if (livePriceLineRef.current) {
          candleSeriesRef.current.removePriceLine(livePriceLineRef.current);
        }
        const last = candles[candles.length - 1];
        livePriceLineRef.current = candleSeriesRef.current.createPriceLine({
          price: last.close,
          color: last.close >= last.open ? '#24D08E' : '#F04452',
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Last',
        });
      }
    } catch (err) {
      console.error('Failed to render candlestick data:', err);
    }
  }, [data]);

  useEffect(() => {
    if (!markerApiRef.current) return;
    const markers: SeriesMarker<UTCTimestamp>[] = trades.slice(0, 80).map((trade) => ({
      time: Math.floor((trade.timestamp || Date.now()) / 1000) as UTCTimestamp,
      position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: trade.side === 'buy' ? '#24D08E' : '#F04452',
      shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: trade.side === 'buy' ? 'B' : 'S',
    }));
    markerApiRef.current.setMarkers(markers);
  }, [trades]);

  return <div ref={containerRef} className="h-[520px] w-full rounded-xl overflow-hidden" />;
};

const TokenPreviewPage = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [activeTab, setActiveTab] = useState<TradeSide>('buy');
  const [buyAmountSol, setBuyAmountSol] = useState('0.1');
  const [sellAmountToken, setSellAmountToken] = useState('');
  const [onchainBusy, setOnchainBusy] = useState(false);
  const [onchainBalances, setOnchainBalances] = useState<OnchainBalances>({
    walletSol: 0,
    tokenBalance: 0,
    loading: false,
  });
  const [onchainMintInfo, setOnchainMintInfo] = useState<OnchainMintInfo>({
    decimals: 18,
    symbol: '',
  });
  const [slippage, setSlippage] = useState(1);
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  const [status, setStatus] = useState('');
  const [txPhase, setTxPhase] = useState<TxPhase>('idle');
  const [txRetryCount, setTxRetryCount] = useState(0);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('disconnected');
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot | null>(null);
  const [livePoolState, setLivePoolState] = useState<LivePoolState | null>(null);
  const [primaryPoolAddress, setPrimaryPoolAddress] = useState('');
  const [indexerStale, setIndexerStale] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState('');
  const [contractCopied, setContractCopied] = useState(false);
  const [ethUsdPrice, setEthUsdPrice] = useState(FALLBACK_ETH_USD);

  useEffect(() => {
    let cancelled = false;
    const loadEthPrice = async () => {
      try {
        const response = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
        const body = await response.json();
        const price = Number(body?.data?.amount);
        if (!cancelled && Number.isFinite(price) && price > 0) setEthUsdPrice(price);
      } catch (err) {
        console.error('Failed to load live ETH/USD price:', err);
      }
    };
    loadEthPrice();
    const timer = setInterval(loadEthPrice, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const [curve, setCurve] = useState<CurveState>({
    virtualSolReserves: 30,
    virtualTokenReserves: CURVE_TOKENS,
    realSolReserves: 0.2,
    initialVirtualTokenReserves: CURVE_TOKENS,
    completed: false,
  });
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stateHydrated, setStateHydrated] = useState(false);
  const [usingSharedState, setUsingSharedState] = useState(false);
  const [position, setPosition] = useState<Position>({
    tokens: 0,
    investedSol: 0,
    avgEntry: 0,
    realizedPnl: 0,
  });
  const seenTradeSignaturesRef = useRef<Set<string>>(new Set());

  // Incentifi Loss-Reward state
  const [costBasisData, setCostBasisData] = useState<HolderCostBasis | null>(null);
  const [claimableState, setClaimableState] = useState<ClaimableRewardsState>({ unclaimedEpochs: [], totalClaimableEth: 0 });
  const [lossPoolTvl, setLossPoolTvl] = useState<number>(0);
  const [claiming, setClaiming] = useState(false);
  const [claimSuccessMsg, setClaimSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadLossRewardData = async () => {
      const wallet = getWalletAccount();
      if (!tokenData?.mintAddress) return;

      try {
        const [tvl, costBasis, claimable] = await Promise.all([
          getLossRewardPoolTVL(tokenData.mintAddress),
          wallet ? getHolderCostBasis(tokenData.mintAddress, wallet) : null,
          wallet ? getClaimableRewards(tokenData.mintAddress, wallet) : { unclaimedEpochs: [], totalClaimableEth: 0 },
        ]);

        if (!cancelled) {
          setLossPoolTvl(tvl);
          if (costBasis) setCostBasisData(costBasis);
          setClaimableState(claimable);
        }
      } catch (err) {
        console.error('Failed to load loss-reward data:', err);
      }
    };

    loadLossRewardData();
    const interval = setInterval(loadLossRewardData, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tokenData?.mintAddress, onchainBalances.tokenBalance]);

  const lossStats = useMemo(() => {
    const currentPrice = livePoolState ? livePoolState.priceEth : 0;
    return calculateUnrealizedLossStats(costBasisData, currentPrice);
  }, [costBasisData, livePoolState]);

  const handleClaimRewards = async () => {
    const wallet = getWalletAccount();
    if (!wallet || !tokenData?.mintAddress || claimableState.unclaimedEpochs.length === 0) return;

    try {
      setClaiming(true);
      setClaimSuccessMsg(null);
      const txHash = await claimBatchRewards(tokenData.mintAddress, wallet, claimableState.unclaimedEpochs);
      setClaimSuccessMsg(`Claimed ${claimableState.totalClaimableEth.toFixed(4)} ETH!`);
      setClaimableState({ unclaimedEpochs: [], totalClaimableEth: 0 });
      await refreshOnchainBalances();
    } catch (err: any) {
      console.error('Claim failed:', err);
      setStatus(describeError(err));
    } finally {
      setClaiming(false);
    }
  };

  useEffect(() => {
    const loadToken = async () => {
      const pathParts = location.pathname.split('/');
      const symbolFromUrl = pathParts[pathParts.length - 1].toUpperCase();

      const saved = localStorage.getItem('previewToken');
      if (saved) {
        const parsed = JSON.parse(saved) as TokenData;
        if (parsed.tokenSymbol === symbolFromUrl) {
          setTokenData(parsed);
          setLoading(false);
          return;
        }
      }

      try {
        const { data, error } = await supabase
          .from('tokens')
          .select('*')
          .eq('symbol', symbolFromUrl)
          .limit(1);

        if (error) throw new Error(error.message);

        if (data && data.length > 0) {
          const first = data[0] as {
            name?: string;
            symbol?: string;
            description?: string;
            image_url?: string;
            website?: string;
            twitter?: string;
            telegram?: string;
            mint_address?: string;
          };
          setTokenData({
            tokenName: first.name || symbolFromUrl,
            tokenSymbol: first.symbol || symbolFromUrl,
            description: first.description || '',
            imageUrl: first.image_url || '',
            website: first.website || '',
            twitter: first.twitter || '',
            telegram: first.telegram || '',
            initialLiquidity: '0.1',
            mintAddress: first.mint_address || '',
            chain: 'evm',
          });
          setLoading(false);
          return;
        }
      } catch (err) {
        console.error('Failed to load token data:', err);
      }

      navigate('/launch');
    };

    loadToken();
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (!tokenData) return;
    setStateHydrated(false);
    setUsingSharedState(false);
    setMarketSnapshot(null);
    setLivePoolState(null);
    setPrimaryPoolAddress('');

    const hydrateInitialState = () => {
      const initialLiquidity = parseFloat(tokenData.initialLiquidity || '0.1') * 2;
      const initialVirtualSol = Math.max(30, initialLiquidity * 100);
      const initialCurve: CurveState = {
        virtualSolReserves: initialVirtualSol,
        virtualTokenReserves: CURVE_TOKENS,
        realSolReserves: initialLiquidity,
        initialVirtualTokenReserves: CURVE_TOKENS,
        completed: false,
      };
      setCurve(initialCurve);
      setChartData([]);
      setTrades([]);
      seenTradeSignaturesRef.current.clear();
      setPosition({
        tokens: 0,
        investedSol: 0,
        avgEntry: 0,
        realizedPnl: 0,
      });
      setStateHydrated(true);
    };

    hydrateInitialState();
  }, [tokenData]);

  const chartPriceSol = useMemo(() => {
    if (chartData.length > 0) {
      const latest = chartData[chartData.length - 1]?.close;
      if (Number.isFinite(latest) && latest > 0) return latest;
    }
    return curve.virtualSolReserves / Math.max(curve.virtualTokenReserves, 1);
  }, [chartData, curve.virtualSolReserves, curve.virtualTokenReserves]);

  const isEvmToken = Boolean(tokenData);
  const priceSol = useMemo(() => {
    if (isEvmToken) return livePoolState?.priceEth || 0;
    return marketSnapshot?.priceSol && marketSnapshot.priceSol > 0 ? marketSnapshot.priceSol : chartPriceSol;
  }, [isEvmToken, livePoolState?.priceEth, marketSnapshot?.priceSol, chartPriceSol]);
  const marketCapUsd = useMemo(() => {
    if (!isEvmToken && marketSnapshot?.marketCapUsd && marketSnapshot.marketCapUsd > 0) return marketSnapshot.marketCapUsd;
    return priceSol * TOTAL_SUPPLY * ethUsdPrice;
  }, [isEvmToken, marketSnapshot?.marketCapUsd, priceSol, ethUsdPrice]);
  const marketCapSol = useMemo(() => marketCapUsd / ethUsdPrice, [marketCapUsd, ethUsdPrice]);
  const liquiditySol = useMemo(
    () => {
      if (isEvmToken) return livePoolState?.liquidityEth || 0;
      return marketSnapshot?.liquiditySol && marketSnapshot.liquiditySol > 0
        ? marketSnapshot.liquiditySol
        : curve.realSolReserves;
    },
    [isEvmToken, livePoolState?.liquidityEth, marketSnapshot?.liquiditySol, curve.realSolReserves]
  );
  const totalVolumeSol = useMemo(() => {
    if (marketSnapshot?.volume24hSol && marketSnapshot.volume24hSol > 0) {
      return marketSnapshot.volume24hSol;
    }
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return trades.filter((t) => t.timestamp >= dayAgo).reduce((sum, t) => sum + t.amountSol, 0);
  }, [marketSnapshot?.volume24hSol, trades]);
  const liquidityUsd = useMemo(() => liquiditySol * ethUsdPrice, [liquiditySol, ethUsdPrice]);
  const totalFeesSol = useMemo(
    () => trades.reduce((sum, t) => sum + t.feeSol, 0),
    [trades]
  );
  const progressPct = useMemo(() => {
    const sold = curve.initialVirtualTokenReserves - curve.virtualTokenReserves;
    return Math.max(0, Math.min(100, (sold / curve.initialVirtualTokenReserves) * 100));
  }, [curve.initialVirtualTokenReserves, curve.virtualTokenReserves]);
  const athMcapUsd = useMemo(() => {
    if (!isEvmToken && marketSnapshot?.fdvUsd && marketSnapshot.fdvUsd > 0) {
      return Math.max(marketSnapshot.fdvUsd, marketCapUsd);
    }
    const highest = chartData.reduce((max, p) => Math.max(max, p.high), 0);
    const fromHistory = highest * TOTAL_SUPPLY * ethUsdPrice;
    return Math.max(fromHistory, marketCapUsd);
  }, [isEvmToken, marketSnapshot?.fdvUsd, chartData, marketCapUsd, ethUsdPrice]);
  const mcap24hDeltaPct = useMemo(() => {
    if (!isEvmToken && marketSnapshot && Number.isFinite(marketSnapshot.priceChange24hPct)) {
      return marketSnapshot.priceChange24hPct;
    }
    if (chartData.length < 2) return 0;
    const first = chartData[Math.max(0, chartData.length - 25)]?.close || chartData[0].close;
    const last = chartData[chartData.length - 1].close;
    if (!first) return 0;
    return ((last - first) / first) * 100;
  }, [isEvmToken, marketSnapshot, chartData]);
  const displaySymbol = onchainMintInfo.symbol || tokenData?.tokenSymbol || '';

  useEffect(() => {
    if (!isEvmToken || !tokenData?.mintAddress) return;
    let cancelled = false;
    const loadLivePoolState = async () => {
      try {
        const pool = await getPoolMarketState(tokenData.mintAddress);
        if (cancelled) return;
        setPrimaryPoolAddress(pool.poolAddress);
        setLivePoolState({
          priceEth: pool.priceEth,
          liquidityEth: pool.liquidityEth,
          updatedAt: Date.now(),
        });
      } catch (err) {
        console.error('Failed to load live pool state:', err);
        if (!cancelled) {
          setPrimaryPoolAddress('');
          setLivePoolState(null);
        }
      }
    };
    loadLivePoolState();
    const timer = setInterval(loadLivePoolState, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isEvmToken, tokenData?.mintAddress]);

  useEffect(() => {
    if (!tokenData?.tokenSymbol) return;
    let cancelled = false;

    const loadChat = async () => {
      try {
        const messages = await fetchChatMessages(tokenData.tokenSymbol);
        if (!cancelled) setChatMessages(messages);
      } catch (err) {
        console.error('Failed to load chat messages:', err);
      }
    };

    loadChat();
    const timer = setInterval(loadChat, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tokenData?.tokenSymbol]);

  const submitChatMessage = async () => {
    const trader = getWalletAccount();
    if (!trader) {
      setChatError('Connect wallet to chat.');
      return;
    }
    if (!chatInput.trim()) return;
    if (!tokenData?.tokenSymbol) return;

    try {
      setChatSending(true);
      setChatError('');
      await postChatMessage(tokenData.tokenSymbol, trader, chatInput);
      setChatInput('');
      const messages = await fetchChatMessages(tokenData.tokenSymbol);
      setChatMessages(messages);
    } catch (err) {
      console.error('Failed to post chat message:', err);
      setChatError(describeError(err));
    } finally {
      setChatSending(false);
    }
  };

  useEffect(() => {
    if (!isEvmToken || !tokenData?.mintAddress) return;
    const trader = getWalletAccount();
    const provider = getEvmProvider();
    if (!trader || !provider) return;

    let cancelled = false;
    const loadBalances = async () => {
      try {
        const balanceData = encodeFunctionData({
          abi: parseAbi(['function balanceOf(address account) view returns (uint256)']),
          functionName: 'balanceOf',
          args: [getAddress(trader)],
        });
        const [tokenBalanceHex, weiBalanceHex] = await Promise.all([
          provider.request({
            method: 'eth_call',
            params: [{ to: tokenData.mintAddress, data: balanceData }, 'latest'],
          }),
          provider.request({ method: 'eth_getBalance', params: [trader, 'latest'] }),
        ]);
        if (cancelled) return;
        const tokenBalance = Number(BigInt(tokenBalanceHex)) / 1e18;
        const walletSol = Number(BigInt(weiBalanceHex)) / 1e18;
        setOnchainBalances({ walletSol, tokenBalance, loading: false });
        setPosition((prev) => ({ ...prev, tokens: tokenBalance }));
      } catch (err) {
        console.error('Failed to load initial on-chain balances:', err);
      }
    };

    loadBalances();
    return () => {
      cancelled = true;
    };
  }, [isEvmToken, tokenData?.mintAddress]);

  useEffect(() => {
    if (!isEvmToken || !tokenData) return;
    setOnchainMintInfo({
      decimals: 18,
      symbol: tokenData.tokenSymbol,
    });
  }, [isEvmToken, tokenData]);

  const getInitials = (symbol: string) => symbol.slice(0, 3).toUpperCase();

  const appendConfirmedTradePoint = (nextPrice: number, volumeSol: number, tsMs: number) => {
    setChartData((prev) => {
      const lastClose = prev.length > 0 ? prev[prev.length - 1].close : nextPrice;
      const open = lastClose;
      const close = nextPrice;
      const high = Math.max(open, close) * 1.004;
      const low = Math.min(open, close) * 0.996;
      const point: ChartPoint = {
        time: new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: tsMs,
        open,
        high,
        low,
        close,
        volume: Math.max(0, volumeSol),
        isUp: close >= open,
      };
      return [...prev.slice(-60), point];
    });
  };

  const pushTrade = (trade: Trade) => {
    setTrades((prev) => {
      if (trade.signature) {
        if (seenTradeSignaturesRef.current.has(trade.signature)) return prev;
        seenTradeSignaturesRef.current.add(trade.signature);
        if (seenTradeSignaturesRef.current.size > 700) {
          const recent = new Set(prev.slice(0, 120).map((t) => t.signature).filter(Boolean) as string[]);
          seenTradeSignaturesRef.current = recent;
        }
      }
      return [trade, ...prev.slice(0, 79)];
    });
  };

  const ingestConfirmedExecution = async ({
    signature,
    side,
    fallbackSol,
    fallbackTokens,
  }: {
    signature: string;
    side: TradeSide;
    fallbackSol: number;
    fallbackTokens: number;
  }) => {
    // EVM trading implementation not present in this UI yet.
    // For now, indicate trading is unsupported for live ingestion.
    throw new Error('Robinhood Chain trading ingestion not implemented.');
  };

  const displayedChartData = useMemo(() => {
    const tf = timeframe === '1m' ? 1 : timeframe === '5m' ? 5 : timeframe === '15m' ? 15 : 60;
    return aggregateCandles(chartData, tf);
  }, [chartData, timeframe]);

  const tokenInputStep = useMemo(() => {
    const decimals = Math.max(0, Math.min(9, onchainMintInfo.decimals));
    return decimals === 0 ? '1' : `0.${'0'.repeat(decimals - 1)}1`;
  }, [onchainMintInfo.decimals]);

  const sellQuote = useMemo(() => {
    const amount = Number(sellAmountToken);
    if (!Number.isFinite(amount) || amount <= 0 || amount > position.tokens) {
      return { netSolOut: 0, feeSol: 0, valid: false };
    }
    const grossSolOut = amount * priceSol;
    const feeSol = grossSolOut * TRADE_FEE_RATE;
    const netSolOut = grossSolOut - feeSol;
    const valid = netSolOut >= MIN_SELL_SOL_OUT;
    return { netSolOut, feeSol, valid };
  }, [sellAmountToken, position.tokens, priceSol]);

  useEffect(() => {
    if (!tokenData || !stateHydrated) return;
    let cancelled = false;

    const loadIndexedState = async () => {
      try {
        const symbol = tokenData.tokenSymbol.toUpperCase();
        const [indexedSnapshot, indexedCandles, indexedTrades, heartbeat] = await Promise.all([
          fetchIndexedSnapshot(symbol),
          fetchIndexedCandles(symbol, 140),
          fetchIndexedTrades(symbol, 120),
          fetchIndexerHeartbeat(symbol),
        ]);
        if (cancelled) return;
        if (heartbeat) {
          const ageMs = Date.now() - heartbeat.updatedAt;
          const stale = ageMs > 120_000 || heartbeat.status === 'error';
          setIndexerStale(stale);
          if (stale) {
            setStatus(
              heartbeat.status === 'error'
                ? `Indexer error: ${heartbeat.message || 'check worker logs'}`
                : 'Indexer data is stale. Last update is older than 2 minutes.'
            );
          }
        }

        if (indexedSnapshot) {
          setMarketSnapshot({
            priceSol: indexedSnapshot.priceSol,
            liquiditySol: indexedSnapshot.liquiditySol,
            volume24hSol: indexedSnapshot.volume24hSol,
            marketCapUsd: indexedSnapshot.marketCapUsd,
            fdvUsd: indexedSnapshot.fdvUsd,
            priceChange24hPct: indexedSnapshot.priceChange24hPct,
            updatedAt: indexedSnapshot.updatedAt,
          });
        }

        if (indexedCandles.length > 0) {
          setChartData((prev) => {
            const byMinute = new Map<number, ChartPoint>();
            for (const row of prev) {
              byMinute.set(Math.floor(row.timestamp / 60_000), row);
            }
            for (const row of indexedCandles) {
              const bucket = Math.floor(row.timestamp / 60_000);
              byMinute.set(bucket, {
                time: new Date(row.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
                timestamp: row.timestamp,
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volumeSol,
                isUp: row.close >= row.open,
              });
            }
            return [...byMinute.values()]
              .sort((a, b) => a.timestamp - b.timestamp)
              .slice(-160);
          });
        }

        if (indexedTrades.length > 0) {
          setTrades((prev) => {
            const existing = new Map<string, Trade>();
            for (const trade of prev) {
              existing.set(trade.id, trade);
              if (trade.signature) seenTradeSignaturesRef.current.add(trade.signature);
            }
            for (const trade of indexedTrades) {
              if (trade.signature && seenTradeSignaturesRef.current.has(trade.signature)) continue;
              if (trade.signature) seenTradeSignaturesRef.current.add(trade.signature);
              existing.set(trade.id, {
                id: trade.id,
                time: new Date(trade.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
                timestamp: trade.timestamp,
                side: trade.side,
                price: trade.priceSol,
                amountToken: trade.amountToken,
                amountSol: trade.amountSol,
                feeSol: trade.feeSol,
                signature: trade.signature,
              });
            }
            return [...existing.values()]
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, 120);
          });
        }
      } catch (err) {
        console.error('Failed to load indexed market state:', err);
      }
    };

    loadIndexedState();
    const timer = setInterval(loadIndexedState, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tokenData, stateHydrated, isEvmToken]);

  useEffect(() => {
    if (!isEvmToken || !primaryPoolAddress || !tokenData?.mintAddress) {
      setFeedStatus('disconnected');
      return;
    }

    let cancelled = false;
    const loadPoolHistory = async () => {
      setFeedStatus('connecting');
      try {
        const { trades: poolTrades, candles } = await fetchPoolHistory(
          primaryPoolAddress,
          tokenData.mintAddress as string,
          onchainMintInfo.decimals || 18
        );
        if (cancelled) return;

        setChartData(
          candles.map((c) => ({
            time: new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            timestamp: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            isUp: c.close >= c.open,
          }))
        );

        setTrades(
          poolTrades.map((t) => ({
            id: t.id,
            time: new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            timestamp: t.timestamp,
            side: t.side,
            price: t.priceEth,
            amountToken: t.tokenAmount,
            amountSol: t.ethAmount,
            feeSol: 0,
            signature: t.txHash,
          }))
        );

        setFeedStatus('live');
      } catch (err) {
        console.error('Failed to load pool trade history:', err);
        if (!cancelled) setFeedStatus('error');
      }
    };

    loadPoolHistory();
    const timer = setInterval(loadPoolHistory, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isEvmToken, primaryPoolAddress, tokenData?.mintAddress, onchainMintInfo.decimals]);


  if (loading || !tokenData) {
    return (
      <div className="min-h-screen bg-[#0E1518] flex items-center justify-center">
        <p className="text-[#9FA6A3]">Loading token...</p>
      </div>
    );
  }

  const submitBuy = async () => {
    const trader = getWalletAccount();
    if (!trader) {
      setStatus('Connect wallet first.');
      return;
    }
    const ethIn = Number(buyAmountSol);
    if (!Number.isFinite(ethIn) || ethIn <= 0) {
      setStatus('Enter a valid ETH amount.');
      return;
    }
    if (!tokenData?.mintAddress) {
      setStatus('No contract address found for this token.');
      return;
    }
    try {
      setOnchainBusy(true);
      setTxPhase('signing');
      const result = await buyToken(tokenData.mintAddress, trader, ethIn, slippage);
      const timestamp = Date.now();
      if (result.trade.side !== 'buy') {
        throw new Error('Transaction confirmed, but the pool reported a sell instead of a buy. Check the transaction before retrying.');
      }
      pushTrade({
        id: result.txHash,
        signature: result.txHash,
        time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp,
        side: result.trade.side,
        price: result.trade.priceEth,
        amountToken: result.trade.amountToken,
        amountSol: result.trade.amountEth,
        feeSol: 0,
      });
      appendConfirmedTradePoint(result.trade.priceEth, result.trade.amountEth, timestamp);
      const pool = await getPoolMarketState(tokenData.mintAddress);
      setPrimaryPoolAddress(pool.poolAddress);
      setLivePoolState({ priceEth: pool.priceEth, liquidityEth: pool.liquidityEth, updatedAt: Date.now() });
      setTxPhase('success');
      setStatus(`Buy confirmed (${shortSig(result.txHash)}).`);
      await refreshOnchainBalances();
    } catch (err) {
      console.error('Buy failed:', err);
      setTxPhase('error');
      setStatus(describeError(err));
    } finally {
      setOnchainBusy(false);
    }
  };

  const submitSell = async () => {
    const trader = getWalletAccount();
    if (!trader) {
      setStatus('Connect wallet first.');
      return;
    }
    const amount = Number(sellAmountToken);
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus('Enter a valid token amount.');
      return;
    }
    if (!tokenData?.mintAddress) {
      setStatus('No contract address found for this token.');
      return;
    }
    try {
      setOnchainBusy(true);
      setTxPhase('signing');
      const result = await sellToken(
        tokenData.mintAddress,
        trader,
        amount,
        onchainMintInfo.decimals,
        slippage
      );
      const timestamp = Date.now();
      if (result.trade.side !== 'sell') {
        throw new Error('Transaction confirmed, but the pool reported a buy instead of a sell. Check the transaction before retrying.');
      }
      pushTrade({
        id: result.txHash,
        signature: result.txHash,
        time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp,
        side: result.trade.side,
        price: result.trade.priceEth,
        amountToken: result.trade.amountToken,
        amountSol: result.trade.amountEth,
        feeSol: 0,
      });
      appendConfirmedTradePoint(result.trade.priceEth, result.trade.amountEth, timestamp);
      const pool = await getPoolMarketState(tokenData.mintAddress);
      setPrimaryPoolAddress(pool.poolAddress);
      setLivePoolState({ priceEth: pool.priceEth, liquidityEth: pool.liquidityEth, updatedAt: Date.now() });
      setTxPhase('success');
      setStatus(`Sell confirmed (${shortSig(result.txHash)}).`);
      setSellAmountToken('');
      await refreshOnchainBalances();
    } catch (err) {
      console.error('Sell failed:', err);
      setTxPhase('error');
      setStatus(describeError(err));
    } finally {
      setOnchainBusy(false);
    }
  };

  const quickBuy = (amount: number) => setBuyAmountSol(String(amount));
  const refreshOnchainBalances = async () => {
    const trader = getWalletAccount();
    const provider = getEvmProvider();
    if (!trader || !provider || !tokenData?.mintAddress) return;

    try {
      setOnchainBalances((prev) => ({ ...prev, loading: true }));

      const balanceData = encodeFunctionData({
        abi: parseAbi(['function balanceOf(address account) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [getAddress(trader)],
      });

      const [tokenBalanceHex, weiBalanceHex] = await Promise.all([
        provider.request({
          method: 'eth_call',
          params: [{ to: tokenData.mintAddress, data: balanceData }, 'latest'],
        }),
        provider.request({ method: 'eth_getBalance', params: [trader, 'latest'] }),
      ]);

      const tokenBalance = Number(BigInt(tokenBalanceHex)) / 10 ** onchainMintInfo.decimals;
      const walletSol = Number(BigInt(weiBalanceHex)) / 1e18;

      setOnchainBalances({ walletSol, tokenBalance, loading: false });
      setPosition((prev) => ({ ...prev, tokens: tokenBalance }));
    } catch (err) {
      console.error('Failed to refresh on-chain balances:', err);
      setOnchainBalances((prev) => ({ ...prev, loading: false }));
    }
  };
  const normalizeTokenInput = (raw: string) => {
    if (!raw) return '';
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) return '';
    const decimals = Math.max(0, Math.min(9, onchainMintInfo.decimals));
    const fixed = num.toFixed(decimals);
    return decimals > 0 ? fixed.replace(/\.?0+$/, '') : String(Math.floor(num));
  };
  const formatInputAmount = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return '';
    const decimals = Math.max(0, Math.min(9, onchainMintInfo.decimals));
    return normalizeTokenInput(value.toFixed(decimals));
  };
  const quickSellPct = (pct: number) => {
    if (position.tokens <= 0) return;
    setSellAmountToken(formatInputAmount(position.tokens * (pct / 100)));
  };
  const setMaxSell = () => {
    if (position.tokens <= 0) return;
    setSellAmountToken(formatInputAmount(position.tokens));
  };

  return (
    <div className="min-h-screen bg-[#070A12]">
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#0B1120]/95 backdrop-blur border-b border-[#1D2940]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="h-16 sm:h-20 flex items-center justify-between">
            <Link to="/" className="flex items-center gap-3">
              <img
                src="/incentifi-logo.jpeg"
                alt="incentifi"
                className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg"
              />
              <span className="brand-type text-[#E8EEF9] font-semibold text-lg sm:text-xl">incentifi</span>
            </Link>
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="pt-20 sm:pt-24">
        <section className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-[#9FB0CF] hover:text-white transition-colors"
          >
            <i className="ri-arrow-left-line"></i>
            Back to Market
          </Link>
        </section>

        <section className="max-w-7xl mx-auto px-4 sm:px-6 pb-12">
          <div className="mb-6 p-4 sm:p-6 rounded-2xl bg-[#0B1120] border border-[#1D2940]">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex items-center gap-4">
                {tokenData.imageUrl ? (
                  <img
                    src={tokenData.imageUrl}
                    alt={tokenData.tokenName}
                    className="w-14 h-14 rounded-xl object-cover border border-[#2A3D66]"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-[#00C2FF] to-[#006DFF] flex items-center justify-center text-white font-bold">
                    {getInitials(tokenData.tokenSymbol)}
                  </div>
                )}
                <div>
                  <h1 className="text-xl sm:text-2xl font-semibold text-[#E8EEF9]">
                    {tokenData.tokenName}{' '}
                    <span className="text-[#53B8FF]">${displaySymbol}</span>
                  </h1>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {tokenData.website && (
                      <a
                        href={tokenData.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#10192C] border border-[#1D2940] px-2.5 py-1.5 text-xs text-[#9FB0CF] hover:text-white transition-colors"
                      >
                        <i className="ri-global-line"></i>
                        Website
                      </a>
                    )}
                    {primaryPoolAddress && (
                      <a
                        href={`https://dexscreener.com/robinhood/${primaryPoolAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#10192C] border border-[#1D2940] px-2.5 py-1.5 text-xs text-[#9FB0CF] hover:text-white transition-colors"
                      >
                        <i className="ri-line-chart-line"></i>
                        Dexscreener
                      </a>
                    )}
                    {tokenData.mintAddress && (
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(tokenData.mintAddress as string);
                          setContractCopied(true);
                          setTimeout(() => setContractCopied(false), 2000);
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                          contractCopied
                            ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                            : 'bg-[#10192C] border-[#1D2940] text-[#9FB0CF] hover:text-white'
                        }`}
                      >
                        <i className={contractCopied ? 'ri-check-line' : 'ri-file-copy-line'}></i>
                        {contractCopied ? 'Copied!' : 'Contract'}
                      </button>
                    )}
                    {primaryPoolAddress && (
                      <a
                        href={EVM_ADDRESS_URL(primaryPoolAddress)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#10192C] border border-[#1D2940] px-2.5 py-1.5 text-xs text-[#9FB0CF] hover:text-white transition-colors"
                      >
                        <i className="ri-link"></i>
                        Pool
                      </a>
                    )}
                  </div>
                  <div className="mt-3">
                    <p className="text-xs text-[#8DA3CD] uppercase tracking-wide">Live Market Cap</p>
                    <p className="text-3xl sm:text-4xl font-bold text-white">
                      {livePoolState ? formatCurrencyCompact(marketCapUsd) : 'Awaiting pool'}
                    </p>
                    <div className="flex items-center gap-3 mt-2">
                      <p className={`text-sm ${mcap24hDeltaPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {mcap24hDeltaPct >= 1 ? '+' : ''}{formatPercent(mcap24hDeltaPct, 2)}% 24h
                      </p>
                      <div className="flex-1 h-2 rounded-full bg-[#22314F] overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-[#5DA6FF] to-[#67E8A5]"
                          style={{ width: `${Math.max(8, Math.min(100, (marketCapUsd / Math.max(athMcapUsd, 1)) * 100))}%` }}
                        ></div>
                      </div>
                      <p className="text-sm text-[#9FB0CF]">
                        ATH <span className="text-white font-semibold">{formatCurrencyCompact(athMcapUsd)}</span>
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <span className="px-2.5 py-1 rounded-md bg-[#10192C] text-[#93A9CF]">
                        {primaryPoolAddress ? 'Live Uniswap V3 pool' : 'Awaiting live pool'}
                    </span>
                    {livePoolState && liquidityUsd < 50 && (
                      <span className="px-2.5 py-1 rounded-md bg-amber-400/10 text-amber-300 border border-amber-400/20">
                        Very low liquidity: price is highly unstable
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl px-3 py-2">
                  <p className="text-[#7D92BC]">Live Liquidity</p>
                  <p className="text-[#E8EEF9] font-semibold">
                    {livePoolState ? formatCurrencyCompact(liquidityUsd) : 'Awaiting pool'}
                  </p>
                </div>
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl px-3 py-2">
                  <p className="text-[#7D92BC]">24h Volume</p>
                  <p className="text-[#E8EEF9] font-semibold">
                    {totalVolumeSol > 0 ? `${formatSol(totalVolumeSol)} ${EVM_NATIVE_SYMBOL}` : 'No trades yet'}
                  </p>
                </div>
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl px-3 py-2">
                  <p className="text-[#7D92BC]">24h Change</p>
                  <p className={`font-semibold ${mcap24hDeltaPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {mcap24hDeltaPct >= 1 ? '+' : ''}{formatPercent(mcap24hDeltaPct, 2)}%
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
            <div className="space-y-6">
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-[#E8EEF9] font-semibold">Price Chart</h2>
                  <span className="text-xs text-[#8A9CC2]">Live from Dexscreener</span>
                </div>
                {primaryPoolAddress ? (
                  <iframe
                    key={primaryPoolAddress}
                    src={`https://dexscreener.com/robinhood/${primaryPoolAddress}?embed=1&theme=dark&trades=0&info=0`}
                    className="h-[520px] w-full rounded-xl border-0"
                    title="Dexscreener chart"
                  />
                ) : (
                  <div className="h-[520px] w-full rounded-xl bg-[#070A12] flex items-center justify-center text-sm text-[#8A9CC2]">
                    Loading pool...
                  </div>
                )}
              </div>

              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-6">
                <h2 className="text-[#E8EEF9] font-semibold mb-4">Recent Trades</h2>
                {trades.length === 0 ? (
                  <p className="text-sm text-[#8A9CC2]">
                    {isEvmToken
                      ? 'Trading is live on the locked Uniswap V3 pool. This feed isn\'t wired up to show past trades yet - check Dexscreener above for live trade history.'
                      : 'No trades yet. Place the first trade.'}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[#7D92BC] border-b border-[#16243F]">
                          <th className="py-2 pr-3">Time</th>
                          <th className="py-2 pr-3">Side</th>
                          <th className="py-2 pr-3">Price</th>
                          <th className="py-2 pr-3">Amount</th>
                          <th className="py-2 pr-3">{isEvmToken ? EVM_NATIVE_SYMBOL : 'SOL'}</th>
                          <th className="py-2 pr-3">Fee</th>
                          <th className="py-2 pr-3">Tx</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trades.map((trade) => (
                          <tr key={trade.id} className="border-b border-[#121C31] text-[#D4E1F7]">
                            <td className="py-2 pr-3">{trade.time}</td>
                            <td
                              className={`py-2 pr-3 font-medium ${
                                trade.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'
                              }`}
                            >
                              {trade.side.toUpperCase()}
                            </td>
                            <td className="py-2 pr-3">{formatPrice(trade.price)}</td>
                            <td className="py-2 pr-3">{formatTokenAmount(trade.amountToken)}</td>
                            <td className="py-2 pr-3">{formatSol(trade.amountSol)}</td>
                            <td className="py-2 pr-3">{formatSol(trade.feeSol)}</td>
                            <td className="py-2 pr-3">
                              {trade.signature ? (
                                <a
                                  href={EVM_TX_URL(trade.signature)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[#7EC8FF] hover:text-white"
                                >
                                  {shortSig(trade.signature)}
                                </a>
                              ) : (
                                <span className="text-[#6079A6]">-</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-6">
                <h2 className="text-[#E8EEF9] font-semibold mb-1">Chat</h2>
                <p className="text-xs text-[#7D92BC] mb-4">Connected wallets can post. Be nice.</p>
                <div className="max-h-80 overflow-y-auto space-y-3 pr-1">
                  {chatMessages.length === 0 ? (
                    <p className="text-sm text-[#8A9CC2]">No messages yet. Be the first to say something.</p>
                  ) : (
                    chatMessages.map((msg) => (
                      <div key={msg.id} className="text-sm">
                        <span className="text-[#7EC8FF] font-medium">
                          {msg.walletAddress.slice(0, 6)}...{msg.walletAddress.slice(-4)}
                        </span>{' '}
                        <span className="text-[#D4E1F7] break-words">{msg.message}</span>
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-4 flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitChatMessage();
                    }}
                    maxLength={500}
                    placeholder="Say something..."
                    className="flex-1 px-4 py-2.5 rounded-xl bg-[#081122] border border-[#1D2940] text-[#E8EEF9] placeholder-[#5F6A6E] focus:outline-none focus:border-[#36BCFF] text-sm"
                  />
                  <button
                    onClick={submitChatMessage}
                    disabled={chatSending || !chatInput.trim()}
                    className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Send
                  </button>
                </div>
                {chatError && <p className="text-xs text-rose-400 mt-2">{chatError}</p>}
              </div>
            </div>

            <aside className="lg:sticky lg:top-24 h-fit space-y-4">
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-5">
                <div className="mb-4">
                  <p className="text-xs text-[#7D92BC] mb-2">Execution</p>
                  <p className="text-[11px] text-[#8EA6D1] mt-2">
                    Network: <span className="uppercase">{EVM_CHAIN_NAME}</span>. Trades execute directly against the token's locked Uniswap V3 pool.
                  </p>
                  {tokenData.mintAddress && (
                    <a
                      href={EVM_ADDRESS_URL(tokenData.mintAddress)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex text-[11px] font-semibold text-[#7EC8FF] hover:text-white"
                    >
                      View contract
                    </a>
                  )}
                </div>

                {(
                  <>
                    <div className="grid grid-cols-2 bg-[#081122] p-1 rounded-xl mb-4">
                      <button
                        onClick={() => setActiveTab('buy')}
                        className={`py-2 rounded-lg text-sm font-semibold transition ${
                          activeTab === 'buy'
                            ? 'bg-emerald-500 text-white'
                            : 'text-[#7D92BC] hover:text-[#D4E1F7]'
                        }`}
                      >
                        Buy
                      </button>
                      <button
                        onClick={() => setActiveTab('sell')}
                        className={`py-2 rounded-lg text-sm font-semibold transition ${
                          activeTab === 'sell'
                            ? 'bg-rose-500 text-white'
                            : 'text-[#7D92BC] hover:text-[#D4E1F7]'
                        }`}
                      >
                        Sell
                      </button>
                    </div>

                    {activeTab === 'buy' ? (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs text-[#7D92BC] mb-2">You pay ({EVM_NATIVE_SYMBOL})</label>
                          <input
                            type="number"
                            min="0"
                            step="0.001"
                            value={buyAmountSol}
                            onChange={(e) => setBuyAmountSol(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl bg-[#081122] border border-[#1D2940] text-[#E8EEF9] focus:outline-none focus:border-[#36BCFF]"
                          />
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                          {[0.01, 0.05, 0.1, 0.5].map((value) => (
                            <button
                              key={value}
                              onClick={() => quickBuy(value)}
                              className="py-2 rounded-lg bg-[#10192C] border border-[#1D2940] text-[#A9BCDE] hover:text-white"
                            >
                              {value}
                            </button>
                          ))}
                        </div>
                        <p className="text-xs text-[#7D92BC]">
                          Executes against the live pool price with {slippage}% slippage tolerance.
                        </p>
                        <button
                          onClick={submitBuy}
                          disabled={onchainBusy}
                          className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {onchainBusy
                            ? txPhase === 'signing'
                              ? 'Awaiting wallet signature...'
                              : txPhase === 'sending'
                                ? 'Sending transaction...'
                                : txPhase === 'confirming'
                                  ? 'Confirming on-chain...'
                                  : 'Processing...'
                            : `Buy ${displaySymbol}`}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs text-[#7D92BC] mb-2">
                            You sell ({displaySymbol})
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="number"
                              min="0"
                              step={tokenInputStep}
                              value={sellAmountToken}
                              onChange={(e) => setSellAmountToken(normalizeTokenInput(e.target.value))}
                              className="flex-1 px-4 py-3 rounded-xl bg-[#081122] border border-[#1D2940] text-[#E8EEF9] focus:outline-none focus:border-[#36BCFF]"
                            />
                            <button
                              onClick={setMaxSell}
                              className="px-3 py-3 rounded-xl bg-[#13213D] border border-[#1D2940] text-[#C7D8F4] text-xs font-semibold hover:text-white"
                            >
                              MAX
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                          {[25, 50, 75, 100].map((value) => (
                            <button
                              key={value}
                              onClick={() => quickSellPct(value)}
                              className="py-2 rounded-lg bg-[#10192C] border border-[#1D2940] text-[#A9BCDE] hover:text-white"
                            >
                              {value}%
                            </button>
                          ))}
                        </div>
                        <p className="text-xs text-[#7D92BC]">
                          Executes against the live pool price with {slippage}% slippage tolerance.
                        </p>
                        <button
                          onClick={submitSell}
                          disabled={
                            onchainBusy ||
                            position.tokens <= 0 ||
                            !(Number(sellAmountToken) > 0 && Number(sellAmountToken) <= position.tokens)
                          }
                          className="w-full py-3 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {onchainBusy
                            ? txPhase === 'signing'
                              ? 'Awaiting wallet signature...'
                              : txPhase === 'sending'
                                ? 'Sending transaction...'
                                : txPhase === 'confirming'
                                  ? 'Confirming on-chain...'
                                  : 'Processing...'
                            : `Sell ${displaySymbol}`}
                        </button>
                      </div>
                    )}

                    <div className="mt-4 pt-4 border-t border-[#16243F]">
                      <label className="block text-xs text-[#7D92BC] mb-2">Slippage (%)</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={slippage}
                        onChange={(e) => setSlippage(Math.min(100, Math.max(0, Number(e.target.value))))}
                        className="w-full px-4 py-2 rounded-xl bg-[#081122] border border-[#1D2940] text-[#E8EEF9]"
                      />
                    </div>
                  </>
                )}

                {status && <p className="text-xs text-[#9ED0FF] mt-3">{status}</p>}
                {txRetryCount > 0 && onchainBusy && (
                  <p className="text-[11px] text-[#7D92BC] mt-1">Broadcast retries: {txRetryCount}</p>
                )}
              </div>

              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-5">
                <h3 className="text-[#E8EEF9] font-semibold mb-3">Your Position</h3>
                <div className="grid grid-cols-1 gap-2 text-sm">
                  <div className="rounded-xl border border-[#1D2940] bg-[#091325] px-3 py-2">
                    <p className="text-[#7D92BC] text-xs">Wallet {EVM_NATIVE_SYMBOL}</p>
                    <p className="text-[#E8EEF9] font-semibold">
                      {onchainBalances.loading
                        ? 'Refreshing...'
                        : `${formatSol(onchainBalances.walletSol)} ${EVM_NATIVE_SYMBOL}`}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[#1D2940] bg-[#091325] px-3 py-2">
                    <p className="text-[#7D92BC] text-xs">Token Balance</p>
                    <p className="text-[#E8EEF9] font-semibold">
                      {formatTokenAmount(position.tokens, onchainMintInfo.decimals)} {displaySymbol}
                    </p>
                  </div>
                </div>
              </div>

              {/* Incentifi Loss-Reward Protection Panel */}
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-5 relative overflow-hidden">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    <h3 className="text-[#E8EEF9] font-semibold text-sm">Loss-Reward Protection</h3>
                  </div>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[#14B8A6]/10 text-[#53B8FF] border border-[#14B8A6]/20">
                    10% Hourly
                  </span>
                </div>

                <div className="space-y-2.5 text-xs">
                  {/* Pool TVL */}
                  <div className="flex items-center justify-between rounded-xl bg-[#091325] px-3 py-2.5 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Loss Pool Balance</span>
                    <span className="text-white font-bold">{lossPoolTvl > 0 ? `${lossPoolTvl.toFixed(4)} ${EVM_NATIVE_SYMBOL}` : '0.0000 ETH'}</span>
                  </div>

                  {/* Cost Basis vs Market Price */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-[#091325] p-2.5 border border-[#1D2940]">
                      <span className="text-[#7D92BC] block text-[10px] uppercase">Your Cost Basis</span>
                      <span className="text-white font-semibold text-xs">
                        {lossStats.costBasisEth > 0 ? `${lossStats.costBasisEth.toFixed(6)} ETH` : 'No Entry Yet'}
                      </span>
                    </div>
                    <div className="rounded-xl bg-[#091325] p-2.5 border border-[#1D2940]">
                      <span className="text-[#7D92BC] block text-[10px] uppercase">Current Price</span>
                      <span className="text-white font-semibold text-xs">
                        {lossStats.currentPriceEth > 0 ? `${lossStats.currentPriceEth.toFixed(6)} ETH` : '0.000000 ETH'}
                      </span>
                    </div>
                  </div>

                  {/* Unrealized Loss / Profit Status */}
                  <div className="rounded-xl bg-[#091325] p-3 border border-[#1D2940]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[#7D92BC]">Position Status</span>
                      {costBasisData?.isUnderwaterSeller ? (
                        <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 font-semibold text-[11px] border border-rose-500/20">
                          Disqualified (Sold at Loss)
                        </span>
                      ) : lossStats.isUnderwater ? (
                        <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 font-semibold text-[11px] border border-amber-500/20">
                          Underwater (-{lossStats.unrealizedLossPct.toFixed(1)}%)
                        </span>
                      ) : lossStats.tokenBalance > 0 ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold text-[11px] border border-emerald-500/20">
                          In Profit / Breakeven
                        </span>
                      ) : (
                        <span className="text-[#7D92BC]">No Active Tokens</span>
                      )}
                    </div>
                    {lossStats.isUnderwater && (
                      <div className="mt-2 pt-2 border-t border-[#16243F] flex items-center justify-between text-[11px]">
                        <span className="text-[#8DA3CD]">Unrealized Loss:</span>
                        <span className="text-rose-400 font-semibold">{lossStats.unrealizedLossEth.toFixed(5)} ETH</span>
                      </div>
                    )}
                    {lossStats.isUnderwater && lossStats.isEligible && (
                      <div className="mt-1 flex items-center justify-between text-[11px]">
                        <span className="text-[#8DA3CD]">Est. Hourly Reward:</span>
                        <span className="text-emerald-400 font-semibold">{lossStats.theoreticalRewardEth.toFixed(5)} ETH (10%)</span>
                      </div>
                    )}
                  </div>

                  {/* Claim Section */}
                  <div className="rounded-xl bg-gradient-to-br from-[#0C1A30] to-[#0A1424] p-3 border border-[#23385D]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[#9FB0CF] text-xs">Claimable Rewards:</span>
                      <span className="text-white font-bold text-sm">
                        {claimableState.totalClaimableEth > 0 ? `${claimableState.totalClaimableEth.toFixed(5)} ${EVM_NATIVE_SYMBOL}` : '0.0000 ETH'}
                      </span>
                    </div>

                    <button
                      onClick={handleClaimRewards}
                      disabled={claiming || claimableState.totalClaimableEth <= 0}
                      className="w-full py-2.5 rounded-xl bg-gradient-to-r from-[#00B4D8] to-[#0077B6] hover:from-[#0096C7] hover:to-[#023E8A] text-white font-semibold text-xs disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
                    >
                      {claiming ? (
                        <span>Verifying Proof & Claiming...</span>
                      ) : (
                        <span>Claim Rewards {claimableState.unclaimedEpochs.length > 0 ? `(${claimableState.unclaimedEpochs.length} Epochs)` : ''}</span>
                      )}
                    </button>

                    {claimSuccessMsg && (
                      <p className="mt-2 text-center text-emerald-400 text-[11px]">{claimSuccessMsg}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-5">
                <h3 className="text-[#E8EEF9] font-semibold mb-3">
                  {isEvmToken ? 'Token Contract' : 'Bonding Curve'}
                </h3>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Token</span>
                    <span className="text-[#E8EEF9] font-medium">{displaySymbol || '-'} ({onchainMintInfo.decimals}d)</span>
                  </div>
                  <div className="rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                    <span className="block text-[#7D92BC]">Contract Address</span>
                    {tokenData?.mintAddress ? (
                      <a
                        href={isEvmToken ? EVM_ADDRESS_URL(tokenData.mintAddress) : undefined}
                        target={isEvmToken ? '_blank' : undefined}
                        rel={isEvmToken ? 'noopener noreferrer' : undefined}
                        className="mt-1 block break-all text-xs font-medium text-[#7EC8FF] hover:text-white"
                      >
                        {tokenData.mintAddress}
                      </a>
                    ) : (
                      <span className="mt-1 block break-all text-xs font-medium text-[#E8EEF9]">-</span>
                    )}
                  </div>
                  {isEvmToken ? (
                    <>
                      <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                        <span className="text-[#7D92BC]">Chain</span>
                        <span className="text-[#E8EEF9] font-medium">{EVM_CHAIN_NAME}</span>
                      </div>
                      <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                        <span className="text-[#7D92BC]">Supply</span>
                        <span className="text-[#E8EEF9] font-medium">1.00B</span>
                      </div>
                      <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                        <span className="text-[#7D92BC]">Gas</span>
                        <span className="text-[#E8EEF9] font-medium">{EVM_NATIVE_SYMBOL}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                        <span className="text-[#7D92BC]">Curve SOL Baseline</span>
                        <span className="text-[#E8EEF9] font-medium">{formatSol(curve.virtualSolReserves)} SOL</span>
                      </div>
                      <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                        <span className="text-[#7D92BC]">Curve Token Baseline</span>
                        <span className="text-[#E8EEF9] font-medium">{formatTokenAmount(curve.virtualTokenReserves, onchainMintInfo.decimals)}</span>
                      </div>
                      <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                        <span className="text-[#7D92BC]">Collected Fees</span>
                        <span className="text-[#E8EEF9] font-medium">{formatSol(totalFeesSol)} SOL</span>
                      </div>
                    </>
                  )}
                </div>
                {!isEvmToken && <div className="mt-4">
                  <div className="flex items-center justify-between text-xs text-[#8A9CC2] mb-1">
                    <span>Curve Progress</span>
                    <span>{formatNum(progressPct, 2)}%</span>
                  </div>
                  <div className="w-full h-2.5 bg-[#1A2846] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#00C2FF] to-[#22C55E]"
                      style={{ width: `${progressPct}%` }}
                    ></div>
                  </div>
                </div>}
              </div>
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
};

export default TokenPreviewPage;
