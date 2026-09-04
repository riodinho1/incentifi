/**
 * @file Incentifi External Trading Integration SDK
 * @description Non-custodial TypeScript helpers for external bots, terminals, and aggregators.
 */

import {
  encodeFunctionData,
  parseAbi,
  parseEther,
  formatEther,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from 'viem';

// ----------------------------------------------------------------------------
// Canonical Mainnet Configuration (Robinhood Chain, Chain ID 4663)
// ----------------------------------------------------------------------------
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD_EXPLORER_URL = 'https://explorer.mainnet.chain.robinhood.com';

export const INCENTIFI_BONDING_CURVE_FACTORY = '0xa0143de84fba1753b887e4e32941e4fb342e473f' as Address;
export const INCENTIFI_SWAP_ROUTER = '0x4c1f4197b5eebb6cc15c37e053f963a56787575e' as Address;
export const LOSS_REWARD_POOL = '0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf' as Address;
export const WETH_ADDRESS = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address;
export const UNISWAP_V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as Address;
export const UNISWAP_V3_POSITION_MANAGER = '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3' as Address;

export const PROTOCOL_FEE_BPS = 200; // 2.00% Total Trading Fee
export const CREATOR_FEE_BPS = 100; // 1.00% Creator Fee
export const LOSS_REWARD_FEE_BPS = 100; // 1.00% Loss Reward Pool Fee

// ----------------------------------------------------------------------------
// Canonical ABIs
// ----------------------------------------------------------------------------
export const ROUTER_ABI = parseAbi([
  'function buyToken(address token, uint256 amountOutMinimum, uint256 deadline) external payable returns (uint256 amountOut)',
  'function sellToken(address token, uint256 tokenAmountIn, uint256 minEthOut, uint256 deadline) external returns (uint256 netEthOut)',
  'event IncentifiTrade(address indexed token, address indexed trader, bool indexed isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 creatorFee, uint256 lossPoolFee)',
]);

export const FACTORY_ABI = parseAbi([
  'function getBondingCurve(address token) external view returns (address)',
  'function isGraduated(address token) external view returns (bool)',
  'function isBondingCurve(address curve) external view returns (bool)',
  'function allCurves(uint256 index) external view returns (address)',
  'function allCurvesLength() external view returns (uint256)',
  'event BondingCurveCreated(address indexed token, address indexed curve, address indexed creator, uint256 initialInventory)',
]);

export const CURVE_ABI = parseAbi([
  'function getCurrentPrice() external view returns (uint256)',
  'function getProgressBps() external view returns (uint256)',
  'function getAmountOutTokens(uint256 grossEthIn) external view returns (uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'function getAmountOutEth(uint256 tokensIn) external view returns (uint256 netEthOut, uint256 creatorFee, uint256 lossPoolFee)',
  'function realEthReserve() external view returns (uint256)',
  'function realTokenReserve() external view returns (uint256)',
  'function graduated() external view returns (bool)',
  'function uniswapPool() external view returns (address)',
  'function buy(uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minEthOut, address payable recipient) external returns (uint256 netEthOut)',
]);

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
]);

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
export type MarketState = {
  tokenAddress: Address;
  bondingCurveAddress: Address | null;
  isGraduated: boolean;
  isBondingCurveActive: boolean;
  routerAddress: Address;
  factoryAddress: Address;
  chainId: number;
};

export type QuoteResult = {
  tokenAddress: Address;
  side: 'buy' | 'sell';
  inputAmountFormatted: string;
  inputAmountWei: bigint;
  expectedOutputFormatted: string;
  expectedOutputWei: bigint;
  creatorFeeWei: bigint;
  lossPoolFeeWei: bigint;
  protocolFeeBps: number;
  marketType: 'BondingCurve' | 'UniswapV3';
};

export type BuildTransactionResult = {
  to: Address;
  value: bigint;
  data: Hex;
  chainId: number;
  description: string;
};

export type BuildApprovalResult = {
  to: Address;
  value: 0n;
  data: Hex;
  spender: Address;
  amountWei: bigint;
  description: string;
};

// ----------------------------------------------------------------------------
// Transaction Builders (Non-Custodial)
// ----------------------------------------------------------------------------

