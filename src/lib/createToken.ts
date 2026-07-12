// src/lib/createToken.ts
import * as web3 from '@solana/web3.js';
import { EXPLORER_ADDRESS_URL, EXPLORER_TX_URL, SOLANA_RPC_URL } from './network';
import {
  IS_PUMPPORTAL_FUNDED_LAUNCH_ENABLED,
  normalizeInitialLiquidity,
  payLaunchCosts,
} from './platformFee';
import { waitForConfirmedSignature } from './solanaTransactions';
import { createEvmToken } from './createEvmToken';
import { IS_ROBINHOOD_CHAIN_MODE } from './evmNetwork';

type CreateTokenInput = {
  tokenName: string;
  tokenSymbol: string;
  description?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  initialLiquidity?: string;
};

const PUMPPORTAL_LOCAL_TRADE_URL = 'https://pumpportal.fun/api/trade-local';

const makeMetadataUri = (mint: string, input: CreateTokenInput) => {
  const origin =
    typeof window !== 'undefined' &&
    window.location?.origin &&
    !window.location.hostname.includes('localhost') &&
    !window.location.hostname.includes('127.0.0.1')
      ? window.location.origin
      : 'https://incentifi.fun';
  const url = new URL('/api/token-metadata', origin);
  url.searchParams.set('mint', mint);
  url.searchParams.set('n', input.tokenName.trim().slice(0, 32));
  url.searchParams.set('s', input.tokenSymbol.trim().toUpperCase().slice(0, 10));
  return url.toString();
};

const uploadMetadata = async (mint: string, input: CreateTokenInput) => {
  const fallbackUri = makeMetadataUri(mint, input);
  const response = await fetch('/api/upload-token-metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, mint }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Metadata upload failed before token creation. ${detail || response.statusText}`
    );
  }

  const result = await response.json();
  const uri = result?.uri || fallbackUri;

  if (result?.provider !== 'pinata' || !uri.includes('/ipfs/')) {
    throw new Error(
      'Pinata/IPFS metadata is not active on this deployment. Confirm PINATA_JWT is saved in Vercel and redeploy before creating a token.'
    );
  }

  return uri;
};

const createWithLightningFallback = async (
  input: CreateTokenInput,
  metadataUri: string,
  initialLiquidity: number
) => {
  const response = await fetch('/api/create-pump-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, initialLiquidity, metadataUri }),
  });

  const text = await response.text();
  let result: any = {};
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { error: text };
  }

  if (!response.ok) {
    throw new Error(result?.error || text || 'PumpPortal Lightning fallback failed.');
  }

  return {
    mint: result.mint,
    explorer: result.explorer,
    txExplorer: result.txExplorer,
  };
};

const ensureLightningFallbackReady = async () => {
  const response = await fetch('/api/create-pump-token?preflight=1', {
    method: 'GET',
  });

  let result: any = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }

  if (!response.ok || !result?.ready) {
    throw new Error(
      result?.error ||
        'The launch backend is not ready. Confirm PUMPPORTAL_API_KEY is saved in Vercel and redeploy before collecting launch payment.'
    );
  }
};

export const createRealToken = async (
  provider: any,
  input: CreateTokenInput
) => {
  if (IS_ROBINHOOD_CHAIN_MODE) {
    return createEvmToken(provider, input);
  }

  const connection = new web3.Connection(SOLANA_RPC_URL, 'confirmed');
  const mint = web3.Keypair.generate();
  const publicKey = provider?.publicKey?.toString?.();

  if (!publicKey) throw new Error('Connect wallet first.');

  const amount = normalizeInitialLiquidity(input.initialLiquidity);
  const mintAddress = mint.publicKey.toBase58();
  const metadataUri = await uploadMetadata(mintAddress, input);

  if (IS_PUMPPORTAL_FUNDED_LAUNCH_ENABLED) {
    await ensureLightningFallbackReady();
    const launchPayment = await payLaunchCosts(provider, connection, amount);
    const launchResult = await createWithLightningFallback(input, metadataUri, amount);
    return { ...launchResult, launchPayment };
  }

  const launchPayment = await payLaunchCosts(provider, connection, amount);

  const response = await fetch(PUMPPORTAL_LOCAL_TRADE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      action: 'create',
      tokenMetadata: {
        name: input.tokenName.trim(),
        symbol: input.tokenSymbol.trim().toUpperCase(),
        uri: metadataUri,
      },
      mint: mintAddress,
      denominatedInSol: 'true',
      amount,
      slippage: 10,
      priorityFee: 0.0005,
      pool: 'pump',
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    if (message.includes('toBuffer') || response.statusText.includes('toBuffer')) {
      throw new Error(
        'PumpPortal direct wallet creation is unavailable right now. Add VITE_PUMPPORTAL_WALLET_PUBLIC_KEY in Vercel so the connected wallet funds the PumpPortal launch route before creation.'
      );
    }
    throw new Error(
      `PumpPortal create failed (${response.status} ${response.statusText}). ${
        message || 'No extra details returned.'
      }`
    );
  }

  const txBuffer = await response.arrayBuffer();
  const transaction = web3.VersionedTransaction.deserialize(new Uint8Array(txBuffer));
  transaction.sign([mint]);

  const signed = await provider.signTransaction(transaction);
  const txid = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await waitForConfirmedSignature(connection, txid);

  return {
    mint: mintAddress,
    txExplorer: EXPLORER_TX_URL(txid),
    explorer: EXPLORER_ADDRESS_URL(mintAddress),
    launchPayment,
  };
};
