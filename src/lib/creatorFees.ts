import { encodeFunctionData, parseAbi, getAddress, formatEther } from 'viem';
import { publicClient, getEvmProvider, ensureEvmChain, waitForTransactionReceipt } from './evmNetwork';
import { INCENTIFI_V4_HOOK, INCENTIFI_LEGIBLE_HOOK } from './uniswapAddresses';
import { getBondingCurveAddress } from './bondingCurve';
import { isV4LaunchedToken, getV4PoolKey, computeV4PoolId } from './bondingCurveV4';
import { getLegiblePoolKey, estimateGasWithHeadroom, SWAP_GAS_FLOOR } from './legiblePool';
import { computeUncollectedLegibleFees, fetchPendingConversion, LEGIBLE_FEE_HOOK_ABI, type UncollectedLegibleFees, type PendingConversion } from './legibleFees';
import { resolveTokenVenue } from './tokenVenue';

// ----------------------------------------------------------------------------
// Creator fees are PULL payments on both venues, bound to msg.sender:
//   * V3: each token has its own IncentifiBondingCurve; the creator's 1% accrues in that
//     curve's creatorBalances[creator] (buys/sells on the curve AND post-graduation router
//     trades via depositCreatorFee) and is withdrawn with curve.claimCreatorFees().
//   * V4: one shared hook for every pool; creatorBalances[creator] there is GLOBAL across all
//     of that creator's V4 tokens, withdrawn with hook.claimCreatorFees() in one go.
// Both contracts pay msg.sender, so — exactly like loss-reward claims after PR #13 — the
// claim MUST be signed and sent by the creator's own connected wallet. No relayer.
// ----------------------------------------------------------------------------

const CREATOR_FEES_ABI = parseAbi([
  'function creatorBalances(address creator) view returns (uint256)',
  'function claimCreatorFees()',
  // V3 curve: who this token's creator is
  'function creator() view returns (address)',
  // V4 hook: per-pool state (creator is the 2nd field)
  'function curveStates(bytes32 poolId) view returns (address token, address creator, bool initialized, bool graduated, uint256 realEthReserve, uint256 realTokenReserve)',
  // custom errors, so a pre-flight simulation decodes by name
  'error NoBalanceToClaim()',
  'error EthTransferFailed()',
]);

export type CreatorFeeSource =
  | { kind: 'v3'; contract: `0x${string}`; scope: 'token' }
  // V4: the hook the token's pool is bound to — the legible hook (PR #17) or the previous
  // GenericSell hook. Both expose the same creatorBalances/claimCreatorFees surface; each keeps
  // its own global-per-creator balance, so a creator with tokens on both claims on both.
  | { kind: 'v4'; contract: `0x${string}`; scope: 'creator'; venue: 'legible' | 'v4-generic' };

export type CreatorFeeStatus = {
  source: CreatorFeeSource;
  /** The on-chain creator of THIS token. */
  creator: `0x${string}`;
  /** Whether `walletAddress` is that creator. */
  isCreator: boolean;
  /** creatorBalances(walletAddress) on the source contract (V4: across all the wallet's V4 tokens). "Ready to claim". */
  balanceWei: bigint;
  balanceEth: number;
  /**
   * Legible pools only: fees still sitting in the PoolManager position ("accrued in pool, uncollected"),
   * from a simulated collect(). `creatorShare` is the ETH the creator receives when collect() runs;
   * token-side fees become ETH only after the converter runs (see `pending`).
   */
  uncollected?: UncollectedLegibleFees;
  /** Legible pools only: token-side fees already collected, waiting for convert(). */
  pending?: PendingConversion;
};

/**
 * Which contract holds the creator-fee balance for this token: its V3 curve if the V3 factory
 * knows it, else the shared V4 hook if the V4 factory launched it, else null (not an Incentifi
 * launch, or not resolvable).
 */
