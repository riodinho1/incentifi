// src/lib/createToken.ts
import { createEvmToken, type CreateEvmTokenProgressCallback } from './createEvmToken';

type CreateTokenInput = {
  tokenName: string;
  tokenSymbol: string;
  description?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  /** Loss-reward payout asset address (address(0) / 'ETH' = ETH). */
  rewardAsset?: string;
  onProgress?: CreateEvmTokenProgressCallback;
};

export const createRealToken = async (
  provider: any,
  input: CreateTokenInput
) => {
  const deployment = await createEvmToken(provider, input);
  return deployment;
};
