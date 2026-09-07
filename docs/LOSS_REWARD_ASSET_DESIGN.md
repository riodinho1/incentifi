# Creator-selected Loss-Reward payout asset — Design Doc (Phase B, pre-Solidity)

**Status:** Phase B approved with three amendments (A, B, C below); **Phase C implemented in this PR**: `LossRewardPoolV2`, `RewardSwapperUniswapV3`, deploy + re-point scripts, 24 fork tests green. **Nothing deployed.** Measured numbers in §C5.
**Scope:** a new `LossRewardPoolV2` at a new address that pays claims in ETH (as today) or in a creator-selected Robinhood stock token (AAPL, TSLA, NVDA at launch). The loss calculation, epoch/Merkle mechanism, eligibility, leaf format and operator model are **unchanged**. Only what the claimant receives changes.
**Not in scope:** creator fees (they live in the hook's `creatorBalances`, never touch the pool, and stay ETH — there is no coupling to design), MSFT (deferred: no deep direct WETH pool; the two-hop needs an unaudited third-party hook), any change to PR #17's curve or fee mechanics.

---

## 0. What Phase A established (the facts this design rests on)

| Fact | Value | Verified how |
|---|---|---|
| Live pool is not upgradeable | `0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF`, plain contract, no proxy, no `DELEGATECALL` | bytecode + EIP-1967 slots |
| On-chain asset registry | **StockFactory** `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046` (ERC1967/UUPS proxy, logic `0xee351e53…6ee0e`, verified) | verified source, 203 `Deployed` events, 0 duplicate uids |
| Membership check | `IStock(candidate).uid()` → `StockFactory.tokenAddress(uid) == candidate` | round-trips for AAPL/TSLA/NVDA/MSFT; random uid → 0; counterfeit "AAPL" has no `uid()` |
| Access-controls registry (also the beacon) | `0xe10b6f6B275de231345c20D14Ab812db62151b00` — `isBlocked(addr)`, `paused()` | verified source |
| Stock implementation | `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` (`Stock`, BeaconProxy behind it). `transfer`/`transferFrom` revert if token paused, registry paused, or sender/recipient/caller blocked. `adminBurn` exists. Balances are raw; `uiMultiplier()` is display-only. | verified source |
| The docs table is NOT an on-chain read | `AssetsTable` fetches `https://api.robinhood.com/rhj/assets` (194 assets, off-chain `ASSET_STATUS_ACTIVE`) | docs-site JS bundle |
| Venues (WETH V3, same factory the app already uses) | AAPL `0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f` 0.05% · TSLA `0xA953CA88ff430e9487c60cA34d757414f4efdA07` 0.30% · NVDA `0x62AB521f71431f78ac374CdbadC6cda3c8916b6C` 0.05%; WETH is `token0` in all three | on-chain `factory()`, `fee()`, `token0()` |
| Price impact (V3, QuoterV2) | 0.05 ETH: ≤ 0.007% · 0.5 ETH: ≤ 0.046% | quotes |
| V4 native-ETH pools for these three | 5% fee — quote ~6% worse. **Not used.** | `Initialize` logs |
| TWAP availability | oldest observation: AAPL 6.0 h, NVDA 7.0 h, TSLA 13.1 h (cardinality 1400/1400/300) | fork read |
| Chainlink | "Robinhood AAPL / USD" `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0`, TSLA `0x4A1166a659A55625345e9515b32adECea5547C38`, NVDA `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` (8 dp, 24 h heartbeat) — **65 h stale over the weekend** | feed directory + `latestRoundData` |
| Gas price | L2 ≈ 0.305 gwei; L1 data component `ArbGasInfo.getL1BaseFeeEstimate() == 0` | RPC |

### Measured cost of the stock path (Robinhood fork, block ≈ 56.8M, 0.05 ETH, recipient = claimant, direct `IUniswapV3Pool.swap` + callback)

| Step | AAPL | TSLA | NVDA |
|---|---|---|---|
| `observe([1800, 0])` (30-min TWAP) | 69,180 | 50,574 | 65,897 |
| registry round-trip + `paused()` + `isBlocked(claimant)` + `liquidity()` | 32,370 | 32,370 | 32,370 |
| `WETH.deposit` | 46,233 | 46,233 | 46,233 |
| `pool.swap` (stock lands in the claimant's wallet) | 116,339 | 118,760 | 118,521 |
| **stock-path overhead** | **264,394** | **248,209** | **263,293** |
| V1 `claimReward`, 1 epoch, empty proof (baseline) | 82,421 | | |

A full stock claim is therefore ≈ **350–360k gas** (baseline + overhead + adapter call), an ETH claim ≈ 82k for one epoch and ≈ 110–130k for a realistic 3-epoch batch. At today's 0.305 gwei: stock claim ≈ 0.00011 ETH (≈ $0.27), ETH claim ≈ 0.000025 ETH, **marginal cost of choosing stock ≈ 0.000085 ETH (≈ $0.21)**. The probe that produced these numbers is kept out of the repo (scratchpad `GasProbeStockClaim.t.sol`) and will be folded into the Phase C suite.

---

## B1. Contracts, files, interfaces

### New contracts (`contracts/loss-reward/`)

| File | Role |
|---|---|
| `LossRewardPoolV2.sol` | The pool. V1 surface preserved verbatim + asset config + stock payout with ETH fallback. **Holds only ETH, ever.** |
| `RewardSwapperUniswapV3.sol` | Stateless swap adapter: wrap → direct `IUniswapV3Pool.swap` with `recipient = claimant` → callback pays WETH. Computes the TWAP reference; enforces `amountOutMinimum` **inside the swap frame**. Never holds stock; holds ETH/WETH only inside one call frame and asserts a zero residual before returning. **`swap` is callable only by the pool** (`OnlyLossRewardPool`); it has no `receive()`. |
| `interfaces/ILossRewardPoolV2.sol` | Full ABI (below). |
| `interfaces/IRewardSwapper.sol` | Adapter ABI (below). |
| `interfaces/IRobinhoodStock.sol` | Minimal `IStock` (`uid`, `paused`), `IStockFactory` (`tokenAddress`), `IAccessControlsRegistry` (`isBlocked`, `paused`). |
| `interfaces/IUniswapV3PoolMinimal.sol`, `interfaces/IWETH9.sol` | Minimal external ABIs (`swap`, `observe`, `liquidity`, `token0/1`, `factory`; `deposit`, `transfer`). |

Why an adapter instead of swap code inside the pool: the pool's job is accounting and custody of ETH; the adapter is the only thing that knows Uniswap. Adding MSFT later through a V3 WETH pool is then a `setAssetRoute` call (config); adding it through a two-hop would be a second adapter contract plus config, with **no change to the pool**. The adapter is owner-chosen but cannot be pointed at an arbitrary sink: it validates every route against the canonical V3 factory (`IUniswapV3Factory.getPool(WETH, asset, fee) == pool`) at `setAssetRoute` time, so the owner's power is "pick a canonical Uniswap pool", not "pick where the ETH goes".

### Modified contracts

| File | Change | Depends on |
|---|---|---|
| `contracts/v4/legible/IncentifiV4LegibleFactory.sol` | `launchToken(address token, address rewardAsset)`; existing `launchToken(token)` = ETH. After registering with the hook it calls `pool.setRewardAsset(token, rewardAsset)`. `msg.sender` (the creator) is the only party who can make that call for that token, because the factory is the only authorised setter and the call happens inside the creator's own launch transaction. | PR #17 merged |
| `contracts/v4/legible/IncentifiV4LegibleHook.sol` | `setLossRewardPool(address)` (owner) with `LossRewardPoolUpdated(old, new)`. **Today `lossRewardPool` is `immutable` on this branch and on the live GenericSell hook.** Either PR #17 gains this setter before merge, or the legible hook is deployed with V2 as its constructor argument (V2 must then exist first). This doc assumes the setter. | PR #17 |

### Scripts, tests, off-chain, frontend

| File | Change |
|---|---|
| `script/DeployLossRewardPoolV2.s.sol` | Deploy V2 + swapper; `setAssetRoute` × 3 (validated on-chain); `setAssetSetter(legibleFactory, true)`; `setMinStockReward`; `setOperator(0x78a4E4BC…)`. Owner = `--sender` (hardware EOA). Prints everything. |
| `script/RepointHookLossRewardPool.s.sol` | **Separate, deliberate second action:** reads `hook.lossRewardPool()`, requires V2 has code and `V2.operator()` is set, calls `hook.setLossRewardPool(V2)`, prints before/after. Never run by the deploy script. |
| `test/foundry/LossRewardPoolV2.t.sol` (+ `LossRewardPoolV2Fallbacks.t.sol`) | Fork suite, §B10. |
| `scripts/loss-reward-worker.mjs` | Address from env; **dual-pool mode** during migration (§B6). |
| `scripts/evm-indexer.mjs` | `loss_pool_tvl_eth` = sum of both pools' unallocated balance for a token. |
| `supabase/functions/loss-reward-gateway/index.ts` | `pool_address` per epoch in `/query`; legacy `/claim` relayer path stays deprecated. |
| `supabase/loss_reward_asset_migration.sql` | `reward_epochs.pool_address` (default = V1), `tokens.reward_asset`, `tokens.reward_asset_symbol`. |
| `src/lib/uniswapAddresses.ts` | `LOSS_REWARD_POOL` → V2, new `LOSS_REWARD_POOL_LEGACY` → V1. |
| `src/lib/lossReward.ts` | claims grouped by pool; `claimBatchAs` with quote-derived `minOut` + deadline for V2; V1 path unchanged. |
| `src/lib/rewardAssets.ts` (new) | Allow-list = on-chain `assetRoute(asset).enabled` ∩ API `ASSET_STATUS_ACTIVE`; `uiMultiplier()` display helper; `previewStockOut()`. |
| `src/lib/createEvmToken.ts`, `src/pages/launch/page.tsx` | Reward-asset dropdown; passes the address to `launchToken(token, asset)`. |
| `src/pages/token-preview/page.tsx` | "Loss Reward: AAPL" badge, claim copy, "you will receive ≈ X AAPL", legacy-pool claims section. |
| `scripts/claim-loss-rewards.mjs`, `scripts/check-live-deployment.mjs` | V2 + `minOut`/deadline flags; both addresses. |

### Interfaces

```solidity
// ---------- ILossRewardPoolV2 ----------
// V1 surface, byte-for-byte semantics (worker/CLI/gateway changes are address-only):
function depositReward(address token) external payable;
function getUnallocatedBalance(address token) external view returns (uint256);
function setEpochMerkleRoot(address token, uint256 epochId, bytes32 merkleRoot, uint256 allocatedAmount) external; // onlyOperator
function claimReward(address token, uint256 epochId, uint256 amount, bytes32[] calldata proof) external;            // ETH tokens only
function claimBatch(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata proofs) external; // ETH tokens only
function totalDeposited(address) external view returns (uint256);
function totalAllocated(address) external view returns (uint256);
function totalClaimed(address) external view returns (uint256);
function epochMerkleRoots(address, uint256) external view returns (bytes32);
function epochAllocatedAmounts(address, uint256) external view returns (uint256);
function hasClaimed(address, uint256, address) external view returns (bool);
function owner() external view returns (address);
function operator() external view returns (address);
function setOperator(address) external;          // onlyOwner
function transferOwnership(address) external;    // onlyOwner
// leaf: keccak256(bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount))))  — unchanged

// New: claims that may pay in stock (work for ETH tokens too; minAssetOut/deadline ignored there)
function claimRewardAs(address token, uint256 epochId, uint256 amount, bytes32[] calldata proof,
                       uint256 minAssetOut, uint256 deadline) external;
function claimBatchAs(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata proofs,
                      uint256 minAssetOut, uint256 deadline) external;

// Per-token asset (set once, at launch, by an authorised setter = the launch factory)
function setRewardAsset(address token, address asset) external;      // onlyAssetSetter, reverts if already set
function forceEthPayout(address token) external;                     // onlyOwner, one-way
function rewardAsset(address token) external view returns (address asset, bool assetSet, bool forcedEth);
function effectivePayoutAsset(address token) external view returns (address); // address(0) = ETH

// Allow-list / routes (owner). Adding an asset later is a call, not code.
struct AssetRoute { address swapper; address pool; uint24 fee; uint32 twapWindow; uint16 maxDeviationBps; bool enabled; }
function setAssetRoute(address asset, AssetRoute calldata route) external;   // validates via swapper.validateRoute()
function setAssetEnabled(address asset, bool enabled) external;
function assetRoute(address asset) external view returns (AssetRoute memory);
function isSelectableAsset(address asset) external view returns (bool);      // enabled && registry round-trip && !paused()
function setAssetSetter(address setter, bool allowed) external;             // onlyOwner (factories)
function setMinStockReward(uint256 wei_) external;                          // onlyOwner
function minStockRewardWei() external view returns (uint256);

// Strict per-token accounting
function epochClaimedAmounts(address token, uint256 epochId) external view returns (uint256);
function tokenVault(address token) external view returns (uint256);         // totalDeposited - totalClaimed

// Events (V1 events kept: RewardDeposited, EpochRootPublished, RewardClaimed, OperatorUpdated, OwnershipTransferred)
event RewardAssetSet(address indexed token, address indexed asset, address indexed setter);
event EthPayoutForced(address indexed token, address indexed previousAsset);
event AssetRouteSet(address indexed asset, address swapper, address pool, uint24 fee, uint32 twapWindow, uint16 maxDeviationBps, bool enabled);
event AssetSetterUpdated(address indexed setter, bool allowed);
event MinStockRewardUpdated(uint256 wei_);
event RewardPaid(address indexed token, address indexed claimant, uint256 ethAmount, address indexed asset, uint256 assetAmount); // asset = 0 for ETH
event RewardPaidInEthFallback(address indexed claimant, address indexed token, address indexed asset, FallbackReason reason, bytes data);
enum FallbackReason { ForcedEth, AssetDisabled, RegistryMismatch, AssetPaused, ClaimantBlocked, NoLiquidity, ReferenceUnavailable, BelowMinimum, BelowProtocolBound, SwapFailed }

// Errors (V1 errors kept) + SwapParamsRequired(), DeadlineExpired(), MinOutNotMet(uint256 out, uint256 minOut),
//   AssetNotSelectable(address), RewardAssetAlreadySet(address), NotAssetSetter(), EpochOverClaimed(), BareEthRejected(), InvalidRoute()

// ---------- IRewardSwapper ----------
function validateRoute(address asset, address pool, uint24 fee) external view returns (bool);        // canonical factory check, token1 == asset, token0 == WETH
function referenceOut(address asset, address pool, uint32 twapWindow, uint256 ethIn) external view
        returns (uint256 refOut, bool available);                                                      // TWAP-implied output; available=false if observe() reverts
function swap(address asset, address pool, uint256 minOut, uint256 refFloor, address recipient, uint256 deadline)
        external payable returns (uint256 assetOut);                                                   // reverts MinOutNotMet | BelowProtocolBound | pool errors
function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
```

---

## B2. Per-token asset config

- **Chosen once, at launch, via the factory; immutable.** `launchToken(token, asset)` → `pool.setRewardAsset(token, asset)`. `asset == address(0)` means ETH and is also recorded (`assetSet = true`), so *every* launched token is pinned. A token with no record (pre-V2 tokens, V3-curve tokens) is ETH by default.
- **Validated against the registry at selection time** (`isSelectableAsset`): route enabled, `IStock(asset).uid()` in `try/catch`, `StockFactory.tokenAddress(uid) == asset`, `!IStock(asset).paused()`. The frontend's dropdown comes from the API filtered to `ACTIVE`, intersected with `assetRoute(asset).enabled`; the contract trusts only the factory round-trip.
- **Who can set:** only addresses in `assetSetters` (the legible factory; any future factory is one `setAssetSetter` call). The factory only calls it inside the creator's launch transaction, so "non-creator cannot set an asset" and "creator of A cannot set B's" hold at both layers: the pool refuses non-setters and refuses second writes; the factory refuses non-launchers.
- **Owner override: `forceEthPayout(token)`**, one-way, emits `EthPayoutForced`. **For:** stock tokens are pausable, block-listable and admin-burnable by Robinhood, and pools can drain — without the override every claim on a dead asset still ends in the ETH fallback, but only after each user pays for a doomed attempt (~100k gas of pre-checks and a reverted swap) and sees a confusing "fallback" event. The override makes the state explicit, cheap and honest in the UI. It cannot extract value: the only thing the owner can do is pay the base asset the pool already holds. **Against:** it is owner discretion over a creator's promise. Mitigations that make it acceptable: it is irreversible (cannot be flipped back to stock, so it cannot be used to time markets), it is evented, and the fallback path exists regardless, so the override never changes *whether* users get paid, only *how cheaply*. **Recommendation: keep it.**

## B3. Claim-time conversion

Order inside `claimBatchAs` (also `claimRewardAs`):

1. `nonReentrant`; `deadline` check (reverts `DeadlineExpired` — the user's own parameter).
2. For each epoch: `_claimEpoch` exactly as V1 (root exists, not claimed, proof verifies for `msg.sender`), **`hasClaimed = true` and the per-epoch cap are written here, before any external call**. Sum → `total`.
3. Effects: `totalClaimed[token] += total`.
4. Decide payout (§B4 pre-checks). ETH path: `call{value: total}` to `msg.sender`, `RewardPaid(token, claimant, total, address(0), 0)`.
5. Stock path: `swapper.swap{value: total}(asset, pool, amountOutMinimum, msg.sender, deadline)` inside `try/catch`, with `amountOutMinimum = max(userMin, protocolFloor)` (§B4). The adapter wraps `total` to WETH and calls `IUniswapV3Pool.swap(recipient = claimant, zeroForOne = true, amountSpecified = total, sqrtPriceLimit = MIN+1)`. The stock goes **from the Uniswap pool straight to the claimant**; neither the pool nor the adapter ever holds it. On success: `RewardPaid(token, claimant, total, asset, assetOut)`.

**Amendment C — the minimum applies to the batch total.** `minStockRewardWei` is compared against the summed `total` of the claim, never per epoch, so a user can combine several small epochs in one `claimBatchAs` to reach a stock payout (tested: three 0.001 ETH epochs — one alone pays ETH as `BelowMinimum`, two together pay AAPL).

**Amendment B — V1 signatures on a stock token.** `claimReward` / `claimBatch` (no `minAssetOut`, no `deadline`) **revert `UseClaimAs()`** when the effective payout is a stock. They still work, and pay ETH, when the effective payout is ETH anyway: the token is ETH, `forceEthPayout` was applied, or the batch total is below `minStockRewardWei`. Stated in `ILossRewardPoolV2` and tested. The legacy relayer path in the gateway now encodes `claimBatchAs` (it remains deprecated: the pool binds `claimant = msg.sender`).

**Economics, stated in the contract NatSpec, the design doc and the UI:** *your ETH allocation is spent buying the selected stock at the moment you claim; you receive whatever it buys.* There is no dollar-value promise, no oracle price, no shortfall liability, no top-up. The reward amount in the Merkle leaf is and stays ETH-denominated. If the stock cannot be delivered you receive the ETH instead.

**UI copy (token page, claim panel, for a stock token):**
> Loss rewards for this token are paid in **AAPL**. When you claim, your ETH reward (≈ 0.0123 ETH) is used to buy AAPL on Uniswap and sent to your wallet — you receive whatever it buys at that moment (≈ 0.0956 AAPL now; this is an estimate, not a guarantee). If AAPL can't be delivered, you receive the ETH instead.

## B4. Swap protection

Incentives first: at claim time **the caller is the beneficiary**. A user-supplied `minAssetOut` is aligned (unlike `convert()` in PR #17, where the caller was not the beneficiary), so it is the primary protection. The protocol bound exists only to stop a buggy or hostile frontend from passing `minAssetOut = 0`.

**Amendment A — bound enforcement is inside the swap, because delivery to the claimant is irreversible.** Exactly:

- Before the swap the pool reads `refOut = swapper.referenceOut(pool, twapWindow, total)` and derives `protocolFloor = refOut × (1 − maxDeviationBps / 10 000)`.
- The swap is called with **`amountOutMinimum = max(userMin, protocolFloor)`**. The adapter checks the delivered amount against it *inside the swap frame*: a shortfall reverts the frame with `InsufficientOutput(out, min)`, which unwinds the Uniswap transfer to the claimant. Nothing has moved when the pool catches it.
- If the adapter reverts with `InsufficientOutput`: **if `protocolFloor > userMin` the protocol was the binding bound → ETH fallback (`BelowProtocolBound`); otherwise the user's bound was binding → the claim reverts (`MinOutNotMet(out, userMin)`)**. The two are distinguishable by construction and both are tested on the same manipulated pool state.
- Any *other* revert from the adapter/pool/token (paused mid-flight, blocked pool, callback failure) → ETH fallback (`SwapFailed`, revert data attached). This is the one refinement to the amendment as written: a non-output failure is never turned into a claim revert on the user, because "a reward must never be stuck".
- **No post-swap outcome check can trigger a fallback**: once the adapter returns, stock has moved. Post-swap checks only assert invariants — the adapter reverts `ResidualBalance` if it holds any WETH or ETH after the swap (an impossible state, hence a revert not a fallback).
- **The ETH for the swap is passed as `msg.value` in the same adapter call that swaps.** Nothing is transferred to the adapter in a prior call, so a caught revert returns the ETH to the pool atomically and the fallback pays it out. The adapter has no `receive()`; bare ETH to it reverts.

1. **Required `minAssetOut` and `deadline`.** The frontend derives `minAssetOut` from a fresh QuoterV2 quote on the configured route × (1 − user slippage, default 1%), `deadline = now + 10 min`. Failure of *this* bound reverts the whole claim (`MinOutNotMet`) — the user's choice; nothing is consumed and they retry.
2. **Protocol sanity bound: the V3 pool's own TWAP.** `refOut = ethIn × price(meanTick over twapWindow)` from `pool.observe([window, 0])` (V3 rounding); enforced through `amountOutMinimum` as above. **Defaults: window 1800 s, tolerance 300 bps, per asset, owner-tunable (window ≥ 300 s, tolerance ≤ 2 000 bps enforced by the contract).** Justification:
   - *Why the pool's TWAP and not Chainlink:* the stock feeds go 65 h stale over weekends (measured) while the pools trade 24/7; a hard Chainlink bound would fall back to ETH every weekend. The pool's TWAP tracks the venue the claim actually executes on.
   - *Why 30 min:* Robinhood Chain has a single sequencer, no MEV auction and ~10 blocks/s, so a spot or 1-block reference is trivially manipulable in one transaction. Moving a 30-min TWAP by 3% requires holding the pool ≥ 3% off for a large fraction of 1800 s against arbitrage from the far deeper USDG pools ($1.6M AAPL, $1.5M TSLA, $6.3M NVDA) — capital ≈ pool depth × deviation, exposed for 30 min, to skim ≤ 3% of one user's reward. All three pools carry ≥ 6 h of observations today (TSLA 13 h at cardinality 300), so 1800 s is available with > 10× margin; if `observe` reverts `OLD`, the adapter retries a 600 s window and, failing that, reports `available = false` → ETH fallback (`ReferenceUnavailable`). The fork test that pushes the AAPL pool with a 60 ETH buy inside one block confirms the TWAP does not move within that block.
   - *Why 3%:* it must exceed LP fee (0.05–0.30%) + measured impact (≤ 0.05% at 0.5 ETH) + the drift a legitimate claim can see over the window. Regular-session 30-min moves for AAPL/NVDA are typically well under 1%; TSLA can exceed 3% on news days, in which case the claim pays ETH — a safe outcome, not a loss. Tighter bounds cost users stock payouts on ordinary volatility; looser bounds shift more of the manipulation budget to the attacker.
   - *Chainlink as an extra check only when fresh:* deferred to a later adapter version. The interface allows it (`referenceOut` is the adapter's), and it would apply only when `updatedAt` is within 3600 s and the L2 sequencer feed reports up; never a hard block.
3. **Liquidity check before attempting:** `swapper.poolLiquidity(pool) > 0` and `refOut > 0`; otherwise ETH fallback (`NoLiquidity`) with no swap attempted.
4. **Cheap pre-checks before the swap** (~15k gas): registry round-trip, `asset.paused()` (covers token *and* global pause), `registry.isBlocked(claimant)`. Any failure → ETH fallback without a wasted swap.
5. **Minimum reward size for stock payout.** Measured on the fork (§C5): a one-epoch AAPL claim costs 352,223 gas against 120,144 for the same ETH claim — **≈ 232k gas of stock-path overhead**, ≈ 0.00007 ETH at today's 0.305 gwei. Rule: *the marginal cost must not exceed 5% of the reward* ⇒ `minStockRewardWei = 20 × 232 000 × gasPrice` ≈ 0.0014 ETH today. **Default 0.002 ETH (≈ $5)**, owner-tunable with `MinStockRewardUpdated`; applies to the batch total (Amendment C). Below it the claim pays ETH directly (`BelowMinimum`). Stated plainly: with the current reward magnitudes on this launchpad (the last TESTINGG claim was 0.00012 ETH) most claims will land under this threshold and pay ETH; the stock path is for positions where the reward is worth the swap.
6. **`nonReentrant`, checks-effects-interactions, `hasClaimed` before any external call** (§B3). The adapter has no storage beyond the in-flight pool address; the only re-entrant surfaces are the claimant's `receive()` on the ETH path (blocked by the guard, tested both propagated and swallowed) and the V3 callback (adapter checks `msg.sender == pool` and pays WETH only).

## B5. Fallback — a reward must never be stuck

Every stock-path failure pays the ETH allocation instead and emits `RewardPaidInEthFallback(claimant, token, asset, reason, data)` followed by `RewardPaid(token, claimant, total, address(0), 0)`:

| Reason | When | Swap attempted? |
|---|---|---|
| `ForcedEth` | owner used `forceEthPayout(token)` | no |
| `BelowMinimum` | batch `total < minStockRewardWei` (V1 signatures allowed here) | no |
| `AssetDisabled` | route disabled/missing | no |
| `RegistryMismatch` | `uid()` reverted or `tokenAddress(uid) != asset` at claim time | no |
| `AssetPaused` | `asset.paused()` (token or global) | no |
| `ClaimantBlocked` | `registry.isBlocked(claimant)` — a transfer to them would revert | no |
| `NoLiquidity` | `liquidity() == 0` or `refOut == 0` | no |
| `ReferenceUnavailable` | TWAP `observe` reverted at both windows | no |
| `BelowProtocolBound` | `InsufficientOutput` with the protocol floor binding (swap reverted and unwound) | yes |
| `SwapFailed` | any other revert from the adapter/pool/token (`data` = revert bytes) | yes |

Three things bubble up instead of falling back, all the user's own: `MinOutNotMet` (their bound was binding), `DeadlineExpired`, and `UseClaimAs` (wrong signature for a stock token). Because the whole swap runs in the adapter's frame, a revert unwinds the WETH wrap too; the pool's ETH is untouched and is then paid out directly.

## B6. Migration

V1 keeps its ETH (0.0222 ETH today) and its published epochs; **no funds move between pools**. V1 has no sweep, so any ETH left unallocated there can only ever leave via epochs published *there*. The cutover is therefore a per-token drain-then-switch, not a flag flip.

1. **Deploy V2** with the deploy script (owner = hardware EOA, operator = `0x78a4E4BCC8ab559B6d3B1Cb9eab0A04a2411c726`, routes AAPL/TSLA/NVDA validated on-chain, `assetSetters = {legible factory}`, `minStockRewardWei = 0.002 ETH`). Verify on Blockscout. Fork-test against the deployed address.
2. **DB migration:** `reward_epochs.pool_address` (default V1 for existing rows), `tokens.reward_asset` / `reward_asset_symbol`.
3. **Worker, dual-pool mode, from block N:** per token and per run, if `V1.getUnallocatedBalance(token) ≥ MIN_EPOCH_PAYOUT_WEI` publish this epoch **on V1** (draining it), else publish **on V2**. Each `reward_epochs` row records its `pool_address`. Pending-funding FIFO resolution runs per pool. Once V1's unallocated balance for a token is under the dust guard, that token is V2-only forever. No epoch is ever split across pools.
4. **Gateway `/query`** returns `poolAddress` with each unclaimed epoch; **frontend** groups epochs by pool and sends one transaction per pool: V1 → `claimBatch` (unchanged), V2 → `claimBatchAs`. The panel shows a "Legacy pool" sub-section while any V1 epochs remain; when none remain it disappears. Old-pool claims are always ETH.
5. **Hook re-point**, only after 1–4 are live and verified: `RepointHookLossRewardPool.s.sol` calls `legibleHook.setLossRewardPool(V2)`. From that transaction every `collect()` and converter deposit for every token on that hook lands in V2. The live GenericSell hook cannot be re-pointed (immutable); its single token (TESTINGG) keeps feeding V1, which the dual-pool worker keeps draining — no special case.
6. **Indexer** sums both pools for `loss_pool_tvl_eth`.

**Every place the V1 address is hardcoded** (from `grep`), and what to do:

| Site | Action |
|---|---|
| `src/lib/uniswapAddresses.ts:32` | `LOSS_REWARD_POOL` → V2 via `VITE_LOSS_REWARD_POOL`; add `LOSS_REWARD_POOL_LEGACY` via `VITE_LOSS_REWARD_POOL_LEGACY` (default V1) |
| `src/lib/integration/index.ts:26` | same two exports |
| `scripts/loss-reward-worker.mjs:98` | `LOSS_REWARD_POOL_ADDRESS` (V2) + `LOSS_REWARD_POOL_LEGACY_ADDRESS` (V1) |
| `scripts/evm-indexer.mjs:111` | both, summed |
| `supabase/functions/loss-reward-gateway/index.ts:42` | both, `pool_address` per epoch |
| `scripts/claim-loss-rewards.mjs:43` | `--pool` flag, default V2, `--min-out`/`--deadline` |
| `scripts/check-live-deployment.mjs:21` | check both |
| `src/lib/incentifiBondingCurveFactoryBytecode.ts:269`, `src/lib/incentifiSwapRouterBytecode.ts:303`, `scripts/generate-deploy-bytecode.mjs:42`, `scripts/verify-factory.mjs:20`, `scripts/verify-router.mjs:25`, `scripts/verify-v3-fix-mainnet.ts:73`, `scripts/deploy-v3-fixed-factory-and-router.ts:60` | V3-curve deploy/verify artefacts: leave as-is (they describe the deployed V3 contracts, which point at V1 immutably) |
| `scripts/deploy-v4-hook-*.ts`, `scripts/verify-v4-hook-production-mainnet.ts`, `scripts/.v*-deployment-result.json` | historical deploy records: leave as-is |

**Env vars to set:** Vercel `VITE_LOSS_REWARD_POOL`, `VITE_LOSS_REWARD_POOL_LEGACY`; Railway (worker + indexer) `LOSS_REWARD_POOL_ADDRESS`, `LOSS_REWARD_POOL_LEGACY_ADDRESS` (the worker currently reads `VITE_LOSS_REWARD_POOL` — normalise); Supabase function secrets `LOSS_REWARD_POOL_ADDRESS`, `LOSS_REWARD_POOL_LEGACY_ADDRESS`. The hardcoded V1 fallbacks in the four runtime sites are replaced by a fail-loud "address not configured" so a stale deploy cannot silently publish epochs to the wrong pool.

## B7. Off-chain changes

- **Worker:** dual-pool selection (§B6), `pool_address` on every `reward_epochs` insert, ABI additions (`rewardAsset`, `epochClaimedAmounts` for reconciliation). No change to epoch maths, leaves, dust guard, freshness gate, balance cap.
- **Indexer:** TVL from both pools. Nothing else — `Bought`/`Sold` are untouched.
- **Gateway:** `poolAddress` and `rewardAsset` in `/query`; `/claim` (relayer) stays deprecated and returns the "use your wallet" message.
- **Frontend**
  - *Launch page:* "Loss-reward payout asset" dropdown: ETH (default) + assets where `assetRoute(asset).enabled` on-chain **and** the API lists `ASSET_STATUS_ACTIVE`, showing name/logo from the API. Below it, the B3 sentence. `createEvmToken` passes the address to `launchToken(token, asset)`.
  - *Token page:* badge "Loss Reward: AAPL" (or "ETH", or "ETH (forced)" after an override) from `pool.rewardAsset(token)`, mirrored into `tokens.reward_asset` by the launch flow for lists. Claim panel: claimable ETH (unchanged), "you will receive ≈ X AAPL" from a QuoterV2 quote on the configured route, slippage control (default 1%), the B3 copy, and the legacy-pool sub-section.
  - **`uiMultiplier` — required for every stock number shown.** Balances and swap outputs are raw ERC-20 amounts; Robinhood's app displays `raw × uiMultiplier() / 1e18` (AAPL is at 1.000566 today after a corporate action; TSLA/NVDA at 1.0). The estimate, the post-claim receipt and any wallet-balance display must apply the multiplier or users will see numbers that disagree with Robinhood by the multiplier. `rewardAssets.ts` exposes `toDisplayShares(raw, asset)` reading `uiMultiplier()`, and shows a note when `newUIMultiplier()`/`effectiveAt()` announce a pending change.
- **Docs/whitepaper pages:** one paragraph on the payout-asset option and the "you receive whatever it buys" rule.

## B8. Open question: should V2 accept deposits denominated in the stock?

**Recommendation: ETH-only, forever.** Reasons: (1) the custody constraint — the pool must never hold stock, and a stock deposit would have to be sold to ETH inside the deposit, adding a sell route, price risk and a second swap surface for a feature nobody has asked for; (2) the whole epoch machine (leaves, allocations, dust guard, `getUnallocatedBalance`) is ETH-denominated and the worker's budgeting would need a valuation oracle for stock sitting in the pool; (3) a creator who wants to fund rewards with AAPL can sell it and call `depositReward{value}` today, with no protocol change. If sponsor deposits are ever wanted, build them as a separate "sponsor converter" contract (same pattern as PR #17's `FeeConverter`) that sells to ETH and calls `depositReward`; the pool's code never changes and never touches stock.

## B9. V2 pool fixes

- **Bare ETH is rejected: `receive()` reverts `BareEthRejected()`.** Why revert rather than a labelled sink: bare ETH is unattributable, and a sink would need an owner-only "attribute this to token X" lever — a new privileged action that can move value between tokens' budgets. Reverting is loss-free (the sender keeps their ETH, the transaction simply fails) and keeps the invariant below exact. The hook, converter and worker never send bare ETH; the only path in is `depositReward(token)`.
- **Strict per-token accounting, enforced.** V1 only checks `allocated ≤ deposited` at allocation; a Merkle root whose leaves sum to more than the epoch's allocation could drain other tokens' ETH. V2 adds `epochClaimedAmounts[token][epochId] += amount; require(≤ epochAllocatedAmounts[token][epochId])` (`EpochOverClaimed`). With that, claims ≤ Σ allocations ≤ deposits per token, and because bare ETH is rejected and swaps consume exactly `amount`, the invariant **`address(this).balance == Σ_token (totalDeposited − totalClaimed)`** holds exactly and is asserted in tests. `tokenVault(token)` exposes it.
- **Unchanged on purpose:** `depositReward`, `setEpochMerkleRoot`, `claimReward`, `claimBatch`, the leaf format, `onlyOperator` (= operator or owner), `setOperator`, `transferOwnership`, all V1 events and errors.

## B10. Test plan (Phase C, Foundry, Robinhood mainnet fork, real registry/factory/pools)

Foundry, Robinhood mainnet fork, real StockFactory / access registry / stock tokens / Uniswap V3 pools. `test/foundry/LossRewardPoolV2.t.sol` (21) + `test/foundry/LossRewardPoolV2Hook.t.sol` (3, wired to the PR #17 hook/factory/converter). **24/24 passing.**

| Case | Test | Result |
|---|---|---|
| ETH reward byte-for-byte unchanged | `test_EthClaim_ParityWithV1` — V1 and V2 side by side, identical `RewardClaimed` topics+data, balances, counters; V1 signatures | pass |
| AAPL reward: claim receives AAPL, ETH consumed | `test_StockClaim_AAPL` | pass |
| TSLA on another token, same block, no cross-contamination | `test_TwoAssets_SameBlock_NoCrossContamination` | pass |
| Creator ETH unaffected | `test_HookFeesFundV2_StockClaim_CreatorEthUntouched` (hook `creatorBalances` before/after, then pulled) | pass |
| Non-setter / non-creator cannot set; A's creator cannot set B's | `test_SetRewardAsset_Authorisation`, `test_FactoryLaunchWithRewardAsset_AgainstV2_SetsIt` | pass |
| Arbitrary / non-registry address rejected (asset and route) | `test_NonRegistryAssetRejected` | pass |
| Registry-valid at launch, invalid at claim → ETH fallback + event | `test_RegistryInvalidAtClaim_FallsBackToEth` | pass |
| Below user minOut → revert; below protocol bound → fallback; distinguishable | `test_UserBoundBinding_RevertsMinOutNotMet`, `test_ProtocolBoundBinding_FallsBack_and_UserBoundStillReverts` (60 ETH push inside the block) | pass |
| Paused stock → fallback (and not selectable) | `test_PausedAtClaim_FallsBackToEth` | pass |
| Empty / thin liquidity → fallback, no swap | `test_ThinLiquidity_FallsBackWithoutSwapping` | pass |
| Claimant blocked → fallback | `test_ClaimantBlocked_FallsBackToEth` | pass |
| Route disabled → fallback | `test_AssetDisabled_FallsBack` | pass |
| Batch below min → ETH; batch above min → stock; mixed epochs | `test_MinimumReward_BatchTotal` | pass |
| V1 signature on stock token reverts; on ETH / forced / below-min pays ETH | `test_V1Signatures_OnStockToken`, `test_EthClaim_ParityWithV1` | pass |
| Reentrancy: propagated → claim reverts; swallowed → paid once | `test_Reentrancy_RevertsAndNeverDoublePays` | pass |
| `forceEthPayout`: works, emits, owner-only, irreversible | `test_ForceEthPayout` | pass |
| Accounting: paid + swapped + remaining == deposited, per token, mixed batch | `test_Accounting_MixedBatch` (6 claims, 3 tokens, 2 users, one fallback) | pass |
| Adapter holds zero after every path | `assertNoCustody()` in every stock-path test (success, fallback, revert) | pass |
| Per-epoch cap: a root over-committing an epoch cannot drain | `test_EpochOverClaimed_PerTokenAccountingIsEnforced` | pass |
| Bare ETH rejected (pool and adapter); deadline; adapter entrypoint pool-only | `test_BareEthRejected`, `test_DeadlineExpired`, `test_AdapterSwapOnlyByPool` | pass |
| Factory launch with rewardAsset: against V2 sets it (and surfaces V2's rejection); against V1 reverts | `test_FactoryLaunchWithRewardAsset_AgainstV2_SetsIt`, `…_AgainstV1_Reverts` | pass |
| Deploy script runs with an EOA sender | `forge script script/DeployLossRewardPoolV2.s.sol --sender 0x1111…` dry run (no broadcast): routes validated against the live V3 factory, all three assets selectable | pass |

## C5. Measured numbers (Phase C, Robinhood fork, block ≈ 56.87M)

| Measurement | Value |
|---|---|
| `claimBatchAs`, 1 epoch, empty proof, **AAPL** payout (pre-checks + TWAP + wrap + swap + delivery) | **352,223 gas** |
| `claimBatchAs`, 1 epoch, empty proof, **ETH** payout | **120,144 gas** |
| Stock-path overhead | **≈ 232k gas** ≈ 0.00007 ETH at 0.305 gwei (L1 data component 0) |
| V1 `claimReward`, 1 epoch, empty proof (baseline) | 82,421 gas |
| 0.05 ETH → AAPL via the 0.05% pool (probe, direct swap) | 0.38881 AAPL raw (× uiMultiplier 1.000566 for display) |
| Same-block 60 ETH push on the AAPL/WETH pool | 30-min TWAP reference unchanged to the wei; spot output fell below the 3% floor → `BelowProtocolBound` fallback |
| `minStockRewardWei` default | 0.002 ETH (5%-rule value today ≈ 0.0014 ETH) |

Slippage observed per asset in the suite (0.05–0.07 ETH claims, quiet pool): AAPL, TSLA, NVDA deliveries all above 99% of the TWAP-implied output (the user `minOut` used in `test_StockClaim_AAPL` is 99% of the reference and is met).

## B11. Risks and what is not verified

- **Upgradeable counterparties.** StockFactory (UUPS) and every Stock (shared beacon) are upgradeable by Robinhood roles; the registry round-trip and the pause/blocklist semantics are trusted as of today's verified source. The fallback design means an adverse upgrade degrades to ETH payouts, not to stuck rewards.
- **Owner route power** is bounded to canonical V3 pools by `validateRoute`, but a shallow canonical pool would push claims to the fallback via the TWAP bound; route changes are evented.
- **TWAP manipulation** is bounded, not eliminated (§B4). The user's `minAssetOut` is the primary guard.
- **Not audited:** the `FablesRampETH` hook on the USDG/ETH pool (irrelevant while MSFT is deferred).
- **Not measured yet:** gas of the full V2 claim with adapter overhead (C5), and behaviour of `observe()` under a burst that fills TSLA's 300-slot ring inside 30 minutes (handled by the 600 s retry and ETH fallback).
