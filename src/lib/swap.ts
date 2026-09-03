import { decodeEventLog, encodeFunctionData, parseAbi, getAddress, parseEther, parseUnits } from 'viem';
import { getEvmProvider, publicClient, ensureEvmChain, waitForTransactionReceipt } from './evmNetwork';
import {
  UNISWAP_V3_FACTORY,
  INCENTIFI_SWAP_ROUTER,
  WETH_ADDRESS,
  POOL_FEE,
  PROTOCOL_FEE_BPS,
  CREATOR_FEE_BPS,
  LOSS_REWARD_FEE_BPS,
} from './uniswapAddresses';
import {
  fetchBondingCurveState,
  calculateTokensOut,
  calculateEthOut,
  executeBondingCurveBuy,
  executeBondingCurveSell,
  TOTAL_TOKEN_SUPPLY,
  REFERENCE_ETH_USD,
  BondingCurveState,
} from './bondingCurve';

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const INCENTIFI_ROUTER_ABI = parseAbi([
  'function buyToken(address token, uint256 amountOutMinimum, uint256 deadline) payable returns (uint256 amountOut)',
  'function sellToken(address token, uint256 amountIn, uint256 amountOutMinimum, uint256 deadline) returns (uint256 amountOut)',
  'event Bought(address indexed buyer, address indexed token, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossRewardFee)',
  'event Sold(address indexed seller, address indexed token, uint256 tokensIn, uint256 ethOut, uint256 creatorFee, uint256 lossRewardFee)',
]);

const toQuantityHex = (value: bigint) => `0x${value.toString(16)}`;

const waitForReceipt = waitForTransactionReceipt;

const priceInEth = (sqrtPriceX96: bigint, isTokenFirst: boolean) => {
  const Q96 = 1n << 96n;
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = sqrtPrice * sqrtPrice;
  return isTokenFirst ? 1 / rawPrice : rawPrice;
};

export type ConfirmedPoolSwap = {
  side: 'buy' | 'sell';
  amountToken: number;
  amountEth: number;
  priceEth: number;
};

export const getPoolQuote = async (tokenAddress: string) => {
  const token = getAddress(tokenAddress);
  const weth = getAddress(WETH_ADDRESS);

  const poolAddress = await publicClient.readContract({
    address: getAddress(UNISWAP_V3_FACTORY),
    abi: FACTORY_ABI,
    functionName: 'getPool',
    args: [token, weth, POOL_FEE],
  } as any);

  if (!poolAddress || poolAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error('No liquidity pool found for this token yet.');
  }

  const slot0 = await publicClient.readContract({
    address: poolAddress as `0x${string}`,
    abi: POOL_ABI,
    functionName: 'slot0',
  } as any);
  const sqrtPriceX96 = BigInt(slot0[0]);

  if (sqrtPriceX96 <= 0n) {
    throw new Error('Pool exists but has no price yet.');
  }

  const isTokenFirst = BigInt(token) < BigInt(weth);

  return { poolAddress: poolAddress as `0x${string}`, sqrtPriceX96, isTokenFirst };
};

export type UnifiedMarketState = {
  isBondingCurve: boolean;
  isGraduated: boolean;
  poolAddress?: string;
  curveAddress?: string;
  priceEth: number;
  priceUsd: number;
  marketCapUsd: number;
  progressBps: number;
  circulatingTokens: number;
  realEthReserveEth: number;
  realTokenReserveTokens: number;
};

/**
 * Unified query resolving either pre-graduation Bonding Curve or post-graduation Uniswap V3.
 */