/**
 * Builds the unsigned transaction payload for buying tokens via IncentifiSwapRouter.
 */
export function buildBuyTransaction(params: {
  tokenAddress: string;
  ethAmount: string | number;
  minTokensOutWei: bigint | string | number;
  deadlineMinutes?: number;
}): BuildTransactionResult {
  if (!isAddress(params.tokenAddress)) {
    throw new Error(`Invalid token address: ${params.tokenAddress}`);
  }

  const token = getAddress(params.tokenAddress);
  const ethWei = typeof params.ethAmount === 'string' || typeof params.ethAmount === 'number'
    ? parseEther(String(params.ethAmount))
    : BigInt(params.ethAmount);

  if (ethWei <= 0n) {
    throw new Error('ETH amount must be greater than 0');
  }

  const minTokens = BigInt(params.minTokensOutWei);
  const deadlineSec = BigInt(Math.floor(Date.now() / 1000) + (params.deadlineMinutes || 20) * 60);

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'buyToken',
    args: [token, minTokens, deadlineSec],
  });

  return {
    to: INCENTIFI_SWAP_ROUTER,
    value: ethWei,
    data,
    chainId: ROBINHOOD_CHAIN_ID,
    description: `Buy ${token} with ${formatEther(ethWei)} ETH via IncentifiSwapRouter`,
  };
}

/**
 * Builds the unsigned transaction payload for selling tokens via IncentifiSwapRouter.
 */
export function buildSellTransaction(params: {
  tokenAddress: string;
  tokenAmount: string | number;
  minEthOutWei: bigint | string | number;
  deadlineMinutes?: number;
}): BuildTransactionResult {
  if (!isAddress(params.tokenAddress)) {
    throw new Error(`Invalid token address: ${params.tokenAddress}`);
  }

  const token = getAddress(params.tokenAddress);
  const tokenWei = typeof params.tokenAmount === 'string' || typeof params.tokenAmount === 'number'
    ? parseEther(String(params.tokenAmount))
    : BigInt(params.tokenAmount);

  if (tokenWei <= 0n) {
    throw new Error('Token amount must be greater than 0');
  }

  const minEth = BigInt(params.minEthOutWei);
  const deadlineSec = BigInt(Math.floor(Date.now() / 1000) + (params.deadlineMinutes || 20) * 60);

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'sellToken',
    args: [token, tokenWei, minEth, deadlineSec],
  });

  return {
    to: INCENTIFI_SWAP_ROUTER,
    value: 0n,
    data,
    chainId: ROBINHOOD_CHAIN_ID,
    description: `Sell ${formatEther(tokenWei)} tokens of ${token} for ETH via IncentifiSwapRouter`,
  };
}

/**
 * Builds the unsigned ERC-20 approval transaction for the IncentifiSwapRouter.
 */
export function buildTokenApproval(params: {
  tokenAddress: string;
  tokenAmount?: string | number | bigint;
}): BuildApprovalResult {
  if (!isAddress(params.tokenAddress)) {
    throw new Error(`Invalid token address: ${params.tokenAddress}`);
  }

  const token = getAddress(params.tokenAddress);
  const amountWei = params.tokenAmount
    ? (typeof params.tokenAmount === 'bigint' ? params.tokenAmount : parseEther(String(params.tokenAmount)))
    : (1_000_000_000n * 10n ** 18n); // Default to total supply (1B)

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [INCENTIFI_SWAP_ROUTER, amountWei],
  });

  return {
    to: token,
    value: 0n,
    data,
    spender: INCENTIFI_SWAP_ROUTER,
    amountWei,
    description: `Approve IncentifiSwapRouter (${INCENTIFI_SWAP_ROUTER}) to spend ${formatEther(amountWei)} tokens`,
  };
}

/**
 * Calculates slippage minimum output.
 * @param expectedAmount Base amount before slippage
 * @param slippageTolerancePct Percentage tolerance (e.g. 1 for 1%)
 */
export function calculateSlippageMin(expectedAmount: bigint, slippageTolerancePct: number): bigint {
  const bps = BigInt(Math.round(slippageTolerancePct * 100));
  return (expectedAmount * (10_000n - bps)) / 10_000n;
}
