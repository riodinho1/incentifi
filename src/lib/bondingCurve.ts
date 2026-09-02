import { decodeEventLog, encodeFunctionData, parseAbi, getAddress } from 'viem';
import { getEvmProvider, publicClient } from './evmNetwork';
import {
  INCENTIFI_BONDING_CURVE_FACTORY,
  WETH_ADDRESS,
  CREATOR_FEE_BPS,
} from './uniswapAddresses';

export const BONDING_CURVE_FACTORY_ABI = parseAbi([
  'function getBondingCurve(address token) view returns (address)',
  'function isGraduated(address token) view returns (bool)',
  'function registerExistingToken(address token, address creator) returns (address curve)',
  'event BondingCurveCreated(address indexed token, address indexed curve, address indexed creator, uint256 initialInventory)',
]);

export const BONDING_CURVE_ABI = parseAbi([
  'function token() view returns (address)',
  'function creator() view returns (address)',
  'function lossRewardPool() view returns (address)',
  'function realEthReserve() view returns (uint256)',
  'function realTokenReserve() view returns (uint256)',
  'function initialized() view returns (bool)',
  'function graduated() view returns (bool)',
  'function lpTokenId() view returns (uint256)',
  'function uniswapPool() view returns (address)',
  'function getAmountOutTokens(uint256 grossEthIn) view returns (uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'function getAmountOutEth(uint256 tokensIn) view returns (uint256 netEthOut, uint256 creatorFee, uint256 lossPoolFee)',
  'function getCurrentPrice() view returns (uint256)',
  'function getProgressBps() view returns (uint256)',
  'function buy(uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minEthOut, address recipient) returns (uint256 netEthOut)',
  'event TokensPurchased(address indexed buyer, address indexed recipient, uint256 ethInGross, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event TokensSold(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 netEthOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event Graduated(address indexed pool, uint256 tokenId, uint256 wethAmount, uint256 tokenAmount)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

// ----------------------------------------------------------------------------
// Verified Economic Constants
// ----------------------------------------------------------------------------
export const TOTAL_TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n; // 1B
export const VIRTUAL_ETH = 2156250000000000000n; // 2.15625 ETH
export const VIRTUAL_TOKEN = 78125000000000000000000000n; // 78.125M Tokens
export const INVARIANT_K = 2324707031250000000000000000000000000000000000n;
export const GRADUATION_ETH_TARGET = 5853863234375000000n; // 5.853863234375 ETH
export const GRADUATION_SQRT_PRICE_X96 = 476897496634883656268812375606081n;

export const INITIAL_MARKET_CAP_USD = 5000;
export const GRADUATION_MARKET_CAP_USD = 69000;
export const INITIAL_TOKEN_PRICE_USD = 0.000005;
export const GRADUATION_TOKEN_PRICE_USD = 0.000069;
export const REFERENCE_ETH_USD = 2500;

export interface BondingCurveState {
  curveAddress: `0x${string}` | null;
  initialized: boolean;
  graduated: boolean;
  realEthReserve: bigint;
  realTokenReserve: bigint;
  progressBps: number;
  currentPriceEth: number;
  marketCapUsd: number;
  circulatingTokens: number;
  uniswapPoolAddress: `0x${string}` | null;
}

const toQuantityHex = (value: bigint) => `0x${value.toString(16)}`;

const waitForReceipt = async (txHash: string) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Wallet provider disappeared while waiting for confirmation.');

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (receipt) {
      if (receipt.status === '0x0' || receipt.status === 0 || receipt.status === 0n) {
        throw new Error('Transaction reverted on-chain. No trade was executed.');
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Transaction was submitted, but confirmation timed out.');
};

/**
 * Pure offline calculation of token output given gross ETH input.
 */
export function calculateTokensOut(
  grossEthInWei: bigint,
  realEthReserveWei: bigint = 0n,
  realTokenReserveWei: bigint = TOTAL_TOKEN_SUPPLY
): {
  tokensOut: bigint;
  creatorFeeWei: bigint;
  lossPoolFeeWei: bigint;
  netEthInWei: bigint;
  refundWei: bigint;
  actualGrossEthInWei: bigint;
} {
  if (grossEthInWei === 0n || realEthReserveWei >= GRADUATION_ETH_TARGET) {
    return {
      tokensOut: 0n,
      creatorFeeWei: 0n,
      lossPoolFeeWei: 0n,
      netEthInWei: 0n,
      refundWei: 0n,
      actualGrossEthInWei: 0n,
    };
  }

  const maxNetEth = GRADUATION_ETH_TARGET - realEthReserveWei;
  const k = maxNetEth / 98n;
  const r = maxNetEth % 98n;
  const maxGrossEth = 100n * k + r;

  let actualGrossEth = grossEthInWei;
  let refundWei = 0n;
  if (actualGrossEth > maxGrossEth) {
    refundWei = actualGrossEth - maxGrossEth;
    actualGrossEth = maxGrossEth;
  }

  const creatorFeeWei = actualGrossEth / 100n; // 1.0%
  const lossPoolFeeWei = actualGrossEth / 100n; // 1.0%
  const netEthInWei = actualGrossEth - creatorFeeWei - lossPoolFeeWei; // 98.0%

  const currentEth = VIRTUAL_ETH + realEthReserveWei;
  const currentToken = VIRTUAL_TOKEN + realTokenReserveWei;

  const newEth = currentEth + netEthInWei;
  const newToken = INVARIANT_K / newEth;
  let tokensOut = currentToken - newToken;

  if (tokensOut > realTokenReserveWei) {
    tokensOut = realTokenReserveWei;
  }

  return {
    tokensOut,
    creatorFeeWei,
    lossPoolFeeWei,
    netEthInWei,
    refundWei,
    actualGrossEthInWei: actualGrossEth,
  };
}

/**
 * Pure offline calculation of net ETH output given token input.
 */
export function calculateEthOut(
  tokensInWei: bigint,
  realEthReserveWei: bigint = 0n,
  realTokenReserveWei: bigint = TOTAL_TOKEN_SUPPLY
): { netEthOut: bigint; creatorFeeWei: bigint; lossPoolFeeWei: bigint; grossEthOutWei: bigint } {
  if (tokensInWei === 0n) {
    return { netEthOut: 0n, creatorFeeWei: 0n, lossPoolFeeWei: 0n, grossEthOutWei: 0n };
  }
  const currentEth = VIRTUAL_ETH + realEthReserveWei;
  const currentToken = VIRTUAL_TOKEN + realTokenReserveWei;

  const newToken = currentToken + tokensInWei;
  const newEth = INVARIANT_K / newToken;
  let grossEthOutWei = currentEth - newEth;

  if (grossEthOutWei > realEthReserveWei) {
    grossEthOutWei = realEthReserveWei;
  }

  const creatorFeeWei = grossEthOutWei / 100n; // 1.0%
  const lossPoolFeeWei = grossEthOutWei / 100n; // 1.0%
  const netEthOut = grossEthOutWei - creatorFeeWei - lossPoolFeeWei; // 98.0%

  return { netEthOut, creatorFeeWei, lossPoolFeeWei, grossEthOutWei };
}

/**
 * Calculates spot price and market cap.
 */
export function calculateSpotPriceAndMarketCap(
  realEthReserveWei: bigint = 0n,
  realTokenReserveWei: bigint = TOTAL_TOKEN_SUPPLY,
  ethPriceUsd: number = REFERENCE_ETH_USD
): { priceEth: number; priceUsd: number; marketCapUsd: number; progressBps: number } {
  const currentEth = VIRTUAL_ETH + realEthReserveWei;
  const currentToken = VIRTUAL_TOKEN + realTokenReserveWei;

  const priceEth = Number(currentEth) / Number(currentToken);
  const priceUsd = priceEth * ethPriceUsd;
  const marketCapUsd = 1_000_000_000 * priceUsd;

  const progressBps = realEthReserveWei >= GRADUATION_ETH_TARGET
    ? 10000
    : Number((realEthReserveWei * 10000n) / GRADUATION_ETH_TARGET);

  return { priceEth, priceUsd, marketCapUsd, progressBps };
}

/**
 * Resolves the on-chain bonding curve address for a token directly via Robinhood Chain RPC.
 */
export async function getBondingCurveAddress(tokenAddress: string): Promise<`0x${string}` | null> {
  if (!INCENTIFI_BONDING_CURVE_FACTORY || INCENTIFI_BONDING_CURVE_FACTORY === '0x') {
    return null;
  }
  try {
    const normalizedToken = getAddress(tokenAddress);
    const curve = await publicClient.readContract({
      address: getAddress(INCENTIFI_BONDING_CURVE_FACTORY),
      abi: BONDING_CURVE_FACTORY_ABI,
      functionName: 'getBondingCurve',
      args: [normalizedToken],
    } as any);

    if (!curve || curve === '0x0000000000000000000000000000000000000000') {
      return null;
    }
    return curve as `0x${string}`;
  } catch (err) {
    console.warn('Failed to resolve bonding curve address from factory:', err);
    return null;
  }
}

/**
 * Fetches the on-chain bonding curve state for a token directly via Robinhood Chain RPC.
 */
export async function fetchBondingCurveState(
  tokenAddress: string,
  ethPriceUsd: number = REFERENCE_ETH_USD
): Promise<BondingCurveState> {
  const normalizedToken = getAddress(tokenAddress);

  try {
    const curveAddress = await getBondingCurveAddress(normalizedToken);

    if (!curveAddress) {
      // Return default deterministic initial state
      const { priceEth, marketCapUsd, progressBps } = calculateSpotPriceAndMarketCap(0n, TOTAL_TOKEN_SUPPLY, ethPriceUsd);
      return {
        curveAddress: null,
        initialized: true,
        graduated: false,
        realEthReserve: 0n,
        realTokenReserve: TOTAL_TOKEN_SUPPLY,
        progressBps,
        currentPriceEth: priceEth,
        marketCapUsd,
        circulatingTokens: 0,
        uniswapPoolAddress: null,
      };
    }

    // Read curve state on-chain via dedicated Robinhood Chain publicClient
    const [realEthReserveRaw, realTokenReserveRaw, graduatedRaw] = await Promise.all([
      publicClient.readContract({
        address: curveAddress,
        abi: BONDING_CURVE_ABI,
        functionName: 'realEthReserve',
      } as any),
      publicClient.readContract({
        address: curveAddress,
        abi: BONDING_CURVE_ABI,
        functionName: 'realTokenReserve',
      } as any),
      publicClient.readContract({
        address: curveAddress,
        abi: BONDING_CURVE_ABI,
        functionName: 'graduated',
      } as any),
    ]);

    const realEthReserve = BigInt((realEthReserveRaw as any) ?? 0n);
    const realTokenReserve = BigInt((realTokenReserveRaw as any) ?? TOTAL_TOKEN_SUPPLY);
    const graduated = Boolean(graduatedRaw);

    const { priceEth, marketCapUsd, progressBps } = calculateSpotPriceAndMarketCap(
      realEthReserve,
      realTokenReserve,
      ethPriceUsd
    );

    const circulatingTokens = Number(TOTAL_TOKEN_SUPPLY - realTokenReserve) / 1e18;

    return {
      curveAddress,
      initialized: true,
      graduated,
      realEthReserve,
      realTokenReserve,
      progressBps: graduated ? 10000 : progressBps,
      currentPriceEth: priceEth,
      marketCapUsd,
      circulatingTokens,
      uniswapPoolAddress: null,
    };
  } catch (error) {
    console.warn('Error reading bonding curve state on-chain:', error);
    const { priceEth, marketCapUsd, progressBps } = calculateSpotPriceAndMarketCap(0n, TOTAL_TOKEN_SUPPLY, ethPriceUsd);
    return {
      curveAddress: null,
      initialized: true,
      graduated: false,
      realEthReserve: 0n,
      realTokenReserve: TOTAL_TOKEN_SUPPLY,
      progressBps,
      currentPriceEth: priceEth,
      marketCapUsd,
      circulatingTokens: 0,
      uniswapPoolAddress: null,
    };
  }
}

/**
 * Execute a buy trade against the bonding curve.
 */
export async function executeBondingCurveBuy(
  curveAddress: string,
  grossEthWei: bigint,
  minTokensOutWei: bigint,
  recipient: string
): Promise<{ txHash: string; receipt: any }> {
  const provider = getEvmProvider();
  if (!provider) throw new Error('No EVM wallet detected. Please connect your wallet.');

  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const sender = accounts?.[0];
  if (!sender) throw new Error('Wallet is connected, but no active account was found.');

  const data = encodeFunctionData({
    abi: BONDING_CURVE_ABI,
    functionName: 'buy',
    args: [minTokensOutWei, getAddress(recipient || sender)],
  });

  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: sender,
        to: getAddress(curveAddress),
        value: toQuantityHex(grossEthWei),
        data,
      },
    ],
  })) as string;

  const receipt = await waitForReceipt(txHash);
  return { txHash, receipt };
}

