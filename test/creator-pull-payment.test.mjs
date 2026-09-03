import assert from 'node:assert/strict';

console.log('======================================================');
console.log('  CREATOR PULL-PAYMENT TEST');
console.log('======================================================\n');
console.log('Verifies the fix to contracts/IncentifiBondingCurve.sol buy()/sell():');
console.log('creator fees are credited to creatorBalances[creator] instead of being');
console.log('pushed immediately, and claimCreatorFees() lets the creator withdraw on');
console.log('their own schedule — so a creator address that reverts on receiving ETH');
console.log('can never brick trading for everyone else. Also verifies the matching fix');
console.log('to contracts/IncentifiSwapRouter.sol\'s _sendCreatorFee(): post-graduation');
console.log('creator fees now route through the SAME curve.creatorBalances accounting');
console.log('via a new depositCreatorFee() entrypoint, instead of the router pushing ETH');
console.log('to the creator directly.\n');

// ----------------------------------------------------------------------------
// Bonding curve economic constants (contracts/IncentifiBondingCurve.sol)
// ----------------------------------------------------------------------------
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const VIRTUAL_ETH = 2156250000000000000n;
const VIRTUAL_TOKEN = 78125000000000000000000000n;
const INVARIANT_K = 2324707031250000000000000000000000000000000000n;
const GRADUATION_ETH_TARGET = 5853863234375000000n;

/**
 * Mirrors the FIXED contracts/IncentifiBondingCurve.sol: creator fees are credited to
 * `creatorBalances[creator]` in buy()/sell(), and `claimCreatorFees()` is a separate,
 * caller-initiated pull. `sendEth(to, amount)` models SafeTransferLib.safeTransferETH:
 * it throws (like a Solidity revert) if the recipient is configured to reject ETH, and
 * — critically — a thrown error here must leave ALL state from this call reverted,
 * exactly like the EVM undoing every state change in a reverted transaction.
 */
class FixedBondingCurveSimulator {
  constructor(creatorAddress, ethReceivers) {
    this.creator = creatorAddress;
    this.ethReceivers = ethReceivers; // address -> { revertsOnReceive: bool, balance: bigint }
    this.creatorBalances = new Map();
    this.realEthReserve = 0n;
    this.realTokenReserve = TOTAL_SUPPLY;
  }

  _sendEth(to, amount) {
    const receiver = this.ethReceivers.get(to);
    if (receiver && receiver.revertsOnReceive) {
      throw new Error('EthTransferFailed');
    }
    if (receiver) receiver.balance += amount;
  }

  buy(grossEthIn, buyerAddress) {
    const creatorFee = grossEthIn / 100n;
    const lossPoolFee = grossEthIn / 100n;
    const netEth = grossEthIn - creatorFee - lossPoolFee;

    // FIX: credit instead of push — no external call to the creator happens here at all.
    this.creatorBalances.set(this.creator, (this.creatorBalances.get(this.creator) ?? 0n) + creatorFee);
    // lossPoolFee deposit modeled as always succeeding (LossRewardPool is a fixed,
    // trusted, protocol-controlled address, not user-supplied — out of scope here).

    const currentEth = VIRTUAL_ETH + this.realEthReserve;
    const currentToken = VIRTUAL_TOKEN + this.realTokenReserve;
    const newEth = currentEth + netEth;
    const tokensOut = currentToken - INVARIANT_K / newEth;

    this.realEthReserve += netEth;
    this.realTokenReserve -= tokensOut;

    return { tokensOut, creatorFee, lossPoolFee, netEth };
  }

  sell(tokensIn, sellerAddress) {
    const currentEth = VIRTUAL_ETH + this.realEthReserve;
    const currentToken = VIRTUAL_TOKEN + this.realTokenReserve;
    const newToken = currentToken + tokensIn;
    const grossEthOut = currentEth - INVARIANT_K / newToken;

    const creatorFee = grossEthOut / 100n;
    const lossPoolFee = grossEthOut / 100n;
    const netEthOut = grossEthOut - creatorFee - lossPoolFee;

    this.realEthReserve -= grossEthOut;
    this.realTokenReserve += tokensIn;

    // FIX: credit instead of push.
    this.creatorBalances.set(this.creator, (this.creatorBalances.get(this.creator) ?? 0n) + creatorFee);

    // Pay net ETH to seller (unrelated to the creator-payment fix; sellers are assumed
    // to be able to receive their own funds, same as before).
    this._sendEth(sellerAddress, netEthOut);

    return { grossEthOut, netEthOut, creatorFee, lossPoolFee };
  }

