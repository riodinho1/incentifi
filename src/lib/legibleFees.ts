import { parseAbi, getAddress } from 'viem';
import { publicClient } from './evmNetwork';
import { INCENTIFI_LEGIBLE_HOOK, INCENTIFI_LEGIBLE_FEE_CONVERTER, UNISWAP_V4_STATE_VIEW } from './uniswapAddresses';
import { getLegiblePoolKey } from './legiblePool';
import { computeV4PoolId } from './bondingCurveV4';

// ----------------------------------------------------------------------------
// Legible-pool fee plumbing, read-only.
//
// LP fees on a legible pool accrue INSIDE the PoolManager position until someone calls
// hook.collect(token): only then is the ETH half split creator / loss pool and the token half
// handed to the converter, which turns it into ETH on convert(token, 0, 0). Nothing here is
// automatic on-chain, so "what has this token earned" has three parts:
//   uncollected  — fees sitting in the position (this module simulates collect() by applying the
//                  PoolManager's own formula to the position checkpoint + current fee growth)
//   pending      — token-side fees already collected but not yet converted to ETH
//   ready        — creatorBalances / LossRewardPool balances, i.e. already distributed
// ----------------------------------------------------------------------------

export const LEGIBLE_FEE_HOOK_ABI = parseAbi([
  'function poolIdOf(address token) view returns (bytes32)',
  'function tokenStates(bytes32 poolId) view returns ((address token, address creator, bool initialized, bool curveSeeded, bool graduated, uint256 curveTokens, uint256 reserveTokens, uint256 finalEthReserve, uint256 finalTokenReserve, uint128 graduatedLiquidity))',
  'function collect(address token)',
  'event FeesCollected(bytes32 indexed poolId, uint256 ethFees, uint256 tokenFees, uint256 creatorShare, uint256 lossPoolShare)',
  'error CurveNotSeeded()',
]);
export const LEGIBLE_CONVERTER_ABI = parseAbi([
  'function pendingTokenFees(address token) view returns (uint256)',
  'function checkpointEthValue(address token, uint256 tokenAmount) view returns (uint256)',
  'function convert(address token, uint256 amount, uint256 minEthOut) returns (uint256 ethOut)',
]);
const STATE_VIEW_FEES_ABI = parseAbi([
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
]);

export const LEGIBLE_TICK_LOWER = 174070;
export const LEGIBLE_TICK_UPPER = 200310;
const MIN_USABLE_TICK = -887270; // TickMath.minUsableTick(10)
const MAX_USABLE_TICK = 887270;
const CURVE_SALT = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
const GRADUATED_SALT = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const MASK_256 = (1n << 256n) - 1n;

/** Uniswap v4: fees owed = mulDiv(feeGrowthInside - last (mod 2^256), liquidity, Q128), per currency. */
export function uncollectedFeesFromGrowth(p: { liquidity: bigint; feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint; feeGrowthInside0LastX128: bigint; feeGrowthInside1LastX128: bigint }): { ethFees: bigint; tokenFees: bigint } {
  const d0 = (p.feeGrowthInside0X128 - p.feeGrowthInside0LastX128) & MASK_256;
  const d1 = (p.feeGrowthInside1X128 - p.feeGrowthInside1LastX128) & MASK_256;
  return { ethFees: (d0 * p.liquidity) >> 128n, tokenFees: (d1 * p.liquidity) >> 128n };
}

/** IncentifiV4LegibleHook._distribute: ETH 50/50 creator / loss pool; every token-side fee goes to the converter. */
export function splitCollectedFees(ethFees: bigint, tokenFees: bigint): { creatorShare: bigint; lossPoolShare: bigint; tokenFeesToConverter: bigint } {
  const creatorShare = ethFees / 2n;
  return { creatorShare, lossPoolShare: ethFees - creatorShare, tokenFeesToConverter: tokenFees };
}

export type UncollectedLegibleFees = {
  poolId: `0x${string}`;
  creator: `0x${string}`;
  seeded: boolean;
  graduated: boolean;
  /** What FeesCollected would report if collect(token) ran now. */
  ethFees: bigint;
  tokenFees: bigint;
  creatorShare: bigint;
  lossPoolShare: bigint;
};

