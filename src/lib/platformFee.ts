import * as web3 from '@solana/web3.js';
import { EXPLORER_TX_URL } from './network';
import { waitForConfirmedSignature } from './solanaTransactions';

export const PLATFORM_FEE_WALLET = String(import.meta.env.VITE_PLATFORM_FEE_WALLET || '').trim();
export const PUMPPORTAL_WALLET_PUBLIC_KEY = String(
  import.meta.env.VITE_PUMPPORTAL_WALLET_PUBLIC_KEY || ''
).trim();

const rawFee = import.meta.env.VITE_PLATFORM_CREATION_FEE_SOL;

export const PLATFORM_CREATION_FEE_SOL = PLATFORM_FEE_WALLET
  ? Math.max(0, Number(rawFee ?? '0.02') || 0)
  : 0;

export const IS_PLATFORM_FEE_ENABLED =
  Boolean(PLATFORM_FEE_WALLET) && PLATFORM_CREATION_FEE_SOL > 0;

export const IS_PUMPPORTAL_FUNDED_LAUNCH_ENABLED = Boolean(PUMPPORTAL_WALLET_PUBLIC_KEY);

export const normalizeInitialLiquidity = (value?: string | number) =>
  Math.max(0.0001, Number(value || 0.01) || 0.01);

export const getLaunchPaymentSummary = (initialLiquidity?: string | number) => {
  const setupFeeSol = IS_PLATFORM_FEE_ENABLED ? PLATFORM_CREATION_FEE_SOL : 0;
  const initialLiquiditySol = normalizeInitialLiquidity(initialLiquidity);
  const liquidityFundingSol = IS_PUMPPORTAL_FUNDED_LAUNCH_ENABLED
    ? initialLiquiditySol
    : 0;

  return {
    initialLiquiditySol,
    liquidityFundingSol,
    setupFeeSol,
    totalSol: liquidityFundingSol + setupFeeSol,
  };
};

export const formatSolAmount = (amount: number) =>
  amount.toLocaleString(undefined, {
    maximumFractionDigits: 4,
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
  });

const readPublicKey = (address: string, label: string) => {
  try {
    return new web3.PublicKey(address);
  } catch {
    throw new Error(`${label} is not a valid Solana address.`);
  }
};

export const payLaunchCosts = async (
  provider: any,
  connection: web3.Connection,
  initialLiquidity?: string | number
) => {
  const payment = getLaunchPaymentSummary(initialLiquidity);
  if (payment.totalSol <= 0) return null;

  const fromPubkey = provider?.publicKey;
  if (!fromPubkey) throw new Error('Connect wallet first.');

  const totalLamports = Math.round(payment.totalSol * web3.LAMPORTS_PER_SOL);
  const balance = await connection.getBalance(fromPubkey);
  const minimumNeeded = totalLamports + 10_000;

  if (balance < minimumNeeded) {
    throw new Error(
      `This wallet needs at least ${formatSolAmount(
        payment.totalSol
      )} SOL plus a small network fee to launch.`
    );
  }

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new web3.Transaction({
    feePayer: fromPubkey,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  if (payment.liquidityFundingSol > 0) {
    transaction.add(
      web3.SystemProgram.transfer({
        fromPubkey,
        toPubkey: readPublicKey(
          PUMPPORTAL_WALLET_PUBLIC_KEY,
          'The PumpPortal launch wallet'
        ),
        lamports: Math.round(payment.liquidityFundingSol * web3.LAMPORTS_PER_SOL),
      })
    );
  }

  if (payment.setupFeeSol > 0) {
    transaction.add(
      web3.SystemProgram.transfer({
        fromPubkey,
        toPubkey: readPublicKey(PLATFORM_FEE_WALLET, 'The incentifi fee wallet'),
        lamports: Math.round(payment.setupFeeSol * web3.LAMPORTS_PER_SOL),
      })
    );
  }

  const signed = await provider.signTransaction(transaction);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await waitForConfirmedSignature(connection, signature);

  return {
    signature,
    explorer: EXPLORER_TX_URL(signature),
    payment,
  };
};
