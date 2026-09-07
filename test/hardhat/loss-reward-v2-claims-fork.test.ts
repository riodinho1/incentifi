import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import http from 'node:http';
import { parseEther, getAddress, formatEther, parseAbi, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { createServer as createViteServer } from 'vite';

/**
 * LOSS REWARD V2 ROLLOUT — fork test of the REAL frontend modules (src/lib/lossReward.ts,
 * src/lib/rewardAssets.ts via Vite SSR) against a Robinhood mainnet fork with a fresh V1
 * LossRewardPool, a fresh LossRewardPoolV2 + RewardSwapperUniswapV3 (real StockFactory, real
 * AAPL/WETH pool), and a minimal EIP-1193 wallet.
 *
 *   1. one session claims a V1 epoch AND a V2 epoch for the same token: two transactions, V1 first
 *      (claimReward on V1), then V2 (claimRewardAs on V2); exact ETH delta net of gas; hasClaimed on both
 *   2. a stock-paying token: badge "Loss Reward: AAPL"; minAssetOut = quote × (1 − slippage) > 0;
 *      the claim delivers AAPL to the holder; the displayed balance applies uiMultiplier()
 *   3. dropdown options: flag off -> ETH only; flag on -> AAPL enabled only after the API + chain checks
 *   4. V2 address unset -> every V2 path is a no-op (badge ETH, options ETH, V2-tagged epoch refused)
 *
 * Run (isolated): npx hardhat test nodejs --network robinhoodFork -- test/hardhat/loss-reward-v2-claims-fork.test.ts
 */

const STOCK_FACTORY = getAddress('0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046');
const ACCESS_REGISTRY = getAddress('0xe10b6f6B275de231345c20D14Ab812db62151b00');
const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
const V3_FACTORY = getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
const AAPL = getAddress('0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9');
const TSLA = getAddress('0x322F0929c4625eD5bAd873c95208D54E1c003b2d');
const AAPL_POOL = getAddress('0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f');
const TOKEN_ETH = getAddress('0x00000000000000000000000000000000000000E1');
const TOKEN_AAPL = getAddress('0x00000000000000000000000000000000000000A1');

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function uiMultiplier() view returns (uint256)']);
const POOL_READ = parseAbi(['function hasClaimed(address,uint256,address) view returns (bool)']);

const leaf = (token: `0x${string}`, epochId: bigint, claimant: `0x${string}`, amount: bigint) =>
  keccak256(keccak256(encodeAbiParameters(parseAbiParameters('address, uint256, address, uint256'), [token, epochId, claimant, amount])));

function extractRevertData(err: any): string | undefined {
  const candidates = [err?.data?.data, err?.data, err?.cause?.data?.data, err?.cause?.data, err?.error?.data];
  for (const c of candidates) if (typeof c === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(c)) return c;
  const text = [err?.message, err?.details, err?.cause?.message].filter(Boolean).join(' ');
  const m = text.match(/0x[0-9a-fA-F]{8,}/);
  return m ? m[0] : undefined;
}

async function startRpcProxy(provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const handleOne = async (item: any) => {
          try {
            return { jsonrpc: '2.0', id: item.id, result: await provider.request({ method: item.method, params: item.params }) };
          } catch (err: any) {
            const data = extractRevertData(err);
            return { jsonrpc: '2.0', id: item.id, error: { code: data ? 3 : (err?.code ?? -32000), message: err?.shortMessage || err?.message || String(err), data } };
          }
        };
        const out = Array.isArray(payload) ? await Promise.all(payload.map(handleOne)) : await handleOne(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('LossRewardPoolV2 rollout: V1 + V2 claims in one session, stock payout, badge, uiMultiplier, dropdown gating', () => {
  it('claims from both pools, pays AAPL with a quote-derived bound, and is a no-op without a V2 address', async () => {
    const { viem, networkHelpers, provider } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [operatorWallet, holderWallet] = await viem.getWalletClients();
    const OPERATOR = getAddress(operatorWallet.account.address);
    const HOLDER = getAddress(holderWallet.account.address);
    await networkHelpers.setBalance(OPERATOR, parseEther('20'));
    await networkHelpers.setBalance(HOLDER, parseEther('1'));
    await networkHelpers.mine(1);
    console.log('--- Fork setup --- block', await publicClient.getBlockNumber());

    // Fresh V1 and V2 (operator = this test), swapper, AAPL route, asset setter = operator.
    const v1 = await viem.deployContract('LossRewardPool', [OPERATOR]);
    const v2 = await viem.deployContract('LossRewardPoolV2', [OPERATOR, STOCK_FACTORY, ACCESS_REGISTRY]);
    const swapper = await viem.deployContract('RewardSwapperUniswapV3', [v2.address, WETH, V3_FACTORY]);
    await publicClient.waitForTransactionReceipt({ hash: await v2.write.setAssetRoute([AAPL, { swapper: swapper.address, pool: AAPL_POOL, fee: 500, twapWindow: 1800, maxDeviationBps: 300, enabled: true }]) });
    await publicClient.waitForTransactionReceipt({ hash: await v2.write.setAssetSetter([OPERATOR, true]) });
    await publicClient.waitForTransactionReceipt({ hash: await v2.write.setMinStockReward([parseEther('0.002')]) });
    await publicClient.waitForTransactionReceipt({ hash: await v2.write.setRewardAsset([TOKEN_ETH, '0x0000000000000000000000000000000000000000']) });
    await publicClient.waitForTransactionReceipt({ hash: await v2.write.setRewardAsset([TOKEN_AAPL, AAPL]) });
    const V1 = getAddress(v1.address);
    const V2 = getAddress(v2.address);
    console.log('V1', V1, '| V2', V2, '| swapper', swapper.address);

    // Fund + publish: epoch 1 on V1 (0.05 ETH), epoch 2 on V2 (0.03 ETH) for TOKEN_ETH; epoch 1 on V2 (0.05 ETH) for TOKEN_AAPL.
    const A1 = parseEther('0.05'), A2 = parseEther('0.03'), B1 = parseEther('0.05');
    await publicClient.waitForTransactionReceipt({ hash: await v1.write.depositReward([TOKEN_ETH], { value: parseEther('1') }) });
    await publicClient.waitForTransactionReceipt({ hash: await v2.write.depositReward([TOKEN_ETH], { value: parseEther('1') }) });
    await publicClient.waitForTransactionReceipt({ hash: await v2.write.depositReward([TOKEN_AAPL], { value: parseEther('1') }) });
    await publicClient.waitForTransactionReceipt({ hash: await v1.write.setEpochMerkleRoot([TOKEN_ETH, 1n, leaf(TOKEN_ETH, 1n, HOLDER, A1), A1]) });
    await publicClient.waitForTransactionReceipt({ hash: await v2.write.setEpochMerkleRoot([TOKEN_ETH, 2n, leaf(TOKEN_ETH, 2n, HOLDER, A2), A2]) });
    await publicClient.waitForTransactionReceipt({ hash: await v2.write.setEpochMerkleRoot([TOKEN_AAPL, 1n, leaf(TOKEN_AAPL, 1n, HOLDER, B1), B1]) });

    const rpcProxy = await startRpcProxy(provider);
    const servers: Array<Awaited<ReturnType<typeof createViteServer>>> = [];
    try {
      process.env.VITE_EVM_RPC_URL = rpcProxy.url;
      process.env.VITE_SUPABASE_URL = '';
      process.env.VITE_SUPABASE_ANON_KEY = '';
      process.env.VITE_LOSS_REWARD_POOL = V1;

      const sent: Array<{ to: string; data: string; hash: string }> = [];
      let activeAccount: `0x${string}` = HOLDER;
      (globalThis as any).window = {
        ethereum: {
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [activeAccount];
            if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
            const result = await provider.request({ method, params });
            if (method === 'eth_sendTransaction') {
              const p = (params as any[])[0];
              sent.push({ to: getAddress(p.to), data: p.data, hash: result as string });
            }
            return result;
          },
        },
      };

      const load = async (v2Env: string) => {
        process.env.VITE_LOSS_REWARD_POOL_V2 = v2Env;
        process.env.VITE_STOCK_REWARDS_ENABLED = 'true';
        process.env.VITE_LEGIBLE_LAUNCH_ENABLED = 'true';
        const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
        servers.push(vite);
        return {
          lossReward: await vite.ssrLoadModule('/src/lib/lossReward.ts'),
          rewardAssets: await vite.ssrLoadModule('/src/lib/rewardAssets.ts'),
          addresses: await vite.ssrLoadModule('/src/lib/uniswapAddresses.ts'),
        };
      };

      // ============================================================================
      // 1. V1 + V2 epochs in one session
      // ============================================================================
      console.log('\n=== [1] claim a V1 epoch and a V2 epoch for the same token in one session ===');
      const m = await load(V2);
      assert.equal(getAddress(m.addresses.LOSS_REWARD_POOL), V1);
      assert.equal(m.rewardAssets.isV2Configured(), true);
      const ethBefore = await publicClient.getBalance({ address: HOLDER });
      const sentBefore = sent.length;
      const res = await m.lossReward.claimBatchRewards(
        TOKEN_ETH,
        HOLDER,
        [
          { id: 2, epochId: 2, epochNumber: 2, finalRewardEth: 0.03, amountWei: A2.toString(), merkleProof: [], poolAddress: V2 },
          { id: 1, epochId: 1, epochNumber: 1, finalRewardEth: 0.05, amountWei: A1.toString(), merkleProof: [], poolAddress: null },
        ],
        { slippagePct: 1 }
      );
      const txs = sent.slice(sentBefore);
      assert.equal(txs.length, 2, 'one transaction per pool');
      assert.equal(res.txHashes.length, 2);
      assert.equal(txs[0].to, V1, 'V1 first');
      assert.equal(txs[0].data.slice(0, 10), keccak256(new TextEncoder().encode('claimReward(address,uint256,uint256,bytes32[])')).slice(0, 10), 'V1: claimReward');
      assert.equal(txs[1].to, V2, 'then V2');
      assert.equal(txs[1].data.slice(0, 10), keccak256(new TextEncoder().encode('claimRewardAs(address,uint256,uint256,bytes32[],uint256,uint256)')).slice(0, 10), 'V2: claimRewardAs');
      let gas = 0n;
      for (const t of txs) {
        const r = await publicClient.getTransactionReceipt({ hash: t.hash as `0x${string}` });
        assert.equal(r.status, 'success');
        gas += r.gasUsed * r.effectiveGasPrice;
      }
      const ethAfter = await publicClient.getBalance({ address: HOLDER });
      assert.equal(ethAfter - ethBefore + gas, A1 + A2, 'holder received exactly both epochs, net of gas');
      assert.equal(res.claimedEth, formatEther(A1 + A2));
      assert.equal(await publicClient.readContract({ address: V1, abi: POOL_READ, functionName: 'hasClaimed', args: [TOKEN_ETH, 1n, HOLDER] }), true);
      assert.equal(await publicClient.readContract({ address: V2, abi: POOL_READ, functionName: 'hasClaimed', args: [TOKEN_ETH, 2n, HOLDER] }), true);
      console.log(`  V1 ${txs[0].hash.slice(0, 10)}… + V2 ${txs[1].hash.slice(0, 10)}… -> +${formatEther(A1 + A2)} ETH net of gas  OK`);

      // ============================================================================
      // 2. stock token: badge, quote-derived bound, AAPL delivered, uiMultiplier display
      // ============================================================================
      console.log('\n=== [2] stock-paying token: badge, minAssetOut from quote × (1 − slippage), AAPL delivered ===');
      const info = await m.rewardAssets.getTokenRewardAsset(TOKEN_AAPL);
      assert.equal(info.isStock, true);
      assert.equal(getAddress(info.asset), AAPL);
      assert.equal(info.symbol, 'AAPL');
      assert.equal(m.rewardAssets.formatRewardAssetBadge(info.symbol), 'Loss Reward: AAPL');
      const ethInfo = await m.rewardAssets.getTokenRewardAsset(TOKEN_ETH);
      assert.equal(ethInfo.isStock, false);
      assert.equal(m.rewardAssets.formatRewardAssetBadge(ethInfo.symbol), 'Loss Reward: ETH');

      const bound = await m.rewardAssets.computeMinAssetOut(TOKEN_AAPL, B1, 1);
      assert.ok(bound.quoted > 0n, 'QuoterV2 quote on the route pool');
      assert.equal(bound.minAssetOut, (bound.quoted * 9_900n) / 10_000n, 'minAssetOut = quote × (1 − 1%)');
      const bound5 = await m.rewardAssets.computeMinAssetOut(TOKEN_AAPL, B1, 5);
      assert.equal(bound5.minAssetOut, (bound.quoted * 9_500n) / 10_000n, 'slippage setting is honoured');

      const aaplBefore = await publicClient.readContract({ address: AAPL, abi: ERC20, functionName: 'balanceOf', args: [HOLDER] });
      const sentBefore2 = sent.length;
      const res2 = await m.lossReward.claimBatchRewards(TOKEN_AAPL, HOLDER, [{ id: 3, epochId: 3, epochNumber: 1, finalRewardEth: 0.05, amountWei: B1.toString(), merkleProof: [], poolAddress: V2 }], { slippagePct: 1 });
      assert.equal(sent.length - sentBefore2, 1);
      assert.equal(sent[sent.length - 1].to, V2);
      const r2 = await publicClient.getTransactionReceipt({ hash: res2.txHash });
      assert.equal(r2.status, 'success');
      const aaplAfter = await publicClient.readContract({ address: AAPL, abi: ERC20, functionName: 'balanceOf', args: [HOLDER] });
      const received = aaplAfter - aaplBefore;
      assert.ok(received >= bound.minAssetOut, 'delivered AAPL >= the user bound');
      assert.ok(received > 0n);
      assert.equal(await publicClient.readContract({ address: AAPL, abi: ERC20, functionName: 'balanceOf', args: [V2] }), 0n, 'pool holds no AAPL');
      assert.equal(await publicClient.readContract({ address: AAPL, abi: ERC20, functionName: 'balanceOf', args: [swapper.address] }), 0n, 'adapter holds no AAPL');

      const mult = await publicClient.readContract({ address: AAPL, abi: ERC20, functionName: 'uiMultiplier' });
      const display = await m.rewardAssets.fetchStockBalanceDisplay(AAPL, HOLDER);
      assert.equal(display.raw, aaplAfter);
      assert.equal(display.multiplier, mult);
      assert.equal(m.rewardAssets.toDisplayShares(aaplAfter, mult), (aaplAfter * mult) / 10n ** 18n, 'display = raw × uiMultiplier / 1e18');
      if (mult !== 10n ** 18n) assert.notEqual(m.rewardAssets.toDisplayShares(aaplAfter, mult), aaplAfter, 'multiplier != 1 changes the displayed figure');
      console.log(`  received ${formatEther(received)} AAPL raw (min ${formatEther(bound.minAssetOut)}); uiMultiplier ${formatEther(mult)} -> display ${display.display} shares  OK`);

      // ============================================================================
      // 3. dropdown options
      // ============================================================================
      console.log('\n=== [3] launch dropdown options ===');
      const off = await m.rewardAssets.getRewardAssetOptions({ flagEnabled: false });
      assert.deepEqual(off.map((o: any) => o.symbol), ['ETH'], 'flag off -> ETH only (dropdown hidden)');
      const fakeApi = async () => new Map<string, `0x${string}`>([['AAPL', AAPL], ['TSLA', TSLA]]); // NVDA not active in this fixture
      const on = await m.rewardAssets.getRewardAssetOptions({ flagEnabled: true, legibleEnabled: true, fetchActive: fakeApi });
      const by = Object.fromEntries(on.map((o: any) => [o.symbol, o]));
      assert.equal(by.ETH.enabled, true);
      assert.equal(by.AAPL.enabled, true, 'AAPL: active + canonical + route on V2');
      assert.equal(by.TSLA.enabled, false);
      assert.match(by.TSLA.reason, /not enabled on the reward pool/, 'TSLA: canonical but no route configured');
      assert.equal(by.NVDA.enabled, false);
      assert.match(by.NVDA.reason, /not listed as active/);
      const apiDown = await m.rewardAssets.getRewardAssetOptions({ flagEnabled: true, legibleEnabled: true, fetchActive: async () => { throw new Error('down'); } });
      assert.ok(apiDown.filter((o: any) => o.symbol !== 'ETH').every((o: any) => !o.enabled), 'API down -> no stock enabled');
      console.log(`  flag off: ${off.map((o: any) => o.symbol).join(',')} | flag on: ${on.map((o: any) => `${o.symbol}${o.enabled ? '' : '(x)'}`).join(' ')}  OK`);

      // ============================================================================
      // 4. V2 unset -> no-ops
      // ============================================================================
      console.log('\n=== [4] V2 address unset: every V2 path is a no-op ===');
      const u = await load('');
      assert.equal(u.rewardAssets.isV2Configured(), false);
      assert.equal((await u.rewardAssets.getTokenRewardAsset(TOKEN_AAPL)).symbol, 'ETH', 'badge falls back to ETH');
      const uOpts = await u.rewardAssets.getRewardAssetOptions({ flagEnabled: true, legibleEnabled: true, fetchActive: fakeApi });
      const uBy = Object.fromEntries(uOpts.map((o: any) => [o.symbol, o]));
      assert.ok(uOpts.filter((o: any) => o.symbol !== 'ETH').every((o: any) => !o.enabled), 'no stock can be enabled without V2');
      assert.match(uBy.AAPL.reason, /V2 not configured/, 'AAPL is canonical + listed, blocked only by the missing V2 address');
      assert.match(uBy.TSLA.reason, /V2 not configured/);
      assert.match(uBy.NVDA.reason, /not listed as active/, 'NVDA is unlisted in this fixture, so that reason comes first');
      await assert.rejects(
        u.lossReward.claimBatchRewards(TOKEN_ETH, HOLDER, [{ id: 9, epochId: 9, epochNumber: 3, finalRewardEth: 0.01, amountWei: parseEther('0.01').toString(), merkleProof: [], poolAddress: V2 }]),
        /not configured for|LossRewardPoolV2 address not set/
      );
      console.log('  badge=ETH, no stock option enabled, V2-tagged epoch refused  OK');
    } finally {
      for (const s of servers) await s.close();
      rpcProxy.server.close();
      delete (globalThis as any).window;
    }
  });
});
