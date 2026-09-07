// LossRewardPoolV2 fallback monitor: the RewardPaidInEthFallback event is the ONLY signal of an
// adapter/route/asset failure (no transaction fails; users just get ETH). These tests pin down
// (1) the pure summariser and (2) the poller's alerting and cursor behaviour with an injected
// client and alert sink — no RPC, no Supabase.
import assert from 'node:assert/strict';
import {
  summarizeFallbackEvents,
  monitorFallbackEvents,
  FALLBACK_REASONS,
  EXPECTED_FALLBACK_REASONS,
  FALLBACK_LOOKBACK_BLOCKS,
} from '../scripts/loss-reward-worker.mjs';

const V2 = '0x00000000000000000000000000000000000000A2';
const log = (reason, token = '0xToKeN', claimant = '0xC1') => ({ args: { reason, token, claimant } });

// --- 1. summariser -------------------------------------------------------------------------
{
  const s = summarizeFallbackEvents([]);
  assert.equal(s.total, 0);
  assert.equal(s.alertable, 0);
  assert.deepEqual(s.byReason, {});
}
{
  const idx = (name) => FALLBACK_REASONS.indexOf(name);
  const s = summarizeFallbackEvents([
    log(idx('BelowMinimum'), '0xAAA', '0xC1'),
    log(idx('ForcedEth'), '0xAAA', '0xC2'),
    log(idx('SwapFailed'), '0xBBB', '0xC1'),
    log(idx('BelowProtocolBound'), '0xBBB', '0xC3'),
    log(99, '0xBBB', '0xC3'),
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.byReason.BelowMinimum, 1);
  assert.equal(s.byReason.ForcedEth, 1);
  assert.equal(s.byReason.SwapFailed, 1);
  assert.equal(s.byReason.BelowProtocolBound, 1);
  assert.equal(s.byReason['Unknown(99)'], 1);
  assert.equal(s.alertable, 3, 'ForcedEth and BelowMinimum are expected; everything else alerts');
  assert.deepEqual(s.tokens.sort(), ['0xaaa', '0xbbb']);
  assert.equal(s.claimants, 3);
  assert.ok(EXPECTED_FALLBACK_REASONS.has('ForcedEth') && EXPECTED_FALLBACK_REASONS.has('BelowMinimum'));
  assert.equal(FALLBACK_REASONS.length, 10, 'must match the Solidity enum order');
}

// --- 2. poller: no address -> no-op ---------------------------------------------------------
{
  const r = await monitorFallbackEvents({ address: '' });
  assert.equal(r.skipped, true);
}

// --- 3. poller: alerts only on unexpected reasons, advances the cursor, never throws ----------
{
  const calls = [];
  const alerts = [];
  const client = {
    getBlockNumber: async () => 10_000n,
    getLogs: async (q) => {
      calls.push(q);
      return [log(FALLBACK_REASONS.indexOf('BelowMinimum')), log(FALLBACK_REASONS.indexOf('SwapFailed'), '0xDeAd')];
    },
  };
  const alert = async (m) => alerts.push(m);

  const r1 = await monitorFallbackEvents({ address: V2, client, alert });
  assert.equal(r1.total, 2);
  assert.equal(r1.alertable, 1);
  assert.equal(calls[0].fromBlock, 10_000n - FALLBACK_LOOKBACK_BLOCKS, 'first run looks back one cadence');
  assert.equal(calls[0].toBlock, 10_000n);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /UNEXPECTED/);
  assert.match(alerts[0], /SwapFailed=1/);
  assert.match(alerts[0], /0xdead/);

  // expected-only batch: logged, not alerted; cursor continues from the previous head + 1
  client.getLogs = async (q) => { calls.push(q); return [log(FALLBACK_REASONS.indexOf('ForcedEth'))]; };
  client.getBlockNumber = async () => 10_500n;
  const r2 = await monitorFallbackEvents({ address: V2, client, alert });
  assert.equal(r2.total, 1);
  assert.equal(r2.alertable, 0);
  assert.equal(alerts.length, 1, 'no new alert for an expected reason');
  assert.equal(calls[1].fromBlock, 10_001n, 'cursor resumes right after the last head');
  assert.equal(calls[1].toBlock, 10_500n);

  // RPC failure: swallowed, reported, cursor untouched
  client.getLogs = async () => { throw new Error('rpc down'); };
  client.getBlockNumber = async () => 11_000n;
  const r3 = await monitorFallbackEvents({ address: V2, client, alert });
  assert.equal(r3.skipped, true);
  assert.equal(r3.reason, 'error');
  client.getLogs = async (q) => { calls.push(q); return []; };
  const r4 = await monitorFallbackEvents({ address: V2, client, alert });
  assert.equal(r4.total, 0);
  assert.equal(calls[2].fromBlock, 10_501n, 'a failed poll does not move the cursor');
}

console.log('fallback-monitor tests passed');
