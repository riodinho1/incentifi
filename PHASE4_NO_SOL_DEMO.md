# Phase 4 No-SOL Demo Plan

Use this to show production-readiness progress before funding mainnet trades.

## 1) Run readiness preflight
```bash
npm run phase4:preflight
```
Show that env and network config are valid.

## 2) Apply ops SQL (optional)
Run:
- `supabase/phase4_ops_views.sql`

This gives dashboard-friendly views:
- `v_market_health`
- `v_trade_verification_failures`

## 3) Run health report
```bash
npm run phase4:health-report
```
Show JSON output with heartbeat/snapshot/candles/trades/verification status.

## 4) Show UI safety states
- Open token preview.
- Demonstrate tx state labels:
  - awaiting wallet signature
  - sending
  - confirming
- Demonstrate devnet guard message for real execution.
- Show feed and indexer status badges.

## 5) Show backend controls
- `npm run phase3:indexer` (worker)
- `npm run phase3:verify-trades` (verifier)
- Explain webhook alerts via `ALERT_WEBHOOK_URL`.

## 6) What remains blocked without SOL
- Final tiny buy/sell on mainnet
- End-to-end on-chain-to-DB-to-UI proof using your own live signatures

After funding, run final checklist in `GO_LIVE_CHECKLIST.md`.
