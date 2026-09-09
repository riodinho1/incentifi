# Robinhood Chain (4663) RPC endpoints and failover

Probed 2026-09-08 ~12:00 UTC from a residential connection. "2,000-block getLogs" = `eth_getLogs` on the legible hook over a 2,000-block window known to contain 5 logs (57 551 000 – 57 553 000); "eth_call" = `hook.owner()`. Latency is a single sample (median of 3 for `eth_chainId`).

| Endpoint | Source | eth_chainId | eth_getLogs 2,000 blocks | eth_call | Verdict |
|---|---|---|---|---|---|
| `https://rpc.mainnet.chain.robinhood.com` | official (docs: "rate-limited, not for production") | ok, 289 ms | ok (5 logs), 0.6–1.3 s | **429 Too Many Requests** during the probe | correct but rate-limited; returns non-JSON bodies under load (the viem `undefined (reading 'error')` crash) and dropped TLS on 2026-09-08 |
| `https://robinhood.api.pocket.network` | chainlist (Pocket) | ok, 1.2 s | ok (5 logs), 1.2–1.7 s | ok, 208 ms | **usable**; a 9,000-block range failed with a relay error (intermittent) |
| `https://rpc-robinhood.blockmachine.io` | chainlist | ok, 0.8 s | ok (14 logs over 9,000 blocks, 0.2–4.3 s) | ok, 1.1 s | **usable**; one connection timeout in three attempts |
| `https://robinhood-rpc.publicnode.com` (+ wss) | chainlist, ethereum-lists | ok, 1.4 s | **refused**: "Archive requests require a personal token" (even for blocks ~4 h old) | ok, 215 ms | calls/head only — fine as a last-resort fallback for `eth_call`, useless for discovery |
| `https://robinhood.rpc.blxrbdn.com` | chainlist (bloXroute, tracking) | ok, 320 ms | **403 Forbidden** (HTML) | ok, 2.0 s | calls only |
| `https://robinhood.drpc.org` | dRPC (docs list dRPC as a provider) | ok, 220 ms | method not available | method not available | only `eth_chainId` on the free tier — unusable |
| `https://lb.routeme.sh/rpc/evm/4663` | chainlist | rate limit exceeded | rate limit exceeded | rate limit exceeded | sign-up required |
| `https://rpc.nodeflare.app/robinhood/public` | chainlist | malformed error | malformed error | malformed error | broken |
| `https://rpc.arrowrpc.com` | ethereum-lists | HTML landing page | HTML | HTML | not an RPC |
| `https://rpc.ordofi.network` | ethereum-lists | ok, 9.7 s | ok, 10 s | connect timeout | too slow |
| `https://4663.rpc.thirdweb.com` | thirdweb pattern | "Invalid chain" | — | — | not supported |
| `https://rpc.ankr.com/robinhood` | Ankr pattern | 403 (needs key) | — | — | keyed only |
| `https://robinhood-mainnet.g.alchemy.com/v2/{KEY}` | docs: **recommended provider** | needs key | | | **recommended for production** (Alchemy is the documented primary provider; QuickNode `{endpoint}.robinhood-mainnet.quiknode.pro/{token}`, Blockdaemon and Validation Cloud are also listed) |

Official WebSocket: `wss://feed.mainnet.chain.robinhood.com`. Sequencer: `https://sequencer.mainnet.chain.robinhood.com`. Explorers: robinhoodchain.blockscout.com, robinscan.io, hoodscan.co, stonkscan.io.

## Recommended `RPC_URLS`

A keyed archive endpoint FIRST, public endpoints as fallbacks (see "Sustained operation needs a keyed endpoint" below — the public-only list was tried on 2026-09-09 and could not carry a discovery rescan):

```
RPC_URLS=https://robinhood-mainnet.g.alchemy.com/v2/<KEY>,https://rpc.mainnet.chain.robinhood.com,https://rpc-robinhood.blockmachine.io,https://robinhood.api.pocket.network,https://robinhood-rpc.publicnode.com
```

