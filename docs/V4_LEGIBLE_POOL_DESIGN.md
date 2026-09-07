# V4 "Legible Pool" Redesign — Design Doc (pre-Solidity)

**Status:** DRAFT for review. No contracts written yet; this doc is the gate.
**Goal:** make pre-graduation Incentifi V4 tokens tradable on generic terminals (GMGN, Axiom, DexScreener-fed tools) *without* per-terminal integration, while leaving the loss-reward economics and payout path unchanged.

---

## 1. Why terminals can't see us today (measured 2026-09-07)

The current hook (`IncentifiV4HookGenericSell`) *is* the AMM: `beforeSwap` computes the whole trade on virtual reserves and absorbs it via `beforeSwapReturnDelta`. PoolManager holds **no** liquidity. To every generic V4 indexer/router the pool is dead:

| Signal | TESTINGG (live) | Normal V4 pool on Robinhood (Index/ETH) |
|---|---|---|
| `StateView.getLiquidity(poolId)` | **0** | > 0 |
| PoolManager `Swap` event on a real sell | `amount0 = 0, amount1 = 0, liquidity = 0`, price unchanged, `fee = 0` | real amounts, price moves |
| DexScreener `/latest/dex/pairs/robinhood/<id>` | **0 pairs** (by token and by poolId) | indexed, $1.06M liquidity, volume |

Execution and pricing already work for any generic caller — Uniswap's canonical **V4 Quoter** (`0x8dc178efb8111bb0973dd9d722ebeff267c98f94`) quotes TESTINGG correctly (0.01 ETH → 4,710,057 tokens, matching the hook's math to the token), and a third-party Telegram bot sells through UniversalRouter. **Discovery is the only blocker**, and it is structural. GMGN lists other Robinhood launchpads (Flapstock, flap.sh, klik, Noxa) via explicit per-launchpad integration — the pump.fun model. This redesign removes the need for that.

## 2. Non-goals / invariants

- **Reward path unchanged:** 1% creator + 1% loss-pool per trade, same `LossRewardPool`, same `depositReward(token)`, same `holder_cost_basis` → epochs → Merkle → wallet-signed claims.
- **Curve economics unchanged:** same price path $5k → $69k, same 5.853863 ETH to graduation, same tokens sold (proven in §4).
- **Indexer/worker/frontend/infra shape unchanged** (see §8). `Bought`/`Sold` events preserved field-for-field.
- **Do NOT couple** "become visible" with "start charging after graduation" (§6 — one-way door).

## 3. Design

### 3.1 Pool
- `PoolKey { currency0: ETH (address(0)), currency1: token, fee: DYNAMIC_FEE_FLAG (0x800000), tickSpacing: 1, hooks: new hook }`.
- Initialized at `sqrtPriceX96 = √(5e8)·2⁹⁶ = 1771595571817166965907191352733264` — the exact launch price today's hook uses (tick 200,311.2).

### 3.2 The curve **is** a real position (mechanism A, not hook deltas)
The virtual-reserve curve `(VE+E)(VT+T) = K` is a constant-product segment, i.e. exactly a Uniswap range position. The factory mints **one** position, owned and locked by the hook:

| Parameter | Value | Derivation |
|---|---|---|
| Liquidity `L` | **48215215764839215328822** | `√K`, `K = VE·(VT+SUPPLY) = 2.32470703125e45` (exact) |
| Range (Uniswap price = tokens/ETH) | `[q_g, q₀] = [36,231,884.08, 500,000,000]` | `q₀ = (VT+SUPPLY)/VE`, `q_g = (K/(VE+GRAD_ETH))/(VE+GRAD_ETH)` |
| Ticks (spacing 1) | **lower 174,064 · upper 200,311** | `log₁.₀₀₀₁(q)`, rounded inward; bound error ≤ 0.008% |
| Token side at launch (token1) | **787,903,505.843 tokens** | `L(√q₀ − √q_g)` |
| ETH to traverse (token0) | **5.853863234 ETH** | `L(1/√q_g − 1/√q₀)` = `GRADUATION_ETH_TARGET` exactly |
| Held back in hook custody | **212,096,494.157 tokens** | `SUPPLY − 787.9M` = exactly the tokens that pair with 5.8539 ETH at `P_g` |

At launch the price sits at the range's upper bound, so the position is 100% token; buys walk the price down through the range converting tokens to ETH inside the position; at the lower bound the position is 100% ETH = graduation. Same numbers as today, but now `getLiquidity > 0`, `Swap` events carry real amounts, and price moves — everything generic infrastructure keys on.

