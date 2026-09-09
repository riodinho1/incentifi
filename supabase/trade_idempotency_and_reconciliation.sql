-- Trade idempotency + holder balance reconciliation (2026-09-09). Idempotent; run in the SQL editor.
--
-- Incident: holder_cost_basis rows at exactly 2x the on-chain balance (INCENTIFI 0xb1aE…7195, e.g.
-- 0x6e5e24f8…: ONE buy of 4,159,194 tokens on chain and ONE trade row in token_trades_evm, but a DB
-- balance of 8,318,387). scripts/evm-indexer.mjs updated holder_cost_basis BEFORE it wrote the
-- token_trades_evm row, so a failure between the two (RPC/DB hiccup, restart) left the holder
-- updated with no trade row; the next tick re-scanned the window, found no row, and applied the buy
-- again. Trade rows themselves cannot duplicate: tx_hash is the primary key and the indexer's
-- identity is `<transactionHash>:<logIndex>` (0 legacy ids without the suffix in production), so
-- there is nothing to dedupe at the row level — the damage is in holder_cost_basis and is repaired
-- by the indexer's periodic chain reconciliation (reconcileHolderBalances), audited below.
--
-- The indexer now (1) writes the trade row FIRST with applied = false, (2) updates the holder,
-- (3) sets applied = true. A rescan applies a row only while applied = false. Without this column
-- the indexer still works (trade row first, then holder), it just cannot resume a half-applied row.

alter table public.token_trades_evm add column if not exists applied boolean not null default true;
alter table public.token_trades_evm add column if not exists applied_at timestamptz;
comment on column public.token_trades_evm.applied is 'false while the holder_cost_basis update for this trade has not completed; the indexer re-applies such rows on rescan and never re-applies applied = true rows';
create index if not exists idx_token_trades_evm_unapplied on public.token_trades_evm (applied) where applied = false;

-- Defensive: trade identity must carry the log index. Reports (does not delete) any legacy row.
-- select count(*) as legacy_rows_without_log_index from public.token_trades_evm where tx_hash not like '%:%';
-- Duplicate-detection query for audits (same trader/block/side/amounts under different ids):
-- select token_address, trader_address, block_number, side, amount_token, amount_eth, count(*)
--   from public.token_trades_evm group by 1,2,3,4,5,6 having count(*) > 1;

-- Audit trail of every DB balance the reconciliation changed.
create table if not exists public.holder_balance_reconciliations (
  id              bigint generated always as identity primary key,
  token_address   text not null,
  wallet_address  text not null,
  block_number    bigint not null,           -- chain block the balance was read at (the indexer's cursor)
  db_balance      numeric not null,
  chain_balance   numeric not null,
  invested_before numeric not null,
  invested_after  numeric not null,
  action          text not null,             -- 'lowered'
  created_at      timestamptz not null default now()
);
create index if not exists idx_holder_balance_reconciliations_token_wallet on public.holder_balance_reconciliations (token_address, wallet_address);
alter table public.holder_balance_reconciliations enable row level security;
