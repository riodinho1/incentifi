import { encodeFunctionData, parseAbi, getAddress } from 'viem';
import { supabase } from './supabase';
import { getEvmProvider } from './evmNetwork';
import { LOSS_REWARD_POOL } from './uniswapAddresses';

const LOSS_POOL_ABI = parseAbi([
  'function getUnallocatedBalance(address token) view returns (uint256)',
  'function totalDeposited(address token) view returns (uint256)',
  'function totalAllocated(address token) view returns (uint256)',
  'function totalClaimed(address token) view returns (uint256)',
  'function hasClaimed(address token, uint256 epochId, address account) view returns (bool)',
  'function claimReward(address token, uint256 epochId, uint256 amount, bytes32[] calldata merkleProof)',
  'function claimBatch(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata merkleProofs)',
]);

/** Snapshot interval: 5 minutes (300 seconds) */
export const SNAPSHOT_INTERVAL_SECONDS = 300;
export const SNAPSHOT_INTERVAL_MINUTES = 5;

export type HolderCostBasis = {
  tokenAddress: string;
  walletAddress: string;
  tokenBalance: number;
  totalInvestedEth: number;
  avgCostBasisEth: number;
  isEligible: boolean;
  isUnderwaterSeller: boolean;
};

export type UnrealizedLossStats = {
  tokenBalance: number;
  costBasisEth: number;
  currentPriceEth: number;
  unrealizedLossEth: number;
  unrealizedLossPct: number;
  theoreticalRewardEth: number;
  isUnderwater: boolean;
  isEligible: boolean;
};

export type UnclaimedEpoch = {
  id: number;
  epochId: number;
  epochNumber: number;
  finalRewardEth: number;
  merkleProof: string[];
};

export type ClaimableRewardsState = {
  unclaimedEpochs: UnclaimedEpoch[];
  totalClaimableEth: number;
};

/**
 * Fetch a holder's cost basis and eligibility status from Supabase.
 */
export const getHolderCostBasis = async (
  tokenAddress: string,
  walletAddress: string
): Promise<HolderCostBasis | null> => {
  if (!tokenAddress || !walletAddress) return null;
  const token = tokenAddress.toLowerCase();
  const wallet = walletAddress.toLowerCase();

  const { data, error } = await supabase
    .from('holder_cost_basis')
    .select('*')
    .eq('token_address', token)
    .eq('wallet_address', wallet)
    .maybeSingle();

  if (error || !data) {
    return {
      tokenAddress: token,
      walletAddress: wallet,
      tokenBalance: 0,
      totalInvestedEth: 0,
      avgCostBasisEth: 0,
      isEligible: true,
      isUnderwaterSeller: false,
    };
  }

  return {
    tokenAddress: data.token_address,
    walletAddress: data.wallet_address,
    tokenBalance: Number(data.token_balance || 0),
    totalInvestedEth: Number(data.total_invested_eth || 0),
    avgCostBasisEth: Number(data.avg_cost_basis_eth || 0),
    isEligible: data.is_eligible ?? true,
    isUnderwaterSeller: data.is_underwater_seller ?? false,
  };
};

/**
 * Calculate real-time unrealized loss and 10% theoretical reward stats.
 */
export const calculateUnrealizedLossStats = (
  costBasis: HolderCostBasis | null,
  currentPriceEth: number
): UnrealizedLossStats => {
  if (!costBasis || costBasis.tokenBalance <= 0 || costBasis.avgCostBasisEth <= 0) {
    return {
      tokenBalance: costBasis?.tokenBalance || 0,
      costBasisEth: 0,
      currentPriceEth,
      unrealizedLossEth: 0,
      unrealizedLossPct: 0,
      theoreticalRewardEth: 0,
      isUnderwater: false,
      isEligible: costBasis?.isEligible ?? true,
    };
  }

  const { tokenBalance, avgCostBasisEth, totalInvestedEth, isEligible, isUnderwaterSeller } = costBasis;
  const currentValEth = tokenBalance * currentPriceEth;
  const isUnderwater = currentPriceEth < avgCostBasisEth;

  const unrealizedLossEth = isUnderwater ? Math.max(0, totalInvestedEth - currentValEth) : 0;
  const unrealizedLossPct = totalInvestedEth > 0 ? (unrealizedLossEth / totalInvestedEth) * 100 : 0;
  const theoreticalRewardEth = (isEligible && !isUnderwaterSeller) ? 0.10 * unrealizedLossEth : 0;

  return {
    tokenBalance,
    costBasisEth: avgCostBasisEth,
    currentPriceEth,
    unrealizedLossEth,
    unrealizedLossPct,
    theoreticalRewardEth,
    isUnderwater,
    isEligible: isEligible && !isUnderwaterSeller,
  };
};

/**
 * Fetch all uncollected Merkle reward proofs for the connected wallet.
 */
