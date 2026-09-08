/**
 * LEGIBLE-POOL FEES END TO END (Robinhood mainnet fork; the LIVE hook, converter, LossRewardPoolV2
 * and its 26 stock routes; real frontend modules via Vite SSR; the real worker function):
 *
 *   1. launch a legible token with GOOGL as the payout asset, buy twice through swap.ts
 *   2. the simulated collect() (src/lib/legibleFees.ts / scripts/lib/legiblePool.mjs) predicts the
 *      EXACT ethFees/tokenFees the real hook.collect(token) then emits in FeesCollected
 *   3. Creator Fees panel data: "accrued in pool" = creatorShare before collect, "ready to claim" =
 *      creatorBalances after; claimCreatorFees() from the creator's wallet is TWO transactions
 *      (collect, then claimCreatorFees) and pays the creator's half; with nothing uncollected it is ONE
 *   4. Loss-Reward panel: V2.getUnallocatedBalance(token) == lossPoolShare after the collect (the
 *      "Loss Pool Balance (V2, unallocated)" line); the stock display for a GOOGL allocation above
 *      the minimum quotes "≈ N GOOGL" from the live route pool, and below 0.002 ETH says "paid in ETH"
 *   5. the worker's collectLegibleFees() on a second round of trades: sends collect() (fees >> gas)
 *      then convert() on the pending token-side fees, and the converter's Converted event lands ETH in
 *      creatorBalances + V2 again
 *
 * Run: npm run test:fork -- test/hardhat/legible-fees-fork.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import http from 'node:http';
import { parseEther, getAddress, formatEther, parseAbi, decodeEventLog } from 'viem';
import { createServer as createViteServer } from 'vite';

const LEGIBLE_HOOK = getAddress('0x921d0bE20A21e5A687734b4dF6302EA55BD168C0');
const CONVERTER = getAddress('0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9');
const V2 = getAddress('0x5d94246CD31064Da02E953DB357F0001F0E9A631');
const GOOGL = getAddress('0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3');
const HOOK_ABI = parseAbi([
  'function creatorBalances(address creator) view returns (uint256)',
  'function lossRewardPool() view returns (address)',
  'event FeesCollected(bytes32 indexed poolId, uint256 ethFees, uint256 tokenFees, uint256 creatorShare, uint256 lossPoolShare)',
  'event CreatorFeesClaimed(address indexed creator, uint256 amount)',
]);
const CONVERTER_ABI = parseAbi([
  'function pendingTokenFees(address token) view returns (uint256)',
  'event Converted(address indexed token, uint256 tokensIn, uint256 ethOut, uint256 creatorShare, uint256 lossPoolShare)',
]);
const V2_ABI = parseAbi(['function getUnallocatedBalance(address token) view returns (uint256)', 'function totalDeposited(address token) view returns (uint256)', 'function rewardAsset(address token) view returns (address asset, bool assetSet, bool forcedEth)', 'function minStockRewardWei() view returns (uint256)']);

function extractRevertData(err: any): string | undefined {
  const c = [err?.data?.data, err?.data, err?.error?.data, err?.cause?.data, err?.cause?.cause?.data];
  for (const v of c) if (typeof v === 'string' && v.startsWith('0x') && v.length > 2) return v;
  return undefined;
}
async function startRpcProxy(provider: any) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const handleOne = async (item: any) => {
          try { return { jsonrpc: '2.0', id: item.id, result: await provider.request({ method: item.method, params: item.params }) }; }
          catch (err: any) { const data = extractRevertData(err); return { jsonrpc: '2.0', id: item.id, error: { code: data ? 3 : (err?.code ?? -32000), message: err?.shortMessage || err?.message || String(err), data } }; }
        };
        const out = Array.isArray(payload) ? await Promise.all(payload.map(handleOne)) : await handleOne(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
      } catch (err: any) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(err) })); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` };
}

describe('Legible-pool fees: simulated collect == real collect, creator collect-then-claim, V2 balance, stock display, worker collect/convert', () => {
  it('runs the whole fee path on the live contracts', async () => {
    const { viem, networkHelpers, provider } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [operatorWallet, creatorWallet, buyerWallet] = await viem.getWalletClients();
    const OPERATOR = getAddress(operatorWallet.account.address);
    const CREATOR = getAddress(creatorWallet.account.address);
    const BUYER = getAddress(buyerWallet.account.address);
    for (const a of [OPERATOR, CREATOR, BUYER]) await networkHelpers.setBalance(a, parseEther('10'));
    await networkHelpers.mine(1);
    console.log('--- Fork setup --- block', await publicClient.getBlockNumber());
    assert.equal(getAddress(await publicClient.readContract({ address: LEGIBLE_HOOK, abi: HOOK_ABI, functionName: 'lossRewardPool' })), V2, 'the live hook deposits into V2');

    const rpcProxy = await startRpcProxy(provider);
    const servers: Array<Awaited<ReturnType<typeof createViteServer>>> = [];
    try {
      process.env.VITE_EVM_RPC_URL = rpcProxy.url;
      process.env.VITE_SUPABASE_URL = '';
      process.env.VITE_SUPABASE_ANON_KEY = '';
      process.env.VITE_LEGIBLE_LAUNCH_ENABLED = 'true';
      process.env.VITE_STOCK_REWARDS_ENABLED = 'true';
      process.env.VITE_LOSS_REWARD_POOL_V2 = V2;

      let activeAccount: `0x${string}` = CREATOR;
      const sent: Array<{ to: string; from: string; gas?: string; data?: string; hash: string }> = [];
      (globalThis as any).window = {
        ethereum: {
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [activeAccount];
            if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
            const result = await provider.request({ method, params });
            if (method === 'eth_sendTransaction') { const p = (params as any[])[0]; sent.push({ to: p.to ? getAddress(p.to) : '(create)', from: getAddress(p.from), gas: p.gas, data: p.data, hash: result as string }); }
            return result;
          },
        },
      };
      const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
      servers.push(vite);
      const m = {
        createEvmToken: await vite.ssrLoadModule('/src/lib/createEvmToken.ts'),
        swap: await vite.ssrLoadModule('/src/lib/swap.ts'),
        creatorFees: await vite.ssrLoadModule('/src/lib/creatorFees.ts'),
        legibleFees: await vite.ssrLoadModule('/src/lib/legibleFees.ts'),
        lossReward: await vite.ssrLoadModule('/src/lib/lossReward.ts'),
        display: await vite.ssrLoadModule('/src/lib/lossRewardDisplay.ts'),
        rewardAssets: await vite.ssrLoadModule('/src/lib/rewardAssets.ts'),
      };

      // ---------------------------------------------------------------- 1. launch (GOOGL payout) + buys
      console.log('\n=== [1] launch a legible token paying GOOGL, buy twice ===');
      activeAccount = CREATOR;
      const launched = await m.createEvmToken.createEvmToken(null, { tokenName: 'Fee Path', tokenSymbol: 'FEEP', rewardAsset: GOOGL });
      const TOKEN = getAddress(launched.mint);
      const ra = await publicClient.readContract({ address: V2, abi: V2_ABI, functionName: 'rewardAsset', args: [TOKEN] });
      assert.equal(getAddress(ra[0]), GOOGL, 'V2 records GOOGL for the token');
      activeAccount = BUYER;
      await m.swap.buyToken(TOKEN, BUYER, '0.05', 1);
      await m.swap.buyToken(TOKEN, BUYER, '0.05', 1);
      console.log(`  token ${TOKEN}, 2 buys of 0.05 ETH  OK`);

      // ---------------------------------------------------------------- 2. simulated collect == real collect
      console.log('\n=== [2] simulated collect() == FeesCollected ===');
      const predicted = await m.legibleFees.computeUncollectedLegibleFees(TOKEN);
      assert.ok(predicted.seeded && !predicted.graduated);
      assert.ok(predicted.ethFees > 0n, 'buys left ETH fees in the position');
      assert.equal(predicted.tokenFees, 0n, 'buys only: no token-side fees yet');
      assert.equal(predicted.creatorShare, predicted.ethFees / 2n);
      assert.equal(await publicClient.readContract({ address: LEGIBLE_HOOK, abi: HOOK_ABI, functionName: 'creatorBalances', args: [CREATOR] }), 0n, 'nothing distributed yet (the production symptom)');
      assert.equal(await publicClient.readContract({ address: V2, abi: V2_ABI, functionName: 'getUnallocatedBalance', args: [TOKEN] }), 0n);

      // creator status before: "accrued in pool" = creatorShare, "ready" = 0
      const before = await m.creatorFees.fetchCreatorFeeStatus(TOKEN, CREATOR);
      assert.equal(before.isCreator, true);
      assert.equal(before.balanceWei, 0n, 'ready to claim = 0 before any collect');
      assert.equal(before.uncollected.creatorShare, predicted.creatorShare, 'accrued in pool (uncollected) = creator half of the simulated collect');
      assert.equal(m.creatorFees.hasUncollectedFees(before), true);

      // ---------------------------------------------------------------- 3. creator: collect + claim (2 txs)
      console.log('\n=== [3] creator claim = collect(token) then claimCreatorFees() ===');
      activeAccount = CREATOR;
      const ethBefore = await publicClient.getBalance({ address: CREATOR });
      const sentBefore = sent.length;
      const res = await m.creatorFees.claimCreatorFees(TOKEN, CREATOR);
      const txs = sent.slice(sentBefore);
      assert.equal(txs.length, 2, 'two transactions');
      assert.equal(txs[0].to, LEGIBLE_HOOK); assert.equal(txs[1].to, LEGIBLE_HOOK);
      assert.ok(BigInt(txs[0].gas!) >= 300_000n, `collect gas limit >= 300k (got ${BigInt(txs[0].gas!)})`);
      assert.equal(res.collectTxHash, txs[0].hash); assert.equal(res.txHash, txs[1].hash);
      const collectReceipt = await publicClient.getTransactionReceipt({ hash: res.collectTxHash });
      const collected = collectReceipt.logs.map((l) => { try { return decodeEventLog({ abi: HOOK_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e: any) => e?.eventName === 'FeesCollected') as any;
      assert.ok(collected, 'FeesCollected emitted');
      assert.equal(collected.args.ethFees, predicted.ethFees, 'REAL ethFees == simulated (exact)');
      assert.equal(collected.args.tokenFees, predicted.tokenFees);
      assert.equal(collected.args.creatorShare, predicted.creatorShare);
      assert.equal(collected.args.lossPoolShare, predicted.lossPoolShare);
      assert.equal(res.claimedEth, formatEther(predicted.creatorShare), 'claimed the creator half');
      let gasPaid = 0n;
      for (const t of txs) { const r = await publicClient.getTransactionReceipt({ hash: t.hash as `0x${string}` }); gasPaid += r.gasUsed * r.effectiveGasPrice; }
      assert.equal(await publicClient.getBalance({ address: CREATOR }), ethBefore - gasPaid + predicted.creatorShare, 'creator received exactly creatorShare net of gas');
      assert.equal(await publicClient.readContract({ address: LEGIBLE_HOOK, abi: HOOK_ABI, functionName: 'creatorBalances', args: [CREATOR] }), 0n, 'balance drained by the claim');
      const after = await m.creatorFees.fetchCreatorFeeStatus(TOKEN, CREATOR);
      assert.equal(after.uncollected.ethFees, 0n, 'nothing left in the position');
      assert.equal(m.creatorFees.hasUncollectedFees(after), false);
      await assert.rejects(m.creatorFees.claimCreatorFees(TOKEN, CREATOR), /No accrued creator fees/, 'nothing uncollected + nothing ready -> refuses, no transaction');
      console.log(`  collect ${formatEther(collected.args.ethFees)} ETH fees (creator ${formatEther(collected.args.creatorShare)} / loss pool ${formatEther(collected.args.lossPoolShare)}), then claim  OK`);

      // ---------------------------------------------------------------- 4. loss-reward panel data
      console.log('\n=== [4] Loss Pool Balance (V2, unallocated) + stock claim display ===');
      const balances = await m.lossReward.getLossPoolBalances(TOKEN);
      assert.equal(balances.v2UnallocatedWei, predicted.lossPoolShare, 'V2 unallocated == the loss-pool half of the collect');
      assert.equal(balances.v1UnallocatedWei, 0n, 'nothing on V1 for a post-re-point token');
      assert.equal(await publicClient.readContract({ address: V2, abi: V2_ABI, functionName: 'totalDeposited', args: [TOKEN] }), predicted.lossPoolShare);
      const minStock = await publicClient.readContract({ address: V2, abi: V2_ABI, functionName: 'minStockRewardWei' });
      assert.equal(await m.display.fetchMinStockRewardWei(), minStock);
      const above = await m.display.fetchStockClaimDisplay(TOKEN, parseEther('0.01'));
      assert.equal(above.asset.symbol, 'GOOGL');
      assert.equal(above.display.mode, 'stock', 'above the minimum -> stock estimate from the live GOOGL/WETH route');
      assert.match(above.display.primary, /^≈ \d+\.\d+ GOOGL$/);
      assert.match(above.display.secondary, /^0\.01000 ETH allocation/);
      const quoted = await m.rewardAssets.quoteStockForEth(GOOGL, parseEther('0.01'));
      const mult = await m.rewardAssets.fetchUiMultiplier(GOOGL);
      assert.equal(above.display.primary, `≈ ${m.rewardAssets.formatDisplayShares(quoted, mult, 6)} GOOGL`, 'display = quote × uiMultiplier / 1e18');
      const below = await m.display.fetchStockClaimDisplay(TOKEN, minStock - 1n);
      assert.equal(below.display.mode, 'below-min');
      assert.equal(below.display.primary, `Below ${formatEther(minStock)} ETH — paid in ETH`);
      console.log(`  V2 unallocated ${formatEther(balances.v2UnallocatedWei)} ETH; 0.01 ETH -> "${above.display.primary}"; ${formatEther(minStock - 1n)} ETH -> "${below.display.primary}"  OK`);

      // ---------------------------------------------------------------- 5. the worker: collect + convert
      console.log('\n=== [5] worker collectLegibleFees(): collect then convert on the live contracts ===');
      activeAccount = BUYER;
      const buyerTokens = await publicClient.readContract({ address: TOKEN, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [BUYER] });
      await m.swap.buyToken(TOKEN, BUYER, '0.05', 1);
      await m.swap.sellToken(TOKEN, BUYER, formatEther(buyerTokens / 3n), 1); // a sell leaves TOKEN-side fees in the position
      const pred2 = await m.legibleFees.computeUncollectedLegibleFees(TOKEN);
      assert.ok(pred2.ethFees > 0n && pred2.tokenFees > 0n, 'buy + sell -> ETH and token fees uncollected');
      process.env.OPERATOR_PRIVATE_KEY = '';
      process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://fork-fee-test.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fork-fee-test-key';
      const worker = await import('../../scripts/loss-reward-worker.mjs');
      const logs: string[] = [];
      const creatorBalBefore = await publicClient.readContract({ address: LEGIBLE_HOOK, abi: HOOK_ABI, functionName: 'creatorBalances', args: [CREATOR] });
      const v2Before = await publicClient.readContract({ address: V2, abi: V2_ABI, functionName: 'getUnallocatedBalance', args: [TOKEN] });
      // gasPriceWei pinned to Robinhood Chain's real ~0.3 gwei: the hardhat fork reports an inflated gas price that
      // would make 0.002 ETH of fees look like only ~4x gas (the 10x rule itself is covered offline in test/worker-fee-collection.test.mjs)
      const results = await worker.collectLegibleFees({ client: publicClient, walletClient: operatorWallet, tokens: [TOKEN], gasPriceWei: 300_000_000n, log: (l: string) => logs.push(l), alert: async () => {} });
      const r = results[0];
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.collect.sent, true, `collect sent (${r.collect.reason || ''})`);
      assert.equal(BigInt(r.collect.ethFees), pred2.ethFees, 'worker collect == simulated');
      assert.equal(BigInt(r.collect.tokenFees), pred2.tokenFees);
      assert.equal(r.convert.sent, true, `convert sent (${r.convert.reason || ''})`);
      assert.equal(BigInt(r.convert.tokensIn), pred2.tokenFees, 'all pending token fees converted');
      assert.ok(BigInt(r.convert.ethOut) > 0n);
      assert.equal(await publicClient.readContract({ address: CONVERTER, abi: CONVERTER_ABI, functionName: 'pendingTokenFees', args: [TOKEN] }), 0n, 'converter drained');
      const creatorBalAfter = await publicClient.readContract({ address: LEGIBLE_HOOK, abi: HOOK_ABI, functionName: 'creatorBalances', args: [CREATOR] });
      const v2After = await publicClient.readContract({ address: V2, abi: V2_ABI, functionName: 'getUnallocatedBalance', args: [TOKEN] });
      assert.equal(creatorBalAfter - creatorBalBefore, BigInt(r.collect.creatorShare) + BigInt(r.convert.creatorShare), 'creator credited by collect AND convert');
      assert.equal(v2After - v2Before, BigInt(r.collect.lossPoolShare) + BigInt(r.convert.lossPoolShare), 'V2 credited by collect AND convert');
      assert.ok(logs.some((l) => l.includes('collect() sent')) && logs.some((l) => l.includes('convert() sent')), 'both logged');
      assert.ok(BigInt(r.collect.gas) >= 300_000n && BigInt(r.convert.gas) >= 300_000n, 'gas headroom rule on both');
      await worker.closeV4Module();
      console.log(`  collect ${formatEther(BigInt(r.collect.ethFees))} ETH + ${formatEther(BigInt(r.collect.tokenFees))} tokens; convert -> ${formatEther(BigInt(r.convert.ethOut))} ETH; creator +${formatEther(creatorBalAfter - creatorBalBefore)} / V2 +${formatEther(v2After - v2Before)}  OK`);
    } finally {
      for (const s of servers) await s.close();
      rpcProxy.server.close();
      delete (globalThis as any).window;
    }
  });
});
