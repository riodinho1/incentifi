import { getAddress, parseAbi } from 'viem';
import { publicClient } from './evmNetwork';
import { supabase, isSupabaseConfigured } from './supabase';
import { INCENTIFI_LEGIBLE_FACTORY, INCENTIFI_LEGIBLE_HOOK, INCENTIFI_V4_FACTORY, INCENTIFI_V4_HOOK } from './uniswapAddresses';
import { getBondingCurveAddress } from './bondingCurve';

/**
 * Which contracts a token trades through. Resolved PER TOKEN, never by a global switch:
 *   'legible'    — launched through the V4 legible factory (PR #17): real V4 pool, UniversalRouter
 *   'v4-generic' — launched through the previous IncentifiV4HookGenericSell factory: IncentifiV4Router
 *   'v3'         — per-token IncentifiBondingCurve + IncentifiSwapRouter
 *   'unknown'    — none of the above (not an Incentifi launch, or RPC trouble)
 *
 * Source of truth, in order: the indexer/DB tag (`tokens.hook_address`, written by the indexer
 * when it sees the TokenLaunched event and by the launch page), then the chain (each factory's
 * `isLaunched`, then the V3 factory). The DB read is best-effort: if the column is missing or
 * Supabase is down we fall through to the chain, never fail.
 */
export type TokenVenue = 'legible' | 'v4-generic' | 'v3' | 'unknown';

const FACTORY_IS_LAUNCHED_ABI = parseAbi(['function isLaunched(address token) view returns (bool)']);

const cache = new Map<string, TokenVenue>();

export function venueForHookAddress(hookAddress: string | null | undefined): TokenVenue | null {
  if (!hookAddress) return null;
  const hook = String(hookAddress).toLowerCase();
  if (hook === INCENTIFI_LEGIBLE_HOOK.toLowerCase()) return 'legible';
  if (hook === INCENTIFI_V4_HOOK.toLowerCase()) return 'v4-generic';
  return null;
}

export function hookAddressForVenue(venue: TokenVenue): `0x${string}` | null {
  if (venue === 'legible') return getAddress(INCENTIFI_LEGIBLE_HOOK);
  if (venue === 'v4-generic') return getAddress(INCENTIFI_V4_HOOK);
  return null;
}

async function venueFromDb(tokenLower: string): Promise<TokenVenue | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const { data, error } = await supabase.from('tokens').select('hook_address').eq('mint_address', tokenLower).maybeSingle();
    if (error || !data) return null;
    return venueForHookAddress((data as any).hook_address);
  } catch {
    return null; // column not migrated yet, network error, ... -> chain decides
  }
}

async function isLaunchedOn(factory: string, token: `0x${string}`): Promise<boolean> {
  try {
    return Boolean(await publicClient.readContract({ address: getAddress(factory), abi: FACTORY_IS_LAUNCHED_ABI, functionName: 'isLaunched', args: [token] } as any));
  } catch {
    return false;
  }
}

async function venueFromChain(token: `0x${string}`): Promise<TokenVenue> {
  if (await isLaunchedOn(INCENTIFI_LEGIBLE_FACTORY, token)) return 'legible';
  if (await isLaunchedOn(INCENTIFI_V4_FACTORY, token)) return 'v4-generic';
  try {
    if (await getBondingCurveAddress(token)) return 'v3';
  } catch {
    /* fall through */
  }
  return 'unknown';
}

export async function resolveTokenVenue(tokenAddress: string, { skipCache = false } = {}): Promise<TokenVenue> {
  const token = getAddress(tokenAddress);
  const key = token.toLowerCase();
  if (!skipCache) {
    const hit = cache.get(key);
    if (hit && hit !== 'unknown') return hit;
  }
  const venue = (await venueFromDb(key)) ?? (await venueFromChain(token));
  cache.set(key, venue);
  return venue;
}

/** Tests / launch flow: record a venue we just established without a round trip. */
export function primeTokenVenue(tokenAddress: string, venue: TokenVenue) {
  cache.set(getAddress(tokenAddress).toLowerCase(), venue);
}
