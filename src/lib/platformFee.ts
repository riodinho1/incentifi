import * as web3 from '@solana/web3.js';
import { EXPLORER_TX_URL } from './network';
import { waitForConfirmedSignature } from './solanaTransactions';

export const PLATFORM_FEE_WALLET = String(import.meta.env.VITE_PLATFORM_FEE_WALLET || '').trim();

const rawFee = import.meta.env.VITE_PLATFORM_CREATION_FEE_SOL;

export const PLATFORM_CREATION_FEE_SOL = PLATFORM_FEE_WALLET
  ? Math.max(0, Number(rawFee ?? '0.02') || 0)
  : 0;

export const IS_PLATFORM_FEE_ENABLED =
  Boolean(PLATFORM_FEE_WALLET) && PLATFORM_CREATION_FEE_SOL > 0;

export const formatSolAmount = (amount: number) =>
  amount.toLocaleString(undefined, {
    maximumFractionDigits: 4,
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
  });

export const shortenWallet = (address: string) =>
  address ? `${address.slice(0, 4)}...${address.slice(-4)}` : '';

export const payPlatformCreationFee = async (
  provider: any,
  connection: web3.Connection
) => {
  if (!IS_PLATFORM_FEE_ENABLED) return null;

  const fromPubkey = provider?.publicKey;
  if (!fromPubkey) throw new Error('Connect wallet first.');

  let treasuryPubkey: web3.PublicKey;
  try {
    treasuryPubkey = new web3.PublicKey(PLATFORM_FEE_WALLET);
  } catch {
    throw new Error('The incentifi launch fee wallet is not a valid Solana address.');
  }

  const lamports = Math.round(PLATFORM_CREATION_FEE_SOL * web3.LAMPORTS_PER_SOL);
  const balance = await connection.getBalance(fromPubkey);
  const minimumNeeded = lamports + 10_000;

  if (balance < minimumNeeded) {
    throw new Error(
      `This wallet needs at least ${formatSolAmount(
        PLATFORM_CREATION_FEE_SOL
      )} SOL plus a small network fee to launch.`
    );
  }

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new web3.Transaction({
    feePayer: fromPubkey,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  }).add(
    web3.SystemProgram.transfer({
      fromPubkey,
      toPubkey: treasuryPubkey,
      lamports,
    })
  );

  const signed = await provider.signTransaction(transaction);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await waitForConfirmedSignature(connection, signature);

  return {
    signature,
    explorer: EXPLORER_TX_URL(signature),
  };
};
