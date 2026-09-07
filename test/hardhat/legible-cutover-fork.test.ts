import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import http from 'node:http';
import { parseEther, getAddress, formatEther, parseAbi, createPublicClient, http as viemHttp } from 'viem';
import { createServer as createViteServer } from 'vite';

/**
 * LEGIBLE POOL CUTOVER — fork test of the REAL frontend modules (Vite SSR) against a Robinhood
 * mainnet fork with the REAL deployed legible trio (hook 0x921d0bE2…, factory 0xD4ce8F95…) and
 * the REAL GenericSell trio, through a minimal EIP-1193 wallet.
 *
 *   flag ON  (VITE_LEGIBLE_LAUNCH_ENABLED=true): createEvmToken launches on the legible factory
 *            with rewardAsset = address(0); the curve is a real V4 position; swap.ts routes the
 *            token to UniversalRouter for a buy AND a sell (Permit2), every swap with an explicit
 *            gas limit >= 300,000; the V4 Quoter's quote equals the executed amount; creator fees
 *            resolve to the legible hook.
 *   flag OFF (default): createEvmToken launches on the previous GenericSell factory, and a buy on
 *            that token goes through IncentifiV4Router exactly as before. TESTINGG (live GenericSell
 *            token) resolves to the old venue.
 *   calldata: the frontend's UniversalRouter encoding is byte-identical to the input of the
 *            mainnet smoke-test transaction (read from the live chain, read-only).
 *
 * Run (isolated): npx hardhat test nodejs --network robinhoodFork -- test/hardhat/legible-cutover-fork.test.ts
 */

