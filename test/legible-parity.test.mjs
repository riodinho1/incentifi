/**
 * LEGIBLE POOL PARITY — read-only against the LIVE Robinhood Chain, using the deployed PR #17
 * trio and the mainnet test token SMK95868 (0xC517a323…, poolId 0x7000b77f…).
 *
 * Proves, without sending anything:
 *   1. venue routing on the live chain: SMK95868 -> legible; TESTINGG -> the GenericSell trio;
 *      DHT (a V3 launch) -> neither V4 factory;
 *   2. the V4 Quoter's buy AND sell quotes equal the closed-form single-position V4 maths
 *      (2% fee on the input, then constant-L price move) computed from slot0 + liquidity, to
 *      within 0.01% — i.e. the quote the frontend shows is the pool's real execution price;
 *   3. slot0's price agrees with the hook's legacy 6-field curveStates view (virtual-reserve
 *      formula) to within 0.1%, so existing consumers of that view stay consistent;
 *   4. the exact-output quote round-trips through the exact-input quote (buy the quoted ETH,
 *      receive >= the requested tokens, within 0.01%).
 *
 * Run: node test/legible-parity.test.mjs   (needs network access to the Robinhood RPC)
 */
import assert from 'node:assert/strict';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import {
  INCENTIFI_LEGIBLE_FACTORY,
  INCENTIFI_LEGIBLE_HOOK,
  UNISWAP_V4_QUOTER,
  LEGIBLE_FACTORY_ABI,
  isLegibleToken,
  fetchLegibleState,
  priceEthFromSqrtPriceX96,
} from '../scripts/lib/legiblePool.mjs';

const RPC_URL = process.env.VITE_EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const client = createPublicClient({ transport: http(RPC_URL) });

const SMK = getAddress('0xC517a3235293Fa456723090B4C64354C2b80E725');
const SMK_POOL_ID = '0x7000b77fe5a3e0f8a8694c7f8e8bc48e06007eeb729a63005aa44cdd41103d35';
const TESTINGG = getAddress('0x7F9b8A09877F6e8096b0b8c6027DC49580b05474');
const DHT = getAddress('0x6b0f14f9cd498b01ee337ce68daf79b4104c7f51');
const OLD_V4_FACTORY = getAddress(process.env.VITE_INCENTIFI_V4_FACTORY || '0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0');
const V3_FACTORY = getAddress(process.env.VITE_INCENTIFI_BONDING_CURVE_FACTORY || '0xa0143de84fba1753b887e4e32941e4fb342e473f');

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function quoteExactOutputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountIn, uint256 gasEstimate)',
]);
const V3_FACTORY_ABI = parseAbi(['function getBondingCurve(address token) view returns (address)']);

const Q96 = 1n << 96n;
const FEE_PIPS = 20_000n; // 2% dynamic LP fee, pre- and post-graduation
const mulDiv = (a, b, d) => (a * b) / d;
const relDiff = (a, b) => Number(a > b ? a - b : b - a) / Number(b);

async function quote(fn, poolKey, zeroForOne, exactAmount) {
  const { result } = await client.simulateContract({ address: UNISWAP_V4_QUOTER, abi: QUOTER_ABI, functionName: fn, args: [{ poolKey, zeroForOne, exactAmount, hookData: '0x' }] });
  return { amount: result[0], gas: result[1] };
}

console.log('======================================================');
console.log('  LEGIBLE POOL PARITY (live Robinhood Chain, read-only)');
console.log('======================================================\n');
console.log('block', await client.getBlockNumber());

// --- 1. venue routing ---------------------------------------------------------------------
const isLaunchedOld = (t) => client.readContract({ address: OLD_V4_FACTORY, abi: LEGIBLE_FACTORY_ABI, functionName: 'isLaunched', args: [t] });
assert.equal(await isLegibleToken(client, SMK), true, 'SMK95868 is a legible launch');
assert.equal(await isLaunchedOld(SMK), false, 'SMK95868 is NOT on the GenericSell factory');
assert.equal(await isLegibleToken(client, TESTINGG), false, 'TESTINGG is NOT legible');
assert.equal(await isLaunchedOld(TESTINGG), true, 'TESTINGG is on the GenericSell factory');
assert.equal(await isLegibleToken(client, DHT), false);
assert.equal(await isLaunchedOld(DHT), false);
const dhtCurve = await client.readContract({ address: V3_FACTORY, abi: V3_FACTORY_ABI, functionName: 'getBondingCurve', args: [DHT] });
console.log(`routing: SMK95868=legible  TESTINGG=v4-generic  DHT=${dhtCurve === '0x0000000000000000000000000000000000000000' ? 'not-v3-either (pre-factory launch)' : 'v3'}  OK`);