export const getUnifiedMarketState = async (
  tokenAddress: string,
  ethPriceUsd: number = REFERENCE_ETH_USD
): Promise<UnifiedMarketState> => {
  const curveState = await fetchBondingCurveState(tokenAddress, ethPriceUsd);

  if (!curveState.graduated) {
    return {
      isBondingCurve: true,
      isGraduated: false,
      curveAddress: curveState.curveAddress || undefined,
      priceEth: curveState.currentPriceEth,
      priceUsd: curveState.currentPriceEth * ethPriceUsd,
      marketCapUsd: curveState.marketCapUsd,
      progressBps: curveState.progressBps,
      circulatingTokens: curveState.circulatingTokens,
      realEthReserveEth: Number(curveState.realEthReserve) / 1e18,
      realTokenReserveTokens: Number(curveState.realTokenReserve) / 1e18,
    };
  }

  // Token is graduated: query Uniswap V3 pool
  try {
    const { poolAddress, sqrtPriceX96, isTokenFirst } = await getPoolQuote(tokenAddress);
    const pEth = priceInEth(sqrtPriceX96, isTokenFirst);
    const pUsd = pEth * ethPriceUsd;

    return {
      isBondingCurve: false,
      isGraduated: true,
      poolAddress,
      priceEth: pEth,
      priceUsd: pUsd,
      marketCapUsd: 1_000_000_000 * pUsd,
      progressBps: 10000,
      circulatingTokens: 1_000_000_000,
      realEthReserveEth: 5.85386,
      realTokenReserveTokens: 212096496.0558,
    };
  } catch {
    // Fallback gracefully
    return {
      isBondingCurve: false,
      isGraduated: true,
      priceEth: curveState.currentPriceEth,
      priceUsd: curveState.currentPriceEth * ethPriceUsd,
      marketCapUsd: curveState.marketCapUsd,
      progressBps: 10000,
      circulatingTokens: 1_000_000_000,
      realEthReserveEth: 5.85386,
      realTokenReserveTokens: 212096496.0558,
    };
  }
};

const applySlippage = (amount: bigint, slippageBps: number) => {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
};

export type SwapResult = {
  txHash: string;
  trade: ConfirmedPoolSwap;
};

/**
 * Universal Buy Function: routes to Bonding Curve pre-graduation, or Uniswap V3 post-graduation.
 */
export const buyToken = async (
  tokenAddress: string,
  trader: string,
  ethAmount: string | number | bigint,
  slippagePct: number,
  ethPriceUsd: number = REFERENCE_ETH_USD
): Promise<SwapResult> => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Connect wallet first.');
  await ensureEvmChain();

  const token = getAddress(tokenAddress);
  const traderAddr = getAddress(trader);

  const ethWei = typeof ethAmount === 'bigint'
    ? ethAmount
    : typeof ethAmount === 'number'
      ? parseEther(ethAmount.toFixed(18))
      : parseEther(String(ethAmount).trim());

  if (ethWei <= 0n) throw new Error('Enter a valid ETH amount.');

  const curveState = await fetchBondingCurveState(token, ethPriceUsd);

  // 1. Pre-Graduation: Route to Bonding Curve
  if (!curveState.graduated) {
    if (!curveState.curveAddress) {
      throw new Error(
        'Bonding curve has not been activated for this token yet. Please wait for the token creator to initialize the bonding curve.'
      );
    }

    const { tokensOut } = calculateTokensOut(ethWei, curveState.realEthReserve, curveState.realTokenReserve);
    const minTokensOut = applySlippage(tokensOut, slippagePct * 100);

    const { txHash } = await executeBondingCurveBuy(
      curveState.curveAddress,
      ethWei,
      minTokensOut,
      traderAddr
    );

    const tokensPurchasedNum = Number(tokensOut) / 1e18;
    const ethPaidNum = Number(ethWei) / 1e18;

    return {
      txHash,
      trade: {
        side: 'buy',
        amountToken: tokensPurchasedNum,
        amountEth: ethPaidNum,
        priceEth: tokensPurchasedNum > 0 ? ethPaidNum / tokensPurchasedNum : 0,
      },
    };
  }

  // 2. Post-Graduation: Route to Uniswap V3 via Router
  const { poolAddress, sqrtPriceX96, isTokenFirst } = await getPoolQuote(token);
  const wethIsToken0 = !isTokenFirst;

  const feeWei = (ethWei * BigInt(PROTOCOL_FEE_BPS)) / 10_000n;
  const swapEthWei = ethWei - feeWei;

  const Q192 = 1n << 192n;
  const expectedOut = wethIsToken0
    ? (swapEthWei * sqrtPriceX96 * sqrtPriceX96) / Q192
    : (swapEthWei * Q192) / (sqrtPriceX96 * sqrtPriceX96);

  const amountOutMinimum = applySlippage(expectedOut, slippagePct * 100);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

  const buyData = encodeFunctionData({
    abi: INCENTIFI_ROUTER_ABI,
    functionName: 'buyToken',
    args: [token, amountOutMinimum, deadline],
  });

  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: traderAddr,
        to: INCENTIFI_SWAP_ROUTER,
        value: toQuantityHex(ethWei),
        data: buyData,
      },
    ],
  })) as string;

  await waitForReceipt(txHash);

  const tokensOutNum = Number(expectedOut) / 1e18;
  const ethPaidNum = Number(ethWei) / 1e18;

  return {
    txHash,
    trade: {
      side: 'buy',
      amountToken: tokensOutNum,
      amountEth: ethPaidNum,
      priceEth: tokensOutNum > 0 ? ethPaidNum / tokensOutNum : 0,
    },
  };
};

