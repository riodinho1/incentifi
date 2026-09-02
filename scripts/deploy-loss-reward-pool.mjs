/**
 * Deployment Script for LossRewardPool.sol on Robinhood Chain Mainnet (Chain ID: 4663)
 *
 * Usage:
 *   Dry-Run (Safe, no broadcast):
 *     node scripts/deploy-loss-reward-pool.mjs --dry-run
 *
 *   Execute Deployment (Requires explicit approval and DEPLOYER_PRIVATE_KEY):
 *     DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-loss-reward-pool.mjs --execute
 */

import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Lightweight .env loader (avoids external dependency)
function loadEnv() {
  const envFiles = ['.env', '.env.local'];
  for (const file of envFiles) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}
loadEnv();

const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;

export function compileLossRewardPool() {
  const contractPath = path.resolve('contracts', 'LossRewardPool.sol');
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      'LossRewardPool.sol': {
        content: source,
      },
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const fatalErrors = output.errors.filter((e) => e.severity === 'error');
    if (fatalErrors.length > 0) {
      console.error('Solidity compilation errors:', fatalErrors);
      throw new Error(`Solidity compilation failed: ${fatalErrors[0].formattedMessage}`);
    }
  }

  const contract = output.contracts['LossRewardPool.sol']['LossRewardPool'];
  return {
    abi: contract.abi,
    bytecode: '0x' + contract.evm.bytecode.object,
    deployedBytecode: '0x' + contract.evm.deployedBytecode.object,
  };
}

export async function prepareDeployment({ operatorAddress = '0x0000000000000000000000000000000000000000' } = {}) {
  const { abi, bytecode, deployedBytecode } = compileLossRewardPool();

  const constructorArgs = encodeAbiParameters(
    parseAbiParameters('address _operator'),
    [operatorAddress]
  );
  const deployData = `${bytecode}${constructorArgs.slice(2)}`;

  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`Chain ID mismatch! Expected ${CHAIN_ID}, got ${chainId}`);
  }

  const block = await publicClient.getBlock({ blockTag: 'latest' });
  const gasPrice = await publicClient.getGasPrice();
  const feeData = await publicClient.estimateFeesPerGas();

  // Estimate gas with a placeholder or deployer account
  let deployerAddress = null;
  let deployerBalance = null;

  const rawKey = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
  if (rawKey) {
    const formattedKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
    const account = privateKeyToAccount(formattedKey);
    deployerAddress = account.address;
    deployerBalance = await publicClient.getBalance({ address: deployerAddress });
  }

  const gasEstimate = await publicClient.estimateGas({
    account: deployerAddress || '0x000000000000000000000000000000000000dead',
    data: deployData,
  });

  const effectiveGasPrice = feeData.maxFeePerGas || gasPrice;
  const estimatedCostWei = gasEstimate * effectiveGasPrice;

  return {
    chainId,
    currentBlockNumber: block.number,
    operatorAddress,
    deployerAddress,
    deployerBalance: deployerBalance ? formatEther(deployerBalance) : null,
    abi,
    bytecode,
    deployedBytecode,
    constructorArgs,
    deployData,
    gasEstimate,
    gasPrice,
    maxFeePerGas: feeData.maxFeePerGas || gasPrice,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 0n,
    estimatedCostWei,
    estimatedCostEth: formatEther(estimatedCostWei),
  };
}

