import { createClient } from '@supabase/supabase-js';
import {
  createPublicClient,
  parseAbiItem,
  createWalletClient,
  parseAbi,
  getAddress,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  concat,
  decodeEventLog,
  formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import { isLegibleToken, fetchLegibleState, computeUncollectedLegibleFees, INCENTIFI_LEGIBLE_HOOK, INCENTIFI_LEGIBLE_FEE_CONVERTER, LEGIBLE_HOOK_ABI, LEGIBLE_CONVERTER_ABI } from './lib/legiblePool.mjs';
import { createFailoverRpc, parseRpcUrls } from './lib/rpcFailover.mjs';
import { readBalanceReliably } from './lib/reliableBalance.mjs';

// ============================================================================
// CRASH-RECOVERY & IDEMPOTENCY MATRIX
// ============================================================================
// A. Crash before calculation:
//    - State: 0 mutations on-chain, 0 mutations in DB.
//    - Recovery: Worker re-runs cleanly on next tick.
//
// B. Crash during calculation / Merkle tree construction:
//    - State: In-memory only. 0 mutations on-chain, 0 mutations in DB.
//    - Recovery: Worker re-evaluates inputs and re-calculates cleanly.
//
// C. Crash before blockchain transaction:
//    - State: Cost basis untouched, DB untouched, on-chain root unset.
//    - Recovery: Safe to re-run from Step 1.
//
// D. Blockchain transaction rejected / reverted:
//    - State: On-chain root remains 0x0. Cost basis is NOT depleted. DB is NOT modified.
//    - Recovery: Worker logs failure and aborts; protected basis is fully preserved.
//
// E. Blockchain transaction submitted but confirmation delayed / RPC timeout:
//    - State: Transaction may be pending in mempool.
//    - Recovery: Worker does NOT assume failure or resubmit blindly. On-chain reconciliation
//      checks epochMerkleRoots(token, epochNumber) to verify confirmation.
//
// F. Blockchain transaction confirmed on-chain:
//    - State: epochMerkleRoots(token, epochNumber) is set on-chain.
//    - Recovery: Proceed to database persistence.
//
// G. Crash immediately after on-chain confirmation (before DB insert):
//    - State: On-chain root is published, but DB lacks reward_epochs/epoch_holder_rewards.
//    - Recovery: On next run, reconciliation detects State 3 (Chain present, DB absent).
//      It reconstructs Merkle proofs from deterministic inputs, verifies matching root,
//      persists DB records, and applies cost-basis depletion without publishing on-chain twice.
//
// H. DB reward_epochs insert failure:
//    - State: On-chain root published, DB insert failed.
//    - Recovery: Handled by State 3 reconciliation on retry.
//
// I. DB epoch_holder_rewards insert failure:
//    - State: reward_epochs inserted, proofs insert failed. Cost basis NOT yet depleted.
//    - Recovery: Cascade delete unconfirmed reward_epochs or backfill missing proofs on retry.
//
// J. Crash before cost-basis depletion:
//    - State: Merkle proofs exist, root is published, cost basis not yet depleted.
//    - Recovery: On-chain proof is already valid for claims. Subsequent epoch will detect
//      already-published epoch and avoid double-allocation.
//
// K. Crash during cost-basis update loop:
//    - State: Partial holders depleted.
//    - Recovery: Unique constraint on (epoch_id, wallet_address) prevents double reward generation.
//
// L. Second worker starts while first is active:
//    - State: Two simultaneous executions.
//    - Recovery: Active in-process lock prevents concurrent runs per token. On-chain
//      EpochAlreadyPublished() revert and DB UNIQUE(token_address, epoch_number) constraint
//      prevent double-allocation across independent processes.
// ============================================================================

// Robust .env.local loader (safe, non-printing)
if (fs.existsSync('.env.local')) {
  const envContent = fs.readFileSync('.env.local', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [k, ...v] = line.split('=');
    const keyName = k.trim();
    let val = v.join('=').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (keyName && val.length > 0) {
      process.env[keyName] = val;
    }
  }
}

// Environment Configuration with safe defaults
// RPC_URLS (comma-separated) with failover (scripts/lib/rpcFailover.mjs); legacy single variable still honoured.
const RPC_URLS = parseRpcUrls(process.env);
export const rpcFailover = createFailoverRpc(RPC_URLS, { name: 'worker', timeoutMs: Number(process.env.RPC_TIMEOUT_MS || 20_000) });
const rpcTransport = rpcFailover.transport;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || '';
const LOSS_REWARD_POOL_ADDRESS = process.env.VITE_LOSS_REWARD_POOL || '0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf';
const INCENTIFI_FACTORY_ADDRESS = process.env.VITE_INCENTIFI_BONDING_CURVE_FACTORY || '0xa0143de84fba1753b887e4e32941e4fb342e473f';
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
// LossRewardPoolV2 (creator-selected stock payouts). Optional until V2 is deployed; when set, the
// worker polls RewardPaidInEthFallback on every run — see monitorFallbackEvents() below.
const LOSS_REWARD_POOL_V2_ADDRESS = process.env.LOSS_REWARD_POOL_V2_ADDRESS || '';
// Dual-pool mode (docs/LOSS_REWARD_ASSET_DESIGN.md section B6). V1 is the live pool every token
// has been funded into so far; V2 is LossRewardPoolV2. Until LOSS_REWARD_POOL_V2_ADDRESS is set
// every path below behaves exactly as before (V1 only).
const LOSS_REWARD_POOL_V1_ADDRESS = LOSS_REWARD_POOL_ADDRESS;
const WORKER_NAME = 'loss-reward-worker';
// Legible-pool fee collection (see collectLegibleFees below). Fees on a legible pool sit inside the
// PoolManager position until hook.collect(token) is called, and token-side fees sit in the
// converter until convert(token, 0, 0): nothing on-chain does either. The worker does, when the
// value clears a multiple of the gas it costs.
const FEE_COLLECT_ENABLED = String(process.env.FEE_COLLECT_ENABLED || 'true').toLowerCase() !== 'false';
const FEE_COLLECT_MIN_MULTIPLE = Number(process.env.FEE_COLLECT_MIN_MULTIPLE || 10);
const FEE_COLLECT_LOOKBACK_HOURS = Number(process.env.FEE_COLLECT_LOOKBACK_HOURS || 24);
const FEE_TX_GAS_FLOOR = 300_000n; // same rule as every legible-pool transaction: estimate + 30%, never below this
// Operator runway alert (audit 2026-09-08 finding 2): alert when the operator wallet holds less than
// OPERATOR_MIN_RUNWAY_DAYS of gas at the observed cadence (publishes + collects + converts in the last
// 24 h, floored at one continuously-underwater token = 288 publishes/day).
const OPERATOR_MIN_RUNWAY_DAYS = Number(process.env.OPERATOR_MIN_RUNWAY_DAYS || 3);
const OPERATOR_ALERT_INTERVAL_MS = Number(process.env.OPERATOR_ALERT_INTERVAL_MS || 6 * 3600 * 1000);
export const PUBLISH_GAS_ESTIMATE = 80_000n;   // measured 79,812 (tx 0x019b0d24…)
export const COLLECT_GAS_ESTIMATE = 180_000n;  // measured estimate 178,993
export const CONVERT_GAS_ESTIMATE = 250_000n;

/**
 * Indexer freshness gate: scripts/evm-indexer.mjs (worker_name 'evm-indexer') upserts a
 * heartbeat to `indexer_heartbeats` on every successful (or failed) poll of its 10-second
 * loop. `holder_cost_basis` — the table this worker reads "who is in loss" from — is
 * populated exclusively by that indexer, so a stale or missing heartbeat means the
 * eligibility data below could be trailing real chain state by an unknown amount.
 *
 * Threshold: 120 seconds (2 minutes) — 12x the indexer's normal 10-second poll cadence
 * (generous headroom for a one-off slow batch or RPC hiccup) while still comfortably
 * under the 5-minute snapshot cadence (SNAPSHOT_INTERVAL_SECONDS), so a genuinely stuck
 * indexer is caught before more than one epoch could run against stale data.
 * FLAGGING FOR CONFIRMATION: adjust if the indexer's real-world cadence differs.
 */
export const INDEXER_FRESHNESS_THRESHOLD_SECONDS = 120;
const EVM_INDEXER_WORKER_NAME = 'evm-indexer';

/** Loss-Reward Snapshot Interval: 5 minutes (300 seconds) */
export const SNAPSHOT_INTERVAL_SECONDS = 300;
export const SNAPSHOT_INTERVAL_MINUTES = 5;

/**
 * Minimum-payout dust guard. If a candidate epoch's total allocated amount
 * would round to fewer wei than this, the epoch is recorded as
 * `completed_dust` instead of computing a Merkle tree and submitting a real
 * setEpochMerkleRoot() transaction.
 *
 * Why this exists: `theoreticalReward = 0.10 * unrealizedLoss` (below), combined
 * with immediately depleting a holder's cost basis by exactly what was just
 * paid (step 13), is a geometric decay — each cycle's reward is exactly 90% of
 * the previous cycle's, converging toward zero but never cleanly reaching it.
 * With no floor, the worker keeps submitting a real, successful
 * setEpochMerkleRoot() transaction every 5 minutes, forever, once a position
 * has decayed into economic irrelevance. This is not hypothetical: real
 * production transactions for one position show its on-chain payout decaying
 * by exactly 0.9x every single 5-minute epoch (267,028 -> 49,481 wei across 16
 * consecutive real transactions, each costing real gas — ~79,263 gas at
 * ~0.35 gwei, ~2.8e13 wei — for a reward already far below that cost).
 *
 * Default: 1e13 wei (0.00001 ETH), chosen to sit near that measured real-world
 * gas cost — i.e. "don't spend more recording a reward on-chain than the
 * reward itself is worth." Configurable via MIN_EPOCH_PAYOUT_WEI for operators
 * who want a different floor without a code change.
 */
export const MIN_EPOCH_PAYOUT_WEI = BigInt(process.env.MIN_EPOCH_PAYOUT_WEI || '10000000000000');

/**
 * Pure decision function for the minimum-payout dust guard — extracted so
 * tests can exercise the real guard logic directly (not a hand-mirrored copy
 * of it) without needing the live Supabase/RPC clients executeEpochForToken()
 * itself depends on.
 */
export function evaluateDustGuard(totalDistributedEth, thresholdWei = MIN_EPOCH_PAYOUT_WEI) {
  const candidateAllocatedWei = BigInt(Math.round(totalDistributedEth * 1e18));
  return { candidateAllocatedWei, isDust: candidateAllocatedWei < thresholdWei };
}

/**
 * On-chain balance guard (pure). `holder_cost_basis` is fed by scripts/evm-indexer.mjs and can
 * lag or miss a sell entirely (2026-09-07: a failed V4 discovery scan left a fully-sold wallet
 * recorded as holding 18.7M tokens and the worker published 15 epochs against it). The chain
 * is the authority on what a wallet holds, so every payout is computed on
 * min(dbBalance, onChainBalance). `invested` is scaled by the SAME ratio — the loss formula
 * is `invested - balance * price`, so capping balance alone would INFLATE the loss (a zero
 * balance would pay 10% of everything ever invested); scaling both preserves the recorded
 * average cost basis and pays only for tokens actually held.
 */
export function applyOnChainBalanceCap(holder, onChainBalanceTokens) {
  const dbBalance = Number(holder.token_balance);
  const invested = Number(holder.total_invested_eth);
  if (!Number.isFinite(onChainBalanceTokens) || onChainBalanceTokens < 0) {
    throw new Error(`[BALANCE GUARD] Invalid on-chain balance for ${holder.wallet_address}: ${onChainBalanceTokens}`);
  }
  if (onChainBalanceTokens >= dbBalance) {
    return { balance: dbBalance, invested, capped: false, dbBalance, onChainBalance: onChainBalanceTokens };
  }
  const ratio = dbBalance > 0 ? onChainBalanceTokens / dbBalance : 0;
  return { balance: onChainBalanceTokens, invested: invested * ratio, capped: true, dbBalance, onChainBalance: onChainBalanceTokens };
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const publicClient = createPublicClient({ transport: rpcTransport });

const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);

const FACTORY_ABI = parseAbi([
  'function getBondingCurve(address token) view returns (address)',
  'function isGraduated(address token) view returns (bool)',
]);

const BONDING_CURVE_ABI = parseAbi([
  'function realEthReserve() view returns (uint256)',
  'function realTokenReserve() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function uniswapPool() view returns (address)',
  'function getCurrentPrice() view returns (uint256)',
]);

const UNISWAP_V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

const POOL_ABI = parseAbi([
  'function getUnallocatedBalance(address token) view returns (uint256)',
  'function epochMerkleRoots(address token, uint256 epochId) view returns (bytes32)',
  'function epochAllocatedAmounts(address token, uint256 epochId) view returns (uint256)',
  'function setEpochMerkleRoot(address token, uint256 epochId, bytes32 merkleRoot, uint256 allocatedAmount) external',
]);

// In-process lock tracker to prevent concurrent execution on the same token
const activeTokenLocks = new Set();

/**
 * Drain-then-switch, PER TOKEN (section B6). Which pool this token's NEXT epoch is published on:
 *   - V2 not configured      -> V1 (today's behaviour, unchanged: an underfunded epoch is parked
 *                               as pending_funding until V1 is topped up)
 *   - V1 unallocated >= dust -> V1. If V1 cannot cover this epoch's full demand the epoch is
 *                               published on V1 anyway, CAPPED to V1's unallocated balance
 *                               (`capToV1`): rewards are scaled pro-rata so V1 is emptied to the
 *                               wei. V1 has no withdraw, so this is the only way its remainder
 *                               ever reaches holders once the hook deposits into V2.
 *   - V1 unallocated <  dust -> V2 (V1 is drained)
 * Pending epochs keep the pool they were recorded on (reward_epochs.pool_address).
 * Never throws: an RPC failure reading V1 falls back to V1 (the status quo).
 */
export async function resolveEpochPool(tokenAddress, demandWei = 0n, options = {}) {
  const v1 = options.v1 ?? LOSS_REWARD_POOL_V1_ADDRESS;
  const v2 = options.v2 ?? LOSS_REWARD_POOL_V2_ADDRESS;
  const dustWei = options.dustWei ?? MIN_EPOCH_PAYOUT_WEI;
  const client = options.client ?? publicClient;
  if (!v2) return { address: v1, version: 'v1', reason: 'v2_not_configured', capToV1: false, v1UnallocatedWei: null };
  let v1UnallocatedWei;
  try {
    v1UnallocatedWei = BigInt(
      await client.readContract({ address: getAddress(v1), abi: POOL_ABI, functionName: 'getUnallocatedBalance', args: [getAddress(tokenAddress)] })
    );
  } catch (err) {
    console.warn(`[POOL SELECT] Could not read V1 unallocated balance for ${tokenAddress} (${err.message}); staying on V1.`);
    return { address: v1, version: 'v1', reason: 'v1_read_failed', capToV1: false, v1UnallocatedWei: null };
  }
  const demand = BigInt(demandWei || 0n);
  if (v1UnallocatedWei >= dustWei) {
    const capToV1 = demand > v1UnallocatedWei;
    return { address: v1, version: 'v1', reason: capToV1 ? 'v1_drain_capped' : 'v1_can_fund', capToV1, v1UnallocatedWei };
  }
  return { address: v2, version: 'v2', reason: 'v1_drained', capToV1: false, v1UnallocatedWei };
}

/**
 * Pro-rata allocation in exact wei. Each holder gets floor(theoretical_i * available / demand),
 * so the sum never exceeds `availableWei` and the on-chain allocation (the sum of the leaves) is
 * exactly what the pool has. Exported for tests. With available >= demand this is the identity.
 */
const allocatedWeiOf = (weiList) => weiList.reduce((a, b) => a + b, 0n);
/** wei -> the wei the gateway/UI rebuild from the stored ETH float (`Math.round(Number(eth) * 1e18)`). */
export function floatRoundTripWei(wei) {
  const rt = (w) => BigInt(Math.round((Number(w) / 1e18) * 1e18));
  let a = rt(BigInt(wei));
  for (let pass = 0; pass < 64; pass++) {
    const b = rt(a);
    if (b === a) return a; // fixed point: what is stored is what is rebuilt
    a = pass % 2 ? b : a - 1n; // rarely (1 in 10k) the round trip cycles; nudge down a wei and retry
  }
  throw new Error(`floatRoundTripWei: no fixed point near ${wei}`);
}
export const LEAF_STABILIZE_SLACK_WEI = 1_000_000n; // 1e-12 ETH kept back when a re-cap is needed

/**
 * Makes every leaf amount a fixed point of the float round trip. epoch_holder_rewards stores
 * final_reward_eth as a NUMBER and the gateway rebuilds the claim amount as
 * BigInt(Math.round(eth * 1e18)); above ~2^52 wei (~0.0045 ETH) that is not the wei the leaf was
 * hashed with, and the Merkle proof fails on-chain. Applying the round trip here first (and storing
 * that value) closes the gap. If the adjusted sum overshoots `availableWei` the list is re-capped to
 * `availableWei - slack` and adjusted again (the adjustment moves each leaf by at most a few hundred
 * wei, far below the slack). Returns { finalWei, allocatedWei }.
 */
export function stabilizeLeafWei(weiList, availableWei, slackWei = LEAF_STABILIZE_SLACK_WEI) {
  let out = weiList.map((w) => (w > 0n ? floatRoundTripWei(w) : 0n));
  if (allocatedWeiOf(out) > availableWei) {
    const target = availableWei > slackWei ? availableWei - slackWei : 0n;
    out = capAllocationsToAvailable(weiList, target).finalWei.map((w) => (w > 0n ? floatRoundTripWei(w) : 0n));
    if (allocatedWeiOf(out) > availableWei) throw new Error(`stabilizeLeafWei: ${allocatedWeiOf(out)} > ${availableWei} after re-cap`);
  }
  return { finalWei: out, allocatedWei: allocatedWeiOf(out) };
}
export function capAllocationsToAvailable(theoreticalWeiList, availableWei) {
  const demand = theoreticalWeiList.reduce((a, b) => a + b, 0n);
  if (demand === 0n || availableWei >= demand) return { finalWei: [...theoreticalWeiList], scalingFactor: 1, allocatedWei: demand };
  const finalWei = theoreticalWeiList.map((t) => (t * availableWei) / demand);
  const allocatedWei = finalWei.reduce((a, b) => a + b, 0n);
  return { finalWei, scalingFactor: Number(availableWei) / Number(demand), allocatedWei };
}

/**
 * reward_epochs insert that tolerates a not-yet-applied migration: if PostgREST rejects the
 * pool_address column (supabase/loss_reward_v2_migration.sql not run), retry without it and warn
 * once. The gateway treats a null pool_address as V1, which is what an un-migrated deployment is.
 */
let warnedPoolAddressColumn = false;
async function insertRewardEpoch(row, select = null, { upsert = false } = {}) {
  const write = (r) => (upsert ? supabase.from('reward_epochs').upsert(r, { onConflict: 'token_address,epoch_number' }) : supabase.from('reward_epochs').insert(r));
  let q = write(row);
  let res = select ? await q.select(select).single() : await q;
  if (res.error && row.pool_address !== undefined && /pool_address|column/i.test(res.error.message || '')) {
    if (!warnedPoolAddressColumn) {
      console.warn('[DB] reward_epochs.pool_address is missing — apply supabase/loss_reward_v2_migration.sql. Inserting without it (readers treat null as V1).');
      warnedPoolAddressColumn = true;
    }
    const { pool_address, ...rest } = row;
    q = write(rest);
    res = select ? await q.select(select).single() : await q;
  }
  return res;
}

async function sendAlert(message) {
  console.error(`[ALERT] ${WORKER_NAME}: ${message}`);
  if (!ALERT_WEBHOOK_URL) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `[${new Date().toISOString()}] ${WORKER_NAME}: ${message}` }),
    });
  } catch {
    // ignore alert transport failure — the console.error above is the durable record
  }
}

