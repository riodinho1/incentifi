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
    const message = err instanceof Error ? err.message : 'Liquidity setup failed.';
    return { ...deployment, liquidity: null, liquidityError: message };
  }
};
