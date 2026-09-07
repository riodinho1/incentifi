import { encodeFunctionData, parseAbi, getAddress, formatEther } from 'viem';
import { publicClient, getEvmProvider, ensureEvmChain, waitForTransactionReceipt } from './evmNetwork';
import { INCENTIFI_V4_HOOK } from './uniswapAddresses';
import { getBondingCurveAddress } from './bondingCurve';
import { isV4LaunchedToken, getV4PoolKey, computeV4PoolId } from './bondingCurveV4';

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
  | { kind: 'v4'; contract: `0x${string}`; scope: 'creator' };

export type CreatorFeeStatus = {
  source: CreatorFeeSource;
  /** The on-chain creator of THIS token. */
  creator: `0x${string}`;
  /** Whether `walletAddress` is that creator. */
  isCreator: boolean;
  /** creatorBalances(walletAddress) on the source contract (V4: across all the wallet's V4 tokens). */
  balanceWei: bigint;
  balanceEth: number;
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
  if (await isV4LaunchedToken(token)) return { kind: 'v4', contract: getAddress(INCENTIFI_V4_HOOK), scope: 'creator' };
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
    const poolId = computeV4PoolId(await getV4PoolKey(token));
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

  return { source, creator, isCreator: creator === wallet, balanceWei, balanceEth: Number(formatEther(balanceWei)) };
}

export type CreatorFeeClaimResult = { txHash: string; claimedEth: string; source: CreatorFeeSource };

/**
 * Withdraw the connected wallet's accrued creator fees for this token's venue, signed and sent
 * by that wallet (same eth_sendTransaction mechanics as buys, sells and loss-reward claims).
 * On V4 this pays out the wallet's balance across ALL its V4 tokens, by contract design.
 */
export async function claimCreatorFees(tokenAddress: string, walletAddress: string): Promise<CreatorFeeClaimResult> {
  const wallet = getAddress(walletAddress);
  const status = await fetchCreatorFeeStatus(tokenAddress, wallet);
  if (!status) throw new Error('This token has no Incentifi creator-fee contract to claim from.');
  if (status.balanceWei === 0n) throw new Error('No accrued creator fees to claim for this wallet.');

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

  await waitForTransactionReceipt(txHash, {
    description: 'Creator fee claim',
    revertedMessage: 'Creator fee claim reverted on-chain. Nothing was paid out.',
  });

  return { txHash, claimedEth: formatEther(status.balanceWei), source: status.source };
}
