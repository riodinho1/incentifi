// src/lib/createToken.ts
import { createEvmToken } from './createEvmToken';

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
  return createEvmToken(provider, input);
};
