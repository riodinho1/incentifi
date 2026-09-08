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
  'function poolIdOf(address token) view returns (bytes32)',
  'function tokenStates(bytes32 poolId) view returns ((address token, address creator, bool initialized, bool curveSeeded, bool graduated, uint256 curveTokens, uint256 reserveTokens, uint256 finalEthReserve, uint256 finalTokenReserve, uint128 graduatedLiquidity))',
  'function collect(address token)',
  'function feeConverter() view returns (address)',
  'event FeesCollected(bytes32 indexed poolId, uint256 ethFees, uint256 tokenFees, uint256 creatorShare, uint256 lossPoolShare)',
]);

export const LEGIBLE_CONVERTER_ABI = parseAbi([
  'function pendingTokenFees(address token) view returns (uint256)',
  'function checkpointEthValue(address token, uint256 tokenAmount) view returns (uint256)',
  'function convert(address token, uint256 amount, uint256 minEthOut) returns (uint256 ethOut)',
  'event Converted(address indexed token, uint256 tokensIn, uint256 ethOut, uint256 creatorShare, uint256 lossPoolShare)',
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
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
]);

// The hook's positions (IncentifiV4LegibleHook): the curve position [TICK_LOWER, TICK_UPPER] with
// salt 0 before graduation; a full-range position with salt 1 after.
export const LEGIBLE_TICK_LOWER = 174070;
export const LEGIBLE_TICK_UPPER = 200310;
export const LEGIBLE_TICK_SPACING = 10;
export const LEGIBLE_CURVE_SALT = '0x0000000000000000000000000000000000000000000000000000000000000000';
export const LEGIBLE_GRADUATED_SALT = '0x0000000000000000000000000000000000000000000000000000000000000001';
const MIN_USABLE_TICK = -887270; // TickMath.minUsableTick(10)
const MAX_USABLE_TICK = 887270;
const MASK_256 = (1n << 256n) - 1n;

/**
 * Pure: what a collect() would take from a V4 position right now — Uniswap v4's
 * FullMath.mulDiv(feeGrowthInside - feeGrowthInsideLast (mod 2^256), liquidity, Q128) per currency.
 * currency0 = ETH, currency1 = the token. Exported for tests.
 */
export function uncollectedFeesFromGrowth({ liquidity, feeGrowthInside0X128, feeGrowthInside1X128, feeGrowthInside0LastX128, feeGrowthInside1LastX128 }) {
  const L = BigInt(liquidity);
  const d0 = (BigInt(feeGrowthInside0X128) - BigInt(feeGrowthInside0LastX128)) & MASK_256;
  const d1 = (BigInt(feeGrowthInside1X128) - BigInt(feeGrowthInside1LastX128)) & MASK_256;
  return { ethFees: (d0 * L) >> 128n, tokenFees: (d1 * L) >> 128n };
}

/** The hook's fee split (IncentifiV4LegibleHook._distribute): ETH 50/50 creator / loss pool; tokens to the converter. */
export function splitCollectedFees(ethFees, tokenFees) {
  const creatorShare = BigInt(ethFees) / 2n;
  return { creatorShare, lossPoolShare: BigInt(ethFees) - creatorShare, tokenFeesToConverter: BigInt(tokenFees) };
}

/**
 * Simulates hook.collect(token) without a transaction: reads the hook's position checkpoint and the
 * pool's fee growth (StateView) and applies the same formula the PoolManager uses. Returns the ETH and
 * token fees collect() would emit in FeesCollected, plus the split.
 */
export async function computeUncollectedLegibleFees(client, tokenAddress) {
  const token = getAddress(tokenAddress);
  const poolId = await client.readContract({ address: INCENTIFI_LEGIBLE_HOOK, abi: LEGIBLE_HOOK_ABI, functionName: 'poolIdOf', args: [token] });
  const state = await client.readContract({ address: INCENTIFI_LEGIBLE_HOOK, abi: LEGIBLE_HOOK_ABI, functionName: 'tokenStates', args: [poolId] });
  if (!state.curveSeeded) return { poolId, ethFees: 0n, tokenFees: 0n, creatorShare: 0n, lossPoolShare: 0n, tokenFeesToConverter: 0n, graduated: false, seeded: false, creator: state.creator };
  const [tl, tu, salt] = state.graduated ? [MIN_USABLE_TICK, MAX_USABLE_TICK, LEGIBLE_GRADUATED_SALT] : [LEGIBLE_TICK_LOWER, LEGIBLE_TICK_UPPER, LEGIBLE_CURVE_SALT];
  const [pos, inside] = await Promise.all([
    client.readContract({ address: UNISWAP_V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getPositionInfo', args: [poolId, INCENTIFI_LEGIBLE_HOOK, tl, tu, salt] }),
    client.readContract({ address: UNISWAP_V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getFeeGrowthInside', args: [poolId, tl, tu] }),
  ]);
  const { ethFees, tokenFees } = uncollectedFeesFromGrowth({ liquidity: pos[0], feeGrowthInside0X128: inside[0], feeGrowthInside1X128: inside[1], feeGrowthInside0LastX128: pos[1], feeGrowthInside1LastX128: pos[2] });
  return { poolId, ethFees, tokenFees, ...splitCollectedFees(ethFees, tokenFees), graduated: Boolean(state.graduated), seeded: true, creator: state.creator };
}


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
