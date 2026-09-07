-- =====================================================================================
-- LOSS REWARD POOL V2 ROLLOUT — per-epoch pool address, per-token reward asset.
--
-- Two loss-reward pools coexist during the transition (docs/LOSS_REWARD_ASSET_DESIGN.md §B6):
--   V1  0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf  (live, keeps its ETH and published epochs)
--   V2  LossRewardPoolV2 (address set by env once deployed)
-- The worker drains V1 per token, then publishes to V2, and records WHICH pool each epoch was
-- published on. The gateway and the frontend read that column to send V1 epochs to
-- claimBatch on V1 and V2 epochs to claimBatchAs on V2. Rows that predate this migration
-- are V1 epochs by definition, so the backfill below sets them explicitly.
--
-- tokens.reward_asset / reward_asset_symbol mirror the creator's launch-time choice (source
-- of truth stays on-chain: LossRewardPoolV2.rewardAsset(token)) so token lists can show the
-- "Loss Reward: AAPL" badge without an RPC per row.
--
-- Apply in the Supabase SQL editor. Idempotent.
-- =====================================================================================
alter table public.reward_epochs add column if not exists pool_address text;
update public.reward_epochs
   set pool_address = '0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf'
 where pool_address is null;
create index if not exists idx_reward_epochs_pool on public.reward_epochs (pool_address);
comment on column public.reward_epochs.pool_address is
  'Lowercase address of the LossRewardPool this epoch''s Merkle root was (or will be) published on. V1 = 0x697bda…, V2 = LossRewardPoolV2. Claims must target this pool.';

alter table public.tokens add column if not exists reward_asset text;
alter table public.tokens add column if not exists reward_asset_symbol text;
comment on column public.tokens.reward_asset is
  'Lowercase address of the loss-reward payout asset chosen at launch (address(0) / null = ETH). Mirror of LossRewardPoolV2.rewardAsset(token); the chain is authoritative.';
comment on column public.tokens.reward_asset_symbol is
  'Display symbol for reward_asset (ETH, AAPL, TSLA, NVDA).';
