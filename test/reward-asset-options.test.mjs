/**
 * LAUNCH DROPDOWN — src/lib/rewardAssets.ts getRewardAssetOptions(): the Robinhood asset list is an
 * OPTIONAL enrichment; the on-chain checks are authoritative.
 *
 * Production bug this pins: api.robinhood.com/rhj/assets has no CORS headers, so the browser fetch
 * rejects (TypeError: Failed to fetch) and every stock showed "unavailable (Robinhood asset list
 * unavailable)" although StockFactory round-trip + isSelectableAsset() passed.
 *
 * Cases (deps-injected, offline, real module loaded through Vite SSR):
 *   1. API unreachable            -> all three ENABLED (with a note), one console warning naming the error
 *   2. API reachable, TSLA inactive -> TSLA disabled "does not mark this asset ACTIVE", others enabled
 *   3. isSelectableAsset(NVDA) = false -> NVDA disabled "isSelectableAsset() is false", others enabled
 *   4. StockFactory round-trip false, address differs, V2 unset -> the named reasons
 *   5. fetchActiveStockAssetList: proxy first, direct fallback, both errors reported
 *
 * Run: node test/reward-asset-options.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import { createServer as createViteServer } from 'vite';

const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const TSLA = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';

const vite = await createViteServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const m = await vite.ssrLoadModule('/src/lib/rewardAssets.ts');
  const base = { flagEnabled: true, legibleEnabled: true, v2Configured: true, canonical: async () => true, selectable: async () => true };
  const byLabel = (opts) => Object.fromEntries(opts.map((o) => [o.symbol, o]));

  console.log('======================================================');
  console.log('  LAUNCH DROPDOWN: API optional, chain authoritative');
  console.log('======================================================\n');

  // 1. API unreachable -> all enabled, warning with the actual error
  {
    const warnings = [];
    const { options, assetList } = await m.getRewardAssetOptionsWithStatus({ ...base, fetchActive: async () => { throw new TypeError('Failed to fetch'); }, warn: (w) => warnings.push(w) });
    const by = byLabel(options);
    assert.equal(by.ETH.enabled, true);
    for (const s of ['AAPL', 'TSLA', 'NVDA']) {
      assert.equal(by[s].enabled, true, `${s} enabled on the on-chain checks alone`);
      assert.equal(by[s].reason, undefined);
      assert.equal(by[s].note, m.NOTE_API_UNREACHABLE);
    }
    assert.deepEqual(assetList, { reachable: false, error: 'Failed to fetch' });
    assert.equal(warnings.length, 1, 'exactly one warning');
    assert.match(warnings[0], /Robinhood asset list unreachable \(Failed to fetch\)/);
    assert.match(warnings[0], /on-chain checks alone/);
    console.log('1. API unreachable      -> AAPL TSLA NVDA enabled (note), 1 warning with the fetch error  OK');
  }

  // 2. API reachable, TSLA not ACTIVE -> only TSLA disabled, with that reason
  {
    const { options, assetList } = await m.getRewardAssetOptionsWithStatus({ ...base, fetchActive: async () => ({ active: new Map([['AAPL', AAPL], ['NVDA', NVDA]]), source: 'proxy' }) });
    const by = byLabel(options);
    assert.equal(by.AAPL.enabled, true); assert.equal(by.AAPL.note, undefined);
    assert.equal(by.NVDA.enabled, true);
    assert.equal(by.TSLA.enabled, false);
    assert.equal(by.TSLA.reason, m.REASON_API_INACTIVE);
    assert.deepEqual(assetList, { reachable: true, source: 'proxy' });
    console.log('2. API says TSLA inactive -> TSLA disabled "' + by.TSLA.reason + '"  OK');
  }

  // 3. isSelectableAsset(NVDA) false -> NVDA disabled with the on-chain reason, even though the API lists it
  {
    const options = await m.getRewardAssetOptions({ ...base, selectable: async (a) => a.toLowerCase() !== NVDA.toLowerCase(), fetchActive: async () => new Map([['AAPL', AAPL], ['TSLA', TSLA], ['NVDA', NVDA]]) });
    const by = byLabel(options);
    assert.equal(by.AAPL.enabled, true); assert.equal(by.TSLA.enabled, true);
    assert.equal(by.NVDA.enabled, false);
    assert.equal(by.NVDA.reason, m.REASON_NOT_SELECTABLE);
    assert.match(by.NVDA.reason, /isSelectableAsset\(\) is false/);
    console.log('3. isSelectableAsset(NVDA)=false -> NVDA disabled "' + by.NVDA.reason.slice(0, 60) + '…"  OK');
  }

  // 3b. the same with the API unreachable: the on-chain failure still disables, the others still enable
  {
    const options = await m.getRewardAssetOptions({ ...base, selectable: async (a) => a.toLowerCase() !== NVDA.toLowerCase(), fetchActive: async () => { throw new Error('HTTP 404'); }, warn: () => {} });
    const by = byLabel(options);
    assert.equal(by.AAPL.enabled, true); assert.equal(by.TSLA.enabled, true);
    assert.equal(by.NVDA.enabled, false); assert.equal(by.NVDA.reason, m.REASON_NOT_SELECTABLE);
    console.log('3b. API down + NVDA not selectable -> AAPL TSLA enabled, NVDA disabled on-chain  OK');
  }

  // 4. other named reasons: StockFactory round-trip, address differs, V2 unset
  {
    const canon = byLabel(await m.getRewardAssetOptions({ ...base, canonical: async (a) => a.toLowerCase() !== AAPL.toLowerCase(), fetchActive: async () => new Map([['AAPL', AAPL], ['TSLA', TSLA], ['NVDA', NVDA]]) }));
    assert.equal(canon.AAPL.enabled, false); assert.equal(canon.AAPL.reason, m.REASON_NOT_CANONICAL); assert.match(canon.AAPL.reason, /StockFactory round-trip/);
    assert.equal(canon.TSLA.enabled, true);
    const differs = byLabel(await m.getRewardAssetOptions({ ...base, fetchActive: async () => new Map([['AAPL', TSLA], ['TSLA', TSLA], ['NVDA', NVDA]]) }));
    assert.equal(differs.AAPL.enabled, false); assert.equal(differs.AAPL.reason, m.REASON_API_ADDRESS_DIFFERS);
    const noV2 = byLabel(await m.getRewardAssetOptions({ ...base, v2Configured: false, fetchActive: async () => { throw new Error('down'); }, warn: () => {} }));
    for (const s of ['AAPL', 'TSLA', 'NVDA']) { assert.equal(noV2[s].enabled, false); assert.equal(noV2[s].reason, m.REASON_V2_NOT_CONFIGURED); }
    const hidden = await m.getRewardAssetOptions({ ...base, flagEnabled: false, fetchActive: async () => { throw new Error('must not be called'); } });
    assert.deepEqual(hidden.map((o) => o.symbol), ['ETH']);
    console.log('4. StockFactory / address-differs / V2-unset / flag-off reasons  OK');
  }

  // 5. fetchActiveStockAssetList: proxy first, direct fallback, both errors surfaced
  {
    const payload = { assets: [{ tokenSymbol: 'AAPL', status: 'ASSET_STATUS_ACTIVE', deployments: [{ contractAddress: AAPL.toLowerCase(), chainId: 4663 }] }, { tokenSymbol: 'TSLA', status: 'ASSET_STATUS_INACTIVE', deployments: [{ contractAddress: TSLA, chainId: 4663 }] }, { tokenSymbol: 'NVDA', status: 'ASSET_STATUS_ACTIVE', deployments: [{ contractAddress: NVDA, chainId: 1 }] }] };
    const calls = [];
    const mk = (proxyOk, directOk) => async (url, init) => {
      calls.push(url);
      if (url.startsWith('https://proxy.test')) {
        assert.equal(init.headers.Accept, 'application/json');
        if (proxyOk) return { ok: true, status: 200, json: async () => payload };
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (directOk) return { ok: true, status: 200, json: async () => payload };
      throw new TypeError('Failed to fetch');
    };
    const viaProxy = await m.fetchActiveStockAssetList(mk(true, true), { proxyUrl: 'https://proxy.test/assets', directUrl: 'https://direct.test/assets' });
    assert.equal(viaProxy.source, 'proxy');
    assert.deepEqual([...viaProxy.active.entries()], [['AAPL', AAPL]], 'ACTIVE on chain 4663 only: TSLA inactive, NVDA on another chain; address checksummed');
    assert.deepEqual(calls, ['https://proxy.test/assets'], 'direct URL not touched when the proxy answers');
    calls.length = 0;
    const viaDirect = await m.fetchActiveStockAssetList(mk(false, true), { proxyUrl: 'https://proxy.test/assets', directUrl: 'https://direct.test/assets' });
    assert.equal(viaDirect.source, 'direct');
    assert.deepEqual(calls, ['https://proxy.test/assets', 'https://direct.test/assets']);
    await assert.rejects(m.fetchActiveStockAssetList(mk(false, false), { proxyUrl: 'https://proxy.test/assets', directUrl: 'https://direct.test/assets' }), (e) => {
      assert.match(e.message, /proxy https:\/\/proxy\.test\/assets: HTTP 404/);
      assert.match(e.message, /direct https:\/\/direct\.test\/assets: TypeError: Failed to fetch/);
      return true;
    });
    const noProxy = await m.fetchActiveStockAssetList(mk(false, true), { proxyUrl: '', directUrl: 'https://direct.test/assets' });
    assert.equal(noProxy.source, 'direct');
    console.log('5. proxy first, direct fallback, both errors reported when neither answers  OK');
  }

  console.log('\nreward-asset-options tests passed');
} finally {
  await vite.close();
}
