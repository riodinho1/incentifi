/**
 * Deploys a NEW IncentifiBondingCurveFactory + IncentifiSwapRouter to REAL Robinhood
 * Chain MAINNET (Chain ID 4663), built from this repo's CURRENT (fixed) contract
 * source — wired to the same already-live LossRewardPool / WETH / Uniswap V3
 * PositionManager / Uniswap V3 Factory / Uniswap V3 SwapRouter02 the old deployment
 * used.
 *
 * WHY A NEW DEPLOYMENT (not an upgrade): the currently-live Factory
 * (0x9fcea653c6f31c82606582b22da82b39f61f9c0e) and Router
 * (0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf) were deployed from this repo's
 * PRE-FIX source. Commit 8344791 ("Fix fee-on-transfer accounting, JWT secret
 * fallback, graduation price bug, creator payment DoS (curve + router), indexer
 * freshness gate") fixed real bugs in IncentifiBondingCurve.sol / IncentifiSwapRouter.sol
 * — most notably a creator-payment DoS (a creator address that reverts on receiving
 * ETH could brick trading for everyone) and fee-on-transfer accounting. Neither
 * contract is upgradeable, and merging the fix to GitHub does not alter bytecode
 * already deployed on mainnet — a contract's code is immutable once deployed. The
 * only way to run the fixed logic on mainnet is a fresh deployment of both the
 * Factory (which itself `new`s IncentifiBondingCurve instances on every
 * registerExistingToken() call, so it must carry the fixed curve bytecode) and the
 * Router (which independently received the creator-payment-DoS fix).
 *
 * SAFETY: this broadcasts real transactions costing real ETH on REAL mainnet, and
 * the resulting contracts are immutable and permanent. It refuses to run unless ALL
 * of the following are explicitly set:
 *   - DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) — a funded Robinhood Chain mainnet key
 *   - DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET \
 *     npx hardhat run scripts/deploy-v3-fixed-factory-and-router.ts --network robinhoodMainnet
 *
 * RESUMING after a partial run (e.g. the Factory deployed fine but the script then hit
 * a transient RPC error waiting for its receipt, or errored before reaching the
 * Router): set EXISTING_FACTORY_ADDRESS to skip Factory deployment entirely and go
 * straight to the Router, wired to that address. The existing Factory's bytecode and
 * immutables are still independently re-verified on-chain before the Router is
 * deployed against it — this does not just trust the address you pass in.
 *
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET \
 *   EXISTING_FACTORY_ADDRESS=0x... \
 *     npx hardhat run scripts/deploy-v3-fixed-factory-and-router.ts --network robinhoodMainnet
 *
 * Output: prints a full JSON deployment report to stdout and writes it to
 * scripts/.v3-deployment-result.json — scripts/verify-v3-fix-mainnet.ts and
 * scripts/rewire-v3-factory-router.mjs both read the two new addresses from there
 * (or from V3_FACTORY_ADDRESS / V3_ROUTER_ADDRESS env vars, if set instead).
 */

import fs from 'node:fs';
import path from 'node:path';
import { network } from 'hardhat';
import { formatEther, getAddress } from 'viem';

const CHAIN_ID = 4663;

// Real, already-live, independently-verified addresses (see INTEGRATION.md /
// scripts/verify-factory.mjs) that this new deployment wires to. Unchanged by this
// redeploy — only the Factory and Router themselves are new.
const LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
const UNISWAP_V3_POSITION_MANAGER = getAddress('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3');
const UNISWAP_V3_FACTORY = getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
const UNISWAP_V3_SWAP_ROUTER02 = getAddress('0xcaf681a66D020601342297493863e78C959e5Cb2');

const RESULT_PATH = path.resolve('scripts', '.v3-deployment-result.json');

function requireConfirmation() {
  if (process.env.DEPLOY_CONFIRM !== 'I_UNDERSTAND_THIS_IS_MAINNET') {
    throw new Error(
      '\nRefusing to run: this deploys NEW, IMMUTABLE contracts to REAL Robinhood Chain ' +
      'mainnet using REAL ETH.\nSet DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET to proceed.\n'
    );
  }
  const key = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
  if (!key) {
    throw new Error('DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) env var is required to deploy.');
  }
}

