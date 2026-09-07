/**
 * GATEWAY RELAYER CLAIM PLAN — supabase/functions/loss-reward-gateway/claim-plan.mjs.
 * The (deprecated) relayer path must choose per epoch: V1 epochs -> claimReward/claimBatch on the
 * V1 pool (its ABI has no *As variants), V2 epochs -> claimRewardAs/claimBatchAs on V2. Rows with
 * no pool_address (pre-migration) are V1. A V2 row with no V2 address configured is an error.
 *
 * Run: node test/gateway-claim-plan.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import { planClaimTransactions, poolAddressForRow } from '../supabase/functions/loss-reward-gateway/claim-plan.mjs';

const V1 = '0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf';
const V2 = '0x00000000000000000000000000000000000000b2';
const TOKEN = '0x00000000000000000000000000000000000000AA';
const row = (id, epochNumber, amountWei, pool) => ({ id, epochNumber, amountWei, merkle_proof: [`0x${String(id).padStart(64, '0')}`], reward_epochs: { epoch_number: epochNumber, status: 'published', pool_address: pool } });
const NOW = 1_788_800_000;

// poolAddressForRow: explicit pool, null -> V1, missing join -> V1, case-normalised
assert.equal(poolAddressForRow(row(1, 1, '1', V2), { v1: V1 }), V2);
assert.equal(poolAddressForRow(row(1, 1, '1', null), { v1: V1 }), V1);
assert.equal(poolAddressForRow({ id: 1 }, { v1: V1 }), V1);
assert.equal(poolAddressForRow(row(1, 1, '1', V1.toUpperCase().replace('0X', '0x')), { v1: V1 }), V1);

// V1 only, single epoch -> claimReward on V1
{
  const plans = planClaimTransactions([row(1, 7, '1000', null)], { v1: V1, v2: V2, token: TOKEN, nowSec: NOW });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].pool, V1);
  assert.equal(plans[0].version, 'v1');
  assert.equal(plans[0].functionName, 'claimReward');
  assert.deepEqual(plans[0].args, [TOKEN, 7n, 1000n, [`0x${'1'.padStart(64, '0')}`]]);
  assert.deepEqual(plans[0].rowIds, [1]);
}

// V1 only, several epochs -> one claimBatch on V1, epochs sorted
{
  const plans = planClaimTransactions([row(2, 9, '20', V1), row(1, 8, '10', null)], { v1: V1, v2: null, token: TOKEN, nowSec: NOW });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].functionName, 'claimBatch');
  assert.deepEqual(plans[0].args[1], [8n, 9n]);
  assert.deepEqual(plans[0].args[2], [10n, 20n]);
  assert.equal(plans[0].args.length, 4, 'V1 signature carries no minAssetOut/deadline');
}

// V2 only -> claimBatchAs on V2 with minAssetOut 0 and deadline now+600
{
  const plans = planClaimTransactions([row(3, 11, '5', V2), row(4, 12, '6', V2)], { v1: V1, v2: V2, token: TOKEN, nowSec: NOW });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].pool, V2);
  assert.equal(plans[0].version, 'v2');
  assert.equal(plans[0].functionName, 'claimBatchAs');
  assert.deepEqual(plans[0].args[1], [11n, 12n]);
  assert.equal(plans[0].args[4], 0n);
  assert.equal(plans[0].args[5], BigInt(NOW + 600));
}

// mixed -> two transactions, V1 first then V2; single V2 epoch -> claimRewardAs
{
  const plans = planClaimTransactions([row(5, 13, '5', V2), row(1, 7, '1', null), row(2, 8, '2', V1)], { v1: V1, v2: V2, token: TOKEN, nowSec: NOW });
  assert.equal(plans.length, 2);
  assert.equal(plans[0].version, 'v1');
  assert.equal(plans[0].functionName, 'claimBatch');
  assert.deepEqual(plans[0].epochNumbers, [7, 8]);
  assert.equal(plans[1].version, 'v2');
  assert.equal(plans[1].functionName, 'claimRewardAs');
  assert.deepEqual(plans[1].args.slice(0, 3), [TOKEN, 13n, 5n]);
  assert.deepEqual(plans[1].rowIds, [5]);
}

// V2 row while V2 is not configured -> refuse, never guess
assert.throws(() => planClaimTransactions([row(6, 14, '1', V2)], { v1: V1, v2: null, token: TOKEN, nowSec: NOW }), /neither the configured V1/);
// unknown pool -> refuse
assert.throws(() => planClaimTransactions([row(7, 15, '1', '0x00000000000000000000000000000000000000c3')], { v1: V1, v2: V2, token: TOKEN, nowSec: NOW }), /neither the configured V1/);

console.log('gateway-claim-plan tests passed');