export async function resolveCreatorFeeSource(tokenAddress: string): Promise<CreatorFeeSource | null> {
  const token = getAddress(tokenAddress);
  const curve = await getBondingCurveAddress(token);
  if (curve) return { kind: 'v3', contract: getAddress(curve), scope: 'token' };
  const venue = await resolveTokenVenue(token);
  if (venue === 'legible') return { kind: 'v4', contract: getAddress(INCENTIFI_LEGIBLE_HOOK), scope: 'creator', venue: 'legible' };
  if (venue === 'v4-generic' || (await isV4LaunchedToken(token))) {
    return { kind: 'v4', contract: getAddress(INCENTIFI_V4_HOOK), scope: 'creator', venue: 'v4-generic' };
  }
  return null;
}

/**
 * Live, on-chain creator-fee status for (token, wallet): who the creator is, whether this wallet
 * is it, and the wallet's claimable balance on the relevant contract.
 */
export async function fetchCreatorFeeStatus(tokenAddress: string, walletAddress: string): Promise<CreatorFeeStatus | null> {
  const token = getAddress(tokenAddress);
  const wallet = getAddress(walletAddress);
  const source = await resolveCreatorFeeSource(token);
  if (!source) return null;

  let creator: `0x${string}`;
  if (source.kind === 'v3') {
    creator = getAddress(
      (await publicClient.readContract({ address: source.contract, abi: CREATOR_FEES_ABI, functionName: 'creator' } as any)) as string
    );
  } else {
    const poolId = computeV4PoolId(source.venue === 'legible' ? await getLegiblePoolKey(token) : await getV4PoolKey(token));
    const state = (await publicClient.readContract({
      address: source.contract,
      abi: CREATOR_FEES_ABI,
      functionName: 'curveStates',
      args: [poolId],
    } as any)) as readonly [string, string, boolean, boolean, bigint, bigint];
    creator = getAddress(state[1]);
  }

  const balanceWei = (await publicClient.readContract({
    address: source.contract,
    abi: CREATOR_FEES_ABI,
    functionName: 'creatorBalances',
    args: [wallet],
  } as any)) as bigint;

  const status: CreatorFeeStatus = { source, creator, isCreator: creator === wallet, balanceWei, balanceEth: Number(formatEther(balanceWei)) };
  if (source.kind === 'v4' && source.venue === 'legible') {
    // Uncollected position fees + pending conversion: both read-only, both best-effort.
    try {
      status.uncollected = await computeUncollectedLegibleFees(token);
    } catch (err) {
      console.warn('Uncollected legible fees unavailable:', err);
    }
    try {
      status.pending = await fetchPendingConversion(token);
    } catch (err) {
      console.warn('Pending conversion unavailable:', err);
    }
  }
  return status;
}

/** True when a collect(token) would move something (ETH or token-side fees) out of the position. */
export function hasUncollectedFees(status: CreatorFeeStatus | null | undefined): boolean {
  const u = status?.uncollected;
  return Boolean(u && u.seeded && (u.ethFees > 0n || u.tokenFees > 0n));
}

export type CreatorFeeClaimResult = {
  /** The claimCreatorFees() transaction (null when only a collect ran and nothing was claimable after it). */
  txHash: string | null;
  /** The collect(token) transaction that ran first (legible pools with uncollected fees), else null. */
  collectTxHash: string | null;
  txHashes: string[];
  claimedEth: string;
  /** ETH the collect moved into creatorBalances before the claim ("0" when no collect ran). */
  collectedCreatorEth: string;
  source: CreatorFeeSource;
};

/**
 * Withdraw the connected wallet's accrued creator fees for this token's venue, signed and sent
 * by that wallet (same eth_sendTransaction mechanics as buys, sells and loss-reward claims).
 * On V4 this pays out the wallet's balance across ALL its V4 tokens, by contract design.
 *
 * Legible pools: fees accrue inside the PoolManager position until hook.collect(token) runs, so
 * the claim is TWO transactions — collect(token) first (skipped when the simulated collect shows
 * nothing uncollected), then claimCreatorFees(). Anyone may call collect; the creator's half of
 * the ETH lands in creatorBalances, the loss pool's half in LossRewardPoolV2, token-side fees in
 * the converter for a later convert().
 */
