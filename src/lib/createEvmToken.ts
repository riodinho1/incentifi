import { encodeFunctionData, parseAbi, getAddress } from 'viem';
import {
  EVM_ADDRESS_URL,
  EVM_CHAIN_NAME,
  EVM_TX_URL,
  ensureEvmChain,
  getEvmProvider,
  requestEvmAccounts,
  waitForTransactionReceipt,
} from './evmNetwork';
import { INCENTIFI_LAUNCH_TOKEN_BYTECODE } from './incentifiLaunchTokenBytecode';
import { INCENTIFI_V4_FACTORY, INCENTIFI_V4_HOOK } from './uniswapAddresses';

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

// V4: IncentifiV4Factory.launchToken() replaces registerExistingToken() — one
// call, no separate `creator` arg (it reads msg.sender and cross-checks it
// against token.creator() itself). isLaunched() replaces getBondingCurve() for
// post-launch verification — V4 has no per-token curve contract to look up;
// the launch either registered successfully or it didn't.
const FACTORY_V4_ABI = parseAbi([
  'function launchToken(address token) returns (bytes32 poolId)',
  'function isLaunched(address token) view returns (bool)',
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

const waitForReceipt = (txHash: string, description: string = 'Transaction') =>
  waitForTransactionReceipt(txHash, { description });

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
  // STEP 2/3: Authorize the V4 Factory (Approve 1B Supply)
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
    args: [INCENTIFI_V4_FACTORY, TOTAL_SUPPLY],
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
  // STEP 3/3: Launch on the V4 Factory (registers the token + initializes its
  // pool against the shared hook in one call — no separate curve deployment)
  // --------------------------------------------------------------------------
  onProgress?.(
    3,
    3,
    'Initializing Incentifi Bonding Curve',
    `Please confirm the final transaction to deploy and activate the bonding curve on Robinhood Chain.`
  );

  const launchData = encodeFunctionData({
    abi: FACTORY_V4_ABI,
    functionName: 'launchToken',
    args: [tokenAddress],
  });

  const launchTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: account,
        to: INCENTIFI_V4_FACTORY,
        data: launchData,
      },
    ],
  });

  await waitForReceipt(launchTxHash, 'Bonding curve initialization');

  // --------------------------------------------------------------------------
  // VERIFICATION: confirm the factory registered the launch, and that the full
  // 1B supply actually landed on the shared hook (V4 has no per-token curve
  // contract to look up — IncentifiV4Hook._beforeInitialize already enforces
  // this same balance check on-chain before the pool activates at all; this
  // re-confirms it independently rather than just trusting the tx didn't revert).
  // --------------------------------------------------------------------------
  const isLaunchedData = encodeFunctionData({
    abi: FACTORY_V4_ABI,
    functionName: 'isLaunched',
    args: [tokenAddress],
  });

  const isLaunchedRes = await provider.request({
    method: 'eth_call',
    params: [{ to: INCENTIFI_V4_FACTORY, data: isLaunchedData }, 'latest'],
  });

  if (BigInt(isLaunchedRes || '0x0') !== 1n) {
    throw new Error('Bonding curve initialization transaction succeeded, but Factory.isLaunched() still reports false.');
  }

  const balanceData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'balanceOf',
    args: [INCENTIFI_V4_HOOK],
  });

  const balRes = await provider.request({
    method: 'eth_call',
    params: [{ to: tokenAddress, data: balanceData }, 'latest'],
  });

  const hookTokenBalance = BigInt(balRes || '0x0');
  if (hookTokenBalance !== TOTAL_SUPPLY) {
    throw new Error(
      `Bonding curve token balance verification failed: expected ${TOTAL_SUPPLY} tokens on the hook, but found ${hookTokenBalance}.`
    );
  }

  return {
    mint: tokenAddress,
    // V4 has no per-token curve contract — every launched token's pool state
    // lives in the shared hook's own curveStates mapping instead of a
    // dedicated address. Left null (not omitted) so callers see explicitly
    // that this field doesn't apply anymore, rather than reading undefined.
    curveAddress: null as `0x${string}` | null,
    hookAddress: INCENTIFI_V4_HOOK,
    creatorAddress: account,
    chain: EVM_CHAIN_NAME,
    txExplorer: EVM_TX_URL(deployTxHash),
    explorer: EVM_ADDRESS_URL(tokenAddress),
    curveExplorer: EVM_ADDRESS_URL(INCENTIFI_V4_HOOK),
    launchPayment: null,
  };
};
