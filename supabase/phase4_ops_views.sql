-- Optional ops views for dashboards and quick SQL checks.

create or replace view public.v_market_health as
select
  s.symbol,
  s.mint_address,
  s.price_sol,
  s.volume_24h_sol,
  s.updated_at as snapshot_updated_at,
  h.worker_name,
  h.status as indexer_status,
  h.updated_at as heartbeat_updated_at,
  extract(epoch from (now() - h.updated_at))::bigint as heartbeat_age_seconds
from public.token_market_snapshots s
left join public.indexer_heartbeats h
  on h.symbol = s.symbol;

create or replace view public.v_trade_verification_failures as
select
  v.symbol,
  v.signature,
  v.verify_error,
  v.verified_at
from public.token_trade_verifications v
where v.verified = false
order by v.verified_at desc;
