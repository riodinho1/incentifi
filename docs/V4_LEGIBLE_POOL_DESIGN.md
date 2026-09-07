# V4 "Legible Pool" Redesign — Design Doc (pre-Solidity)

**Status:** Phase 2 implemented in this PR (contracts + Foundry fork suite, 11 + 5 review tests green on a Robinhood mainnet fork). NOT deployed. Numbers below were corrected from the suite (tickSpacing 10, see §3.1). Decision D is **final** as of review round 2: the 2% fee continues after graduation, capped at 2%, no timelock, owner is a hardware-wallet EOA by choice (§3.6, §6).
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
- **Fee continuity:** the same 2% (1% creator / 1% loss pool) applies before *and* after graduation; there is no fee cliff and the fee can never exceed 2% (§3.6).

## 3. Design

### 3.1 Pool
- `PoolKey { currency0: ETH (address(0)), currency1: token, fee: DYNAMIC_FEE_FLAG (0x800000), tickSpacing: 10, hooks: new hook }`.
- **Why tickSpacing 10, not 1 (found in the fork suite):** a swap that overshoots the curve (a buy larger than what is left, or a sell into an emptied pool) walks the tick bitmap word by word all the way to the caller's price limit, and generic routers pass MIN/MAX. A word spans 256 × tickSpacing ticks: with spacing 1 the graduating buy touched ~4,150 bitmap words ≈ 8.7M gas (measured: 11.6M total). Spacing 10 caps the worst case at ~415 words (< 1M gas) and costs ≤ 0.07% of bound rounding.
- Initialized at `sqrtPriceX96 = √(5e8)·2⁹⁶ = 1771595571817166965907191352733264` — the exact launch price today's hook uses (tick 200,311.2).

### 3.2 The curve **is** a real position (mechanism A, not hook deltas)
The virtual-reserve curve `(VE+E)(VT+T) = K` is a constant-product segment, i.e. exactly a Uniswap range position. The factory mints **one** position, owned and locked by the hook:

| Parameter | Value | Derivation |
|---|---|---|
| Liquidity `L` | **48215215764839215328822** | `√K`, `K = VE·(VT+SUPPLY) = 2.32470703125e45` (exact) |
| Range (Uniswap price = tokens/ETH) | `[q_g, q₀] = [36,231,884.08, 500,000,000]` | `q₀ = (VT+SUPPLY)/VE`, `q_g = (K/(VE+GRAD_ETH))/(VE+GRAD_ETH)` |
| Ticks (spacing 10) | **lower 174,070 · upper 200,310** | `log₁.₀₀₀₁(q)`, rounded inward to spacing 10; bound error ≤ 0.07% |
| Token side at launch (token1) | **787,740,104.72 tokens** | `L(√q_upper − √q_lower)` at the spacing-10 bounds (787,903,505.84 at the exact bounds) |
| ETH to traverse (token0) | **5.85114 ETH (−0.046% vs 5.853863234)** | `L(1/√q_lower − 1/√q₀)` from the launch price to the spacing-10 lower bound (exact bounds: 5.853863234) |
| Held back in hook custody | **212,259,895.28 tokens** | `SUPPLY − 787,740,104.72` = the tokens that pair with the raised ETH at `P_g` |

At launch the price sits at the range's upper bound, so the position is 100% token; buys walk the price down through the range converting tokens to ETH inside the position; at the lower bound the position is 100% ETH = graduation. Same numbers as today, but now `getLiquidity > 0`, `Swap` events carry real amounts, and price moves — everything generic infrastructure keys on.

