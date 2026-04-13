# Phase 3 Runbook (Indexer + DB Source of Truth)

## 1) Apply DB schema
Run `supabase/phase3_schema.sql` in Supabase SQL Editor.
Then run `supabase/phase3_hardening.sql`.

This creates:
- `token_market_snapshots`
- `token_candles_1m`
- `token_trades`
- `token_trade_verifications`
- `indexer_heartbeats`

And anon read policies for frontend reads.

## 2) Configure env for indexer
Set these environment variables in your shell:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TOKEN_MINT`
- `TOKEN_SYMBOL` (uppercase, e.g. `RIO`)
- Optional: `INDEXER_LOOP_MS` (default `15000`)
- Optional: `SOL_USD` (default `180`)
- Optional: `ALERT_WEBHOOK_URL` (Slack/Discord webhook for failures)
- Optional: `WORKER_NAME` (default `phase3-indexer-{SYMBOL}`)
- Optional: `SOLANA_NETWORK` (must be `mainnet` for this worker)

Note:
- Phase 3 indexer expects a real market pair (mainnet).
- Tokens that exist only on devnet/simulation will not return pair data.

## 3) Start indexer
```bash
npm run phase3:indexer
```

The indexer pulls:
- snapshot from DexScreener
- 1m OHLC from GeckoTerminal
- recent trades from GeckoTerminal

Then upserts into Supabase every loop.

## 3b) Verify canonical trade confirmations
```bash
npm run phase3:verify-trades
```

Required env vars for verifier:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TOKEN_SYMBOL`
- Optional: `RPC_URL`
- Optional: `VERIFY_LIMIT` (default `100`)

## 4) Frontend behavior
`token-preview` now prefers indexed DB data:
- snapshots/metrics from `token_market_snapshots`
- candles from `token_candles_1m`
- trade table from `token_trades`

Fallbacks still exist (live feed / external reads) if indexed rows are not available yet.

For app network mode:
- Set `VITE_SOLANA_NETWORK=devnet` for test mode
- Set `VITE_SOLANA_NETWORK=mainnet` for real mode

## 5) Production recommendation
- Run indexer as a managed worker (Railway, Render, Fly, PM2/VPS).
- Add one worker per token or a multi-token scheduler.
- Add error alerting (logs + webhook).