export async function executeDeployment({ operatorAddress = '0x0000000000000000000000000000000000000000' } = {}) {
  const rawKey = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
  if (!rawKey) {
    throw new Error('DEPLOYER_PRIVATE_KEY environment variable is required to execute deployment.');
  }

  const formattedKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
  const account = privateKeyToAccount(formattedKey);

  const { bytecode, abi } = compileLossRewardPool();
  const constructorArgs = encodeAbiParameters(
    parseAbiParameters('address _operator'),
    [operatorAddress]
  );
  const fullData = `${bytecode}${constructorArgs.slice(2)}`;

  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`Chain ID mismatch! Expected ${CHAIN_ID}, got ${chainId}`);
  }

  // Pre-flight balance & gas verification
  const balance = await publicClient.getBalance({ address: account.address });
  const gasPrice = await publicClient.getGasPrice();
  const feeData = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = feeData.maxFeePerGas || gasPrice;

  const gasEstimate = await publicClient.estimateGas({
    account: account.address,
    data: fullData,
  });
  const estimatedCost = gasEstimate * maxFeePerGas;

  console.log(`\n========================================`);
  console.log(`[PRE-FLIGHT CHECK] Deployer Account: ${account.address}`);
  console.log(`[PRE-FLIGHT CHECK] Current Balance: ${formatEther(balance)} ETH`);
  console.log(`[PRE-FLIGHT CHECK] Estimated Deployment Cost: ${formatEther(estimatedCost)} ETH`);

  if (balance < estimatedCost) {
    throw new Error(`Insufficient funds! Deployer account ${account.address} has ${formatEther(balance)} ETH, but estimated cost is ${formatEther(estimatedCost)} ETH.`);
  }
  console.log(`[PRE-FLIGHT CHECK] Balance check PASSED (sufficient ETH for gas).`);
  console.log(`========================================\n`);

  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
  });

  console.log(`Broadcasting deployment transaction to Robinhood Chain Mainnet (Chain ID: ${CHAIN_ID})...`);

  const txHash = await walletClient.sendTransaction({
    data: fullData,
  });

  console.log(`Transaction sent! Tx Hash: ${txHash}`);
  console.log('Waiting for transaction confirmation...');

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  const contractAddress = receipt.contractAddress;
  console.log(`Transaction confirmed in block #${receipt.blockNumber}`);
  console.log(`Deployed Contract Address: ${contractAddress}`);
  console.log(`Gas Used: ${receipt.gasUsed.toString()}`);

  // Verify bytecode is present at the new contract address
  const deployedCode = await publicClient.getCode({
    address: contractAddress,
  });

  const isCodeNonEmpty = Boolean(deployedCode && deployedCode !== '0x' && deployedCode.length > 2);
  console.log(`eth_getCode Verification: ${isCodeNonEmpty ? 'NON-EMPTY (SUCCESS)' : 'EMPTY (FAILED)'}`);

  return {
    txHash,
    contractAddress,
    blockNumber: receipt.blockNumber,
    deployerAddress: account.address,
    constructorArgument: operatorAddress,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    isCodeNonEmpty,
    codeLength: deployedCode ? (deployedCode.length - 2) / 2 : 0,
  };
}

// CLI Execution handler
if (process.argv[1]?.includes('deploy-loss-reward-pool.mjs')) {
  const isExecute = process.argv.includes('--execute');

  if (isExecute) {
    executeDeployment()
      .then((res) => {
        console.log('\n=== DEPLOYMENT RESULT ===');
        console.log(JSON.stringify(res, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error('\n[DEPLOYMENT ERROR]:', err.message);
        process.exit(1);
      });
  } else {
    prepareDeployment()
      .then((prep) => {
        console.log('\n=== DEPLOYMENT PREPARATION SUMMARY ===');
        console.log(`Network: Robinhood Chain Mainnet (Chain ID: ${prep.chainId})`);
        console.log(`RPC Endpoint: ${RPC_URL}`);
        console.log(`Current Block Number: ${prep.currentBlockNumber}`);
        console.log(`Deployer Address: ${prep.deployerAddress || '(Not set in env yet)'}`);
        if (prep.deployerBalance) console.log(`Deployer Balance: ${prep.deployerBalance} ETH`);
        console.log(`Constructor Argument (_operator): ${prep.operatorAddress}`);
        console.log(`Creation Bytecode Size: ${(prep.bytecode.length - 2) / 2} bytes`);
        console.log(`Full Deploy Data Size: ${(prep.deployData.length - 2) / 2} bytes`);
        console.log(`Estimated Gas Units: ${prep.gasEstimate.toString()}`);
        console.log(`Gas Price: ${(Number(prep.gasPrice) / 1e9).toFixed(4)} Gwei`);
        console.log(`Estimated Cost: ${prep.estimatedCostEth} ETH`);
        console.log('=======================================\n');
      })
      .catch((err) => {
        console.error('[PREPARATION ERROR]:', err.message);
        process.exit(1);
      });
  }
}
