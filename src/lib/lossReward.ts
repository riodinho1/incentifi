import { encodeFunctionData, parseAbi, getAddress } from 'viem';
import { supabase } from './supabase';
import { publicClient } from './evmNetwork';
import { LOSS_REWARD_POOL } from './uniswapAddresses';
import {
  getStoredSession,
  fetchLossRewardData,
  getGatewayBaseUrl,
  authenticateWallet,
  clearStoredSession,
} from './lossRewardAuth';

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

/**
 * Accurately formats ETH prices including sub-microETH values (e.g. 2e-9 on bonding curve).
 */
export const formatLossRewardEthPrice = (priceEth: number): string => {
  if (!Number.isFinite(priceEth) || priceEth <= 0) return '0.000000 ETH';
  if (priceEth < 0.00001) {
    const formatted = priceEth.toFixed(18).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
    return `${formatted} ETH`;
  }
  if (priceEth < 1) {
    return `${priceEth.toFixed(6)} ETH`;
  }
  return `${priceEth.toFixed(4)} ETH`;
};

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
  pendingEpochs: UnclaimedEpoch[];
  totalPendingEth: number;
};

/**
 * Fetch a holder's cost basis and eligibility status via the secure authenticated gateway.
 */
export const getHolderCostBasis = async (
  tokenAddress: string,
  walletAddress: string
): Promise<HolderCostBasis | null> => {
  if (!tokenAddress || !walletAddress) return null;
  const token = tokenAddress.toLowerCase();
  const wallet = walletAddress.toLowerCase();

  try {
    // If a session exists, use authenticated gateway query
    if (getStoredSession(wallet)) {
      const data = await fetchLossRewardData(token, wallet);
      return data.costBasis;
    }
  } catch (err) {
    console.warn('Authenticated cost basis query skipped/failed:', err);
  }

  // Default unauthenticated baseline state
  return {
    tokenAddress: token,
    walletAddress: wallet,
    tokenBalance: 0,
    totalInvestedEth: 0,
    avgCostBasisEth: 0,
    isEligible: true,
    isUnderwaterSeller: false,
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
 * Fetch all uncollected Merkle reward proofs for the connected wallet via the secure authenticated gateway.
 */
export const getClaimableRewards = async (
  tokenAddress: string,
  walletAddress: string
): Promise<ClaimableRewardsState> => {
  if (!tokenAddress || !walletAddress) {
    return { unclaimedEpochs: [], totalClaimableEth: 0, pendingEpochs: [], totalPendingEth: 0 };
  }

  const token = tokenAddress.toLowerCase();
  const wallet = walletAddress.toLowerCase();

  try {
    if (getStoredSession(wallet)) {
      const data = await fetchLossRewardData(token, wallet);
      return data.claimable;
    }
  } catch (err) {
    console.warn('Authenticated claimable rewards query skipped/failed:', err);
  }

  return { unclaimedEpochs: [], totalClaimableEth: 0, pendingEpochs: [], totalPendingEth: 0 };
};

/**
 * Execute gasless on-chain claim for a single or multiple epochs via authenticated relayer gateway.
 */
export const claimReward = async (
  tokenAddress: string,
  walletAddress: string,
  _epochNumber?: number,
  _amountEth?: number,
  _merkleProof?: string[],
  _epochId?: number
) => {
  return claimBatchRewards(tokenAddress, walletAddress);
};

/**
 * Execute gasless on-chain batch claim for all uncollected epochs in a single transaction via server relayer.
 */
export const claimBatchRewards = async (
  tokenAddress: string,
  walletAddress: string,
  _unclaimedEpochs?: UnclaimedEpoch[]
): Promise<{ success: boolean; txHash: string | null; claimedEth?: string; alreadyClaimed?: boolean; message?: string }> => {
  if (!tokenAddress || !walletAddress) {
    throw new Error('Token address and connected wallet are required.');
  }

  const normalizedWallet = getAddress(walletAddress).toLowerCase();
  let sessionToken = getStoredSession(normalizedWallet);

  // If session token is missing or expired, prompt gas-free EIP-191 signature
  if (!sessionToken) {
    sessionToken = await authenticateWallet(walletAddress);
  }

  const gatewayUrl = getGatewayBaseUrl();
  const makeRequest = async (token: string) => {
    return await fetch(`${gatewayUrl}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim(),
      },
      body: JSON.stringify({
        tokenAddress: getAddress(tokenAddress),
      }),
    });
  };

  let response = await makeRequest(sessionToken);

  if (response.status === 401) {
    // Session expired: clear and re-authenticate once
    clearStoredSession(normalizedWallet);
    const newSessionToken = await authenticateWallet(walletAddress);
    response = await makeRequest(newSessionToken);
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Gasless claim request failed (${response.status})`);
  }

  return await response.json();
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

    if (data?.loss_pool_tvl_eth && Number(data.loss_pool_tvl_eth) > 0) {
      return Number(data.loss_pool_tvl_eth);
    }

    const tokenAddr = getAddress(tokenAddress);
    const pool = getAddress(LOSS_REWARD_POOL);
    const result = await publicClient.readContract({
      address: pool,
      abi: LOSS_POOL_ABI,
      functionName: 'getUnallocatedBalance',
      args: [tokenAddr],
    } as any);
    return Number(result) / 1e18;
  } catch {
    return 0;
  }
};
