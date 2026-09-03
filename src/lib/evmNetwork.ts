import { createPublicClient, http, defineChain } from 'viem';

export const LAUNCH_CHAIN_MODE = 'robinhood';

export const IS_ROBINHOOD_CHAIN_MODE = true;

export const EVM_CHAIN_NAME = String(
  import.meta.env.VITE_EVM_CHAIN_NAME || 'Robinhood Chain'
);

export const EVM_CHAIN_ID_DECIMAL = Number(import.meta.env.VITE_EVM_CHAIN_ID || 4663);
export const EVM_CHAIN_ID_HEX = `0x${EVM_CHAIN_ID_DECIMAL.toString(16)}`;

// Guardrail against a misconfigured environment silently pointing the app at
// the wrong chain: every contract address in this codebase is hardcoded to
// Robinhood Chain (4663) deployments, so a chain ID override (e.g. an
// accidental VITE_EVM_CHAIN_ID=1 from a copy-pasted .env) would otherwise
// fail confusingly deep inside a swap instead of at startup.
if (IS_ROBINHOOD_CHAIN_MODE && EVM_CHAIN_ID_DECIMAL !== 4663) {
  throw new Error(
    `Robinhood Chain mode is enabled but the resolved chain ID is ${EVM_CHAIN_ID_DECIMAL} (expected 4663). ` +
      'Check the VITE_EVM_CHAIN_ID environment variable.'
  );
}

export const EVM_RPC_URL = String(
  import.meta.env.VITE_EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
).trim();

// Kept aligned with the canonical explorer documented in INTEGRATION.md and
// src/lib/integration/index.ts's ROBINHOOD_EXPLORER_URL — do not diverge here
// without updating those too.
export const EVM_EXPLORER_URL = String(
  import.meta.env.VITE_EVM_EXPLORER_URL || 'https://explorer.mainnet.chain.robinhood.com'
).replace(/\/$/, '');

export const EVM_NATIVE_SYMBOL = String(import.meta.env.VITE_EVM_NATIVE_SYMBOL || 'ETH');

export const EVM_ADDRESS_URL = (address: string) => `${EVM_EXPLORER_URL}/address/${address}`;
export const EVM_TX_URL = (txHash: string) =>
  `${EVM_EXPLORER_URL}/tx/${(txHash || '').split(/[:_#-]/)[0]}`;

export const robinhoodChain = defineChain({
  id: EVM_CHAIN_ID_DECIMAL,
  name: EVM_CHAIN_NAME,
  nativeCurrency: {
    name: EVM_NATIVE_SYMBOL,
    symbol: EVM_NATIVE_SYMBOL,
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [EVM_RPC_URL],
    },
    public: {
      http: [EVM_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: EVM_EXPLORER_URL,
    },
  },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(EVM_RPC_URL, {
    batch: true,
    retryCount: 3,
    retryDelay: 1000,
  }),
});

export const getEvmProvider = () =>
  typeof window !== 'undefined' ? (window as any).ethereum : undefined;

/**
 * Polls for a transaction receipt via the connected wallet provider.
 * Shared by swap.ts, bondingCurve.ts, and createEvmToken.ts, which all
 * previously carried near-identical copies of this polling loop.
 *
 * @param txHash Transaction hash to wait on.
 * @param options.description Optional label used in the default revert/timeout
 *   messages (e.g. "Token deployment"). Omit to get the original generic
 *   trade-confirmation wording used by swap.ts/bondingCurve.ts.
 * @param options.revertedMessage Overrides the on-revert error message entirely.
 * @param options.timeoutMessage Overrides the on-timeout error message entirely.
 */
export const waitForTransactionReceipt = async (
  txHash: string,
  options?: { description?: string; revertedMessage?: string; timeoutMessage?: string }
) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Wallet provider disappeared while waiting for confirmation.');

  const description = options?.description;
  const revertedMessage =
    options?.revertedMessage ??
    (description ? `${description} reverted on-chain.` : 'Transaction reverted on-chain. No trade was executed.');
  const timeoutMessage =
    options?.timeoutMessage ??
    (description ? `${description} was submitted, but confirmation timed out.` : 'Transaction was submitted, but confirmation timed out.');

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (receipt) {
      if (receipt.status === '0x0' || receipt.status === 0 || receipt.status === 0n) {
        throw new Error(revertedMessage);
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(timeoutMessage);
};

export const requestEvmAccounts = async () => {
  const provider = getEvmProvider();
  if (!provider) {
    throw new Error('Install an EVM wallet such as MetaMask, Rabby, or Robinhood Wallet.');
  }

  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const account = accounts?.[0];
  if (!account) throw new Error('No wallet account selected.');
  return account as string;
};

export const ensureEvmChain = async () => {
  const provider = getEvmProvider();
  if (!provider) {
    throw new Error('Install an EVM wallet such as MetaMask, Rabby, or Robinhood Wallet.');
  }

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: EVM_CHAIN_ID_HEX }],
    });
  } catch (error: any) {
    if (error?.code !== 4902) throw error;

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: EVM_CHAIN_ID_HEX,
          chainName: EVM_CHAIN_NAME,
          nativeCurrency: {
            name: EVM_NATIVE_SYMBOL,
            symbol: EVM_NATIVE_SYMBOL,
            decimals: 18,
          },
          rpcUrls: [EVM_RPC_URL],
          blockExplorerUrls: [EVM_EXPLORER_URL],
        },
      ],
    });
  }
};