/**
 * Execute a sell trade against the bonding curve.
 */
export async function executeBondingCurveSell(
  curveAddress: string,
  tokenAddress: string,
  tokensInWei: bigint,
  minEthOutWei: bigint,
  recipient: string
): Promise<{ txHash: string; receipt: any }> {
  const provider = getEvmProvider();
  if (!provider) throw new Error('No EVM wallet detected. Please connect your wallet.');

  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const sender = accounts?.[0];
  if (!sender) throw new Error('Wallet is connected, but no active account was found.');

  const normalizedToken = getAddress(tokenAddress);
  const normalizedCurve = getAddress(curveAddress);

  // 1. Check Allowance and Approve if needed
  const allowanceData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [getAddress(sender), normalizedCurve],
  });
  const allowanceHex = await provider.request({
    method: 'eth_call',
    params: [{ to: normalizedToken, data: allowanceData }, 'latest'],
  });
  const currentAllowance = BigInt(allowanceHex || '0x0');

  if (currentAllowance < tokensInWei) {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [normalizedCurve, 2n ** 256n - 1n],
    });
    const approveTxHash = (await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: sender, to: normalizedToken, data: approveData }],
    })) as string;
    await waitForReceipt(approveTxHash);
  }

  // 2. Execute sell on bonding curve
  const data = encodeFunctionData({
    abi: BONDING_CURVE_ABI,
    functionName: 'sell',
    args: [tokensInWei, minEthOutWei, getAddress(recipient || sender)],
  });

  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: sender,
        to: normalizedCurve,
        data,
      },
    ],
  })) as string;

  const receipt = await waitForReceipt(txHash);
  return { txHash, receipt };
}
