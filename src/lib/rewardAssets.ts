import { parseAbi, getAddress, formatUnits } from 'viem';
import { publicClient } from './evmNetwork';
import {
  LOSS_REWARD_POOL_V2,
  STOCK_REWARDS_ENABLED,
  LEGIBLE_LAUNCH_ENABLED,
  ROBINHOOD_STOCK_FACTORY,
  ROBINHOOD_ASSETS_API_URL,
  UNISWAP_QUOTER_V2,
  WETH_ADDRESS,
} from './uniswapAddresses';

// ----------------------------------------------------------------------------
// Loss-reward payout assets (docs/LOSS_REWARD_ASSET_DESIGN.md §B2/§B7).
//
// The creator picks the asset ONCE at launch; LossRewardPoolV2.rewardAsset(token) is the source
// of truth. The launch dropdown is built from Robinhood's public asset list (ACTIVE filter,
// names) but an option is only ENABLED after the on-chain checks the pool itself performs:
// StockFactory round-trip (uid() -> tokenAddress(uid) == address) and isSelectableAsset() on the
// V2 pool. Stock balances and quotes are RAW ERC-20 amounts; Robinhood's app shows
// raw × uiMultiplier() / 1e18, so every displayed stock figure goes through toDisplayShares().
// Every function here is a no-op / ETH when LOSS_REWARD_POOL_V2 is unset.
// ----------------------------------------------------------------------------

export const ETH_ASSET = '0x0000000000000000000000000000000000000000' as const;
export const ROBINHOOD_CHAIN_ID = 4663;

/** The launch allow-list (AAPL / TSLA / NVDA — MSFT deferred). Addresses verified in Phase A. */
export const STOCK_REWARD_CANDIDATES: Record<string, `0x${string}`> = {
  AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
  NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
};

const STOCK_ABI = parseAbi([
  'function uid() view returns (bytes32)',
  'function uiMultiplier() view returns (uint256)',
  'function symbol() view returns (string)',
  'function balanceOf(address account) view returns (uint256)',
]);
const STOCK_FACTORY_ABI = parseAbi(['function tokenAddress(bytes32 uid) view returns (address)']);
const POOL_V2_ABI = parseAbi([
  'function isSelectableAsset(address asset) view returns (bool)',
  'function rewardAsset(address token) view returns (address asset, bool assetSet, bool forcedEth)',
  'function assetRoute(address asset) view returns ((address swapper, address pool, uint24 fee, uint32 twapWindow, uint16 maxDeviationBps, bool enabled))',
  'function minStockRewardWei() view returns (uint256)',
]);
const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export const isV2Configured = (): boolean => /^0x[0-9a-fA-F]{40}$/.test(LOSS_REWARD_POOL_V2);
export const shouldShowStockDropdown = (): boolean => STOCK_REWARDS_ENABLED && LEGIBLE_LAUNCH_ENABLED;

export type RewardAssetOption = {
  symbol: string;
  address: `0x${string}`;
  enabled: boolean;
  /** Why the option is greyed out (only when !enabled). */
  reason?: string;
};