export async function claimCreatorFees(tokenAddress: string, walletAddress: string): Promise<CreatorFeeClaimResult> {
  const wallet = getAddress(walletAddress);
  let status = await fetchCreatorFeeStatus(tokenAddress, wallet);
  if (!status) throw new Error('This token has no Incentifi creator-fee contract to claim from.');
  const needsCollect = hasUncollectedFees(status);
  if (status.balanceWei === 0n && !needsCollect) throw new Error('No accrued creator fees to claim for this wallet.');

  const provider = getEvmProvider();
  if (!provider) throw new Error('No EVM wallet detected. Please connect your wallet.');
  await ensureEvmChain();
  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const sender = accounts?.[0];
  if (!sender) throw new Error('Wallet is connected, but no active account was found.');
  if (getAddress(sender) !== wallet) {
    throw new Error(
      `The wallet's active account (${sender.slice(0, 6)}…${sender.slice(-4)}) is not the wallet these creator fees belong to ` +
        `(${wallet.slice(0, 6)}…${wallet.slice(-4)}). Switch accounts in your wallet and try again.`
    );
  }

  const txHashes: string[] = [];
  let collectTxHash: string | null = null;
  let collectedCreatorEth = '0';

  // ---- 1. collect(token): only for legible pools with something uncollected ----
  if (needsCollect) {
    const token = getAddress(tokenAddress);
    const hook = status.source.contract;
    const collectData = encodeFunctionData({ abi: LEGIBLE_FEE_HOOK_ABI, functionName: 'collect', args: [token] });
    try {
      await publicClient.simulateContract({ address: hook, abi: LEGIBLE_FEE_HOOK_ABI, functionName: 'collect', args: [token], account: wallet } as any);
    } catch (err: any) {
      throw new Error(`collect(token) would revert on-chain: ${err?.shortMessage || err?.message || String(err)}`);
    }
    const gas = await estimateGasWithHeadroom(provider, { from: sender, to: hook, data: collectData }, SWAP_GAS_FLOOR);
    collectTxHash = (await provider.request({ method: 'eth_sendTransaction', params: [{ from: sender, to: hook, data: collectData, gas }] })) as string;
    txHashes.push(collectTxHash);
    await waitForTransactionReceipt(collectTxHash, {
      description: 'Fee collection',
      revertedMessage: 'collect(token) reverted on-chain. Nothing moved; your claimable balance is unchanged.',
    });
    collectedCreatorEth = formatEther(status.uncollected?.creatorShare ?? 0n);
    // Re-read: the claimable balance now includes the creator's half of the collected ETH.
    status = (await fetchCreatorFeeStatus(tokenAddress, wallet)) || status;
    if (status.balanceWei === 0n) {
      // Only token-side fees were collected (they become ETH after the converter runs) — nothing to claim yet.
      return { txHash: null, collectTxHash, txHashes, claimedEth: '0', collectedCreatorEth, source: status.source };
    }
  }

  // ---- 2. claimCreatorFees() ----
  // Pre-flight as the sender so a revert is decoded by name before the wallet prompts.
  try {
    await publicClient.simulateContract({ address: status.source.contract, abi: CREATOR_FEES_ABI, functionName: 'claimCreatorFees', account: wallet } as any);
  } catch (err: any) {
    const text = [err?.shortMessage, err?.message, err?.details, err?.cause?.message].filter(Boolean).join(' ');
    if (/NoBalanceToClaim/.test(text)) throw new Error('No accrued creator fees to claim for this wallet.');
    throw new Error(`Creator fee claim would revert on-chain: ${err?.shortMessage || err?.message || String(err)}`);
  }

  const data = encodeFunctionData({ abi: CREATOR_FEES_ABI, functionName: 'claimCreatorFees' });
  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: sender, to: status.source.contract, data }],
  })) as string;
  txHashes.push(txHash);

  await waitForTransactionReceipt(txHash, {
    description: 'Creator fee claim',
    revertedMessage: 'Creator fee claim reverted on-chain. Nothing was paid out.',
  });

  return { txHash, collectTxHash, txHashes, claimedEth: formatEther(status.balanceWei), collectedCreatorEth, source: status.source };
}
