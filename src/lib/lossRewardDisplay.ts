import { formatEther, getAddress, parseAbi } from 'viem';
import { publicClient } from './evmNetwork';
import { LOSS_REWARD_POOL_V2 } from './uniswapAddresses';
import { getTokenRewardAsset, quoteStockForEth, fetchUiMultiplier, formatDisplayShares, isV2Configured, type TokenRewardAsset } from './rewardAssets';

// ----------------------------------------------------------------------------
// What a holder of a STOCK-paying token will actually receive for their claimable allocation.
//
// The pool spends the holder's ETH allocation buying the stock at claim time, so the honest
// figure is "≈ N GOOGL right now" with the ETH allocation underneath. Two rules from the pool:
//   * a claim whose ETH total is below minStockRewardWei (0.002 ETH) is paid in ETH, by design
//     (BelowMinimum fallback) — say so, never show a stock estimate that will not be delivered;
//   * the quote is the route pool's spot price via QuoterV2 for the whole batch, displayed with
//     uiMultiplier() applied, exactly like the balances.
// Pure builder + async fetcher, so the panel copy is unit-testable without a chain.
// ----------------------------------------------------------------------------

const POOL_V2_MIN_ABI = parseAbi(['function minStockRewardWei() view returns (uint256)']);

export type StockClaimDisplay = {
  mode: 'eth' | 'stock' | 'below-min' | 'stock-unquoted';
  /** The headline figure. */
  primary: string;
  /** The ETH allocation line under it (stock modes), or a hint. */
  secondary?: string;
  /** Raw stock the quote implies (0n when not quoted). */
  quotedRaw: bigint;
  /** Display shares = raw × uiMultiplier / 1e18, formatted. */
  displayShares?: string;
};

export function formatEthShort(wei: bigint, digits = 5): string {
  return `${Number(formatEther(wei)).toFixed(digits)} ETH`;
}

/**
 * Pure: builds the claimable-rewards copy for a token whose payout asset may be a stock.
 */
export function buildStockClaimDisplay(p: {
  symbol: string;
  isStock: boolean;
  totalClaimableWei: bigint;
  minStockRewardWei: bigint;
  quotedRaw: bigint;
  uiMultiplierWei: bigint;
  ethSymbol?: string;
}): StockClaimDisplay {
  const eth = p.ethSymbol || 'ETH';
  const allocation = `${Number(formatEther(p.totalClaimableWei)).toFixed(5)} ${eth}`;
  if (!p.isStock || p.totalClaimableWei <= 0n) {
    return { mode: 'eth', primary: p.totalClaimableWei > 0n ? allocation : `0.0000 ${eth}`, quotedRaw: 0n };
  }
  if (p.totalClaimableWei < p.minStockRewardWei) {
    return {
      mode: 'below-min',
      primary: `Below ${Number(formatEther(p.minStockRewardWei)).toString()} ${eth} — paid in ${eth}`,
      secondary: `${allocation} allocation (stock payouts start at ${Number(formatEther(p.minStockRewardWei)).toString()} ${eth} per claim)`,
      quotedRaw: 0n,
    };
  }
  if (p.quotedRaw <= 0n) {
    return { mode: 'stock-unquoted', primary: `≈ ? ${p.symbol} (no quote right now)`, secondary: `${allocation} allocation, spent on ${p.symbol} at claim time`, quotedRaw: 0n };
  }
  const displayShares = formatDisplayShares(p.quotedRaw, p.uiMultiplierWei, 6);
  return {
    mode: 'stock',
    primary: `≈ ${displayShares} ${p.symbol}`,
    secondary: `${allocation} allocation, spent on ${p.symbol} at claim time (current price; falls back to ${eth} if ${p.symbol} cannot be delivered)`,
    quotedRaw: p.quotedRaw,
    displayShares,
  };
}

/** minStockRewardWei from the configured V2 pool (0n when V2 is unset). */
export async function fetchMinStockRewardWei(): Promise<bigint> {
  if (!isV2Configured()) return 0n;
  try {
    return BigInt((await publicClient.readContract({ address: getAddress(LOSS_REWARD_POOL_V2), abi: POOL_V2_MIN_ABI, functionName: 'minStockRewardWei' } as any)) as bigint);
  } catch {
    return 0n;
  }
}

/**
 * Live version: reads the token's payout asset, the pool minimum, a QuoterV2 quote for the whole
 * claimable batch and the stock's uiMultiplier, then builds the copy. ETH tokens short-circuit.
 */
export async function fetchStockClaimDisplay(tokenAddress: string, totalClaimableWei: bigint, ethSymbol = 'ETH'): Promise<{ display: StockClaimDisplay; asset: TokenRewardAsset }> {
  const asset = await getTokenRewardAsset(tokenAddress);
  if (!asset.isStock) {
    return { display: buildStockClaimDisplay({ symbol: 'ETH', isStock: false, totalClaimableWei, minStockRewardWei: 0n, quotedRaw: 0n, uiMultiplierWei: 10n ** 18n, ethSymbol }), asset };
  }
  const minStockRewardWei = await fetchMinStockRewardWei();
  if (totalClaimableWei <= 0n || totalClaimableWei < minStockRewardWei) {
    return { display: buildStockClaimDisplay({ symbol: asset.symbol, isStock: true, totalClaimableWei, minStockRewardWei, quotedRaw: 0n, uiMultiplierWei: 10n ** 18n, ethSymbol }), asset };
  }
  const [quotedRaw, uiMultiplierWei] = await Promise.all([quoteStockForEth(asset.asset, totalClaimableWei), fetchUiMultiplier(asset.asset)]);
  return { display: buildStockClaimDisplay({ symbol: asset.symbol, isStock: true, totalClaimableWei, minStockRewardWei, quotedRaw, uiMultiplierWei, ethSymbol }), asset };
}
