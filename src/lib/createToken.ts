// src/lib/createToken.ts
import * as web3 from '@solana/web3.js';
import { EXPLORER_ADDRESS_URL, EXPLORER_TX_URL, SOLANA_RPC_URL } from './network';

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

const waitForConfirmedSignature = async (
  connection: web3.Connection,
  signature: string,
  timeoutMs = 45_000
) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await connection.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error('Transaction confirmation timed out. Check wallet history for final status.');
};

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
  metadataUri: string
) => {
  const response = await fetch('/api/create-pump-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, metadataUri }),
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

export const createRealToken = async (
  provider: any,
  input: CreateTokenInput
) => {
  const connection = new web3.Connection(SOLANA_RPC_URL, 'confirmed');
  const mint = web3.Keypair.generate();
  const publicKey = provider?.publicKey?.toString?.();

  if (!publicKey) throw new Error('Connect wallet first.');

  const amount = Math.max(0.0001, Number(input.initialLiquidity || 0.01) || 0.01);
  const mintAddress = mint.publicKey.toBase58();
  const metadataUri = await uploadMetadata(mintAddress, input);

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
      return createWithLightningFallback(input, metadataUri);
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
  };
};
