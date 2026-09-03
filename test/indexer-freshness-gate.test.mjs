import assert from 'node:assert/strict';

console.log('======================================================');
console.log('  INDEXER FRESHNESS GATE TEST');
console.log('======================================================\n');
console.log('Verifies the fix to scripts/loss-reward-worker.mjs: a loss-reward');
console.log('snapshot must refuse to run against holder_cost_basis data fed by a');
console.log('stale or missing scripts/evm-indexer.mjs heartbeat, rather than');
console.log('silently computing rewards off outdated balances.\n');
console.log('(Mirrors checkIndexerFreshness()/the gate in executeEpochForToken() as');
console.log('pure logic against an injected heartbeat, the same way the rest of this');
console.log('suite tests scripts/loss-reward-worker.mjs without a live Supabase —');
console.log('see test/worker-hardening.test.mjs for the established pattern.)\n');

const INDEXER_FRESHNESS_THRESHOLD_SECONDS = 120; // must match scripts/loss-reward-worker.mjs

/** Mirrors checkIndexerFreshness()'s decision logic exactly. */
function evaluateFreshness(heartbeat, { thresholdSeconds = INDEXER_FRESHNESS_THRESHOLD_SECONDS, nowMs = Date.now() } = {}) {
  if (!heartbeat) {
    return {
      fresh: false,
      reason: 'No heartbeat found for indexer worker "evm-indexer" — indexer may never have run.',
      ageSeconds: null,
    };
  }

  const updatedAtMs = Date.parse(heartbeat.updated_at);
  if (!Number.isFinite(updatedAtMs)) {
    return { fresh: false, reason: `Indexer heartbeat has an unparsable updated_at: ${heartbeat.updated_at}`, ageSeconds: null };
  }

  const ageSeconds = (nowMs - updatedAtMs) / 1000;
  if (ageSeconds > thresholdSeconds) {
    return {
      fresh: false,
      reason: `Indexer heartbeat is stale: last updated ${ageSeconds.toFixed(1)}s ago, threshold is ${thresholdSeconds}s (status="${heartbeat.status}", message="${heartbeat.message}").`,
      ageSeconds,
    };
  }

  if (heartbeat.status === 'error') {
    return {
      fresh: false,
      reason: `Indexer heartbeat is fresh (${ageSeconds.toFixed(1)}s ago) but reports status="error": ${heartbeat.message}`,
      ageSeconds,
    };
  }

  return { fresh: true, reason: null, ageSeconds };
}

/** Mirrors the gate inside executeEpochForToken(): step 3b, before querying holder_cost_basis. */
function runSnapshotGate(heartbeat, options) {
  const freshness = evaluateFreshness(heartbeat, options);
  if (!freshness.fresh) {
    return { skipped: true, reason: 'indexer_stale', detail: freshness.reason, ageSeconds: freshness.ageSeconds };
  }
  return { skipped: false, ageSeconds: freshness.ageSeconds };
}

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

// ----------------------------------------------------------------------------
// Test 1: fresh heartbeat -> snapshot proceeds
// ----------------------------------------------------------------------------
console.log('Testing [1/5] Fresh heartbeat (updated 5s ago, status=ok) allows the snapshot...');
{
  const heartbeat = { status: 'ok', message: 'Indexed through block 12345', updated_at: new Date(NOW - 5_000).toISOString() };
  const result = runSnapshotGate(heartbeat, { nowMs: NOW });
  assert.equal(result.skipped, false);
  console.log(`  ✓ Not skipped (age=${result.ageSeconds.toFixed(1)}s, threshold=${INDEXER_FRESHNESS_THRESHOLD_SECONDS}s)\n`);
}

// ----------------------------------------------------------------------------
// Test 2: stale heartbeat -> snapshot correctly blocked
// ----------------------------------------------------------------------------
console.log('Testing [2/5] Stale heartbeat (updated 10 minutes ago) blocks the snapshot...');
{
  const heartbeat = { status: 'ok', message: 'Indexed through block 12000', updated_at: new Date(NOW - 10 * 60_000).toISOString() };
  const result = runSnapshotGate(heartbeat, { nowMs: NOW });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'indexer_stale');
  assert.ok(result.ageSeconds > INDEXER_FRESHNESS_THRESHOLD_SECONDS);
  console.log(`  ✓ Snapshot skipped with reason="indexer_stale" (age=${result.ageSeconds.toFixed(1)}s exceeds ${INDEXER_FRESHNESS_THRESHOLD_SECONDS}s threshold)`);
  console.log(`  ✓ Detail: ${result.detail}\n`);
}

// ----------------------------------------------------------------------------
// Test 3: missing heartbeat entirely -> snapshot correctly blocked
// ----------------------------------------------------------------------------
console.log('Testing [3/5] Missing heartbeat (indexer never ran) blocks the snapshot...');
{
  const result = runSnapshotGate(null, { nowMs: NOW });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'indexer_stale');
  assert.equal(result.ageSeconds, null);
  console.log(`  ✓ Snapshot skipped — missing heartbeat is treated the same as stale, not silently allowed`);
  console.log(`  ✓ Detail: ${result.detail}\n`);
}

// ----------------------------------------------------------------------------
// Test 4: recently-updated but status="error" -> snapshot correctly blocked
// ----------------------------------------------------------------------------
console.log('Testing [4/5] Recent heartbeat reporting status="error" blocks the snapshot...');
{
  const heartbeat = { status: 'error', message: 'RPC timeout on block range', updated_at: new Date(NOW - 5_000).toISOString() };
  const result = runSnapshotGate(heartbeat, { nowMs: NOW });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'indexer_stale');
  console.log(`  ✓ Snapshot skipped despite a recent timestamp — a fresh timestamp with an error status is not "fresh"`);
  console.log(`  ✓ Detail: ${result.detail}\n`);
}

// ----------------------------------------------------------------------------
// Test 5: exact threshold boundary
// ----------------------------------------------------------------------------
console.log('Testing [5/5] Threshold boundary (just under vs. just over)...');
{
  const justUnder = { status: 'ok', message: '', updated_at: new Date(NOW - (INDEXER_FRESHNESS_THRESHOLD_SECONDS - 1) * 1000).toISOString() };
  const justOver = { status: 'ok', message: '', updated_at: new Date(NOW - (INDEXER_FRESHNESS_THRESHOLD_SECONDS + 1) * 1000).toISOString() };

  const underResult = runSnapshotGate(justUnder, { nowMs: NOW });
  const overResult = runSnapshotGate(justOver, { nowMs: NOW });

  assert.equal(underResult.skipped, false, `${INDEXER_FRESHNESS_THRESHOLD_SECONDS - 1}s old must still be fresh`);
  assert.equal(overResult.skipped, true, `${INDEXER_FRESHNESS_THRESHOLD_SECONDS + 1}s old must be stale`);
  console.log(`  ✓ ${INDEXER_FRESHNESS_THRESHOLD_SECONDS - 1}s old: allowed`);
  console.log(`  ✓ ${INDEXER_FRESHNESS_THRESHOLD_SECONDS + 1}s old: blocked\n`);
}

console.log('======================================================');
console.log('  ALL 5/5 INDEXER FRESHNESS GATE TESTS PASSED!');
console.log('======================================================');
