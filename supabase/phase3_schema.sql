create table if not exists public.token_market_snapshots (
  symbol text primary key,
  mint_address text not null,
  price_sol numeric not null default 0,
  liquidity_sol numeric not null default 0,
  volume_24h_sol numeric not null default 0,
  market_cap_usd numeric not null default 0,
  fdv_usd numeric not null default 0,
  price_change_24h_pct numeric not null default 0,
  source text not null default 'indexer',
  updated_at timestamptz not null default now()
);

create table if not exists public.token_candles_1m (
  symbol text not null,
  mint_address text not null,
  bucket_ts timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume_sol numeric not null default 0,
  source text not null default 'indexer',
  updated_at timestamptz not null default now(),
  primary key (symbol, bucket_ts)
);

create table if not exists public.token_trades (
  signature text primary key,
  symbol text not null,
  mint_address text not null,
  side text not null check (side in ('buy', 'sell')),
  amount_sol numeric not null default 0,
  amount_token numeric not null default 0,
  price_sol numeric not null default 0,
  fee_sol numeric not null default 0,
  source text not null default 'indexer',
  block_time timestamptz not null,
  inserted_at timestamptz not null default now()
);

create index if not exists token_candles_1m_symbol_ts_idx
  on public.token_candles_1m (symbol, bucket_ts desc);
create index if not exists token_trades_symbol_time_idx
  on public.token_trades (symbol, block_time desc);

alter table public.token_market_snapshots enable row level security;
alter table public.token_candles_1m enable row level security;
alter table public.token_trades enable row level security;

drop policy if exists "public read snapshots" on public.token_market_snapshots;
drop policy if exists "public read candles" on public.token_candles_1m;
drop policy if exists "public read trades" on public.token_trades;

create policy "public read snapshots"
on public.token_market_snapshots for select
to anon
using (true);

create policy "public read candles"
on public.token_candles_1m for select
to anon
using (true);

create policy "public read trades"
on public.token_trades for select
to anon
using (true);
