# Incentifi

Incentifi is a token launchpad on **Robinhood Chain** (chain id `4663`). Anyone can launch a
fixed-supply token onto a bonding curve, and every trade pays a **2% fee** that is split in two:

- **1% to the token's creator**, as a pull payment the creator claims.
- **1% to a Loss Reward Pool**, which pays holders who are sitting on an unrealised loss.

Every five minutes an off-chain worker snapshots each token, finds the holders whose average cost
is above the current price, and publishes a Merkle root on-chain that lets each of them claim
**10% of their unrealised loss** from that token's pool. A creator can choose to have those rewards
paid in **ETH** or in a **Robinhood stock token** (NVDA, GOOGL, …) bought at the moment of the claim.

This README is mostly about the contracts. The web app, indexer and worker are summarised at the end.

---

## How money moves

```
 trader ── swap (2% fee) ──► Uniswap V4 pool (IncentifiV4LegibleHook owns the liquidity)
                                   │
                  hook.collect(token)   ◄── anyone may call; the worker does it automatically
                                   │
        ┌──────────────────────────┴───────────────────────────┐
   ETH-side fees                                         token-side fees
        │                                                       │
   50% creatorBalances[creator]                  IncentifiFeeConverter.convert()
   50% LossRewardPool.depositReward(token)       sells them into the same pool, then
                                                 splits the ETH 50/50 the same way
                                   │
              LossRewardPoolV2 (per-token ETH ledger)
                                   │
   operator: setEpochMerkleRoot(token, epochId, root, allocated)      every 5 minutes
                                   │
   holder:  claimReward / claimBatch            → paid in ETH
            claimRewardAs / claimBatchAs        → ETH spent on the chosen stock, stock sent to holder
```

---

## Contracts

All sources are under [contracts/](contracts/). Solidity `^0.8.26`, Uniswap V4 core and periphery.

### Live deployment (Robinhood Chain, 4663)

| Contract | Address | Source |
|---|---|---|
| IncentifiV4LegibleHook | `0x921d0bE20A21e5A687734b4dF6302EA55BD168C0` | [contracts/v4/legible/IncentifiV4LegibleHook.sol](contracts/v4/legible/IncentifiV4LegibleHook.sol) |
| IncentifiV4LegibleFactory | `0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda` | [contracts/v4/legible/IncentifiV4LegibleFactory.sol](contracts/v4/legible/IncentifiV4LegibleFactory.sol) |
| IncentifiFeeConverter | `0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9` | [contracts/v4/legible/IncentifiFeeConverter.sol](contracts/v4/legible/IncentifiFeeConverter.sol) |
| LossRewardPoolV2 | `0x5d94246CD31064Da02E953DB357F0001F0E9A631` | [contracts/loss-reward/LossRewardPoolV2.sol](contracts/loss-reward/LossRewardPoolV2.sol) |
| RewardSwapperUniswapV3 | `0xEDe37d70Ca99E25D501c780D6Ed24307C63A3aDe` | [contracts/loss-reward/RewardSwapperUniswapV3.sol](contracts/loss-reward/RewardSwapperUniswapV3.sol) |
| LossRewardPool (V1, legacy) | `0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF` | [contracts/LossRewardPool.sol](contracts/LossRewardPool.sol) |