/**
 * Checks whether scripts/evm-indexer.mjs's heartbeat is fresh enough to trust
 * `holder_cost_basis` for a snapshot. Returns { fresh: boolean, reason, ageSeconds }.
 * Missing heartbeat is treated the same as a stale one — the indexer may simply never
 * have started, which is just as dangerous as it having stalled.
 */
export async function checkIndexerFreshness(options = {}) {
  const thresholdSeconds = options.thresholdSeconds ?? INDEXER_FRESHNESS_THRESHOLD_SECONDS;
  const nowMs = options.nowMs ?? Date.now();

  const { data: heartbeat, error } = await supabase
    .from('indexer_heartbeats')
    .select('worker_name, status, message, updated_at')
    .eq('worker_name', EVM_INDEXER_WORKER_NAME)
    .maybeSingle();

  if (error) {
    return { fresh: false, reason: `DB error reading indexer_heartbeats: ${error.message}`, ageSeconds: null };
  }

  if (!heartbeat) {
    return { fresh: false, reason: `No heartbeat found for indexer worker "${EVM_INDEXER_WORKER_NAME}" — indexer may never have run.`, ageSeconds: null };
  }

  const updatedAtMs = Date.parse(heartbeat.updated_at);
  if (!Number.isFinite(updatedAtMs)) {
    return { fresh: false, reason: `Indexer heartbeat has an unparsable updated_at: ${heartbeat.updated_at}`, ageSeconds: null };
  }

  const ageSeconds = (nowMs - updatedAtMs) / 1000;
  if (ageSeconds > thresholdSeconds) {
    return {
      fresh: false,
      reason: `Indexer heartbeat is stale: last updated ${ageSeconds.toFixed(1)}s ago, threshold is ${thresholdSeconds}s (status="${heartbeat.status}", message="${heartbeat.message}").`,
      ageSeconds,
    };
  }

  if (heartbeat.status === 'error') {
    return {
      fresh: false,
      reason: `Indexer heartbeat is fresh (${ageSeconds.toFixed(1)}s ago) but reports status="error": ${heartbeat.message}`,
      ageSeconds,
    };
  }

  return { fresh: true, reason: null, ageSeconds };
}

/**
 * Standard OpenZeppelin-compatible Merkle Tree builder
 */
export class MerkleTree {
  constructor(leaves) {
    this.leaves = leaves.map((leaf) => leaf.toLowerCase());
    this.layers = [this.leaves];
    this._buildTree();
  }

  _hashPair(a, b) {
    return a <= b
      ? keccak256(concat([a, b]))
      : keccak256(concat([b, a]));
  }

  _buildTree() {
    while (this.layers[this.layers.length - 1].length > 1) {
      const currentLayer = this.layers[this.layers.length - 1];
      const nextLayer = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(this._hashPair(currentLayer[i], currentLayer[i + 1]));
        } else {
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
    }
  }

  getRoot() {
    return this.layers[this.layers.length - 1][0] || '0x0000000000000000000000000000000000000000000000000000000000000000';
  }

  getProof(leafIndex) {
    const proof = [];
    let currentIndex = leafIndex;
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }
    return proof;
  }
}

/**
 * Generates double-hashed leaf matching LossRewardPool.sol:
 * keccak256(bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount))))
 */
export function hashLeaf(tokenAddress, epochId, claimant, amountWei) {
  const innerHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('address token, uint256 epochId, address claimant, uint256 amount'),
      [getAddress(tokenAddress), BigInt(epochId), getAddress(claimant), BigInt(amountWei)]
    )
  );
  return keccak256(innerHash);
}

