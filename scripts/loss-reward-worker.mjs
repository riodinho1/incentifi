import { createClient } from '@supabase/supabase-js';
import {
  createPublicClient,
  parseAbiItem,
  createWalletClient,
  http,
  parseAbi,
  getAddress,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  concat,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import { isLegibleToken, fetchLegibleState } from './lib/legiblePool.mjs';

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
const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
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
const publicClient = createPublicClient({ transport: http(RPC_URL) });

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
 *   - V2 not configured                          -> V1 (today's behaviour, unchanged)
 *   - V1 unallocated >= this epoch's demand      -> V1 (V1 can still fund a whole epoch: keep draining it)
 *   - V1 unallocated >= dust but < demand, V2 set -> V2 (V1's remainder is smaller than one epoch; it
 *                                                    is picked up by a later, smaller epoch rather
 *                                                    than parking this one as pending_funding forever)
 *   - V1 unallocated < dust                      -> V2
 * The demand-aware rule is what makes "drain" safe for tokens whose hook has been re-pointed to
 * V2: V1 receives no new deposits for them, so an underfunded epoch published there would never
 * resolve. Pending epochs keep the pool they were recorded on (reward_epochs.pool_address).
 * Never throws: an RPC failure reading V1 falls back to V1 (the status quo).
 */
export async function resolveEpochPool(tokenAddress, demandWei = 0n, options = {}) {
  const v1 = options.v1 ?? LOSS_REWARD_POOL_V1_ADDRESS;
  const v2 = options.v2 ?? LOSS_REWARD_POOL_V2_ADDRESS;
  const dustWei = options.dustWei ?? MIN_EPOCH_PAYOUT_WEI;
  const client = options.client ?? publicClient;
  if (!v2) return { address: v1, version: 'v1', reason: 'v2_not_configured', v1UnallocatedWei: null };
  let v1UnallocatedWei;
  try {
    v1UnallocatedWei = BigInt(
      await client.readContract({ address: getAddress(v1), abi: POOL_ABI, functionName: 'getUnallocatedBalance', args: [getAddress(tokenAddress)] })
    );
  } catch (err) {
    console.warn(`[POOL SELECT] Could not read V1 unallocated balance for ${tokenAddress} (${err.message}); staying on V1.`);
    return { address: v1, version: 'v1', reason: 'v1_read_failed', v1UnallocatedWei: null };
  }
  const demand = BigInt(demandWei || 0n);
  if (v1UnallocatedWei >= dustWei && (demand === 0n || v1UnallocatedWei >= demand)) {
    return { address: v1, version: 'v1', reason: 'v1_can_fund', v1UnallocatedWei };
  }
  return { address: v2, version: 'v2', reason: v1UnallocatedWei < dustWei ? 'v1_drained' : 'v1_below_demand', v1UnallocatedWei };
}

/**
 * reward_epochs insert that tolerates a not-yet-applied migration: if PostgREST rejects the
 * pool_address column (supabase/loss_reward_v2_migration.sql not run), retry without it and warn
 * once. The gateway treats a null pool_address as V1, which is what an un-migrated deployment is.
 */
let warnedPoolAddressColumn = false;
async function insertRewardEpoch(row, select = null) {
  let q = supabase.from('reward_epochs').insert(row);
  let res = select ? await q.select(select).single() : await q;
  if (res.error && row.pool_address !== undefined && /pool_address|column/i.test(res.error.message || '')) {
    if (!warnedPoolAddressColumn) {
      console.warn('[DB] reward_epochs.pool_address is missing — apply supabase/loss_reward_v2_migration.sql. Inserting without it (readers treat null as V1).');
      warnedPoolAddressColumn = true;
    }
    const { pool_address, ...rest } = row;
    q = supabase.from('reward_epochs').insert(rest);
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
      if (await v4.isV4LaunchedToken(token)) {
        const state = await v4.fetchV4CurveState(token);
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
export async function executeEpochForToken(tokenAddress, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const token = tokenAddress.toLowerCase();

  // 1. Concurrency Guard
  if (activeTokenLocks.has(token)) {
    console.warn(`[CONCURRENCY LOCK] Token ${token} is already processing an epoch. Skipping concurrent invocation.`);
    return { skipped: true, reason: 'concurrency_locked' };
  }

  activeTokenLocks.add(token);

  try {
    console.log(`\n======================================================`);
    console.log(`[EPOCH WORKER] Processing Loss-Reward Epoch for ${token} (DRY RUN = ${dryRun})`);

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
        console.error(`[FRESHNESS GATE] Refusing to run epoch for ${token}: ${freshness.reason}`);
        return { skipped: true, reason: 'indexer_stale', detail: freshness.reason, ageSeconds: freshness.ageSeconds };
      }
      console.log(`[FRESHNESS GATE] Indexer heartbeat is fresh (${freshness.ageSeconds.toFixed(1)}s old, threshold ${INDEXER_FRESHNESS_THRESHOLD_SECONDS}s). Proceeding.`);
    }

    // 1b. Check & Resolve Prior Pending Funding Epochs (FIFO)
    if (!dryRun && OPERATOR_PRIVATE_KEY && LOSS_REWARD_POOL_ADDRESS) {
      try {
        // pool_address may not exist before the V2 migration: select it defensively.
        let pendingRes = await supabase
          .from('reward_epochs')
          .select('epoch_id, epoch_number, total_distributed_eth, merkle_root, status, pool_address')
          .eq('token_address', token)
          .eq('status', 'pending_funding')
          .order('epoch_number', { ascending: true });
        if (pendingRes.error && /pool_address|column/i.test(pendingRes.error.message || '')) {
          pendingRes = await supabase
            .from('reward_epochs')
            .select('epoch_id, epoch_number, total_distributed_eth, merkle_root, status')
            .eq('token_address', token)
            .eq('status', 'pending_funding')
            .order('epoch_number', { ascending: true });
        }
        const pendingEpochs = pendingRes.data;

        if (pendingEpochs && pendingEpochs.length > 0) {
          // A pending epoch is funded from the pool it was RECORDED on (null = V1, pre-migration
          // rows). Balances are read once per pool and drawn down as epochs are published.
          const poolBalanceEth = new Map();
          const balanceFor = async (poolAddr) => {
            const key = poolAddr.toLowerCase();
            if (!poolBalanceEth.has(key)) {
              const wei = await publicClient.readContract({
                address: getAddress(poolAddr),
                abi: POOL_ABI,
                functionName: 'getUnallocatedBalance',
                args: [getAddress(token)],
              });
              poolBalanceEth.set(key, Number(wei) / 1e18);
            }
            return poolBalanceEth.get(key);
          };

          for (const pending of pendingEpochs) {
            const pendingPool = pending.pool_address || LOSS_REWARD_POOL_V1_ADDRESS;
            let currentPoolEth = await balanceFor(pendingPool);
            const requiredEth = Number(pending.total_distributed_eth || 0);
            if (currentPoolEth >= requiredEth && requiredEth > 0) {
              console.log(`[PENDING EPOCH RESOLUTION] Pool ${pendingPool} funded (${currentPoolEth.toFixed(6)} ETH >= ${requiredEth.toFixed(6)} ETH). Publishing Epoch #${pending.epoch_number}...`);
              const account = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
              const walletClient = createWalletClient({ account, transport: http(RPC_URL) });
              const totalAllocatedWei = BigInt(Math.round(requiredEth * 1e18));

              const txHash = await walletClient.writeContract({
                address: getAddress(pendingPool),
                abi: POOL_ABI,
                functionName: 'setEpochMerkleRoot',
                args: [getAddress(token), BigInt(pending.epoch_number), pending.merkle_root, totalAllocatedWei],
              });

              const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
              if (receipt.status === 'success') {
                await supabase
                  .from('reward_epochs')
                  .update({ status: 'published', onchain_tx_hash: txHash })
                  .eq('epoch_id', pending.epoch_id);
                console.log(`[PENDING EPOCH PUBLISHED] Epoch #${pending.epoch_number} now published & claimable on ${pendingPool} (Tx: ${txHash}).`);
                currentPoolEth -= requiredEth;
                poolBalanceEth.set(pendingPool.toLowerCase(), currentPoolEth);
              }
            } else {
              console.log(`[PENDING EPOCH REMAINS] Epoch #${pending.epoch_number} requires ${requiredEth.toFixed(6)} ETH, pool has ${currentPoolEth.toFixed(6)} ETH.`);
              break; // Maintain FIFO ordering
            }
          }
        }
      } catch (err) {
        console.warn(`[PENDING RESOLUTION ERROR] Could not process pending epochs: ${err.message}`);
      }
    }

    // 2. Fetch authoritative benchmark price (Curve getCurrentPrice pre-graduation, Uniswap V3 post-graduation)
    const priceRes = await getTokenBenchmarkPriceEth(token);
    const benchmarkPriceEth = priceRes.priceEth;

    if (benchmarkPriceEth <= 0) {
      console.log(`[EPOCH WORKER] No valid benchmark price for ${token}. Skipping epoch.`);
      return { skipped: true, reason: 'invalid_price' };
    }
    console.log(`[PRICE BENCHMARK] ${priceRes.isGraduated ? 'Graduated' : 'Pre-Graduation'} Price: ${benchmarkPriceEth.toExponential(6)} ETH per token (Source: ${priceRes.source})`);

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
    const candidateEpochNumber = latestDbEpochNumber + 1;

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
        console.warn(`[ON-CHAIN READ WARNING] Could not read candidate epoch root on ${poolAddr}: ${err.message}`);
      }
    }

    const isCandidatePublishedOnchain = Boolean(
      onchainCandidateRoot &&
      onchainCandidateRoot !== '0x0000000000000000000000000000000000000000000000000000000000000000'
    );

    console.log(`[EPOCH RECONCILIATION] DB Latest Epoch: #${latestDbEpochNumber} | Candidate Epoch: #${candidateEpochNumber} | On-Chain Published: ${isCandidatePublishedOnchain}`);

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
      console.log(`[EPOCH WORKER] No eligible underwater holders for ${token}.`);
      if (!dryRun && !isCandidatePublishedOnchain) {
        await insertRewardEpoch({
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
      };
    }

    // 5. Calculate 10% Theoretical Loss Reward per holder
    let totalTheoreticalDemandEth = 0;
    const eligibleAllocations = [];

    for (const h of holders) {
      // On-chain balance guard — see applyOnChainBalanceCap(). FAIL CLOSED: if the chain can't
      // be read, this epoch is skipped for this token rather than paid on unverified data.
      let onChainBalanceTokens;
      try {
        const raw = await publicClient.readContract({
          address: getAddress(token),
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [getAddress(h.wallet_address)],
        });
        onChainBalanceTokens = Number(raw) / 1e18;
      } catch (err) {
        throw new Error(`[BALANCE GUARD] Could not read on-chain balance for ${h.wallet_address} — refusing to compute epoch on unverified holder data: ${err.message}`);
      }
      const capped = applyOnChainBalanceCap(h, onChainBalanceTokens);
      if (capped.capped) {
        console.warn(`[BALANCE GUARD] ${h.wallet_address}: DB balance ${capped.dbBalance} > on-chain ${capped.onChainBalance} (indexer lag or a missed sell). Paying on ${capped.balance} only.`);
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

    console.log(`[DEMAND] Eligible Underwater Holders: ${eligibleAllocations.length}`);
    console.log(`[DEMAND] Total Theoretical Reward Demand: ${totalTheoreticalDemandEth.toFixed(10)} ETH`);

    // 6. Choose the pool for THIS epoch (drain V1, then switch to V2 — see resolveEpochPool) and
    //    query its available balance. If the candidate epoch already exists on-chain (crash
    //    recovery), the pool that holds it wins.
    const demandWei = BigInt(Math.round(totalTheoreticalDemandEth * 1e18));
    const epochPool = onchainCandidatePool
      ? { address: onchainCandidatePool, version: onchainCandidatePool.toLowerCase() === (LOSS_REWARD_POOL_V2_ADDRESS || '').toLowerCase() ? 'v2' : 'v1', reason: 'already_on_chain' }
      : await resolveEpochPool(token, demandWei);
    const EPOCH_POOL_ADDRESS = epochPool.address;
    console.log(`[POOL SELECT] Epoch #${candidateEpochNumber} -> ${epochPool.version.toUpperCase()} ${EPOCH_POOL_ADDRESS} (${epochPool.reason}${epochPool.v1UnallocatedWei != null ? `, V1 unallocated ${(Number(epochPool.v1UnallocatedWei) / 1e18).toFixed(6)} ETH` : ''})`);

    let availablePoolEth = 0;
    if (EPOCH_POOL_ADDRESS) {
      try {
        const balanceWei = await publicClient.readContract({
          address: getAddress(EPOCH_POOL_ADDRESS),
          abi: POOL_ABI,
          functionName: 'getUnallocatedBalance',
          args: [getAddress(token)],
        });
        availablePoolEth = Number(balanceWei) / 1e18;
      } catch (err) {
        console.warn(`[POOL READ] Could not read on-chain pool balance: ${err.message}. Defaulting to demand.`);
        availablePoolEth = totalTheoreticalDemandEth;
      }
    } else {
      availablePoolEth = totalTheoreticalDemandEth;
    }

    console.log(`[POOL BUDGET] Available Unallocated ETH on ${epochPool.version.toUpperCase()}: ${availablePoolEth.toFixed(6)} ETH`);

    // 7. Calculate Proportional Scaling Factor & Mode
    // When pool is underfunded, 100% full theoretical rewards and proofs are preserved as pending_funding
    const isUnderfunded = availablePoolEth < totalTheoreticalDemandEth;
    const scalingFactor = 1.0;
    const totalDistributedEth = totalTheoreticalDemandEth;

    // 7a. Minimum-payout dust guard (see MIN_EPOCH_PAYOUT_WEI's own doc comment).
    // Checked here, BEFORE building the Merkle tree or touching cost basis: a
    // dust-level reward must skip depletion entirely too, or holders would have
    // their recorded loss reduced for compensation they never actually received.
    // Only applies when this candidate epoch hasn't already been published
    // on-chain — an already-published epoch (e.g. from before this guard
    // existed) still needs full reconciliation below, not a retroactive skip.
    const { candidateAllocatedWei, isDust } = evaluateDustGuard(totalDistributedEth);
    if (!isCandidatePublishedOnchain && isDust) {
      console.log(`[DUST GUARD] Candidate Epoch #${candidateEpochNumber} total payout (${candidateAllocatedWei.toString()} wei) is below the minimum payout threshold (${MIN_EPOCH_PAYOUT_WEI.toString()} wei, ${eligibleAllocations.length} eligible holder(s)). Skipping Merkle tree construction, on-chain submission, and cost-basis depletion — recording as completed_dust instead.`);
      if (!dryRun) {
        await insertRewardEpoch({
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
      };
    }

    // 8. Calculate Final Scaled Rewards & Generate Merkle Leaves
    const leaves = [];
    const finalPayouts = [];

    for (let i = 0; i < eligibleAllocations.length; i++) {
      const alloc = eligibleAllocations[i];
      const finalRewardEth = alloc.theoreticalReward;
      const finalRewardWei = BigInt(Math.round(finalRewardEth * 1e18));

      const leaf = hashLeaf(token, candidateEpochNumber, alloc.wallet, finalRewardWei);
      leaves.push(leaf);

      finalPayouts.push({
        ...alloc,
        finalRewardEth,
        finalRewardWei,
        leafIndex: i,
      });

      console.log(`  Holder #${i+1} [${alloc.wallet.slice(0, 10)}...]: Balance=${alloc.balance.toFixed(2)} | CostBasis=${alloc.costBasis.toExponential(4)} | Loss=${alloc.unrealizedLoss.toFixed(8)} ETH | Final Reward=${finalRewardEth.toFixed(10)} ETH (${finalRewardWei.toString()} wei)`);
    }

    // 9. Build Merkle Tree & Root
    const tree = new MerkleTree(leaves);
    const merkleRoot = tree.getRoot();
    console.log(`[MERKLE TREE] Generated Merkle Root: ${merkleRoot}`);

    // 10. Reconciliation Path (State 3: Chain present, DB absent)
    if (isCandidatePublishedOnchain) {
      if (onchainCandidateRoot.toLowerCase() !== merkleRoot.toLowerCase()) {
        throw new Error(
          `[RECONCILIATION ERROR] On-chain Merkle root (${onchainCandidateRoot}) does not match calculated candidate root (${merkleRoot}) for Epoch #${candidateEpochNumber}. Stopping execution to prevent state corruption.`
        );
      }
      console.log(`[RECONCILIATION SUCCESS] On-chain Merkle root matches candidate calculation. Resuming database persistence.`);
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
            transport: http(RPC_URL),
          });

          const totalAllocatedWei = BigInt(Math.round(totalDistributedEth * 1e18));
          console.log(`[ON-CHAIN] Submitting setEpochMerkleRoot for Epoch #${candidateEpochNumber} on ${epochPool.version.toUpperCase()} ${EPOCH_POOL_ADDRESS}...`);

          onchainTxHash = await walletClient.writeContract({
            address: getAddress(EPOCH_POOL_ADDRESS),
            abi: POOL_ABI,
            functionName: 'setEpochMerkleRoot',
            args: [getAddress(token), BigInt(candidateEpochNumber), merkleRoot, totalAllocatedWei],
          });

          console.log(`[ON-CHAIN] Transaction broadcast: ${onchainTxHash}. Awaiting receipt...`);

          // Wait for on-chain receipt confirmation
          const receipt = await publicClient.waitForTransactionReceipt({ hash: onchainTxHash });
          if (receipt.status !== 'success') {
            throw new Error(`[ON-CHAIN REVERT] Transaction ${onchainTxHash} reverted on-chain.`);
          }
          console.log(`[ON-CHAIN CONFIRMED] Block #${receipt.blockNumber} Gas Used: ${receipt.gasUsed}`);
          epochStatus = 'published';
        } catch (err) {
          console.error(`[ON-CHAIN FATAL] setEpochMerkleRoot failed: ${err.message}`);
          throw err;
        }
      } else {
        epochStatus = 'pending_funding';
        console.log(`[POOL UNDERFUNDED] Available pool (${availablePoolEth.toFixed(6)} ETH) < demand (${totalDistributedEth.toFixed(6)} ETH). Saving Epoch #${candidateEpochNumber} as 'pending_funding' (original theoretical rewards & Merkle proofs preserved).`);
      }
    } else if (isCandidatePublishedOnchain) {
      epochStatus = 'published';
    }

    // 12. Database Persistence: reward_epochs & epoch_holder_rewards
    if (!dryRun) {
      const { data: insertedEpoch, error: insertEpochErr } = await insertRewardEpoch({
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

      // 13. DEFERRED COST-BASIS DEPLETION: Apply ONLY after on-chain confirmed & DB persisted
      console.log(`[COST BASIS DEPLETION] Applying post-confirmation cost-basis depletion for ${finalPayouts.length} holders...`);
      for (const payout of finalPayouts) {
        const newInvested = Math.max(0, payout.invested - payout.finalRewardEth);
        const newCostBasis = payout.balance > 0 ? newInvested / payout.balance : 0;

        const { error: updateHolderErr } = await supabase.from('holder_cost_basis').update({
          total_invested_eth: newInvested,
          avg_cost_basis_eth: newCostBasis,
          last_updated_at: new Date().toISOString(),
        }).eq('token_address', token).eq('wallet_address', payout.wallet);

        if (updateHolderErr) {
          console.warn(`[DB WARNING] Could not update cost basis for ${payout.wallet}: ${updateHolderErr.message}`);
        }
      }

      console.log(`[SUCCESS] Epoch #${candidateEpochNumber} complete! Distributed: ${totalDistributedEth.toFixed(6)} ETH to ${finalPayouts.length} holders.`);
    } else {
      console.log(`[DRY RUN COMPLETE] Simulated Epoch #${candidateEpochNumber}: ${totalDistributedEth.toFixed(10)} ETH total allocation for ${finalPayouts.length} eligible holders (0 DB/on-chain mutations).`);
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
    };
  } finally {
    // Release concurrency lock
    activeTokenLocks.delete(token);
  }
}

/**
 * Main 5-minute epoch cron runner
 */
export async function runEpochWorker(options = {}) {
  console.log('--- Incentifi 5-Minute Loss-Reward Worker Started ---');
  const { data: tokens, error: tokErr } = await supabase.from('tokens').select('mint_address');
  if (tokErr || !tokens) return [];

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
  // V2 fallback-rate monitor (no-op until LOSS_REWARD_POOL_V2_ADDRESS is set). Runs after the
  // epochs so a monitoring failure can never delay a payout.
  if (!options.skipFallbackMonitor) await monitorFallbackEvents(options.fallbackMonitor || {});
  return results;
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
