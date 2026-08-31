-- ============================================================================
-- INCENTIFI LOSS-REWARD & EVM INDEXING SCHEMA (Robinhood Chain / EVM)
-- ============================================================================

-- 1. Holder Cost Basis Tracking Table
create table if not exists public.holder_cost_basis (
  token_address text not null,
  wallet_address text not null,
  token_balance numeric not null default 0,
  total_invested_eth numeric not null default 0,
  avg_cost_basis_eth numeric not null default 0,
  is_eligible boolean not null default true,
  is_underwater_seller boolean not null default false,
  acquired_epoch bigint not null default 0,
  first_acquired_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  primary key (token_address, wallet_address)
);

create index if not exists idx_holder_cost_basis_token 
  on public.holder_cost_basis (token_address);
create index if not exists idx_holder_cost_basis_wallet 
  on public.holder_cost_basis (wallet_address);
create index if not exists idx_holder_cost_basis_eligibility 
  on public.holder_cost_basis (token_address, is_eligible);

-- 2. Hourly Reward Epochs Table
create table if not exists public.reward_epochs (
  epoch_id bigint generated always as identity primary key,
  token_address text not null,
  epoch_number int not null,
  snapshot_time timestamptz not null default now(),
  pool_price_eth numeric not null,
  pool_twap_price_eth numeric not null,
  total_theoretical_reward_eth numeric not null default 0,
  available_pool_eth numeric not null default 0,
  scaling_factor numeric not null default 1.0,
  total_distributed_eth numeric not null default 0,
  merkle_root text not null,
  onchain_tx_hash text,
  status text not null default 'published',
  created_at timestamptz not null default now(),
  unique (token_address, epoch_number)
);

create index if not exists idx_reward_epochs_token 
  on public.reward_epochs (token_address, epoch_number desc);

-- 3. Per-Holder Epoch Allocations & Merkle Proofs Table
create table if not exists public.epoch_holder_rewards (
  id bigint generated always as identity primary key,
  epoch_id bigint not null references public.reward_epochs(epoch_id) on delete cascade,
  token_address text not null,
  wallet_address text not null,
  token_balance numeric not null default 0,
  cost_basis_eth numeric not null default 0,
  unrealized_loss_eth numeric not null default 0,
  theoretical_reward_eth numeric not null default 0,
  final_reward_eth numeric not null default 0,
  merkle_proof jsonb not null default '[]'::jsonb,
  claimed boolean not null default false,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (epoch_id, wallet_address)
);

create index if not exists idx_epoch_holder_rewards_token_wallet 
  on public.epoch_holder_rewards (token_address, wallet_address);
create index if not exists idx_epoch_holder_rewards_claimed 
  on public.epoch_holder_rewards (wallet_address, claimed);

-- 4. EVM Trade History Table
create table if not exists public.token_trades_evm (
  tx_hash text primary key,
  token_address text not null,
  trader_address text not null,
  side text not null check (side in ('buy', 'sell')),
  amount_token numeric not null default 0,
  amount_eth numeric not null default 0,
  price_eth numeric not null default 0,
  creator_fee_eth numeric not null default 0,
  loss_pool_fee_eth numeric not null default 0,
  is_underwater_sale boolean not null default false,
  block_number bigint not null default 0,
  block_time timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_token_trades_evm_token_time 
  on public.token_trades_evm (token_address, block_time desc);
create index if not exists idx_token_trades_evm_trader 
  on public.token_trades_evm (trader_address);

-- 5. EVM Live Market Snapshots Table
create table if not exists public.token_market_snapshots_evm (
  token_address text primary key,
  symbol text not null,
  price_eth numeric not null default 0,
  price_usd numeric not null default 0,
  liquidity_eth numeric not null default 0,
  volume_24h_eth numeric not null default 0,
  market_cap_usd numeric not null default 0,
  loss_pool_tvl_eth numeric not null default 0,
  price_change_24h_pct numeric not null default 0,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

alter table public.holder_cost_basis enable row level security;
alter table public.reward_epochs enable row level security;
alter table public.epoch_holder_rewards enable row level security;
alter table public.token_trades_evm enable row level security;
alter table public.token_market_snapshots_evm enable row level security;

-- Public read access
drop policy if exists "public read holder_cost_basis" on public.holder_cost_basis;
create policy "public read holder_cost_basis"
  on public.holder_cost_basis for select to anon using (true);

drop policy if exists "public read reward_epochs" on public.reward_epochs;
create policy "public read reward_epochs"
  on public.reward_epochs for select to anon using (true);

drop policy if exists "public read epoch_holder_rewards" on public.epoch_holder_rewards;
create policy "public read epoch_holder_rewards"
  on public.epoch_holder_rewards for select to anon using (true);

drop policy if exists "public read token_trades_evm" on public.token_trades_evm;
create policy "public read token_trades_evm"
  on public.token_trades_evm for select to anon using (true);

drop policy if exists "public read token_market_snapshots_evm" on public.token_market_snapshots_evm;
create policy "public read token_market_snapshots_evm"
  on public.token_market_snapshots_evm for select to anon using (true);

-- Service role full access
drop policy if exists "service write holder_cost_basis" on public.holder_cost_basis;
create policy "service write holder_cost_basis"
  on public.holder_cost_basis for all to service_role using (true) with check (true);

drop policy if exists "service write reward_epochs" on public.reward_epochs;
create policy "service write reward_epochs"
  on public.reward_epochs for all to service_role using (true) with check (true);

drop policy if exists "service write epoch_holder_rewards" on public.epoch_holder_rewards;
create policy "service write epoch_holder_rewards"
  on public.epoch_holder_rewards for all to service_role using (true) with check (true);

drop policy if exists "service write token_trades_evm" on public.token_trades_evm;
create policy "service write token_trades_evm"
  on public.token_trades_evm for all to service_role using (true) with check (true);

drop policy if exists "service write token_market_snapshots_evm" on public.token_market_snapshots_evm;
create policy "service write token_market_snapshots_evm"
  on public.token_market_snapshots_evm for all to service_role using (true) with check (true);
