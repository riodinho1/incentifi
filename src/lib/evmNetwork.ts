export const LAUNCH_CHAIN_MODE = 'robinhood';

export const IS_ROBINHOOD_CHAIN_MODE = true;

export const EVM_CHAIN_NAME = String(
  import.meta.env.VITE_EVM_CHAIN_NAME || 'Robinhood Chain'
);

export const EVM_CHAIN_ID_DECIMAL = Number(import.meta.env.VITE_EVM_CHAIN_ID || 4663);
export const EVM_CHAIN_ID_HEX = `0x${EVM_CHAIN_ID_DECIMAL.toString(16)}`;

export const EVM_RPC_URL = String(import.meta.env.VITE_EVM_RPC_URL || '').trim();

export const EVM_EXPLORER_URL = String(
  import.meta.env.VITE_EVM_EXPLORER_URL || 'https://robinhoodchain.blockscout.com'
).replace(/\/$/, '');

export const EVM_NATIVE_SYMBOL = String(import.meta.env.VITE_EVM_NATIVE_SYMBOL || 'ETH');

export const EVM_ADDRESS_URL = (address: string) => `${EVM_EXPLORER_URL}/address/${address}`;
export const EVM_TX_URL = (txHash: string) => `${EVM_EXPLORER_URL}/tx/${txHash}`;

export const getEvmProvider = () =>
  typeof window !== 'undefined' ? (window as any).ethereum : undefined;

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

  if (!EVM_RPC_URL) {
    throw new Error(
      'VITE_EVM_RPC_URL is not configured. Add the official Robinhood Chain RPC URL in Vercel before deploying tokens.'
    );
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
