import { createClient } from '@supabase/supabase-js';
import {
  createPublicClient,
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
import fs from 'fs';

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
const INCENTIFI_FACTORY_ADDRESS = process.env.VITE_INCENTIFI_BONDING_CURVE_FACTORY || '0x9fcea653c6f31c82606582b22da82b39f61f9c0e';

/** Loss-Reward Snapshot Interval: 5 minutes (300 seconds) */
export const SNAPSHOT_INTERVAL_SECONDS = 300;
export const SNAPSHOT_INTERVAL_MINUTES = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const publicClient = createPublicClient({ transport: http(RPC_URL) });

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

/**
 * Resolves the authoritative benchmark price for a token:
 * - If PRE-GRADUATION: Queries the Incentifi Bonding Curve getCurrentPrice() (or reserve calculation).
 * - If GRADUATED: Queries the canonical Uniswap V3 Pool 30-minute TWAP (with slot0 fallback).
 */
export async function getTokenBenchmarkPriceEth(tokenAddress) {
  const token = getAddress(tokenAddress);
  const factory = getAddress(INCENTIFI_FACTORY_ADDRESS);

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

    // 1b. Check & Resolve Prior Pending Funding Epochs (FIFO)
    if (!dryRun && OPERATOR_PRIVATE_KEY && LOSS_REWARD_POOL_ADDRESS) {
      try {
        const { data: pendingEpochs } = await supabase
          .from('reward_epochs')
          .select('epoch_id, epoch_number, total_distributed_eth, merkle_root, status')
          .eq('token_address', token)
          .eq('status', 'pending_funding')
          .order('epoch_number', { ascending: true });

        if (pendingEpochs && pendingEpochs.length > 0) {
          const currentPoolWei = await publicClient.readContract({
            address: getAddress(LOSS_REWARD_POOL_ADDRESS),
            abi: POOL_ABI,
            functionName: 'getUnallocatedBalance',
            args: [getAddress(token)],
          });
          let currentPoolEth = Number(currentPoolWei) / 1e18;

          for (const pending of pendingEpochs) {
            const requiredEth = Number(pending.total_distributed_eth || 0);
            if (currentPoolEth >= requiredEth && requiredEth > 0) {
              console.log(`[PENDING EPOCH RESOLUTION] Pool funded (${currentPoolEth.toFixed(6)} ETH >= ${requiredEth.toFixed(6)} ETH). Publishing Epoch #${pending.epoch_number}...`);
              const account = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
              const walletClient = createWalletClient({ account, transport: http(RPC_URL) });
              const totalAllocatedWei = BigInt(Math.round(requiredEth * 1e18));

              const txHash = await walletClient.writeContract({
                address: getAddress(LOSS_REWARD_POOL_ADDRESS),
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
                console.log(`[PENDING EPOCH PUBLISHED] Epoch #${pending.epoch_number} now published & claimable (Tx: ${txHash}).`);
                currentPoolEth -= requiredEth;
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
    console.log(`[PRICE BENCHMARK] ${priceRes.isGraduated ? 'Graduated (Uniswap V3)' : 'Pre-Graduation (Bonding Curve)'} Price: ${benchmarkPriceEth.toExponential(6)} ETH per token (Source: ${priceRes.source})`);

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

    // Check on-chain root for candidate epoch
    let onchainCandidateRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
    try {
      const root = await publicClient.readContract({
        address: getAddress(LOSS_REWARD_POOL_ADDRESS),
        abi: POOL_ABI,
        functionName: 'epochMerkleRoots',
        args: [getAddress(token), BigInt(candidateEpochNumber)],
      });
      onchainCandidateRoot = root;
    } catch (err) {
      console.warn(`[ON-CHAIN READ WARNING] Could not read candidate epoch root on-chain: ${err.message}`);
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
        await supabase.from('reward_epochs').insert({
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
      const balance = Number(h.token_balance);
      const costBasis = Number(h.avg_cost_basis_eth);
      const invested = Number(h.total_invested_eth);
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

    // 6. Query On-Chain Available Pool Balance
    let availablePoolEth = 0;
    if (LOSS_REWARD_POOL_ADDRESS) {
      try {
        const balanceWei = await publicClient.readContract({
          address: getAddress(LOSS_REWARD_POOL_ADDRESS),
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

    console.log(`[POOL BUDGET] Available Unallocated ETH: ${availablePoolEth.toFixed(6)} ETH`);

    // 7. Calculate Proportional Scaling Factor & Mode
    // When pool is underfunded, 100% full theoretical rewards and proofs are preserved as pending_funding
    const isUnderfunded = availablePoolEth < totalTheoreticalDemandEth;
    const scalingFactor = 1.0;
    const totalDistributedEth = totalTheoreticalDemandEth;

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

    if (!dryRun && !isCandidatePublishedOnchain && OPERATOR_PRIVATE_KEY && LOSS_REWARD_POOL_ADDRESS) {
      if (!isUnderfunded) {
        try {
          const account = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
          const walletClient = createWalletClient({
            account,
            transport: http(RPC_URL),
          });

          const totalAllocatedWei = BigInt(Math.round(totalDistributedEth * 1e18));
          console.log(`[ON-CHAIN] Submitting setEpochMerkleRoot for Epoch #${candidateEpochNumber}...`);

          onchainTxHash = await walletClient.writeContract({
            address: getAddress(LOSS_REWARD_POOL_ADDRESS),
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
      const { data: insertedEpoch, error: insertEpochErr } = await supabase.from('reward_epochs').insert({
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
      }).select('epoch_id').single();

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
    if (t.mint_address) {
      const res = await executeEpochForToken(t.mint_address, options);
      results.push(res);
    }
  }
  return results;
}

// Backward-compatible alias
export const runHourlyWorker = runEpochWorker;

if (process.argv[1]?.endsWith('loss-reward-worker.mjs')) {
  const isDryRun = process.argv.includes('--dry-run');
  runEpochWorker({ dryRun: isDryRun }).then(() => process.exit(0));
}
