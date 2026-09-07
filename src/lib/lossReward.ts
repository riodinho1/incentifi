import { encodeFunctionData, parseAbi, getAddress, formatEther } from 'viem';
import { supabase } from './supabase';
import { publicClient, getEvmProvider, ensureEvmChain, waitForTransactionReceipt } from './evmNetwork';
import { LOSS_REWARD_POOL } from './uniswapAddresses';
import { getStoredSession, fetchLossRewardData } from './lossRewardAuth';

// Includes LossRewardPool's custom errors so a pre-flight simulation of a claim decodes a
// revert to its name (e.g. AlreadyClaimed / InvalidProof) instead of a bare 4-byte selector.
const LOSS_POOL_ABI = parseAbi([
  'function getUnallocatedBalance(address token) view returns (uint256)',
  'function totalDeposited(address token) view returns (uint256)',
  'function totalAllocated(address token) view returns (uint256)',
  'function totalClaimed(address token) view returns (uint256)',
  'function hasClaimed(address token, uint256 epochId, address account) view returns (bool)',
  'function claimReward(address token, uint256 epochId, uint256 amount, bytes32[] calldata merkleProof)',
  'function claimBatch(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata merkleProofs)',
  'error EpochNotPublished()',
  'error AlreadyClaimed()',
  'error InvalidProof()',
  'error EthTransferFailed()',
  'error ArrayLengthMismatch()',
  'error ReentrancyGuardReentrantCall()',
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
  /** Exact wei amount as the gateway computed it (BigInt(Math.round(finalRewardEth * 1e18)).toString()). */
  amountWei?: string;
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
 * Claim one or more epochs — a thin alias for claimBatchRewards kept for existing call sites.
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

export type ClaimResult = {
  success: boolean;
  txHash: string | null;
  claimedEth?: string;
  alreadyClaimed?: boolean;
  message?: string;
};

/**
 * Claim every uncollected published epoch for (token, wallet) in ONE transaction, signed and sent
 * by the user's own connected wallet — the same eth_sendTransaction path buys and sells use.
 *
 * Why not the gateway's relayer: LossRewardPool binds each Merkle leaf (and the ETH payout) to
 * msg.sender (`_claimEpoch(..., msg.sender)`), and the worker builds leaves for the HOLDER. A claim
 * relayed from the operator wallet therefore reverts InvalidProof for every wallet except the
 * operator itself — and even a matching leaf would pay the operator, not the holder. Only the
 * holder's wallet can be msg.sender, so the holder must sign.
 *
 * The authenticated gateway is still the source of truth for WHAT is claimable (`/query` returns
 * the unclaimed epochs, exact wei amounts and Merkle proofs, reconciled against on-chain
 * hasClaimed); callers may pass that list in to avoid a second round-trip.
 */
export const claimBatchRewards = async (
  tokenAddress: string,
  walletAddress: string,
  unclaimedEpochs?: UnclaimedEpoch[]
): Promise<ClaimResult> => {
  if (!tokenAddress || !walletAddress) {
    throw new Error('Token address and connected wallet are required.');
  }
  const token = getAddress(tokenAddress);
  const wallet = getAddress(walletAddress);

  // 1. What is claimable — from the caller's already-fetched state, else the authenticated gateway.
  let epochs = (unclaimedEpochs || []).filter((e) => Number.isFinite(e.epochNumber));
  if (epochs.length === 0) {
    const data = await fetchLossRewardData(token, wallet);
    epochs = data.claimable.unclaimedEpochs || [];
  }
  if (epochs.length === 0) {
    return { success: true, txHash: null, claimedEth: '0', alreadyClaimed: true, message: 'No claimable rewards available.' };
  }

  // 2. The connected wallet MUST be the holder the proofs were built for.
  const provider = getEvmProvider();
  if (!provider) throw new Error('No EVM wallet detected. Please connect your wallet.');
  await ensureEvmChain();
  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const sender = accounts?.[0];
  if (!sender) throw new Error('Wallet is connected, but no active account was found.');
  if (getAddress(sender) !== wallet) {
    throw new Error(
      `The wallet's active account (${sender.slice(0, 6)}…${sender.slice(-4)}) is not the holder these rewards belong to ` +
        `(${wallet.slice(0, 6)}…${wallet.slice(-4)}). Switch accounts in your wallet and try again.`
    );
  }

  // 3. Exact arguments. amountWei is the gateway's exact figure when present; the fallback is the
  //    identical rounding the worker used to build the leaf, so the two can't drift.
  const sorted = [...epochs].sort((a, b) => a.epochNumber - b.epochNumber);
  const epochIds = sorted.map((e) => BigInt(e.epochNumber));
  const amounts = sorted.map((e) => (e.amountWei ? BigInt(e.amountWei) : BigInt(Math.round(e.finalRewardEth * 1e18))));
  const proofs = sorted.map((e) => (Array.isArray(e.merkleProof) ? e.merkleProof : []) as `0x${string}`[]);
  const totalWei = amounts.reduce((s, a) => s + a, 0n);
  const pool = getAddress(LOSS_REWARD_POOL);

  const call =
    sorted.length === 1
      ? ({ functionName: 'claimReward', args: [token, epochIds[0], amounts[0], proofs[0]] } as const)
      : ({ functionName: 'claimBatch', args: [token, epochIds, amounts, proofs] } as const);

  // 4. Pre-flight the exact call as the sender so a revert surfaces by name (AlreadyClaimed,
  //    InvalidProof, …) BEFORE the wallet prompts — instead of a failed tx the user paid for.
  try {
    await publicClient.simulateContract({ address: pool, abi: LOSS_POOL_ABI, account: wallet, ...call } as any);
  } catch (err: any) {
    // Wallet RPCs differ in where the decoded reason lands (shortMessage vs details vs cause);
    // look at all of them before deciding.
    const fullText = [err?.shortMessage, err?.message, err?.details, err?.cause?.message, err?.cause?.details]
      .filter(Boolean)
      .join(' ');
    if (/AlreadyClaimed/.test(fullText)) {
      return { success: true, txHash: null, claimedEth: '0', alreadyClaimed: true, message: 'Rewards were already claimed on-chain.' };
    }
    throw new Error(`Claim would revert on-chain: ${err?.shortMessage || err?.message || String(err)}`);
  }

  // 5. Send from the user's wallet — identical mechanics to executeV4Buy / swap.ts.
  const data = encodeFunctionData({ abi: LOSS_POOL_ABI, ...call } as any);
  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: sender, to: pool, data }],
  })) as string;

  await waitForTransactionReceipt(txHash, {
    description: 'Reward claim',
    revertedMessage: 'Reward claim reverted on-chain. Nothing was paid out.',
  });

  return { success: true, txHash, claimedEth: formatEther(totalWei) };
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
