import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
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
  fetchIndexedCandles,
  fetchIndexerHeartbeat,
  fetchIndexedSnapshot,
  fetchIndexedTrades,
} from '../../lib/marketData';
import { IS_MAINNET, SOLANA_NETWORK, SOLANA_RPC_URL, SOLSCAN_TX_URL } from '../../lib/network';

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
type TxPhase = 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error';

const TOTAL_SUPPLY = 1_000_000_000;
const CURVE_TOKENS = 800_000_000;
const TRADE_FEE_RATE = 0.01;
const MIN_BUY_SOL = 0.001;
const MIN_SELL_SOL_OUT = 0.0001;
const SOL_USD = 180;
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
);
const DEXSCREENER_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';
const GECKOTERMINAL_POOL_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';

const formatNum = (value: number, digits = 4) => {
  if (!Number.isFinite(value)) return '0';
  if (value === 0) return '0';
  if (value < 0.0001) return value.toExponential(2);
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
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
  if (!Number.isFinite(value)) return '$0';
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
const isRetryableSendError = (message: string) =>
  /429|rate limit|blockhash|node is behind|temporarily unavailable|fetch failed|network/i.test(
    message
  );

const humanizeTradeError = (raw: string) => {
  const text = raw.toLowerCase();
  if (text.includes('user rejected') || text.includes('rejected the request')) {
    return 'Transaction was rejected in wallet.';
  }
  if (text.includes('insufficient') && text.includes('fund')) {
    return 'Insufficient SOL balance for this transaction.';
  }
  if (text.includes('slippage')) {
    return 'Trade failed due to slippage. Increase slippage or lower size.';
  }
  if (text.includes('timed out')) {
    return 'Confirmation timed out. Check wallet history for final status.';
  }
  if (text.includes('no route') || text.includes('no solana pair')) {
    return 'No tradable route/pool found for this token yet.';
  }
  return raw;
};

const waitForFinalizedSignature = async (
  connection: Connection,
  signature: string,
  timeoutMs = 45_000
) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await connection.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error('Transaction confirmation timed out.');
};

