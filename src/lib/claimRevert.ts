/**
 * Claim pre-flight helpers (2026-09-09).
 *
 * Incident: pressing Claim on a V2 (stock-paying) epoch showed "Claim on the V2 pool would revert
 * on-chain: The contract function claimRewardAs reverted." and nothing else. viem's `shortMessage`
 * for a revert whose custom error IS in the ABI is exactly that bare sentence — the decoded name and
 * arguments live on the inner ContractFunctionRevertedError (`data.errorName`, `data.args`), and the
 * site only showed `shortMessage`. Every simulation of the same leaf from the holder succeeded when
 * replayed, so the user never learned which of InvalidProof / AlreadyClaimed / EpochNotPublished /
 * DeadlineExpired / MinOutNotMet it was. These helpers are pure (viem only) so they can be tested
 * without a wallet, an RPC or Supabase.
 */
import { BaseError, ContractFunctionRevertedError, RpcRequestError, HttpRequestError, encodeAbiParameters, parseAbiParameters, keccak256, concat, getAddress, formatEther } from 'viem';

export type ClaimEpochContext = {
  epochNumber: number;
  amountWei: bigint;
  pool: string;
  onChainRoot?: string | null;
};

export type ClaimRevertExplanation = {
  /** Decoded custom error name, 'RpcError', 'UnknownSelector', 'NoData' or 'Unknown'. */
  code: string;
  /** User-facing sentence(s). */
  message: string;
  /** Decoded args as strings (for logs). */
  args: string[];
  /** Raw 4-byte selector when the error could not be decoded. */
  signature?: string;
};

/** keccak256(bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount)))) — LossRewardPool's leaf. */
export function claimLeaf(token: string, epochId: number | bigint, claimant: string, amountWei: bigint): `0x${string}` {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters('address token, uint256 epochId, address claimant, uint256 amount'), [getAddress(token), BigInt(epochId), getAddress(claimant), amountWei]));
  return keccak256(inner);
}

/** OpenZeppelin-style sorted-pair Merkle verification (the pool's MerkleProof.verify). */
export function verifyClaimProof(leaf: `0x${string}`, proof: readonly string[], root: string): boolean {
  let h = leaf.toLowerCase();
  for (const p of proof) {
    const q = String(p).toLowerCase();
    h = (h <= q ? keccak256(concat([h as `0x${string}`, q as `0x${string}`])) : keccak256(concat([q as `0x${string}`, h as `0x${string}`]))).toLowerCase();
  }
  return h === String(root).toLowerCase();
}

/**
 * Claim deadline: 10 minutes after the CHAIN's clock, not the device's. The contract compares against
 * block.timestamp; a device clock that is slow by more than the window would make every claim revert
 * DeadlineExpired with no visible reason.
 */
