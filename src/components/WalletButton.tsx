import { useState, useSyncExternalStore } from 'react';
import { getEvmProvider, requestEvmAccounts } from '../lib/evmNetwork';
import { getWalletAccount, setWalletAccount, subscribeWalletAccount } from '../lib/walletAccount';

const shortenAddress = (addr: string) => `${addr.slice(0, 4)}...${addr.slice(-4)}`;

type WalletButtonProps = {
  compact?: boolean;
};

export default function WalletButton({ compact = false }: WalletButtonProps) {
  const publicKey = useSyncExternalStore(subscribeWalletAccount, getWalletAccount);
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    setConnecting(true);
    try {
      if (!getEvmProvider()) {
        window.open('https://metamask.io/download/', '_blank');
        return;
      }
      const account = await requestEvmAccounts();
      setWalletAccount(account);
    } catch {
      alert('Connection rejected');
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setWalletAccount(null);
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
