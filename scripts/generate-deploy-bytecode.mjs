#!/usr/bin/env node
/**
 * Regenerates src/lib/incentifiBondingCurveFactoryBytecode.ts and
 * src/lib/incentifiSwapRouterBytecode.ts (ABI + creation/deployed bytecode +
 * constructor-args-encoded deploy data) from this repo's CURRENT contracts/*.sol
 * source, using the `solc` npm package directly (Solidity 0.8.26, optimizer enabled,
 * 200 runs — matching this repo's hardhat.config.ts `solidity: '0.8.26'` setting and
 * the existing files' own header comment).
 *
 * These two files are what src/pages/deploy/page.tsx ships to the browser for its
 * own from-scratch "deploy Factory/Router via a connected wallet" flow — so they
 * need to be regenerated (not just the on-chain Robinhood Chain mainnet deployment
 * from deploy-v3-fixed-factory-and-router.ts) whenever the Factory/Router source
 * changes, or that browser flow keeps shipping stale/vulnerable bytecode even after
 * a mainnet redeploy.
 *
 * Why `solc` directly and not `npx hardhat compile`: identical compiler version and
 * optimizer settings, but Hardhat needs to download its solc binary from
 * binaries.soliditylang.org on first use, which isn't reachable from every
 * environment (e.g. network-sandboxed CI/agent runners) — the `solc` npm package
 * ships as a self-contained wasm build with no such runtime download, and is already
 * a project devDependency used the same way in deploy-loss-reward-pool.mjs.
 *
 * Usage:
 *   node scripts/generate-deploy-bytecode.mjs [--factory <address>]
 *
 *   --factory <address>   The IncentifiBondingCurveFactory address to bake into the
 *                          Router's own CONSTRUCTOR_ARGS / FULL_DEPLOY_DATA (its
 *                          `bondingCurveFactory` constructor arg). Defaults to
 *                          whatever INCENTIFI_BONDING_CURVE_FACTORY currently resolves
 *                          to in src/lib/uniswapAddresses.ts — i.e. re-run this AFTER
 *                          rewire-v3-factory-router.mjs (or pass --factory explicitly)
 *                          to point the browser deploy page's Router at a new Factory.
 */

import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { encodeAbiParameters, parseAbiParameters, getAddress } from 'viem';

// Stable, real, already-live addresses (unaffected by a Factory/Router redeploy).
const LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
const UNISWAP_V3_POSITION_MANAGER = getAddress('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3');
const UNISWAP_V3_FACTORY = getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
const UNISWAP_V3_SWAP_ROUTER02 = getAddress('0xcaf681a66D020601342297493863e78C959e5Cb2');

function resolveDefaultFactoryAddress() {
  const src = fs.readFileSync(path.resolve('src/lib/uniswapAddresses.ts'), 'utf8');
  const match = src.match(/INCENTIFI_BONDING_CURVE_FACTORY[\s\S]*?'(0x[0-9a-fA-F]{40})'/);
  if (!match) throw new Error('Could not locate INCENTIFI_BONDING_CURVE_FACTORY default address in src/lib/uniswapAddresses.ts');
  return getAddress(match[1]);
}

function compile(contractFileName, contractName, extraSources = {}) {
  const contractPath = path.resolve('contracts', contractFileName);
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      [contractFileName]: { content: source },
      ...extraSources,
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } },
    },
  };

  function findImports(importPath) {
    const resolved = path.resolve('contracts', importPath);
    if (fs.existsSync(resolved)) {
      return { contents: fs.readFileSync(resolved, 'utf8') };
    }
    return { error: `File not found: ${importPath}` };
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === 'error');
    if (fatal.length > 0) {
      console.error(fatal.map((e) => e.formattedMessage).join('\n'));
      throw new Error(`Solidity compilation failed for ${contractFileName}`);
    }
  }

  const contract = output.contracts[contractFileName][contractName];
  return {
    abi: contract.abi,
    creationBytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  };
}