export const CLAIM_DEADLINE_SECONDS = 600;
export function claimDeadline(chainTimestampSec: number | bigint | null | undefined, nowMs: number = Date.now()): bigint {
  const device = Math.floor(nowMs / 1000);
  const chain = chainTimestampSec === null || chainTimestampSec === undefined ? device : Number(chainTimestampSec);
  return BigInt(Math.max(device, chain) + CLAIM_DEADLINE_SECONDS);
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Turns whatever `simulateContract` / `eth_sendTransaction` threw into a named reason the user can
 * act on. Walks viem's error chain for the decoded custom error first, then RPC-level errors.
 */
export function explainClaimRevert(err: unknown, ctx: { epochs: ClaimEpochContext[]; pool: string; isV2: boolean; slippagePct?: number; assetSymbol?: string; chainSkewSec?: number | null }): ClaimRevertExplanation {
  const epochsLabel = ctx.epochs.map((e) => `#${e.epochNumber}`).join(', ');
  const poolLabel = `${ctx.isV2 ? 'LossRewardPoolV2' : 'LossRewardPool'} ${shortAddr(ctx.pool)}`;
  const base = err instanceof BaseError ? err : null;
  const reverted = base ? (base.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;

  if (reverted) {
    const name = reverted.data?.errorName;
    const args = ((reverted.data?.args as readonly unknown[] | undefined) ?? []).map((a) => String(a));
    switch (name) {
      case 'InvalidProof': {
        const detail = ctx.epochs.map((e) => `${'#' + e.epochNumber}: ${formatEther(e.amountWei)} ETH${e.onChainRoot ? `, on-chain root ${e.onChainRoot.slice(0, 10)}…` : ''}`).join('; ');
        return { code: name, message: `${poolLabel} rejected the Merkle proof (InvalidProof) for epoch ${epochsLabel} — the amount or proof this page holds does not match what was published on-chain (${detail}). The epoch was probably rebuilt and republished after this page loaded; the reward list has been refreshed, please try again.`, args };
      }
      case 'AlreadyClaimed':
        return { code: name, message: `Epoch ${epochsLabel} was already claimed by this wallet on ${poolLabel} (AlreadyClaimed).`, args };
      case 'EpochNotPublished':
        return { code: name, message: `Epoch ${epochsLabel} is not published on ${poolLabel} yet (EpochNotPublished). The worker publishes every 5 minutes; try again shortly.`, args };
      case 'DeadlineExpired': {
        const skew = ctx.chainSkewSec != null ? ` Your device clock is ${Math.abs(Math.round(ctx.chainSkewSec))}s ${ctx.chainSkewSec > 0 ? 'behind' : 'ahead of'} the chain.` : '';
        return { code: name, message: `The claim deadline was already in the past when the pool checked it (DeadlineExpired).${skew} Retry; if it repeats, correct the device clock.`, args };
      }
      case 'MinOutNotMet': {
        const out = args[0] ?? '?';
        const min = args[1] ?? '?';
        const sym = ctx.assetSymbol || 'the stock';
        return { code: name, message: `The ${sym} swap would return ${out} (raw units) but your minimum is ${min}${ctx.slippagePct != null ? ` (quote minus ${ctx.slippagePct}% slippage)` : ''} — MinOutNotMet. The pool price moved between the quote and the claim; raise the slippage setting or try again.`, args };
      }
      case 'UseClaimAs':
        return { code: name, message: `This epoch pays a stock and must be claimed with claimRewardAs/claimBatchAs (UseClaimAs) — the site sent a V1-style claim to ${poolLabel}. This is a site configuration problem, not a wallet problem.`, args };
      case 'EthTransferFailed':
        return { code: name, message: `${poolLabel} could not send ETH to this wallet (EthTransferFailed) — a contract wallet that rejects plain transfers?`, args };
      case 'ArrayLengthMismatch':
        return { code: name, message: `Malformed batch claim (ArrayLengthMismatch) — epochs, amounts and proofs differ in length. Site bug; refresh and retry.`, args };
      case 'ReentrancyGuardReentrantCall':
        return { code: name, message: `${poolLabel} rejected a re-entrant call (ReentrancyGuardReentrantCall).`, args };
      default: {
        if (name) return { code: name, message: `${poolLabel} reverted with ${name}(${args.join(', ')}) for epoch ${epochsLabel}.`, args };
        const sig = reverted.signature;
        if (sig) return { code: 'UnknownSelector', message: `${poolLabel} reverted with an unrecognised error selector ${sig} for epoch ${epochsLabel}.`, args, signature: sig };
        return { code: 'NoData', message: `${poolLabel} reverted without returning a reason for epoch ${epochsLabel} (empty revert data). This usually means the call reached an address without this function — check the configured pool address.`, args };
      }
    }
  }
  const rpc = base ? (base.walk((e) => e instanceof RpcRequestError || e instanceof HttpRequestError) as (RpcRequestError | HttpRequestError) | null) : null;
  if (rpc) {
    const code = (rpc as RpcRequestError).code;
    const detail = String((rpc as any).details || rpc.shortMessage || rpc.message || '').replace(/\.+$/, '');
    return { code: 'RpcError', message: `The RPC endpoint could not run the pre-flight simulation${code !== undefined ? ` (error ${code})` : ''}: ${detail}. Nothing was sent; retry in a moment.`, args: [] };
  }
  const msg = (err as any)?.shortMessage || (err as any)?.message || String(err);
  return { code: 'Unknown', message: `Claim pre-flight failed: ${msg}`, args: [] };
}
