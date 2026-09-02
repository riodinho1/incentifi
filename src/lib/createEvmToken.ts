import { encodeFunctionData, parseAbi, getAddress } from 'viem';
import {
  EVM_ADDRESS_URL,
  EVM_CHAIN_NAME,
  EVM_TX_URL,
  ensureEvmChain,
  getEvmProvider,
  requestEvmAccounts,
} from './evmNetwork';
import { INCENTIFI_LAUNCH_TOKEN_BYTECODE } from './incentifiLaunchTokenBytecode';
import { INCENTIFI_BONDING_CURVE_FACTORY } from './uniswapAddresses';

export type CreateEvmTokenProgressCallback = (
  step: number,
  total: number,
  title: string,
  description: string
) => void;

type CreateEvmTokenInput = {
  tokenName: string;
  tokenSymbol: string;
  onProgress?: CreateEvmTokenProgressCallback;
};

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n; // 1 Billion tokens with 18 decimals

const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

const FACTORY_REGISTER_ABI = parseAbi([
  'function registerExistingToken(address token, address creator) returns (address curve)',
  'function getBondingCurve(address token) view returns (address)',
]);

const strip0x = (value: string) => value.replace(/^0x/i, '');

const padHex = (value: string) => value.padStart(64, '0');

const encodeUint256 = (value: bigint) => padHex(value.toString(16));

const encodeUtf8 = (value: string) =>
  Array.from(new TextEncoder().encode(value))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const encodeDynamicString = (value: string) => {
  const hex = encodeUtf8(value);
  const byteLength = hex.length / 2;
  const paddedLength = Math.ceil(byteLength / 32) * 64;
  return `${encodeUint256(BigInt(byteLength))}${hex.padEnd(paddedLength, '0')}`;
};

const encodeConstructor = (name: string, symbol: string, supply: bigint) => {
  const encodedName = encodeDynamicString(name);
  const encodedSymbol = encodeDynamicString(symbol);
  const nameOffset = 96n;
  const symbolOffset = nameOffset + BigInt(encodedName.length / 2);

  return [
    encodeUint256(nameOffset),
    encodeUint256(symbolOffset),
    encodeUint256(supply),
    encodedName,
    encodedSymbol,
  ].join('');
};

const waitForReceipt = async (txHash: string, description: string = 'Transaction') => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Wallet provider disappeared while waiting for launch.');

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });

    if (receipt) {
      if (receipt.status === '0x0' || receipt.status === 0 || receipt.status === 0n) {
        throw new Error(`${description} reverted on-chain.`);
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`${description} was submitted, but confirmation timed out.`);
};

export const createEvmToken = async (_provider: any, input: CreateEvmTokenInput) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Install an EVM wallet before creating a token.');

  await ensureEvmChain();
  const rawAccount = await requestEvmAccounts();
  const account = getAddress(rawAccount);
  const name = input.tokenName.trim().slice(0, 32);
  const symbol = input.tokenSymbol.trim().toUpperCase().slice(0, 10);
  const onProgress = input.onProgress;

  // --------------------------------------------------------------------------
  // STEP 1/3: Deploy ERC-20 Token (1B Fixed Supply)
  // --------------------------------------------------------------------------
  onProgress?.(
    1,
    3,
    'Deploying ERC-20 Token Contract',
    `Please confirm the token creation transaction in your wallet for $${symbol}.`
  );

  const data = `${strip0x(INCENTIFI_LAUNCH_TOKEN_BYTECODE)}${encodeConstructor(
    name,
    symbol,
    TOTAL_SUPPLY
  )}`;

  const deployTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: account,
        data: `0x${data}`,
      },
    ],
  });

  const deployReceipt = await waitForReceipt(deployTxHash, 'Token deployment');
  const tokenAddress = getAddress(deployReceipt.contractAddress as string);

  // --------------------------------------------------------------------------
  // STEP 2/3: Authorize Bonding Curve Factory (Approve 1B Supply)
  // --------------------------------------------------------------------------
  onProgress?.(
    2,
    3,
    'Authorizing Factory for Bonding Curve',
    `Please confirm the token approval in your wallet to deposit the 1B supply into the bonding curve.`
  );

  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [INCENTIFI_BONDING_CURVE_FACTORY, TOTAL_SUPPLY],
  });

  const approveTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: account,
        to: tokenAddress,
        data: approveData,
      },
    ],
  });

  await waitForReceipt(approveTxHash, 'Factory approval');

  // --------------------------------------------------------------------------
  // STEP 3/3: Initialize Incentifi Bonding Curve
  // --------------------------------------------------------------------------
  onProgress?.(
    3,
    3,
    'Initializing Incentifi Bonding Curve',
    `Please confirm the final transaction to deploy and activate the bonding curve on Robinhood Chain.`
  );

  const registerData = encodeFunctionData({
    abi: FACTORY_REGISTER_ABI,
    functionName: 'registerExistingToken',
    args: [tokenAddress, account],
  });

  const registerTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: account,
        to: INCENTIFI_BONDING_CURVE_FACTORY,
        data: registerData,
      },
    ],
  });

  await waitForReceipt(registerTxHash, 'Bonding curve initialization');

  // --------------------------------------------------------------------------
  // VERIFICATION: Verify Curve on-chain and confirm 1B inventory
  // --------------------------------------------------------------------------
  const getCurveData = encodeFunctionData({
    abi: FACTORY_REGISTER_ABI,
    functionName: 'getBondingCurve',
    args: [tokenAddress],
  });

  const curveRes = await provider.request({
    method: 'eth_call',
    params: [{ to: INCENTIFI_BONDING_CURVE_FACTORY, data: getCurveData }, 'latest'],
  });

  const curveAddress = (curveRes && curveRes.length >= 66
    ? getAddress(`0x${curveRes.slice(26)}`)
    : null) as `0x${string}` | null;

  if (!curveAddress || curveAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error('Bonding curve was created, but Factory lookup returned a zero address.');
  }

  // Verify curve holds the 1B tokens
  const balanceData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'balanceOf',
    args: [curveAddress],
  });

  const balRes = await provider.request({
    method: 'eth_call',
    params: [{ to: tokenAddress, data: balanceData }, 'latest'],
  });

  const curveTokenBalance = BigInt(balRes || '0x0');
  if (curveTokenBalance !== TOTAL_SUPPLY) {
    throw new Error(
      `Bonding curve token balance verification failed: expected ${TOTAL_SUPPLY} tokens, but found ${curveTokenBalance}.`
    );
  }

  return {
    mint: tokenAddress,
    curveAddress,
    creatorAddress: account,
    chain: EVM_CHAIN_NAME,
    txExplorer: EVM_TX_URL(deployTxHash),
    explorer: EVM_ADDRESS_URL(tokenAddress),
    curveExplorer: EVM_ADDRESS_URL(curveAddress),
    launchPayment: null,
  };
};
