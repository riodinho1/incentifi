// src/lib/createToken.ts
import { createEvmToken } from './createEvmToken';
import { addLiquidityAndLock } from './addLiquidity';
import { describeError } from './errors';

type CreateTokenInput = {
  tokenName: string;
  tokenSymbol: string;
  description?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  initialLiquidity?: string;
  initialMarketCapUsd?: string;
};

const fetchEthUsdPrice = async () => {
  const response = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  if (!response.ok) throw new Error('Could not fetch the live ETH/USD rate for the launch price.');
  const body = await response.json();
  const price = Number(body?.data?.amount);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Received an invalid ETH/USD rate for the launch price.');
  return price;
};

export const createRealToken = async (
  provider: any,
  input: CreateTokenInput
) => {
  const deployment = await createEvmToken(provider, input);

  try {
    const ethUsdPrice = await fetchEthUsdPrice();
    const liquidity = await addLiquidityAndLock(
      deployment.mint,
      deployment.creatorAddress,
      input.initialLiquidity || '0.1',
      input.initialMarketCapUsd || '2000',
      ethUsdPrice
    );
    return { ...deployment, liquidity, liquidityError: null };
  } catch (err) {
    console.error('Liquidity setup failed:', err);
    return { ...deployment, liquidity: null, liquidityError: describeError(err) };
  }
};
