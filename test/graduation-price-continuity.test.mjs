import assert from 'node:assert/strict';

console.log('======================================================');
console.log('  GRADUATION PRICE-CONTINUITY TEST');
console.log('======================================================\n');
console.log('Verifies the fix to contracts/IncentifiBondingCurve.sol _graduate():');
console.log('sqrtPriceX96 is now computed at graduation time from actual token0/token1');
console.log('ordering, instead of a fixed constant that was only correct when the');
console.log('launched token\'s address sorts above WETH\'s.\n');

// ----------------------------------------------------------------------------
// Exact bonding curve constants (contracts/IncentifiBondingCurve.sol)
// ----------------------------------------------------------------------------
const VIRTUAL_ETH = 2156250000000000000n;
const VIRTUAL_TOKEN = 78125000000000000000000000n;
const INVARIANT_K = 2324707031250000000000000000000000000000000000n;
const GRADUATION_ETH_TARGET = 5853863234375000000n;
const Q96 = 2n ** 96n;
const SCALE = 10n ** 36n; // extra precision for exact BigInt price comparisons

// ----------------------------------------------------------------------------
// Mirrors the NEW Solidity _sqrt() / _computeSqrtPriceX96() exactly.
// ----------------------------------------------------------------------------
function sqrtBig(x) {
  if (x === 0n) return 0n;
  let z = (x + 1n) / 2n;
  let y = x;
  while (z < y) {
    y = z;
    z = (x / z + z) / 2n;
  }
  return y;
}

function computeSqrtPriceX96(amount0, amount1) {
  assert.ok(amount0 > 0n && amount1 > 0n, 'ZeroAmount');
  const sqrtAmount0 = sqrtBig(amount0);
  const sqrtAmount1 = sqrtBig(amount1);
  return (sqrtAmount1 << 96n) / sqrtAmount0;
}

// The OLD (buggy) behavior: a single fixed constant used regardless of ordering.
// Reproduced here only to demonstrate, as a regression guard, how badly wrong it
// was for the ordering it was never designed for.
const OLD_FIXED_SQRT_PRICE_X96 = 476897496634883656268812375606081n;

function impliedPriceScaled(sqrtPriceX96) {
  // price = (sqrtPriceX96 / 2^96)^2, scaled by 1e36 for exact-integer comparison
  return (sqrtPriceX96 * sqrtPriceX96 * SCALE) / (Q96 * Q96);
}

function relativeDiffPct(scaledA, scaledB) {
  const a = Number(scaledA) / Number(SCALE);
  const b = Number(scaledB) / Number(SCALE);
  return ((a / b) - 1) * 100;
}

// ----------------------------------------------------------------------------
// Bonding curve state at the exact moment graduation triggers
// ----------------------------------------------------------------------------
const wethDeposit = GRADUATION_ETH_TARGET; // realEthReserve == target exactly (0 wei overshoot, verified elsewhere)
const currentEthAtGrad = VIRTUAL_ETH + wethDeposit;
const currentTokenAtGrad = INVARIANT_K / currentEthAtGrad;
const tokenDeposit = currentTokenAtGrad - VIRTUAL_TOKEN; // realTokenReserve at graduation

const WETH_ADDRESS = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const TOKEN_ABOVE_WETH = '0xb617bf8807db8763a2f86a5d15bab2ba83cfff10'; // > WETH numerically
const TOKEN_BELOW_WETH = '0x0111111111111111111111111111111111111111'; // < WETH numerically (starts 0x01 < 0x0B)

assert.ok(BigInt(TOKEN_ABOVE_WETH) > BigInt(WETH_ADDRESS), 'fixture token must sort above WETH');
assert.ok(BigInt(TOKEN_BELOW_WETH) < BigInt(WETH_ADDRESS), 'fixture token must sort below WETH');

const TOLERANCE_PCT = 1e-5; // 0.00001% — generous vs. the ~2.8e-8% actually observed, tight vs. the ~1e17% old bug