// V4 price logic is NOT reimplemented here. src/lib/bondingCurveV4.ts's fetchV4CurveState()
// is the single, already-verified implementation (hook.curveStates(poolId) virtual-reserve
// math pre-graduation; StateView.getSlot0(poolId) post-graduation) that the site and
// scripts/evm-indexer.mjs both read from, so this worker loads that same TypeScript module
// through Vite's SSR loader exactly the way the indexer already does — one price formula for
// the whole app to drift out of sync with, not two. The Vite server is created lazily, once
// per process (a one-time startup cost for a long-running worker), never per call.
let v4ViteServerPromise = null;
let v4ModulePromise = null;
async function getV4Module() {
  if (!v4ModulePromise) {
    v4ViteServerPromise = createViteServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom', logLevel: 'warn' });
    v4ModulePromise = v4ViteServerPromise.then((viteServer) => viteServer.ssrLoadModule('/src/lib/bondingCurveV4.ts'));
    v4ModulePromise.catch(() => {
      // Don't cache a failed load — the next price lookup retries it.
      v4ModulePromise = null;
      v4ViteServerPromise = null;
    });
  }
  return v4ModulePromise;
}

/** Tears down the lazily-created Vite server (tests only — lets the process exit cleanly). */
export async function closeV4Module() {
  if (!v4ViteServerPromise) return;
  const viteServer = await v4ViteServerPromise.catch(() => null);
  v4ViteServerPromise = null;
  v4ModulePromise = null;
  if (viteServer) await viteServer.close();
}

/**
 * Resolves the authoritative benchmark price for a token:
 * - V3 PRE-GRADUATION: Queries the Incentifi Bonding Curve getCurrentPrice() (or reserve calculation).
 * - V3 GRADUATED: Queries the canonical Uniswap V3 Pool 30-minute TWAP (with slot0 fallback).
 * - V4 (no V3 curve registered for the token): fetchV4CurveState() — hook.curveStates(poolId)
 *   pre-graduation, StateView.getSlot0(poolId) post-graduation (see getV4Module above).
 */
export async function getTokenBenchmarkPriceEth(tokenAddress) {
  const token = getAddress(tokenAddress);
  const factory = getAddress(INCENTIFI_FACTORY_ADDRESS);

  // LEGIBLE POOL (PR #17): a real V4 pool, so the benchmark is the pool's own slot0 price —
  // before AND after graduation (the curve IS the pool; there is no separate virtual-reserve
  // regime to read). One cheap factory read decides; the older paths below are untouched.
  try {
    if (await isLegibleToken(publicClient, token)) {
      const state = await fetchLegibleState(publicClient, token);
      if (state.currentPriceEth > 0) {
        return { priceEth: state.currentPriceEth, isGraduated: state.graduated, source: 'v4_legible_slot0' };
      }
      console.warn(`[LEGIBLE PRICE] ${token} is legible-launched but slot0 resolved to a zero price (initialized=${state.initialized}, graduated=${state.graduated}).`);
      return { priceEth: 0, isGraduated: state.graduated, source: 'unknown' };
    }
  } catch (err) {
    console.warn(`[LEGIBLE PRICE] Could not read the legible factory/pool for ${token} (falling through to the older paths): ${err.message}`);
  }

  let isGrad = false;
  let curveAddr = '0x0000000000000000000000000000000000000000';
  try {
    const [graduated, curve] = await Promise.all([
      publicClient.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: 'isGraduated',
        args: [token],
      }),
      publicClient.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: 'getBondingCurve',
        args: [token],
      }),
    ]);
    isGrad = Boolean(graduated);
    curveAddr = curve;
  } catch (err) {
    console.warn(`[FACTORY ERROR] Could not read factory for ${token}: ${err.message}`);
  }

  // PRE-GRADUATION: Use Incentifi Bonding Curve
  if (!isGrad && curveAddr && curveAddr !== '0x0000000000000000000000000000000000000000') {
    try {
      const priceWei = await publicClient.readContract({
        address: getAddress(curveAddr),
        abi: BONDING_CURVE_ABI,
        functionName: 'getCurrentPrice',
      });
      const priceEth = Number(priceWei) / 1e18;
      if (priceEth > 0) {
        return { priceEth, isGraduated: false, source: 'bonding_curve' };
      }
    } catch {
      // Fallback to reserve math if getCurrentPrice reverts
      try {
        const [realEthReserve, realTokenReserve] = await Promise.all([
          publicClient.readContract({
            address: getAddress(curveAddr),
            abi: BONDING_CURVE_ABI,
            functionName: 'realEthReserve',
          }),
          publicClient.readContract({
            address: getAddress(curveAddr),
            abi: BONDING_CURVE_ABI,
            functionName: 'realTokenReserve',
          }),
        ]);
        const VIRTUAL_ETH = 2.15625;
        const VIRTUAL_TOKEN = 78_125_000;
        const curEth = VIRTUAL_ETH + Number(realEthReserve) / 1e18;
        const curToken = VIRTUAL_TOKEN + Number(realTokenReserve) / 1e18;
        const priceEth = curEth / curToken;
        return { priceEth, isGraduated: false, source: 'bonding_curve_reserves' };
      } catch (err) {
        console.error(`[CURVE PRICE ERROR] Could not resolve curve price for ${token}:`, err.message);
      }
    }
  }

  // POST-GRADUATION: Use Uniswap V3 Pool
  if (isGrad && curveAddr && curveAddr !== '0x0000000000000000000000000000000000000000') {
    try {
      const poolAddr = await publicClient.readContract({
        address: getAddress(curveAddr),
        abi: BONDING_CURVE_ABI,
        functionName: 'uniswapPool',
      });

      if (poolAddr && poolAddr !== '0x0000000000000000000000000000000000000000') {
        const pool = getAddress(poolAddr);
        try {
          const [tickCumulatives] = await publicClient.readContract({
            address: pool,
            abi: UNISWAP_V3_POOL_ABI,
            functionName: 'observe',
            args: [[1800, 0]],
          });
          const timeWeightedTick = Number(tickCumulatives[1] - tickCumulatives[0]) / 1800;
          const token0 = await publicClient.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0' });
          const isToken0Weth = token0.toLowerCase() !== token.toLowerCase();
          const rawPrice = Math.pow(1.0001, timeWeightedTick);
          const priceEth = isToken0Weth ? rawPrice : (rawPrice > 0 ? 1 / rawPrice : 0);
          return { priceEth, isGraduated: true, source: 'uniswap_v3_twap' };
        } catch {
          const slot0 = await publicClient.readContract({
            address: pool,
            abi: UNISWAP_V3_POOL_ABI,
            functionName: 'slot0',
          });
          const token0 = await publicClient.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0' });
          const isToken0Weth = token0.toLowerCase() !== token.toLowerCase();
          const sqrtPriceX96 = Number(slot0[0]);
          const rawPrice = Math.pow(sqrtPriceX96 / Math.pow(2, 96), 2);
          const priceEth = isToken0Weth ? rawPrice : (rawPrice > 0 ? 1 / rawPrice : 0);
          return { priceEth, isGraduated: true, source: 'uniswap_v3_spot' };
        }
      }
    } catch (err) {
      console.error(`[UNISWAP V3 PRICE ERROR] Could not resolve V3 price for ${token}:`, err.message);
    }
  }

  // V4: the V3 factory knows nothing about this token (no curve registered). A V4 token has
  // no per-token curve contract at all — its state lives in the shared hook, keyed by poolId
  // — so without this branch every V4 epoch is skipped as invalid_price even once Fix 1 has
  // populated holder_cost_basis for it.
  if (!curveAddr || curveAddr === '0x0000000000000000000000000000000000000000') {
    try {
      const v4 = await getV4Module();
      if (await v4.isV4LaunchedToken(token, { client: publicClient })) {
        const state = await v4.fetchV4CurveState(token, undefined, { client: publicClient });
        if (state.currentPriceEth > 0) {
          return {
            priceEth: state.currentPriceEth,
            isGraduated: Boolean(state.graduated),
            source: state.graduated ? 'v4_stateview_slot0' : 'v4_hook_curve',
          };
        }
        console.warn(`[V4 PRICE] ${token} is V4-launched but resolved to a zero price (initialized=${state.initialized}, graduated=${state.graduated}).`);
      }
    } catch (err) {
      console.error(`[V4 PRICE ERROR] Could not resolve V4 price for ${token}:`, err.message);
    }
  }

  return { priceEth: 0, isGraduated: isGrad, source: 'unknown' };
}

/**
 * Executes a hardened 5-minute loss-reward epoch calculation for a given token.
 * Features:
 * - Concurrency Lock: Prevents simultaneous executions per token.
 * - On-Chain Reconciliation: Cross-checks on-chain roots vs DB to prevent duplicates or missed proofs.
 * - Deferred Cost-Basis Depletion: Applies depletion ONLY after confirmed on-chain transaction & DB persistence.
 * - Safe Dry-Run: Allows pure read/simulation mode.
 */
// ---------------------------------------------------------------------------------------------
// Pool balance read with retry + pending-epoch resolution (2026-09-09).
//
// Incident: INCENTIFI (reward asset NVDA) had 0.2923 ETH unallocated on LossRewardPoolV2 and two
// `pending_funding` epochs (#4 = 0.3024 ETH, #5 = 0.2479 ETH) that never published. The gate read
// the right number (V2.getUnallocatedBalance, the same call the site shows) but the rule was wrong:
// an underfunded epoch was parked at FULL demand and the resolver required the FULL amount, FIFO,
// so #4 (0.01 ETH short) blocked #5 (fundable) for good — while both had already depleted every
// holder's cost basis for money never paid. Fix: every epoch pays what the pool holds now, pro rata
// (the V1-drain rule, PR #23), legacy pending rows are published the same way from their stored
// per-holder allocations (no re-snapshot), the unpaid part of their depletion is given back, and a
// pool read that fails after retries skips the token instead of guessing.
// ---------------------------------------------------------------------------------------------
export const POOL_READ_ATTEMPTS = Number(process.env.POOL_READ_ATTEMPTS || 3);
const ZERO_ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000';
const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(6);

/**
 * getUnallocatedBalance(token) on `poolAddr`, retried with a growing delay. Both callers gate real
 * money on this number: a transient RPC failure must never read as "empty" (parks the epoch) or as
 * "equal to demand" (the old fallback, which produced a publish the contract reverted). After the
 * last attempt the error propagates and the caller skips the token for this run.
 */
export async function readUnallocatedWithRetry(poolAddr, tokenAddress, { client = publicClient, attempts = POOL_READ_ATTEMPTS, retryDelayMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = (m) => console.warn(m) } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return BigInt(await client.readContract({ address: getAddress(poolAddr), abi: POOL_ABI, functionName: 'getUnallocatedBalance', args: [getAddress(tokenAddress)] }));
    } catch (err) {
      lastErr = err;
      log(`[POOL READ] getUnallocatedBalance(${tokenAddress}) on ${poolAddr} failed (attempt ${i}/${attempts}): ${err.shortMessage || err.message}`);
      if (i < attempts) await sleep(retryDelayMs * i);
    }
  }
  throw new Error(`[POOL READ] getUnallocatedBalance(${tokenAddress}) on ${poolAddr} failed after ${attempts} attempts: ${lastErr?.shortMessage || lastErr?.message}`);
}

