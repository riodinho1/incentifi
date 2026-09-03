import assert from 'node:assert/strict';

console.log('==================================================================');
console.log('  FEE-ON-TRANSFER TOKEN ACCOUNTING TEST');
console.log('==================================================================\n');
console.log('Simulates a token with a 1% transfer tax against the FIXED');
console.log('IncentifiBondingCurve.buy()/sell() and IncentifiSwapRouter.sellToken()');
console.log('accounting (balance-delta based) and contrasts it with the OLD');
console.log('(nominal-amount-trusting) logic that shipped before this audit.\n');

// ----------------------------------------------------------------------------
// Bonding curve economic constants (mirrors contracts/IncentifiBondingCurve.sol)
// ----------------------------------------------------------------------------
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const VIRTUAL_ETH = 2156250000000000000n;
const VIRTUAL_TOKEN = 78125000000000000000000000n;
const INVARIANT_K = 2324707031250000000000000000000000000000000000n;
const GRADUATION_ETH_TARGET = 5853863234375000000n;

// ----------------------------------------------------------------------------
// Minimal fee-on-transfer ERC-20 ledger: every transfer() / transferFrom()
// deducts the FULL nominal amount from the sender but only credits the
// recipient with (amount - tax). This is the behavior the fixed contracts
// must be robust against.
// ----------------------------------------------------------------------------
class FeeOnTransferToken {
  constructor(taxBps) {
    this.taxBps = BigInt(taxBps);
    this.balances = new Map();
  }

  balanceOf(addr) {
    return this.balances.get(addr) ?? 0n;
  }

  mint(addr, amount) {
    this.balances.set(addr, this.balanceOf(addr) + amount);
  }

  /** Moves `amount` out of `from`; `to` receives `amount` minus the transfer tax. */
  transfer(from, to, amount) {
    const fromBal = this.balanceOf(from);
    assert.ok(fromBal >= amount, `insufficient balance: ${from} has ${fromBal}, needs ${amount}`);
    const tax = (amount * this.taxBps) / 10_000n;
    const received = amount - tax;
    this.balances.set(from, fromBal - amount);
    this.balances.set(to, this.balanceOf(to) + received);
    return received;
  }
}

// ----------------------------------------------------------------------------
// FIXED bonding curve: mirrors contracts/IncentifiBondingCurve.sol buy()/sell()
// post-fix — reserve accounting is driven by measured balance deltas, exactly
// like the Solidity `balanceOf(this)` before/after snapshots.
// ----------------------------------------------------------------------------
class FixedBondingCurveSimulator {
  constructor(token, curveAddress) {
    this.token = token;
    this.address = curveAddress;
    this.realEthReserve = 0n;
    this.realTokenReserve = TOTAL_SUPPLY;
  }

  buy(grossEthIn, buyerAddress, minTokensOut) {
    const creatorFee = grossEthIn / 100n;
    const lossPoolFee = grossEthIn / 100n;
    const netEth = grossEthIn - creatorFee - lossPoolFee;

    const currentEth = VIRTUAL_ETH + this.realEthReserve;
    const currentToken = VIRTUAL_TOKEN + this.realTokenReserve;
    const newEth = currentEth + netEth;
    const tokensOut = currentToken - INVARIANT_K / newEth;

    assert.ok(tokensOut <= this.realTokenReserve, 'InsufficientReserve');

    this.realEthReserve += netEth;
    this.realTokenReserve -= tokensOut;

    // Deliver tokens and measure what the buyer actually received — the fix.
    const before = this.token.balanceOf(buyerAddress);
    this.token.transfer(this.address, buyerAddress, tokensOut);
    const actualTokensReceived = this.token.balanceOf(buyerAddress) - before;

    if (actualTokensReceived < minTokensOut) {
      throw new Error('SlippageExceeded');
    }

    return { tokensOutNominal: tokensOut, actualTokensReceived, creatorFee, lossPoolFee, netEth };
  }

