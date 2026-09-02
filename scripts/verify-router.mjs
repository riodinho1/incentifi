/**
 * Verification Script for IncentifiSwapRouter on Robinhood Chain Mainnet
 * Usage: node scripts/verify-router.mjs <ROUTER_ADDRESS>
 */

import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;

const ROUTER_ABI = parseAbi([
  'function uniswapRouter() view returns (address)',
  'function WETH9() view returns (address)',
  'function lossRewardPool() view returns (address)',
  'function bondingCurveFactory() view returns (address)',
  'function POOL_FEE() view returns (uint24)',
  'function PROTOCOL_FEE_BPS() view returns (uint256)',
  'function CREATOR_FEE_BPS() view returns (uint256)',
  'function LOSS_REWARD_FEE_BPS() view returns (uint256)',
]);

const EXPECTED = {
  uniswapRouter: getAddress('0xcaf681a66d020601342297493863e78c959e5cb2'),
  weth: getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  lossRewardPool: getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf'),
  bondingCurveFactory: getAddress('0x9fcea653c6f31c82606582b22da82b39f61f9c0e'),
};

export async function verifyRouter(routerAddress) {
  const client = createPublicClient({ transport: http(RPC_URL) });
  const address = getAddress(routerAddress);

  console.log('\n======================================================');
  console.log(`[VERIFY SWAP ROUTER] Target: ${address} on Chain ID ${CHAIN_ID}`);
  console.log('======================================================\n');

  // 1. Get Code
  const code = await client.getCode({ address });
  const isCodeNonEmpty = Boolean(code && code !== '0x' && code.length > 2);
  const codeBytes = code ? (code.length - 2) / 2 : 0;
  console.log(`1. eth_getCode: ${isCodeNonEmpty ? 'NON-EMPTY (VERIFIED)' : 'EMPTY (FAILED)'} (${codeBytes} bytes)`);

  if (!isCodeNonEmpty) {
    throw new Error(`Contract not found or empty code at ${address}`);
  }

  // 2. Read Immutables & Constants
  const [uniswapRouter, weth, lossRewardPool, bondingCurveFactory, poolFee, protocolFeeBps, creatorFeeBps, lossFeeBps] = await Promise.all([
    client.readContract({ address, abi: ROUTER_ABI, functionName: 'uniswapRouter' }),
    client.readContract({ address, abi: ROUTER_ABI, functionName: 'WETH9' }),
    client.readContract({ address, abi: ROUTER_ABI, functionName: 'lossRewardPool' }),
    client.readContract({ address, abi: ROUTER_ABI, functionName: 'bondingCurveFactory' }),
    client.readContract({ address, abi: ROUTER_ABI, functionName: 'POOL_FEE' }),
    client.readContract({ address, abi: ROUTER_ABI, functionName: 'PROTOCOL_FEE_BPS' }),
    client.readContract({ address, abi: ROUTER_ABI, functionName: 'CREATOR_FEE_BPS' }),
    client.readContract({ address, abi: ROUTER_ABI, functionName: 'LOSS_REWARD_FEE_BPS' }),
  ]);

  console.log(`2. uniswapRouter(): ${uniswapRouter}`);
  console.log(`   Matches Mainnet Router (0xcaf6...5cb2): ${getAddress(uniswapRouter) === EXPECTED.uniswapRouter}`);

  console.log(`3. WETH9(): ${weth}`);
  console.log(`   Matches Mainnet WETH: ${getAddress(weth) === EXPECTED.weth}`);

  console.log(`4. lossRewardPool(): ${lossRewardPool}`);
  console.log(`   Matches Verified Pool (0x697b...dcdf): ${getAddress(lossRewardPool) === EXPECTED.lossRewardPool}`);

  console.log(`5. bondingCurveFactory(): ${bondingCurveFactory}`);
  console.log(`   Matches Verified Factory (0x9fce...9c0e): ${getAddress(bondingCurveFactory) === EXPECTED.bondingCurveFactory}`);

  console.log(`6. Fee Configuration: Total Fee = ${Number(protocolFeeBps)/100}%, Creator = ${Number(creatorFeeBps)/100}%, Loss Pool = ${Number(lossFeeBps)/100}%, Pool Fee = ${Number(poolFee)/10000}%`);

  const allPassed =
    isCodeNonEmpty &&
    getAddress(uniswapRouter) === EXPECTED.uniswapRouter &&
    getAddress(weth) === EXPECTED.weth &&
    getAddress(lossRewardPool) === EXPECTED.lossRewardPool &&
    getAddress(bondingCurveFactory) === EXPECTED.bondingCurveFactory &&
    Number(protocolFeeBps) === 200 &&
    Number(creatorFeeBps) === 100 &&
    Number(lossFeeBps) === 100;

  console.log('\n======================================================');
  console.log(`[VERIFICATION RESULT] ${allPassed ? 'ALL CHECKS PASSED (100% VERIFIED)' : 'VERIFICATION FAILED'}`);
  console.log('======================================================\n');

  return {
    address,
    isCodeNonEmpty,
    codeBytes,
    uniswapRouter,
    weth,
    lossRewardPool,
    bondingCurveFactory,
    allPassed,
  };
}

if (process.argv[2]) {
  verifyRouter(process.argv[2])
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
