export type SolanaNetwork = 'devnet' | 'mainnet';

const rawNetwork = String(import.meta.env.VITE_SOLANA_NETWORK || 'devnet').toLowerCase();
export const SOLANA_NETWORK: SolanaNetwork =
  rawNetwork === 'mainnet' || rawNetwork === 'mainnet-beta' ? 'mainnet' : 'devnet';

export const IS_MAINNET = SOLANA_NETWORK === 'mainnet';

export const SOLANA_RPC_URL =
  import.meta.env.VITE_RPC_URL ||
  (IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');

export const SOLANA_EXPLORER_CLUSTER_QUERY = IS_MAINNET ? '' : '?cluster=devnet';

export const EXPLORER_ADDRESS_URL = (address: string) =>
  `https://explorer.solana.com/address/${address}${SOLANA_EXPLORER_CLUSTER_QUERY}`;

export const EXPLORER_TX_URL = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}${SOLANA_EXPLORER_CLUSTER_QUERY}`;

export const SOLSCAN_TX_URL = (signature: string) =>
  IS_MAINNET
    ? `https://solscan.io/tx/${signature}`
    : `https://solscan.io/tx/${signature}?cluster=devnet`;