async function main() {
  requireConfirmation();

  const { viem } = await network.create('robinhoodMainnet');
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`Chain ID mismatch! Expected ${CHAIN_ID} (Robinhood Chain mainnet), got ${chainId}.`);
  }

  const [deployer] = await viem.getWalletClients();
  const deployerAddress = deployer.account.address;
  const balanceBefore = await publicClient.getBalance({ address: deployerAddress });

  console.log('\n============================================================');
  console.log('[DEPLOY v3] Robinhood Chain MAINNET (Chain ID 4663)');
  console.log('============================================================');
  console.log(`Deployer:        ${deployerAddress}`);
  console.log(`Balance before:  ${formatEther(balanceBefore)} ETH`);
  console.log(`LossRewardPool:  ${LOSS_REWARD_POOL} (unchanged, real, already live)`);
  console.log(`WETH:            ${WETH} (unchanged, real, already live)`);
  console.log(`PositionManager: ${UNISWAP_V3_POSITION_MANAGER} (unchanged, real, already live)`);
  console.log(`UniswapFactory:  ${UNISWAP_V3_FACTORY} (unchanged, real, already live)`);
  console.log(`SwapRouter02:    ${UNISWAP_V3_SWAP_ROUTER02} (unchanged, real, already live)`);
  console.log('============================================================\n');

  if (balanceBefore === 0n) {
    throw new Error(`Deployer ${deployerAddress} has zero ETH balance on mainnet. Fund it before deploying.`);
  }

  // ------------------------------------------------------------------------
  // 1. IncentifiBondingCurveFactory — deploy fresh, or reuse an already-deployed one
  // ------------------------------------------------------------------------
  const existingFactoryAddress = process.env.EXISTING_FACTORY_ADDRESS
    ? getAddress(process.env.EXISTING_FACTORY_ADDRESS)
    : null;

  let factory;
  let factoryAddress: `0x${string}`;
  let factoryTxHash: string | null = null;
  let factoryBlockNumber: bigint | null = null;
  let factoryGasUsed: bigint | null = null;

  async function verifyFactoryOnChain(candidate: typeof factory, address: `0x${string}`) {
    const code = await publicClient.getCode({ address });
    if (!code || code === '0x') {
      throw new Error(`Factory has EMPTY code at ${address}. Aborting before deploying the Router.`);
    }
    console.log(`  eth_getCode: NON-EMPTY (${(code.length - 2) / 2} bytes)`);

    const [readLossRewardPool, readWeth, readPositionManager, readUniswapFactory] = await Promise.all([
      candidate.read.lossRewardPool(),
      candidate.read.weth(),
      candidate.read.positionManager(),
      candidate.read.uniswapFactory(),
    ]);
    const ok =
      getAddress(readLossRewardPool) === LOSS_REWARD_POOL &&
      getAddress(readWeth) === WETH &&
      getAddress(readPositionManager) === UNISWAP_V3_POSITION_MANAGER &&
      getAddress(readUniswapFactory) === UNISWAP_V3_FACTORY;
    if (!ok) {
      throw new Error(
        `Factory immutables do not match expected constructor args.\n` +
        `  lossRewardPool:  got ${readLossRewardPool}, expected ${LOSS_REWARD_POOL}\n` +
        `  weth:            got ${readWeth}, expected ${WETH}\n` +
        `  positionManager: got ${readPositionManager}, expected ${UNISWAP_V3_POSITION_MANAGER}\n` +
        `  uniswapFactory:  got ${readUniswapFactory}, expected ${UNISWAP_V3_FACTORY}`
      );
    }
    console.log('  Immutables read back on-chain: MATCH\n');
  }

  if (existingFactoryAddress) {
    console.log(`[1/2] EXISTING_FACTORY_ADDRESS set — reusing ${existingFactoryAddress}, skipping Factory deployment.`);
    factoryAddress = existingFactoryAddress;
    factory = await viem.getContractAt('IncentifiBondingCurveFactory', factoryAddress);
    // Same on-chain confirmation a fresh deploy gets — this does not just trust the
    // address it was given; a wrong or unrelated address here is caught before any
    // ETH is spent deploying a Router wired to it.
    await verifyFactoryOnChain(factory, factoryAddress);
  } else {
    console.log('[1/2] Deploying IncentifiBondingCurveFactory...');
    const { contract, deploymentTransaction: factoryTx } = await viem.sendDeploymentTransaction(
      'IncentifiBondingCurveFactory',
      [LOSS_REWARD_POOL, WETH, UNISWAP_V3_POSITION_MANAGER, UNISWAP_V3_FACTORY]
    );
    factory = contract;
    console.log(`  Tx sent: ${factoryTx.hash}`);
    const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryTx.hash, confirmations: 1 });
    if (factoryReceipt.status !== 'success') {
      throw new Error(`Factory deployment transaction reverted (status: ${factoryReceipt.status}). Tx: ${factoryTx.hash}`);
    }
    factoryAddress = getAddress(factoryReceipt.contractAddress!);
    factoryTxHash = factoryTx.hash;
    factoryBlockNumber = factoryReceipt.blockNumber;
    factoryGasUsed = factoryReceipt.gasUsed;
    console.log(`  Confirmed in block #${factoryReceipt.blockNumber}, gas used: ${factoryReceipt.gasUsed}`);
    console.log(`  Factory address: ${factoryAddress}`);

    // On-chain confirmation: real bytecode present + immutables match what we just
    // constructed it with, not just "the receipt didn't revert".
    await verifyFactoryOnChain(factory, factoryAddress);
  }

  // ------------------------------------------------------------------------
  // 2. Deploy IncentifiSwapRouter, wired to the NEW factory address above
  // ------------------------------------------------------------------------
  console.log('[2/2] Deploying IncentifiSwapRouter (wired to new factory)...');
  const { contract: router, deploymentTransaction: routerTx } = await viem.sendDeploymentTransaction(
    'IncentifiSwapRouter',
    [UNISWAP_V3_SWAP_ROUTER02, WETH, LOSS_REWARD_POOL, factoryAddress]
  );
  console.log(`  Tx sent: ${routerTx.hash}`);
  const routerReceipt = await publicClient.waitForTransactionReceipt({ hash: routerTx.hash, confirmations: 1 });
  if (routerReceipt.status !== 'success') {
    throw new Error(`Router deployment transaction reverted (status: ${routerReceipt.status}). Tx: ${routerTx.hash}`);
  }
  const routerAddress = getAddress(routerReceipt.contractAddress!);
  console.log(`  Confirmed in block #${routerReceipt.blockNumber}, gas used: ${routerReceipt.gasUsed}`);
  console.log(`  Router address: ${routerAddress}`);

  const routerCode = await publicClient.getCode({ address: routerAddress });
  if (!routerCode || routerCode === '0x') {
    throw new Error(`Router has EMPTY code at ${routerAddress} despite a successful receipt.`);
  }
  console.log(`  eth_getCode: NON-EMPTY (${(routerCode.length - 2) / 2} bytes)`);

  const [readUniswapRouter, readRouterWeth, readRouterLossPool, readBondingCurveFactory] = await Promise.all([
    router.read.uniswapRouter(),
    router.read.WETH9(),
    router.read.lossRewardPool(),
    router.read.bondingCurveFactory(),
  ]);
  const routerImmutablesOk =
    getAddress(readUniswapRouter) === UNISWAP_V3_SWAP_ROUTER02 &&
    getAddress(readRouterWeth) === WETH &&
    getAddress(readRouterLossPool) === LOSS_REWARD_POOL &&
    getAddress(readBondingCurveFactory) === factoryAddress;
  if (!routerImmutablesOk) {
    throw new Error(
      `Router immutables do not match expected constructor args.\n` +
      `  uniswapRouter:       got ${readUniswapRouter}, expected ${UNISWAP_V3_SWAP_ROUTER02}\n` +
      `  WETH9:               got ${readRouterWeth}, expected ${WETH}\n` +
      `  lossRewardPool:      got ${readRouterLossPool}, expected ${LOSS_REWARD_POOL}\n` +
      `  bondingCurveFactory: got ${readBondingCurveFactory}, expected ${factoryAddress}`
    );
  }
  console.log('  Immutables read back on-chain: MATCH\n');

  const balanceAfter = await publicClient.getBalance({ address: deployerAddress });
  const gasSpentWei = balanceBefore - balanceAfter;

  const result = {
    chainId,
    deployer: deployerAddress,
    factory: {
      address: factoryAddress,
      reused: Boolean(existingFactoryAddress),
      txHash: factoryTxHash,
      blockNumber: factoryBlockNumber !== null ? factoryBlockNumber.toString() : null,
      gasUsed: factoryGasUsed !== null ? factoryGasUsed.toString() : null,
      constructorArgs: {
        lossRewardPool: LOSS_REWARD_POOL,
        weth: WETH,
        positionManager: UNISWAP_V3_POSITION_MANAGER,
        uniswapFactory: UNISWAP_V3_FACTORY,
      },
    },
    router: {
      address: routerAddress,
      txHash: routerTx.hash,
      blockNumber: routerReceipt.blockNumber.toString(),
      gasUsed: routerReceipt.gasUsed.toString(),
      constructorArgs: {
        uniswapRouter: UNISWAP_V3_SWAP_ROUTER02,
        weth: WETH,
        lossRewardPool: LOSS_REWARD_POOL,
        bondingCurveFactory: factoryAddress,
      },
    },
    oldFactory: '0x9fcea653c6f31c82606582b22da82b39f61f9c0e',
    oldRouter: '0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf',
    gasSpentWei: gasSpentWei.toString(),
    gasSpentEth: formatEther(gasSpentWei),
    deployedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));

  console.log('============================================================');
  console.log('[DEPLOY v3] COMPLETE — both contracts confirmed on-chain with matching immutables');
  console.log('============================================================');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSaved to ${RESULT_PATH}`);
  console.log('\nNEXT STEPS:');
  console.log('  1. node scripts/verify-v3-fix-mainnet.ts   (launch+trade a real test token through these contracts)');
  console.log('  2. node scripts/rewire-v3-factory-router.mjs   (point the app + workers at the new addresses)');
}

main().catch((err) => {
  console.error('\n[DEPLOY v3 ERROR]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
