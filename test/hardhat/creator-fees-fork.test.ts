import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import http from 'node:http';
import { parseEther, getAddress, formatEther, parseAbi } from 'viem';
import { createServer as createViteServer } from 'vite';

/**
 * CREATOR FEE CLAIMS — fork test for src/lib/creatorFees.ts (V3 curve + V4 hook).
 *
 * Both contracts are pull-payments bound to msg.sender (curve.claimCreatorFees(),
 * hook.claimCreatorFees()), so the claim must be signed by the creator's own wallet — the same
 * wallet-signed pattern PR #13 established for loss-reward claims. This test drives the REAL
 * frontend module (loaded through Vite SSR, wired to a local proxy over the fork) through a
 * minimal EIP-1193 wallet and checks exact wei deltas net of gas.
 *
 *   V3: a fresh IncentifiBondingCurveFactory + IncentifiSwapRouter (same source as production)
 *       deployed on the fork; a real router buy accrues a real 1% creator fee into
 *       curve.creatorBalances[creator]; the creator claims it via the real function.
 *   V4: the REAL production hook and the REAL TESTINGG pool; a real IncentifiV4Router buy accrues
 *       a real 1% fee to TESTINGG's real creator 0xba69…5cE on the hook; the impersonated creator
 *       claims its whole hook balance via the real function.
 *   Guards: zero balance -> refused before any tx; wrong active account -> refused before any tx;
 *       non-creator wallet -> isCreator=false, balance 0.
 *
 * Run (isolated): npx hardhat test nodejs --network robinhoodFork -- test/hardhat/creator-fees-fork.test.ts
 */

const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
const UNISWAP_V3_FACTORY = getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
const UNISWAP_POSITION_MANAGER = getAddress('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3');
const SWAP_ROUTER02 = getAddress('0xcaf681a66D020601342297493863e78C959e5Cb2');
const LOSS_REWARD_POOL = getAddress('0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF');
const V4_HOOK = getAddress('0xC5Ef9Cb8c95cd8540E71b6D4c00a90257625a888');
const V4_ROUTER = getAddress('0x762b4D9e514e4B19E54E99b62E7b731CE37FF1E6');
const TESTINGG = getAddress('0x7F9b8A09877F6e8096b0b8c6027DC49580b05474');
const TESTINGG_CREATOR = getAddress('0xba69Ca72CD2B87113471c4C38f08928761Edb5cE');

