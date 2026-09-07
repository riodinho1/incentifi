/**
 * Plain-Node helpers for the V4 "legible pool" trio (PR #17), shared by scripts/evm-indexer.mjs
 * and scripts/loss-reward-worker.mjs. Deliberately independent of the Vite-loaded frontend
 * modules the older V4 path relies on: everything here is a handful of viem reads.
 *
 * Addresses: env first, deployed 2026-09-07 values as documented fallbacks
 * (docs/V4_LEGIBLE_POOL_DESIGN.md section 12).
 */
import { parseAbi, parseAbiItem, getAddress, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';

export const INCENTIFI_LEGIBLE_FACTORY = getAddress(process.env.VITE_INCENTIFI_LEGIBLE_FACTORY || '0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
export const INCENTIFI_LEGIBLE_HOOK = getAddress(process.env.VITE_INCENTIFI_LEGIBLE_HOOK || '0x921d0bE20A21e5A687734b4dF6302EA55BD168C0');
export const INCENTIFI_LEGIBLE_FEE_CONVERTER = getAddress(process.env.VITE_INCENTIFI_LEGIBLE_FEE_CONVERTER || '0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9');
export const UNISWAP_V4_STATE_VIEW = getAddress(process.env.VITE_UNISWAP_V4_STATE_VIEW || '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
export const UNISWAP_V4_QUOTER = getAddress(process.env.VITE_UNISWAP_V4_QUOTER || '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94');

/** The legible factory was deployed in block 56,911,931; no TokenLaunched can precede it. */
export const LEGIBLE_DISCOVERY_FLOOR_BLOCK = 56_911_900n;

export const LEGIBLE_FACTORY_ABI = parseAbi([
  'function isLaunched(address token) view returns (bool)',
  'function getPoolKey(address token) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  'function hook() view returns (address)',
  'event TokenLaunched(address indexed token, address indexed creator, bytes32 poolId)',
]);

export const LEGIBLE_HOOK_ABI = parseAbi([
  'function curveStates(bytes32 poolId) view returns (address token, address creator, bool initialized, bool graduated, uint256 realEthReserve, uint256 realTokenReserve)',
  'function creatorBalances(address creator) view returns (uint256)',
]);

/**
 * Bought/Sold carry the same fields and semantics as the GenericSell hook (trader = tx.origin,
 * ethIn gross, ethOut net), so the indexer feeds them into the same processBuyTrade /
 * processSellTrade. FeesConverted is the fee converter selling collected token-side fees back
 * into the pool: protocol plumbing, NOT a holder trade — it must never touch holder_cost_basis.
 */
export const LEGIBLE_HOOK_EVENTS = parseAbi([
  'event Bought(bytes32 indexed poolId, address indexed trader, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event Sold(bytes32 indexed poolId, address indexed trader, uint256 tokensIn, uint256 ethOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event FeesConverted(bytes32 indexed poolId, uint256 tokensIn, uint256 ethOut)',
]);

export const TOKEN_LAUNCHED_EVENT = parseAbiItem('event TokenLaunched(address indexed token, address indexed creator, bytes32 poolId)');

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

export const TOTAL_TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const GRADUATION_ETH_TARGET = 5_853_863_234_375_000_000n;

export function computePoolId(key) {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks])
  );
}

/** ETH per token from sqrtPriceX96 (currency0 = ETH, currency1 = token). */
export function priceEthFromSqrtPriceX96(sqrtPriceX96) {
  const s = BigInt(sqrtPriceX96);
  if (s <= 0n) return 0;
  const sqrtP = Number(s) / 2 ** 96;
  const tokenPerEth = sqrtP * sqrtP;
  return tokenPerEth > 0 ? 1 / tokenPerEth : 0;
}

export async function isLegibleToken(client, tokenAddress) {
  return Boolean(
    await client.readContract({ address: INCENTIFI_LEGIBLE_FACTORY, abi: LEGIBLE_FACTORY_ABI, functionName: 'isLaunched', args: [getAddress(tokenAddress)] })
  );
}

export async function getLegiblePoolKey(client, tokenAddress) {
  return client.readContract({ address: INCENTIFI_LEGIBLE_FACTORY, abi: LEGIBLE_FACTORY_ABI, functionName: 'getPoolKey', args: [getAddress(tokenAddress)] });
}

/**
 * Same shape the frontend's fetchLegiblePoolState returns (the fields the indexer snapshot
 * and the worker benchmark consume): price from slot0, progress/reserves/graduated from the
 * hook's legacy 6-field curveStates.
 */
export async function fetchLegibleState(client, tokenAddress, ethPriceUsd = 2500) {
  const token = getAddress(tokenAddress);
  const poolKey = await getLegiblePoolKey(client, token);
  const poolId = computePoolId(poolKey);
  const [curve, slot0, liquidity] = await Promise.all([
    client.readContract({ address: INCENTIFI_LEGIBLE_HOOK, abi: LEGIBLE_HOOK_ABI, functionName: 'curveStates', args: [poolId] }),
    client.readContract({ address: UNISWAP_V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] }),
    client.readContract({ address: UNISWAP_V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] }),
  ]);
  const [, creator, initialized, graduated, realEthReserve, realTokenReserve] = curve;
  const sqrtPriceX96 = BigInt(slot0[0]);
  const priceEth = priceEthFromSqrtPriceX96(sqrtPriceX96);
  const progressBps = graduated ? 10000 : realEthReserve >= GRADUATION_ETH_TARGET ? 10000 : Number((realEthReserve * 10000n) / GRADUATION_ETH_TARGET);
  return {
    isV4: true,
    venue: 'legible',
    hookAddress: INCENTIFI_LEGIBLE_HOOK,
    poolId,
    poolKey,
    creator: getAddress(creator),
    initialized: Boolean(initialized),
    graduated: Boolean(graduated),
    realEthReserve: BigInt(realEthReserve),
    realTokenReserve: BigInt(realTokenReserve),
    progressBps,
    currentPriceEth: priceEth,
    marketCapUsd: 1_000_000_000 * priceEth * ethPriceUsd,
    circulatingTokens: Number(TOTAL_TOKEN_SUPPLY - BigInt(realTokenReserve)) / 1e18,
    sqrtPriceX96,
    tick: Number(slot0[1]),
    liquidity: BigInt(liquidity),
  };
}
