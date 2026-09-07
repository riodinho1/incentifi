import { encodeAbiParameters, parseAbiParameters, encodeFunctionData, parseAbi, getAddress, decodeEventLog } from 'viem';
import { getEvmProvider, publicClient, waitForTransactionReceipt } from './evmNetwork';
import {
  INCENTIFI_LEGIBLE_FACTORY,
  INCENTIFI_LEGIBLE_HOOK,
  UNISWAP_V4_QUOTER,
  UNISWAP_V4_STATE_VIEW,
  UNIVERSAL_ROUTER_ADDRESS,
  PERMIT2_ADDRESS,
} from './uniswapAddresses';
import { TOTAL_TOKEN_SUPPLY, GRADUATION_ETH_TARGET, REFERENCE_ETH_USD, type BondingCurveState } from './bondingCurve';
import { computeV4PoolId, type V4PoolKey } from './bondingCurveV4';

// ----------------------------------------------------------------------------
// The V4 "legible pool" (PR #17): every token launched through INCENTIFI_LEGIBLE_FACTORY is a
// REAL Uniswap V4 pool — one hook-owned range position holding the curve, a 2% dynamic LP fee
// split 1% creator / 1% LossRewardPool by the hook, and after graduation a hook-owned
// full-range position with the same 2% fee. Because the liquidity is real, the pool is
// priced by slot0 and traded like any other V4 pool: quotes from Uniswap's V4 Quoter, swaps
// through UniversalRouter (Permit2 for the token side), pre- AND post-graduation. The hook's
// `curveStates(poolId)` keeps the legacy 6-field shape (computed from the position) so the
// existing consumers of progress / reserves keep working unchanged.
//
// Gas policy — every transaction this module sends carries an EXPLICIT gas limit of the node's
// estimate + 30%, never below 300,000 for swaps. Why: the 2026-09-07 mainnet smoke test's first
// buy (tx 0x81c6b0e8…b4be) was sent with the bare estimate, 194,373, and ran out of gas inside
// the token transfer at the bottom of the UniversalRouter → PoolManager → hook → token call
// chain (the node itself estimated 198,695; a ~6-deep chain needs the 1/64 reserve at every
// level). A bare estimate is never used again.
// ----------------------------------------------------------------------------

export const LEGIBLE_FACTORY_ABI = parseAbi([
  'function isLaunched(address token) view returns (bool)',
  'function getPoolKey(address token) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  'function launchToken(address token, address rewardAsset) returns (bytes32 poolId)',
  'function hook() view returns (address)',
  'event TokenLaunched(address indexed token, address indexed creator, bytes32 poolId)',
]);

export const LEGIBLE_HOOK_ABI = parseAbi([
  'function curveStates(bytes32 poolId) view returns (address token, address creator, bool initialized, bool graduated, uint256 realEthReserve, uint256 realTokenReserve)',
  'function creatorBalances(address creator) view returns (uint256)',
  'function claimCreatorFees()',
  'function collect(address token)',
  'function lossRewardPool() view returns (address)',
  'event Bought(bytes32 indexed poolId, address indexed trader, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event Sold(bytes32 indexed poolId, address indexed trader, uint256 tokensIn, uint256 ethOut, uint256 creatorFee, uint256 lossPoolFee)',
]);

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function quoteExactOutputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountIn, uint256 gasEstimate)',
]);

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

const PERMIT2_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

// UniversalRouter command + V4Router actions (universal-router Commands.sol / v4-periphery Actions.sol).
const UR_COMMAND_V4_SWAP = 0x10;
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const PERMIT2_EXPIRATION_SECONDS = 365n * 24n * 60n * 60n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Swaps and convert(): node estimate + 30%, never below this. */
export const SWAP_GAS_FLOOR = 300_000n;
export const GAS_HEADROOM_PCT = 30n;

const toQuantityHex = (value: bigint) => `0x${value.toString(16)}`;

export function gasLimitWithHeadroom(estimate: bigint, floor: bigint = 0n): bigint {
  const padded = estimate + (estimate * GAS_HEADROOM_PCT) / 100n;
  return padded < floor ? floor : padded;
}

/**
 * eth_estimateGas through the wallet provider, then +30% with a floor. Never returns the bare
 * estimate (see the module header for the 2026-09-07 out-of-gas at 194,373).
 */
