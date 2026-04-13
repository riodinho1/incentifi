-- Phase 3 security hardening
-- Run after phase3_schema.sql

-- 1) Ensure indexer-only writes for phase3 tables (service_role bypasses RLS).
alter table public.token_market_snapshots enable row level security;
alter table public.token_candles_1m enable row level security;
alter table public.token_trades enable row level security;

drop policy if exists "public write snapshots" on public.token_market_snapshots;
drop policy if exists "public write candles" on public.token_candles_1m;
drop policy if exists "public write trades" on public.token_trades;

-- 2) Optional: tighten token_market_states (legacy shared-sim state).
--    Keep public read; remove anon write in production.
alter table public.token_market_states enable row level security;

drop policy if exists "public write token market states" on public.token_market_states;
drop policy if exists "public update token market states" on public.token_market_states;

-- Keep read policy for UI.
drop policy if exists "public read token market states" on public.token_market_states;
create policy "public read token market states"
on public.token_market_states for select
to anon
using (true);

-- 3) Add verification and heartbeat tables for backend truth + observability.
create table if not exists public.token_trade_verifications (
  signature text primary key,
  symbol text not null,
  mint_address text not null,
  verified boolean not null default false,
  verifier text not null default 'rpc-check',
  verify_error text not null default '',
  verified_at timestamptz not null default now()
);

create table if not exists public.indexer_heartbeats (
  worker_name text primary key,
  symbol text not null,
  mint_address text not null,
  status text not null default 'ok',
  message text not null default '',
  loop_ms int not null default 15000,
  updated_at timestamptz not null default now()
);

alter table public.token_trade_verifications enable row level security;
alter table public.indexer_heartbeats enable row level security;

drop policy if exists "public read trade verifications" on public.token_trade_verifications;
drop policy if exists "public read indexer heartbeats" on public.indexer_heartbeats;

create policy "public read trade verifications"
on public.token_trade_verifications for select
to anon
using (true);

create policy "public read indexer heartbeats"
on public.indexer_heartbeats for select
to anon
using (true);