/** Simulates hook.collect(token) from state: no transaction, no eth_call side effects. */
export async function computeUncollectedLegibleFees(tokenAddress: string): Promise<UncollectedLegibleFees> {
  const token = getAddress(tokenAddress);
  const hook = getAddress(INCENTIFI_LEGIBLE_HOOK);
  const poolId = (await publicClient.readContract({ address: hook, abi: LEGIBLE_FEE_HOOK_ABI, functionName: 'poolIdOf', args: [token] } as any)) as `0x${string}`;
  const state = (await publicClient.readContract({ address: hook, abi: LEGIBLE_FEE_HOOK_ABI, functionName: 'tokenStates', args: [poolId] } as any)) as any;
  const creator = getAddress(state.creator);
  if (!state.curveSeeded) return { poolId, creator, seeded: false, graduated: false, ethFees: 0n, tokenFees: 0n, creatorShare: 0n, lossPoolShare: 0n };
  const [tl, tu, salt] = state.graduated ? [MIN_USABLE_TICK, MAX_USABLE_TICK, GRADUATED_SALT] : [LEGIBLE_TICK_LOWER, LEGIBLE_TICK_UPPER, CURVE_SALT];
  const sv = getAddress(UNISWAP_V4_STATE_VIEW);
  const [pos, inside] = await Promise.all([
    publicClient.readContract({ address: sv, abi: STATE_VIEW_FEES_ABI, functionName: 'getPositionInfo', args: [poolId, hook, tl, tu, salt] } as any) as Promise<readonly [bigint, bigint, bigint]>,
    publicClient.readContract({ address: sv, abi: STATE_VIEW_FEES_ABI, functionName: 'getFeeGrowthInside', args: [poolId, tl, tu] } as any) as Promise<readonly [bigint, bigint]>,
  ]);
  const { ethFees, tokenFees } = uncollectedFeesFromGrowth({ liquidity: BigInt(pos[0]), feeGrowthInside0X128: BigInt(inside[0]), feeGrowthInside1X128: BigInt(inside[1]), feeGrowthInside0LastX128: BigInt(pos[1]), feeGrowthInside1LastX128: BigInt(pos[2]) });
  const split = splitCollectedFees(ethFees, tokenFees);
  return { poolId, creator, seeded: true, graduated: Boolean(state.graduated), ethFees, tokenFees, creatorShare: split.creatorShare, lossPoolShare: split.lossPoolShare };
}

export type PendingConversion = {
  /** Token-side fees the converter holds for this token (raw token units). */
  pendingTokenWei: bigint;
  /** Their ETH value at the converter's last price checkpoint (what convert() is floored against). */
  pendingEthValueWei: bigint;
};

/** Token-side fees already collected, waiting for converter.convert(token, 0, 0). */
export async function fetchPendingConversion(tokenAddress: string): Promise<PendingConversion> {
  const token = getAddress(tokenAddress);
  const converter = getAddress(INCENTIFI_LEGIBLE_FEE_CONVERTER);
  const pendingTokenWei = BigInt((await publicClient.readContract({ address: converter, abi: LEGIBLE_CONVERTER_ABI, functionName: 'pendingTokenFees', args: [token] } as any)) as bigint);
  if (pendingTokenWei === 0n) return { pendingTokenWei, pendingEthValueWei: 0n };
  let pendingEthValueWei = 0n;
  try {
    pendingEthValueWei = BigInt((await publicClient.readContract({ address: converter, abi: LEGIBLE_CONVERTER_ABI, functionName: 'checkpointEthValue', args: [token, pendingTokenWei] } as any)) as bigint);
  } catch {
    /* no checkpoint yet: value unknown */
  }
  return { pendingTokenWei, pendingEthValueWei };
}

/** Convenience: the pool id the frontend already derives from the factory's pool key (sanity-checked against the hook). */
export async function legiblePoolIdOf(tokenAddress: string): Promise<`0x${string}`> {
  return computeV4PoolId(await getLegiblePoolKey(getAddress(tokenAddress))) as `0x${string}`;
}
