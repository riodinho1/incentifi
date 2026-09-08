-- Indexer discovery cursors (2026-09-08). Idempotent; run in the Supabase SQL editor.
--
-- scripts/evm-indexer.mjs scans TokenLaunched on the GenericSell and legible factories from fixed
-- floor blocks (54,600,000 / 56,911,900) to the chain head in chunks. Until now the scanned-through
-- block lived only in memory, so every restart rescanned ~3 M blocks through a rate-limited public
-- RPC. The indexer now persists each factory's cursor here after every chunk and, on startup,
-- restores the discovered-token caches from `indexed_tokens` (supabase/tokens_hidden_and_indexed_tokens.sql)
-- and resumes from these cursors. If either table is missing the indexer falls back to a full rescan.
create table if not exists public.indexer_cursors (
  name        text primary key,          -- 'v4_discovery_generic_sell' | 'v4_discovery_legible'
  block       bigint not null,           -- last block fully scanned
  updated_at  timestamptz not null default now()
);
comment on table public.indexer_cursors is 'scripts/evm-indexer.mjs: last fully scanned block per discovery scan. Safe to delete a row: the indexer rescans that factory from its floor.';
alter table public.indexer_cursors enable row level security;