async function estimateGasWithHeadroom(
  provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> },
  tx: { from: string; to: string; data: string; value?: string },
  floor: bigint
): Promise<string> {
  const raw = (await provider.request({ method: 'eth_estimateGas', params: [tx] })) as string;
  return toQuantityHex(gasLimitWithHeadroom(BigInt(raw || '0x0'), floor));
}

// ----------------------------------------------------------------------------
// Identity / state
// ----------------------------------------------------------------------------
export async function isLegibleToken(tokenAddress: string): Promise<boolean> {
  const launched = await publicClient.readContract({
    address: getAddress(INCENTIFI_LEGIBLE_FACTORY),
    abi: LEGIBLE_FACTORY_ABI,
    functionName: 'isLaunched',
    args: [getAddress(tokenAddress)],
  } as any);
  return Boolean(launched);
}

export async function getLegiblePoolKey(tokenAddress: string): Promise<V4PoolKey> {
  const key = await publicClient.readContract({
    address: getAddress(INCENTIFI_LEGIBLE_FACTORY),
    abi: LEGIBLE_FACTORY_ABI,
    functionName: 'getPoolKey',
    args: [getAddress(tokenAddress)],
  } as any);
  return key as V4PoolKey;
}

export interface LegiblePoolState extends BondingCurveState {
  isV4: true;
  venue: 'legible';
  hookAddress: `0x${string}`;
  poolId: `0x${string}`;
  poolKey: V4PoolKey;
  /** Always true: pre- and post-graduation trades go through UniversalRouter. */
  tradingSupported: true;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

/** ETH per token from a V4 sqrtPriceX96 where currency0 is ETH and currency1 is the token. */
export function priceEthFromSqrtPriceX96(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const tokenPerEth = sqrtP * sqrtP;
  return tokenPerEth > 0 ? 1 / tokenPerEth : 0;
}

/**
 * Live state of a legible pool: price from slot0 (the real pool price, before and after
 * graduation), progress / reserves / graduation flag from the hook's legacy-shaped
 * `curveStates(poolId)`.
 */
export async function fetchLegiblePoolState(tokenAddress: string, ethPriceUsd: number = REFERENCE_ETH_USD): Promise<LegiblePoolState> {
  const token = getAddress(tokenAddress);
  const poolKey = await getLegiblePoolKey(token);
  const poolId = computeV4PoolId(poolKey);
  const hook = getAddress(INCENTIFI_LEGIBLE_HOOK);

  const [curve, slot0, liquidity] = await Promise.all([
    publicClient.readContract({ address: hook, abi: LEGIBLE_HOOK_ABI, functionName: 'curveStates', args: [poolId] } as any) as Promise<
      readonly [string, string, boolean, boolean, bigint, bigint]
    >,
    publicClient.readContract({ address: getAddress(UNISWAP_V4_STATE_VIEW), abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] } as any) as Promise<
      readonly [bigint, number, number, number]
    >,
    publicClient.readContract({ address: getAddress(UNISWAP_V4_STATE_VIEW), abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] } as any) as Promise<bigint>,
  ]);

  const [, , initialized, graduated, realEthReserveRaw, realTokenReserveRaw] = curve;
  const realEthReserve = BigInt(realEthReserveRaw ?? 0n);
  const realTokenReserve = BigInt(realTokenReserveRaw ?? TOTAL_TOKEN_SUPPLY);
  const sqrtPriceX96 = BigInt(slot0[0]);
  const priceEth = priceEthFromSqrtPriceX96(sqrtPriceX96);
  const progressBps = graduated
    ? 10000
    : realEthReserve >= GRADUATION_ETH_TARGET
      ? 10000
      : Number((realEthReserve * 10000n) / GRADUATION_ETH_TARGET);

  return {
    isV4: true,
    venue: 'legible',
    hookAddress: hook,
    poolId,
    poolKey,
    tradingSupported: true,
    curveAddress: null,
    initialized: Boolean(initialized),
    graduated: Boolean(graduated),
    realEthReserve,
    realTokenReserve,
    progressBps,
    currentPriceEth: priceEth,
    marketCapUsd: 1_000_000_000 * priceEth * ethPriceUsd,
    circulatingTokens: Number(TOTAL_TOKEN_SUPPLY - realTokenReserve) / 1e18,
    // A V4 pool has no address of its own; the hook is the closest explorer target.
    uniswapPoolAddress: hook,
    sqrtPriceX96,
    tick: Number(slot0[1]),
    liquidity: BigInt(liquidity),
  };
}

