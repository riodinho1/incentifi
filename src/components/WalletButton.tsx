import { useState, useEffect } from 'react';

const shortenAddress = (addr: string) => `${addr.slice(0, 4)}...${addr.slice(-4)}`;

export default function WalletButton() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
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
    const provider = (window as any).solana;
    if (provider) await provider.disconnect();
    setPublicKey(null);
  };

  if (publicKey) {
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
