/**
 * FRONTEND — claim pre-flight helpers (src/lib/claimRevert.ts), 2026-09-09.
 *
 * Incident: the site showed "The contract function claimRewardAs reverted." for a V2 claim although
 * the leaf, proof, root, pool and amount all verified on-chain. viem's shortMessage for a revert
 * whose custom error IS in the ABI is that bare sentence; the decoded name/args are on the inner
 * ContractFunctionRevertedError and were never shown.
 *   1. explainClaimRevert names every LossRewardPoolV2 error with actionable text (InvalidProof,
 *      AlreadyClaimed, EpochNotPublished, DeadlineExpired with clock skew, MinOutNotMet with both
 *      numbers, UseClaimAs), an unknown selector, empty revert data, and an RPC failure
 *   2. claimLeaf/verifyClaimProof reproduce the on-chain leaf and verify the REAL production proof of
 *      epoch #4 (INCENTIFI, holder 0xb45e…, 6391723164922931 wei) against root 0xeccb35d9…
 *   3. claimDeadline is based on the chain clock when it is ahead of the device, never below now+600
 *
 * Run: node test/claim-revert-explain.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import { createServer as createViteServer } from 'vite';
import { ContractFunctionRevertedError, ContractFunctionExecutionError, RpcRequestError, parseAbi, encodeErrorResult } from 'viem';

const vite = await createViteServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const m = await vite.ssrLoadModule('/src/lib/claimRevert.ts');
  const abi = parseAbi([
    'function claimRewardAs(address token, uint256 epochId, uint256 amount, bytes32[] merkleProof, uint256 minAssetOut, uint256 deadline)',
    'error UseClaimAs()', 'error DeadlineExpired()', 'error MinOutNotMet(uint256 amountOut, uint256 minAssetOut)', 'error EpochNotPublished()', 'error AlreadyClaimed()', 'error InvalidProof()',
  ]);
  const V2 = '0x5d94246CD31064Da02E953DB357F0001F0E9A631';
  const ctx = { epochs: [{ epochNumber: 4, amountWei: 6391723164922931n, pool: V2, onChainRoot: '0xeccb35d977eb6506ce479b6153c2e40b61328c695de8a0ce9af67069814ecfdf' }], pool: V2, isV2: true, slippagePct: 1, assetSymbol: 'NVDA', chainSkewSec: 720 };
  const viemErr = (data) => new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi, data, functionName: 'claimRewardAs' }), { abi, functionName: 'claimRewardAs', args: [], contractAddress: V2 });

  console.log('======================================================');
  console.log('  CLAIM REVERT EXPLANATION + LOCAL PROOF CHECK');
  console.log('======================================================\n');

  // 1. decoded errors
  const cases = [
    ['InvalidProof', encodeErrorResult({ abi, errorName: 'InvalidProof' }), /InvalidProof.*epoch #4.*0\.006391723164922931 ETH.*0xeccb35d9.*refreshed/s],
    ['AlreadyClaimed', encodeErrorResult({ abi, errorName: 'AlreadyClaimed' }), /already claimed by this wallet/],
    ['EpochNotPublished', encodeErrorResult({ abi, errorName: 'EpochNotPublished' }), /not published on LossRewardPoolV2 0x5d94…A631 yet/],
    ['DeadlineExpired', encodeErrorResult({ abi, errorName: 'DeadlineExpired' }), /DeadlineExpired.*device clock is 720s behind the chain/],
    ['MinOutNotMet', encodeErrorResult({ abi, errorName: 'MinOutNotMet', args: [70313370135796879n, 71000000000000000n] }), /NVDA swap would return 70313370135796879 .* minimum is 71000000000000000 \(quote minus 1% slippage\)/],
    ['UseClaimAs', encodeErrorResult({ abi, errorName: 'UseClaimAs' }), /UseClaimAs.*site configuration/],
  ];
  for (const [name, data, re] of cases) {
    const ex = m.explainClaimRevert(viemErr(data), ctx);
    assert.equal(ex.code, name, `${name}: code`); assert.match(ex.message, re, `${name}: message (${ex.message})`);
    // the message viem would have shown alone is useless
    assert.equal(viemErr(data).shortMessage.startsWith('The contract function "claimRewardAs" reverted'), true);
  }
  const unk = m.explainClaimRevert(viemErr('0xdeadbeef'), ctx);
  assert.equal(unk.code, 'UnknownSelector'); assert.match(unk.message, /unrecognised error selector 0xdeadbeef/);
  const nodata = m.explainClaimRevert(viemErr('0x'), ctx);
  assert.equal(nodata.code, 'NoData'); assert.match(nodata.message, /empty revert data.*pool address/);
  const rpc = m.explainClaimRevert(new RpcRequestError({ body: { method: 'eth_call' }, error: { code: -32005, message: 'rate limited' }, url: 'https://rpc.example' }), ctx);
  assert.equal(rpc.code, 'RpcError'); assert.match(rpc.message, /error -32005.*rate limited.*Nothing was sent/s);
  assert.equal(m.explainClaimRevert(new Error('boom'), ctx).code, 'Unknown');
  console.log('1. every V2 custom error, an unknown selector, empty data and an RPC failure explained by name with actionable text  OK');

  // 2. production leaf + proof verify against the on-chain root of epoch #4
  const TOKEN = '0xb1ae1bf55389a3e011fd456ca0ea7e8625307195', W = '0xb45e3d25d4d0c45f33ce7555bfe127281dffc4a1';
  const proof = ['0xbf2781e979359db71becc57babaa7f52bfe93595b1e3e45b0e2a651c5353f9f5', '0xcc46bafae5e3a5d702b438dec9fc1dc33a0d839733213e9e1a4aba824d0f1912', '0x4d550a5e0fc1a1509d2d594de0b4d83cf7daebea177f7e1b4fd5a15e2adaf9d8', '0xf022fd4e94daf19900db1b58593464e2a41be396a2ad8120972c00fa5ef23c5d', '0x07177a33d866396ee3a5a07270a520a81c4d8268a8ac2461ea0b936755a9aef4', '0x1a782a6c81daabfb0d0a975673bbd28652f40194ba0f0bed910db427cedd10dc'];
  const root = '0xeccb35d977eb6506ce479b6153c2e40b61328c695de8a0ce9af67069814ecfdf';
  const leaf = m.claimLeaf(TOKEN, 4, W, 6391723164922931n);
  assert.equal(m.verifyClaimProof(leaf, proof, root), true, 'the real epoch-4 proof verifies');
  assert.equal(m.verifyClaimProof(m.claimLeaf(TOKEN, 4, W, 6391723164922932n), proof, root), false, 'one wei off -> no');
  assert.equal(m.verifyClaimProof(m.claimLeaf(TOKEN, 5, W, 6391723164922931n), proof, root), false, 'wrong epoch -> no');
  assert.equal(m.verifyClaimProof(leaf, proof, '0x' + '0'.repeat(64)), false, 'unpublished (zero) root -> no');
  console.log('2. claimLeaf/verifyClaimProof reproduce the on-chain leaf; the production epoch-4 proof verifies, off-by-one/epoch/root do not  OK');

  // 3. deadline from the chain clock
  const now = 1_788_900_000_000;
  assert.equal(m.claimDeadline(1_788_900_000 + 900, now), BigInt(1_788_900_000 + 900 + 600), 'chain ahead of device -> chain + 600');
  assert.equal(m.claimDeadline(1_788_900_000 - 900, now), BigInt(1_788_900_000 + 600), 'chain behind device -> device + 600');
  assert.equal(m.claimDeadline(null, now), BigInt(1_788_900_000 + 600));
  console.log('3. claimDeadline uses whichever clock is later  OK');

  console.log('\nclaim-revert-explain tests passed');
} finally {
  await vite.close();
}
process.exit(0);
