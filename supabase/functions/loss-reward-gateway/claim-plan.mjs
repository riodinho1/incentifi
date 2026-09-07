/**
 * Pure planner for the (deprecated) relayer claim path: groups a wallet's claimable epoch rows by
 * the pool each epoch was published on and produces one contract call per pool.
 *
 *   V1 epochs (LossRewardPool)   -> claimReward / claimBatch        (the V1 ABI has no *As variants)
 *   V2 epochs (LossRewardPoolV2) -> claimRewardAs / claimBatchAs    (minAssetOut 0, deadline now+600;
 *                                   the pool enforces its own TWAP floor inside the swap)
 *
 * A row whose epoch has no pool_address (pre-migration) is a V1 epoch. A V2 row when no V2
 * address is configured is a hard error: the relayer must never guess a pool.
 *
 * Plain ESM with no dependencies so it is importable both by the Deno edge function
 * (`./claim-plan.mjs`) and by the node test suite.
 */
const ZERO_ROOT_POOL = null;

export function poolAddressForRow(row, { v1 }) {
  const fromEpoch = row?.reward_epochs?.pool_address ?? row?.pool_address ?? ZERO_ROOT_POOL;
  return String(fromEpoch || v1).toLowerCase();
}

export function planClaimTransactions(rows, { v1, v2, token, nowSec = Math.floor(Date.now() / 1000), deadlineSeconds = 600 }) {
  if (!v1) throw new Error('planClaimTransactions: v1 pool address is required');
  const v1Lower = String(v1).toLowerCase();
  const v2Lower = v2 ? String(v2).toLowerCase() : null;
  const groups = new Map();
  for (const row of rows) {
    const pool = poolAddressForRow(row, { v1: v1Lower });
    if (!groups.has(pool)) groups.set(pool, []);
    groups.get(pool).push(row);
  }

  const plans = [];
  for (const [pool, group] of groups) {
    const sorted = [...group].sort((a, b) => Number(a.epochNumber) - Number(b.epochNumber));
    const epochIds = sorted.map((r) => BigInt(r.epochNumber));
    const amounts = sorted.map((r) => BigInt(r.amountWei));
    const proofs = sorted.map((r) => r.merkle_proof ?? r.merkleProof ?? []);
    const isV2 = v2Lower !== null && pool === v2Lower;
    if (!isV2 && pool !== v1Lower) {
      throw new Error(`planClaimTransactions: epoch pool ${pool} is neither the configured V1 (${v1Lower}) nor V2 (${v2Lower ?? 'unset'})`);
    }
    if (isV2) {
      const deadline = BigInt(nowSec + deadlineSeconds);
      plans.push(
        sorted.length === 1
          ? { pool, version: 'v2', functionName: 'claimRewardAs', args: [token, epochIds[0], amounts[0], proofs[0], 0n, deadline], rowIds: sorted.map((r) => r.id), epochNumbers: sorted.map((r) => Number(r.epochNumber)) }
          : { pool, version: 'v2', functionName: 'claimBatchAs', args: [token, epochIds, amounts, proofs, 0n, deadline], rowIds: sorted.map((r) => r.id), epochNumbers: sorted.map((r) => Number(r.epochNumber)) }
      );
    } else {
      plans.push(
        sorted.length === 1
          ? { pool, version: 'v1', functionName: 'claimReward', args: [token, epochIds[0], amounts[0], proofs[0]], rowIds: sorted.map((r) => r.id), epochNumbers: sorted.map((r) => Number(r.epochNumber)) }
          : { pool, version: 'v1', functionName: 'claimBatch', args: [token, epochIds, amounts, proofs], rowIds: sorted.map((r) => r.id), epochNumbers: sorted.map((r) => Number(r.epochNumber)) }
      );
    }
  }
  // V1 first, then V2 — deterministic order for logs and tests.
  plans.sort((a, b) => (a.version === b.version ? 0 : a.version === 'v1' ? -1 : 1));
  return plans;
}