### 3.3 Fees as **LP fees**, then collected (mechanism A)
- `beforeSwap` returns `lpFeeOverride = 20_000 (2%) | OVERRIDE_FEE_FLAG` while pre-graduation; **no** `BeforeSwapDelta`, no `afterSwapReturnDelta`. The hook is never a swap counterparty → nothing for a router or quoter to mis-simulate.
- Fees accrue to the hook's position natively. `collect()` (hook calls `modifyLiquidity(liquidityDelta = 0)` and takes `feesAccrued`) splits **ETH-side** fees 50/50: `creatorBalances[creator] +=` (pull-payment, existing `claimCreatorFees()` UX) and `LossRewardPool.depositReward{value}(token)`.
- **Token-side fees** (sell-side fees accrue in the input token): forwarded to a small `FeeConverter` contract with a permissionless `convert(token)` that sells them into the same pool as an ordinary trade (indexed, fee-paying) and deposits the ETH 50/50 the same way. This keeps sell-side fees funding the loss pool in ETH, which today's design does; the alternative — burning the token side (Brew) — is simpler but would halve loss-pool inflow to buy-side only (TESTINGG's volume tonight was ~50/50). **Open decision A** (§7).
- Collection cadence: on every graduation, on `claimCreatorFees()`, and via permissionless `collect(token)`.

### 3.4 Liquidity gating (security)
- `beforeAddLiquidity`: revert unless `sender == hook`. Pre-graduation **always** (anyone else adding liquidity breaks curve semantics and lets them front-run graduation). Post-graduation governed by `lpOpen[token]` (default **false** → no fee dilution; opening it is a deliberate later choice — **open decision C**).
- Others cannot remove the hook's position (ownership is by `(owner, tickLower, tickUpper, salt)`), so no `beforeRemoveLiquidity` guard is needed.

