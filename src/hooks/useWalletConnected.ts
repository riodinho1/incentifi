import { useEffect, useState } from 'react';

export const useWalletConnected = () => {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const provider = (window as any).solana;
    if (provider && provider.isPhantom) {
      setConnected(provider.isConnected);
      provider.on('connect', () => setConnected(true));
      provider.on('disconnect', () => setConnected(false));
    }
  }, []);

  return connected;
};