/**
 * Universal Sell Function: routes to Bonding Curve pre-graduation, or Uniswap V3 post-graduation.
 */
export const sellToken = async (
  tokenAddress: string,
  trader: string,
  tokenAmount: string | number | bigint,
  slippagePct: number,
  ethPriceUsd: number = REFERENCE_ETH_USD
): Promise<SwapResult> => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Connect wallet first.');
  await ensureEvmChain();

  const token = getAddress(tokenAddress);
  const traderAddr = getAddress(trader);

  const tokenWei = typeof tokenAmount === 'bigint'
    ? tokenAmount
    : typeof tokenAmount === 'number'
      ? parseUnits(tokenAmount.toFixed(18), 18)
      : parseUnits(String(tokenAmount).trim(), 18);

  if (tokenWei <= 0n) throw new Error('Enter a valid token amount.');

  const curveState = await fetchBondingCurveState(token, ethPriceUsd);

  // 1. Pre-Graduation: Route to Bonding Curve
  if (!curveState.graduated) {
    if (!curveState.curveAddress) {
      throw new Error(
        'Bonding curve has not been activated for this token yet. Please wait for the token creator to initialize the bonding curve.'
      );
    }

    const { netEthOut } = calculateEthOut(tokenWei, curveState.realEthReserve, curveState.realTokenReserve);
    const minEthOut = applySlippage(netEthOut, slippagePct * 100);

    const { txHash } = await executeBondingCurveSell(
      curveState.curveAddress,
      token,
      tokenWei,
      minEthOut,
      traderAddr
    );

    const tokensSoldNum = Number(tokenWei) / 1e18;
    const ethReceivedNum = Number(netEthOut) / 1e18;

    return {
      txHash,
      trade: {
        side: 'sell',
        amountToken: tokensSoldNum,
        amountEth: ethReceivedNum,
        priceEth: tokensSoldNum > 0 ? ethReceivedNum / tokensSoldNum : 0,
      },
    };
  }

  // 2. Post-Graduation: Route to Uniswap V3 via Router
  const allowanceData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [traderAddr, INCENTIFI_SWAP_ROUTER],
  });
  const allowanceHex = await provider.request({
    method: 'eth_call',
    params: [{ to: token, data: allowanceData }, 'latest'],
  });
  const currentAllowance = BigInt(allowanceHex || '0x0');

  if (currentAllowance < tokenWei) {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [INCENTIFI_SWAP_ROUTER, 2n ** 256n - 1n],
    });
    const approveTx = (await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: traderAddr, to: token, data: approveData }],
    })) as string;
    await waitForReceipt(approveTx);
  }

  const { poolAddress, sqrtPriceX96, isTokenFirst } = await getPoolQuote(token);
  const tokenIsToken0 = isTokenFirst;

  const Q192 = 1n << 192n;
  const grossEthOut = tokenIsToken0
    ? (tokenWei * sqrtPriceX96 * sqrtPriceX96) / Q192
    : (tokenWei * Q192) / (sqrtPriceX96 * sqrtPriceX96);

  const feeWei = (grossEthOut * BigInt(PROTOCOL_FEE_BPS)) / 10_000n;
  const expectedNetEth = grossEthOut - feeWei;
  const minEthOut = applySlippage(expectedNetEth, slippagePct * 100);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

  const sellData = encodeFunctionData({
    abi: INCENTIFI_ROUTER_ABI,
    functionName: 'sellToken',
    args: [token, tokenWei, minEthOut, deadline],
  });

  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: traderAddr, to: INCENTIFI_SWAP_ROUTER, data: sellData }],
  })) as string;

  await waitForReceipt(txHash);

  const tokensSoldNum = Number(tokenWei) / 1e18;
  const ethReceivedNum = Number(expectedNetEth) / 1e18;

  return {
    txHash,
    trade: {
      side: 'sell',
      amountToken: tokensSoldNum,
      amountEth: ethReceivedNum,
      priceEth: tokensSoldNum > 0 ? ethReceivedNum / tokensSoldNum : 0,
    },
  };
};
