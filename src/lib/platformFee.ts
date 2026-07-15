import { EXPLORER_TX_URL } from './network';

// Solana payment flows removed for EVM-only mode. Expose minimal stubs.

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

export const payLaunchCosts = async (provider: any, connection: any, initialLiquidity?: string | number) => {
  throw new Error('Solana payment flows removed in EVM-only mode.');
};
