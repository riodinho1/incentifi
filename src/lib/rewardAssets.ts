import { parseAbi, getAddress, formatUnits } from 'viem';
import { publicClient } from './evmNetwork';
import generatedCandidates from './stockRewardCandidates.generated.json';
import {
  LOSS_REWARD_POOL_V2,
  STOCK_REWARDS_ENABLED,
  LEGIBLE_LAUNCH_ENABLED,
  ROBINHOOD_STOCK_FACTORY,
  ROBINHOOD_ASSETS_API_URL,
  ROBINHOOD_ASSETS_PROXY_URL,
  UNISWAP_QUOTER_V2,
  WETH_ADDRESS,
} from './uniswapAddresses';

// ----------------------------------------------------------------------------
// Loss-reward payout assets (docs/LOSS_REWARD_ASSET_DESIGN.md §B2/§B7).
//
// The creator picks the asset ONCE at launch; LossRewardPoolV2.rewardAsset(token) is the source
// of truth. An option is ENABLED by the on-chain checks the pool itself performs — StockFactory
// round-trip (uid() -> tokenAddress(uid) == address) and isSelectableAsset() on the V2 pool (route
// enabled, registry round-trip, asset not paused). Robinhood's public asset list is an OPTIONAL
// ENRICHMENT: when reachable and it marks an asset not ACTIVE (or at another address) the option is
// disabled and says so; when unreachable (api.robinhood.com sends no CORS headers, so a direct
// browser fetch always fails — the gateway's GET /assets proxy is tried first) the on-chain result
// stands and a console warning is logged. Stock balances and quotes are RAW ERC-20 amounts; Robinhood's app shows
// raw × uiMultiplier() / 1e18, so every displayed stock figure goes through toDisplayShares().
// Every function here is a no-op / ETH when LOSS_REWARD_POOL_V2 is unset.
// ----------------------------------------------------------------------------

export const ETH_ASSET = '0x0000000000000000000000000000000000000000' as const;
export const ROBINHOOD_CHAIN_ID = 4663;

export type StockCandidate = { symbol: string; address: `0x${string}`; name?: string };

/**
 * The launch candidate universe: every Robinhood stock token that has a LossRewardPoolV2 swap route
 * in config/loss-reward-stock-routes.json (generated from the live venue map by
 * scripts/ops/generate-stock-routes.mjs — Uniswap V3 WETH pool with liquidity and a TWAP, StockFactory
 * round-trip, API ACTIVE). Regenerate + re-run script/ConfigureStockRoutes.s.sol to change it. The
 * chain still decides per asset at render time (isSelectableAsset), so a stale list only costs a
 * greyed-out option, never a wrong one.
 */
export const STOCK_REWARD_CANDIDATE_LIST: StockCandidate[] = (generatedCandidates as { candidates: StockCandidate[] }).candidates
  .map((c) => ({ symbol: String(c.symbol).toUpperCase(), address: getAddress(c.address), name: c.name ? stripRobinhoodSuffix(c.name) : undefined }))
  .sort((a, b) => a.symbol.localeCompare(b.symbol));

/** symbol -> address view of the same list (kept for callers that index by symbol). */
export const STOCK_REWARD_CANDIDATES: Record<string, `0x${string}`> = Object.fromEntries(STOCK_REWARD_CANDIDATE_LIST.map((c) => [c.symbol, c.address]));

/** "Apple • Robinhood Token" -> "Apple" */
export function stripRobinhoodSuffix(name: string): string {
  return String(name).replace(/\s*[•·-]\s*Robinhood Token\s*$/i, '').trim();
}

/** Multicall3 is deployed at the canonical address on Robinhood Chain (verified by scripts/ops/enumerate-stock-venues.mjs). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

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
  /** Display name without the "• Robinhood Token" suffix (stocks only). */
  name?: string;
  enabled: boolean;
  /** Why the option is greyed out (only when !enabled) — names the failed check. */
  reason?: string;
  /** Caveat on an ENABLED option (e.g. the Robinhood list was unreachable, so only the chain vouched). */
  note?: string;
};

export type AssetListStatus = {
  reachable: boolean;
  /** Which URL answered: the gateway proxy or api.robinhood.com directly. */
  source?: 'proxy' | 'direct';
  /** The actual fetch error(s) when unreachable, e.g. "proxy: HTTP 404; direct: TypeError: Failed to fetch". */
  error?: string;
};

export type AssetListResult = { active: Map<string, `0x${string}`>; source: 'proxy' | 'direct' };

const ASSET_LIST_TIMEOUT_MS = 8_000;