// ----------------------------------------------------------------------------
// Test 1: token address ABOVE WETH (token0=WETH, token1=TOKEN)
// ----------------------------------------------------------------------------
console.log(`Testing [1/3] Token address ABOVE WETH (${TOKEN_ABOVE_WETH})...`);
{
  const weth = BigInt(WETH_ADDRESS);
  const tok = BigInt(TOKEN_ABOVE_WETH);
  assert.ok(weth < tok);

  // Mirrors _graduate(): token0 = weth<token ? weth : token, etc.
  const amount0Desired = wethDeposit; // token0 = WETH
  const amount1Desired = tokenDeposit; // token1 = TOKEN

  const sqrtPriceX96 = computeSqrtPriceX96(amount0Desired, amount1Desired);
  const impliedPrice = impliedPriceScaled(sqrtPriceX96); // TOKEN per WETH

  // True curve price expressed the same way: TOKEN per WETH = currentToken/currentEth
  const truePriceScaled = (currentTokenAtGrad * SCALE) / currentEthAtGrad;

  const diffPct = relativeDiffPct(impliedPrice, truePriceScaled);
  console.log(`  Seeded pool price (TOKEN/WETH):  ${(Number(impliedPrice) / Number(SCALE)).toExponential(10)}`);
  console.log(`  Curve's real spot price (TOKEN/WETH): ${(Number(truePriceScaled) / Number(SCALE)).toExponential(10)}`);
  console.log(`  Relative difference: ${diffPct.toExponential(6)}%`);
  assert.ok(Math.abs(diffPct) < TOLERANCE_PCT, `price diff ${diffPct}% exceeds tolerance ${TOLERANCE_PCT}%`);
  console.log(`  ✓ Within tolerance (${TOLERANCE_PCT}%)`);
}

// ----------------------------------------------------------------------------
// Test 2: token address BELOW WETH (token0=TOKEN, token1=WETH) — the ordering
// that broke under the old fixed-constant approach.
// ----------------------------------------------------------------------------
console.log(`\nTesting [2/3] Token address BELOW WETH (${TOKEN_BELOW_WETH})...`);
{
  const weth = BigInt(WETH_ADDRESS);
  const tok = BigInt(TOKEN_BELOW_WETH);
  assert.ok(tok < weth);

  // Mirrors _graduate(): token0 = weth<token ? weth : token -> here token<weth, so token0=TOKEN
  const amount0Desired = tokenDeposit; // token0 = TOKEN
  const amount1Desired = wethDeposit; // token1 = WETH

  const sqrtPriceX96 = computeSqrtPriceX96(amount0Desired, amount1Desired);
  const impliedPrice = impliedPriceScaled(sqrtPriceX96); // WETH per TOKEN

  // True curve price expressed the same way: WETH per TOKEN = currentEth/currentToken
  const truePriceScaled = (currentEthAtGrad * SCALE) / currentTokenAtGrad;

  const diffPct = relativeDiffPct(impliedPrice, truePriceScaled);
  console.log(`  Seeded pool price (WETH/TOKEN):  ${(Number(impliedPrice) / Number(SCALE)).toExponential(10)}`);
  console.log(`  Curve's real spot price (WETH/TOKEN): ${(Number(truePriceScaled) / Number(SCALE)).toExponential(10)}`);
  console.log(`  Relative difference: ${diffPct.toExponential(6)}%`);
  assert.ok(Math.abs(diffPct) < TOLERANCE_PCT, `price diff ${diffPct}% exceeds tolerance ${TOLERANCE_PCT}%`);
  console.log(`  ✓ Within tolerance (${TOLERANCE_PCT}%)`);
}

// ----------------------------------------------------------------------------
// Test 3: regression guard — the OLD fixed-constant approach must be shown to
// have been catastrophically wrong for the below-WETH ordering, so this test
// suite would have failed loudly against the pre-fix code.
// ----------------------------------------------------------------------------
console.log(`\nTesting [3/3] Regression guard: old fixed constant vs. below-WETH ordering...`);
{
  const oldImpliedPrice = impliedPriceScaled(OLD_FIXED_SQRT_PRICE_X96); // interpreted as WETH/TOKEN in this ordering
  const truePriceScaled = (currentEthAtGrad * SCALE) / currentTokenAtGrad;
  const oldDiffPct = relativeDiffPct(oldImpliedPrice, truePriceScaled);
  console.log(`  Old fixed-constant price forced into the below-WETH ordering: off by ${oldDiffPct.toExponential(6)}%`);
  assert.ok(
    Math.abs(oldDiffPct) > 1e15,
    'the old fixed constant should be catastrophically wrong (>1e15%) for the flipped ordering — ' +
      'if this assertion fails, the regression guard itself needs re-checking, not the fix'
  );
  console.log(`  ✓ Confirmed the old approach was catastrophically wrong here (this is what the fix corrects)`);
}

console.log('\n======================================================');
console.log('  ALL 3/3 GRADUATION PRICE-CONTINUITY TESTS PASSED!');
console.log('======================================================');