/** Adds `addBackEth` to a wallet's recorded investment (undoing a depletion that was never paid). */
async function restoreCostBasis(db, token, wallet, addBackEth, log) {
  const { data: row, error } = await db.from('holder_cost_basis').select('token_balance, total_invested_eth, avg_cost_basis_eth').eq('token_address', token).eq('wallet_address', wallet.toLowerCase()).maybeSingle();
  if (error) { log(`[PENDING] could not restore ${addBackEth} ETH of cost basis for ${wallet}: ${error.message}`); return false; }
  if (!row) { log(`[PENDING] no holder_cost_basis row for ${wallet}; nothing to restore`); return true; }
  const invested = Number(row.total_invested_eth || 0) + addBackEth;
  const balance = Number(row.token_balance || 0);
  const { error: upErr } = await db.from('holder_cost_basis').update({
    total_invested_eth: invested,
    avg_cost_basis_eth: balance > 0 ? invested / balance : Number(row.avg_cost_basis_eth || 0),
    last_updated_at: new Date().toISOString(),
  }).eq('token_address', token).eq('wallet_address', wallet.toLowerCase());
  if (upErr) { log(`[PENDING] could not restore cost basis for ${wallet}: ${upErr.message}`); return false; }
  return true;
}

/**
 * Legacy `pending_funding` epochs (2026-09-09): their stored per-holder amounts came from holder rows
 * that turned out to be stale or double-counted, so they are NOT published as stored. This reverses
 * the cost-basis depletion each of them applied (the old worker depleted before paying) and deletes
 * their epoch_holder_rewards rows; the epoch row stays `pending_funding` and executeEpochForToken
 * rebuilds the oldest one as this run's epoch from fresh, confirmed chain reads (anyone who fully
 * sold gets nothing), funded pro rata. Row-level: a holder row is deleted only after its restore
 * succeeded, so a crash mid-way never restores twice and never loses a restore.
 * Returns { pending, epochsReversed, rowsReversed, restoredEth }.
 */
export async function reversePendingEpochs(tokenAddress, { db = supabase, dryRun = false, log = (m) => console.log(m) } = {}) {
  const token = tokenAddress.toLowerCase();
  const { data: pending, error } = await db.from('reward_epochs').select('epoch_id, epoch_number, total_distributed_eth').eq('token_address', token).eq('status', 'pending_funding').order('epoch_number', { ascending: true });
  if (error) throw new Error(`[PENDING] reward_epochs query failed: ${error.message}`);
  const result = { pending: (pending || []).length, epochsReversed: 0, rowsReversed: 0, restoredEth: 0 };
  for (const ep of pending || []) {
    const { data: rows, error: rowsErr } = await db.from('epoch_holder_rewards').select('id, wallet_address, final_reward_eth').eq('epoch_id', ep.epoch_id);
    if (rowsErr) throw new Error(`[PENDING] epoch_holder_rewards query failed for epoch #${ep.epoch_number}: ${rowsErr.message}`);
    if (!rows || !rows.length) continue;
    log(`[PENDING] epoch #${ep.epoch_number}: discarding ${rows.length} stored allocation(s) (${Number(ep.total_distributed_eth || 0).toFixed(6)} ETH) and reversing their cost-basis depletion; the epoch will be rebuilt from fresh chain reads`);
    if (dryRun) continue;
    for (const r of rows) {
      const eth = Number(r.final_reward_eth || 0);
      if (eth > 0) {
        const ok = await restoreCostBasis(db, token, r.wallet_address, eth, log);
        if (!ok) throw new Error(`[PENDING] could not reverse the depletion of ${r.wallet_address} for epoch #${ep.epoch_number}; leaving its row for the next run`);
      }
      const { error: delErr } = await db.from('epoch_holder_rewards').delete().eq('id', r.id);
      if (delErr) throw new Error(`[PENDING] could not delete epoch_holder_rewards row ${r.id}: ${delErr.message}`);
      result.rowsReversed++;
      result.restoredEth += eth;
    }
    result.epochsReversed++;
  }
  return result;
}