/** Parses either the raw Robinhood payload or the gateway proxy's slimmed copy (same field names). */
export function parseActiveStockAssets(json: any): Map<string, `0x${string}`> {
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

const gatewayHeaders = (): Record<string, string> => {
  const h: Record<string, string> = { Accept: 'application/json' };
  const anon = String((import.meta as any).env?.VITE_SUPABASE_ANON_KEY || '').trim();
  if (anon) h.apikey = anon; // Supabase edge functions expect the anon key on every call
  return h;
};

async function fetchJsonWithTimeout(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<any> {
  const signal = typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function' ? (AbortSignal as any).timeout(ASSET_LIST_TIMEOUT_MS) : undefined;
  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * ACTIVE Robinhood stock tokens on this chain, symbol -> checksummed address, and which source
 * answered. Tries the gateway proxy first (same CORS policy as the rest of the gateway), then the
 * direct URL (works from node / same-origin setups, fails in browsers). Throws with BOTH errors when
 * neither answers — the caller treats that as "list unavailable", never as "asset inactive".
 */
export async function fetchActiveStockAssetList(fetchImpl: typeof fetch = fetch, urls: { proxyUrl?: string; directUrl?: string } = {}): Promise<AssetListResult> {
  const proxyUrl = urls.proxyUrl ?? ROBINHOOD_ASSETS_PROXY_URL;
  const directUrl = urls.directUrl ?? ROBINHOOD_ASSETS_API_URL;
  const errors: string[] = [];
  if (proxyUrl) {
    try {
      return { active: parseActiveStockAssets(await fetchJsonWithTimeout(fetchImpl, proxyUrl, gatewayHeaders())), source: 'proxy' };
    } catch (err: any) {
      errors.push(`proxy ${proxyUrl}: ${err?.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err?.message || err}`);
    }
  }
  if (directUrl) {
    try {
      return { active: parseActiveStockAssets(await fetchJsonWithTimeout(fetchImpl, directUrl, { Accept: 'application/json' })), source: 'direct' };
    } catch (err: any) {
      errors.push(`direct ${directUrl}: ${err?.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err?.message || err}`);
    }
  }
  throw new Error(errors.length ? errors.join('; ') : 'no asset list URL configured');
}

/** Back-compat: the ACTIVE map only (throws when unreachable). */
export async function fetchActiveStockAssets(fetchImpl: typeof fetch = fetch): Promise<Map<string, `0x${string}`>> {
  return (await fetchActiveStockAssetList(fetchImpl)).active;
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

/**
 * The two on-chain checks for MANY assets in three multicalls (uid ×N, then tokenAddress ×N +
 * isSelectableAsset ×N) instead of 3N RPC round-trips. A failed sub-call counts as "false", the
 * same as the single-asset helpers. Falls back to the single-asset helpers if multicall itself fails.
 */
export async function checkStocksOnChain(assets: `0x${string}`[]): Promise<Map<string, { canonical: boolean; selectable: boolean }>> {
  const out = new Map<string, { canonical: boolean; selectable: boolean }>();
  if (!assets.length) return out;
  try {
    const uids = await publicClient.multicall({
      contracts: assets.map((a) => ({ address: getAddress(a), abi: STOCK_ABI, functionName: 'uid' })) as any,
      allowFailure: true,
      multicallAddress: MULTICALL3_ADDRESS,
    } as any);
    const v2 = isV2Configured() ? getAddress(LOSS_REWARD_POOL_V2) : null;
    const second = await publicClient.multicall({
      contracts: [
        ...assets.map((_, i) => ({ address: getAddress(ROBINHOOD_STOCK_FACTORY), abi: STOCK_FACTORY_ABI, functionName: 'tokenAddress', args: [uids[i].status === 'success' ? uids[i].result : `0x${'0'.repeat(64)}`] })),
        ...(v2 ? assets.map((a) => ({ address: v2, abi: POOL_V2_ABI, functionName: 'isSelectableAsset', args: [getAddress(a)] })) : []),
      ] as any,
      allowFailure: true,
      multicallAddress: MULTICALL3_ADDRESS,
    } as any);
    assets.forEach((a, i) => {
      const addr = getAddress(a);
      const rt = second[i];
      const canonical = uids[i].status === 'success' && rt.status === 'success' && getAddress(String(rt.result)) === addr;
      const sel = v2 ? second[assets.length + i] : null;
      const selectable = Boolean(sel && sel.status === 'success' && sel.result);
      out.set(addr.toLowerCase(), { canonical, selectable });
    });
    return out;
  } catch {
    for (const a of assets) out.set(getAddress(a).toLowerCase(), { canonical: await isCanonicalStock(a), selectable: await isSelectableOnPool(a) });
    return out;
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
  /** Returns the ACTIVE map, or throws when the list is unreachable. */
  fetchActive?: () => Promise<Map<string, `0x${string}`> | AssetListResult>;
  canonical?: (asset: `0x${string}`) => Promise<boolean>;
  selectable?: (asset: `0x${string}`) => Promise<boolean>;
  /** Candidate universe (default: the generated route list). */
  candidates?: StockCandidate[];
  /** Console sink for the "asset list unreachable" warning (tests). */
  warn?: (message: string) => void;
};

export const REASON_NOT_CANONICAL = 'failed on-chain check: StockFactory round-trip (not a canonical Robinhood stock token)';
export const REASON_V2_NOT_CONFIGURED = 'reward pool V2 not configured';
export const REASON_NOT_SELECTABLE = 'failed on-chain check: isSelectableAsset() is false on the reward pool (route disabled, registry mismatch, or asset paused)';
export const REASON_API_INACTIVE = 'Robinhood asset list does not mark this asset ACTIVE';
export const REASON_API_ADDRESS_DIFFERS = 'Robinhood asset list shows a different address for this symbol';
export const NOTE_API_UNREACHABLE = 'Robinhood asset list unreachable; enabled on the on-chain checks alone';

/**
 * Options for the launch dropdown plus the asset-list status. ETH is always first and always
 * enabled. Each stock is judged by the ON-CHAIN checks first (authoritative: StockFactory
 * round-trip, V2 configured, isSelectableAsset()); a failure disables it and the reason names the
 * check. The Robinhood list is consulted only when it was reachable: an asset it does not mark
 * ACTIVE (or lists at another address) is disabled with that reason. When the list is unreachable
 * every asset that passed the chain is ENABLED with a `note`, and one console warning carries the
 * actual fetch error. With the flag off (or the legible launch path off) the list is ETH only.
 */
export async function getRewardAssetOptionsWithStatus(deps: RewardAssetOptionDeps = {}): Promise<{ options: RewardAssetOption[]; assetList: AssetListStatus }> {
  const flagEnabled = deps.flagEnabled ?? STOCK_REWARDS_ENABLED;
  const legibleEnabled = deps.legibleEnabled ?? LEGIBLE_LAUNCH_ENABLED;
  const v2Configured = deps.v2Configured ?? isV2Configured();
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const eth: RewardAssetOption = { symbol: 'ETH', address: ETH_ASSET, enabled: true };
  if (!flagEnabled || !legibleEnabled) return { options: [eth], assetList: { reachable: false, error: 'not consulted (dropdown hidden)' } };

  let active: Map<string, `0x${string}`> | null = null;
  let assetList: AssetListStatus;
  try {
    const res = await (deps.fetchActive ?? fetchActiveStockAssetList)();
    if (res instanceof Map) {
      active = res;
      assetList = { reachable: true };
    } else {
      active = res.active;
      assetList = { reachable: true, source: res.source };
    }
  } catch (err: any) {
    const message = String(err?.message || err);
    assetList = { reachable: false, error: message };
    warn(`[reward assets] Robinhood asset list unreachable (${message}). Enabling stock options on the on-chain checks alone (StockFactory round-trip + isSelectableAsset on the reward pool). api.robinhood.com sends no CORS headers, so a direct browser fetch always fails; configure the gateway's GET /assets proxy (VITE_ROBINHOOD_ASSETS_PROXY_URL or VITE_SUPABASE_URL) for the ACTIVE filter.`);
  }
  const candidates = deps.candidates ?? STOCK_REWARD_CANDIDATE_LIST;
  // On-chain checks: injected per-asset helpers (tests) or one batched multicall pass for the whole list.
  let batch: Map<string, { canonical: boolean; selectable: boolean }> | null = null;
  if (!deps.canonical && !deps.selectable) batch = await checkStocksOnChain(candidates.map((c) => c.address));
  const canonical = deps.canonical ?? (async (a: `0x${string}`) => batch?.get(a.toLowerCase())?.canonical ?? (await isCanonicalStock(a)));
  const selectable = deps.selectable ?? (async (a: `0x${string}`) => batch?.get(a.toLowerCase())?.selectable ?? (await isSelectableOnPool(a)));

  const stockOptions: RewardAssetOption[] = [];
  for (const { symbol, address, name } of candidates) {
    const opt: RewardAssetOption = { symbol, address, name, enabled: false };
    if (!(await canonical(address))) opt.reason = REASON_NOT_CANONICAL;
    else if (!v2Configured) opt.reason = REASON_V2_NOT_CONFIGURED;
    else if (!(await selectable(address))) opt.reason = REASON_NOT_SELECTABLE;
    else if (active) {
      const listed = active.get(symbol);
      if (!listed) opt.reason = REASON_API_INACTIVE;
      else if (listed.toLowerCase() !== address.toLowerCase()) opt.reason = REASON_API_ADDRESS_DIFFERS;
      else opt.enabled = true;
    } else {
      opt.enabled = true;
      opt.note = NOTE_API_UNREACHABLE;
    }
    stockOptions.push(opt);
  }
  // ETH first, then enabled stocks A-Z, then the greyed-out ones A-Z (with their reasons)
  stockOptions.sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || a.symbol.localeCompare(b.symbol));
  return { options: [eth, ...stockOptions], assetList };
}

/** Options only (see getRewardAssetOptionsWithStatus). */
export async function getRewardAssetOptions(deps: RewardAssetOptionDeps = {}): Promise<RewardAssetOption[]> {
  return (await getRewardAssetOptionsWithStatus(deps)).options;
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