### 3.3 Fees as **LP fees**, then collected (mechanism A)
- `beforeSwap` returns `lpFeeOverride = 20_000 (2%) | OVERRIDE_FEE_FLAG` while pre-graduation; **no** `BeforeSwapDelta`, no `afterSwapReturnDelta`. The hook is never a swap counterparty → nothing for a router or quoter to mis-simulate.
- Fees accrue to the hook's position natively. `collect()` (hook calls `modifyLiquidity(liquidityDelta = 0)` and takes `feesAccrued`) splits **ETH-side** fees 50/50: `creatorBalances[creator] +=` (pull-payment, existing `claimCreatorFees()` UX) and `LossRewardPool.depositReward{value}(token)`.
- **Token-side fees** (sell-side fees accrue in the input token): forwarded to a small `FeeConverter` contract with a permissionless `convert(token)` that sells them into the same pool as an ordinary trade (indexed, fee-paying) and deposits the ETH 50/50 the same way. This keeps sell-side fees funding the loss pool in ETH, which today's design does; the alternative — burning the token side (Brew) — is simpler but would halve loss-pool inflow to buy-side only (TESTINGG's volume tonight was ~50/50). **Open decision A** (§7).
- Collection cadence: on every graduation, on `claimCreatorFees()`, and via permissionless `collect(token)`.
- **Converter protections (review #1/#2):** `convert()` is permissionless, so the caller's `minEthOut` is only an *additional* constraint. The floor is derived on-chain from the hook's per-pool **price checkpoint** — the pool price at the end of the previous block it traded in, captured on the first swap of each block before that swap moves the price — and the conversion must deliver ≥ 97% of the checkpoint-implied ETH for the tokens actually sold, else it reverts. A same-block sandwich therefore cannot settle. A cross-block manipulation is *not* bounded by the 3% — the 3% is measured against the checkpoint, and the checkpoint is exactly what a cross-block attack moves. The real protection is economic: to move the reference price enough to matter, the attacker must trade far more than the batch they are targeting (batches are ~2% of trade size against a ~1e9-token curve) and pay the 2% fee in both directions (~4% round trip, half of which funds the very creator/loss-pool split they are attacking) to extract a fraction of something small, while holding a mispriced position against arbitrage in between. The converter's own swap is **fee-free** (`beforeSwap` returns a 0 override for it), so the ETH it delivers matches what the holder's `Sold` event reported and no new token fees are minted recursively.

### 3.4 Liquidity gating (security)
- `beforeAddLiquidity`: revert unless `sender == hook`. Pre-graduation **always** (anyone else adding liquidity breaks curve semantics and lets them front-run graduation). Post-graduation governed by `lpOpen[token]` (default **false** → no fee dilution; opening it is a deliberate later choice — **open decision C**).
- Others cannot remove the hook's position (ownership is by `(owner, tickLower, tickUpper, salt)`), so no `beforeRemoveLiquidity` guard is needed.

### 3.5 Graduation state machine (the one new piece)
- **Where the ETH lives:** inside the curve position, accumulating as buyers walk the price down. Not in hook custody.
- **Trigger:** `afterSwap` checks `poolTick ≤ tickLower` (position fully converted to ETH) and `!graduated`. Executed **in the same call** — no external trigger to forget, nothing to grief (idempotent, no parameters). A permissionless `graduate(token)` exists only as a fallback.
- **Action:** remove the curve position (≈ 5.8539 ETH + accrued fees); `collect()` fees; pair the 5.8539 ETH with the 212.1M reserve tokens into a **full-range** position owned and locked by the hook at `P_g` (identical to today's graduation seeding); set `graduated`, emit `Graduated`.
- **Remainder (review #4):** the full-range mint cannot pair everything — with tickSpacing 10 the curve raises ~0.046% less ETH than pairs the whole reserve at P_g, so ETH binds and **~0.06% of the reserve (~127,000 tokens, ~0.003 ETH of value) plus at most dust ETH** is left over per graduation. It is **donated into the just-minted graduated position** (`PoolManager.donate`), where it accrues as ordinary LP fees to the hook's own position (external LPs are gated) and re-emerges through `collect()` — ETH split 1%/1%, tokens via the converter. Nothing is stranded and no privileged sweep exists.
- **Edge cases:** the pool has no liquidity below `tickLower`, so a swap that would overshoot stops at the bound (partial fill) — "crossing" means reaching it, which is a trade, which fires `afterSwap`. A swap landing exactly on the bound graduates too. Deltas created by the hook's own `modifyLiquidity` inside `afterSwap` must be settled by the hook within the unlock — **this is the settlement-order class of bug we already had once; it gets the heaviest test coverage.**

### 3.6 Post-graduation fee: **2%, on from launch, capped at 2%** (decision D, final)
`postGraduationFeePips[token]` is set to `DEFAULT_POST_GRADUATION_FEE_PIPS = 20_000` (2%) when the token is registered and is returned as the dynamic override after graduation — identical to the curve fee, split 1% creator / 1% `LossRewardPool`. **No fee cliff:** trading carries on at the same rate throughout. Rationale: half the fee funds the loss-reward pool, which keeps paying underwater holders after graduation, so the fee is not dead weight. `MAX_POST_GRADUATION_FEE_PIPS = 20_000`: the fee **can never exceed the curve fee**. The owner may set any value in `[0, 2%]` per token with a single `setPostGraduationFee(token, pips)`, **effective immediately** — with default == cap there is no raise to delay, and lowering only ever helps traders, so there is no timelock and no proposal state.

### 3.7 Hook permissions
`beforeInitialize (bit 13) · beforeAddLiquidity (11) · beforeSwap (7) · afterSwap (6)` → mask **`0x28C0`**. No return-delta bits — that is the whole point. CREATE2 salt mined for this mask (same tooling as tonight's deploy).

The hook's "in own operation" guard (which silences its fee override and events while it seeds/collects/graduates) is **per pool** (review #3): graduation makes external calls, and a swap on any other pool served by the same hook during those calls is charged normally and emits its events.

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
tick-aligned bounds (spacing 1 — superseded, see §3.1): [174064, 200311] -> bound price error <= 0.0020% / 0.0080%
chosen bounds (spacing 10): [174070, 200310] -> bound price error <= 0.068% / 0.012%; overshoot walk <= ~415 bitmap words
mcap: $5000 at launch, $69000 at graduation
```

## 5. Legibility acceptance test (empirical, before any cutover)
Launch a throwaway token on the new trio on mainnet and confirm, in order: (1) `getLiquidity > 0`, `Swap` events with real amounts, moving `slot0`; (2) V4 Quoter quote == UniversalRouter execution for a buy **and** a sell; (3) DexScreener indexes the pair (automatic for real V4 liquidity — control pool confirmed); (4) the token appears and **trades** on GMGN and Axiom.

## 6. Post-graduation fee and governance (superseded → final)
Earlier drafts shipped the post-graduation fee at 0 behind a governed switch ("one-way door"), then added a 2-day timelock and a multisig-owner requirement. **All of that is superseded** by the product decision in §3.6: the fee is 2% throughout, on from launch, capped at 2% in the contract, adjustable within `[0, 2%]` immediately. Because the cap equals the default, the owner cannot raise anything; the only remaining owner levers are lowering the fee (helps traders) and opening external LP on graduated pools (decision C). With that little power, **the owner is a single hardware-wallet EOA, deliberately** — `script/DeployLegiblePool.s.sol` deploys with a plain EOA owner (the `--sender`, or `OWNER` if set). A hook fee is enforced on every path, so unlike the V3 post-grad fee it cannot be bypassed by trading the pool directly.

## 7. Open decisions (need an answer before Solidity)
| | Options | Recommendation |
|---|---|---|
| **A. Token-side (sell) fees** | convert to ETH via `FeeConverter` (keeps loss-pool funding whole) · burn (simplest, halves loss-pool inflow) | **Convert** — a separate small contract, permissionless, ordinary indexed trades; hook stays minimal |
| **B. Router** | drop `IncentifiV4Router` and trade through UniversalRouter like everyone else · keep a thin router | **Drop** — one fewer deploy, and it forces us to eat the same path terminals use |
| **C. Post-grad LP gating** | keep gated (no fee dilution) · open (external LPs share fees) | **Keep gated** at launch; revisit with §6 |
| **D. Post-grad fee level** | 0 · 1%/1% · governed | **RESOLVED (final): 2% (1%/1%) throughout, on from launch, capped at 2%, no timelock; owner is a hardware-wallet EOA by choice** (§3.6, §6) |

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
2. Mainnet: mine salt for `0x28C0`, deploy hook → `FeeConverter` → factory, re-point `uniswapAddresses.ts` + indexer factory default, PR to master (user runs deploys with own key; each tx verified on-chain). Owner: the deploying hardware-wallet EOA (or `OWNER`), by choice — see §6; no multisig, no timelock.
3. §5 acceptance on a throwaway launch. Then open launches.
4. Later, deliberately: decision C (opening external LP).

## 10. Risks
- **Settlement inside `afterSwap` during graduation** — heaviest testing; same bug class as the GenericSell fix.
- **Tick rounding** — bounded at ≤ 0.07% with tickSpacing 10 (spacing 1 gave ≤ 0.008% but made overshooting swaps walk ~4k bitmap words; see §3.1); quantified, not hand-waved.
- **Sell-side fee currency** — decision A changes loss-pool funding if "burn" is chosen.
- **Aggregator behaviour with a dynamic-fee hook** — the whole point of mechanism A is that there is nothing to simulate; still verified empirically in §5, never assumed.

## 11. Effort (calibrated to this engagement's measured pace)
Design sign-off ½ session · contracts + fork suite 1½–2 · frontend/off-chain ½–1 · mainnet + acceptance ½ + waiting on terminals. ~3–5 build sessions; ~1 week calendar with review/deploy gates.

## 12. Mainnet deployment (2026-09-07, Robinhood Chain 4663)

Deployed by the owner from commit `ea48b3c` (PR #17 squash-merge) with `script/DeployLegiblePool.s.sol`; record in `broadcast/DeployLegiblePool.s.sol/4663/run-latest.json`. Read back on-chain the same day.

| Contract | Address | Tx | Explorer |
|---|---|---|---|
| `IncentifiV4LegibleHook` (CREATE2, flags `0x28C0`) | `0x921d0bE20A21e5A687734b4dF6302EA55BD168C0` | `0x47922909632fdf049b9bac718a89ba663aafe9ffc631470986c2d1fa2aef8018` (block 56,911,909) | https://robinhoodchain.blockscout.com/address/0x921d0bE20A21e5A687734b4dF6302EA55BD168C0?tab=contract |
| `IncentifiV4LegibleFactory` | `0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda` | `0xc1a2e404d1a47437f7f53905a1d1b268c327701255ba970343fc49f3025a13d9` (block 56,911,931) | https://robinhoodchain.blockscout.com/address/0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda?tab=contract |
| `IncentifiFeeConverter` | `0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9` | `0xadf7c809923383aff6bcaebdb36737a2a0a1ebd284617780891343d2238664d5` (block 56,911,982) | https://robinhoodchain.blockscout.com/address/0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9?tab=contract |

Wiring (`setFactory` tx `0xb260214d…`, `setFeeConverter` tx `0x26000279…`), read back: `hook.factory()` / `hook.feeConverter()` / `factory.hook()` / `converter.hook()` match the table; `hook.owner() == hook.deployer() == 0x78a4E4BCC8ab559B6d3B1Cb9eab0A04a2411c726` (hardware-wallet EOA, by choice, §6); `hook.lossRewardPool() == converter.lossRewardPool() == 0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF` (the V1 pool, re-pointable per PR #18); `PRE_GRADUATION_FEE_PIPS == DEFAULT_POST_GRADUATION_FEE_PIPS == MAX_POST_GRADUATION_FEE_PIPS == 20 000`; `TICK_SPACING 10`, bounds `[174070, 200310]`; factory `POOL_FEE == DYNAMIC_FEE_FLAG`. Source verification, all with the exact `foundry.toml` settings (solc v0.8.26+commit.8a97fa7a, optimizer 200 runs, viaIR, cancun) from the standard-JSON input `forge verify-contract --show-standard-json-input` produces:

| Contract | Sourcify (chain 4663) | Blockscout |
|---|---|---|
| Hook `0x921d0bE2…68C0` | **exact match** (creation + runtime), 2026-09-07T14:45:42Z — https://sourcify.dev/server/v2/contract/4663/0x921d0bE20A21e5A687734b4dF6302EA55BD168C0 | **full match**, 2026-09-07T14:45:41Z |
| Factory `0xD4ce8F95…9Dda` | **exact match**, 14:54:08Z | **full match**, 15:05:32Z |
| Converter `0xe1BB0667…F7D9` | **exact match**, 14:54:11Z — https://sourcify.dev/server/v2/contract/4663/0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9 | **pending**: Blockscout's verification endpoint rate-limited every submission ("Too many requests") and Cloudflare blocked Sourcify's push (403). Sourcify is the verification that counts; to mirror it later, open the address on Blockscout and use "Verify via Sourcify", or re-run `forge verify-contract --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/`. |

**Next (§5 acceptance, in order):** run `scripts/smoke-test-legible-pool.mjs` from a funded throwaway wallet (launch → UR buy → UR sell → `collect` → `convert`); confirm real `Swap` events and a moving `slot0`; DexScreener indexes the poolId; Quoter == UniversalRouter; GMGN / Axiom show the token. Only then re-point `src/lib/uniswapAddresses.ts` and the indexer's factory default to this trio.

## 13. Frontend + indexer cutover for NEW launches (flag, default OFF)

**Dual-system, routed per token.** Every token is routed by the hook its pool is bound to — `tokens.hook_address` when the indexer has tagged it (`supabase/legible_pool_cutover.sql`), else the chain (legible factory `isLaunched`, then the GenericSell factory, then the V3 factory) — see `src/lib/tokenVenue.ts`. Nothing is switched globally; every pre-existing code path (V3 curve + IncentifiSwapRouter, GenericSell hook + IncentifiV4Router) is intact.

**Launch flag.** `VITE_LEGIBLE_LAUNCH_ENABLED=true` makes the launch page deploy through the legible factory with `launchToken(token, address(0))` (ETH loss rewards; an ETH-only "Loss Reward Asset" control is shown). Any other value (default) keeps the GenericSell launch path. The flag affects new launches only.

**Trading for legible tokens.** Quotes from Uniswap's V4 Quoter (`quoteExactInputSingle` / `quoteExactOutputSingle`); buys and sells through UniversalRouter (Permit2 on the token side), pre- and post-graduation; price from slot0, progress / reserves / graduation from `hook.curveStates(poolId)` (legacy 6-field shape). **Gas:** every V4 swap is sent with an explicit limit of the node estimate + 30%, floor 300,000 — never the bare estimate (2026-09-07 smoke test: the first buy ran out of gas at 194,373).

**Off-chain.** The indexer discovers launches from BOTH factories (resumable, fail-loud precondition of every tick — the phantom-payout guard applies to the legible hook too), ingests `Bought`/`Sold` from both hooks into the same rows, logs the legible hook's `FeesConverted` without creating a trade, and tags `tokens.hook_address`. The worker takes a legible token's benchmark from slot0 (`v4_legible_slot0`), before and after graduation, and leaves the V3 / GenericSell paths untouched. Creator fees for legible tokens are claimed from the legible hook's `creatorBalances`.

| Env var | Read by | Default (deployed 2026-09-07) |
|---|---|---|
| `VITE_LEGIBLE_LAUNCH_ENABLED` | frontend | `false` |
| `VITE_INCENTIFI_LEGIBLE_HOOK` | frontend, indexer, worker | `0x921d0bE20A21e5A687734b4dF6302EA55BD168C0` |
| `VITE_INCENTIFI_LEGIBLE_FACTORY` | frontend, indexer, worker | `0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda` |
| `VITE_INCENTIFI_LEGIBLE_FEE_CONVERTER` | frontend, scripts | `0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9` |
| `VITE_UNISWAP_V4_POOL_MANAGER` | frontend | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| `VITE_UNISWAP_V4_QUOTER` | frontend, scripts | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| `VITE_UNISWAP_V4_STATE_VIEW` | frontend, indexer, worker | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |

Rollout: apply `supabase/legible_pool_cutover.sql`, deploy the indexer/worker (they pick up both hooks with no env change), deploy the frontend with the flag unset (old launch path, legible tokens such as SMK95868 already tradeable), then flip `VITE_LEGIBLE_LAUNCH_ENABLED=true` on Vercel when ready.
