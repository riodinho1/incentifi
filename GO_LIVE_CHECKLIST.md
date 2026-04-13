# Go-Live Checklist (Mainnet)

## Config
- Set `VITE_SOLANA_NETWORK=mainnet`
- Set production `VITE_RPC_URL`
- Remove dev/test placeholder env values

## Security
- Run `supabase/phase3_schema.sql`
- Run `supabase/phase3_hardening.sql`
- Confirm no anon write policies exist for phase3 tables
- Keep `service_role` keys server-side only

## Indexer + Verification
- Start `npm run phase3:indexer` in managed runtime
- Configure `ALERT_WEBHOOK_URL`
- Run `npm run phase3:verify-trades` periodically (cron/job)
- Confirm `indexer_heartbeats.updated_at` freshness

## Trading Safety
- Test wallet reject flow
- Test insufficient funds flow
- Test slippage failure flow
- Test tx timeout flow and post-timeout confirmation lookup

## Operational
- Set rate limits at edge/API
- Set log retention and alert thresholds
- Define rollback: disable trading button + stop indexer + show maintenance banner
- Rotate service keys after dry run

## Final Dry Run
- 1 tiny buy + 1 tiny sell on mainnet
- Confirm UI trade rows match on-chain signatures
- Confirm snapshot/candle/trade tables are updating
