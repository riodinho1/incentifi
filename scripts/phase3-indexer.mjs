import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN_MINT = process.env.TOKEN_MINT;
const TOKEN_SYMBOL = (process.env.TOKEN_SYMBOL || '').toUpperCase();
const SOL_USD = Number(process.env.SOL_USD || 180);
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
const NETWORK = (process.env.SOLANA_NETWORK || 'mainnet').toLowerCase();
const WORKER_NAME = process.env.WORKER_NAME || `phase3-indexer-${TOKEN_SYMBOL}`;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TOKEN_MINT || !TOKEN_SYMBOL) {
  console.error(
    'Missing env vars. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_MINT, TOKEN_SYMBOL'
  );
  process.exit(1);
}
const containsPlaceholder = (value) =>
  String(value || '').includes('YOUR_') || String(value || '').includes('your_');
if (
  containsPlaceholder(SUPABASE_URL) ||
  containsPlaceholder(SUPABASE_SERVICE_ROLE_KEY) ||
  containsPlaceholder(TOKEN_MINT) ||
  containsPlaceholder(TOKEN_SYMBOL)
) {
  console.error('Env vars still contain placeholders. Replace YOUR_* values with real secrets/ids.');
  process.exit(1);
}
if (NETWORK !== 'mainnet') {
  console.error('Phase 3 indexer is intended for mainnet market pairs. Set SOLANA_NETWORK=mainnet.');
  process.exit(1);
}

const DEXSCREENER_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const GECKOTERMINAL_POOL_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';
const LOOP_MS = Number(process.env.INDEXER_LOOP_MS || 15000);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const choosePrimaryPair = (pairs) => {
  const solanaPairs = (pairs || []).filter((p) => p?.chainId === 'solana');
  solanaPairs.sort((a, b) => num(b?.liquidity?.usd) - num(a?.liquidity?.usd));
  return solanaPairs[0] || null;
};

const upsertSnapshot = async (pair) => {
  const priceSol = num(pair?.priceNative) || (num(pair?.priceUsd) > 0 ? num(pair.priceUsd) / SOL_USD : 0);
  const payload = {
    symbol: TOKEN_SYMBOL,
    mint_address: TOKEN_MINT,
    price_sol: priceSol,
    liquidity_sol: Math.max(0, num(pair?.liquidity?.usd) / SOL_USD),
    volume_24h_sol: Math.max(0, num(pair?.volume?.h24) / SOL_USD),
    market_cap_usd: Math.max(0, num(pair?.marketCap)),
    fdv_usd: Math.max(0, num(pair?.fdv)),
    price_change_24h_pct: num(pair?.priceChange?.h24),
    source: 'dexscreener',
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('token_market_snapshots').upsert(payload, {
    onConflict: 'symbol',
  });
  if (error) throw error;
  return payload;
};

const upsertCandles = async (poolAddress) => {
  const res = await fetch(
    `${GECKOTERMINAL_POOL_URL}/${poolAddress}/ohlcv/minute?aggregate=1&limit=120`
  );
  if (!res.ok) return 0;
  const body = await res.json();
  const list = body?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list) || list.length === 0) return 0;

  const rows = list
    .map((item) => {
      if (!Array.isArray(item) || item.length < 6) return null;
      const ts = new Date(num(item[0]) * 1000).toISOString();
      const open = num(item[1]);
      const high = num(item[2]);
      const low = num(item[3]);
      const close = num(item[4]);
      const volumeSol = num(item[5]) / SOL_USD;
      if (!open || !close) return null;
      return {
        symbol: TOKEN_SYMBOL,
        mint_address: TOKEN_MINT,
        bucket_ts: ts,
        open,
        high: Math.max(high, open, close),
        low: Math.min(low || open || close, open, close),
        close,
        volume_sol: Math.max(0, volumeSol),
        source: 'geckoterminal',
        updated_at: new Date().toISOString(),
      };
    })
    .filter(Boolean);

  if (rows.length === 0) return 0;
  const { error } = await supabase.from('token_candles_1m').upsert(rows, {
    onConflict: 'symbol,bucket_ts',
  });
  if (error) throw error;
  return rows.length;
};