export async function executeEpochForToken(tokenAddress, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const token = tokenAddress.toLowerCase();
  // Every line this run logs carries the token so concurrent/interleaved runs stay readable.
  const tag = `[${token}]`;
  const tlog = (m) => console.log(`${tag} ${m}`);
  const twarn = (m) => console.warn(`${tag} ${m}`);
  const terror = (m) => console.error(`${tag} ${m}`);
  const fmtTok = (wei) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 });

  // 1. Concurrency Guard
  if (activeTokenLocks.has(token)) {
    twarn(`[CONCURRENCY LOCK] Token ${token} is already processing an epoch. Skipping concurrent invocation.`);
    return { skipped: true, reason: 'concurrency_locked' };
  }

  activeTokenLocks.add(token);

  try {
    tlog(`\n======================================================`);
    tlog(`[EPOCH WORKER] Processing Loss-Reward Epoch for ${token} (DRY RUN = ${dryRun})`);

    // 1a. Indexer freshness gate — checked FIRST, before any chain or DB work below.
    // holder_cost_basis (queried further down) is populated exclusively by
    // scripts/evm-indexer.mjs — if that indexer has stalled or never started, "who is
    // in loss" would be computed from outdated balances without any indication to
    // callers. Refuse to proceed rather than silently trusting stale data. Running this
    // check before any RPC/DB call (rather than after the benchmark-price fetch and
    // epoch reconciliation) also avoids wasting those calls on a run that's going to be
    // discarded anyway.
    if (!options.skipFreshnessCheck) {
      const freshness = await checkIndexerFreshness();
      if (!freshness.fresh) {
        await sendAlert(`Loss-reward snapshot for ${token} BLOCKED — indexer data is not fresh. ${freshness.reason}`);
        terror(`[FRESHNESS GATE] Refusing to run epoch for ${token}: ${freshness.reason}`);
        return { skipped: true, reason: 'indexer_stale', detail: freshness.reason, ageSeconds: freshness.ageSeconds };
      }
      tlog(`[FRESHNESS GATE] Indexer heartbeat is fresh (${freshness.ageSeconds.toFixed(1)}s old, threshold ${INDEXER_FRESHNESS_THRESHOLD_SECONDS}s). Proceeding.`);
    }

    // 1b. Legacy `pending_funding` epochs: the per-holder amounts they stored came from holder rows
    // we no longer trust (2026-09-09: stale and double-counted balances). Reverse the cost-basis
    // depletion they applied and drop their rows; step 3 then rebuilds the oldest one as THIS run's
    // epoch from fresh, confirmed chain reads (see reversePendingEpochs).
    if (LOSS_REWARD_POOL_ADDRESS) {
      try {
        const rev = await reversePendingEpochs(token, { dryRun, log: tlog });
        if (rev.epochsReversed) tlog(`[PENDING] reversed ${rev.rowsReversed} stored allocation(s) across ${rev.epochsReversed} pending epoch(s), ${rev.restoredEth.toFixed(6)} ETH of depletion given back`);
      } catch (err) {
        terror(`[PENDING REVERSAL ERROR] ${err.message} - skipping ${token} this run.`);
        return { skipped: true, reason: 'pending_reversal_failed', detail: err.message };
      }
    }

    // One block for every balance read of this run (never "latest": a run that rotates between
    // endpoints must read one consistent state; see scripts/lib/reliableBalance.mjs).
    const snapshotBlock = (await publicClient.getBlockNumber()) - 1n;

    // 2. Fetch authoritative benchmark price (Curve getCurrentPrice pre-graduation, Uniswap V3 post-graduation)
    const priceRes = await getTokenBenchmarkPriceEth(token);
    const benchmarkPriceEth = priceRes.priceEth;

    if (benchmarkPriceEth <= 0) {
      tlog(`[EPOCH WORKER] No valid benchmark price for ${token}. Skipping epoch.`);
      return { skipped: true, reason: 'invalid_price' };
    }
    tlog(`[PRICE BENCHMARK] ${priceRes.isGraduated ? 'Graduated' : 'Pre-Graduation'} Price: ${benchmarkPriceEth.toExponential(6)} ETH per token (Source: ${priceRes.source})`);

    // 3. Reconcile On-Chain vs Database Epoch State
    const { data: latestDbEpoch, error: dbEpochErr } = await supabase
      .from('reward_epochs')
      .select('epoch_number, merkle_root, status, onchain_tx_hash')
      .eq('token_address', token)
      .order('epoch_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (dbEpochErr) {
      throw new Error(`[DB ERROR] Failed to query latest epoch from reward_epochs: ${dbEpochErr.code} ${dbEpochErr.message}`);
    }

    const latestDbEpochNumber = latestDbEpoch?.epoch_number || 0;
    // A pending_funding row (legacy) is rebuilt in place, oldest first, before any new epoch number.
    const { data: oldestPending, error: pendingErr } = await supabase
      .from('reward_epochs')
      .select('epoch_id, epoch_number')
      .eq('token_address', token)
      .eq('status', 'pending_funding')
      .order('epoch_number', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (pendingErr) {
      throw new Error(`[DB ERROR] Failed to query pending epochs from reward_epochs: ${pendingErr.code} ${pendingErr.message}`);
    }
    const rebuildingEpoch = oldestPending || null;
    const candidateEpochNumber = rebuildingEpoch ? Number(rebuildingEpoch.epoch_number) : latestDbEpochNumber + 1;
    const persistEpoch = (row, select = null) => insertRewardEpoch(row, select, { upsert: Boolean(rebuildingEpoch) });
    if (rebuildingEpoch) tlog(`[REBUILD] Epoch #${candidateEpochNumber} was pending_funding; rebuilding it from fresh chain reads at block ${snapshotBlock}`);

    // Check on-chain root for candidate epoch — on EVERY pool this worker can publish to, since a
    // crash between publish and DB persistence could have left it on either (State 3 below).
    let onchainCandidateRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
    let onchainCandidatePool = null;
    for (const poolAddr of [LOSS_REWARD_POOL_V1_ADDRESS, LOSS_REWARD_POOL_V2_ADDRESS].filter(Boolean)) {
      try {
        const root = await publicClient.readContract({
          address: getAddress(poolAddr),
          abi: POOL_ABI,
          functionName: 'epochMerkleRoots',
          args: [getAddress(token), BigInt(candidateEpochNumber)],
        });
        if (root && root !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
          onchainCandidateRoot = root;
          onchainCandidatePool = poolAddr;
          break;
        }
      } catch (err) {
        twarn(`[ON-CHAIN READ WARNING] Could not read candidate epoch root on ${poolAddr}: ${err.message}`);
      }
    }

    const isCandidatePublishedOnchain = Boolean(
      onchainCandidateRoot &&
      onchainCandidateRoot !== '0x0000000000000000000000000000000000000000000000000000000000000000'
    );

    tlog(`[EPOCH RECONCILIATION] DB Latest Epoch: #${latestDbEpochNumber} | Candidate Epoch: #${candidateEpochNumber} | On-Chain Published: ${isCandidatePublishedOnchain}`);

    // 4. Query all eligible underwater holders
    const { data: holders, error: holdersErr } = await supabase
      .from('holder_cost_basis')
      .select('*')
      .eq('token_address', token)
      .eq('is_eligible', true)
      .eq('is_underwater_seller', false)
      .gt('token_balance', 0)
      .gt('avg_cost_basis_eth', benchmarkPriceEth);

    if (holdersErr) {
      throw new Error(`[DB ERROR] Failed to query holder_cost_basis: ${holdersErr.code} ${holdersErr.message}`);
    }

    if (!holders || holders.length === 0) {
      tlog(`[EPOCH WORKER] No eligible underwater holders for ${token}.`);
      if (!dryRun && !isCandidatePublishedOnchain) {
        await persistEpoch({
          token_address: token,
          epoch_number: candidateEpochNumber,
          pool_price_eth: benchmarkPriceEth,
          pool_twap_price_eth: benchmarkPriceEth,
          total_theoretical_reward_eth: 0,
          available_pool_eth: 0,
          scaling_factor: 1.0,
          total_distributed_eth: 0,
          merkle_root: '0x0000000000000000000000000000000000000000000000000000000000000000',
          status: 'completed_empty',
          pool_address: (await resolveEpochPool(token, 0n)).address.toLowerCase(),
        });
      }
      return {
        epochNumber: candidateEpochNumber,
        tokenAddress: token,
        isGraduated: priceRes.isGraduated,
        benchmarkPriceEth,
        eligibleHolders: 0,
        totalTheoreticalDemandEth: 0,
        availablePoolEth: 0,
        scalingFactor: 1.0,
        totalDistributedEth: 0,
        merkleRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
        payouts: [],
        skippedHolders: [],
        rebuilt: Boolean(rebuildingEpoch),
      };
    }

    // 5. Calculate 10% Theoretical Loss Reward per holder
    let totalTheoreticalDemandEth = 0;
    const eligibleAllocations = [];
    const skippedHolders = [];

    for (const h of holders) {
      // On-chain balance guard — see applyOnChainBalanceCap(). FAIL CLOSED: if the chain can't
      // be read, this epoch is skipped for this token rather than paid on unverified data.
      // Pinned to snapshotBlock; a read BELOW the DB balance (a zero included) is confirmed by a second
      // endpoint before it is believed. Disputed -> the holder is skipped this epoch (not paid, not
      // zeroed, DB untouched); a read that fails on every endpoint -> the whole token is skipped.
      let onChainBalanceTokens;
      const dbWei = BigInt(Math.round(Number(h.token_balance) * 1e18));
      let read;
      try {
        read = await readBalanceReliably({ client: publicClient, rpc: rpcFailover, token, wallet: h.wallet_address, blockNumber: snapshotBlock, expectedAtLeastWei: dbWei - dbWei / 1_000_000n, ...(options.balanceRead || {}) });
      } catch (err) {
        throw new Error(`[BALANCE GUARD] Could not read on-chain balance for ${h.wallet_address} at block ${snapshotBlock} — refusing to compute epoch on unverified holder data: ${err.message}`);
      }
      if (read.disputed) {
        terror(`[BALANCE GUARD] DISPUTED balance for ${h.wallet_address} at block ${snapshotBlock}: ${read.endpoints[0] || 'primary'} says ${fmtTok(read.primaryWei)}, ${read.endpoints[1] || 'second read'} says ${fmtTok(read.confirmWei)} (DB ${h.token_balance}). Holder SKIPPED this epoch — not paid, not zeroed.`);
        skippedHolders.push({ wallet: h.wallet_address, primaryWei: read.primaryWei, confirmWei: read.confirmWei });
        continue;
      }
      onChainBalanceTokens = Number(read.balanceWei) / 1e18;
      const capped = applyOnChainBalanceCap(h, onChainBalanceTokens);
      if (capped.capped) {
        twarn(`[BALANCE GUARD] ${h.wallet_address}: DB balance ${capped.dbBalance} > on-chain ${capped.onChainBalance} at block ${snapshotBlock}${read.confirmed ? ` (confirmed by ${read.endpoints[1] || 'a second read'})` : ''} (indexer lag, a missed sell or a double-counted buy). Paying on ${capped.balance} only.`);
      }
      if (!(capped.balance > 0)) continue;

      const balance = capped.balance;
      const costBasis = Number(h.avg_cost_basis_eth);
      const invested = capped.invested;
      const currentVal = balance * benchmarkPriceEth;
      const unrealizedLoss = Math.max(0, invested - currentVal);
      const theoreticalReward = 0.10 * unrealizedLoss;

      if (theoreticalReward > 0) {
        totalTheoreticalDemandEth += theoreticalReward;
        eligibleAllocations.push({
          wallet: h.wallet_address.toLowerCase(),
          balance,
          costBasis,
          invested,
          unrealizedLoss,
          theoreticalReward,
        });
      }
    }

    if (skippedHolders.length) terror(`[BALANCE GUARD] ${skippedHolders.length} holder(s) SKIPPED this epoch because two endpoints disagreed on their balance: ${skippedHolders.map((x) => x.wallet).join(', ')}`);
    tlog(`[DEMAND] Eligible Underwater Holders: ${eligibleAllocations.length}${skippedHolders.length ? ` (+${skippedHolders.length} skipped, disputed reads)` : ''}`);
    tlog(`[DEMAND] Total Theoretical Reward Demand: ${totalTheoreticalDemandEth.toFixed(10)} ETH`);

    // 6. Choose the pool for THIS epoch (drain V1, then switch to V2 — see resolveEpochPool) and
    //    query its available balance. If the candidate epoch already exists on-chain (crash
    //    recovery), the pool that holds it wins.
    const demandWei = BigInt(Math.round(totalTheoreticalDemandEth * 1e18));
    const epochPool = onchainCandidatePool
      ? { address: onchainCandidatePool, version: onchainCandidatePool.toLowerCase() === (LOSS_REWARD_POOL_V2_ADDRESS || '').toLowerCase() ? 'v2' : 'v1', reason: 'already_on_chain' }
      : await resolveEpochPool(token, demandWei);
    const EPOCH_POOL_ADDRESS = epochPool.address;
    tlog(`[POOL SELECT] Epoch #${candidateEpochNumber} -> ${epochPool.version.toUpperCase()} ${EPOCH_POOL_ADDRESS} (${epochPool.reason}${epochPool.v1UnallocatedWei != null ? `, V1 unallocated ${(Number(epochPool.v1UnallocatedWei) / 1e18).toFixed(6)} ETH` : ''})`);

    // The funding gate reads getUnallocatedBalance(token) on the epoch's pool - the same call the
    // site shows as "unallocated". Retried; on persistent failure the token is skipped this run.
    // (The old fallback "default to demand" produced a publish that the contract reverted.)
    let availablePoolEth = 0;
    let availablePoolWei = 0n;
    if (EPOCH_POOL_ADDRESS) {
      try {
        availablePoolWei = await readUnallocatedWithRetry(EPOCH_POOL_ADDRESS, token, options.poolRead || {});
        availablePoolEth = Number(availablePoolWei) / 1e18;
      } catch (err) {
        terror(`${err.message} - skipping ${token} this run (fail closed).`);
        return { skipped: true, reason: 'pool_read_failed', detail: err.message };
      }
    } else {
      availablePoolEth = totalTheoreticalDemandEth;
      availablePoolWei = BigInt(Math.round(availablePoolEth * 1e18));
    }

    tlog(`[POOL BUDGET] Available Unallocated ETH on ${epochPool.version.toUpperCase()} ${EPOCH_POOL_ADDRESS}: ${availablePoolEth.toFixed(6)} ETH (getUnallocatedBalance at latest, run snapshot block ${snapshotBlock})`);

    // 7. Scaling & mode.
    //    Default: when the pool is underfunded, 100% theoretical rewards and proofs are preserved
    //    as pending_funding (no scaling). V1-DRAIN exception (resolveEpochPool.capToV1): the epoch
    //    is published on V1 now, capped pro-rata to V1's unallocated balance, so V1 empties to the
    //    wei and the token moves to V2 on the next run. Allocations are computed in exact wei and
    //    the on-chain allocation is the SUM OF THE LEAVES (never a rounded float), so the pool's
    //    per-epoch cap can never be a wei short of the last claimant.
    const theoreticalWeiList = eligibleAllocations.map((a) => BigInt(Math.round(a.theoreticalReward * 1e18)));
    let isUnderfunded = allocatedWeiOf(theoreticalWeiList) > availablePoolWei;
    let scalingFactor = 1.0;
    let finalWeiList = theoreticalWeiList;
    let allocatedWei = allocatedWeiOf(theoreticalWeiList);
    if (isUnderfunded) {
      // Pay what the pool holds NOW, pro rata, on every pool (the V1-drain rule of PR #23 was the
      // only place this happened). Parking the full demand as `pending_funding` stalled every token
      // whose 10%-of-loss demand outran its 1%-of-volume pool: the resolver wanted the FULL amount,
      // FIFO, so one oversized epoch blocked all later ones while cost basis had already been
      // depleted for money never paid (INCENTIFI, 2026-09-08). With 0 available every leaf is 0 and
      // the dust guard below records completed_dust without touching cost basis.
      const capped = capAllocationsToAvailable(theoreticalWeiList, availablePoolWei);
      finalWeiList = capped.finalWei;
      scalingFactor = capped.scalingFactor;
      allocatedWei = capped.allocatedWei;
      isUnderfunded = false;
      tlog(`[${epochPool.capToV1 ? 'V1 DRAIN' : 'POOL CAP'}] Epoch #${candidateEpochNumber} capped to ${epochPool.version.toUpperCase()}'s ${availablePoolEth.toFixed(6)} ETH (demand ${totalTheoreticalDemandEth.toFixed(6)} ETH, scaling ${scalingFactor.toFixed(6)})${epochPool.capToV1 ? '; V1 will be emptied and the next epoch moves to V2' : ''}.`);
    }
    // Leaf amounts must survive the ETH-float round trip the gateway performs (see stabilizeLeafWei).
    if (EPOCH_POOL_ADDRESS) {
      const stable = stabilizeLeafWei(finalWeiList, availablePoolWei);
      finalWeiList = stable.finalWei;
      allocatedWei = stable.allocatedWei;
      if (scalingFactor !== 1 && allocatedWeiOf(theoreticalWeiList) > 0n) scalingFactor = Number(allocatedWei) / Number(allocatedWeiOf(theoreticalWeiList));
    }
    const totalDistributedEth = Number(allocatedWei) / 1e18;

    // 7a. Minimum-payout dust guard (see MIN_EPOCH_PAYOUT_WEI's own doc comment).
    // Checked here, BEFORE building the Merkle tree or touching cost basis: a
    // dust-level reward must skip depletion entirely too, or holders would have
    // their recorded loss reduced for compensation they never actually received.
    // Only applies when this candidate epoch hasn't already been published
    // on-chain — an already-published epoch (e.g. from before this guard
    // existed) still needs full reconciliation below, not a retroactive skip.
    const { candidateAllocatedWei, isDust } = evaluateDustGuard(totalDistributedEth);
    if (!isCandidatePublishedOnchain && isDust) {
      tlog(`[DUST GUARD] Candidate Epoch #${candidateEpochNumber} total payout (${candidateAllocatedWei.toString()} wei) is below the minimum payout threshold (${MIN_EPOCH_PAYOUT_WEI.toString()} wei, ${eligibleAllocations.length} eligible holder(s)). Skipping Merkle tree construction, on-chain submission, and cost-basis depletion — recording as completed_dust instead.`);
      if (!dryRun) {
        await persistEpoch({
          token_address: token,
          epoch_number: candidateEpochNumber,
          pool_price_eth: benchmarkPriceEth,
          pool_twap_price_eth: benchmarkPriceEth,
          total_theoretical_reward_eth: totalTheoreticalDemandEth,
          available_pool_eth: availablePoolEth,
          scaling_factor: scalingFactor,
          total_distributed_eth: totalDistributedEth,
          merkle_root: '0x0000000000000000000000000000000000000000000000000000000000000000',
          status: 'completed_dust',
          pool_address: EPOCH_POOL_ADDRESS.toLowerCase(),
        });
      }
      return {
        epochNumber: candidateEpochNumber,
        tokenAddress: token,
        isGraduated: priceRes.isGraduated,
        benchmarkPriceEth,
        eligibleHolders: eligibleAllocations.length,
        totalTheoreticalDemandEth,
        availablePoolEth,
        scalingFactor,
        totalDistributedEth,
        merkleRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
        payouts: [],
        skipped: true,
        reason: 'dust_payout',
        candidateAllocatedWei: candidateAllocatedWei.toString(),
        skippedHolders,
        rebuilt: Boolean(rebuildingEpoch),
      };
    }

    // 8. Calculate Final Scaled Rewards & Generate Merkle Leaves
    const leaves = [];
    const finalPayouts = [];

    for (let i = 0; i < eligibleAllocations.length; i++) {
      const alloc = eligibleAllocations[i];
      const finalRewardWei = finalWeiList[i];
      const finalRewardEth = Number(finalRewardWei) / 1e18;
      if (finalRewardWei === 0n) continue; // a pro-rata share that rounds to zero wei gets no leaf

      const leaf = hashLeaf(token, candidateEpochNumber, alloc.wallet, finalRewardWei);
      leaves.push(leaf);

      finalPayouts.push({
        ...alloc,
        finalRewardEth,
        finalRewardWei,
        leafIndex: i,
      });

      tlog(`  Holder #${i+1} [${alloc.wallet.slice(0, 10)}...]: Balance=${alloc.balance.toFixed(2)} | CostBasis=${alloc.costBasis.toExponential(4)} | Loss=${alloc.unrealizedLoss.toFixed(8)} ETH | Final Reward=${finalRewardEth.toFixed(10)} ETH (${finalRewardWei.toString()} wei)`);
    }

    // 9. Build Merkle Tree & Root
    const tree = new MerkleTree(leaves);
    const merkleRoot = tree.getRoot();
    tlog(`[MERKLE TREE] Generated Merkle Root: ${merkleRoot}`);

    // 10. Reconciliation Path (State 3: Chain present, DB absent)
    if (isCandidatePublishedOnchain) {
      if (onchainCandidateRoot.toLowerCase() !== merkleRoot.toLowerCase()) {
        throw new Error(
          `[RECONCILIATION ERROR] On-chain Merkle root (${onchainCandidateRoot}) does not match calculated candidate root (${merkleRoot}) for Epoch #${candidateEpochNumber}. Stopping execution to prevent state corruption.`
        );
      }
      tlog(`[RECONCILIATION SUCCESS] On-chain Merkle root matches candidate calculation. Resuming database persistence.`);
    }

    // 11. On-Chain Transaction Submission & Confirmation
    let onchainTxHash = null;
    let epochStatus = 'published';

    if (!dryRun && !isCandidatePublishedOnchain && OPERATOR_PRIVATE_KEY && EPOCH_POOL_ADDRESS) {
      if (!isUnderfunded) {
        try {
          const account = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
          const walletClient = createWalletClient({
            account,
            transport: rpcTransport,
          });

          const totalAllocatedWei = allocatedWei; // exact sum of the leaves
          tlog(`[ON-CHAIN] Submitting setEpochMerkleRoot for Epoch #${candidateEpochNumber} on ${epochPool.version.toUpperCase()} ${EPOCH_POOL_ADDRESS} (allocating ${totalAllocatedWei} wei)...`);

          onchainTxHash = await walletClient.writeContract({
            address: getAddress(EPOCH_POOL_ADDRESS),
            abi: POOL_ABI,
            functionName: 'setEpochMerkleRoot',
            args: [getAddress(token), BigInt(candidateEpochNumber), merkleRoot, totalAllocatedWei],
          });

          tlog(`[ON-CHAIN] Transaction broadcast: ${onchainTxHash}. Awaiting receipt...`);

          // Wait for on-chain receipt confirmation
          const receipt = await publicClient.waitForTransactionReceipt({ hash: onchainTxHash });
          if (receipt.status !== 'success') {
            throw new Error(`[ON-CHAIN REVERT] Transaction ${onchainTxHash} reverted on-chain.`);
          }
          tlog(`[ON-CHAIN CONFIRMED] Block #${receipt.blockNumber} Gas Used: ${receipt.gasUsed}`);
          epochStatus = 'published';
        } catch (err) {
          terror(`[ON-CHAIN FATAL] setEpochMerkleRoot failed: ${err.message}`);
          throw err;
        }
      } else {
        epochStatus = 'pending_funding';
        tlog(`[POOL UNDERFUNDED] Available pool (${availablePoolEth.toFixed(6)} ETH) < demand (${totalDistributedEth.toFixed(6)} ETH). Saving Epoch #${candidateEpochNumber} as 'pending_funding' (original theoretical rewards & Merkle proofs preserved).`);
      }
    } else if (isCandidatePublishedOnchain) {
      epochStatus = 'published';
    }

    // 12. Database Persistence: reward_epochs & epoch_holder_rewards
    if (!dryRun) {
      const { data: insertedEpoch, error: insertEpochErr } = await persistEpoch({
        token_address: token,
        epoch_number: candidateEpochNumber,
        pool_price_eth: benchmarkPriceEth,
        pool_twap_price_eth: benchmarkPriceEth,
        total_theoretical_reward_eth: totalTheoreticalDemandEth,
        available_pool_eth: availablePoolEth,
        scaling_factor: scalingFactor,
        total_distributed_eth: totalDistributedEth,
        merkle_root: merkleRoot,
        onchain_tx_hash: onchainTxHash || (isCandidatePublishedOnchain ? latestDbEpoch?.onchain_tx_hash : null),
        status: epochStatus,
        pool_address: EPOCH_POOL_ADDRESS.toLowerCase(),
      }, 'epoch_id');

      if (insertEpochErr) {
        throw new Error(`[DB ERROR] Failed to insert reward_epochs: ${insertEpochErr.code} ${insertEpochErr.message}`);
      }

      const epochId = insertedEpoch?.epoch_id;

      const holderProofRows = finalPayouts.map((payout) => ({
        epoch_id: epochId,
        token_address: token,
        wallet_address: payout.wallet,
        token_balance: payout.balance,
        cost_basis_eth: payout.costBasis,
        unrealized_loss_eth: payout.unrealizedLoss,
        theoretical_reward_eth: payout.theoreticalReward,
        final_reward_eth: payout.finalRewardEth,
        merkle_proof: tree.getProof(payout.leafIndex),
        claimed: false,
      }));

      const { error: insertProofsErr } = await supabase.from('epoch_holder_rewards').insert(holderProofRows);
      if (insertProofsErr) {
        throw new Error(`[DB ERROR] Failed to insert epoch_holder_rewards: ${insertProofsErr.code} ${insertProofsErr.message}`);
      }

      // 13. DEFERRED COST-BASIS DEPLETION: ONLY for a published (paid) epoch. A row that is not
      // published paid nobody, so nobody's recorded loss may shrink for it.
      if (epochStatus !== 'published') {
        tlog(`[COST BASIS DEPLETION] Skipped: epoch #${candidateEpochNumber} is '${epochStatus}', nothing was paid.`);
      }
      tlog(`[COST BASIS DEPLETION] Applying post-confirmation cost-basis depletion for ${epochStatus === 'published' ? finalPayouts.length : 0} holders...`);
      for (const payout of epochStatus === 'published' ? finalPayouts : []) {
        const newInvested = Math.max(0, payout.invested - payout.finalRewardEth);
        const newCostBasis = payout.balance > 0 ? newInvested / payout.balance : 0;

        const { error: updateHolderErr } = await supabase.from('holder_cost_basis').update({
          total_invested_eth: newInvested,
          avg_cost_basis_eth: newCostBasis,
          last_updated_at: new Date().toISOString(),
        }).eq('token_address', token).eq('wallet_address', payout.wallet);

        if (updateHolderErr) {
          twarn(`[DB WARNING] Could not update cost basis for ${payout.wallet}: ${updateHolderErr.message}`);
        }
      }

      if (epochStatus === 'published') {
        tlog(`[SUCCESS] Epoch #${candidateEpochNumber} published${rebuildingEpoch ? ' (rebuilt)' : ''}. Distributed: ${totalDistributedEth.toFixed(6)} ETH to ${finalPayouts.length} holders.`);
      } else {
        tlog(`[SAVED] Epoch #${candidateEpochNumber} stored as '${epochStatus}' — nothing was distributed on-chain.`);
      }
    } else {
      tlog(`[DRY RUN COMPLETE] Simulated Epoch #${candidateEpochNumber}: ${totalDistributedEth.toFixed(10)} ETH total allocation for ${finalPayouts.length} eligible holders (0 DB/on-chain mutations).`);
    }

    return {
      epochNumber: candidateEpochNumber,
      tokenAddress: token,
      isGraduated: priceRes.isGraduated,
      benchmarkPriceEth,
      eligibleHolders: finalPayouts.length,
      totalTheoreticalDemandEth,
      availablePoolEth,
      scalingFactor,
      totalDistributedEth,
      merkleRoot,
      payouts: finalPayouts,
      skippedHolders,
      rebuilt: Boolean(rebuildingEpoch),
    };
  } finally {
    // Release concurrency lock
    activeTokenLocks.delete(token);
  }
}

