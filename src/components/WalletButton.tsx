import { useState, useEffect } from 'react';
import {
  IS_ROBINHOOD_CHAIN_MODE,
  ensureEvmChain,
  getEvmProvider,
  requestEvmAccounts,
} from '../lib/evmNetwork';

const shortenAddress = (addr: string) => `${addr.slice(0, 4)}...${addr.slice(-4)}`;

type WalletButtonProps = {
  compact?: boolean;
};

export default function WalletButton({ compact = false }: WalletButtonProps) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (IS_ROBINHOOD_CHAIN_MODE) {
      const provider = getEvmProvider();
      if (!provider) return;

      provider
        .request({ method: 'eth_accounts' })
        .then((accounts: string[]) => setPublicKey(accounts?.[0] || null))
        .catch(() => setPublicKey(null));

      const handleAccountsChanged = (accounts: string[]) => setPublicKey(accounts?.[0] || null);
      const handleDisconnect = () => setPublicKey(null);

      provider.on?.('accountsChanged', handleAccountsChanged);
      provider.on?.('disconnect', handleDisconnect);

      return () => {
        provider.removeListener?.('accountsChanged', handleAccountsChanged);
        provider.removeListener?.('disconnect', handleDisconnect);
      };
    }

    const provider = (window as any).solana;

    if (provider && provider.isPhantom) {
      // Auto-connect if already connected
      if (provider.isConnected) {
        setPublicKey(provider.publicKey.toString());
      }

      // Listen for connect/disconnect
      const handleConnect = (pk: any) => setPublicKey(pk.toString());
      const handleDisconnect = () => setPublicKey(null);

      provider.on('connect', handleConnect);
      provider.on('disconnect', handleDisconnect);

      return () => {
        provider.removeListener('connect', handleConnect);
        provider.removeListener('disconnect', handleDisconnect);
      };
    }
  }, []);

  const connect = async () => {
    setConnecting(true);
    try {
      if (IS_ROBINHOOD_CHAIN_MODE) {
        if (!getEvmProvider()) {
          window.open('https://metamask.io/download/', '_blank');
          return;
        }
        await ensureEvmChain();
        const account = await requestEvmAccounts();
        setPublicKey(account);
        return;
      }

      const provider = (window as any).solana;
      if (provider && provider.isPhantom) {
        await provider.connect();
      } else {
        window.open('https://phantom.app/', '_blank');
      }
    } catch {
      alert('Connection rejected');
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (IS_ROBINHOOD_CHAIN_MODE) {
      setPublicKey(null);
      return;
    }

    const provider = (window as any).solana;
    if (provider) await provider.disconnect();
    setPublicKey(null);
  };

  if (publicKey) {
    if (compact) {
      return (
        <button
          onClick={disconnect}
          className="inline-flex h-8 min-w-[4.35rem] items-center justify-center rounded-xl border border-[#183033] bg-[#0B171A] px-2 text-[11px] font-semibold text-[#DDE8EA]"
        >
          {shortenAddress(publicKey)}
        </button>
      );
    }

    return (
      <div className="flex items-center gap-1.5 rounded-xl border border-[#183033] bg-[#0B171A] px-2 py-1.5">
        <span className="text-xs font-medium text-[#DDE8EA]">
          {shortenAddress(publicKey)}
        </span>
        <button
          onClick={disconnect}
          className="rounded-lg bg-[#7A2730]/80 px-2 py-1 text-[11px] font-medium text-[#FFD7D7] transition hover:bg-[#96323C]"
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (compact) {
    return (
      <button
        onClick={connect}
        disabled={connecting}
        className="inline-flex h-8 min-w-[4.35rem] items-center justify-center rounded-xl bg-[#E9E1D8] px-2 text-[11px] font-semibold text-[#061214] transition hover:bg-white disabled:opacity-70"
      >
        {connecting ? '...' : 'Wallet'}
      </button>
    );
  }

  return (
    <button
      onClick={connect}
      disabled={connecting}
      className="rounded-xl bg-[#E9E1D8] px-3.5 py-1.5 text-xs font-semibold text-[#061214] transition hover:bg-white disabled:opacity-70"
    >
      {connecting ? 'Connecting...' : 'Connect Wallet'}
    </button>
  );
}
