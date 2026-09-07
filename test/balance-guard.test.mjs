/**
 * BALANCE GUARD TEST — scripts/loss-reward-worker.mjs applyOnChainBalanceCap()
 *
 * Pure-function coverage of the on-chain balance cap the worker now applies to every eligible
 * holder before computing a payout (the fork counterpart, test/hardhat/phantom-balance-fork.test.ts,
 * drives the real executeEpochForToken() end-to-end). The property that matters most: `invested`
 * is scaled by the same ratio as `balance`, so the recorded average cost basis is preserved and a
 * phantom (fully-sold) position pays exactly zero rather than 10% of everything ever invested.
 *
 * Run: node test/balance-guard.test.mjs   (offline; part of `npm test`)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

console.log('======================================================');
console.log('  BALANCE GUARD TEST (applyOnChainBalanceCap)');
console.log('======================================================\n');

// The worker creates its Supabase client at import; give it inert values if .env.local is absent.
process.env.VITE_SUPABASE_URL ||= 'https://balance-guard-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'balance-guard-test-key';
const { applyOnChainBalanceCap } = await import('../scripts/loss-reward-worker.mjs');
void fs;

const holder = { wallet_address: '0xba69ca72cd2b87113471c4c38f08928761edb5ce', token_balance: 18744983.522532888, total_invested_eth: 0.04, avg_cost_basis_eth: 0.04 / 18744983.522532888 };
const basis = (r) => (r.balance > 0 ? r.invested / r.balance : 0);

console.log('Testing [1/5] On-chain equals DB: no cap...');
{
  const r = applyOnChainBalanceCap(holder, holder.token_balance);
  assert.equal(r.capped, false); assert.equal(r.balance, holder.token_balance); assert.equal(r.invested, 0.04);
  console.log('  ✓ unchanged\n');
}
console.log('Testing [2/5] On-chain HIGHER than DB (indexer behind on a buy): pays on DB figures, never more...');
{
  const r = applyOnChainBalanceCap(holder, holder.token_balance * 2);
  assert.equal(r.capped, false); assert.equal(r.balance, holder.token_balance); assert.equal(r.invested, 0.04);
  console.log('  ✓ DB balance kept (a missed BUY can only under-pay, never over-pay)\n');
}
console.log('Testing [3/5] THE 2026-09-07 CASE — on-chain ZERO, DB says 18.7M: phantom position pays nothing...');
{
  const r = applyOnChainBalanceCap(holder, 0);
  assert.equal(r.capped, true); assert.equal(r.balance, 0); assert.equal(r.invested, 0, 'invested MUST scale to 0 too, or the loss formula (invested - balance*price) would pay 10% of 0.04 ETH');
  console.log(`  ✓ balance=0 invested=0 → theoretical reward 0 (uncapped code would have paid ${(0.1 * 0.04).toFixed(4)} ETH per epoch)\n`);
}
console.log('Testing [4/5] Partial sell not yet indexed (on-chain = half): pays on half, basis preserved...');
{
  const r = applyOnChainBalanceCap(holder, holder.token_balance / 2);
  assert.equal(r.capped, true);
  assert.ok(Math.abs(r.balance - holder.token_balance / 2) < 1e-6);
  assert.ok(Math.abs(r.invested - 0.02) < 1e-12, `invested must halve (got ${r.invested})`);
  assert.ok(Math.abs(basis(r) - holder.avg_cost_basis_eth) / holder.avg_cost_basis_eth < 1e-9, 'average cost basis must be unchanged by the cap');
  console.log(`  ✓ balance halved, invested halved, basis ${basis(r).toExponential(6)} == ${holder.avg_cost_basis_eth.toExponential(6)}\n`);
}
console.log('Testing [5/5] Garbage on-chain value is rejected (fail closed)...');
{
  assert.throws(() => applyOnChainBalanceCap(holder, NaN), /BALANCE GUARD/);
  assert.throws(() => applyOnChainBalanceCap(holder, -1), /BALANCE GUARD/);
  console.log('  ✓ NaN / negative throw\n');
}
console.log('======================================================');
console.log('  ALL 5/5 BALANCE GUARD TESTS PASSED');
console.log('======================================================');
process.exit(0);
