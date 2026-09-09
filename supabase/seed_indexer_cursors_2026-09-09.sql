-- Seed the V4 discovery cursors so the indexer resumes from a recent, safe block instead of rescanning
-- from the floors (54,600,000 generic-sell / 56,911,900 legible) through rate-limited public RPCs.
--
-- Safe block: 57,958,935 = the last block before 20:00:00 UTC on 2026-09-08 (block 57,958,936 has
-- timestamp 2026-09-08T20:00:00Z; computed by binary search over eth_getBlockByNumber timestamps).
-- The indexer was healthy (heartbeat "ok", discovery complete) until ~22:58 UTC that day, so every
-- TokenLaunched at or before this block is already in `indexed_tokens` (10 rows, all with pool_id,
-- hook_address and symbol; the two launches after it - INCENTIFI @58,005,765 and DHT @58,014,875 -
-- are rediscovered by the scan that starts at 57,958,936). Three hours of margin.
--
-- Cursor semantics (scripts/evm-indexer.mjs restoreDiscoveryState): `block` = last block FULLY
-- scanned for that factory; scanning resumes at block + 1. Both names are read at process start ONLY,
-- and only adopted when every V4 row of indexed_tokens is complete - so run this, then RESTART the
-- indexer. greatest(...) never moves a cursor backwards if a scan has already gone further.
insert into public.indexer_cursors (name, block, updated_at)
values
  ('v4_discovery_generic_sell', 57958935, now()),
  ('v4_discovery_legible',      57958935, now())
on conflict (name) do update
  set block = greatest(public.indexer_cursors.block, excluded.block),
      updated_at = now();

-- Verify:
-- select * from public.indexer_cursors;
-- select mint_address, symbol, venue, first_block from public.indexed_tokens order by first_block;
