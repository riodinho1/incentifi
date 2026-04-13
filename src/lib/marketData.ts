import { supabase } from './supabase';

export type IndexedSnapshot = {
  priceSol: number;
  liquiditySol: number;
  volume24hSol: number;
  marketCapUsd: number;
  fdvUsd: number;
  priceChange24hPct: number;
  updatedAt: number;
};

export type IndexedCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeSol: number;
};

export type IndexedTrade = {
  id: string;
  timestamp: number;
  side: 'buy' | 'sell';
  priceSol: number;
  amountToken: number;
  amountSol: number;
  feeSol: number;
  signature?: string;
};

export type IndexerHeartbeat = {
  workerName: string;
  status: string;
  message: string;
  updatedAt: number;
};

const toNumber = (value: unknown) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

export const fetchIndexedSnapshot = async (symbol: string): Promise<IndexedSnapshot | null> => {
  const { data, error } = await supabase
    .from('token_market_snapshots')
    .select(
      'price_sol, liquidity_sol, volume_24h_sol, market_cap_usd, fdv_usd, price_change_24h_pct, updated_at'
    )
    .eq('symbol', symbol.toUpperCase())
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  return {
    priceSol: toNumber((data as any).price_sol),
    liquiditySol: toNumber((data as any).liquidity_sol),
    volume24hSol: toNumber((data as any).volume_24h_sol),
    marketCapUsd: toNumber((data as any).market_cap_usd),
    fdvUsd: toNumber((data as any).fdv_usd),
    priceChange24hPct: toNumber((data as any).price_change_24h_pct),
    updatedAt: Date.parse((data as any).updated_at) || Date.now(),
  };
};

export const fetchIndexedCandles = async (
  symbol: string,
  limit = 140
): Promise<IndexedCandle[]> => {
  const { data, error } = await supabase
    .from('token_candles_1m')
    .select('bucket_ts, open, high, low, close, volume_sol')
    .eq('symbol', symbol.toUpperCase())
    .order('bucket_ts', { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return (data as any[])
    .map((row) => ({
      timestamp: Date.parse(row.bucket_ts),
      open: toNumber(row.open),
      high: toNumber(row.high),
      low: toNumber(row.low),
      close: toNumber(row.close),
      volumeSol: toNumber(row.volume_sol),
    }))
    .filter((row) => Number.isFinite(row.timestamp) && row.timestamp > 0 && row.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
};

export const fetchIndexedTrades = async (
  symbol: string,
  limit = 120
): Promise<IndexedTrade[]> => {
  const { data, error } = await supabase
    .from('token_trades')
    .select(
      'signature, symbol, side, amount_sol, amount_token, price_sol, fee_sol, block_time, source'
    )
    .eq('symbol', symbol.toUpperCase())
    .order('block_time', { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return (data as any[])
    .map((row) => {
      const timestamp = Date.parse(row.block_time);
      const signature = (row.signature as string) || undefined;
      return {
        id: signature || `${row.source || 'index'}-${timestamp}-${row.side || 'buy'}`,
        timestamp,
        side: row.side === 'sell' ? 'sell' : 'buy',
        priceSol: toNumber(row.price_sol),
        amountToken: toNumber(row.amount_token),
        amountSol: toNumber(row.amount_sol),
        feeSol: toNumber(row.fee_sol),
        signature,
      } as IndexedTrade;
    })
    .filter((row) => Number.isFinite(row.timestamp) && row.timestamp > 0 && row.priceSol > 0);
};

export const fetchIndexerHeartbeat = async (
  symbol: string
): Promise<IndexerHeartbeat | null> => {
  const { data, error } = await supabase
    .from('indexer_heartbeats')
    .select('worker_name, status, message, updated_at')
    .eq('symbol', symbol.toUpperCase())
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return {
    workerName: String((data as any).worker_name || ''),
    status: String((data as any).status || 'unknown'),
    message: String((data as any).message || ''),
    updatedAt: Date.parse((data as any).updated_at) || 0,
  };
};