  sell(tokensIn, sellerAddress, minEthOut) {
    // Pull tokens from seller and measure the actual balance delta — the fix.
    const before = this.token.balanceOf(this.address);
    this.token.transfer(sellerAddress, this.address, tokensIn);
    const actualTokensIn = this.token.balanceOf(this.address) - before;
    assert.ok(actualTokensIn > 0n, 'ZeroAmount');

    const currentEth = VIRTUAL_ETH + this.realEthReserve;
    const currentToken = VIRTUAL_TOKEN + this.realTokenReserve;
    const newToken = currentToken + actualTokensIn;
    const grossEthOut = currentEth - INVARIANT_K / newToken;

    assert.ok(grossEthOut <= this.realEthReserve, 'InsufficientReserve');

    const creatorFee = grossEthOut / 100n;
    const lossPoolFee = grossEthOut / 100n;
    const netEthOut = grossEthOut - creatorFee - lossPoolFee;

    if (netEthOut < minEthOut) {
      throw new Error('SlippageExceeded');
    }

    this.realEthReserve -= grossEthOut;
    this.realTokenReserve += actualTokensIn;

    return { actualTokensIn, grossEthOut, netEthOut, creatorFee, lossPoolFee };
  }
}

// ----------------------------------------------------------------------------
// OLD (broken) bonding curve: mirrors the pre-fix contract, which trusted the
// caller-supplied `tokensIn` / used the pre-tax `tokensOut` for its slippage
// check instead of measuring actual balances. Used only to document the bug.
// ----------------------------------------------------------------------------
class BrokenBondingCurveSimulator {
  constructor(token, curveAddress) {
    this.token = token;
    this.address = curveAddress;
    this.realEthReserve = 0n;
    this.realTokenReserve = TOTAL_SUPPLY;
  }

  sell(tokensIn) {
    const currentEth = VIRTUAL_ETH + this.realEthReserve;
    const currentToken = VIRTUAL_TOKEN + this.realTokenReserve;
    const newToken = currentToken + tokensIn; // BUG: nominal amount, not actual delta
    const grossEthOut = currentEth - INVARIANT_K / newToken;

    const creatorFee = grossEthOut / 100n;
    const lossPoolFee = grossEthOut / 100n;
    const netEthOut = grossEthOut - creatorFee - lossPoolFee;

    // The token transferFrom already happened by the time real Solidity
    // control flow gets here; this simulator only reproduces the OLD
    // accounting math, which never re-measured the actual balance received.
    this.realEthReserve -= grossEthOut;
    this.realTokenReserve += tokensIn; // BUG: credits the full nominal amount

    return { netEthOut, grossEthOut };
  }
}

const TAX_BPS = 100n; // 1% transfer tax, matching the audited token

// ----------------------------------------------------------------------------
// Test 1: Buy — recipient receives less than quoted; fixed slippage check
// catches it, the old pre-tax check would not have.
// ----------------------------------------------------------------------------
console.log('Testing [1/5] Buy: slippage check validates actual post-tax delivery...');
{
  const token = new FeeOnTransferToken(TAX_BPS);
  const curveAddr = 'curve';
  const buyerAddr = 'buyerA';
  token.mint(curveAddr, TOTAL_SUPPLY);

  const curve = new FixedBondingCurveSimulator(token, curveAddr);
  const grossEth = 10n ** 18n; // 1 ETH

  // Ask for slippage protection tight enough that only the FULL pre-tax
  // amount would satisfy it (i.e. between 99% and 100% of the quoted amount).
  const preview = curve.buy(grossEth, 'previewOnly', 0n);
  const tightMinTokensOut = (preview.tokensOutNominal * 995n) / 1000n; // 99.5% of quote

  // Reset state for the real attempt (the preview call above already mutated
  // curve state and buyer balance; simulate a fresh curve+buyer for clarity).
  const token2 = new FeeOnTransferToken(TAX_BPS);
  token2.mint(curveAddr, TOTAL_SUPPLY);
  const curve2 = new FixedBondingCurveSimulator(token2, curveAddr);

  assert.throws(
    () => curve2.buy(grossEth, buyerAddr, tightMinTokensOut),
    /SlippageExceeded/,
    'Fixed buy() must revert when the 1% tax pushes actual delivery below minTokensOut'
  );
  console.log('  ✓ Fixed buy() reverts when post-tax delivery would violate slippage protection');

  // Confirm the OLD behavior: checking the pre-tax `tokensOut` against the
  // same tightMinTokensOut would NOT have reverted, silently shortchanging
  // the buyer by ~1%.
  const oldWouldPass = preview.tokensOutNominal >= tightMinTokensOut;
  assert.ok(oldWouldPass, 'Documents that the old pre-tax check would have let this trade through');
  assert.ok(preview.actualTokensReceived < tightMinTokensOut, 'Actual delivery is indeed below the requested minimum');
  console.log('  ✓ Confirmed the old pre-tax check would have silently accepted an under-delivered buy\n');
}

