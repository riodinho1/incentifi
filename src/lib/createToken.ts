// src/lib/createToken.ts
import { createEvmToken } from './createEvmToken';
import { addLiquidityAndLock } from './addLiquidity';

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

const describeError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const withMessage = err as { message?: unknown; error?: { message?: unknown } };
    if (typeof withMessage.message === 'string') return withMessage.message;
    if (typeof withMessage.error?.message === 'string') return withMessage.error.message;
  }
  return typeof err === 'string' ? err : 'Liquidity setup failed for an unknown reason.';
};

export const createRealToken = async (
  provider: any,
  input: CreateTokenInput
) => {
  const deployment = await createEvmToken(provider, input);

  try {
    const liquidity = await addLiquidityAndLock(
      deployment.mint,
      deployment.creatorAddress,
      input.initialLiquidity || '0.1'
    );
    return { ...deployment, liquidity, liquidityError: null };
  } catch (err) {
    console.error('Liquidity setup failed:', err);
    return { ...deployment, liquidity: null, liquidityError: describeError(err) };
  }
};