export const getClaimableRewards = async (
  tokenAddress: string,
  walletAddress: string
): Promise<ClaimableRewardsState> => {
  if (!tokenAddress || !walletAddress) {
    return { unclaimedEpochs: [], totalClaimableEth: 0 };
  }

  const token = tokenAddress.toLowerCase();
  const wallet = walletAddress.toLowerCase();

  const { data, error } = await supabase
    .from('epoch_holder_rewards')
    .select(`
      id,
      epoch_id,
      final_reward_eth,
      merkle_proof,
      claimed,
      reward_epochs!inner (
        epoch_number
      )
    `)
    .eq('token_address', token)
    .eq('wallet_address', wallet)
    .eq('claimed', false);

  if (error || !data || data.length === 0) {
    return { unclaimedEpochs: [], totalClaimableEth: 0 };
  }

  const unclaimedEpochs: UnclaimedEpoch[] = data.map((d: any) => ({
    id: d.id,
    epochId: Number(d.epoch_id),
    epochNumber: Number(d.reward_epochs?.epoch_number || d.epoch_id),
    finalRewardEth: Number(d.final_reward_eth || 0),
    merkleProof: Array.isArray(d.merkle_proof) ? d.merkle_proof : [],
  }));

  const totalClaimableEth = unclaimedEpochs.reduce((sum, item) => sum + item.finalRewardEth, 0);

  return { unclaimedEpochs, totalClaimableEth };
};

/**
 * Execute on-chain claim for a single epoch.
 */
export const claimReward = async (
  tokenAddress: string,
  walletAddress: string,
  epochNumber: number,
  amountEth: number,
  merkleProof: string[],
  epochId?: number
) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Connect wallet first.');

  const token = getAddress(tokenAddress);
  const wallet = getAddress(walletAddress);
  const pool = getAddress(LOSS_REWARD_POOL);
  const amountWei = BigInt(Math.round(amountEth * 1e18));

  const claimData = encodeFunctionData({
    abi: LOSS_POOL_ABI,
    functionName: 'claimReward',
    args: [token, BigInt(epochNumber), amountWei, merkleProof as `0x${string}`[]],
  });

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: wallet, to: pool, data: claimData }],
  });

  // Mark claimed in Supabase
  if (epochId) {
    await supabase
      .from('epoch_holder_rewards')
      .update({ claimed: true, claimed_at: new Date().toISOString() })
      .eq('epoch_id', epochId)
      .eq('wallet_address', walletAddress.toLowerCase());
  }

  return txHash;
};

/**
 * Execute on-chain batch claim for all uncollected epochs in a single transaction.
 */
export const claimBatchRewards = async (
  tokenAddress: string,
  walletAddress: string,
  unclaimedEpochs: UnclaimedEpoch[]
) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Connect wallet first.');
  if (unclaimedEpochs.length === 0) throw new Error('No claimable rewards available.');

  const token = getAddress(tokenAddress);
  const wallet = getAddress(walletAddress);
  const pool = getAddress(LOSS_REWARD_POOL);

  const onchainEpochIds = unclaimedEpochs.map((e) => BigInt(e.epochNumber));
  const amounts = unclaimedEpochs.map((e) => BigInt(Math.round(e.finalRewardEth * 1e18)));
  const proofs = unclaimedEpochs.map((e) => e.merkleProof as `0x${string}`[]);

  const claimData = encodeFunctionData({
    abi: LOSS_POOL_ABI,
    functionName: 'claimBatch',
    args: [token, onchainEpochIds, amounts, proofs],
  });

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: wallet, to: pool, data: claimData }],
  });

  // Mark all claimed in Supabase
  const epochIdList = unclaimedEpochs.map((e) => e.epochId);
  await supabase
    .from('epoch_holder_rewards')
    .update({ claimed: true, claimed_at: new Date().toISOString() })
    .in('epoch_id', epochIdList)
    .eq('wallet_address', walletAddress.toLowerCase());

  return txHash;
};

/**
 * Query the total available ETH in the token's Loss Reward Pool.
 */
export const getLossRewardPoolTVL = async (tokenAddress: string): Promise<number> => {
  try {
    const token = tokenAddress.toLowerCase();
    const { data } = await supabase
      .from('token_market_snapshots_evm')
      .select('loss_pool_tvl_eth')
      .eq('token_address', token)
      .maybeSingle();

    if (data?.loss_pool_tvl_eth) {
      return Number(data.loss_pool_tvl_eth);
    }

    const provider = getEvmProvider();
    if (provider) {
      const tokenAddr = getAddress(tokenAddress);
      const pool = getAddress(LOSS_REWARD_POOL);
      const callData = encodeFunctionData({
        abi: LOSS_POOL_ABI,
        functionName: 'getUnallocatedBalance',
        args: [tokenAddr],
      });
      const result = await provider.request({
        method: 'eth_call',
        params: [{ to: pool, data: callData }, 'latest'],
      });
      if (result && result !== '0x') {
        return Number(BigInt(result)) / 1e18;
      }
    }
  } catch {
    // Fail silently and return 0
  }
  return 0;
};