/** ACTIVE Robinhood stock tokens on this chain, symbol -> checksummed address. */
export async function fetchActiveStockAssets(fetchImpl: typeof fetch = fetch): Promise<Map<string, `0x${string}`>> {
  const res = await fetchImpl(ROBINHOOD_ASSETS_API_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`asset list HTTP ${res.status}`);
  const json: any = await res.json();
  const assets: any[] = Array.isArray(json) ? json : json?.assets || [];
  const out = new Map<string, `0x${string}`>();
  for (const a of assets) {
    if (a?.status !== 'ASSET_STATUS_ACTIVE') continue;
    const dep = (a.deployments || []).find((d: any) => Number(d.chainId) === ROBINHOOD_CHAIN_ID);
    if (!dep?.contractAddress || !a.tokenSymbol) continue;
    try {
      out.set(String(a.tokenSymbol).toUpperCase(), getAddress(dep.contractAddress));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** The pool's own canonical check: uid() -> StockFactory.tokenAddress(uid) == asset. */
export async function isCanonicalStock(asset: string): Promise<boolean> {
  try {
    const addr = getAddress(asset);
    const uid = (await publicClient.readContract({ address: addr, abi: STOCK_ABI, functionName: 'uid' } as any)) as `0x${string}`;
    const canonical = (await publicClient.readContract({ address: getAddress(ROBINHOOD_STOCK_FACTORY), abi: STOCK_FACTORY_ABI, functionName: 'tokenAddress', args: [uid] } as any)) as string;
    return getAddress(canonical) === addr;
  } catch {
    return false;
  }
}

export async function isSelectableOnPool(asset: string): Promise<boolean> {
  if (!isV2Configured()) return false;
  try {
    return Boolean(await publicClient.readContract({ address: getAddress(LOSS_REWARD_POOL_V2), abi: POOL_V2_ABI, functionName: 'isSelectableAsset', args: [getAddress(asset)] } as any));
  } catch {
    return false;
  }
}

export type RewardAssetOptionDeps = {
  flagEnabled?: boolean;
  legibleEnabled?: boolean;
  v2Configured?: boolean;
  fetchActive?: () => Promise<Map<string, `0x${string}`>>;
  canonical?: (asset: `0x${string}`) => Promise<boolean>;
  selectable?: (asset: `0x${string}`) => Promise<boolean>;
};

/**
 * Options for the launch dropdown. ETH is always first and always enabled. Each stock is enabled
 * only when ALL of: listed ACTIVE by Robinhood at the address we know, canonical per the
 * StockFactory round-trip, and selectable on the configured V2 pool. With the flag off (or the
 * legible launch path off) the list is ETH only — the caller renders the ETH-only control.
 */
export async function getRewardAssetOptions(deps: RewardAssetOptionDeps = {}): Promise<RewardAssetOption[]> {
  const flagEnabled = deps.flagEnabled ?? STOCK_REWARDS_ENABLED;
  const legibleEnabled = deps.legibleEnabled ?? LEGIBLE_LAUNCH_ENABLED;
  const v2Configured = deps.v2Configured ?? isV2Configured();
  const eth: RewardAssetOption = { symbol: 'ETH', address: ETH_ASSET, enabled: true };
  if (!flagEnabled || !legibleEnabled) return [eth];

  let active = new Map<string, `0x${string}`>();
  let apiFailed = false;
  try {
    active = await (deps.fetchActive ?? fetchActiveStockAssets)();
  } catch {
    apiFailed = true;
  }
  const canonical = deps.canonical ?? isCanonicalStock;
  const selectable = deps.selectable ?? isSelectableOnPool;

  const options: RewardAssetOption[] = [eth];
  for (const [symbol, address] of Object.entries(STOCK_REWARD_CANDIDATES)) {
    const opt: RewardAssetOption = { symbol, address, enabled: false };
    const listed = active.get(symbol);
    if (apiFailed) opt.reason = 'Robinhood asset list unavailable';
    else if (!listed) opt.reason = 'not listed as active by Robinhood';
    else if (listed.toLowerCase() !== address.toLowerCase()) opt.reason = 'address differs from the known canonical token';
    else if (!(await canonical(address))) opt.reason = 'not a canonical Robinhood stock token';
    else if (!v2Configured) opt.reason = 'reward pool V2 not configured';
    else if (!(await selectable(address))) opt.reason = 'not enabled on the reward pool';
    else opt.enabled = true;
    options.push(opt);
  }
  return options;
}

export type TokenRewardAsset = {
  /** Effective payout asset: address(0) for ETH. */
  asset: `0x${string}`;
  symbol: string;
  isStock: boolean;
  forcedEth: boolean;
  /** The creator's original selection (may differ from `asset` after forceEthPayout). */
  selected: `0x${string}`;
};

const ETH_INFO: TokenRewardAsset = { asset: ETH_ASSET, symbol: 'ETH', isStock: false, forcedEth: false, selected: ETH_ASSET };

/** What THIS token's loss rewards pay out in. ETH whenever V2 is unset or the token has no record. */
export async function getTokenRewardAsset(tokenAddress: string): Promise<TokenRewardAsset> {
  if (!isV2Configured()) return ETH_INFO;
  try {
    const [asset, , forcedEth] = (await publicClient.readContract({
      address: getAddress(LOSS_REWARD_POOL_V2),
      abi: POOL_V2_ABI,
      functionName: 'rewardAsset',
      args: [getAddress(tokenAddress)],
    } as any)) as readonly [string, boolean, boolean];
    const selected = getAddress(asset);
    if (selected === ETH_ASSET || forcedEth) return { ...ETH_INFO, forcedEth: Boolean(forcedEth), selected };
    let symbol = 'STOCK';
    try {
      symbol = String(await publicClient.readContract({ address: selected, abi: STOCK_ABI, functionName: 'symbol' } as any));
    } catch {
      const known = Object.entries(STOCK_REWARD_CANDIDATES).find(([, a]) => a.toLowerCase() === selected.toLowerCase());
      if (known) symbol = known[0];
    }
    return { asset: selected, symbol, isStock: true, forcedEth: false, selected };
  } catch {
    return ETH_INFO;
  }
}

export const formatRewardAssetBadge = (symbol: string): string => `Loss Reward: ${symbol}`;

/** Robinhood's displayed share count for a raw ERC-20 amount (multiplier is 1e18-scaled). */
export function toDisplayShares(rawAmount: bigint, uiMultiplierWei: bigint): bigint {
  return (rawAmount * uiMultiplierWei) / 10n ** 18n;
}

export function formatDisplayShares(rawAmount: bigint, uiMultiplierWei: bigint, maxFractionDigits = 6): string {
  const shares = Number(formatUnits(toDisplayShares(rawAmount, uiMultiplierWei), 18));
  return shares.toLocaleString('en-US', { maximumFractionDigits: maxFractionDigits });
}

export async function fetchUiMultiplier(asset: string): Promise<bigint> {
  try {
    return BigInt((await publicClient.readContract({ address: getAddress(asset), abi: STOCK_ABI, functionName: 'uiMultiplier' } as any)) as bigint);
  } catch {
    return 10n ** 18n;
  }
}

export async function fetchStockBalanceDisplay(asset: string, holder: string): Promise<{ raw: bigint; multiplier: bigint; display: string }> {
  const [raw, multiplier] = await Promise.all([
    publicClient.readContract({ address: getAddress(asset), abi: STOCK_ABI, functionName: 'balanceOf', args: [getAddress(holder)] } as any) as Promise<bigint>,
    fetchUiMultiplier(asset),
  ]);
  return { raw: BigInt(raw), multiplier, display: formatDisplayShares(BigInt(raw), multiplier) };
}

/**
 * Expected raw stock for `ethWei` on the pool's configured route (Uniswap V3 QuoterV2 on the
 * same WETH/asset pool the adapter swaps on). 0n when it cannot be quoted — the pool's own TWAP
 * floor still protects the claim; the frontend just cannot add a user bound on top.
 */
export async function quoteStockForEth(asset: string, ethWei: bigint): Promise<bigint> {
  if (!isV2Configured() || ethWei <= 0n) return 0n;
  try {
    const route = (await publicClient.readContract({ address: getAddress(LOSS_REWARD_POOL_V2), abi: POOL_V2_ABI, functionName: 'assetRoute', args: [getAddress(asset)] } as any)) as any;
    if (!route?.enabled) return 0n;
    const { result } = await publicClient.simulateContract({
      address: getAddress(UNISWAP_QUOTER_V2),
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: getAddress(WETH_ADDRESS), tokenOut: getAddress(asset), amountIn: ethWei, fee: Number(route.fee), sqrtPriceLimitX96: 0n }],
    } as any);
    return BigInt((result as readonly [bigint, bigint, number, bigint])[0]);
  } catch {
    return 0n;
  }
}

/**
 * The user's minAssetOut for a V2 claim: the quoted stock for the batch's ETH, minus the user's
 * slippage setting. 0n for ETH-paying tokens, and 0n (protocol floor only) when no quote is
 * available. `minStockRewardWei` matters too: below it the pool pays ETH regardless, so no bound.
 */
export async function computeMinAssetOut(tokenAddress: string, totalEthWei: bigint, slippagePct: number): Promise<{ minAssetOut: bigint; asset: TokenRewardAsset; quoted: bigint }> {
  const asset = await getTokenRewardAsset(tokenAddress);
  if (!asset.isStock) return { minAssetOut: 0n, asset, quoted: 0n };
  try {
    const minStock = BigInt((await publicClient.readContract({ address: getAddress(LOSS_REWARD_POOL_V2), abi: POOL_V2_ABI, functionName: 'minStockRewardWei' } as any)) as bigint);
    if (totalEthWei < minStock) return { minAssetOut: 0n, asset, quoted: 0n };
  } catch {
    /* fall through to a quote */
  }
  const quoted = await quoteStockForEth(asset.asset, totalEthWei);
  if (quoted === 0n) return { minAssetOut: 0n, asset, quoted };
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippagePct * 100))));
  return { minAssetOut: (quoted * (10_000n - bps)) / 10_000n, asset, quoted };
}
