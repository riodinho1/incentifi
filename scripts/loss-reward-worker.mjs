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
import { getPoolTwapPriceEth } from './evm-indexer.mjs';

// Environment Configuration
const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'http://127.0.0.1:8545';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || '';
const LOSS_REWARD_POOL_ADDRESS = process.env.VITE_LOSS_REWARD_POOL || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const publicClient = createPublicClient({ transport: http(RPC_URL) });

const POOL_ABI = parseAbi([
  'function getUnallocatedBalance(address token) view returns (uint256)',
  'function setEpochMerkleRoot(address token, uint256 epochId, bytes32 merkleRoot, uint256 allocatedAmount) external',
]);

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
 * Executes an hourly loss-reward epoch calculation for a given token.
 */
export async function executeEpochForToken(tokenAddress) {
  const token = tokenAddress.toLowerCase();
  console.log(`\n======================================================`);
  console.log(`[EPOCH WORKER] Processing Loss-Reward Epoch for ${token}`);

  // 1. Fetch 30-minute TWAP benchmark price
  const twapPriceEth = await getPoolTwapPriceEth(token);
  if (twapPriceEth <= 0) {
    console.log(`[EPOCH WORKER] No valid TWAP price for ${token}. Skipping epoch.`);
    return;
  }
  console.log(`[TWAP BENCHMARK] 30-min TWAP Price: ${twapPriceEth.toFixed(8)} ETH per token`);

  // 2. Fetch latest epoch number
  const { data: latestEpoch } = await supabase
    .from('reward_epochs')
    .select('epoch_number')
    .eq('token_address', token)
    .order('epoch_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const epochNumber = (latestEpoch?.epoch_number || 0) + 1;
  console.log(`[EPOCH NUMBER] Generating Epoch #${epochNumber}`);

  // 3. Query all eligible underwater holders
  const { data: holders } = await supabase
    .from('holder_cost_basis')
    .select('*')
    .eq('token_address', token)
    .eq('is_eligible', true)
    .eq('is_underwater_seller', false)
    .gt('token_balance', 0)
    .gt('avg_cost_basis_eth', twapPriceEth);

  if (!holders || holders.length === 0) {
    console.log(`[EPOCH WORKER] No eligible underwater holders for ${token}.`);
    // Record empty epoch record
    await supabase.from('reward_epochs').insert({
      token_address: token,
      epoch_number: epochNumber,
      pool_price_eth: twapPriceEth,
      pool_twap_price_eth: twapPriceEth,
      total_theoretical_reward_eth: 0,
      available_pool_eth: 0,
      scaling_factor: 1.0,
      total_distributed_eth: 0,
      merkle_root: '0x0000000000000000000000000000000000000000000000000000000000000000',
      status: 'completed_empty',
    });
    return;
  }

  // 4. Calculate 10% Theoretical Loss Reward per holder
  let totalTheoreticalDemandEth = 0;
  const eligibleAllocations = [];

  for (const h of holders) {
    const balance = Number(h.token_balance);
    const costBasis = Number(h.avg_cost_basis_eth);
    const invested = Number(h.total_invested_eth);
    const currentVal = balance * twapPriceEth;
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
  console.log(`[DEMAND] Total Theoretical Reward Demand: ${totalTheoreticalDemandEth.toFixed(6)} ETH`);

  // 5. Query On-Chain Available Pool Balance
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

  // 6. Calculate Proportional Scaling Factor
  const scalingFactor = totalTheoreticalDemandEth > 0
    ? Math.min(1.0, availablePoolEth / totalTheoreticalDemandEth)
    : 1.0;
  console.log(`[SCALING] Proportional Scaling Factor: ${(scalingFactor * 100).toFixed(2)}%`);

  // 7. Calculate Final Scaled Rewards & Apply Cost-Basis Depletion
  let totalDistributedEth = 0;
  const leaves = [];
  const finalPayouts = [];

  for (let i = 0; i < eligibleAllocations.length; i++) {
    const alloc = eligibleAllocations[i];
    const finalRewardEth = alloc.theoreticalReward * scalingFactor;
    const finalRewardWei = BigInt(Math.round(finalRewardEth * 1e18));
    totalDistributedEth += finalRewardEth;

    // Generate leaf
    const leaf = hashLeaf(token, epochNumber, alloc.wallet, finalRewardWei);
    leaves.push(leaf);

    finalPayouts.push({
      ...alloc,
      finalRewardEth,
      finalRewardWei,
      leafIndex: i,
    });

    // Apply Cost-Basis Depletion in holder_cost_basis
    const newInvested = Math.max(0, alloc.invested - finalRewardEth);
    const newCostBasis = alloc.balance > 0 ? newInvested / alloc.balance : 0;

    await supabase.from('holder_cost_basis').update({
      total_invested_eth: newInvested,
      avg_cost_basis_eth: newCostBasis,
      last_updated_at: new Date().toISOString(),
    }).eq('token_address', token).eq('wallet_address', alloc.wallet);
  }

  // 8. Build Merkle Tree
  const tree = new MerkleTree(leaves);
  const merkleRoot = tree.getRoot();
  console.log(`[MERKLE TREE] Generated Merkle Root: ${merkleRoot}`);

  // 9. Submit Merkle Root On-Chain (if Operator Key configured)
  let onchainTxHash = null;
  if (OPERATOR_PRIVATE_KEY && LOSS_REWARD_POOL_ADDRESS) {
    try {
      const account = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
      const walletClient = createWalletClient({
        account,
        transport: http(RPC_URL),
      });

      const totalAllocatedWei = BigInt(Math.round(totalDistributedEth * 1e18));
      onchainTxHash = await walletClient.writeContract({
        address: getAddress(LOSS_REWARD_POOL_ADDRESS),
        abi: POOL_ABI,
        functionName: 'setEpochMerkleRoot',
        args: [getAddress(token), BigInt(epochNumber), merkleRoot, totalAllocatedWei],
      });
      console.log(`[ON-CHAIN] Merkle Root published! Tx: ${onchainTxHash}`);
    } catch (err) {
      console.error(`[ON-CHAIN ERROR] Failed to publish Merkle Root:`, err.message);
    }
  }

  // 10. Record Epoch and Holder Allocations in Supabase
  const { data: insertedEpoch } = await supabase.from('reward_epochs').insert({
    token_address: token,
    epoch_number: epochNumber,
    pool_price_eth: twapPriceEth,
    pool_twap_price_eth: twapPriceEth,
    total_theoretical_reward_eth: totalTheoreticalDemandEth,
    available_pool_eth: availablePoolEth,
    scaling_factor: scalingFactor,
    total_distributed_eth: totalDistributedEth,
    merkle_root: merkleRoot,
    onchain_tx_hash: onchainTxHash,
    status: 'published',
  }).select('epoch_id').single();

  const epochId = insertedEpoch?.epoch_id;

  for (const payout of finalPayouts) {
    const proof = tree.getProof(payout.leafIndex);
    await supabase.from('epoch_holder_rewards').insert({
      epoch_id: epochId,
      token_address: token,
      wallet_address: payout.wallet,
      token_balance: payout.balance,
      cost_basis_eth: payout.costBasis,
      unrealized_loss_eth: payout.unrealizedLoss,
      theoretical_reward_eth: payout.theoreticalReward,
      final_reward_eth: payout.finalRewardEth,
      merkle_proof: proof,
      claimed: false,
    });
  }

  console.log(`[SUCCESS] Epoch #${epochNumber} complete! Distributed: ${totalDistributedEth.toFixed(6)} ETH to ${finalPayouts.length} holders.`);
}

/**
 * Main hourly cron runner
 */
export async function runHourlyWorker() {
  console.log('--- Incentifi Hourly Loss-Reward Worker Started ---');
  const { data: tokens } = await supabase.from('tokens').select('mint_address');
  if (!tokens) return;

  for (const t of tokens) {
    if (t.mint_address) {
      await executeEpochForToken(t.mint_address);
    }
  }
}

if (process.argv[1]?.endsWith('loss-reward-worker.mjs')) {
  runHourlyWorker().then(() => process.exit(0));
}