const CURVE_EVENTS = parseAbi([
  'event TokensPurchased(address indexed buyer, address indexed recipient, uint256 ethInGross, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
]);
const HOOK_EVENTS = parseAbi([
  'event Bought(bytes32 indexed poolId, address indexed trader, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
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

describe('Creator fee claims (V3 curve + real V4 hook on a mainnet fork, real frontend module, exact balance deltas)', () => {
  it('reads accrued fees and claims them from the creator wallet on both venues; guards refuse before any tx', async () => {
    const { viem, networkHelpers, provider } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [, creatorWallet, buyerWallet, strangerWallet] = await viem.getWalletClients();
    const CREATOR = getAddress(creatorWallet.account.address);
    const BUYER = getAddress(buyerWallet.account.address);
    const STRANGER = getAddress(strangerWallet.account.address);
    for (const a of [CREATOR, BUYER, STRANGER]) await networkHelpers.setBalance(a, parseEther('10'));
    await networkHelpers.mine(1);
    console.log('--- Fork setup ---');
    console.log('Forked at block:', await publicClient.getBlockNumber());

    // ---- V3: fresh factory/router (production source) wired to the real LossRewardPool ----
    const factory = await viem.deployContract('IncentifiBondingCurveFactory', [LOSS_REWARD_POOL, WETH, UNISWAP_POSITION_MANAGER, UNISWAP_V3_FACTORY]);
    const router = await viem.deployContract('IncentifiSwapRouter', [SWAP_ROUTER02, WETH, LOSS_REWARD_POOL, factory.address]);
    const totalSupply = 1_000_000_000n * 10n ** 18n;
    const token = await viem.deployContract('IncentifiLaunchToken', ['Creator Fee Fork Test', 'CFFT', totalSupply], { client: { wallet: creatorWallet } });
    await publicClient.waitForTransactionReceipt({ hash: await token.write.approve([factory.address, totalSupply], { account: creatorWallet.account }) });
    await publicClient.waitForTransactionReceipt({ hash: await factory.write.registerExistingToken([token.address, CREATOR], { account: creatorWallet.account }) });
    const curveAddr = getAddress(await factory.read.getBondingCurve([token.address]));
    const curve = await viem.getContractAt('IncentifiBondingCurve', curveAddr);
    assert.equal(getAddress(await curve.read.creator()), CREATOR);
    console.log('Fresh V3 factory:', factory.address, '| token:', token.address, '| curve:', curveAddr);

    const rpcProxy = await startRpcProxy(provider);
    let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
    try {
      // Frontend env: RPC -> fork proxy; V3 factory -> the fresh one (V4 hook/factory stay real).
      process.env.VITE_EVM_RPC_URL = rpcProxy.url;
      process.env.VITE_INCENTIFI_BONDING_CURVE_FACTORY = factory.address;
      vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
      const evmNetwork = await vite.ssrLoadModule('/src/lib/evmNetwork.ts');
      assert.equal(evmNetwork.EVM_RPC_URL, rpcProxy.url, 'frontend must be wired to the fork');
      const addresses = await vite.ssrLoadModule('/src/lib/uniswapAddresses.ts');
      assert.equal(getAddress(addresses.INCENTIFI_BONDING_CURVE_FACTORY), getAddress(factory.address), 'frontend must see the fresh V3 factory');
      assert.equal(getAddress(addresses.INCENTIFI_V4_HOOK), V4_HOOK, 'frontend must see the REAL V4 hook');
      const creatorFees = await vite.ssrLoadModule('/src/lib/creatorFees.ts');
      console.log('Real src/lib/creatorFees.ts loaded via Vite SSR');

      let activeAccount: `0x${string}` = CREATOR;
      const sent: string[] = [];
      (globalThis as any).window = {
        ethereum: {
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [activeAccount];
            if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
            const result = await provider.request({ method, params });
            if (method === 'eth_sendTransaction') sent.push(result as string);
            return result;
          },
        },
      };

      const claimVia = async (tokenAddr: `0x${string}`, wallet: `0x${string}`) => {
        const before = await publicClient.getBalance({ address: wallet });
        const sentBefore = sent.length;
        const res = await creatorFees.claimCreatorFees(tokenAddr, wallet);
        const after = await publicClient.getBalance({ address: wallet });
        const receipt = await publicClient.getTransactionReceipt({ hash: res.txHash });
        const tx = await publicClient.getTransaction({ hash: res.txHash });
        const fee = receipt.gasUsed * receipt.effectiveGasPrice;
        return { res, receipt, tx, netDelta: after - before + fee, txsSent: sent.length - sentBefore };
      };

      // ================================================================================
      // V3
      // ================================================================================
      console.log('\n=== V3: real router buy accrues a real 1% creator fee; creator claims it ===');
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const buyReceipt = await publicClient.waitForTransactionReceipt({
        hash: await router.write.buyToken([token.address, 0n, deadline], { account: buyerWallet.account, value: parseEther('0.5') }),
      });
      const purchase = (await publicClient.getLogs({ address: curveAddr, event: CURVE_EVENTS[0], fromBlock: buyReceipt.blockNumber, toBlock: buyReceipt.blockNumber }))[0];
      const v3Fee = purchase.args.creatorFee!;
      assert.ok(v3Fee > 0n);
      assert.equal(await curve.read.creatorBalances([CREATOR]), v3Fee, 'curve must credit exactly the emitted creatorFee');
      console.log(`  buy 0.5 ETH -> emitted creatorFee ${formatEther(v3Fee)} ETH; curve.creatorBalances[creator] == emitted  OK`);

      // status read through the real module
      const v3Status = await creatorFees.fetchCreatorFeeStatus(token.address, CREATOR);
      assert.equal(v3Status.source.kind, 'v3');
      assert.equal(getAddress(v3Status.source.contract), curveAddr, 'V3 source must be this token\'s curve');
      assert.equal(v3Status.isCreator, true);
      assert.equal(v3Status.balanceWei, v3Fee, 'status balance must equal the real on-chain creatorBalances');
      console.log(`  fetchCreatorFeeStatus: kind=${v3Status.source.kind} isCreator=${v3Status.isCreator} balance=${formatEther(v3Status.balanceWei)} ETH  OK`);

      // non-creator sees isCreator=false and 0
      const strangerStatus = await creatorFees.fetchCreatorFeeStatus(token.address, STRANGER);
      assert.equal(strangerStatus.isCreator, false);
      assert.equal(strangerStatus.balanceWei, 0n);

      // wrong active account -> refused, 0 txs
      activeAccount = STRANGER;
      const sentBeforeGuard = sent.length;
      await assert.rejects(creatorFees.claimCreatorFees(token.address, CREATOR), /not the wallet these creator fees belong to/);
      assert.equal(sent.length - sentBeforeGuard, 0);
      activeAccount = CREATOR;
      console.log('  wrong active account: refused, 0 transactions  OK');

      // the real claim
      const v3 = await claimVia(token.address, CREATOR);
      assert.equal(v3.receipt.status, 'success');
      assert.equal(getAddress(v3.tx.from), CREATOR, 'claim must be sent by the creator wallet');
      assert.equal(getAddress(v3.tx.to), curveAddr, 'V3 claim goes to the token\'s curve');
      assert.equal(v3.netDelta, v3Fee, 'creator balance must rise by EXACTLY the accrued fee, net of gas');
      assert.equal(v3.res.claimedEth, formatEther(v3Fee));
      assert.equal(await curve.read.creatorBalances([CREATOR]), 0n, 'balance must be zero after the claim');
      console.log(`  tx ${v3.res.txHash} from=${v3.tx.from} gasUsed=${v3.receipt.gasUsed} | net delta ${formatEther(v3.netDelta)} == ${formatEther(v3Fee)} ETH  PASS`);

      // zero balance -> refused before any tx
      const sentBeforeZero = sent.length;
      await assert.rejects(creatorFees.claimCreatorFees(token.address, CREATOR), /No accrued creator fees/);
      assert.equal(sent.length - sentBeforeZero, 0);
      console.log('  second claim with zero balance: refused, 0 transactions  PASS');

      // ================================================================================
      // V4 — REAL hook, REAL TESTINGG pool, REAL creator
      // ================================================================================
      console.log('\n=== V4: real IncentifiV4Router buy on TESTINGG accrues to the real creator on the real hook ===');
      const hook = await viem.getContractAt('IncentifiV4HookGenericSell', V4_HOOK);
      const v4Router = await viem.getContractAt('IncentifiV4Router', V4_ROUTER);
      const hookBalBefore = await hook.read.creatorBalances([TESTINGG_CREATOR]);
      console.log(`  real creator ${TESTINGG_CREATOR} hook balance before: ${formatEther(hookBalBefore)} ETH`);
      const v4BuyReceipt = await publicClient.waitForTransactionReceipt({
        hash: await v4Router.write.buyToken([TESTINGG, 0n, deadline], { account: buyerWallet.account, value: parseEther('0.02') }),
      });
      const bought = (await publicClient.getLogs({ address: V4_HOOK, event: HOOK_EVENTS[0], fromBlock: v4BuyReceipt.blockNumber, toBlock: v4BuyReceipt.blockNumber }))[0];
      const v4Fee = bought.args.creatorFee!;
      const hookBalAfterBuy = await hook.read.creatorBalances([TESTINGG_CREATOR]);
      assert.equal(hookBalAfterBuy - hookBalBefore, v4Fee, 'hook must credit exactly the emitted Bought.creatorFee to the real creator');
      console.log(`  buy 0.02 ETH -> emitted creatorFee ${formatEther(v4Fee)} ETH; hook balance now ${formatEther(hookBalAfterBuy)} ETH  OK`);

      const v4Status = await creatorFees.fetchCreatorFeeStatus(TESTINGG, TESTINGG_CREATOR);
      assert.equal(v4Status.source.kind, 'v4');
      assert.equal(getAddress(v4Status.source.contract), V4_HOOK);
      assert.equal(getAddress(v4Status.creator), TESTINGG_CREATOR, 'module must identify the real creator from hook.curveStates');
      assert.equal(v4Status.isCreator, true);
      assert.equal(v4Status.balanceWei, hookBalAfterBuy, 'status must report the FULL hook balance (all of the creator\'s V4 tokens)');
      console.log(`  fetchCreatorFeeStatus: kind=${v4Status.source.kind} creator=${v4Status.creator} balance=${formatEther(v4Status.balanceWei)} ETH  OK`);

      await networkHelpers.impersonateAccount(TESTINGG_CREATOR);
      await networkHelpers.setBalance(TESTINGG_CREATOR, parseEther('1')); // gas only
      activeAccount = TESTINGG_CREATOR;
      const v4 = await claimVia(TESTINGG, TESTINGG_CREATOR);
      assert.equal(v4.receipt.status, 'success');
      assert.equal(getAddress(v4.tx.from), TESTINGG_CREATOR, 'the real creator must be msg.sender');
      assert.equal(getAddress(v4.tx.to), V4_HOOK, 'V4 claim goes to the shared hook');
      assert.equal(v4.netDelta, hookBalAfterBuy, 'creator balance must rise by EXACTLY the whole hook balance, net of gas');
      assert.equal(await hook.read.creatorBalances([TESTINGG_CREATOR]), 0n);
      console.log(`  tx ${v4.res.txHash} from=${v4.tx.from} gasUsed=${v4.receipt.gasUsed} | net delta ${formatEther(v4.netDelta)} == ${formatEther(hookBalAfterBuy)} ETH  PASS`);

      console.log('\n=== RESULT: creator fees read and claimed by the creator wallet on V3 and the real V4 hook, exact deltas ===');
    } finally {
      if (vite) await vite.close();
      rpcProxy.server.close();
      rpcProxy.server.closeAllConnections?.();
      delete (globalThis as any).window;
      delete process.env.VITE_INCENTIFI_BONDING_CURVE_FACTORY;
    }
  });
});