Pocket and Publicnode are treated as non-archive by default (`RPC_NON_ARCHIVE_URLS`): head reads only. Never commit keys; set them on Railway / Supabase.

## How failover works (`scripts/lib/rpcFailover.mjs`; gateway copy `supabase/functions/loss-reward-gateway/rpc-failover.mjs`)

- `RPC_URLS` (comma-separated) wins; otherwise the legacy single variable (`VITE_EVM_RPC_URL` / `EVM_RPC_URL` / `RPC_URL`); otherwise the official endpoint.
- The module owns the HTTP layer (an EIP-1193 provider behind viem's `custom` transport), so every failure is classified before viem sees it. **Rotate + per-endpoint exponential cooldown (2 s → 60 s)** on: non-JSON or malformed JSON-RPC bodies (the viem 2.55 `Cannot read properties of undefined (reading 'error')` case), HTTP 429/5xx, timeouts, connection/TLS errors, JSON-RPC rate-limit codes, "method not available", and publicnode's "Archive requests require a personal token". **Final** (thrown as viem's `RpcRequestError`, so revert data still decodes): execution reverts and other errors a node produced on purpose.
- `eth_sendRawTransaction` is re-sent on failure (the payload is already signed); a later "already known" is treated as success with `keccak256(rawTx)` as the hash.
- Every switch is logged: `[RPC] <service>: <url> failed (<reason>) -> switching to <url> (cooldown Ns on the failed endpoint)`; the active endpoint is announced on first use.
- Optional: `RPC_TIMEOUT_MS` (indexer/worker, default 20 000).

## Discovery warm-up (indexer)

`V4_DISCOVERY_CHUNK_BLOCKS` = 2 000 (was 5 000). Progress is persisted per factory in `indexer_cursors` (`supabase/indexer_cursors.sql`) after every chunk, and the discovered tokens live in `indexed_tokens`; on start the indexer rebuilds its caches from `indexed_tokens` and resumes from the cursors instead of rescanning from block 54 600 000. If either table is missing or a row is incomplete it falls back to the full rescan (always correct, just slow) and warns once. If a discovered token cannot be written to `indexed_tokens` (or its symbol cannot be read) the process keeps its in-memory cursors but stops persisting them, so the next restart rescans from the last cursor before that token instead of losing it. Deleting a cursor row forces a rescan of that factory.


## Sustained operation needs a keyed endpoint (2026-09-09)

**Plainly: the four public endpoints cannot carry this indexer.** On 2026-09-09 a discovery rescan from the floor (2,000-block `eth_getLogs` chunks, one at a time) was refused by every one of them: the official endpoint answered 429, Blockmachine answered 429, Pocket answered 500 `historical state is not available` (its relays are not archive nodes), and Publicnode requires an Allnodes personal token for anything older than a few blocks. The failover kept the process alive but produced no progress. Public endpoints are fine for **head reads** (the worker's balance and pool reads, the current window of trades); they are not fine for history.

Put a keyed archive endpoint **first** in `RPC_URLS` and keep the public ones as fallbacks. Verified to serve Robinhood Chain (chain id 4663) with archive data, pricing as published on 2026-09-09 (check before buying; free tiers are enough for this indexer's steady state of roughly 4 `eth_getLogs` + a few hundred `eth_call` per 10-second tick):

| Provider | Endpoint pattern | Archive | Free tier | Paid |
|---|---|---|---|---|
| **Alchemy** (Robinhood's documented primary provider) | `https://robinhood-mainnet.g.alchemy.com/v2/{KEY}` | yes | 30M compute units / month, 25 rps | pay-as-you-go $0.45 per 1M CU (first 300M), $0.40 after; Enterprise custom |
| **QuickNode** (listed in Robinhood's docs) | `https://{ENDPOINT}.robinhood-mainnet.quiknode.pro/{TOKEN}` | yes, all plans | 10M API credits, 15 rps | Build $49/mo (80M credits, 50 rps), Accelerate $249/mo (450M, 125 rps), Scale $499/mo, … |
| **Dwellir** | per-account endpoint (HTTPS + WSS), archive node from genesis | yes | 100K responses / day | $49/mo for 25M responses, $299/mo for 150M, $999/mo for 500M |
| **dRPC** (listed in Robinhood's docs) | per-account endpoint; the public `robinhood.drpc.org` only serves `eth_chainId` | yes (paid) | 210M CU / month (per Dwellir's comparison; unverified) | ~$6 per 1M requests (per the same comparison); Enterprise custom |
| **SolidRPC** | `https://rpc.solidrpc.io/{KEY}/evm/4663` | yes — "historical queries route to archive nodes automatically by block age, at no surcharge"; `debug_*` available | Free entry plan, account-wide quotas | fixed plans + PAYG (see solidrpc.io/docs/pricing) |
| **Allnodes / Publicnode personal token** | `https://robinhood-rpc.publicnode.com` with a personal token | yes ("Archive data available — Get Archive Access") | none for archive | not published on the endpoint or pricing pages we could fetch; request via the "Get Archive Access" link |
| **Validation Cloud**, **Blockdaemon** (listed in Robinhood's docs) | per-account | yes | Validation Cloud has a free tier | custom / enterprise |

Sources: docs.robinhood.com/chain/connecting; alchemy.com/pricing; quicknode.com/pricing; dwellir.com/blog/best-robinhood-chain-rpc-providers; solidrpc.io/docs/chains/robinhood-chain; robinhood.publicnode.com; allnodes.com/pricing.

### How the failover now treats endpoints (`scripts/lib/rpcFailover.mjs`)

- **Pacing:** `eth_getLogs` is serialised (concurrency 1) with a minimum interval between calls — `RPC_GETLOGS_MIN_INTERVAL_MS`, default 300 ms — across discovery, backfills and the live window.
- **Rate limits:** a 429/503 with `Retry-After` puts the endpoint on cooldown for at least that long; otherwise the per-endpoint cooldown doubles for failures that follow each other within 60 s (2 s → 4 s → … → `RPC_COOLDOWN_MAX_MS`, default 120 s) and is **not** reset by an intervening success.
- **Non-archive endpoints:** `RPC_NON_ARCHIVE_URLS` (default `robinhood.api.pocket.network,publicnode.com`) are skipped for *historical* requests — `eth_getLogs` ranges, or `eth_call`/`eth_getBalance`/… with a block tag, older than `RPC_HISTORY_DEPTH_BLOCKS` (256) behind the last head seen — and kept for head reads. An endpoint that answers "historical state is not available" / "Archive requests require …" is marked non-archive at runtime. If every configured endpoint is non-archive, a historical request fails immediately with a message saying so instead of burning retries.

### Indexer: trade indexing is no longer blocked behind discovery

Trades of every **known** pool are indexed every tick; V4 discovery runs in the background one pass at a time; a token discovered later whose launch is at or before the trade cursor is **backfilled** from its launch block (poolId-filtered `eth_getLogs`) before the next window, and its live logs are held back until then. The heartbeat stays `ok` and notes `V4 discovery behind (...)` while the scan catches up. `V4_DISCOVERY_BLOCKING=true` restores the old hard precondition. The worker's balance and pool reads never depended on discovery (direct RPC, freshness gate on the heartbeat's age).

### Cursor seed after an outage

`supabase/seed_indexer_cursors_2026-09-09.sql` seeds both cursors to block 57,958,935 (last block before 20:00 UTC on 2026-09-08, three hours before the indexer's last healthy heartbeat), then restart the indexer. The cursors are read only at process start and adopted only when every V4 row in `indexed_tokens` is complete.