const LEGIBLE_HOOK = getAddress('0x921d0bE20A21e5A687734b4dF6302EA55BD168C0');
const LEGIBLE_FACTORY = getAddress('0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const OLD_V4_HOOK = getAddress('0xC5Ef9Cb8c95cd8540E71b6D4c00a90257625a888');
const OLD_V4_FACTORY = getAddress('0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0');
const OLD_V4_ROUTER = getAddress('0x762b4D9e514e4B19E54E99b62E7b731CE37FF1E6');
const UNIVERSAL_ROUTER = getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904');
const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3');
const POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951');
const TESTINGG = getAddress('0x7F9b8A09877F6e8096b0b8c6027DC49580b05474');
const SMK = getAddress('0xC517a3235293Fa456723090B4C64354C2b80E725');
const SMOKE_BUY_TX = '0x81c6b0e8c43a28e025b0fe4efcced5d6969d40eb1a9c18e3897f7dcd4815b4be'; // SMK94829 first buy: 0.01 ETH, minOut 0, deadline 1788795447
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const FACTORY = parseAbi(['function isLaunched(address) view returns (bool)', 'function getPoolKey(address) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))']);
const HOOK = parseAbi(['function creatorBalances(address) view returns (uint256)', 'function collect(address token)']);
const HOOK_EVENTS = parseAbi([
  'event Bought(bytes32 indexed poolId, address indexed trader, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event Sold(bytes32 indexed poolId, address indexed trader, uint256 tokensIn, uint256 ethOut, uint256 creatorFee, uint256 lossPoolFee)',
]);

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

type Sent = { to: string; from: string; gas?: string; value?: string; data?: string; hash: string };

describe('Legible pool cutover (flag on/off launch, UR trading, old path intact, calldata parity)', () => {
  it('routes per token: legible launches trade through UniversalRouter; old launches and TESTINGG keep the old path', async () => {
    const { viem, networkHelpers, provider } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [, creatorWallet, buyerWallet] = await viem.getWalletClients();
    const CREATOR = getAddress(creatorWallet.account.address);
    const BUYER = getAddress(buyerWallet.account.address);
    for (const a of [CREATOR, BUYER]) await networkHelpers.setBalance(a, parseEther('10'));
    await networkHelpers.mine(1);
    console.log('--- Fork setup --- block', await publicClient.getBlockNumber());

    const rpcProxy = await startRpcProxy(provider);
    const servers: Array<Awaited<ReturnType<typeof createViteServer>>> = [];
    try {
      // Frontend env: RPC -> fork proxy; Supabase off (venue resolution must come from the chain here).
      process.env.VITE_EVM_RPC_URL = rpcProxy.url;
      process.env.VITE_SUPABASE_URL = '';
      process.env.VITE_SUPABASE_ANON_KEY = '';

      let activeAccount: `0x${string}` = CREATOR;
      const sent: Sent[] = [];
      (globalThis as any).window = {
        ethereum: {
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [activeAccount];
            if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
            const result = await provider.request({ method, params });
            if (method === 'eth_sendTransaction') {
              const p = (params as any[])[0];
              // contract creations carry no `to`
              sent.push({ to: p.to ? getAddress(p.to) : '(create)', from: getAddress(p.from), gas: p.gas, value: p.value, data: p.data, hash: result as string });
            }
            return result;
          },
        },
      };

      const load = async (flag: 'true' | 'false') => {
        process.env.VITE_LEGIBLE_LAUNCH_ENABLED = flag;
        const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
        servers.push(vite);
        const addresses = await vite.ssrLoadModule('/src/lib/uniswapAddresses.ts');
        assert.equal(addresses.LEGIBLE_LAUNCH_ENABLED, flag === 'true', `flag must read as ${flag}`);
        assert.equal(getAddress(addresses.INCENTIFI_LEGIBLE_HOOK), LEGIBLE_HOOK);
        return {
          createEvmToken: await vite.ssrLoadModule('/src/lib/createEvmToken.ts'),
          swap: await vite.ssrLoadModule('/src/lib/swap.ts'),
          venue: await vite.ssrLoadModule('/src/lib/tokenVenue.ts'),
          creatorFees: await vite.ssrLoadModule('/src/lib/creatorFees.ts'),
          legible: await vite.ssrLoadModule('/src/lib/legiblePool.ts'),
        };
      };

      // ================================================================================
      // FLAG ON
      // ================================================================================
      console.log('\n=== flag ON: launch through the legible factory ===');
      const on = await load('true');
      assert.equal(on.createEvmToken.getLaunchVenue(), 'legible');
      activeAccount = CREATOR;
      const sentBefore = sent.length;
      const launched = await on.createEvmToken.createEvmToken(null, { tokenName: 'Legible Cutover', tokenSymbol: 'LGC' });
      const TOKEN = getAddress(launched.mint);
      assert.equal(launched.venue, 'legible');
      assert.equal(getAddress(launched.hookAddress), LEGIBLE_HOOK);
      assert.equal(launched.lossRewardAsset, 'ETH');
      assert.equal(sent.length - sentBefore, 3, 'deploy + approve + launch');
      assert.equal(sent[sent.length - 1].to, LEGIBLE_FACTORY, 'the launch tx targets the legible factory');
      assert.equal(await publicClient.readContract({ address: LEGIBLE_FACTORY, abi: FACTORY, functionName: 'isLaunched', args: [TOKEN] }), true);
      assert.equal(await publicClient.readContract({ address: OLD_V4_FACTORY, abi: FACTORY, functionName: 'isLaunched', args: [TOKEN] }), false);
      const hookBal = await publicClient.readContract({ address: TOKEN, abi: ERC20, functionName: 'balanceOf', args: [LEGIBLE_HOOK] });
      const pmBal = await publicClient.readContract({ address: TOKEN, abi: ERC20, functionName: 'balanceOf', args: [POOL_MANAGER] });
      assert.equal(hookBal + pmBal, TOTAL_SUPPLY, 'reserve on the hook + curve position in the PoolManager == supply');
      assert.ok(pmBal > 700_000_000n * 10n ** 18n, 'the curve position is a real PoolManager balance');
      console.log(`  token ${TOKEN}: hook reserve ${formatEther(hookBal)} + PoolManager ${formatEther(pmBal)} tokens  OK`);

      assert.equal(await on.venue.resolveTokenVenue(TOKEN, { skipCache: true }), 'legible');
      const state0 = await on.swap.getUnifiedMarketState(TOKEN);
      assert.equal(state0.venue, 'legible');
      assert.equal(state0.isV4, true);
      assert.equal(state0.tradingSupported, true);
      assert.ok(state0.priceEth > 0 && state0.progressBps === 0 && !state0.isGraduated);
      console.log(`  getUnifiedMarketState: venue=${state0.venue} price=${state0.priceEth.toExponential(4)} progress=${state0.progressBps}bps  OK`);

      // ---- buy via swap.ts -> UniversalRouter ----
      console.log('\n=== flag ON: buy 0.01 ETH through swap.ts (UniversalRouter, explicit gas) ===');
      activeAccount = BUYER;
      const quoteBefore = await on.legible.quoteLegibleBuy(TOKEN, parseEther('0.01'));
      const sentBeforeBuy = sent.length;
      const buy = await on.swap.buyToken(TOKEN, BUYER, '0.01', 1);
      const buyTx = sent[sent.length - 1];
      assert.equal(sent.length - sentBeforeBuy, 1, 'a buy is exactly one transaction');
      assert.equal(buyTx.to, UNIVERSAL_ROUTER, 'buy goes to UniversalRouter');
      assert.ok(buyTx.gas, 'an explicit gas limit is set');
      assert.ok(BigInt(buyTx.gas!) >= 300_000n, `gas limit >= 300,000 (got ${BigInt(buyTx.gas!)})`);
      const buyReceipt = await publicClient.getTransactionReceipt({ hash: buy.txHash });
      assert.equal(buyReceipt.status, 'success');
      const bought = (await publicClient.getLogs({ address: LEGIBLE_HOOK, event: HOOK_EVENTS[0], fromBlock: buyReceipt.blockNumber, toBlock: buyReceipt.blockNumber }))[0];
      assert.equal(getAddress(bought.args.trader!), BUYER);
      assert.equal(bought.args.tokensOut, quoteBefore.amount, 'V4 Quoter quote == executed tokensOut (same pool state)');
      const buyerTokens = await publicClient.readContract({ address: TOKEN, abi: ERC20, functionName: 'balanceOf', args: [BUYER] });
      assert.equal(buyerTokens, bought.args.tokensOut);
      assert.equal(BigInt(Math.round(buy.trade.amountToken * 1e18)) / 10n ** 12n, buyerTokens / 10n ** 12n, 'swap.ts reports the executed amount');
      console.log(`  tx ${buy.txHash} gas limit ${BigInt(buyTx.gas!)} -> ${formatEther(buyerTokens)} tokens == quoter  OK`);

      // ---- sell half via swap.ts -> Permit2 + UniversalRouter ----
      console.log('\n=== flag ON: sell half through swap.ts (Permit2 approvals + UniversalRouter) ===');
      const half = buyerTokens / 2n;
      const sellQuote = await on.legible.quoteLegibleSell(TOKEN, half);
      const ethBefore = await publicClient.getBalance({ address: BUYER });
      const sentBeforeSell = sent.length;
      const sell = await on.swap.sellToken(TOKEN, BUYER, formatEther(half), 1);
      const sellTxs = sent.slice(sentBeforeSell);
      assert.equal(sellTxs.length, 3, 'ERC20 approve(Permit2) + Permit2 approve(UR) + UR execute');
      assert.equal(sellTxs[0].to, TOKEN);
      assert.equal(sellTxs[1].to, PERMIT2);
      assert.equal(sellTxs[2].to, UNIVERSAL_ROUTER);
      assert.ok(BigInt(sellTxs[2].gas!) >= 300_000n, 'sell gas limit >= 300,000');
      const sellReceipt = await publicClient.getTransactionReceipt({ hash: sell.txHash });
      assert.equal(sellReceipt.status, 'success');
      const sold = (await publicClient.getLogs({ address: LEGIBLE_HOOK, event: HOOK_EVENTS[1], fromBlock: sellReceipt.blockNumber, toBlock: sellReceipt.blockNumber }))[0];
      assert.equal(sold.args.tokensIn, half);
      assert.equal(sold.args.ethOut, sellQuote.amount, 'V4 Quoter sell quote == executed ethOut');
      let gasPaid = 0n;
      for (const t of sellTxs) {
        const r = await publicClient.getTransactionReceipt({ hash: t.hash as `0x${string}` });
        gasPaid += r.gasUsed * r.effectiveGasPrice;
      }
      const ethAfter = await publicClient.getBalance({ address: BUYER });
      assert.equal(ethAfter - ethBefore + gasPaid, sold.args.ethOut, 'buyer received exactly ethOut net of gas');
      console.log(`  ${sellTxs.length} txs; ethOut ${formatEther(sold.args.ethOut!)} == quoter  OK`);

      // ---- second sell: approvals already in place -> exactly one tx ----
      const sentBeforeSell2 = sent.length;
      await on.swap.sellToken(TOKEN, BUYER, formatEther(buyerTokens / 4n), 1);
      assert.equal(sent.length - sentBeforeSell2, 1, 'approvals are not repeated');

      // ---- creator fees resolve to the legible hook ----
      console.log('\n=== flag ON: creator fees on the legible hook ===');
      await publicClient.waitForTransactionReceipt({ hash: await (await viem.getContractAt('IncentifiV4LegibleHook', LEGIBLE_HOOK)).write.collect([TOKEN], { account: buyerWallet.account }) });
      const status = await on.creatorFees.fetchCreatorFeeStatus(TOKEN, CREATOR);
      assert.equal(status.source.kind, 'v4');
      assert.equal(status.source.venue, 'legible');
      assert.equal(getAddress(status.source.contract), LEGIBLE_HOOK);
      assert.equal(getAddress(status.creator), CREATOR);
      assert.equal(status.isCreator, true);
      const hookCreatorBal = await publicClient.readContract({ address: LEGIBLE_HOOK, abi: HOOK, functionName: 'creatorBalances', args: [CREATOR] });
      assert.equal(status.balanceWei, hookCreatorBal);
      assert.ok(hookCreatorBal > 0n, 'collect() credited the creator');
      console.log(`  creatorBalances[creator] = ${formatEther(hookCreatorBal)} ETH via the legible hook  OK`);

      // ================================================================================
      // FLAG OFF
      // ================================================================================
      console.log('\n=== flag OFF: launch through the previous GenericSell factory ===');
      const off = await load('false');
      assert.equal(off.createEvmToken.getLaunchVenue(), 'v4-generic');
      activeAccount = CREATOR;
      const launchedOld = await off.createEvmToken.createEvmToken(null, { tokenName: 'Old Path', tokenSymbol: 'OLDP' });
      const OLD_TOKEN = getAddress(launchedOld.mint);
      assert.equal(launchedOld.venue, 'v4-generic');
      assert.equal(getAddress(launchedOld.hookAddress), OLD_V4_HOOK);
      assert.equal(sent[sent.length - 1].to, OLD_V4_FACTORY, 'the launch tx targets the GenericSell factory');
      assert.equal(await publicClient.readContract({ address: OLD_V4_FACTORY, abi: FACTORY, functionName: 'isLaunched', args: [OLD_TOKEN] }), true);
      assert.equal(await publicClient.readContract({ address: LEGIBLE_FACTORY, abi: FACTORY, functionName: 'isLaunched', args: [OLD_TOKEN] }), false);
      assert.equal(await publicClient.readContract({ address: OLD_TOKEN, abi: ERC20, functionName: 'balanceOf', args: [OLD_V4_HOOK] }), TOTAL_SUPPLY, 'GenericSell hook holds the whole supply');
      assert.equal(await off.venue.resolveTokenVenue(OLD_TOKEN, { skipCache: true }), 'v4-generic');

      activeAccount = BUYER;
      const sentBeforeOldBuy = sent.length;
      const oldBuy = await off.swap.buyToken(OLD_TOKEN, BUYER, '0.01', 1);
      assert.equal(sent.length - sentBeforeOldBuy, 1);
      assert.equal(sent[sent.length - 1].to, OLD_V4_ROUTER, 'old-path buy goes to IncentifiV4Router, untouched');
      assert.equal((await publicClient.getTransactionReceipt({ hash: oldBuy.txHash })).status, 'success');
      assert.ok((await publicClient.readContract({ address: OLD_TOKEN, abi: ERC20, functionName: 'balanceOf', args: [BUYER] })) > 0n);
      console.log(`  old-path token ${OLD_TOKEN}: buy via ${OLD_V4_ROUTER}  OK`);

      // the live GenericSell token keeps its venue under both flags
      assert.equal(await on.venue.resolveTokenVenue(TESTINGG, { skipCache: true }), 'v4-generic');
      assert.equal(await off.venue.resolveTokenVenue(TESTINGG, { skipCache: true }), 'v4-generic');
      const tState = await off.swap.getUnifiedMarketState(TESTINGG);
      assert.equal(tState.venue, 'v4-generic');
      console.log(`  TESTINGG resolves to v4-generic under both flags  OK`);

      // ================================================================================
      // Calldata parity with the mainnet smoke-test transaction (read-only from the live chain)
      // ================================================================================
      console.log('\n=== UniversalRouter calldata == mined mainnet transaction ===');
      const live = createPublicClient({ transport: viemHttp('https://rpc.mainnet.chain.robinhood.com') });
      const smokeTx = await live.getTransaction({ hash: SMOKE_BUY_TX });
      const smkKey = await live.readContract({ address: LEGIBLE_FACTORY, abi: FACTORY, functionName: 'getPoolKey', args: [getAddress('0x6497226fD6E3E70CD2D1B09229515360768F49A2')] });
      const encoded = on.legible.encodeUniversalRouterV4Swap(smkKey, true, parseEther('0.01'), 0n, 1788795447n);
      assert.equal(encoded.toLowerCase(), smokeTx.input.toLowerCase(), 'frontend encoding is byte-identical to the mined UniversalRouter input');
      assert.equal(getAddress(smokeTx.to!), UNIVERSAL_ROUTER);
      console.log(`  ${encoded.length / 2 - 1} bytes identical to tx ${SMOKE_BUY_TX.slice(0, 12)}…  OK`);
      void SMK;
    } finally {
      for (const s of servers) await s.close();
      rpcProxy.server.close();
      delete (globalThis as any).window;
    }
  });
});