### 3.5 Graduation state machine (the one new piece)
- **Where the ETH lives:** inside the curve position, accumulating as buyers walk the price down. Not in hook custody.
- **Trigger:** `afterSwap` checks `poolTick ≤ tickLower` (position fully converted to ETH) and `!graduated`. Executed **in the same call** — no external trigger to forget, nothing to grief (idempotent, no parameters). A permissionless `graduate(token)` exists only as a fallback.
- **Action:** remove the curve position (≈ 5.8539 ETH + accrued fees); `collect()` fees; pair the 5.8539 ETH with the 212.1M reserve tokens into a **full-range** position owned and locked by the hook at `P_g` (identical to today's graduation seeding); set `graduated`, emit `Graduated`.
- **Edge cases:** the pool has no liquidity below `tickLower`, so a swap that would overshoot stops at the bound (partial fill) — "crossing" means reaching it, which is a trade, which fires `afterSwap`. A swap landing exactly on the bound graduates too. Deltas created by the hook's own `modifyLiquidity` inside `afterSwap` must be settled by the hook within the unlock — **this is the settlement-order class of bug we already had once; it gets the heaviest test coverage.**

### 3.6 Post-graduation fee: a governed parameter, default **0**
`postGradFeePips[token]` (hook-owned, settable by owner, **zero allowed**), returned as the dynamic override after graduation. Ships at 0. See §6.

### 3.7 Hook permissions
`beforeInitialize (bit 13) · beforeAddLiquidity (11) · beforeSwap (7) · afterSwap (6)` → mask **`0x28C0`**. No return-delta bits — that is the whole point. CREATE2 salt mined for this mask (same tooling as tonight's deploy).

### 3.8 Events (indexer compatibility)
`Bought(poolId, trader=tx.origin, ethIn (gross), tokensOut, creatorFee, lossPoolFee)` and `Sold(poolId, trader=tx.origin, tokensIn, ethOut (net), creatorFee, lossPoolFee)` emitted from `afterSwap`, computed from the swap delta and the fee rate — **same fields, same semantics** as today, so `scripts/evm-indexer.mjs` (Fix 1) needs **no change**. One nuance: for sells the fee is denominated in tokens on-chain; the event reports its ETH-equivalent at the trade price (the fields are ETH-denominated today), which is what `token_trades_evm.loss_pool_fee_eth` expects.

## 4. Numeric proof (exact arithmetic, `node`)
```
K == VE*(VT+SUPPLY): true
L = sqrt(K) = 48215215764839215328822   (|L²−K|/K = 3e-23)
q0 = 500000000 tokens/ETH -> tick 200311.201   (live TESTINGG slot0 tick = 200311)
qg = 36231884.078 tokens/ETH -> tick 174063.203
P0 = 2.000000e-9 ETH/token, Pg = 2.760000e-8, ratio 13.8000
position token1 = 787903505.843  == curve tokens sold to graduation (rel diff 1.5e-16)
position token0 = 5.853863234 ETH == GRADUATION_ETH_TARGET (rel diff 0)
hook reserve   = 212096494.157  == tokens pairing 5.853863 ETH at Pg (rel diff 8e-16)
tick-aligned bounds (spacing 1): [174064, 200311] -> bound price error ≤ 0.0020% / 0.0080%
mcap: $5000 at launch, $69000 at graduation
```

## 5. Legibility acceptance test (empirical, before any cutover)
Launch a throwaway token on the new trio on mainnet and confirm, in order: (1) `getLiquidity > 0`, `Swap` events with real amounts, moving `slot0`; (2) V4 Quoter quote == UniversalRouter execution for a buy **and** a sell; (3) DexScreener indexes the pair (automatic for real V4 liquidity — control pool confirmed); (4) the token appears and **trades** on GMGN and Axiom. Only after (4): consider §6.

## 6. The one-way door: decouple visibility from post-graduation fees
Hooks are immutable per pool. Ship with `postGradFeePips = 0` and `lpOpen = false`; run §5; then flip the fee on (a storage write, no redeploy). Rationale for eventually charging: a hook fee is enforced on every path, whereas today's V3 post-grad fee is bypassed by anyone trading the Uniswap pool directly. Close that inconsistency in step two, not step one.

## 7. Open decisions (need an answer before Solidity)
| | Options | Recommendation |
|---|---|---|
| **A. Token-side (sell) fees** | convert to ETH via `FeeConverter` (keeps loss-pool funding whole) · burn (simplest, halves loss-pool inflow) | **Convert** — a separate small contract, permissionless, ordinary indexed trades; hook stays minimal |
| **B. Router** | drop `IncentifiV4Router` and trade through UniversalRouter like everyone else · keep a thin router | **Drop** — one fewer deploy, and it forces us to eat the same path terminals use |
| **C. Post-grad LP gating** | keep gated (no fee dilution) · open (external LPs share fees) | **Keep gated** at launch; revisit with §6 |
| **D. Post-grad fee level** | 0 · 1%/1% · governed | **Governed, default 0** (non-negotiable per §6) |

## 8. What changes / what doesn't
| Layer | Change |
|---|---|
| Contracts | New hook + factory + `FeeConverter` (+ router per B). `LossRewardPool` untouched. |
| Frontend | `bondingCurveV4.ts` reads slot0 + position instead of `curveStates`; buy/sell via UR (per B). Loss-reward panel, creator-fee card, Permit2 card, claims: unchanged. |
| Indexer | Unchanged (events preserved). |
| Worker | V4 benchmark = slot0 always (code exists for the graduated branch). |
| Supabase / gateway / Railway / Vercel | Unchanged. |
| Existing tokens | Stranded on their current hook. **Cost today: 1 token (TESTINGG, a test token, fully sold out).** Grows with every launch before cutover. |

## 9. Migration & rollout
1. Contracts + fork suite (curve equivalence to the wei vs today's hook; fees land in the real pool; UR buy & sell; graduation incl. boundary cases; loss-reward epoch end-to-end on the new pool; `FeeConverter.convert`).
2. Mainnet: mine salt for `0x28C0`, deploy hook → `FeeConverter` → factory → (router), re-point `uniswapAddresses.ts` + indexer factory default, PR to master (user runs deploys with own key; each tx verified on-chain).
3. §5 acceptance on a throwaway launch. Then open launches.
4. Later, deliberately: §6 fee switch, decision C.

## 10. Risks
- **Settlement inside `afterSwap` during graduation** — heaviest testing; same bug class as the GenericSell fix.
- **Tick rounding** — bounded at ≤ 0.008%; quantified, not hand-waved.
- **Sell-side fee currency** — decision A changes loss-pool funding if "burn" is chosen.
- **Aggregator behaviour with a dynamic-fee hook** — the whole point of mechanism A is that there is nothing to simulate; still verified empirically in §5, never assumed.

## 11. Effort (calibrated to this engagement's measured pace)
Design sign-off ½ session · contracts + fork suite 1½–2 · frontend/off-chain ½–1 · mainnet + acceptance ½ + waiting on terminals. ~3–5 build sessions; ~1 week calendar with review/deploy gates.