// ----------------------------------------------------------------------------
// Quotes — Uniswap's canonical V4 Quoter, which simulates the real swap (hook fee included)
// ----------------------------------------------------------------------------
export type LegibleQuote = { amount: bigint; gasEstimate: bigint };

async function quote(fn: 'quoteExactInputSingle' | 'quoteExactOutputSingle', poolKey: V4PoolKey, zeroForOne: boolean, exactAmount: bigint): Promise<LegibleQuote> {
  const { result } = await publicClient.simulateContract({
    address: getAddress(UNISWAP_V4_QUOTER),
    abi: QUOTER_ABI,
    functionName: fn,
    args: [{ poolKey, zeroForOne, exactAmount, hookData: '0x' }],
  } as any);
  const [amount, gasEstimate] = result as readonly [bigint, bigint];
  return { amount: BigInt(amount), gasEstimate: BigInt(gasEstimate) };
}

/** Tokens received for `ethInWei` (gross, the 2% hook fee is inside the quote). */
export async function quoteLegibleBuy(tokenAddress: string, ethInWei: bigint): Promise<LegibleQuote> {
  return quote('quoteExactInputSingle', await getLegiblePoolKey(tokenAddress), true, ethInWei);
}

/** ETH needed to receive exactly `tokensOutWei`. */
export async function quoteLegibleBuyExactTokens(tokenAddress: string, tokensOutWei: bigint): Promise<LegibleQuote> {
  return quote('quoteExactOutputSingle', await getLegiblePoolKey(tokenAddress), true, tokensOutWei);
}

/** Net ETH received for `tokensInWei` (the 2% hook fee is inside the quote). */
export async function quoteLegibleSell(tokenAddress: string, tokensInWei: bigint): Promise<LegibleQuote> {
  return quote('quoteExactInputSingle', await getLegiblePoolKey(tokenAddress), false, tokensInWei);
}

