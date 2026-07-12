import {
  EVM_ADDRESS_URL,
  EVM_CHAIN_NAME,
  EVM_TX_URL,
  ensureEvmChain,
  getEvmProvider,
  requestEvmAccounts,
} from './evmNetwork';
import { INCENTIFI_LAUNCH_TOKEN_BYTECODE } from './incentifiLaunchTokenBytecode';

type CreateEvmTokenInput = {
  tokenName: string;
  tokenSymbol: string;
};

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

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

const waitForReceipt = async (txHash: string) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Wallet provider disappeared while waiting for launch.');

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });

    if (receipt?.contractAddress) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error('Token deployment was submitted, but confirmation timed out.');
};

export const createEvmToken = async (_provider: any, input: CreateEvmTokenInput) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Install an EVM wallet before creating a token.');

  await ensureEvmChain();
  const account = await requestEvmAccounts();
  const name = input.tokenName.trim().slice(0, 32);
  const symbol = input.tokenSymbol.trim().toUpperCase().slice(0, 10);

  const data = `${strip0x(INCENTIFI_LAUNCH_TOKEN_BYTECODE)}${encodeConstructor(
    name,
    symbol,
    TOTAL_SUPPLY
  )}`;

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: account,
        data: `0x${data}`,
      },
    ],
  });

  const receipt = await waitForReceipt(txHash);
  const contractAddress = receipt.contractAddress as string;

  return {
    mint: contractAddress,
    creatorAddress: account,
    chain: EVM_CHAIN_NAME,
    txExplorer: EVM_TX_URL(txHash),
    explorer: EVM_ADDRESS_URL(contractAddress),
    launchPayment: null,
  };
};
