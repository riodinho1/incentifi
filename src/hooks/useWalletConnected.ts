import { useEffect, useState } from 'react';
import { IS_ROBINHOOD_CHAIN_MODE, getEvmProvider } from '../lib/evmNetwork';

export const useWalletConnected = () => {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (IS_ROBINHOOD_CHAIN_MODE) {
      const provider = getEvmProvider();
      if (!provider) return;

      provider
        .request({ method: 'eth_accounts' })
        .then((accounts: string[]) => setConnected(Boolean(accounts?.[0])))
        .catch(() => setConnected(false));

      const handleAccountsChanged = (accounts: string[]) => setConnected(Boolean(accounts?.[0]));
      const handleDisconnect = () => setConnected(false);

      provider.on?.('accountsChanged', handleAccountsChanged);
      provider.on?.('disconnect', handleDisconnect);

      return () => {
        provider.removeListener?.('accountsChanged', handleAccountsChanged);
        provider.removeListener?.('disconnect', handleDisconnect);
      };
    }

    const provider = (window as any).solana;
    if (provider && provider.isPhantom) {
      setConnected(provider.isConnected);
      provider.on('connect', () => setConnected(true));
      provider.on('disconnect', () => setConnected(false));
    }
  }, []);

  return connected;
};