// ----------------------------------------------------------------------------
// UniversalRouter calldata (byte-identical to test/foundry/LegiblePool.t.sol's urInputs(),
// verified against a mined transaction on 2026-09-07)
// ----------------------------------------------------------------------------
export function encodeUniversalRouterV4Swap(poolKey: V4PoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMinimum: bigint, deadline: bigint) {
  const actions = `0x${[ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL].map((a) => a.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
  const swapParams = encodeAbiParameters(
    parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)'),
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData: '0x' }]
  );
  const inCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const outCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const settle = encodeAbiParameters(parseAbiParameters('address, uint256'), [inCurrency, amountIn]);
  const take = encodeAbiParameters(parseAbiParameters('address, uint256'), [outCurrency, amountOutMinimum]);
  const input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [actions, [swapParams, settle, take]]);
  const commands = `0x${UR_COMMAND_V4_SWAP.toString(16).padStart(2, '0')}` as `0x${string}`;
  return encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [commands, [input], deadline] });
}

function requireWallet() {
  const provider = getEvmProvider();
  if (!provider) throw new Error('No EVM wallet detected. Please connect your wallet.');
  return provider as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
}

async function activeAccount(provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }) {
  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const sender = accounts?.[0];
  if (!sender) throw new Error('Wallet is connected, but no active account was found.');
  return getAddress(sender);
}

export type LegibleSwapResult = { txHash: string; receipt: any; ethAmount: bigint; tokenAmount: bigint };

function decodeHookTrade(receipt: any, eventName: 'Bought' | 'Sold'): { eth: bigint; tokens: bigint } | null {
  const hook = getAddress(INCENTIFI_LEGIBLE_HOOK).toLowerCase();
  for (const log of receipt?.logs || []) {
    if (String(log.address).toLowerCase() !== hook) continue;
    try {
      const ev = decodeEventLog({ abi: LEGIBLE_HOOK_ABI, data: log.data, topics: log.topics }) as any;
      if (ev.eventName !== eventName) continue;
      const a = ev.args as any;
      return eventName === 'Bought' ? { eth: BigInt(a.ethIn), tokens: BigInt(a.tokensOut) } : { eth: BigInt(a.ethOut), tokens: BigInt(a.tokensIn) };
    } catch {
      /* not one of ours */
    }
  }
  return null;
}

/** Buy through UniversalRouter (native ETH in). Works before and after graduation. */
export async function executeLegibleBuy(tokenAddress: string, ethInWei: bigint, minTokensOut: bigint, expectedTokensOut: bigint = minTokensOut): Promise<LegibleSwapResult> {
  const provider = requireWallet();
  const sender = await activeAccount(provider);
  const poolKey = await getLegiblePoolKey(tokenAddress);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const data = encodeUniversalRouterV4Swap(poolKey, true, ethInWei, minTokensOut, deadline);
  const tx = { from: sender, to: getAddress(UNIVERSAL_ROUTER_ADDRESS), value: toQuantityHex(ethInWei), data };
  const gas = await estimateGasWithHeadroom(provider, tx, SWAP_GAS_FLOOR);
  const txHash = (await provider.request({ method: 'eth_sendTransaction', params: [{ ...tx, gas }] })) as string;
  const receipt = await waitForTransactionReceipt(txHash, { description: 'Buy' });
  const traded = decodeHookTrade(receipt, 'Bought');
  return { txHash, receipt, ethAmount: traded?.eth ?? ethInWei, tokenAmount: traded?.tokens ?? expectedTokensOut };
}

/**
 * Sell through UniversalRouter. The token side goes through Permit2 (UniversalRouter pulls via
 * Permit2), so up to two approvals precede the swap, each skipped when already in place.
 */
export async function executeLegibleSell(tokenAddress: string, tokensInWei: bigint, minEthOut: bigint, expectedEthOut: bigint = minEthOut): Promise<LegibleSwapResult> {
  const provider = requireWallet();
  const sender = await activeAccount(provider);
  const token = getAddress(tokenAddress);
  const permit2 = getAddress(PERMIT2_ADDRESS);
  const router = getAddress(UNIVERSAL_ROUTER_ADDRESS);

  const erc20Allowance = (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [sender, permit2] } as any)) as bigint;
  if (BigInt(erc20Allowance) < tokensInWei) {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [permit2, MAX_UINT256] });
    const tx = { from: sender, to: token, data };
    const gas = await estimateGasWithHeadroom(provider, tx, 0n);
    const hash = (await provider.request({ method: 'eth_sendTransaction', params: [{ ...tx, gas }] })) as string;
    await waitForTransactionReceipt(hash, { description: 'Permit2 token approval' });
  }

  const [permitAmount, permitExpiration] = (await publicClient.readContract({
    address: permit2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [sender, token, router],
  } as any)) as readonly [bigint, number, number];
  const nowSec = Math.floor(Date.now() / 1000);
  if (BigInt(permitAmount) < tokensInWei || Number(permitExpiration) <= nowSec + 60) {
    const expiration = BigInt(nowSec) + PERMIT2_EXPIRATION_SECONDS;
    const data = encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [token, router, MAX_UINT160, Number(expiration)] });
    const tx = { from: sender, to: permit2, data };
    const gas = await estimateGasWithHeadroom(provider, tx, 0n);
    const hash = (await provider.request({ method: 'eth_sendTransaction', params: [{ ...tx, gas }] })) as string;
    await waitForTransactionReceipt(hash, { description: 'Universal Router Permit2 approval' });
  }

  const poolKey = await getLegiblePoolKey(token);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const data = encodeUniversalRouterV4Swap(poolKey, false, tokensInWei, minEthOut, deadline);
  const tx = { from: sender, to: router, data };
  const gas = await estimateGasWithHeadroom(provider, tx, SWAP_GAS_FLOOR);
  const txHash = (await provider.request({ method: 'eth_sendTransaction', params: [{ ...tx, gas }] })) as string;
  const receipt = await waitForTransactionReceipt(txHash, { description: 'Sell' });
  const traded = decodeHookTrade(receipt, 'Sold');
  return { txHash, receipt, ethAmount: traded?.eth ?? expectedEthOut, tokenAmount: traded?.tokens ?? tokensInWei };
}

export { ZERO_ADDRESS as LEGIBLE_REWARD_ASSET_ETH };