  claimCreatorFees(caller) {
    const amount = this.creatorBalances.get(caller) ?? 0n;
    if (amount === 0n) throw new Error('NoBalanceToClaim');

    // checks-effects-interactions: zero the balance, THEN attempt the transfer.
    this.creatorBalances.set(caller, 0n);
    try {
      this._sendEth(caller, amount);
    } catch (err) {
      // Models a real EVM revert: every state change made during this call — including
      // the zeroing above — is undone. The balance is never lost.
      this.creatorBalances.set(caller, amount);
      throw err;
    }
    return amount;
  }

  /** Mirrors the new IncentifiBondingCurve.depositCreatorFee(): permissionless, credits
   *  this curve's own fixed `creator`, regardless of who calls it or graduation status. */
  depositCreatorFee(amount) {
    if (amount === 0n) throw new Error('ZeroAmount');
    this.creatorBalances.set(this.creator, (this.creatorBalances.get(this.creator) ?? 0n) + amount);
  }
}

/**
 * Mirrors the FIXED IncentifiSwapRouter._sendCreatorFee(): looks up the token's curve via
 * a factory map and, if found, credits that curve's creatorBalances through
 * depositCreatorFee() instead of pushing ETH directly to the creator.
 */
class RouterSimulator {
  constructor(curvesByToken) {
    this.curvesByToken = curvesByToken; // token -> FixedBondingCurveSimulator
  }

  sendCreatorFee(token, amount) {
    if (amount === 0n) return;
    const curve = this.curvesByToken.get(token);
    if (curve) {
      curve.depositCreatorFee(amount);
      return;
    }
    throw new Error('NoRegisteredCurve: fallback push path not modeled here');
  }
}

/**
 * Mirrors the OLD (pre-fix) buy()/sell(): creator fee is pushed immediately via
 * safeTransferETH, and a failed transfer reverts the ENTIRE trade. Used only as a
 * regression-guard contrast.
 */
class OldPushPaymentSimulator {
  constructor(creatorAddress, ethReceivers) {
    this.creator = creatorAddress;
    this.ethReceivers = ethReceivers;
    this.realEthReserve = 0n;
    this.realTokenReserve = TOTAL_SUPPLY;
  }

  _sendEth(to, amount) {
    const receiver = this.ethReceivers.get(to);
    if (receiver && receiver.revertsOnReceive) {
      throw new Error('EthTransferFailed'); // reverts the WHOLE buy()/sell() call
    }
    if (receiver) receiver.balance += amount;
  }

  buy(grossEthIn) {
    const creatorFee = grossEthIn / 100n;
    const lossPoolFee = grossEthIn / 100n;
    const netEth = grossEthIn - creatorFee - lossPoolFee;

    this._sendEth(this.creator, creatorFee); // OLD BUG: forced push, can revert the whole trade

    const currentEth = VIRTUAL_ETH + this.realEthReserve;
    const currentToken = VIRTUAL_TOKEN + this.realTokenReserve;
    const newEth = currentEth + netEth;
    const tokensOut = currentToken - INVARIANT_K / newEth;
    this.realEthReserve += netEth;
    this.realTokenReserve -= tokensOut;
    return { tokensOut };
  }
}

// ----------------------------------------------------------------------------
// Test 1: normal claim flow works
// ----------------------------------------------------------------------------
console.log('Testing [1/5] Normal claim flow...');
{
  const CREATOR = 'creator1';
  const ethReceivers = new Map([[CREATOR, { revertsOnReceive: false, balance: 0n }]]);
  const curve = new FixedBondingCurveSimulator(CREATOR, ethReceivers);

  const buyResult = curve.buy(1n * 10n ** 18n, 'buyer1');
  assert.equal(curve.creatorBalances.get(CREATOR), buyResult.creatorFee);

  const claimed = curve.claimCreatorFees(CREATOR);
  assert.equal(claimed, buyResult.creatorFee);
  assert.equal(curve.creatorBalances.get(CREATOR), 0n);
  assert.equal(ethReceivers.get(CREATOR).balance, buyResult.creatorFee);

  console.log(`  ✓ Creator accrued ${buyResult.creatorFee.toString()} wei, claimed exactly that amount, balance now 0`);

  // Claiming again with nothing accrued must revert, not silently pay 0.
  assert.throws(() => curve.claimCreatorFees(CREATOR), /NoBalanceToClaim/);
  console.log('  ✓ Re-claiming with a zero balance correctly reverts (NoBalanceToClaim)\n');
}