/**
 * The worker's token universe: the client-written `tokens` table UNION the indexer's discovery
 * table `indexed_tokens` (scripts/evm-indexer.mjs upserts every TokenLaunched it sees). A token
 * exists for the worker as soon as the chain says so, so a deleted or never-written `tokens` row
 * can no longer strand the loss-reward funds of a real token (audit 2026-09-08 finding 5). Hidden
 * tokens (tokens.hidden = true) are included on purpose: hiding is a listing decision, not a funds
 * decision. Tolerates a not-yet-created indexed_tokens table.
 */
export async function listWorkerTokens({ db = supabase } = {}) {
  const seen = new Map();
  const { data: rows, error } = await db.from('tokens').select('mint_address');
  if (error) { console.error(`[WORKER] tokens query failed: ${error.message}`); }
  for (const t of rows || []) if (t.mint_address) seen.set(String(t.mint_address).toLowerCase(), { mint_address: t.mint_address, source: 'tokens' });
  try {
    const { data: idx, error: idxErr } = await db.from('indexed_tokens').select('mint_address, venue');
    if (idxErr) console.warn(`[WORKER] indexed_tokens unavailable (${idxErr.message}); using tokens only`);
    for (const t of idx || []) {
      const k = String(t.mint_address || '').toLowerCase();
      if (k && !seen.has(k)) seen.set(k, { mint_address: t.mint_address, source: 'indexed_tokens', venue: t.venue });
    }
  } catch (err) {
    console.warn(`[WORKER] indexed_tokens unavailable (${err.message}); using tokens only`);
  }
  const list = [...seen.values()];
  const fromIndex = list.filter((t) => t.source === 'indexed_tokens').length;
  if (fromIndex) console.log(`[WORKER] ${fromIndex} token(s) come from indexed_tokens only (no tokens row): ${list.filter((t) => t.source === 'indexed_tokens').map((t) => t.mint_address).join(', ')}`);
  return list;
}

/**
 * Pure: days of runway for `balanceWei` given the actions of the last 24 h. Cadence floor = one
 * continuously-underwater token (288 publishes/day) so a quiet day cannot hide the risk. Exported
 * for tests.
 */
export function estimateOperatorRunway({ balanceWei, gasPriceWei, publishes24h = 0, collects24h = 0, converts24h = 0, minDailyPublishes = 288 }) {
  const publishes = BigInt(Math.max(Number(publishes24h) || 0, minDailyPublishes));
  const dailyGas = publishes * PUBLISH_GAS_ESTIMATE + BigInt(collects24h || 0) * COLLECT_GAS_ESTIMATE + BigInt(converts24h || 0) * CONVERT_GAS_ESTIMATE;
  const dailyCostWei = dailyGas * BigInt(gasPriceWei || 0n);
  const runwayDays = dailyCostWei === 0n ? Infinity : Number(BigInt(balanceWei) * 1000n / dailyCostWei) / 1000;
  return { dailyCostWei, dailyGas, publishes: Number(publishes), runwayDays };
}

let lastOperatorAlertAt = 0;
/**
 * Reads the operator's balance, the last-24h cadence from reward_epochs (published rows) and the
 * chain's gas price, and alerts when runway < OPERATOR_MIN_RUNWAY_DAYS (re-alerts every
 * OPERATOR_ALERT_INTERVAL_MS while it stays low). Options for tests: client, db, alert, now,
 * operatorAddress, minRunwayDays, collects24h/converts24h (default: FeesCollected/Converted are
 * not counted from the DB; the fee-collection summaries of this process are used when passed).
 */
