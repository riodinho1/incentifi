# Selling a legacy V4 token (one the site no longer resolves)

Three V4 hook generations have been deployed on Robinhood Chain; only the last two are known to the
site and indexer (`src/lib/uniswapAddresses.ts`, `src/lib/tokenVenue.ts`):

| Generation | Factory | Hook | Tokens |
|---|---|---|---|
| 1 — first mainnet test (with post-grad fee) | `0xe003e8db9d8db61dbf3e7fa813eebf51029ada27` | `0x76E8A2883379fA6507329d91f298D479Ba636888` (loss pool `0x8bB63d98…`) | **V4MAINTEST** `0x5e7CCb5Bb351018918427A7A4fa05F33103E33A0` (launched block 54,147,327, graduated) |
| 2 — NoPostGradFee | `0xdEca2efDB578B6E5F298885b97F64d52f92f5Aa9` | `0x5bBcf2CDAAA00c285eEc903AA1E2aB9142782888` | TESTTT, TESST, TESTING |
| 3 — GenericSell (current) | `0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0` | `0xC5Ef9Cb8c95cd8540E71b6D4c00a90257625a888` | current launches |
| legible (current) | `0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda` | `0x921d0bE20A21e5A687734b4dF6302EA55BD168C0` | current launches |

A pool's hook is immutable, so a generation-1 token can never move to a newer hook. It is not
stranded though: once **graduated**, an Incentifi V4 pool is a plain Uniswap V4 pool for swaps, the V4
Quoter prices it and Uniswap's **UniversalRouter** sells it — the same `V4_SWAP` path the site uses for
legible tokens. What does *not* work: IncentifiV4Router (pre-graduation only), the wallet app's swap
("No quotes available": its aggregator has no route to a hooked V4 pool), and the site's token page
(the venue resolver does not know the factory).

## `scripts/ops/v4-legacy-sell.mjs` — read-only planner

```
RPC_URLS=https://rpc-robinhood.blockmachine.io,https://robinhood.api.pocket.network,https://rpc.mainnet.chain.robinhood.com \
node scripts/ops/v4-legacy-sell.mjs --token 0x5e7CCb5Bb351018918427A7A4fa05F33103E33A0 \
  --wallet 0x78a4E4BCC8ab559B6d3B1Cb9eab0A04a2411c726 --slippage 2 --account incentifi-owner \
  --rpc https://rpc.mainnet.chain.robinhood.com
```

It finds the launch (deployment block by `eth_getCode` binary search, then the 1B-token transfer into
the factory; the receipt carries `TokenLaunched` and PoolManager `Initialize`), reads the pool key,
graduation flag, tick and liquidity, quotes the requested amount plus 10 % and 1 % of the balance
(price impact), computes `minOut` from `--slippage`, checks the two approvals (token → Permit2,
Permit2 → UniversalRouter), simulates the swap from the wallet when they are in place, and prints
three `cast send … --account <keystore>` commands. It never signs or reads a key. `RPC_URLS` needs one
archive-capable endpoint for the launch lookup (or pass `--factory`); `--rpc` is only the URL written
into the commands. Re-run it after the approvals to see the simulation, and re-run it if the printed
deadline (24 h) has passed — the calldata embeds amount, minOut and deadline.

## V4MAINTEST on 2026-09-15 (owner wallet `0x78a4…c726`, 787,903,505.84 tokens = 78.8 % of supply)

| Sell | ETH out (quoted) |
|---|---|
| 1 % of the balance | 0.004193 |
| 10 % | 0.031712 |
| **100 %** | **0.092246** (min 0.090401 at 2 % slippage) |

The pool's ETH is essentially what the graduation left in it (~0.117 ETH recorded), so selling
everything drains it at a steep price impact — the full sale returns ~0.092 ETH; the wallet's
0.0179 ETH covers gas for the three transactions. Test: `test/v4-legacy-sell.test.mjs`.
