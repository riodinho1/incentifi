/**
 * ROBINHOOD ASSET LIST PROXY — GET /assets on the loss-reward gateway.
 *
 * Why: api.robinhood.com/rhj/assets sends no Access-Control-Allow-Origin header (and its OPTIONS
 * preflight 404s), so a browser fetch from the site fails with "TypeError: Failed to fetch" /
 * "blocked by CORS policy". The launch page uses the list only as an ENRICHMENT (ACTIVE status);
 * the chain is authoritative. This module fetches the list server-side, slims it to the fields the
 * frontend parser reads, and caches it in memory for a minute. Stale cache is served when the
 * upstream is down (with X-Assets-Cache: stale) so a Robinhood hiccup never breaks the dropdown.
 *
 * Plain ESM with no runtime imports so Deno (the edge function) and node (tests) both load it.
 */

export const DEFAULT_UPSTREAM_URL = 'https://api.robinhood.com/rhj/assets';
export const ASSETS_CACHE_TTL_MS = 60_000;
export const UPSTREAM_TIMEOUT_MS = 10_000;
// The upstream sits behind CloudFront; a browser-like UA avoids bot challenges.
const UPSTREAM_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 incentifi-loss-reward-gateway';

/** Keep exactly what src/lib/rewardAssets.ts parses (plus name/multiplier for display); drop logos etc. */
export function slimAssets(json, fetchedAtMs) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.assets) ? json.assets : [];
  const assets = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    assets.push({
      id: a.id ?? null,
      tokenSymbol: a.tokenSymbol ?? null,
      tokenName: a.tokenName ?? null,
      status: a.status ?? null,
      currentMultiplier: a.currentMultiplier ?? null,
      deployments: Array.isArray(a.deployments)
        ? a.deployments.map((d) => ({ contractAddress: d?.contractAddress ?? null, chainId: d?.chainId ?? null }))
        : [],
    });
  }
  return { assets, fetchedAt: new Date(fetchedAtMs).toISOString(), source: 'robinhood' };
}

/**
 * Returns a handler `() => Promise<{ status, body, headers }>`; the edge function wraps it in a
 * Response with the gateway's CORS headers. `fetchImpl`, `now` and `ttlMs` are injectable for tests.
 */
export function createAssetsProxy({ fetchImpl = globalThis.fetch, upstreamUrl = DEFAULT_UPSTREAM_URL, ttlMs = ASSETS_CACHE_TTL_MS, timeoutMs = UPSTREAM_TIMEOUT_MS, now = () => Date.now() } = {}) {
  let cache = null; // { body: string, fetchedAt: number }

  async function fetchUpstream() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(upstreamUrl, { headers: { Accept: 'application/json', 'User-Agent': UPSTREAM_UA }, signal: controller ? controller.signal : undefined });
      if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
      const json = await res.json();
      const slim = slimAssets(json, now());
      if (slim.assets.length === 0) throw new Error('upstream returned no assets');
      return JSON.stringify(slim);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return async function handleAssets() {
    const t = now();
    if (cache && t - cache.fetchedAt < ttlMs) {
      return { status: 200, body: cache.body, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'X-Assets-Cache': 'hit' } };
    }
    try {
      const body = await fetchUpstream();
      cache = { body, fetchedAt: t };
      return { status: 200, body, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'X-Assets-Cache': 'miss' } };
    } catch (err) {
      const message = err && err.name === 'AbortError' ? `upstream timeout after ${timeoutMs}ms` : String((err && err.message) || err);
      if (cache) {
        return { status: 200, body: cache.body, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30', 'X-Assets-Cache': 'stale', 'X-Assets-Upstream-Error': message } };
      }
      return { status: 502, body: JSON.stringify({ error: `Robinhood asset list unavailable: ${message}` }), headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Assets-Cache': 'none' } };
    }
  };
}