export async function checkOperatorRunway(options = {}) {
  const client = options.client ?? publicClient;
  const db = options.db ?? supabase;
  const alert = options.alert ?? sendAlert;
  const now = options.now ?? (() => Date.now());
  const minRunwayDays = options.minRunwayDays ?? OPERATOR_MIN_RUNWAY_DAYS;
  let operatorAddress = options.operatorAddress;
  if (!operatorAddress) {
    if (!OPERATOR_PRIVATE_KEY) return null;
    operatorAddress = privateKeyToAccount(OPERATOR_PRIVATE_KEY).address;
  }
  const [balanceWei, gasPriceWei] = await Promise.all([client.getBalance({ address: getAddress(operatorAddress) }), client.getGasPrice()]);
  const since = new Date(now() - 24 * 3600 * 1000).toISOString();
  const { data: published } = await db.from('reward_epochs').select('epoch_id').eq('status', 'published').gte('created_at', since);
  const publishes24h = (published || []).length;
  const est = estimateOperatorRunway({ balanceWei, gasPriceWei, publishes24h, collects24h: options.collects24h ?? 0, converts24h: options.converts24h ?? 0 });
  const summary = { operatorAddress, balanceEth: formatEther(balanceWei), gasPriceWei: gasPriceWei.toString(), publishes24h, dailyCostEth: formatEther(est.dailyCostWei), runwayDays: est.runwayDays, low: est.runwayDays < minRunwayDays };
  console.log(`[OPERATOR] ${operatorAddress} balance ${summary.balanceEth} ETH; cadence ${est.publishes} publishes/day -> ${summary.dailyCostEth} ETH/day; runway ${est.runwayDays === Infinity ? 'inf' : est.runwayDays.toFixed(2)} days (alert below ${minRunwayDays})`);
  if (summary.low && now() - lastOperatorAlertAt >= (options.alertIntervalMs ?? OPERATOR_ALERT_INTERVAL_MS)) {
    lastOperatorAlertAt = now();
    await alert(`Operator wallet ${operatorAddress} LOW: ${summary.balanceEth} ETH = ${est.runwayDays.toFixed(2)} days of runway at the current cadence (${est.publishes} publishes/day, ${summary.dailyCostEth} ETH/day, gas ${gasPriceWei} wei). Top up before epochs start failing silently.`);
  }
  return summary;
}

/**
 * Main 5-minute epoch cron runner
 */
export async function runEpochWorker(options = {}) {
  console.log('--- Incentifi 5-Minute Loss-Reward Worker Started ---');
  const tokens = await listWorkerTokens({ db: options.db ?? supabase });
  if (!tokens.length) return [];

  // Operator runway check first: an empty operator means silent no-row epochs (audit finding 2).
  if (!options.skipBalanceCheck) {
    try { await checkOperatorRunway(options.balanceCheck || {}); } catch (err) { console.error(`[OPERATOR] runway check failed: ${err.message}`); }
  }

  const results = [];
  for (const t of tokens) {
    if (!t.mint_address) continue;
    // Per-token isolation: one token's failure (an RPC read, an unfunded operator wallet, a
    // revert) must not abort the cycle for every token after it in the list — which is
    // exactly what happened on 2026-09-06 when the operator ran out of gas.
    try {
      const res = await executeEpochForToken(t.mint_address, options);
      results.push(res);
    } catch (err) {
      console.error(`[EPOCH WORKER] Epoch failed for ${t.mint_address} (continuing with remaining tokens): ${err.message}`);
      results.push({ tokenAddress: String(t.mint_address).toLowerCase(), skipped: true, reason: 'error', detail: err.message });
    }
  }
  // Legible-pool fee collection: collect() + convert() for tokens with recent trades, when the
  // fees are worth the gas. After the epochs (a failure here never delays a payout), before the
  // monitor. Never throws.
  if (!options.skipFeeCollection) {
    try {
      await collectLegibleFees(options.feeCollection || {});
    } catch (err) {
      console.error(`[FEE COLLECT] cycle failed: ${err.message}`);
    }
  }
  // V2 fallback-rate monitor (no-op until LOSS_REWARD_POOL_V2_ADDRESS is set). Runs after the
  // epochs so a monitoring failure can never delay a payout.
  if (!options.skipFallbackMonitor) await monitorFallbackEvents(options.fallbackMonitor || {});
  return results;
}

// ---------------------------------------------------------------------------------------------
// Legible-pool fee collection.
//
// On the legible pool the 2% LP fee accrues INSIDE the hook's PoolManager position. Nothing moves
// until someone calls hook.collect(token) (ETH half -> creatorBalances / LossRewardPool, token half
// -> converter) and then converter.convert(token, 0, 0) (token-side fees sold for ETH, split the
// same way). In production nobody did, so creatorBalances and V2.totalDeposited stayed 0 despite
// trades. Each tick the worker, for every legible token with recent trades:
//   1. simulates collect() from state (position checkpoint + fee growth, the PoolManager's own
//      formula) and sends collect(token) when ETH fees >= FEE_COLLECT_MIN_MULTIPLE x gas cost;
//   2. reads converter.pendingTokenFees(token), values it at the converter's checkpoint price, and
//      sends convert(token, 0, 0) on the same rule (the converter enforces its own TWAP-style floor).
// Gas: node estimate + 30%, never below 300,000 (the 2026-09-07 out-of-gas lesson).
// ---------------------------------------------------------------------------------------------

/**
 * Pure: is `valueWei` worth spending `gasEstimate` at `gasPriceWei`? Exported for tests.
 * Returns { send, costWei, ratio } where ratio = value / cost (Infinity when cost is 0).
 */
export function decideFeeAction({ valueWei, gasEstimate, gasPriceWei, minMultiple = FEE_COLLECT_MIN_MULTIPLE }) {
  const value = BigInt(valueWei || 0n);
  const costWei = BigInt(gasEstimate || 0n) * BigInt(gasPriceWei || 0n);
  if (value <= 0n) return { send: false, costWei, ratio: 0, reason: 'nothing to collect' };
  if (costWei === 0n) return { send: true, costWei, ratio: Infinity, reason: 'zero gas cost' };
  const ratio = Number(value) / Number(costWei);
  const send = value >= costWei * BigInt(Math.ceil(minMultiple));
  return { send, costWei, ratio, reason: send ? `value ${ratio.toFixed(1)}x gas` : `value only ${ratio.toFixed(1)}x gas (< ${minMultiple}x)` };
}

/** estimate + 30%, floor FEE_TX_GAS_FLOOR — the gas policy for every legible-pool transaction. */
export function feeTxGasLimit(estimate, floor = FEE_TX_GAS_FLOOR) {
  const padded = BigInt(estimate) + (BigInt(estimate) * 30n) / 100n;
  return padded < floor ? floor : padded;
}

/**
 * Legible tokens that traded in the last `lookbackHours` (token_trades_evm.block_time), de-duplicated.
 * `tokens.hook_address` (PR #21) tags legible launches; tokens without the tag are checked on-chain.
 */
export async function findRecentlyTradedLegibleTokens({ client = publicClient, db = supabase, lookbackHours = FEE_COLLECT_LOOKBACK_HOURS, now = () => Date.now() } = {}) {
  const since = new Date(now() - lookbackHours * 3600 * 1000).toISOString();
  const { data: trades, error } = await db.from('token_trades_evm').select('token_address').gte('block_time', since);
  if (error) throw new Error(`token_trades_evm query failed: ${error.message}`);
  const candidates = [...new Set((trades || []).map((t) => String(t.token_address || '').toLowerCase()).filter(Boolean))];
  if (!candidates.length) return [];
  const { data: rows } = await db.from('tokens').select('mint_address, hook_address').in('mint_address', candidates.map((a) => getAddress(a)));
  const tagged = new Map((rows || []).map((r) => [String(r.mint_address || '').toLowerCase(), String(r.hook_address || '').toLowerCase()]));
  const legibleHook = INCENTIFI_LEGIBLE_HOOK.toLowerCase();
  const out = [];
  for (const addr of candidates) {
    const tag = tagged.get(addr);
    if (tag === legibleHook) { out.push(getAddress(addr)); continue; }
    if (tag) continue; // tagged with another hook
    if (await isLegibleToken(client, getAddress(addr)).catch(() => false)) out.push(getAddress(addr));
  }
  return out;
}

/**
 * One fee-collection pass. Options (all optional, for tests): client, walletClient (viem, with
 * account), tokens (explicit list; skips the DB), minMultiple, gasFloor, dryRun, log, alert, now.
 * Returns one summary per token. Never throws for a single token's failure.
 */
