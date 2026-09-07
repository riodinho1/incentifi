/**
 * GATEWAY ASSET-LIST PROXY — supabase/functions/loss-reward-gateway/assets-proxy.mjs.
 * The browser cannot read api.robinhood.com/rhj/assets (no CORS headers), so the gateway fetches it
 * server-side, slims it and caches it. Cases: miss -> upstream fetched; hit within TTL -> no upstream
 * call; TTL expiry -> refetch; upstream 5xx with a cache -> stale served; upstream down with no
 * cache -> 502; slim output keeps exactly what the frontend parser reads.
 *
 * Run: node test/gateway-assets-proxy.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import { createAssetsProxy, slimAssets } from '../supabase/functions/loss-reward-gateway/assets-proxy.mjs';

const upstreamJson = {
  assets: [
    { id: '0x1', tokenSymbol: 'AAPL', tokenName: 'Apple • Robinhood Token', status: 'ASSET_STATUS_ACTIVE', currentMultiplier: '1.000566', logoUrl: 'https://cdn/x.png', tradingCapabilities: { market: {} }, deployments: [{ contractAddress: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', chainId: 4663, networkName: 'Robinhood Chain' }] },
    { id: '0x2', tokenSymbol: 'TSLA', tokenName: 'Tesla', status: 'ASSET_STATUS_INACTIVE', deployments: [{ contractAddress: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', chainId: 4663 }] },
  ],
};

let t = 1_000_000;
const now = () => t;
let calls = 0;
let mode = 'ok';
const fetchImpl = async (url, init) => {
  calls++;
  assert.equal(url, 'https://upstream.test/assets');
  assert.equal(init.headers.Accept, 'application/json');
  assert.ok(init.headers['User-Agent'].includes('Mozilla'), 'browser-like UA for CloudFront');
  if (mode === 'http500') return { ok: false, status: 500, json: async () => ({}) };
  if (mode === 'down') throw new TypeError('fetch failed');
  return { ok: true, status: 200, json: async () => upstreamJson };
};
const handle = createAssetsProxy({ fetchImpl, upstreamUrl: 'https://upstream.test/assets', ttlMs: 60_000, now });

console.log('======================================================');
console.log('  GATEWAY /assets PROXY (Robinhood asset list)');
console.log('======================================================\n');

// 1. miss -> upstream fetched, slimmed
const r1 = await handle();
assert.equal(r1.status, 200);
assert.equal(r1.headers['X-Assets-Cache'], 'miss');
assert.equal(calls, 1);
const body1 = JSON.parse(r1.body);
assert.equal(body1.assets.length, 2);
assert.deepEqual(Object.keys(body1.assets[0]).sort(), ['currentMultiplier', 'deployments', 'id', 'status', 'tokenName', 'tokenSymbol'], 'slimmed to the parsed fields (no logoUrl / tradingCapabilities)');
assert.deepEqual(body1.assets[0].deployments, [{ contractAddress: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', chainId: 4663 }]);
assert.equal(body1.assets[1].status, 'ASSET_STATUS_INACTIVE', 'inactive rows are passed through - the FRONTEND decides');
assert.equal(body1.source, 'robinhood');
console.log('miss:   upstream fetched once, 2 assets slimmed  OK');

// 2. hit within TTL -> no upstream call
t += 30_000;
const r2 = await handle();
assert.equal(r2.headers['X-Assets-Cache'], 'hit');
assert.equal(calls, 1, 'served from cache');
assert.equal(r2.body, r1.body);
console.log('hit:    +30s served from cache, no upstream call  OK');

// 3. TTL expired -> refetch
t += 31_000;
const r3 = await handle();
assert.equal(r3.headers['X-Assets-Cache'], 'miss');
assert.equal(calls, 2);
console.log('expiry: +61s refetched  OK');

// 4. upstream 500 with a cache -> stale served, still 200
t += 61_000;
mode = 'http500';
const r4 = await handle();
assert.equal(r4.status, 200);
assert.equal(r4.headers['X-Assets-Cache'], 'stale');
assert.match(r4.headers['X-Assets-Upstream-Error'], /upstream HTTP 500/);
assert.equal(calls, 3);
console.log('stale:  upstream 500 -> last good body served with X-Assets-Cache: stale  OK');

// 5. fresh proxy, upstream down, no cache -> 502 with the reason
mode = 'down';
const cold = createAssetsProxy({ fetchImpl, upstreamUrl: 'https://upstream.test/assets', now });
const r5 = await cold();
assert.equal(r5.status, 502);
assert.match(JSON.parse(r5.body).error, /Robinhood asset list unavailable: fetch failed/);
assert.equal(r5.headers['Cache-Control'], 'no-store');
console.log('cold:   upstream down, no cache -> 502 with reason  OK');

// 6. slimAssets tolerates the bare-array shape and junk rows
const s = slimAssets([{ tokenSymbol: 'X', status: 'ASSET_STATUS_ACTIVE' }, null, 'junk'], 0);
assert.equal(s.assets.length, 1);
assert.deepEqual(s.assets[0].deployments, []);
assert.equal(s.fetchedAt, '1970-01-01T00:00:00.000Z');
console.log('slim:   bare array + junk rows tolerated  OK');

console.log('\ngateway-assets-proxy tests passed');
