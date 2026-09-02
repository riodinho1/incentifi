/**
 * Verification Script for IncentifiBondingCurveFactory on Robinhood Chain Mainnet
 * Usage: node scripts/verify-factory.mjs <FACTORY_ADDRESS>
 */

import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;

const FACTORY_ABI = parseAbi([
  'function lossRewardPool() view returns (address)',
  'function weth() view returns (address)',
  'function positionManager() view returns (address)',
  'function uniswapFactory() view returns (address)',
  'function allCurvesLength() view returns (uint256)',
]);

const EXPECTED = {
  lossRewardPool: getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf'),
  weth: getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  positionManager: getAddress('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3'),
  uniswapFactory: getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'),
};

export async function verifyFactory(factoryAddress) {
  const client = createPublicClient({ transport: http(RPC_URL) });
  const address = getAddress(factoryAddress);

  console.log('\n======================================================');
  console.log(`[VERIFY FACTORY] Target: ${address} on Chain ID ${CHAIN_ID}`);
  console.log('======================================================\n');

  // 1. Get Code
  const code = await client.getCode({ address });
  const isCodeNonEmpty = Boolean(code && code !== '0x' && code.length > 2);
  const codeBytes = code ? (code.length - 2) / 2 : 0;
  console.log(`1. eth_getCode: ${isCodeNonEmpty ? 'NON-EMPTY (VERIFIED)' : 'EMPTY (FAILED)'} (${codeBytes} bytes)`);

  if (!isCodeNonEmpty) {
    throw new Error(`Contract not found or empty code at ${address}`);
  }

  // 2. Read Immutables
  const [lossRewardPool, weth, positionManager, uniswapFactory, allCurvesLength] = await Promise.all([
    client.readContract({ address, abi: FACTORY_ABI, functionName: 'lossRewardPool' }),
    client.readContract({ address, abi: FACTORY_ABI, functionName: 'weth' }),
    client.readContract({ address, abi: FACTORY_ABI, functionName: 'positionManager' }),
    client.readContract({ address, abi: FACTORY_ABI, functionName: 'uniswapFactory' }),
    client.readContract({ address, abi: FACTORY_ABI, functionName: 'allCurvesLength' }),
  ]);

  console.log(`2. lossRewardPool(): ${lossRewardPool}`);
  console.log(`   Matches Verified Pool (0x697b...dcdf): ${getAddress(lossRewardPool) === EXPECTED.lossRewardPool}`);

  console.log(`3. weth(): ${weth}`);
  console.log(`   Matches Mainnet WETH: ${getAddress(weth) === EXPECTED.weth}`);

  console.log(`4. positionManager(): ${positionManager}`);
  console.log(`   Matches Uniswap V3 PM: ${getAddress(positionManager) === EXPECTED.positionManager}`);

  console.log(`5. uniswapFactory(): ${uniswapFactory}`);
  console.log(`   Matches Uniswap V3 Factory: ${getAddress(uniswapFactory) === EXPECTED.uniswapFactory}`);

  console.log(`6. allCurvesLength(): ${allCurvesLength.toString()}`);

  const allPassed =
    isCodeNonEmpty &&
    getAddress(lossRewardPool) === EXPECTED.lossRewardPool &&
    getAddress(weth) === EXPECTED.weth &&
    getAddress(positionManager) === EXPECTED.positionManager &&
    getAddress(uniswapFactory) === EXPECTED.uniswapFactory;

  console.log('\n======================================================');
  console.log(`[VERIFICATION RESULT] ${allPassed ? 'ALL CHECKS PASSED (100% VERIFIED)' : 'VERIFICATION FAILED'}`);
  console.log('======================================================\n');

  return {
    address,
    isCodeNonEmpty,
    codeBytes,
    lossRewardPool,
    weth,
    positionManager,
    uniswapFactory,
    allCurvesLength: Number(allCurvesLength),
    allPassed,
  };
}

if (process.argv[2]) {
  verifyFactory(process.argv[2])
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
