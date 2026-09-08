-- Audit remediation 2026-09-08 (docs/AUDIT_2026-09-08.md finding 5). Idempotent; run in the Supabase SQL editor.
--
-- 1. tokens.hidden — the ONLY sanctioned way to take a token off the site.
--    NEVER DELETE A tokens ROW: the loss-reward worker iterates `tokens` to publish epochs, so a
--    deleted row silently strands whatever that token still holds on the loss-reward pools (V1 has
--    no withdraw) and orphans its reward_epochs / holder_cost_basis rows. Hidden tokens stay out of
--    the home page and lists but keep their token page, indexing and epochs.
alter table public.tokens add column if not exists hidden boolean not null default false;
comment on column public.tokens.hidden is 'true = not listed on the home page / lists; the token page, indexer and loss-reward worker still see it. Set this instead of deleting the row (deleting strands loss-reward funds).';
comment on table public.tokens is 'One row per launched token. NEVER DELETE a row: set hidden = true instead (the loss-reward worker drains pools per row; a deleted row strands funds).';

-- 2. indexed_tokens — the indexer''s durable discovery table (scripts/evm-indexer.mjs upserts every
--    token it discovers from the legible and GenericSell factories' TokenLaunched events). The worker
--    iterates tokens ∪ indexed_tokens, so a token exists for the worker as soon as the chain says so,
--    whether or not the launch flow wrote its tokens row and whether or not someone deleted it.
create table if not exists public.indexed_tokens (
  mint_address     text primary key,                 -- checksummed
  symbol           text,
  name             text,
  venue            text not null,                    -- 'legible' | 'v4-generic' | 'v3'
  hook_address     text,                             -- lowercase, V4 venues
  factory_address  text,                             -- lowercase
  creator_address  text,                             -- checksummed, from TokenLaunched
  pool_id          text,
  first_block      bigint,
  discovered_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.indexed_tokens is 'Tokens discovered on-chain by scripts/evm-indexer.mjs (TokenLaunched on the legible + GenericSell factories). Source of truth for "which tokens exist" independently of the client-written tokens table.';
create index if not exists indexed_tokens_venue_idx on public.indexed_tokens (venue);

-- Service role only (the worker and indexer use the service key); the anon key gets read access so
-- the site can resolve hidden tokens by address if needed.
alter table public.indexed_tokens enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'indexed_tokens' and policyname = 'indexed_tokens_read') then
    create policy indexed_tokens_read on public.indexed_tokens for select using (true);
  end if;
end $$;

-- 3. Restore the four token rows deleted on 2026-09-08 (~09:09 UTC) as hidden = true, so the worker
--    sees them again. Values resolved on-chain / from Blockscout on 2026-09-08 (name/symbol from
--    the ERC-20, creator = launch creator, hook = the factory that launched the token).
--    `scripts/ops/restore-hidden-tokens.mjs --apply` does the same for any address list with fresh
--    on-chain data; this inline version needs no node.
insert into public.tokens (name, symbol, mint_address, creator_address, hook_address, hidden, created_at)
values
  ('122',  '111',      '0x5B01759839e36A475B46d50A2e245022198a50Cc', '0xba69Ca72CD2B87113471c4C38f08928761Edb5cE', '0x921d0be20a21e5a687734b4df6302ea55bd168c0', true, '2026-09-07T21:57:00Z'),
  ('1224', '1234',     '0x0fDadAFe6D99BfCe06Fb35c261E2B4E87BaF053b', null,                                         '0xc5ef9cb8c95cd8540e71b6d4c00a90257625a888', true, '2026-09-07T21:57:00Z'),
  ('Test', 'TESTING2', '0xfC577546689f4010d2da92235B6084F51FC8023E', '0xba69Ca72CD2B87113471c4C38f08928761Edb5cE', '0xc5ef9cb8c95cd8540e71b6d4c00a90257625a888', true, '2026-09-07T21:57:00Z'),
  ('Test', 'TEST',     '0x74bb410C8aa4a9F9cc024160b6368dD98b2F616e', '0xba69Ca72CD2B87113471c4C38f08928761Edb5cE', null,                                         true, '2026-09-07T21:57:00Z')
on conflict (mint_address) do update set hidden = true;
-- If `tokens.mint_address` has no unique constraint in your schema, replace the ON CONFLICT clause with
-- a WHERE NOT EXISTS guard (the restore script does this automatically).
