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
      <div className="flex items-center gap-3 bg-[#1A1A2E] px-4 py-2.5 rounded-xl border border-[#2A3338]">
        <span className="text-sm text-[#E9E1D8] font-medium">
          {shortenAddress(publicKey)}
        </span>
        <button
          onClick={disconnect}
          className="px-3 py-1.5 text-xs bg-red-900/50 text-red-300 rounded-lg hover:bg-red-900/70 transition"
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
      className="px-6 py-3 rounded-xl bg-gradient-to-r from-[#00D9FF] to-[#9D00FF] text-white font-semibold text-sm hover:shadow-lg hover:shadow-[#00D9FF]/30 transition-all disabled:opacity-70"
    >
      {connecting ? 'Connecting...' : 'Connect Wallet'}
    </button>
  );
}