const upsertTrades = async (poolAddress) => {
  const res = await fetch(`${GECKOTERMINAL_POOL_URL}/${poolAddress}/trades?page=1`);
  if (!res.ok) return 0;
  const body = await res.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  if (!rows.length) return 0;

  const mapped = rows
    .map((row) => {
      const attrs = row?.attributes ?? {};
      const signature = String(
        attrs?.tx_hash ?? attrs?.txHash ?? attrs?.transaction_hash ?? row?.id ?? ''
      ).trim();
      if (!signature) return null;
      const rawSide = String(
        attrs?.kind ?? attrs?.side ?? attrs?.tx_type ?? attrs?.trade_type ?? ''
      ).toLowerCase();
      const side = rawSide.includes('sell') ? 'sell' : 'buy';
      const amountToken = Math.abs(
        num(
          attrs?.base_token_amount ??
            attrs?.token_amount ??
            attrs?.amount_token ??
            attrs?.from_token_amount ??
            attrs?.to_token_amount
        )
      );
      const amountSol = Math.abs(
        num(
          attrs?.quote_token_amount ??
            attrs?.sol_amount ??
            attrs?.amount_sol ??
            attrs?.from_quote_amount ??
            attrs?.to_quote_amount
        )
      );
      const explicitPrice = num(
        attrs?.price_in_quote_token ??
          attrs?.price_quote ??
          attrs?.price ??
          attrs?.price_native
      );
      const priceSol = explicitPrice > 0 ? explicitPrice : amountToken > 0 ? amountSol / amountToken : 0;
      const tsRaw = attrs?.block_timestamp ?? attrs?.block_time ?? attrs?.created_at ?? attrs?.timestamp;
      const parsed = Date.parse(String(tsRaw));
      const blockTime = Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : new Date().toISOString();

      return {
        signature,
        symbol: TOKEN_SYMBOL,
        mint_address: TOKEN_MINT,
        side,
        amount_sol: Math.max(0, amountSol),
        amount_token: Math.max(0, amountToken),
        price_sol: Math.max(0, priceSol),
        fee_sol: 0,
        source: 'geckoterminal',
        block_time: blockTime,
      };
    })
    .filter(Boolean);

  if (!mapped.length) return 0;
  const { error } = await supabase.from('token_trades').upsert(mapped, {
    onConflict: 'signature',
  });
  if (error) throw error;
  return mapped.length;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendAlert = async (message) => {
  if (!ALERT_WEBHOOK_URL) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[${new Date().toISOString()}] ${WORKER_NAME}: ${message}`,
      }),
    });
  } catch {
    // ignore alert transport failure
  }
};

const upsertHeartbeat = async (status, message) => {
  const { error } = await supabase.from('indexer_heartbeats').upsert(
    {
      worker_name: WORKER_NAME,
      symbol: TOKEN_SYMBOL,
      mint_address: TOKEN_MINT,
      status,
      message: message || '',
      loop_ms: LOOP_MS,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'worker_name' }
  );
  if (error) throw error;
};

const runOnce = async () => {
  const res = await fetch(`${DEXSCREENER_TOKEN_URL}/${TOKEN_MINT}`);
  if (!res.ok) throw new Error(`DexScreener fetch failed: ${res.status}`);
  const body = await res.json();
  const pair = choosePrimaryPair(body?.pairs || []);
  if (!pair) throw new Error('No Solana pair found for token.');

  const snapshot = await upsertSnapshot(pair);
  const poolAddress = String(pair?.pairAddress || '').trim();
  const candleCount = poolAddress ? await upsertCandles(poolAddress) : 0;
  const tradeCount = poolAddress ? await upsertTrades(poolAddress) : 0;

  console.log(
    `[${new Date().toISOString()}] ok symbol=${TOKEN_SYMBOL} price=${snapshot.price_sol} candles=${candleCount} trades=${tradeCount}`
  );
};

const main = async () => {
  console.log(`Phase 3 indexer started for ${TOKEN_SYMBOL} (${TOKEN_MINT})`);
  for (;;) {
    try {
      await runOnce();
      await upsertHeartbeat('ok', 'tick');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toISOString()}] indexer error`, error);
      try {
        await upsertHeartbeat('error', message.slice(0, 400));
      } catch (heartbeatErr) {
        console.error('heartbeat write failed', heartbeatErr);
      }
      await sendAlert(message);
    }
    await sleep(LOOP_MS);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