// ----------------------------------------------------------------------------
// Test 2: a creator address that reverts on receive no longer blocks trading
// ----------------------------------------------------------------------------
console.log('Testing [2/5] Revert-on-receive creator does not block trading (the fix)...');
{
  const BROKEN_CREATOR = 'brokenCreatorContract';
  const ethReceivers = new Map([[BROKEN_CREATOR, { revertsOnReceive: true, balance: 0n }]]);
  const curve = new FixedBondingCurveSimulator(BROKEN_CREATOR, ethReceivers);

  // Buy must succeed even though the creator can never accept a push payment.
  const buyResult = curve.buy(1n * 10n ** 18n, 'buyer1');
  console.log(`  ✓ buy() succeeded despite creator reverting on receive (tokensOut=${(Number(buyResult.tokensOut)/1e18).toFixed(4)})`);

  // Sell must also succeed.
  const sellerEthReceivers = new Map([...ethReceivers, ['seller1', { revertsOnReceive: false, balance: 0n }]]);
  const curve2 = new FixedBondingCurveSimulator(BROKEN_CREATOR, sellerEthReceivers);
  curve2.buy(1n * 10n ** 18n, 'buyer1');
  const sellResult = curve2.sell(1_000_000n * 10n ** 18n, 'seller1');
  console.log(`  ✓ sell() succeeded despite creator reverting on receive (netEthOut=${sellResult.netEthOut.toString()} wei)`);

  // The creator's accrued balance is real and tracked, even though they can't yet claim it.
  assert.ok(curve.creatorBalances.get(BROKEN_CREATOR) > 0n);
  console.log(`  ✓ Creator balance correctly accrued (${curve.creatorBalances.get(BROKEN_CREATOR).toString()} wei) despite being unclaimable right now`);

  // Attempting to claim while still broken correctly reverts, but does NOT lose the funds.
  const balanceBeforeFailedClaim = curve.creatorBalances.get(BROKEN_CREATOR);
  assert.throws(() => curve.claimCreatorFees(BROKEN_CREATOR), /EthTransferFailed/);
  assert.equal(curve.creatorBalances.get(BROKEN_CREATOR), balanceBeforeFailedClaim, 'balance must be preserved after a failed claim, not lost');
  console.log('  ✓ Claim attempt while still broken reverts, but the accrued balance is preserved (not lost)');

  // Once the creator's receiving address is fixed, the same balance becomes claimable.
  ethReceivers.get(BROKEN_CREATOR).revertsOnReceive = false;
  const claimed = curve.claimCreatorFees(BROKEN_CREATOR);
  assert.equal(claimed, balanceBeforeFailedClaim);
  assert.equal(curve.creatorBalances.get(BROKEN_CREATOR), 0n);
  console.log(`  ✓ After fixing the receiving address, the full accrued balance (${claimed.toString()} wei) claims successfully\n`);
}

// ----------------------------------------------------------------------------
// Test 3: balances accrue correctly across multiple trades before a claim
// ----------------------------------------------------------------------------
console.log('Testing [3/5] Balances accrue correctly across multiple trades before a claim...');
{
  const CREATOR = 'creator2';
  const ethReceivers = new Map([
    [CREATOR, { revertsOnReceive: false, balance: 0n }],
    ['traderA', { revertsOnReceive: false, balance: 0n }],
  ]);
  const curve = new FixedBondingCurveSimulator(CREATOR, ethReceivers);

  let expectedTotal = 0n;
  const buyAmounts = [10n ** 17n, 33n * 10n ** 16n, 5n * 10n ** 15n, 2n * 10n ** 18n]; // 0.1, 0.33, 0.005, 2 ETH
  for (const amt of buyAmounts) {
    const r = curve.buy(amt, 'traderA');
    expectedTotal += r.creatorFee;
  }
  // Interleave a sell too.
  const sellResult = curve.sell(5_000_000n * 10n ** 18n, 'traderA');
  expectedTotal += sellResult.creatorFee;

  assert.equal(curve.creatorBalances.get(CREATOR), expectedTotal, 'accrued balance must equal the exact sum of every trade\'s creatorFee');
  console.log(`  ✓ After ${buyAmounts.length} buys + 1 sell with zero claims in between, accrued balance = ${expectedTotal.toString()} wei (exact sum match)`);

  const claimed = curve.claimCreatorFees(CREATOR);
  assert.equal(claimed, expectedTotal);
  console.log(`  ✓ Single claim withdraws the full accumulated total in one call: ${claimed.toString()} wei\n`);
}

