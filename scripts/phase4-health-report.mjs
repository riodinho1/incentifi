import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN_SYMBOL = (process.env.TOKEN_SYMBOL || '').toUpperCase();
const HEARTBEAT_STALE_MS = Number(process.env.HEARTBEAT_STALE_MS || 120000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TOKEN_SYMBOL) {
  console.error('Missing env vars. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_SYMBOL');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const nowIso = new Date().toISOString();
const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const oneDayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const run = async () => {
  const [{ data: heartbeat }, { data: snapshot }, { data: candles }, { data: trades }, { data: verifications }] =
    await Promise.all([
      supabase
        .from('indexer_heartbeats')
        .select('worker_name,status,message,updated_at')
        .eq('symbol', TOKEN_SYMBOL)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('token_market_snapshots')
        .select('updated_at,price_sol,volume_24h_sol')
        .eq('symbol', TOKEN_SYMBOL)
        .limit(1)
        .maybeSingle(),
      supabase
        .from('token_candles_1m')
        .select('bucket_ts', { count: 'exact', head: true })
        .eq('symbol', TOKEN_SYMBOL)
        .gte('bucket_ts', oneHourAgoIso),
      supabase
        .from('token_trades')
        .select('signature', { count: 'exact', head: true })
        .eq('symbol', TOKEN_SYMBOL)
        .gte('block_time', oneHourAgoIso),
      supabase
        .from('token_trade_verifications')
        .select('signature,verified_at', { count: 'exact', head: true })
        .eq('symbol', TOKEN_SYMBOL)
        .eq('verified', false)
        .gte('verified_at', oneDayAgoIso),
    ]);

  const heartbeatUpdatedAt = heartbeat?.updated_at ? Date.parse(heartbeat.updated_at) : 0;
  const heartbeatAgeMs = heartbeatUpdatedAt > 0 ? Date.now() - heartbeatUpdatedAt : Number.MAX_SAFE_INTEGER;
  const heartbeatHealthy =
    Boolean(heartbeat) && heartbeat?.status !== 'error' && heartbeatAgeMs <= HEARTBEAT_STALE_MS;

  const report = {
    symbol: TOKEN_SYMBOL,
    generatedAt: nowIso,
    checks: {
      heartbeat: {
        ok: heartbeatHealthy,
        status: heartbeat?.status || 'missing',
        ageMs: heartbeatAgeMs,
        message: heartbeat?.message || '',
      },
      snapshot: {
        ok: Boolean(snapshot && Number(snapshot.price_sol) > 0),
        updatedAt: snapshot?.updated_at || null,
        priceSol: Number(snapshot?.price_sol || 0),
        volume24hSol: Number(snapshot?.volume_24h_sol || 0),
      },
      candles1h: {
        ok: Number(candles?.count || 0) >= 10,
        count: Number(candles?.count || 0),
      },
      trades1h: {
        ok: Number(trades?.count || 0) >= 1,
        count: Number(trades?.count || 0),
      },
      failedVerifications24h: {
        ok: Number(verifications?.count || 0) === 0,
        count: Number(verifications?.count || 0),
      },
    },
  };

  const pass =
    report.checks.heartbeat.ok &&
    report.checks.snapshot.ok &&
    report.checks.candles1h.ok &&
    report.checks.trades1h.ok &&
    report.checks.failedVerifications24h.ok;

  console.log(JSON.stringify(report, null, 2));
  if (!pass) {
    console.error('Phase 4 health report: FAIL');
    process.exit(1);
  }
  console.log('Phase 4 health report: PASS');
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