function writeBytecodeFile({ outPath, contractFileName, abiExportName, creationExportName, deployedExportName, argsExportName, fullDataExportName, paramsExportName, compiled, constructorAbiParams, constructorArgs, paramsForDisplay }) {
  const encodedArgs = constructorAbiParams.length > 0
    ? encodeAbiParameters(parseAbiParameters(constructorAbiParams.join(', ')), constructorArgs)
    : '0x';
  const fullDeployData = `${compiled.creationBytecode}${encodedArgs.slice(2)}`;

  const paramsBody = Object.entries(paramsForDisplay)
    .map(([key, value]) => `  ${key}: '${value}',`)
    .join('\n');

  const content = `// Auto-generated compilation artifact for ${contractFileName}
// Compiler: Solidity 0.8.26 (Optimizer: enabled, 200 runs)
// Regenerated by scripts/generate-deploy-bytecode.mjs — do not hand-edit.

export const ${abiExportName} = ${JSON.stringify(compiled.abi, null, 2)} as const;

export const ${creationExportName} = '${compiled.creationBytecode}' as const;

export const ${deployedExportName} = '${compiled.deployedBytecode}' as const;

export const ${argsExportName} = '${encodedArgs}' as const;

export const ${fullDataExportName} = '${fullDeployData}' as const;

export const ${paramsExportName} = {
${paramsBody}
} as const;
`;

  fs.writeFileSync(path.resolve(outPath), content);
  console.log(`Wrote ${outPath} (creation: ${(compiled.creationBytecode.length - 2) / 2} bytes, full deploy data: ${(fullDeployData.length - 2) / 2} bytes)`);
}

function main() {
  const factoryArgIdx = process.argv.indexOf('--factory');
  const factoryAddress = factoryArgIdx !== -1 && process.argv[factoryArgIdx + 1]
    ? getAddress(process.argv[factoryArgIdx + 1])
    : resolveDefaultFactoryAddress();

  console.log('Compiling IncentifiBondingCurveFactory.sol (+ IncentifiBondingCurve.sol)...');
  const factoryCompiled = compile('IncentifiBondingCurveFactory.sol', 'IncentifiBondingCurveFactory');
  writeBytecodeFile({
    outPath: 'src/lib/incentifiBondingCurveFactoryBytecode.ts',
    contractFileName: 'IncentifiBondingCurveFactory.sol',
    abiExportName: 'INCENTIFI_FACTORY_ABI',
    creationExportName: 'INCENTIFI_FACTORY_CREATION_BYTECODE',
    deployedExportName: 'INCENTIFI_FACTORY_DEPLOYED_BYTECODE',
    argsExportName: 'INCENTIFI_FACTORY_CONSTRUCTOR_ARGS',
    fullDataExportName: 'INCENTIFI_FACTORY_FULL_DEPLOY_DATA',
    paramsExportName: 'FACTORY_CONSTRUCTOR_PARAMS',
    compiled: factoryCompiled,
    constructorAbiParams: ['address _lossRewardPool', 'address _weth', 'address _positionManager', 'address _uniswapFactory'],
    constructorArgs: [LOSS_REWARD_POOL, WETH, UNISWAP_V3_POSITION_MANAGER, UNISWAP_V3_FACTORY],
    paramsForDisplay: {
      lossRewardPool: LOSS_REWARD_POOL,
      weth: WETH,
      positionManager: UNISWAP_V3_POSITION_MANAGER,
      uniswapFactory: UNISWAP_V3_FACTORY,
    },
  });

  console.log('\nCompiling IncentifiSwapRouter.sol...');
  const routerCompiled = compile('IncentifiSwapRouter.sol', 'IncentifiSwapRouter');
  writeBytecodeFile({
    outPath: 'src/lib/incentifiSwapRouterBytecode.ts',
    contractFileName: 'IncentifiSwapRouter.sol',
    abiExportName: 'INCENTIFI_ROUTER_ABI',
    creationExportName: 'INCENTIFI_ROUTER_CREATION_BYTECODE',
    deployedExportName: 'INCENTIFI_ROUTER_DEPLOYED_BYTECODE',
    argsExportName: 'INCENTIFI_ROUTER_CONSTRUCTOR_ARGS',
    fullDataExportName: 'INCENTIFI_ROUTER_FULL_DEPLOY_DATA',
    paramsExportName: 'ROUTER_CONSTRUCTOR_PARAMS',
    compiled: routerCompiled,
    constructorAbiParams: ['address _uniswapRouter', 'address _weth', 'address _lossRewardPool', 'address _bondingCurveFactory'],
    constructorArgs: [UNISWAP_V3_SWAP_ROUTER02, WETH, LOSS_REWARD_POOL, factoryAddress],
    paramsForDisplay: {
      uniswapRouter: UNISWAP_V3_SWAP_ROUTER02,
      weth: WETH,
      lossRewardPool: LOSS_REWARD_POOL,
      bondingCurveFactory: factoryAddress,
    },
  });

  console.log(`\nRouter's bondingCurveFactory constructor arg: ${factoryAddress}`);
  console.log('(pass --factory <address>, or re-run after rewire-v3-factory-router.mjs updates');
  console.log(' src/lib/uniswapAddresses.ts, to point this at a different Factory.)');
}

main();