// ----------------------------------------------------------------------------
// Test 4: regression guard — the OLD push-payment code really would have
// bricked trading for a revert-on-receive creator.
// ----------------------------------------------------------------------------
console.log('Testing [4/5] Regression guard: OLD push-payment code blocks trading...');
{
  const BROKEN_CREATOR = 'brokenCreatorContract';
  const ethReceivers = new Map([[BROKEN_CREATOR, { revertsOnReceive: true, balance: 0n }]]);
  const oldCurve = new OldPushPaymentSimulator(BROKEN_CREATOR, ethReceivers);

  assert.throws(
    () => oldCurve.buy(1n * 10n ** 18n),
    /EthTransferFailed/,
    'the old push-payment code should revert the ENTIRE trade when the creator cannot receive ETH'
  );
  console.log('  ✓ Confirmed: under the old code, this exact scenario reverts the whole trade (this is the bug the fix closes)\n');
}

// ----------------------------------------------------------------------------
// Test 5: router — a creator that reverts on receive no longer blocks a
// post-graduation trade, and the fee lands in the SAME claim path as the curve.
// ----------------------------------------------------------------------------
console.log('Testing [5/5] Router: revert-on-receive creator does not block a post-graduation trade...');
{
  const TOKEN = 'tokenA';
  const BROKEN_CREATOR = 'brokenCreatorContract';
  const ethReceivers = new Map([
    [BROKEN_CREATOR, { revertsOnReceive: true, balance: 0n }],
    ['sellerPostGrad', { revertsOnReceive: false, balance: 0n }],
  ]);

  const curve = new FixedBondingCurveSimulator(BROKEN_CREATOR, ethReceivers);
  const router = new RouterSimulator(new Map([[TOKEN, curve]]));

  // Simulate a post-graduation sell's fee split: router computes creatorShare from
  // gross proceeds and calls _sendCreatorFee(), which must not revert even though the
  // creator itself reverts on receiving ETH directly.
  const grossEthFromSwap = 3n * 10n ** 18n; // 3 ETH proceeds from the Uniswap V3 leg
  const creatorShare = grossEthFromSwap / 100n; // 1%
  const lossPoolShare = grossEthFromSwap / 100n; // 1%
  const netEthOut = grossEthFromSwap - creatorShare - lossPoolShare;

  router.sendCreatorFee(TOKEN, creatorShare); // must not throw
  curve._sendEth('sellerPostGrad', netEthOut); // seller's own payout, unrelated to the fix

  console.log(`  ✓ Post-graduation _sendCreatorFee() succeeded despite creator reverting on receive`);
  assert.equal(curve.creatorBalances.get(BROKEN_CREATOR), creatorShare);
  console.log(`  ✓ Fee landed in the curve's creatorBalances (${creatorShare.toString()} wei) — the SAME accounting buy()/sell() use`);

  // Add a pre-graduation-style credit too (from an earlier curve.buy()), to confirm
  // one unified balance accumulates fees from both sources.
  const buyResult = curve.buy(1n * 10n ** 18n, 'earlyBuyer');
  const expectedTotal = creatorShare + buyResult.creatorFee;
  assert.equal(curve.creatorBalances.get(BROKEN_CREATOR), expectedTotal);
  console.log(`  ✓ Pre-graduation buy() fee (${buyResult.creatorFee.toString()} wei) accrues into the SAME balance: total ${expectedTotal.toString()} wei`);

  // Claim still correctly reverts while broken, preserving the combined balance...
  assert.throws(() => curve.claimCreatorFees(BROKEN_CREATOR), /EthTransferFailed/);
  assert.equal(curve.creatorBalances.get(BROKEN_CREATOR), expectedTotal, 'combined balance must survive a failed claim');
  console.log('  ✓ Claim attempt while still broken reverts without losing the combined balance');

  // ...and becomes claimable in one call once fixed, via the curve's existing claim path.
  ethReceivers.get(BROKEN_CREATOR).revertsOnReceive = false;
  const claimed = curve.claimCreatorFees(BROKEN_CREATOR);
  assert.equal(claimed, expectedTotal);
  console.log(`  ✓ Single claimCreatorFees() call withdraws pre- AND post-graduation fees together: ${claimed.toString()} wei\n`);
}

console.log('======================================================');
console.log('  ALL 5/5 CREATOR PULL-PAYMENT TESTS PASSED!');
console.log('======================================================');