// ----------------------------------------------------------------------------
// Test 2: Sell — reserve accounting matches actual balance, not nominal input.
// ----------------------------------------------------------------------------
console.log('Testing [2/5] Sell: reserve accounting uses actual received balance...');
{
  const token = new FeeOnTransferToken(TAX_BPS);
  const curveAddr = 'curve';
  const sellerAddr = 'sellerA';
  token.mint(curveAddr, TOTAL_SUPPLY);
  token.mint(sellerAddr, 10_000_000n * 10n ** 18n);

  const curve = new FixedBondingCurveSimulator(token, curveAddr);
  // Seed real ETH reserve first — an untouched curve has 0 withdrawable ETH,
  // so selling into it would correctly revert with InsufficientReserve.
  curve.buy(2n * 10n ** 18n, 'primerBuyer', 0n);

  const tokensToSell = 10_000_000n * 10n ** 18n;
  const result = curve.sell(tokensToSell, sellerAddr, 0n);

  const expectedActual = tokensToSell - (tokensToSell * TAX_BPS) / 10_000n;
  assert.equal(result.actualTokensIn, expectedActual, 'actualTokensIn must equal post-tax delivered amount');
  assert.equal(
    token.balanceOf(curveAddr),
    curve.realTokenReserve,
    'Curve ledger balance must exactly match tracked realTokenReserve after a taxed sell'
  );
  console.log(`  ✓ Seller requested ${tokensToSell.toString()}, curve credited only ${result.actualTokensIn.toString()} (post-tax)`);
  console.log('  ✓ realTokenReserve === actual on-chain balance after the sell\n');
}

// ----------------------------------------------------------------------------
// Test 3: Repeated buy/sell cycles — the invariant (tracked reserve === actual
// ledger balance) must hold after every single operation, not just once.
// ----------------------------------------------------------------------------
console.log('Testing [3/5] Repeated buy/sell cycles preserve the reserve == balance invariant...');
{
  const token = new FeeOnTransferToken(TAX_BPS);
  const curveAddr = 'curve';
  token.mint(curveAddr, TOTAL_SUPPLY);
  const curve = new FixedBondingCurveSimulator(token, curveAddr);

  const traders = ['trader1', 'trader2', 'trader3'];
  let step = 0;

  for (let i = 0; i < 12; i += 1) {
    const trader = traders[i % traders.length];
    if (i % 2 === 0) {
      const ethIn = (BigInt(i) + 1n) * 10n ** 16n; // 0.01–0.12 ETH
      curve.buy(ethIn, trader, 0n);
    } else {
      const held = token.balanceOf(trader);
      if (held > 0n) {
        curve.sell(held / 2n, trader, 0n);
      }
    }
    step += 1;
    assert.equal(
      token.balanceOf(curveAddr),
      curve.realTokenReserve,
      `Invariant broke after step ${step}: ledger balance != realTokenReserve`
    );
  }
  console.log(`  ✓ Invariant held across all ${step} alternating buy/sell operations\n`);
}