// --- 2. state + quotes vs closed form ------------------------------------------------------
const st = await fetchLegibleState(client, SMK);
assert.equal(st.poolId.toLowerCase(), SMK_POOL_ID);
assert.equal(getAddress(st.hookAddress), INCENTIFI_LEGIBLE_HOOK);
assert.equal(getAddress(st.poolKey.hooks), INCENTIFI_LEGIBLE_HOOK);
assert.equal(getAddress(st.poolKey.currency1), SMK);
assert.ok(st.initialized && !st.graduated, 'fixture token is pre-graduation');
assert.ok(st.liquidity > 0n, 'real in-range liquidity');
assert.ok(st.currentPriceEth > 0);
console.log(`state: tick=${st.tick} sqrtP=${st.sqrtPriceX96} L=${st.liquidity} price=${st.currentPriceEth.toExponential(6)} ETH/token progress=${st.progressBps}bps realEth=${Number(st.realEthReserve) / 1e18} ETH`);

const sqrtP = st.sqrtPriceX96;
const L = st.liquidity;

// buy: ETH (currency0) in, exact input. Fee on input, then price moves along the single position.
const ethIn = 1_000_000_000_000_000n; // 0.001 ETH
const ethNet = ethIn - mulDiv(ethIn, FEE_PIPS, 1_000_000n);
const sqrtPAfterBuy = mulDiv(L * sqrtP, 1n, L + mulDiv(ethNet, sqrtP, Q96)); // L*sqrtP / (L + x*sqrtP)
const tokensOutClosed = mulDiv(L, sqrtP - sqrtPAfterBuy, Q96); // L * (sqrtP - sqrtP')
const buyQ = await quote('quoteExactInputSingle', st.poolKey, true, ethIn);
const buyDiff = relDiff(buyQ.amount, tokensOutClosed);
console.log(`buy 0.001 ETH: quoter=${buyQ.amount} closed-form=${tokensOutClosed} diff=${(buyDiff * 100).toFixed(5)}% gasEstimate=${buyQ.gas}`);
assert.ok(buyDiff < 1e-4, 'quoter buy == closed-form single-position maths within 0.01%');

// sell: tokens (currency1) in, exact input. Fee on input, then sqrtP rises: sqrtP' = sqrtP + y*Q96/L.
const tokensIn = 1_000n * 10n ** 18n;
const tokensNet = tokensIn - mulDiv(tokensIn, FEE_PIPS, 1_000_000n);
const sqrtPAfterSell = sqrtP + mulDiv(tokensNet, Q96, L);
const ethOutClosed = mulDiv(mulDiv(L, sqrtPAfterSell - sqrtP, sqrtPAfterSell), Q96, sqrtP); // L*(sqrtP'-sqrtP)/(sqrtP*sqrtP') * Q96
const sellQ = await quote('quoteExactInputSingle', st.poolKey, false, tokensIn);
const sellDiff = relDiff(sellQ.amount, ethOutClosed);
console.log(`sell 1000 tokens: quoter=${sellQ.amount} closed-form=${ethOutClosed} diff=${(sellDiff * 100).toFixed(5)}%`);
assert.ok(sellDiff < 1e-4, 'quoter sell == closed-form maths within 0.01%');

// --- 3. slot0 vs the legacy curveStates view ------------------------------------------------
const VIRTUAL_ETH = 2_156_250_000_000_000_000n;
const VIRTUAL_TOKEN = 78_125_000_000_000_000_000_000_000n;
const legacyPrice = Number(VIRTUAL_ETH + st.realEthReserve) / Number(VIRTUAL_TOKEN + st.realTokenReserve);
const slot0Price = priceEthFromSqrtPriceX96(sqrtP);
const viewDiff = Math.abs(legacyPrice - slot0Price) / slot0Price;
console.log(`legacy curveStates price=${legacyPrice.toExponential(6)} slot0 price=${slot0Price.toExponential(6)} diff=${(viewDiff * 100).toFixed(4)}%`);
assert.ok(viewDiff < 1e-3, 'legacy view agrees with slot0 within 0.1% (tickSpacing-10 bound rounding)');

// --- 4. exact-output round trip --------------------------------------------------------------
const want = 1_000n * 10n ** 18n;
const exactOut = await quote('quoteExactOutputSingle', st.poolKey, true, want);
const back = await quote('quoteExactInputSingle', st.poolKey, true, exactOut.amount);
console.log(`exact-out 1000 tokens needs ${exactOut.amount} wei; exact-in of that yields ${back.amount} tokens`);
assert.ok(back.amount >= want - want / 10_000n, 'exact-output quote round-trips within 0.01%');

console.log('\nlegible-parity tests passed');