Uniswap infrastructure the contracts build on: PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`,
StateView `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`, V4 Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`,
UniversalRouter `0x8876789976dEcBfCbBbe364623C63652db8C0904`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`.

Owner of the hook, factory, converter and both pools: `0x78a4E4BCC8ab559B6d3B1Cb9eab0A04a2411c726`.
Operator (publishes epochs, sends `collect`/`convert`): `0x743F4fD6ca1C65654e6825a2E0fC7147c17531E3`.

### 1. IncentifiLaunchToken

[contracts/IncentifiLaunchToken.sol](contracts/IncentifiLaunchToken.sol) — a minimal ERC-20: 18 decimals, the whole supply minted once to
the deployer in the constructor. No mint, no burn, no owner, no blacklist, no transfer tax. Every
launch is exactly **1,000,000,000** tokens.

### 2. IncentifiV4LegibleFactory — launching

`launchToken(token)` / `launchToken(token, rewardAsset)`:

1. pulls the full 1B supply from the caller (`transferFrom`),
2. registers the token and its creator on the hook,
3. initialises a Uniswap V4 pool — native ETH / token, **dynamic fee**, tick spacing **10**,
4. has the hook seed the curve position, and
5. if a reward asset was given, records it on LossRewardPoolV2 (one-time choice, see below).

`getPoolKey(token)` and `isLaunched(token)` are the lookups every client uses. It emits
`TokenLaunched(token, creator, poolId)`, which the indexer discovers tokens from.

### 3. IncentifiV4LegibleHook — the bonding curve as a real Uniswap position

The classic launchpad curve `(VE + E) · (VT + T) = K` is a constant-product segment, which is
exactly a Uniswap range position. So instead of a hook that fakes swaps, the curve **is** one real
position owned by the hook, and every generic tool (DexScreener, any V4 router or quoter, trading
bots) sees a normal pool with real liquidity and real `Swap` events.

| Constant | Value |
|---|---|
| `TOTAL_SUPPLY` | 1,000,000,000 tokens |
| `VIRTUAL_ETH` / `VIRTUAL_TOKEN` | 2.15625 ETH / 78,125,000 tokens |
| `INVARIANT_K` | `VIRTUAL_ETH × (VIRTUAL_TOKEN + TOTAL_SUPPLY)` |
| `CURVE_LIQUIDITY` | `48215215764839215328822` (= √K) |
| `TICK_UPPER` (launch price) | `200310` — 500,000,000 tokens per ETH |
| `TICK_LOWER` (graduation price) | `174070` — about 36,231,884 tokens per ETH |
| `GRADUATION_ETH_TARGET` | 5.853863234375 ETH |
| Fee before graduation | 20,000 pips = **2%** |
| Fee after graduation | 2% by default; owner may lower it per token, **never above 2%** |

What it does:

- **Seeds the curve.** About 787.9M tokens go into the curve position; about 212.1M are held back
  for graduation.
- **Charges the fee as an ordinary dynamic LP fee.** `beforeSwap` returns a fee override and the
  PoolManager accounts for it natively. The hook never returns a swap delta, so it is never a swap
  counterparty and there is nothing for a router or quoter to mis-simulate. Permission mask
  `0x28C0`: `beforeInitialize | beforeAddLiquidity | beforeSwap | afterSwap`.
- **Graduates automatically.** When buys push the price to the curve's lower bound the position is
  100% ETH. In that same transaction `afterSwap` removes it and redeploys the ETH plus the held-back
  tokens as **full-range** liquidity. A permissionless `graduate(token)` exists as an idempotent
  fallback. The 2% fee continues after graduation, so the loss pool keeps being funded.
- **Gates liquidity.** Only the hook can add liquidity — always before graduation, and afterwards
  unless the owner opens it per token (`setLpOpen`). Nobody holds an LP token that could be pulled.
- **Collects and splits fees.** `collect(token)` is permissionless. ETH-side fees go 50% to
  `creatorBalances[creator]` and 50% to the loss pool through `depositReward(token)`. Token-side
  fees are forwarded to the fee converter.
- **Pays creators by pull.** `claimCreatorFees()` sends the caller their accrued balance.
- **Stays indexer-compatible.** `Bought` and `Sold` are emitted from `afterSwap` with the same
  fields as the older hooks, and `curveStates(poolId)` keeps the legacy six-field shape.

Owner powers are deliberately narrow: `setPostGraduationFee` (0 to 2%), `setLpOpen`,
`setLossRewardPool` (must be a contract), `transferOwnership`. There is no function that withdraws
pool liquidity, trader funds or another creator's fees.

### 4. IncentifiFeeConverter — token-side fees become ETH

Sell-side fees accrue in the launched token. `convert(token, amount, minEthOut)` is permissionless:
it sells the pending tokens into the same pool as an ordinary trade and splits the ETH 50/50 between
the creator and the loss pool. It is sandwich-resistant by construction — the hook records a price
checkpoint, and the conversion reverts with `SlippageExceeded` if the output is more than
`MAX_SLIPPAGE_BPS` = 3% below `checkpointEthValue(token, amount)`. The converter's own swap is
fee-free so fees are not charged on fees.

### 5. LossRewardPoolV2 — the reward ledger

A per-token ETH ledger with Merkle-proof claims.

**Accounting (all `public`):** `totalDeposited[token]`, `totalAllocated[token]`,
`totalClaimed[token]`, `epochMerkleRoots[token][epochId]`, `epochAllocatedAmounts[token][epochId]`,
`hasClaimed[token][epochId][claimant]`, and `getUnallocatedBalance(token)` = deposited − allocated.

The invariant, enforced in code and checked against mainnet to the wei:

```
claims ≤ Σ allocations ≤ deposits          (per token)
address(this).balance == Σ over tokens of (totalDeposited − totalClaimed)
```

- `receive()` **reverts** — bare ETH cannot be attributed to a token, so it is refused.
- `depositReward(token)` is the only way ETH enters. Zero amount and zero address revert.
- `setEpochMerkleRoot(token, epochId, root, allocatedAmount)` — operator or owner only. Reverts on a
  zero root, on an epoch that is already published, and if `allocatedAmount` exceeds the token's
  unallocated balance. **A published epoch can never be changed or withdrawn.**
- A per-epoch claimed cap (`EpochOverClaimed`) means a bad root can never pay out more than was
  allocated to that epoch.

**Leaf format** (double-hashed, OpenZeppelin-style sorted-pair proofs):

```solidity
keccak256(bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount))))
```

The claimant is **`msg.sender`**. A claim cannot be relayed by a third party — the holder's own
wallet must send it, and the payout goes to that wallet.

**Claiming**

| Function | Use |
|---|---|
| `claimReward(token, epochId, amount, proof)` | one epoch, V1-compatible signature |
| `claimBatch(token, epochIds, amounts, proofs)` | many epochs, one transaction |
| `claimRewardAs(…, minAssetOut, deadline)` | one epoch of a stock-paying token |
| `claimBatchAs(…, minAssetOut, deadline)` | many epochs of a stock-paying token |

If the token's effective payout is a stock, the V1-style functions revert with `UseClaimAs()`,
because only the `…As` variants carry the claimant's own slippage bound and deadline.

**Stock payouts.** A creator may pick a payout asset **once**, at launch (`setRewardAsset`, callable
by an approved setter such as the factory). At claim time the claimant's ETH allocation is spent
buying that stock and the claimant receives whatever it buys. There is no dollar-value promise, no
oracle price and no shortfall liability. **The pool never holds stock**: the swap adapter delivers it
from the Uniswap pool straight to the claimant. Stock tokens are pausable and block-listable by
their issuer, so custody would be a liability.

An asset is selectable only if it round-trips through Robinhood's on-chain stock registry
(`uid()` ↔ `tokenAddress()`) and the owner has configured an enabled route for it:
`AssetRoute { swapper, pool, fee, twapWindow, maxDeviationBps, enabled }`.

The swap is bounded twice: by the protocol floor (`referenceOut` from the pool's TWAP, minus
`maxDeviationBps`) and by the claimant's `minAssetOut`; the larger of the two applies.

**ETH fallback.** If the stock cannot be delivered the claimant is paid the ETH instead, and
`RewardPaidInEthFallback(claimant, token, asset, reason, data)` records why:

| Reason | Meaning |
|---|---|
| `ForcedEth` | owner forced this token to ETH (`forceEthPayout`, one-way) |
| `AssetDisabled` | no enabled route for the asset |
| `RegistryMismatch` | the registry round-trip failed at claim time |
| `AssetPaused` | the stock token or the registry is paused |
| `ClaimantBlocked` | the registry blocks the claimant; a transfer would revert |
| `NoLiquidity` | empty pool or zero reference |
| `ReferenceUnavailable` | the TWAP could not be read |
| `BelowMinimum` | batch total below `minStockRewardWei` (0.002 ETH) |
| `BelowProtocolBound` | the swap missed the **protocol's** floor |
| `SwapFailed` | any other revert from the adapter, pool or token |

One case deliberately does **not** fall back: if the claimant's *own* `minAssetOut` was the binding
bound, the claim reverts with `MinOutNotMet(amountOut, minAssetOut)`. That bound is the user's
choice, so the user retries rather than being silently paid in a different asset.

**Owner powers:** `setAssetRoute`, `setAssetEnabled`, `setAssetSetter`, `setMinStockReward`,
`forceEthPayout`, `setOperator`, `transferOwnership`. **There is no function that withdraws ETH.**
Deposited ETH leaves only through a holder's Merkle claim.

### 6. RewardSwapperUniswapV3 — the stock swap adapter

Callable only by the loss reward pool. `swap` wraps the ETH it receives as `msg.value`, swaps
WETH → stock on a Uniswap **V3** pool in which WETH must be `token0`, and sends the stock directly to
the recipient. Because the ETH travels in the same call as the swap, a caught revert returns it to
the pool atomically. It reverts with `InsufficientOutput` below the minimum and with
`ResidualBalance` if it would be left holding anything. Views: `validateRoute` (the pool really is
the V3 factory's pool for that pair and fee), `poolLiquidity`, and `referenceOut` (TWAP reference,
falling back to a 600-second window).

### 7. LossRewardPool (V1) — legacy

The same ledger, leaf format and operator model, ETH payouts only, and it accepts bare ETH. It still
holds balances for the earliest test tokens. New tokens use V2; the worker drains a token's V1
balance first and then moves to V2.

### 8. Older launch paths (kept for the tokens bound to them)

A pool's hook is immutable, so tokens stay on the contracts they launched with.

| Generation | Contracts | Status |
|---|---|---|
| V3 bonding curve | [IncentifiBondingCurve](contracts/IncentifiBondingCurve.sol), [Factory](contracts/IncentifiBondingCurveFactory.sol), [SwapRouter](contracts/IncentifiSwapRouter.sol) | per-token curve contract, graduates into Uniswap V3 |
| V4, first mainnet test | [IncentifiV4Hook](contracts/v4/IncentifiV4Hook.sol) | legacy, see [docs/V4_LEGACY_TOKENS.md](docs/V4_LEGACY_TOKENS.md) |
| V4, no post-graduation fee | [IncentifiV4HookNoPostGradFee](contracts/v4/IncentifiV4HookNoPostGradFee.sol) | legacy; pre-graduation trades only through its own router |
| V4, GenericSell | [IncentifiV4HookGenericSell](contracts/v4/IncentifiV4HookGenericSell.sol), [Factory](contracts/v4/IncentifiV4Factory.sol), [Router](contracts/v4/IncentifiV4Router.sol) | still trades; ERC-6909 claims-based sell intake so generic routers work |
| **V4, legible** | section 2–4 above | **current launch path** |

---

## Trust model, in plain terms

- **Token:** fixed supply, no mint, no blacklist, no transfer hook.
- **Liquidity:** owned by the hook contract, not by a wallet. No code path removes it to an address.
- **Fees:** capped at 2%, split 1% / 1%, the owner can only lower the post-graduation fee.
- **Loss pool:** no withdraw function. The operator can only *allocate* a token's own deposits to a
  Merkle root; it cannot move ETH out. The per-epoch cap limits the damage of a wrong root to that
  epoch's allocation.
- **What is off-chain and therefore trusted:** who is "underwater" and by how much. Cost basis is
  computed by the indexer from on-chain trades and turned into Merkle leaves by the worker. The
  contract enforces the totals, not the fairness of the split.
- **Known operational dependency:** the operator wallet pays gas for every epoch and every
  `collect`/`convert`. If it runs dry, publishing and fee collection stop silently.
- The owner is a single externally-owned account by the project's own choice; see
  [docs/AUDIT_2026-09-08.md](docs/AUDIT_2026-09-08.md).

---

## The rest of the app

| Part | Where | What it does |
|---|---|---|
| Web app | [src/](src/) — React + Vite + viem | launch page, token page with buy/sell, Creator Fees card, Loss Reward panel with claim |
| Indexer | [scripts/evm-indexer.mjs](scripts/evm-indexer.mjs) | discovers launches, indexes `Bought`/`Sold` into trades, candles and per-holder cost basis; reconciles balances against the chain |
| Worker | [scripts/loss-reward-worker.mjs](scripts/loss-reward-worker.mjs) | every 5 minutes: snapshot, build the Merkle tree, publish the epoch, auto `collect()`/`convert()` when worth the gas |
| Gateway | [supabase/functions/loss-reward-gateway/](supabase/functions/loss-reward-gateway/) | authenticated API that serves a wallet its own proofs |
| Daemon | [scripts/daemon.mjs](scripts/daemon.mjs) | runs indexer and worker together (`npm run daemon`) |
| Ops | [scripts/ops/](scripts/ops/) | deploy runbook, stock route config, legacy-token sell planner (`v4-legacy-sell.mjs`), read-only pool audit (`audit-loss-pool.mjs`: event scan vs on-chain counters, to-the-wei reconciliation, underwater holders) |

Both services accept a comma-separated `RPC_URLS` with failover; public endpoints alone cannot
carry them — see [docs/RPC_ENDPOINTS.md](docs/RPC_ENDPOINTS.md).

### Running it

```bash
npm install
npm run dev          # web app
npm run daemon       # indexer + worker (needs Supabase and RPC env vars)
npm test             # offline node test suites
npm run test:fork -- <file>     # hardhat tests against a Robinhood Chain fork
forge test                      # Foundry suites in test/foundry
```

Configuration lives in environment variables (`VITE_*` for the site, `RPC_URLS`,
`SUPABASE_SERVICE_ROLE_KEY`, `LOSS_REWARD_POOL_V2_ADDRESS`, `OPERATOR_PRIVATE_KEY` for the services).
Keys are read from the environment only and are never committed.

### Further reading

- [docs/V4_LEGIBLE_POOL_DESIGN.md](docs/V4_LEGIBLE_POOL_DESIGN.md) — why the curve is a real position, with the maths
- [docs/LOSS_REWARD_ASSET_DESIGN.md](docs/LOSS_REWARD_ASSET_DESIGN.md) — stock payouts, rollout and operations log
- [docs/AUDIT_2026-09-08.md](docs/AUDIT_2026-09-08.md) — system audit and remediation
- [docs/V4_LEGACY_TOKENS.md](docs/V4_LEGACY_TOKENS.md) — hook generations and selling legacy tokens