export async function collectLegibleFees(options = {}) {
  const client = options.client ?? publicClient;
  const log = options.log ?? ((m) => console.log(m));
  const alert = options.alert ?? sendAlert;
  const minMultiple = options.minMultiple ?? FEE_COLLECT_MIN_MULTIPLE;
  const gasFloor = options.gasFloor ?? FEE_TX_GAS_FLOOR;
  const dryRun = Boolean(options.dryRun);
  if (!(options.enabled ?? FEE_COLLECT_ENABLED)) return [];
  let walletClient = options.walletClient ?? null;
  if (!walletClient && !dryRun) {
    if (!OPERATOR_PRIVATE_KEY) { log('[FEE COLLECT] OPERATOR_PRIVATE_KEY unset - skipping fee collection'); return []; }
    walletClient = createWalletClient({ account: privateKeyToAccount(OPERATOR_PRIVATE_KEY), transport: rpcTransport });
  }
  const account = walletClient ? walletClient.account : null;

  const tokens = options.tokens ?? (await findRecentlyTradedLegibleTokens({ client, db: options.db ?? supabase, lookbackHours: options.lookbackHours, now: options.now }));
  if (!tokens.length) { log('[FEE COLLECT] no legible tokens with recent trades'); return []; }
  const gasPriceWei = BigInt(options.gasPriceWei ?? (await client.getGasPrice()));
  const results = [];
  for (const tokenRaw of tokens) {
    const token = getAddress(tokenRaw);
    const summary = { token, collect: null, convert: null };
    results.push(summary);
    try {
      // ---- 1. collect() ----
      const fees = await computeUncollectedLegibleFees(client, token);
      if (!fees.seeded) { summary.collect = { sent: false, reason: 'curve not seeded' }; continue; }
      // Value of a collect() = ETH fees + the token-side fees at the converter's checkpoint price
      // (audit finding 3: sells leave token-only fees that never cleared the ETH-only bar).
      let tokenSideValueWei = 0n;
      if (fees.tokenFees > 0n) {
        try { tokenSideValueWei = BigInt(await client.readContract({ address: INCENTIFI_LEGIBLE_FEE_CONVERTER, abi: LEGIBLE_CONVERTER_ABI, functionName: 'checkpointEthValue', args: [token, fees.tokenFees] })); }
        catch { tokenSideValueWei = 0n; }
      }
      const collectValueWei = fees.ethFees + tokenSideValueWei;
      let collectDecision = decideFeeAction({ valueWei: collectValueWei, gasEstimate: 0n, gasPriceWei, minMultiple });
      if (collectValueWei > 0n) {
        let gasEstimate;
        try {
          gasEstimate = await client.estimateContractGas({ address: INCENTIFI_LEGIBLE_HOOK, abi: LEGIBLE_HOOK_ABI, functionName: 'collect', args: [token], account: account?.address ?? account ?? undefined });
        } catch (err) {
          summary.collect = { sent: false, reason: `collect() would revert: ${err.shortMessage || err.message}`, ethFees: fees.ethFees.toString() };
          log(`[FEE COLLECT] ${token}: collect() simulation reverted (${err.shortMessage || err.message}); skipping`);
          continue;
        }
        collectDecision = decideFeeAction({ valueWei: collectValueWei, gasEstimate, gasPriceWei, minMultiple });
        log(`[FEE COLLECT] ${token}: uncollected ${formatEther(fees.ethFees)} ETH + ${formatEther(fees.tokenFees)} tokens (~${formatEther(tokenSideValueWei)} ETH at checkpoint); collect gas ~${gasEstimate} @ ${gasPriceWei} wei = ${formatEther(collectDecision.costWei)} ETH -> ${collectDecision.reason}`);
        if (collectDecision.send && !dryRun) {
          const gas = feeTxGasLimit(gasEstimate, gasFloor);
          const hash = await walletClient.writeContract({ address: INCENTIFI_LEGIBLE_HOOK, abi: LEGIBLE_HOOK_ABI, functionName: 'collect', args: [token], gas, chain: null });
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== 'success') throw new Error(`collect(${token}) reverted on-chain: ${hash}`);
          const ev = decodeReceiptEvents(receipt, INCENTIFI_LEGIBLE_HOOK, LEGIBLE_HOOK_ABI).find((e) => e.eventName === 'FeesCollected');
          summary.collect = { sent: true, hash, gas: gas.toString(), gasUsed: receipt.gasUsed.toString(), ethFees: (ev?.args?.ethFees ?? fees.ethFees).toString(), tokenFees: (ev?.args?.tokenFees ?? fees.tokenFees).toString(), creatorShare: (ev?.args?.creatorShare ?? fees.creatorShare).toString(), lossPoolShare: (ev?.args?.lossPoolShare ?? fees.lossPoolShare).toString() };
          log(`[FEE COLLECT] ${token}: collect() sent ${hash} (gas limit ${gas}, used ${receipt.gasUsed}) -> ethFees ${formatEther(BigInt(summary.collect.ethFees))} (creator ${formatEther(BigInt(summary.collect.creatorShare))}, loss pool ${formatEther(BigInt(summary.collect.lossPoolShare))}), tokenFees ${formatEther(BigInt(summary.collect.tokenFees))} to the converter`);
        } else {
          summary.collect = { sent: false, reason: dryRun && collectDecision.send ? 'dry run' : collectDecision.reason, ethFees: fees.ethFees.toString(), tokenFees: fees.tokenFees.toString(), tokenSideValueWei: tokenSideValueWei.toString(), costWei: collectDecision.costWei.toString() };
        }
      } else {
        summary.collect = { sent: false, reason: 'nothing to collect', tokenFees: fees.tokenFees.toString() };
      }

      // ---- 2. convert() ----
      const pending = BigInt(await client.readContract({ address: INCENTIFI_LEGIBLE_FEE_CONVERTER, abi: LEGIBLE_CONVERTER_ABI, functionName: 'pendingTokenFees', args: [token] }));
      if (pending === 0n) { summary.convert = { sent: false, reason: 'nothing pending' }; continue; }
      let valueWei = 0n;
      try {
        valueWei = BigInt(await client.readContract({ address: INCENTIFI_LEGIBLE_FEE_CONVERTER, abi: LEGIBLE_CONVERTER_ABI, functionName: 'checkpointEthValue', args: [token, pending] }));
      } catch (err) {
        summary.convert = { sent: false, reason: `no price checkpoint (${err.shortMessage || err.message})`, pendingTokenWei: pending.toString() };
        log(`[FEE CONVERT] ${token}: ${summary.convert.reason}`);
        continue;
      }
      let convertGas;
      try {
        convertGas = await client.estimateContractGas({ address: INCENTIFI_LEGIBLE_FEE_CONVERTER, abi: LEGIBLE_CONVERTER_ABI, functionName: 'convert', args: [token, 0n, 0n], account: account?.address ?? account ?? undefined });
      } catch (err) {
        summary.convert = { sent: false, reason: `convert() would revert: ${err.shortMessage || err.message}`, pendingTokenWei: pending.toString(), pendingEthValueWei: valueWei.toString() };
        log(`[FEE CONVERT] ${token}: convert() simulation reverted (${err.shortMessage || err.message}); skipping`);
        continue;
      }
      const convertDecision = decideFeeAction({ valueWei, gasEstimate: convertGas, gasPriceWei, minMultiple });
      log(`[FEE CONVERT] ${token}: pending ${formatEther(pending)} tokens ~ ${formatEther(valueWei)} ETH at checkpoint; convert gas ~${convertGas} = ${formatEther(convertDecision.costWei)} ETH -> ${convertDecision.reason}`);
      if (convertDecision.send && !dryRun) {
        const gas = feeTxGasLimit(convertGas, gasFloor);
        const hash = await walletClient.writeContract({ address: INCENTIFI_LEGIBLE_FEE_CONVERTER, abi: LEGIBLE_CONVERTER_ABI, functionName: 'convert', args: [token, 0n, 0n], gas, chain: null });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`convert(${token}) reverted on-chain: ${hash}`);
        const ev = decodeReceiptEvents(receipt, INCENTIFI_LEGIBLE_FEE_CONVERTER, LEGIBLE_CONVERTER_ABI).find((e) => e.eventName === 'Converted');
        summary.convert = { sent: true, hash, gas: gas.toString(), gasUsed: receipt.gasUsed.toString(), tokensIn: (ev?.args?.tokensIn ?? pending).toString(), ethOut: (ev?.args?.ethOut ?? 0n).toString(), creatorShare: (ev?.args?.creatorShare ?? 0n).toString(), lossPoolShare: (ev?.args?.lossPoolShare ?? 0n).toString() };
        log(`[FEE CONVERT] ${token}: convert() sent ${hash} (gas limit ${gas}, used ${receipt.gasUsed}) -> ${formatEther(BigInt(summary.convert.tokensIn))} tokens -> ${formatEther(BigInt(summary.convert.ethOut))} ETH (creator ${formatEther(BigInt(summary.convert.creatorShare))}, loss pool ${formatEther(BigInt(summary.convert.lossPoolShare))})`);
      } else {
        summary.convert = { sent: false, reason: dryRun && convertDecision.send ? 'dry run' : convertDecision.reason, pendingTokenWei: pending.toString(), pendingEthValueWei: valueWei.toString(), costWei: convertDecision.costWei.toString() };
      }
    } catch (err) {
      summary.error = err.message;
      console.error(`[FEE COLLECT] ${token}: ${err.message}`);
      await alert(`Legible fee collection failed for ${token}: ${err.message}`);
    }
  }
  return results;
}

/** Decodes every log a receipt carries from `address` against `abi` (unknown logs skipped). */
function decodeReceiptEvents(receipt, address, abi) {
  const out = [];
  for (const l of receipt.logs || []) {
    if (String(l.address).toLowerCase() !== String(address).toLowerCase()) continue;
    try { out.push(decodeEventLog({ abi, data: l.data, topics: l.topics })); } catch { /* not ours */ }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// LossRewardPoolV2 fallback monitor.
//
// A stock claim that cannot deliver the stock pays ETH instead and emits
// RewardPaidInEthFallback(claimant, token, asset, reason, data). That is the ONLY signal of an
// adapter bug, a drained route, or a paused asset: no transaction fails, every user simply gets
// ETH. So the worker polls the event on every run and alerts on any reason that is not expected
// in normal operation (ForcedEth = owner decision, BelowMinimum = small claim, by design).
// ---------------------------------------------------------------------------------------------
export const FALLBACK_REASONS = [
  'ForcedEth', 'AssetDisabled', 'RegistryMismatch', 'AssetPaused', 'ClaimantBlocked',
  'NoLiquidity', 'ReferenceUnavailable', 'BelowMinimum', 'BelowProtocolBound', 'SwapFailed',
];
export const EXPECTED_FALLBACK_REASONS = new Set(['ForcedEth', 'BelowMinimum']);
const FALLBACK_EVENT = parseAbiItem(
  'event RewardPaidInEthFallback(address indexed claimant, address indexed token, address indexed asset, uint8 reason, bytes data)'
);
/** Default look-back when there is no cursor yet: ~5 minutes at ~10 blocks/s, one worker cadence. */
export const FALLBACK_LOOKBACK_BLOCKS = 3000n;
let fallbackCursorBlock = null;

/**
 * Pure: folds RewardPaidInEthFallback logs into counts per reason. Exported for unit tests.
 */
export function summarizeFallbackEvents(logs) {
  const byReason = {};
  const tokens = new Set();
  const claimants = new Set();
  let alertable = 0;
  for (const log of logs || []) {
    const idx = Number(log.args?.reason ?? -1);
    const name = FALLBACK_REASONS[idx] ?? `Unknown(${idx})`;
    byReason[name] = (byReason[name] || 0) + 1;
    if (log.args?.token) tokens.add(String(log.args.token).toLowerCase());
    if (log.args?.claimant) claimants.add(String(log.args.claimant).toLowerCase());
    if (!EXPECTED_FALLBACK_REASONS.has(name)) alertable++;
  }
  return { total: (logs || []).length, alertable, byReason, tokens: [...tokens], claimants: claimants.size };
}

/**
 * Polls RewardPaidInEthFallback on LossRewardPoolV2 since the last run and alerts on unexpected
 * reasons. No-op until LOSS_REWARD_POOL_V2_ADDRESS is configured. Never throws into the epoch
 * loop: monitoring must not be able to stop payouts.
 *   options.client  — viem public client (default: the worker's)
 *   options.alert   — alert sink (default: sendAlert)
 *   options.address — pool address (default: env)
 *   options.fromBlock / options.toBlock — override the cursor (tests)
 */
export async function monitorFallbackEvents(options = {}) {
  const address = options.address ?? LOSS_REWARD_POOL_V2_ADDRESS;
  if (!address) return { skipped: true, reason: 'LOSS_REWARD_POOL_V2_ADDRESS not set' };
  const client = options.client ?? publicClient;
  const alert = options.alert ?? sendAlert;
  try {
    const latest = options.toBlock ?? (await client.getBlockNumber());
    let fromBlock = options.fromBlock ?? fallbackCursorBlock;
    if (fromBlock == null) fromBlock = latest > FALLBACK_LOOKBACK_BLOCKS ? latest - FALLBACK_LOOKBACK_BLOCKS : 0n;
    if (fromBlock > latest) return { skipped: true, reason: 'cursor ahead of head', fromBlock, toBlock: latest };
    const logs = await client.getLogs({ address: getAddress(address), event: FALLBACK_EVENT, fromBlock, toBlock: latest });
    const summary = summarizeFallbackEvents(logs);
    fallbackCursorBlock = latest + 1n;
    if (summary.total > 0) {
      const line = Object.entries(summary.byReason).map(([k, v]) => `${k}=${v}`).join(', ');
      console.log(`[FALLBACK MONITOR] ${summary.total} RewardPaidInEthFallback in blocks ${fromBlock}-${latest} (${line}); tokens: ${summary.tokens.join(',')}`);
      if (summary.alertable > 0) {
        await alert(`LossRewardPoolV2 paid ${summary.alertable} stock claim(s) in ETH for an UNEXPECTED reason in blocks ${fromBlock}-${latest}: ${line}. Tokens: ${summary.tokens.join(',')}. Check the adapter/route/asset state before the next epoch.`);
      }
    }
    return { ...summary, fromBlock, toBlock: latest };
  } catch (err) {
    console.warn(`[FALLBACK MONITOR] could not read RewardPaidInEthFallback logs: ${err.message}`);
    return { skipped: true, reason: 'error', detail: err.message };
  }
}

// Backward-compatible alias
export const runHourlyWorker = runEpochWorker;

if (process.argv[1]?.endsWith('loss-reward-worker.mjs')) {
  const isDryRun = process.argv.includes('--dry-run');
  runEpochWorker({ dryRun: isDryRun }).then(() => process.exit(0));
}