const executePumpPortalTrade = async ({
  provider,
  action,
  mint,
  amount,
  denominatedInSol,
  slippageBps,
  onStep,
  onRetry,
}: {
  provider: any;
  action: 'buy' | 'sell';
  mint: string;
  amount: number;
  denominatedInSol: boolean;
  slippageBps: number;
  onStep?: (step: TxPhase) => void;
  onRetry?: (attempt: number, reason: string) => void;
}) => {
  const publicKey = provider?.publicKey?.toString?.();
  if (!publicKey) throw new Error('Connect wallet first.');
  if (!IS_MAINNET) {
    throw new Error('On-chain trading route is currently available only on mainnet mode.');
  }

  const response = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      action,
      mint,
      amount,
      denominatedInSol: denominatedInSol ? 'true' : 'false',
      slippage: Math.max(1, Math.round(slippageBps)),
      priorityFee: 0.0005,
      pool: 'auto',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(errText || 'Failed to build trade transaction.');
  }

  const txBuffer = await response.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
  onStep?.('signing');
  const signed = await provider.signTransaction(tx);
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  onStep?.('sending');
  let signature = '';
  let attempt = 0;
  while (!signature) {
    attempt += 1;
    try {
      signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !isRetryableSendError(message)) {
        throw err;
      }
      onRetry?.(attempt, message);
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
  onStep?.('confirming');
  await waitForFinalizedSignature(connection, signature);
  return signature;
};

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
    decimals: 6,
    symbol: '',
  });
  const [slippage, setSlippage] = useState(1);
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  const [status, setStatus] = useState('');
  const [txPhase, setTxPhase] = useState<TxPhase>('idle');
  const [txRetryCount, setTxRetryCount] = useState(0);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('disconnected');
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot | null>(null);
  const [primaryPoolAddress, setPrimaryPoolAddress] = useState('');
  const [indexerStale, setIndexerStale] = useState(false);

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

    const loadSharedOrLocal = async () => {
      if (IS_MAINNET) {
        hydrateInitialState();
        return;
      }
      const symbolKey = tokenData.tokenSymbol.toUpperCase();
      const storageKey = `market-state:${symbolKey}`;
      const hasLikelyBrokenShape = (rows: ChartPoint[]) =>
        rows.length > 1 && new Set(rows.map((r) => Math.floor(r.timestamp / 60_000))).size <= 1;

      try {
        const { data, error } = await supabase
          .from('token_market_states')
          .select('state')
          .eq('symbol', symbolKey)
          .limit(1)
          .maybeSingle();

        if (!error && data?.state) {
          const state = data.state as PersistedMarketState;
          if (state.version === 1) {
            const normalized = normalizeLoadedChartData(state.chartData || []);
            if (hasLikelyBrokenShape(normalized)) {
              throw new Error('Shared chart state has collapsed timestamps; reinitializing');
            }
            setCurve(state.curve);
            setChartData(normalized);
            const loadedTrades = (state.trades || []).map((t) => ({ ...t, timestamp: t.timestamp || Date.now() }));
            for (const t of loadedTrades) {
              if (t.signature) seenTradeSignaturesRef.current.add(t.signature);
            }
            setTrades(loadedTrades);
            setPosition(state.position);
            setUsingSharedState(true);
            setStateHydrated(true);
            return;
          }
        }
      } catch (err) {
        console.error('Failed to fetch shared market state:', err);
      }

      const raw = localStorage.getItem(storageKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as PersistedMarketState;
          if (parsed.version === 1) {
            const normalized = normalizeLoadedChartData(parsed.chartData || []);
            if (hasLikelyBrokenShape(normalized)) {
              throw new Error('Local chart state has collapsed timestamps; reinitializing');
            }
            setCurve(parsed.curve);
            setChartData(normalized);
            const loadedTrades = (parsed.trades || []).map((t) => ({ ...t, timestamp: t.timestamp || Date.now() }));
            for (const t of loadedTrades) {
              if (t.signature) seenTradeSignaturesRef.current.add(t.signature);
            }
            setTrades(loadedTrades);
            setPosition(parsed.position);
            setStateHydrated(true);
            return;
          }
        } catch (err) {
          console.error('Failed to parse saved local market state:', err);
        }
      }

      hydrateInitialState();
    };

    loadSharedOrLocal();
  }, [tokenData]);

  useEffect(() => {
    if (!tokenData || !stateHydrated || IS_MAINNET) return;
    const symbolKey = tokenData.tokenSymbol.toUpperCase();
    const storageKey = `market-state:${symbolKey}`;
    const payload: PersistedMarketState = {
      version: 1,
      curve,
      chartData: chartData.slice(-120),
      trades: trades.slice(0, 80),
      position,
    };
    localStorage.setItem(storageKey, JSON.stringify(payload));
  }, [tokenData, stateHydrated, curve, chartData, trades, position]);

  useEffect(() => {
    if (!tokenData || !stateHydrated || IS_MAINNET) return;

    const symbolKey = tokenData.tokenSymbol.toUpperCase();
    const payload: PersistedMarketState = {
      version: 1,
      curve,
      chartData: chartData.slice(-120),
      trades: trades.slice(0, 80),
      position,
    };

    const timer = setTimeout(async () => {
      const { error } = await supabase.from('token_market_states').upsert(
        {
          symbol: symbolKey,
          state: payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'symbol' }
      );

      if (error) {
        if (usingSharedState) {
          console.error('Failed to sync shared market state:', error.message);
        }
      } else if (!usingSharedState) {
        setUsingSharedState(true);
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [tokenData, stateHydrated, curve, chartData, trades, position, usingSharedState]);

  const chartPriceSol = useMemo(() => {
    if (chartData.length > 0) {
      const latest = chartData[chartData.length - 1]?.close;
      if (Number.isFinite(latest) && latest > 0) return latest;
    }
    return curve.virtualSolReserves / Math.max(curve.virtualTokenReserves, 1);
  }, [chartData, curve.virtualSolReserves, curve.virtualTokenReserves]);

  const priceSol = useMemo(
    () => (marketSnapshot?.priceSol && marketSnapshot.priceSol > 0 ? marketSnapshot.priceSol : chartPriceSol),
    [marketSnapshot?.priceSol, chartPriceSol]
  );
  const marketCapUsd = useMemo(() => {
    if (marketSnapshot?.marketCapUsd && marketSnapshot.marketCapUsd > 0) return marketSnapshot.marketCapUsd;
    return priceSol * TOTAL_SUPPLY * SOL_USD;
  }, [marketSnapshot?.marketCapUsd, priceSol]);
  const marketCapSol = useMemo(() => marketCapUsd / SOL_USD, [marketCapUsd]);
  const liquiditySol = useMemo(
    () => (marketSnapshot?.liquiditySol && marketSnapshot.liquiditySol > 0 ? marketSnapshot.liquiditySol : curve.realSolReserves),
    [marketSnapshot?.liquiditySol, curve.realSolReserves]
  );
  const totalVolumeSol = useMemo(
    () =>
      marketSnapshot?.volume24hSol && marketSnapshot.volume24hSol > 0
        ? marketSnapshot.volume24hSol
        : trades.reduce((sum, t) => sum + t.amountSol, 0),
    [marketSnapshot?.volume24hSol, trades]
  );
  const totalFeesSol = useMemo(
    () => trades.reduce((sum, t) => sum + t.feeSol, 0),
    [trades]
  );
  const progressPct = useMemo(() => {
    const sold = curve.initialVirtualTokenReserves - curve.virtualTokenReserves;
    return Math.max(0, Math.min(100, (sold / curve.initialVirtualTokenReserves) * 100));
  }, [curve.initialVirtualTokenReserves, curve.virtualTokenReserves]);
  const athMcapUsd = useMemo(() => {
    if (marketSnapshot?.fdvUsd && marketSnapshot.fdvUsd > 0) {
      return Math.max(marketSnapshot.fdvUsd, marketCapUsd);
    }
    const highest = chartData.reduce((max, p) => Math.max(max, p.high), 0);
    const fromHistory = highest * TOTAL_SUPPLY * SOL_USD;
    return Math.max(fromHistory, marketCapUsd);
  }, [marketSnapshot?.fdvUsd, chartData, marketCapUsd]);
  const mcap24hDeltaPct = useMemo(() => {
    if (marketSnapshot && Number.isFinite(marketSnapshot.priceChange24hPct)) {
      return marketSnapshot.priceChange24hPct;
    }
    if (chartData.length < 2) return 0;
    const first = chartData[Math.max(0, chartData.length - 25)]?.close || chartData[0].close;
    const last = chartData[chartData.length - 1].close;
    if (!first) return 0;
    return ((last - first) / first) * 100;
  }, [marketSnapshot, chartData]);
  const displaySymbol = onchainMintInfo.symbol || tokenData?.tokenSymbol || '';

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
    if (!tokenData?.mintAddress) {
      return {
        timestamp: Date.now(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        price: priceSol,
        amountSol: fallbackSol,
        amountToken: fallbackTokens,
        feeSol: 0,
      };
    }

    const provider = (window as any).solana;
    const owner = provider?.publicKey?.toString?.();
    if (!owner) {
      throw new Error('Connect Phantom wallet first.');
    }

    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) {
      throw new Error('Could not load confirmed transaction details.');
    }

    const solDelta = extractOwnerSolDelta(tx, owner);
    const tokenDelta = extractOwnerTokenDelta(tx, owner, tokenData.mintAddress);
    const networkFeeSol = (tx.meta.fee || 0) / 1_000_000_000;
    const timestamp = (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000;

    const amountToken = Math.abs(tokenDelta) > 0 ? Math.abs(tokenDelta) : Math.max(0, fallbackTokens);
    const sideSol =
      side === 'buy'
        ? Math.max(0, -solDelta - networkFeeSol)
        : Math.max(0, solDelta + networkFeeSol);
    const amountSol = sideSol > 0 ? sideSol : Math.max(0, fallbackSol);
    const nextPrice = amountToken > 0 ? amountSol / amountToken : priceSol;

    appendConfirmedTradePoint(nextPrice, amountSol, timestamp);
    setCurve((prev) => ({
      ...prev,
      virtualSolReserves: nextPrice * prev.virtualTokenReserves,
      realSolReserves: Math.max(
        0,
        prev.realSolReserves + (side === 'buy' ? amountSol : -amountSol)
      ),
      completed: false,
    }));

    return {
      timestamp,
      time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      price: nextPrice,
      amountSol,
      amountToken,
      feeSol: networkFeeSol,
    };
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
    if (!tokenData?.mintAddress) return;
    const provider = (window as any).solana;
    if (!provider?.publicKey) return;
    refreshOnchainBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenData?.mintAddress]);

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
  }, [tokenData, stateHydrated]);

  useEffect(() => {
    if (!tokenData?.mintAddress || !stateHydrated || !IS_MAINNET) return;
    let cancelled = false;

    const loadSnapshot = async () => {
      try {
        const response = await fetch(`${DEXSCREENER_TOKEN_URL}/${tokenData.mintAddress}`);
        if (!response.ok) return;
        const body = await response.json();
        const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
        const solanaPairs = pairs.filter((p: any) => p?.chainId === 'solana');
        if (solanaPairs.length === 0 || cancelled) return;
        solanaPairs.sort(
          (a: any, b: any) =>
            parseNumberLike(b?.liquidity?.usd) - parseNumberLike(a?.liquidity?.usd)
        );
        const pair = solanaPairs[0];
        setPrimaryPoolAddress(String(pair?.pairAddress ?? ''));
        const priceSol = parseNumberLike(
          pair?.priceNative,
          parseNumberLike(pair?.priceUsd) > 0 ? parseNumberLike(pair?.priceUsd) / SOL_USD : 0
        );
        if (!Number.isFinite(priceSol) || priceSol <= 0) return;

        const snapshot: MarketSnapshot = {
          priceSol,
          liquiditySol: Math.max(0, parseNumberLike(pair?.liquidity?.usd) / SOL_USD),
          volume24hSol: Math.max(0, parseNumberLike(pair?.volume?.h24) / SOL_USD),
          marketCapUsd: Math.max(0, parseNumberLike(pair?.marketCap)),
          fdvUsd: Math.max(0, parseNumberLike(pair?.fdv)),
          priceChange24hPct: parseNumberLike(pair?.priceChange?.h24),
          updatedAt: Date.now(),
        };
        setMarketSnapshot(snapshot);

        setChartData((prev) => {
          const now = Date.now();
          const lastTs = prev.length > 0 ? prev[prev.length - 1].timestamp : 0;
          if (lastTs > 0 && now - lastTs < 40_000) return prev;
          const lastClose = prev.length > 0 ? prev[prev.length - 1].close : snapshot.priceSol;
          const close = snapshot.priceSol;
          const point: ChartPoint = {
            time: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            timestamp: now,
            open: lastClose,
            high: Math.max(lastClose, close) * 1.002,
            low: Math.min(lastClose, close) * 0.998,
            close,
            volume: 0,
            isUp: close >= lastClose,
          };
          return [...prev.slice(-60), point];
        });
      } catch (err) {
        console.error('Failed to fetch market snapshot:', err);
      }
    };

    loadSnapshot();
    const timer = setInterval(loadSnapshot, 30_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tokenData?.mintAddress, stateHydrated]);

  useEffect(() => {
    if (!tokenData?.mintAddress || !stateHydrated) return;
    if (!IS_MAINNET) {
      setFeedStatus('disconnected');
      return;
    }
    setFeedStatus('connecting');
    const ws = new WebSocket(PUMPPORTAL_WS_URL);

    ws.onopen = () => {
      setFeedStatus('live');
      ws.send(
        JSON.stringify({
          method: 'subscribeTokenTrade',
          keys: [tokenData.mintAddress],
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const live = parseLiveTrade(parsed, tokenData.mintAddress as string);
        if (!live) return;
        if (live.signature && seenTradeSignaturesRef.current.has(live.signature)) return;

        appendConfirmedTradePoint(live.price, live.amountSol, live.timestamp);
        setCurve((prev) => {
          const tokenShift = live.amountToken || 0;
          const nextTokenReserves =
            live.side === 'buy'
              ? Math.max(1, prev.virtualTokenReserves - tokenShift)
              : Math.min(prev.initialVirtualTokenReserves, prev.virtualTokenReserves + tokenShift);
          return {
            ...prev,
            virtualTokenReserves: nextTokenReserves,
            virtualSolReserves: Math.max(0.000001, live.price * nextTokenReserves),
            realSolReserves: Math.max(
              0,
              prev.realSolReserves + (live.side === 'buy' ? live.amountSol : -live.amountSol)
            ),
            completed: false,
          };
        });

        pushTrade({
          id: live.signature || `live-${live.timestamp}`,
          time: new Date(live.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
          timestamp: live.timestamp,
          side: live.side,
          price: live.price,
          amountToken: live.amountToken,
          amountSol: live.amountSol,
          feeSol: 0,
          signature: live.signature,
        });
      } catch (err) {
        console.error('Failed to parse live trade event:', err);
      }
    };

    ws.onerror = () => {
      setFeedStatus('error');
    };

    ws.onclose = () => {
      setFeedStatus('disconnected');
    };

    return () => {
      try {
        ws.send(
          JSON.stringify({
            method: 'unsubscribeTokenTrade',
            keys: [tokenData.mintAddress],
          })
        );
      } catch {
        // ignore socket close race
      }
      ws.close();
    };
  }, [tokenData?.mintAddress, stateHydrated]);

  useEffect(() => {
    if (!primaryPoolAddress || !stateHydrated || !IS_MAINNET) return;
    let cancelled = false;

    const loadHistoricalCandles = async () => {
      try {
        const response = await fetch(
          `${GECKOTERMINAL_POOL_URL}/${primaryPoolAddress}/ohlcv/minute?aggregate=1&limit=120`
        );
        if (!response.ok) return;
        const body = await response.json();
        const list = body?.data?.attributes?.ohlcv_list;
        if (!Array.isArray(list) || cancelled) return;

        const rows: ChartPoint[] = list
          .map((item: any) => {
            if (!Array.isArray(item) || item.length < 6) return null;
            const tsMs = parseNumberLike(item[0]) * 1000;
            const open = parseNumberLike(item[1]);
            const high = parseNumberLike(item[2]);
            const low = parseNumberLike(item[3]);
            const close = parseNumberLike(item[4]);
            const volumeUsd = Math.max(0, parseNumberLike(item[5]));
            if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
            if (!Number.isFinite(close) || close <= 0) return null;
            return {
              time: new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              timestamp: tsMs,
              open,
              high: Math.max(high, open, close),
              low: Math.min(low || open || close, open, close),
              close,
              volume: volumeUsd / SOL_USD,
              isUp: close >= open,
            } as ChartPoint;
          })
          .filter(Boolean)
          .sort((a: ChartPoint, b: ChartPoint) => a.timestamp - b.timestamp);

        if (rows.length === 0) return;

        setChartData((prev) => {
          const byMinute = new Map<number, ChartPoint>();
          for (const point of rows) {
            byMinute.set(Math.floor(point.timestamp / 60_000), point);
          }
          for (const point of prev) {
            byMinute.set(Math.floor(point.timestamp / 60_000), point);
          }
          return [...byMinute.values()]
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(-140);
        });
      } catch (err) {
        console.error('Failed to backfill historical candles:', err);
      }
    };

    loadHistoricalCandles();
    const timer = setInterval(loadHistoricalCandles, 90_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [primaryPoolAddress, stateHydrated]);

  useEffect(() => {
    if (!primaryPoolAddress || !stateHydrated || !IS_MAINNET) return;
    let cancelled = false;

    const loadHistoricalTrades = async () => {
      try {
        const response = await fetch(`${GECKOTERMINAL_POOL_URL}/${primaryPoolAddress}/trades?page=1`);
        if (!response.ok) return;
        const body = await response.json();
        const rows = Array.isArray(body?.data) ? body.data : [];
        if (rows.length === 0 || cancelled) return;

        const parsed = rows
          .map((row: any) => parseHistoricalTrade(row, priceSol))
          .filter((row: Trade | null): row is Trade => Boolean(row))
          .sort((a: Trade, b: Trade) => b.timestamp - a.timestamp);

        if (parsed.length === 0) return;

        setTrades((prev) => {
          const existingIds = new Set(prev.map((t) => t.id));
          const nextRows: Trade[] = [];
          for (const trade of parsed) {
            if (existingIds.has(trade.id)) continue;
            if (trade.signature && seenTradeSignaturesRef.current.has(trade.signature)) continue;
            if (trade.signature) seenTradeSignaturesRef.current.add(trade.signature);
            nextRows.push(trade);
          }
          if (nextRows.length === 0) return prev;
          return [...nextRows, ...prev].slice(0, 120);
        });
      } catch (err) {
        console.error('Failed to backfill historical trades:', err);
      }
    };

    loadHistoricalTrades();
    const timer = setInterval(loadHistoricalTrades, 75_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [primaryPoolAddress, stateHydrated, priceSol]);

  if (loading || !tokenData) {
    return (
      <div className="min-h-screen bg-[#0E1518] flex items-center justify-center">
        <p className="text-[#9FA6A3]">Loading token...</p>
      </div>
    );
  }

  const submitBuy = async () => {
    const solIn = Number(buyAmountSol);
    if (!Number.isFinite(solIn) || solIn <= 0) {
      setStatus('Enter a valid SOL amount.');
      return;
    }
    if (solIn < MIN_BUY_SOL) {
      setStatus(`Minimum buy is ${MIN_BUY_SOL} SOL.`);
      return;
    }

    if (!IS_MAINNET) {
      const solAfterFee = solIn * (1 - TRADE_FEE_RATE);
      const k = curve.virtualSolReserves * curve.virtualTokenReserves;
      const nextVirtualSol = curve.virtualSolReserves + solAfterFee;
      let tokensOut = curve.virtualTokenReserves - k / nextVirtualSol;
      tokensOut = Math.max(0, Math.min(tokensOut, curve.virtualTokenReserves - 1));
      if (tokensOut <= 0) {
        setStatus('Simulated buy rejected: amount too small.');
        return;
      }
      const nextVirtualToken = curve.virtualTokenReserves - tokensOut;
      const nextPrice = nextVirtualSol / Math.max(nextVirtualToken, 1);
      const timestamp = Date.now();

      setCurve((prev) => ({
        ...prev,
        virtualSolReserves: nextVirtualSol,
        virtualTokenReserves: nextVirtualToken,
        realSolReserves: prev.realSolReserves + solAfterFee,
        completed: nextVirtualToken <= prev.initialVirtualTokenReserves * 0.01,
      }));
      appendConfirmedTradePoint(nextPrice, solIn, timestamp);
      pushTrade({
        id: `${timestamp}-buy-sim`,
        time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp,
        side: 'buy',
        price: nextPrice,
        amountToken: tokensOut,
        amountSol: solIn,
        feeSol: solIn * TRADE_FEE_RATE,
      });
      setPosition((prev) => {
        const nextTokens = prev.tokens + tokensOut;
        const nextInvested = prev.investedSol + solIn;
        return {
          ...prev,
          tokens: nextTokens,
          investedSol: nextInvested,
          avgEntry: nextTokens > 0 ? nextInvested / nextTokens : 0,
        };
      });
      setTxPhase('idle');
      setStatus(
        `Simulated buy: ${formatTokenAmount(tokensOut, onchainMintInfo.decimals)} ${displaySymbol} for ${formatSol(solIn)} SOL.`
      );
      return;
    }

    try {
      if (!tokenData.mintAddress) {
        throw new Error('No mint address found for this token.');
      }
      const provider = (window as any).solana;
      if (!provider?.isPhantom || !provider?.publicKey) {
        throw new Error('Connect Phantom wallet first.');
      }
      setOnchainBusy(true);
      setTxRetryCount(0);
      setTxPhase('signing');
      const signature = await executePumpPortalTrade({
        provider,
        action: 'buy',
        mint: tokenData.mintAddress,
        amount: solIn,
        denominatedInSol: true,
        slippageBps: slippage * 100,
        onStep: (step) => setTxPhase(step),
        onRetry: (attempt) => {
          setTxRetryCount(attempt);
          setStatus(`Retrying transaction broadcast (${attempt}/2)...`);
        },
      });

      const estimatedTokens = (solIn / Math.max(priceSol, 0.0000000001)) * (1 - TRADE_FEE_RATE);
      let confirmed = {
        timestamp: Date.now(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        price: priceSol,
        amountSol: solIn,
        amountToken: Math.max(0, estimatedTokens),
        feeSol: 0,
      };
      try {
        confirmed = await ingestConfirmedExecution({
          signature,
          side: 'buy',
          fallbackSol: solIn,
          fallbackTokens: estimatedTokens,
        });
      } catch (ingestErr) {
        console.error('Failed to ingest confirmed buy details:', ingestErr);
        appendConfirmedTradePoint(confirmed.price, confirmed.amountSol, confirmed.timestamp);
      }

      pushTrade({
        id: `${Date.now()}-buy-chain`,
        time: confirmed.time,
        timestamp: confirmed.timestamp,
        side: 'buy',
        price: confirmed.price,
        amountToken: confirmed.amountToken,
        amountSol: confirmed.amountSol,
        feeSol: confirmed.feeSol,
        signature,
      });
      setPosition((prev) => {
        const nextTokens = prev.tokens + confirmed.amountToken;
        const nextInvested = prev.investedSol + confirmed.amountSol;
        return {
          ...prev,
          tokens: nextTokens,
          investedSol: nextInvested,
          avgEntry: nextTokens > 0 ? nextInvested / nextTokens : 0,
        };
      });
      await refreshOnchainBalances();
      setTxPhase('success');
      setStatus(
        `Buy confirmed: ${formatTokenAmount(confirmed.amountToken, onchainMintInfo.decimals)} ${displaySymbol} for ${formatSol(confirmed.amountSol)} SOL (${shortSig(signature)}).`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'On-chain buy failed.';
      setTxPhase('error');
      setStatus(humanizeTradeError(message));
    } finally {
      setOnchainBusy(false);
    }
  };

  const submitSell = async () => {
    const amount = Number(sellAmountToken);
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus('Enter a valid token amount.');
      return;
    }
    if (amount > position.tokens) {
      setStatus('Insufficient token balance.');
      return;
    }

    if (!IS_MAINNET) {
      const k = curve.virtualSolReserves * curve.virtualTokenReserves;
      const nextVirtualToken = curve.virtualTokenReserves + amount;
      const grossSolOut = curve.virtualSolReserves - k / nextVirtualToken;
      const feeSol = grossSolOut * TRADE_FEE_RATE;
      const netSolOut = grossSolOut - feeSol;
      if (netSolOut < MIN_SELL_SOL_OUT) {
        setStatus(`Simulated sell output too small (min ${MIN_SELL_SOL_OUT} SOL).`);
        return;
      }
      const nextVirtualSol = Math.max(0.000001, curve.virtualSolReserves - grossSolOut);
      const nextPrice = nextVirtualSol / Math.max(nextVirtualToken, 1);
      const timestamp = Date.now();

      setCurve((prev) => ({
        ...prev,
        virtualSolReserves: nextVirtualSol,
        virtualTokenReserves: nextVirtualToken,
        realSolReserves: Math.max(0, prev.realSolReserves - grossSolOut),
        completed: false,
      }));
      appendConfirmedTradePoint(nextPrice, grossSolOut, timestamp);
      pushTrade({
        id: `${timestamp}-sell-sim`,
        time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp,
        side: 'sell',
        price: nextPrice,
        amountToken: amount,
        amountSol: grossSolOut,
        feeSol,
      });
      setPosition((prev) => {
        const sold = Math.min(prev.tokens, amount);
        const basis = sold * prev.avgEntry;
        const nextTokens = Math.max(0, prev.tokens - sold);
        const nextInvested = Math.max(0, prev.investedSol - basis);
        return {
          ...prev,
          tokens: nextTokens,
          investedSol: nextInvested,
          avgEntry: nextTokens > 0 ? nextInvested / nextTokens : 0,
          realizedPnl: prev.realizedPnl + (netSolOut - basis),
        };
      });
      setSellAmountToken('');
      setTxPhase('idle');
      setStatus(
        `Simulated sell: ${formatTokenAmount(amount, onchainMintInfo.decimals)} ${displaySymbol} for ${formatSol(netSolOut)} SOL net.`
      );
      return;
    }

    try {
      if (!tokenData.mintAddress) {
        throw new Error('No mint address found for this token.');
      }
      const provider = (window as any).solana;
      if (!provider?.isPhantom || !provider?.publicKey) {
        throw new Error('Connect Phantom wallet first.');
      }
      setOnchainBusy(true);
      setTxRetryCount(0);
      setTxPhase('signing');
      const signature = await executePumpPortalTrade({
        provider,
        action: 'sell',
        mint: tokenData.mintAddress,
        amount,
        denominatedInSol: false,
        slippageBps: slippage * 100,
        onStep: (step) => setTxPhase(step),
        onRetry: (attempt) => {
          setTxRetryCount(attempt);
          setStatus(`Retrying transaction broadcast (${attempt}/2)...`);
        },
      });

      let confirmed = {
        timestamp: Date.now(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        price: priceSol,
        amountSol: Math.max(0, sellQuote.netSolOut),
        amountToken: Math.max(0, amount),
        feeSol: 0,
      };
      try {
        confirmed = await ingestConfirmedExecution({
          signature,
          side: 'sell',
          fallbackSol: sellQuote.netSolOut,
          fallbackTokens: amount,
        });
      } catch (ingestErr) {
        console.error('Failed to ingest confirmed sell details:', ingestErr);
        appendConfirmedTradePoint(confirmed.price, confirmed.amountSol, confirmed.timestamp);
      }

      pushTrade({
        id: `${Date.now()}-sell-chain`,
        time: confirmed.time,
        timestamp: confirmed.timestamp,
        side: 'sell',
        price: confirmed.price,
        amountToken: confirmed.amountToken,
        amountSol: confirmed.amountSol,
        feeSol: confirmed.feeSol,
        signature,
      });
      setPosition((prev) => {
        const sold = Math.min(prev.tokens, confirmed.amountToken);
        const basis = sold * prev.avgEntry;
        const nextTokens = Math.max(0, prev.tokens - sold);
        const nextInvested = Math.max(0, prev.investedSol - basis);
        return {
          ...prev,
          tokens: nextTokens,
          investedSol: nextInvested,
          avgEntry: nextTokens > 0 ? nextInvested / nextTokens : 0,
          realizedPnl: prev.realizedPnl + (confirmed.amountSol - basis),
        };
      });
      await refreshOnchainBalances();
      setTxPhase('success');
      setStatus(
        `Sell confirmed: ${formatTokenAmount(confirmed.amountToken, onchainMintInfo.decimals)} ${displaySymbol} for ${formatSol(confirmed.amountSol)} SOL (${shortSig(signature)}).`
      );
      setSellAmountToken('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'On-chain sell failed.';
      setTxPhase('error');
      setStatus(humanizeTradeError(message));
    } finally {
      setOnchainBusy(false);
    }
  };

  const quickBuy = (amount: number) => setBuyAmountSol(String(amount));
  const refreshOnchainBalances = async () => {
    if (!tokenData?.mintAddress) return;
    const provider = (window as any).solana;
    const owner = provider?.publicKey?.toString?.();
    if (!owner) return;

    try {
      setOnchainBalances((prev) => ({ ...prev, loading: true }));
      const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
      const ownerPk = new PublicKey(owner);
      const mintPk = new PublicKey(tokenData.mintAddress);
      const [metadataPda] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
        TOKEN_METADATA_PROGRAM_ID
      );

      const [lamports, tokenAccounts, mintInfo, metadataInfo] = await Promise.all([
        connection.getBalance(ownerPk, 'confirmed'),
        connection.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk }, 'confirmed'),
        connection.getParsedAccountInfo(mintPk, 'confirmed'),
        connection.getAccountInfo(metadataPda, 'confirmed'),
      ]);

      let tokenBalance = 0;
      for (const acct of tokenAccounts.value) {
        const parsed = acct.account.data.parsed as {
          info?: { tokenAmount?: { uiAmount?: number | null } };
        };
        tokenBalance += parsed?.info?.tokenAmount?.uiAmount || 0;
      }

      const mintParsed = mintInfo.value?.data as
        | { parsed?: { info?: { decimals?: number } } }
        | undefined;
      const decimals = mintParsed?.parsed?.info?.decimals ?? onchainMintInfo.decimals;
      const metadataSymbol = metadataInfo?.data ? parseMetadataSymbol(metadataInfo.data) : '';

      setOnchainBalances({
        walletSol: lamports / 1_000_000_000,
        tokenBalance,
        loading: false,
      });
      setOnchainMintInfo((prev) => ({
        decimals,
        symbol: metadataSymbol || prev.symbol,
      }));

      setPosition((prev) => ({
        ...prev,
        tokens: tokenBalance,
      }));
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
                src="https://static.readdy.ai/image/97719340ed94173328dfb1241fbbf19e/51991647bb900b0ff0ac5e8230d485ae.png"
                alt="IncentiveFi"
                className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg"
              />
              <span className="text-[#E8EEF9] font-semibold text-lg sm:text-xl">IncentiveFi</span>
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
                  <h1 className="text-xl sm:text-2xl font-bold text-[#E8EEF9]">
                    {tokenData.tokenName}{' '}
                    <span className="text-[#53B8FF]">${displaySymbol}</span>
                  </h1>
                  <div className="mt-3">
                    <p className="text-xs text-[#8DA3CD] uppercase tracking-wide">Market Cap</p>
                    <p className="text-3xl sm:text-4xl font-bold text-white">{formatCurrencyCompact(marketCapUsd)}</p>
                    <div className="flex items-center gap-3 mt-2">
                      <p className={`text-sm ${mcap24hDeltaPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {mcap24hDeltaPct >= 0 ? '+' : ''}{formatNum(mcap24hDeltaPct, 2)}% 24h
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
                    <span className="px-2.5 py-1 rounded-md bg-[#10192C] text-[#93A9CF]">Price {formatPrice(priceSol)} SOL</span>
                    <span className="px-2.5 py-1 rounded-md bg-[#10192C] text-[#93A9CF]">MCap {formatSol(marketCapSol)} SOL</span>
                    {marketSnapshot?.updatedAt ? (
                      <span className="px-2.5 py-1 rounded-md bg-[#10192C] text-[#93A9CF]">
                        Live {new Date(marketSnapshot.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl px-3 py-2">
                  <p className="text-[#7D92BC]">Real Liquidity</p>
                  <p className="text-[#E8EEF9] font-semibold">{formatSol(liquiditySol)} SOL</p>
                </div>
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl px-3 py-2">
                  <p className="text-[#7D92BC]">24h Volume</p>
                  <p className="text-[#E8EEF9] font-semibold">{formatSol(totalVolumeSol)} SOL</p>
                </div>
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl px-3 py-2">
                  <p className="text-[#7D92BC]">24h Change</p>
                  <p className={`font-semibold ${mcap24hDeltaPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {mcap24hDeltaPct >= 0 ? '+' : ''}{formatNum(mcap24hDeltaPct, 2)}%
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
            <div className="space-y-6">
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-6">
                <div className="flex flex-col gap-3 mb-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-[#E8EEF9] font-semibold">Price Chart</h2>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] px-2 py-1 rounded-full border ${
                          feedStatus === 'live'
                            ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
                            : feedStatus === 'connecting'
                              ? 'text-amber-300 border-amber-500/40 bg-amber-500/10'
                              : feedStatus === 'error'
                                ? 'text-rose-300 border-rose-500/40 bg-rose-500/10'
                                : 'text-[#8A9CC2] border-[#304368] bg-[#10192C]'
                        }`}
                      >
                        Feed: {feedStatus}
                      </span>
                      <span className="text-xs text-[#8A9CC2]">TradingView-style candles</span>
                      {IS_MAINNET && (
                        <span
                          className={`text-[10px] px-2 py-1 rounded-full border ${
                            indexerStale
                              ? 'text-rose-300 border-rose-500/40 bg-rose-500/10'
                              : 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
                          }`}
                        >
                          Indexer: {indexerStale ? 'stale' : 'ok'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(['1m', '5m', '15m', '1h'] as Timeframe[]).map((tf) => (
                      <button
                        key={tf}
                        onClick={() => setTimeframe(tf)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                          timeframe === tf
                            ? 'bg-[#22C55E] text-white'
                            : 'bg-[#10192C] text-[#9CB0D4] hover:text-white'
                        }`}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>
                <TradingViewChart data={displayedChartData} trades={trades} />
              </div>

              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-6">
                <h2 className="text-[#E8EEF9] font-semibold mb-4">Recent Trades</h2>
                {trades.length === 0 ? (
                  <p className="text-sm text-[#8A9CC2]">No trades yet. Place the first trade.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[#7D92BC] border-b border-[#16243F]">
                          <th className="py-2 pr-3">Time</th>
                          <th className="py-2 pr-3">Side</th>
                          <th className="py-2 pr-3">Price</th>
                          <th className="py-2 pr-3">Amount</th>
                          <th className="py-2 pr-3">SOL</th>
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
                                  href={SOLSCAN_TX_URL(trade.signature)}
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
            </div>

            <aside className="lg:sticky lg:top-24 h-fit space-y-4">
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-5">
                <div className="mb-4">
                  <p className="text-xs text-[#7D92BC] mb-2">Execution</p>
                  <p className="text-[11px] text-[#8EA6D1] mt-2">
                    Network: <span className="uppercase">{SOLANA_NETWORK}</span>. {IS_MAINNET
                      ? 'On-chain route requires a tradable mainnet mint + liquidity.'
                      : 'Devnet runs local simulation mode for buy/sell testing.'}
                  </p>
                </div>

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
                      <label className="block text-xs text-[#7D92BC] mb-2">You pay (SOL)</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={buyAmountSol}
                        onChange={(e) => setBuyAmountSol(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl bg-[#081122] border border-[#1D2940] text-[#E8EEF9] focus:outline-none focus:border-[#36BCFF]"
                      />
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {[0.1, 0.5, 1, 2].map((value) => (
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
                      Est. tokens: {formatTokenAmount((Number(buyAmountSol || 0) / priceSol) * (1 - TRADE_FEE_RATE), onchainMintInfo.decimals)}
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
                    <p className="text-xs text-[#7D92BC]">1% trading fee applies on each trade.</p>
                    <p className="text-xs text-[#7D92BC]">
                      Est. receive: {formatSol(sellQuote.netSolOut)} SOL
                    </p>
                    <button
                      onClick={submitSell}
                      disabled={onchainBusy || position.tokens <= 0 || !sellQuote.valid}
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
                    max="10"
                    step="0.1"
                    value={slippage}
                    onChange={(e) => setSlippage(Math.min(10, Math.max(0, Number(e.target.value))))}
                    className="w-full px-4 py-2 rounded-xl bg-[#081122] border border-[#1D2940] text-[#E8EEF9]"
                  />
                </div>

                {status && <p className="text-xs text-[#9ED0FF] mt-3">{status}</p>}
                {txRetryCount > 0 && onchainBusy && (
                  <p className="text-[11px] text-[#7D92BC] mt-1">Broadcast retries: {txRetryCount}</p>
                )}
              </div>

              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-5">
                <h3 className="text-[#E8EEF9] font-semibold mb-3">Your Position</h3>
                <div className="grid grid-cols-1 gap-2 text-sm">
                  <div className="rounded-xl border border-[#1D2940] bg-[#091325] px-3 py-2">
                    <p className="text-[#7D92BC] text-xs">Wallet SOL</p>
                    <p className="text-[#E8EEF9] font-semibold">
                      {onchainBalances.loading ? 'Refreshing...' : `${formatSol(onchainBalances.walletSol)} SOL`}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[#1D2940] bg-[#091325] px-3 py-2">
                    <p className="text-[#7D92BC] text-xs">Token Balance</p>
                    <p className="text-[#E8EEF9] font-semibold">
                      {formatTokenAmount(position.tokens, onchainMintInfo.decimals)} {displaySymbol}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[#1D2940] bg-[#091325] px-3 py-2">
                    <p className="text-[#7D92BC] text-xs">Average Entry</p>
                    <p className="text-[#E8EEF9] font-semibold">{formatPrice(position.avgEntry)} SOL</p>
                  </div>
                </div>
              </div>

              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-5">
                <h3 className="text-[#E8EEF9] font-semibold mb-3">Bonding Curve</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Mint</span>
                    <span className="text-[#E8EEF9] font-medium">{displaySymbol || '-'} ({onchainMintInfo.decimals}d)</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Virtual SOL</span>
                    <span className="text-[#E8EEF9] font-medium">{formatSol(curve.virtualSolReserves)} SOL</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Virtual Tokens</span>
                    <span className="text-[#E8EEF9] font-medium">{formatTokenAmount(curve.virtualTokenReserves, onchainMintInfo.decimals)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-[#091325] px-3 py-2 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Collected Fees</span>
                    <span className="text-[#E8EEF9] font-medium">{formatSol(totalFeesSol)} SOL</span>
                  </div>
                </div>
                <div className="mt-4">
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
                </div>
              </div>
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
};

export default TokenPreviewPage;
