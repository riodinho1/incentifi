import { getAddress, isAddress } from 'viem';
import { getEvmProvider } from './evmNetwork';
import { supabase } from './supabase';
import type { HolderCostBasis, ClaimableRewardsState } from './lossReward';

const SESSION_KEY_PREFIX = 'incentifi_lr_session_';

export type SessionData = {
  sessionToken: string;
  walletAddress: string;
  expiresAt: number; // Unix timestamp in seconds
};

/**
 * Derives the gateway base URL from Supabase URL configuration.
 */
export const getGatewayBaseUrl = (): string => {
  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const customGateway = (import.meta.env.VITE_LOSS_REWARD_GATEWAY_URL || '').replace(/\/$/, '');
  if (customGateway) return customGateway;
  if (supabaseUrl) return `${supabaseUrl}/functions/v1/loss-reward-gateway`;
  return '/api/loss-reward-gateway';
};

/**
 * Retrieve an active unexpired session token for a given wallet address from sessionStorage.
 */
export const getStoredSession = (walletAddress: string): string | null => {
  if (!walletAddress || !isAddress(walletAddress) || typeof window === 'undefined') {
    return null;
  }

  const normalized = getAddress(walletAddress).toLowerCase();
  const raw = sessionStorage.getItem(`${SESSION_KEY_PREFIX}${normalized}`);
  if (!raw) return null;

  try {
    const parsed: SessionData = JSON.parse(raw);
    const nowSec = Math.floor(Date.now() / 1000);

    if (parsed.expiresAt && parsed.expiresAt > nowSec && parsed.walletAddress?.toLowerCase() === normalized) {
      return parsed.sessionToken;
    }
    // Expired or invalid
    sessionStorage.removeItem(`${SESSION_KEY_PREFIX}${normalized}`);
  } catch {
    sessionStorage.removeItem(`${SESSION_KEY_PREFIX}${normalized}`);
  }

  return null;
};

/**
 * Clear the stored session token for a specific wallet or all stored sessions.
 */
export const clearStoredSession = (walletAddress?: string): void => {
  if (typeof window === 'undefined') return;

  if (walletAddress && isAddress(walletAddress)) {
    const normalized = getAddress(walletAddress).toLowerCase();
    sessionStorage.removeItem(`${SESSION_KEY_PREFIX}${normalized}`);
  } else {
    // Clear all Incentifi loss reward sessions
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(SESSION_KEY_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => sessionStorage.removeItem(k));
  }
};

/**
 * Authenticates the user's connected wallet via EIP-191 personal_sign challenge.
 * Notice: This is a gas-free signature proving wallet ownership.
 */
export const authenticateWallet = async (walletAddress: string): Promise<string> => {
  if (!walletAddress || !isAddress(walletAddress)) {
    throw new Error('Valid EVM wallet address is required for authentication.');
  }

  const provider = getEvmProvider();
  if (!provider) {
    throw new Error('No EVM wallet detected. Please connect MetaMask, Rabby, or Robinhood Wallet.');
  }

  const normalizedWallet = getAddress(walletAddress).toLowerCase();
  const checksummedWallet = getAddress(walletAddress);
  const gatewayUrl = getGatewayBaseUrl();

  // 1. Request Authentication Challenge Nonce
  const challengeRes = await fetch(`${gatewayUrl}/challenge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim(),
    },
    body: JSON.stringify({ walletAddress: checksummedWallet }),
  });

  if (!challengeRes.ok) {
    const errBody = await challengeRes.json().catch(() => ({}));
    throw new Error(errBody.error || `Failed to request authentication challenge (${challengeRes.status})`);
  }

  const challengeData = await challengeRes.json();
  const { nonce, message } = challengeData;

  if (!nonce || !message) {
    throw new Error('Invalid authentication challenge received from gateway.');
  }

  // 2. Request EIP-191 signature via personal_sign
  // Notice: personal_sign params order in EIP-1193 is [message, address]
  const signature: string = await provider.request({
    method: 'personal_sign',
    params: [message, checksummedWallet],
  });

  if (!signature) {
    throw new Error('Wallet signature was rejected or empty.');
  }

  // 3. Verify Signature & Receive 1-Hour Session JWT
  const verifyRes = await fetch(`${gatewayUrl}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim(),
    },
    body: JSON.stringify({
      walletAddress: checksummedWallet,
      nonce,
      signature,
    }),
  });

  if (!verifyRes.ok) {
    const errBody = await verifyRes.json().catch(() => ({}));
    throw new Error(errBody.error || `Authentication verification failed (${verifyRes.status})`);
  }

  const verifyData = await verifyRes.json();
  const { sessionToken, expiresAt } = verifyData;

  if (!sessionToken) {
    throw new Error('Gateway did not return a valid session token.');
  }

  // 4. Store Session in sessionStorage
  const sessionData: SessionData = {
    sessionToken,
    walletAddress: normalizedWallet,
    expiresAt: Number(expiresAt) || Math.floor(Date.now() / 1000) + 3600,
  };
  sessionStorage.setItem(`${SESSION_KEY_PREFIX}${normalizedWallet}`, JSON.stringify(sessionData));

  return sessionToken;
};

/**
 * Fetch authenticated Loss-Reward data for the current token and connected wallet.
 */
export const fetchLossRewardData = async (
  tokenAddress: string,
  walletAddress: string
): Promise<{ costBasis: HolderCostBasis | null; claimable: ClaimableRewardsState }> => {
  if (!tokenAddress || !walletAddress) {
    return {
      costBasis: null,
      claimable: { unclaimedEpochs: [], totalClaimableEth: 0 },
    };
  }

  const normalizedWallet = getAddress(walletAddress).toLowerCase();
  let sessionToken = getStoredSession(normalizedWallet);

  // If no session exists or is expired, trigger signature authentication
  if (!sessionToken) {
    sessionToken = await authenticateWallet(walletAddress);
  }

  const gatewayUrl = getGatewayBaseUrl();
  const response = await fetch(`${gatewayUrl}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
      apikey: (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim(),
    },
    body: JSON.stringify({
      tokenAddress: getAddress(tokenAddress),
    }),
  });

  if (response.status === 401) {
    // Session token expired or invalid: clear cache and throw
    clearStoredSession(normalizedWallet);
    throw new Error('Authentication session expired. Please sign in to verify your wallet.');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Failed to fetch loss-reward data (${response.status})`);
  }

  const data = await response.json();
  return {
    costBasis: data.costBasis || null,
    claimable: data.claimable || { unclaimedEpochs: [], totalClaimableEth: 0 },
  };
};