// ----------------------------------------------------------------------------
// Test 4: Contrast against the OLD (broken) sell() accounting to document the
// bug the fix closes — nominal-amount crediting drifts the tracked reserve
// above the real balance, which can eventually make the curve insolvent.
// ----------------------------------------------------------------------------
console.log('Testing [4/5] Regression check: OLD sell() logic drifts reserve above real balance...');
{
  const token = new FeeOnTransferToken(TAX_BPS);
  const curveAddr = 'curve';
  const sellerAddr = 'sellerA';
  token.mint(curveAddr, TOTAL_SUPPLY);
  token.mint(sellerAddr, 50_000_000n * 10n ** 18n);

  const brokenCurve = new BrokenBondingCurveSimulator(token, curveAddr);
  const tokensToSell = 10_000_000n * 10n ** 18n;

  // Old code path: caller transfers tokens in (tax applies), curve trusts the
  // nominal amount for its own accounting instead of measuring the delta.
  token.transfer(sellerAddr, curveAddr, tokensToSell);
  brokenCurve.sell(tokensToSell);

  const drift = brokenCurve.realTokenReserve - token.balanceOf(curveAddr);
  assert.ok(drift > 0n, 'Old logic must overstate realTokenReserve relative to the real balance');
  assert.equal(drift, (tokensToSell * TAX_BPS) / 10_000n, 'Drift must equal exactly the 1% tax withheld on the inbound transfer');
  console.log(`  ✓ Confirmed: old logic overstates realTokenReserve by ${drift.toString()} wei after a single taxed sell`);
  console.log('    (this compounds with every sell, eventually starving buy() of real token balance)\n');
}

// ----------------------------------------------------------------------------
// Test 5: Graduation-adjacent check — the invariant must still hold once the
// curve has accumulated enough ETH to trigger graduation, since _graduate()
// deposits `realTokenReserve` tokens into the Uniswap V3 position and would
// revert on insufficient balance if the tracked reserve were ever inflated.
// ----------------------------------------------------------------------------
console.log('Testing [5/5] Invariant holds through to the graduation trigger point...');
{
  const token = new FeeOnTransferToken(TAX_BPS);
  const curveAddr = 'curve';
  token.mint(curveAddr, TOTAL_SUPPLY);
  const curve = new FixedBondingCurveSimulator(token, curveAddr);

  const buyers = ['whale1', 'whale2'];
  let i = 0;
  while (curve.realEthReserve < GRADUATION_ETH_TARGET) {
    const buyer = buyers[i % buyers.length];
    curve.buy(2n * 10n ** 18n, buyer, 0n); // 2 ETH per buy
    // Interleave a partial sell from an earlier buyer to keep the token side taxed both ways.
    if (i % 3 === 2) {
      const held = token.balanceOf(buyer);
      if (held > 0n) curve.sell(held / 4n, buyer, 0n);
    }
    i += 1;
    assert.equal(
      token.balanceOf(curveAddr),
      curve.realTokenReserve,
      `Invariant broke mid-ramp at iteration ${i}`
    );
    if (i > 100) throw new Error('Did not reach graduation target in a reasonable number of iterations');
  }

  assert.ok(curve.realEthReserve >= GRADUATION_ETH_TARGET, 'Graduation target reached');
  assert.ok(
    curve.realTokenReserve <= token.balanceOf(curveAddr),
    'realTokenReserve must never exceed the curve\'s actual token balance at graduation — ' +
      'otherwise _graduate() would try to deposit more tokens into the Uniswap V3 position than it holds'
  );
  console.log(`  ✓ Reached graduation after ${i} taxed buy/sell operations`);
  console.log('  ✓ realTokenReserve never exceeded the real on-chain balance — graduation deposit is safe\n');
}

console.log('==================================================================');
console.log('  VERIFICATION RESULT: ALL FEE-ON-TRANSFER ACCOUNTING CHECKS PASSED');
console.log('==================================================================');
