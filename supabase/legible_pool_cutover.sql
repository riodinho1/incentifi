-- =====================================================================================
-- V4 LEGIBLE POOL CUTOVER — tag every token with the hook its pool uses.
--
-- Two V4 hooks are live at once: the older IncentifiV4HookGenericSell
-- (0xC5Ef9Cb8c95cd8540E71b6D4c00a90257625a888) and the legible hook (PR #17,
-- 0x921d0bE20A21e5A687734b4dF6302EA55BD168C0). The frontend, indexer and worker route PER
-- TOKEN by this column (falling back to the chain when it is null), never by a global switch.
--
-- Writers: scripts/evm-indexer.mjs (from the factory TokenLaunched events, best-effort) and
-- the launch page (best-effort, retried without the column if this migration has not been
-- applied yet — so applying it is never a prerequisite for launching).
-- Apply in the Supabase SQL editor. Idempotent.
-- =====================================================================================
alter table public.tokens add column if not exists hook_address text;
create index if not exists idx_tokens_hook_address on public.tokens (hook_address);
comment on column public.tokens.hook_address is
  'Lowercase address of the V4 hook the token''s pool is bound to (legible or GenericSell); null for V3 tokens or until the indexer tags it.';
