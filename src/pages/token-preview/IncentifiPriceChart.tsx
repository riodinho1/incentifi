import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import { BarChart2, TrendingUp, AlertCircle, RefreshCw } from 'lucide-react';
import { EVM_NATIVE_SYMBOL } from '../../lib/evmNetwork';

export type ChartPoint = {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isUp: boolean;
};

export type TradeSide = 'buy' | 'sell';

export type Trade = {
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

export type ChartTimeframe = '1m' | '5m' | '15m' | '1h' | '1D' | 'ALL';
export type ChartType = 'candles' | 'area';

interface IncentifiPriceChartProps {
  data: ChartPoint[];
  trades: Trade[];
  symbol: string;
  currentPriceEth: number;
  ethUsdPrice: number;
  priceChange24hPct?: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  isPoolActive?: boolean;
}

const formatPriceDisplay = (price: number): string => {
  if (!Number.isFinite(price) || price <= 0) return '0.000000';
  if (price < 0.000001) return price.toExponential(4);
  if (price < 0.0001) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
};

const formatUsdDisplay = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.000001) return `$${usd.toExponential(3)}`;
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const aggregateCandlesByInterval = (data: ChartPoint[], intervalMinutes: number): ChartPoint[] => {
  if (intervalMinutes <= 1 || data.length === 0) return data;
  const bucketMs = intervalMinutes * 60 * 1000;
  const buckets = new Map<number, ChartPoint[]>();

  for (const row of data) {
    const key = Math.floor(row.timestamp / bucketMs) * bucketMs;
    const list = buckets.get(key) || [];
    list.push(row);
    buckets.set(key, list);
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

  return aggregated;
};

export const IncentifiPriceChart = ({
  data,
  trades,
  symbol,
  currentPriceEth,
  ethUsdPrice,
  priceChange24hPct,
  loading = false,
  error = null,
  onRetry,
  isPoolActive = false,
}: IncentifiPriceChartProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const areaSeriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markerApiRef = useRef<ReturnType<typeof createSeriesMarkers> | null>(null);
  const livePriceLineRef = useRef<any>(null);
  const didInitialFitRef = useRef(false);

  const [timeframe, setTimeframe] = useState<ChartTimeframe>('1m');
  const [chartType, setChartType] = useState<ChartType>('candles');
  const [hoverData, setHoverData] = useState<{
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    time: string;
  } | null>(null);

  // Timeframe aggregation & filtering
  const processedData = useMemo(() => {
    if (!data || data.length === 0) return [];

    let filtered = [...data];

    if (timeframe === '1m') {
      filtered = aggregateCandlesByInterval(filtered, 1);
    } else if (timeframe === '5m') {
      filtered = aggregateCandlesByInterval(filtered, 5);
    } else if (timeframe === '15m') {
      filtered = aggregateCandlesByInterval(filtered, 15);
    } else if (timeframe === '1h') {
      filtered = aggregateCandlesByInterval(filtered, 60);
    } else if (timeframe === '1D') {
      filtered = aggregateCandlesByInterval(filtered, 1440);
    } else if (timeframe === 'ALL') {
      const minutesSpan = Math.max(1, Math.round((filtered[filtered.length - 1].timestamp - filtered[0].timestamp) / 60000));
      const step = minutesSpan > 2000 ? 60 : minutesSpan > 300 ? 15 : 5;
      filtered = aggregateCandlesByInterval(filtered, step);
    }

    return filtered;
  }, [data, timeframe]);

  const stats = useMemo(() => {
    if (processedData.length === 0) {
      return {
        high: currentPriceEth,
        low: currentPriceEth,
        volume: 0,
      };
    }
    const high = Math.max(...processedData.map((d) => d.high));
    const low = Math.min(...processedData.map((d) => d.low));
    const volume = processedData.reduce((sum, d) => sum + d.volume, 0);
    return { high, low, volume };
  }, [processedData, currentPriceEth]);

  const hasData = processedData.length > 0;

  // Initialize Lightweight Charts
  useEffect(() => {
    if (!containerRef.current || !hasData) return;

    const chart = createChart(containerRef.current, {
      layout: {
        textColor: '#8DA3CD',
        background: { type: ColorType.Solid, color: '#070A12' },
        fontFamily: "'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      },
      grid: {
        vertLines: { color: 'rgba(22, 36, 63, 0.65)' },
        horzLines: { color: 'rgba(22, 36, 63, 0.65)' },
      },
      rightPriceScale: {
        borderColor: '#1D2940',
        scaleMargins: {
          top: 0.1,
          bottom: 0.22,
        },
      },
      timeScale: {
        borderColor: '#1D2940',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 14,
        minBarSpacing: 4,
      },
      localization: {
        priceFormatter: (price: number) => formatPriceDisplay(price),
      },
      crosshair: {
        mode: 1,
        vertLine: {
          visible: true,
          color: 'rgba(54, 188, 255, 0.45)',
          width: 1,
          style: 3,
          labelBackgroundColor: '#10192C',
        },
        horzLine: {
          visible: true,
          color: 'rgba(54, 188, 255, 0.45)',
          width: 1,
          style: 3,
          labelBackgroundColor: '#10192C',
        },
      },
      handleScroll: true,
      handleScale: true,
    });

    let candleSeries: ISeriesApi<'Candlestick'> | null = null;
    let areaSeries: ISeriesApi<'Area'> | null = null;

    if (chartType === 'candles') {
      candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#10B981',
        downColor: '#F43F5E',
        borderVisible: false,
        wickUpColor: '#10B981',
        wickDownColor: '#F43F5E',
        priceLineVisible: true,
        lastValueVisible: true,
        priceLineWidth: 2,
      });
      markerApiRef.current = createSeriesMarkers(candleSeries, []);
      candleSeriesRef.current = candleSeries;
      areaSeriesRef.current = null;
    } else {
      areaSeries = chart.addSeries(AreaSeries, {
        topColor: 'rgba(16, 185, 129, 0.45)',
        bottomColor: 'rgba(16, 185, 129, 0.02)',
        lineColor: '#10B981',
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true,
      });
      markerApiRef.current = createSeriesMarkers(areaSeries, []);
      areaSeriesRef.current = areaSeries;
      candleSeriesRef.current = null;
    }

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
    volumeSeriesRef.current = volumeSeries;

    // Crosshair move subscription for HUD
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setHoverData(null);
        return;
      }

      const activeSeries = candleSeriesRef.current || areaSeriesRef.current;
      if (!activeSeries) return;

      const seriesData = param.seriesData.get(activeSeries) as any;
      if (!seriesData) {
        setHoverData(null);
        return;
      }

      const volData = volumeSeriesRef.current ? (param.seriesData.get(volumeSeriesRef.current) as any) : null;
      const ts = typeof param.time === 'number' ? param.time * 1000 : Date.now();

      if ('open' in seriesData) {
        setHoverData({
          open: seriesData.open,
          high: seriesData.high,
          low: seriesData.low,
          close: seriesData.close,
          volume: volData?.value || 0,
          time: new Date(ts).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        });
      } else if ('value' in seriesData) {
        setHoverData({
          open: seriesData.value,
          high: seriesData.value,
          low: seriesData.value,
          close: seriesData.value,
          volume: volData?.value || 0,
          time: new Date(ts).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        });
      }
    });

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
      areaSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markerApiRef.current = null;
      livePriceLineRef.current = null;
      didInitialFitRef.current = false;
    };
  }, [hasData, chartType]);

  // Feed candlestick / area and volume data into series
  useEffect(() => {
    if (!hasData) return;
    const activeSeries = candleSeriesRef.current || areaSeriesRef.current;
    if (!activeSeries || !volumeSeriesRef.current) return;

    // Deduplicate and merge same-second candles to prevent Lightweight Charts sort/unique errors
    const bySecond = new Map<number, ChartPoint>();
    for (const point of processedData) {
      const second = Math.floor(point.timestamp / 1000);
      const existing = bySecond.get(second);
      if (!existing) {
        bySecond.set(second, point);
        continue;
      }
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

    if (normalized.length === 0) return;

    try {
      if (chartType === 'candles' && candleSeriesRef.current) {
        const candles: CandlestickData[] = normalized.map((point) => ({
          time: Math.floor(point.timestamp / 1000) as UTCTimestamp,
          open: point.open,
          high: point.high,
          low: point.low,
          close: point.close,
        }));
        candleSeriesRef.current.setData(candles);
      } else if (chartType === 'area' && areaSeriesRef.current) {
        const areas = normalized.map((point) => ({
          time: Math.floor(point.timestamp / 1000) as UTCTimestamp,
          value: point.close,
        }));
        areaSeriesRef.current.setData(areas);
      }

      const volumes: HistogramData[] = normalized.map((point) => ({
        time: Math.floor(point.timestamp / 1000) as UTCTimestamp,
        value: point.volume,
        color: point.isUp ? 'rgba(16, 185, 129, 0.45)' : 'rgba(244, 63, 94, 0.45)',
      }));

      volumeSeriesRef.current.setData(volumes);

      if (!didInitialFitRef.current) {
        chartRef.current?.timeScale().fitContent();
        didInitialFitRef.current = true;
      } else {
        chartRef.current?.timeScale().scrollToRealTime();
      }

      // Add / update live price line
      const lastPoint = normalized[normalized.length - 1];
      if (lastPoint && activeSeries) {
        if (livePriceLineRef.current) {
          activeSeries.removePriceLine(livePriceLineRef.current);
        }
        livePriceLineRef.current = activeSeries.createPriceLine({
          price: lastPoint.close,
          color: lastPoint.close >= lastPoint.open ? '#10B981' : '#F43F5E',
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Last',
        });
      }
    } catch (err) {
      console.error('Failed to populate lightweight-charts data:', err);
    }
  }, [processedData, hasData, chartType]);

  // Feed trade execution markers
  useEffect(() => {
    if (!markerApiRef.current || !hasData || trades.length === 0) return;

    try {
      const markers: SeriesMarker<UTCTimestamp>[] = trades.slice(0, 80).map((trade) => ({
        time: Math.floor((trade.timestamp || Date.now()) / 1000) as UTCTimestamp,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: trade.side === 'buy' ? '#10B981' : '#F43F5E',
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: trade.side === 'buy' ? 'BUY' : 'SELL',
      }));

      // Markers must be sorted by time ascending
      markers.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
      markerApiRef.current.setMarkers(markers);
    } catch (err) {
      console.error('Failed to set chart trade markers:', err);
    }
  }, [trades, hasData]);

  // RENDER: Loading State
  if (loading && !hasData) {
    return (
      <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 sm:p-6 relative overflow-hidden">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <BarChart2 className="w-5 h-5 text-[#36BCFF] animate-pulse" />
            <h2 className="text-[#E8EEF9] font-semibold text-base sm:text-lg">Price Chart</h2>
          </div>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#10192C] text-[#8DA3CD] text-xs border border-[#1D2940]">
            <span className="w-2 h-2 rounded-full bg-[#36BCFF] animate-ping" />
            Loading market data...
          </span>
        </div>
        <div className="h-[480px] w-full rounded-xl bg-[#070A12]/80 border border-[#16243F] flex flex-col items-center justify-center gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-[#1D2940] border-t-[#36BCFF] animate-spin" />
          <p className="text-sm text-[#8DA3CD]">Fetching real-time candles & pool trades...</p>
        </div>
      </div>
    );
  }

  // RENDER: Error State
  if (error && !hasData) {
    return (
      <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <BarChart2 className="w-5 h-5 text-rose-400" />
            <h2 className="text-[#E8EEF9] font-semibold text-base sm:text-lg">Price Chart</h2>
          </div>
        </div>
        <div className="h-[480px] w-full rounded-xl bg-[#070A12] border border-[#16243F] flex flex-col items-center justify-center p-6 text-center">
          <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mb-3 text-rose-400">
            <AlertCircle className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-white mb-1">Unable to load price data</h3>
          <p className="text-sm text-[#8DA3CD] max-w-md mb-4">{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#10192C] hover:bg-[#16243F] border border-[#233658] text-sm text-white font-medium transition"
            >
              <RefreshCw className="w-4 h-4" />
              Retry Connection
            </button>
          )}
        </div>
      </div>
    );
  }

  // RENDER: Empty State (e.g. DHT or unseeded token without trades/pool)
  if (!hasData) {
    return (
      <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 sm:p-6 relative overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00C2FF]/20 to-[#0077B6]/20 border border-[#00C2FF]/30 flex items-center justify-center text-[#36BCFF]">
              <BarChart2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-[#E8EEF9] font-semibold text-base sm:text-lg flex items-center gap-2">
                Price Chart
                <span className="text-xs font-normal text-[#53B8FF]">${symbol}</span>
              </h2>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#10192C] text-[#8DA3CD] text-xs border border-[#1D2940]">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            Awaiting Trading Activity
          </span>
        </div>

        {/* Polished Empty State Display */}
        <div className="relative h-[480px] w-full rounded-xl bg-[#070A12] border border-[#16243F] overflow-hidden flex flex-col items-center justify-center p-6 text-center">
          {/* Subtle background grid pattern */}
          <div
            className="absolute inset-0 opacity-[0.07] pointer-events-none"
            style={{
              backgroundImage:
                'linear-gradient(to right, #36BCFF 1px, transparent 1px), linear-gradient(to bottom, #36BCFF 1px, transparent 1px)',
              backgroundSize: '32px 32px',
            }}
          />

          {/* Radial glow */}
          <div className="absolute w-72 h-72 rounded-full bg-gradient-to-tr from-[#00C2FF]/10 to-emerald-500/10 blur-3xl pointer-events-none" />

          <div className="relative z-10 max-w-md flex flex-col items-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#10192C] to-[#0B1120] border border-[#233658] shadow-lg shadow-black/40 flex items-center justify-center mb-4 text-[#36BCFF]">
              <TrendingUp className="w-8 h-8 text-[#36BCFF]" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">No trading data yet</h3>
            <p className="text-sm text-[#8DA3CD] leading-relaxed mb-6">
              Trading activity and price action will appear here once the first trade occurs on Robinhood Chain.
            </p>

            <div className="w-full max-w-sm grid grid-cols-2 gap-2 text-left text-xs bg-[#0B1120]/80 border border-[#1D2940] rounded-xl p-3">
              <div>
                <span className="text-[#64799E] block mb-0.5">Contract Status</span>
                <span className="text-emerald-400 font-medium flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Deployed
                </span>
              </div>
              <div>
                <span className="text-[#64799E] block mb-0.5">Pool Status</span>
                <span className={isPoolActive ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {isPoolActive ? 'Uniswap V3 Ready' : 'Awaiting First Trade'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // RENDER: Live Interactive Chart
  const livePriceUsd = currentPriceEth * ethUsdPrice;

  return (
    <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-4 sm:p-6 relative overflow-hidden">
      {/* Top Header & Live HUD */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4 pb-4 border-b border-[#16243F]">
        {/* Left: Price and Hover HUD */}
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-[#E8EEF9] font-semibold text-base sm:text-lg flex items-center gap-2">
              Price Chart
              <span className="text-xs font-normal text-[#53B8FF]">${symbol}</span>
            </h2>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs border border-emerald-500/20 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live Feed
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-baseline gap-3">
            <span className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
              {hoverData ? formatPriceDisplay(hoverData.close) : formatPriceDisplay(currentPriceEth)}{' '}
              <span className="text-sm font-semibold text-[#8DA3CD]">{EVM_NATIVE_SYMBOL}</span>
            </span>

            <span className="text-sm text-[#8DA3CD]">
              ≈ {hoverData ? formatUsdDisplay(hoverData.close * ethUsdPrice) : formatUsdDisplay(livePriceUsd)}
            </span>

            {typeof priceChange24hPct === 'number' && (
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded-md ${
                  priceChange24hPct >= 0
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                }`}
              >
                {priceChange24hPct >= 0 ? '+' : ''}
                {priceChange24hPct.toFixed(2)}%
              </span>
            )}
          </div>

          {/* Hover Crosshair Details / Period High-Low */}
          {hoverData ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#8DA3CD] bg-[#070A12]/80 px-2.5 py-1 rounded-lg border border-[#16243F]">
              <span>
                <strong className="text-[#64799E]">Time:</strong> {hoverData.time}
              </span>
              <span>
                <strong className="text-[#64799E]">O:</strong> {formatPriceDisplay(hoverData.open)}
              </span>
              <span>
                <strong className="text-[#64799E]">H:</strong> {formatPriceDisplay(hoverData.high)}
              </span>
              <span>
                <strong className="text-[#64799E]">L:</strong> {formatPriceDisplay(hoverData.low)}
              </span>
              <span>
                <strong className="text-[#64799E]">C:</strong> {formatPriceDisplay(hoverData.close)}
              </span>
              {hoverData.volume > 0 && (
                <span>
                  <strong className="text-[#64799E]">Vol:</strong> {hoverData.volume.toFixed(4)} {EVM_NATIVE_SYMBOL}
                </span>
              )}
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#8DA3CD]">
              <span>
                <strong className="text-[#64799E]">Period High:</strong> {formatPriceDisplay(stats.high)}
              </span>
              <span>
                <strong className="text-[#64799E]">Period Low:</strong> {formatPriceDisplay(stats.low)}
              </span>
              {stats.volume > 0 && (
                <span>
                  <strong className="text-[#64799E]">Period Vol:</strong> {stats.volume.toFixed(4)} {EVM_NATIVE_SYMBOL}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right: Controls (Chart Type & Timeframe Switcher) */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 self-start md:self-center">
          {/* Chart Type Toggle */}
          <div className="flex items-center bg-[#070A12] p-0.5 rounded-lg border border-[#1D2940]">
            <button
              onClick={() => setChartType('candles')}
              className={`px-2 sm:px-2.5 py-1 text-[11px] sm:text-xs font-medium rounded-md transition ${
                chartType === 'candles'
                  ? 'bg-[#1D2940] text-white'
                  : 'text-[#7D92BC] hover:text-white'
              }`}
              title="Candlestick Chart"
            >
              Candles
            </button>
            <button
              onClick={() => setChartType('area')}
              className={`px-2 sm:px-2.5 py-1 text-[11px] sm:text-xs font-medium rounded-md transition ${
                chartType === 'area'
                  ? 'bg-[#1D2940] text-white'
                  : 'text-[#7D92BC] hover:text-white'
              }`}
              title="Area Line Chart"
            >
              Line
            </button>
          </div>

          {/* Timeframe Switcher */}
          <div className="flex items-center bg-[#070A12] p-0.5 rounded-lg border border-[#1D2940]">
            {(['1m', '5m', '15m', '1h', '1D', 'ALL'] as ChartTimeframe[]).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-1.5 sm:px-2.5 py-1 text-[11px] sm:text-xs font-medium rounded-md transition ${
                  timeframe === tf
                    ? 'bg-[#36BCFF]/20 text-[#36BCFF] font-semibold'
                    : 'text-[#7D92BC] hover:text-white'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart Canvas */}
      <div ref={containerRef} className="h-[340px] sm:h-[420px] lg:h-[480px] w-full rounded-xl overflow-hidden bg-[#070A12]" />
    </div>
  );
};

export default IncentifiPriceChart;
