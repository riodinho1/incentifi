import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import fs from 'node:fs';
import http from 'node:http';
import { parseEther, parseAbi, getAddress, formatEther, formatUnits, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSupabaseRestMock } from './support/supabase-rest-mock.mjs';

/**
 * FIX 2 — V4 loss-reward end-to-end, on a mainnet fork, against the REAL production V4
 * contracts and the REAL TESTINGG pool (not a fresh deploy):
 *
 *   real hook 0xC5Ef9Cb8… / factory 0x4166418C… / router 0x762b4D9e… / LossRewardPool
 *   0x697BDA9d… — and TESTINGG's real pool, carrying the real fees its 8 mainnet trades
 *   already deposited.
 *
 * What is proven, in order:
 *   1. A genuinely underwater V4 holder is created by REAL price movement on the real hook
 *      (pump buys, holder buys higher, pump dumps) — through the real IncentifiV4Router.
 *   2. Those trades' real 1% loss-pool fees land in the REAL pool, exactly matching the
 *      hook's emitted `lossPoolFee`s (V4 fee-collection, the mechanism that funds rewards).
 *   3. holder_cost_basis is populated by the REAL indexer code path (Fix 1's
 *      indexV4TradesInRange) over BOTH the real mainnet history (W1/W2's 8 trades) and the
 *      fork trades — not seeded by hand as the V3 fork test had to.
 *   4. The REAL worker's getTokenBenchmarkPriceEth() resolves a V4 price via the shared
 *      fetchV4CurveState() (source v4_hook_curve), equal to an independent re-derivation
 *      from hook.curveStates on the fork — and demonstrably read from the FORK, not mainnet.
 *   5. The REAL, unmodified executeEpochForToken() computes a nonzero reward equal to
 *      0.10 × the holder's real unrealized loss, publishes a real Merkle root to the real
 *      pool (signed by a generated operator the impersonated pool OWNER installed on the
 *      fork — no production key is ever used), and the holder claims it: wallet balance
 *      increases by EXACTLY the claimed wei net of gas; a second claim reverts.
 *   6. Post-graduation: a real graduating buy flips the pool; the benchmark switches to
 *      StateView.getSlot0 (source v4_stateview_slot0), equal to an independent slot0 read
 *      and within rounding of the curve's final marginal price; the now-profitable holder
 *      correctly earns nothing.
 *
 * Supabase is the ONLY mock (in-memory PostgREST; every "/rest/v1/*" call intercepted by
 * path, so nothing can reach the real project). The indexer freshness gate is bypassed
 * (skipFreshnessCheck) — covered by its own test — since the indexer's polling loop isn't
 * running here, only its indexing functions.
 *
 * Run (isolated — node:test shares a process across files):
 *   npx hardhat test nodejs --network robinhoodFork -- test/hardhat/v4-loss-reward-fork.test.ts
 */

const V4_FACTORY = getAddress('0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0');
const V4_ROUTER = getAddress('0x762b4D9e514e4B19E54E99b62E7b731CE37FF1E6');
const V4_HOOK = getAddress('0xC5Ef9Cb8c95cd8540E71b6D4c00a90257625a888');
const LOSS_REWARD_POOL = getAddress('0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
const TESTINGG = getAddress('0x7F9b8A09877F6e8096b0b8c6027DC49580b05474');
const W1 = '0xba69ca72cd2b87113471c4c38f08928761edb5ce'; // real creator wallet (mainnet history)
const W2 = '0xd2df2a28cd90f7ac5beac82d00e9c03772b75096'; // real second buyer (mainnet history)
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

const VIRTUAL_ETH = 2_156_250_000_000_000_000n;
const VIRTUAL_TOKEN = 78_125_000_000_000_000_000_000_000n;
const GRADUATION_ETH_TARGET = 5_853_863_234_375_000_000n;
const curvePriceEth = (realEth: bigint, realToken: bigint) => Number(VIRTUAL_ETH + realEth) / Number(VIRTUAL_TOKEN + realToken);

const HOOK_EVENTS = parseAbi([
  'event Bought(bytes32 indexed poolId, address indexed trader, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event Sold(bytes32 indexed poolId, address indexed trader, uint256 tokensIn, uint256 ethOut, uint256 creatorFee, uint256 lossPoolFee)',
]);
const STATE_VIEW_ABI = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']);

const approx = (actual: number, expected: number, label: string, rel = 1e-9) => {
  const tol = Math.max(Math.abs(expected) * rel, 1e-18);
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected}, got ${actual} (rel tol ${rel})`);
};

function readEnvLocal(key: string): string | undefined {
  if (!fs.existsSync('.env.local')) return undefined;
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
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
            return { jsonrpc: '2.0', id: item.id, error: { code: err?.code ?? -32000, message: err?.shortMessage || err?.message || String(err) } };
          }
        };
        const responseBody = Array.isArray(payload) ? await Promise.all(payload.map(handleOne)) : await handleOne(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` };
}

describe('Fix 2: V4 loss-reward lifecycle on the real TESTINGG pool (mainnet fork, real contracts, real worker + indexer code)', () => {
  it('underwater V4 holder -> real benchmark via fetchV4CurveState -> nonzero reward -> real Merkle claim with exact delta -> post-graduation StateView benchmark', async () => {
    const { viem, networkHelpers, provider } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [, pump, holder] = await viem.getWalletClients();
    for (const w of [pump, holder]) await networkHelpers.setBalance(w.account.address, parseEther('100'));
    // EDR refuses to execute at exactly the fork block on this chain — mine one local block first.
    await networkHelpers.mine(1);
    const forkBlock = await publicClient.getBlockNumber();
    console.log('--- Fork setup ---');
    console.log('Forked at block:', forkBlock.toString());

    for (const [name, addr] of [
      ['IncentifiV4Factory (production)', V4_FACTORY],
      ['IncentifiV4Router (production)', V4_ROUTER],
      ['IncentifiV4HookGenericSell (production)', V4_HOOK],
      ['LossRewardPool (production)', LOSS_REWARD_POOL],
      ['StateView', STATE_VIEW],
      ['TESTINGG', TESTINGG],
    ] as const) {
      const code = await publicClient.getCode({ address: addr });
      assert.ok(code && code !== '0x', `${name} must have code on the fork`);
    }

    const factory = await viem.getContractAt('IncentifiV4Factory', V4_FACTORY);
    const router = await viem.getContractAt('IncentifiV4Router', V4_ROUTER);
    const hook = await viem.getContractAt('IncentifiV4HookGenericSell', V4_HOOK);
    const pool = await viem.getContractAt('LossRewardPool', LOSS_REWARD_POOL);
    const token = await viem.getContractAt('IncentifiLaunchToken', TESTINGG);

    assert.equal(await factory.read.isLaunched([TESTINGG]), true, 'TESTINGG must be a real V4 launch on the production factory');
    const rawKey = await factory.read.getPoolKey([TESTINGG]);
    const poolId = keccak256(encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [
      getAddress(rawKey.currency0), getAddress(rawKey.currency1), Number(rawKey.fee), Number(rawKey.tickSpacing), getAddress(rawKey.hooks),
    ]));
    assert.equal(getAddress(rawKey.hooks), V4_HOOK, 'the real pool must be bound to the production GenericSell hook');
    const curve0 = await hook.read.curveStates([poolId]);
    assert.equal(curve0[2], true, 'pool initialized');
    assert.equal(curve0[3], false, 'pool must be PRE-graduation at the start');
    const mainnetPriceEth = curvePriceEth(curve0[4], curve0[5]);
    console.log('Real poolId:', poolId);
    console.log('Real state at fork: realEthReserve =', formatEther(curve0[4]), 'ETH | price =', mainnetPriceEth.toExponential(6), 'ETH/token');

    const rpcProxy = await startRpcProxy(provider);
    console.log('Local RPC proxy (same fork state):', rpcProxy.url);
    let workerModule: any = null;
    try {
      // ------------------------------------------------------------------------
      // Operator for the REAL pool on the fork: impersonate its real OWNER and install a
      // freshly generated operator key — the worker signs with that. No production key.
      // ------------------------------------------------------------------------
      const owner = getAddress(await pool.read.owner());
      await networkHelpers.impersonateAccount(owner);
      await networkHelpers.setBalance(owner, parseEther('10'));
      const ownerClient = await viem.getWalletClient(owner);
      const operatorPrivateKey = generatePrivateKey();
      const operatorAccount = privateKeyToAccount(operatorPrivateKey);
      await networkHelpers.setBalance(operatorAccount.address, parseEther('10'));
      await publicClient.waitForTransactionReceipt({ hash: await pool.write.setOperator([operatorAccount.address], { account: ownerClient.account }) });
      assert.equal(getAddress(await pool.read.operator()), getAddress(operatorAccount.address));
      console.log('Real pool owner', owner, '(impersonated) installed test operator', operatorAccount.address);

      // ------------------------------------------------------------------------
      // 1 + 2. Real underwater position via real price movement; real fees into the real pool.
      // ------------------------------------------------------------------------
      console.log('\n=== 1+2: real pump / holder buy / dump on the real hook; real fee collection ===');
      const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
      const unallocatedBefore = await pool.read.getUnallocatedBalance([TESTINGG]);
      const tradesFrom = (await publicClient.getBlockNumber()) + 1n;

      await publicClient.waitForTransactionReceipt({ hash: await router.write.buyToken([TESTINGG, 0n, deadline()], { account: pump.account, value: parseEther('1') }) });
      const HOLDER_BUY_ETH = parseEther('0.2');
      await publicClient.waitForTransactionReceipt({ hash: await router.write.buyToken([TESTINGG, 0n, deadline()], { account: holder.account, value: HOLDER_BUY_ETH }) });
      const pumpBal = await token.read.balanceOf([pump.account.address]);
      await publicClient.waitForTransactionReceipt({ hash: await token.write.approve([V4_ROUTER, pumpBal], { account: pump.account }) });
      await publicClient.waitForTransactionReceipt({ hash: await router.write.sellToken([TESTINGG, pumpBal, 0n, deadline()], { account: pump.account }) });
      const tradesTo = await publicClient.getBlockNumber();

      const holderBalance = await token.read.balanceOf([holder.account.address]);
      const holderCostBasisEth = Number(HOLDER_BUY_ETH) / 1e18 / (Number(holderBalance) / 1e18);
      const curve1 = await hook.read.curveStates([poolId]);
      const priceAfterDump = curvePriceEth(curve1[4], curve1[5]);
      console.log('holder balance:', formatUnits(holderBalance, 18), '| cost basis:', holderCostBasisEth.toExponential(6), '| price after dump:', priceAfterDump.toExponential(6));
      assert.ok(priceAfterDump < holderCostBasisEth, 'holder must be GENUINELY underwater by real on-chain V4 curve movement');
      console.log(`CONFIRMED: holder is ${((1 - priceAfterDump / holderCostBasisEth) * 100).toFixed(1)}% underwater.`);

      const forkLogs = await publicClient.getLogs({ address: V4_HOOK, events: HOOK_EVENTS, fromBlock: tradesFrom, toBlock: tradesTo });
      const forkTradeLogs = forkLogs.filter((l) => (l.args as any).poolId.toLowerCase() === poolId.toLowerCase());
      assert.equal(forkTradeLogs.length, 3, 'exactly 3 hook trade events for TESTINGG on the fork (buy, buy, sell)');
      const emittedFees = forkTradeLogs.reduce((s, l) => s + ((l.args as any).lossPoolFee as bigint), 0n);
      const unallocatedAfter = await pool.read.getUnallocatedBalance([TESTINGG]);
      console.log('Real pool unallocated(TESTINGG): before', formatEther(unallocatedBefore), '-> after', formatEther(unallocatedAfter), '| sum of emitted lossPoolFee:', formatEther(emittedFees));
      assert.equal(unallocatedAfter - unallocatedBefore, emittedFees, "the real pool's unallocated balance must grow by exactly the hook's emitted loss-pool fees");
      console.log('PASS: V4 fee collection — real fees, real pool, exact match.');

      // ------------------------------------------------------------------------
      // Wire the mock + env BEFORE importing either module (both capture fetch/env at import).
      // ------------------------------------------------------------------------
      const supabaseUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL') || 'https://v4-loss-reward-fork-test.supabase.co';
      const supaMock = createSupabaseRestMock(supabaseUrl, globalThis.fetch, {
        upsertKeys: {
          holder_cost_basis: ['token_address', 'wallet_address'],
          token_trades_evm: ['tx_hash'],
          token_candles_1m: ['symbol', 'bucket_ts'],
          token_market_snapshots_evm: ['token_address'],
          indexer_heartbeats: ['worker_name'],
        },
      });
      globalThis.fetch = supaMock.fetchImpl as unknown as typeof fetch;
      process.env.VITE_SUPABASE_URL ||= supabaseUrl;
      process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy-service-role-key-fork-test';
      process.env.VITE_EVM_RPC_URL = rpcProxy.url; // worker, indexer AND the Vite-loaded bondingCurveV4.ts all read this
      process.env.OPERATOR_PRIVATE_KEY = operatorPrivateKey;

      // ------------------------------------------------------------------------
      // 3. holder_cost_basis from the REAL indexer code (Fix 1), real history + fork trades.
      // ------------------------------------------------------------------------
      console.log('\n=== 3: holder_cost_basis via the real indexer (mainnet history + fork trades) ===');
      const indexer: any = await import('../../scripts/evm-indexer.mjs');
      await indexer.discoverV4TokensInRange(56_230_000n, 56_235_000n); // real TokenLaunched at 56,230,887 (pre-fork, forwarded)
      const n1 = await indexer.indexV4TradesInRange(56_230_000n, 56_235_000n);
      const n2 = await indexer.indexV4TradesInRange(56_235_001n, 56_240_000n);
      const n3 = await indexer.indexV4TradesInRange(tradesFrom, tradesTo);
      console.log(`indexed: ${n1} + ${n2} real mainnet trades, ${n3} fork trades`);
      assert.equal(n1 + n2, 8, 'the 8 real mainnet TESTINGG trades');
      assert.equal(n3, 3, 'the 3 fork trades');
      // Copied by value: the mock's rows are live objects the worker later mutates in place
      // (cost-basis depletion), and the expectations below must be computed from the
      // PRE-epoch state.
      const holderRow = { ...supaMock.table('holder_cost_basis').find((r: any) => r.wallet_address === holder.account.address.toLowerCase()) };
      assert.ok(holderRow.wallet_address, 'indexer must have produced the holder row');
      approx(holderRow.token_balance, Number(holderBalance) / 1e18, 'indexer holder balance == on-chain balance', 1e-9);
      approx(holderRow.avg_cost_basis_eth, holderCostBasisEth, 'indexer cost basis == gross ETH / tokens', 1e-9);
      assert.equal(holderRow.is_eligible, true);
      const pumpRow = supaMock.table('holder_cost_basis').find((r: any) => r.wallet_address === pump.account.address.toLowerCase());
      approx(pumpRow.token_balance, 0, 'pump sold everything', 1e-9);
      assert.ok(supaMock.table('holder_cost_basis').find((r: any) => r.wallet_address === W1), 'real W1 row from mainnet history');
      assert.ok(supaMock.table('holder_cost_basis').find((r: any) => r.wallet_address === W2), 'real W2 row from mainnet history');
      console.log(`PASS: ${supaMock.table('holder_cost_basis').length} holder rows (W1, W2, pump, holder) written by the real indexer code.`);

      // ------------------------------------------------------------------------
      // 4. The real worker's V4 benchmark price — via the shared fetchV4CurveState().
      // ------------------------------------------------------------------------
      console.log('\n=== 4: getTokenBenchmarkPriceEth() for a V4 token ===');
      const worker: any = await import('../../scripts/loss-reward-worker.mjs');
      workerModule = worker;
      const bench = await worker.getTokenBenchmarkPriceEth(TESTINGG);
      console.log('benchmark:', JSON.stringify(bench));
      assert.equal(bench.source, 'v4_hook_curve', 'pre-graduation V4 price must come from hook.curveStates via fetchV4CurveState');
      assert.equal(bench.isGraduated, false);
      approx(bench.priceEth, priceAfterDump, 'worker benchmark == independent curveStates re-derivation on the fork', 1e-9);
      assert.ok(Math.abs(bench.priceEth - mainnetPriceEth) / mainnetPriceEth > 0.01, 'benchmark must reflect FORK state (post-dump), not the unchanged mainnet state — proves the Vite-loaded module hit the proxy');
      console.log('PASS: V4 benchmark resolved from the fork via fetchV4CurveState (was invalid_price before Fix 2).');

      // ------------------------------------------------------------------------
      // 5. Real epoch -> nonzero reward -> real root on the real pool -> real claim, exact delta.
      // ------------------------------------------------------------------------
      console.log('\n=== 5: real executeEpochForToken() + real Merkle claim ===');
      const unallocatedBeforeEpoch = await pool.read.getUnallocatedBalance([TESTINGG]);
      const epoch = await worker.executeEpochForToken(TESTINGG, { skipFreshnessCheck: true });
      console.log('Epoch result:', JSON.stringify({ ...epoch, payouts: epoch.payouts?.length }, null, 2));
      assert.equal(epoch.skipped, undefined, `epoch must not be skipped (reason=${epoch.reason})`);
      assert.equal(epoch.eligibleHolders, 1, 'exactly the one underwater holder is eligible (W1 balance 0, W2 balance 0 + disqualified, pump balance 0)');
      const expectedLossEth = holderRow.total_invested_eth - holderRow.token_balance * bench.priceEth;
      const expectedRewardEth = 0.10 * expectedLossEth;
      console.log('holder unrealized loss:', expectedLossEth.toExponential(6), 'ETH | expected reward (10%):', expectedRewardEth.toExponential(6), 'ETH | worker:', epoch.totalDistributedEth);
      assert.ok(epoch.totalDistributedEth > 0, 'a NONZERO reward must be computed');
      approx(epoch.totalDistributedEth, expectedRewardEth, 'reward == 0.10 x real unrealized loss', 1e-6);
      assert.ok(BigInt(Math.round(epoch.totalDistributedEth * 1e18)) <= unallocatedBeforeEpoch, 'reward funded by the REAL collected fees (no synthetic deposit)');
      assert.notEqual(epoch.merkleRoot, ZERO32);
      const rootOnChain = await pool.read.epochMerkleRoots([TESTINGG, BigInt(epoch.epochNumber)]);
      assert.equal(rootOnChain, epoch.merkleRoot, 'root published on the REAL pool (fork) must match');
      const epochRow = supaMock.table('reward_epochs').find((r: any) => r.epoch_number === epoch.epochNumber);
      assert.equal(epochRow.status, 'published');
      console.log(`Epoch #${epoch.epochNumber} published on-chain, root ${rootOnChain}`);

      const payout = epoch.payouts[0];
      const rewardRow = supaMock.table('epoch_holder_rewards').find((r: any) => r.wallet_address === holder.account.address.toLowerCase());
      assert.ok(rewardRow?.merkle_proof, 'a real Merkle proof must be persisted for the holder');
      const ethBefore = await publicClient.getBalance({ address: holder.account.address });
      const claimHash = await pool.write.claimReward([TESTINGG, BigInt(epoch.epochNumber), payout.finalRewardWei, rewardRow.merkle_proof], { account: holder.account });
      const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimHash });
      const gas = claimReceipt.gasUsed * claimReceipt.effectiveGasPrice;
      const ethAfter = await publicClient.getBalance({ address: holder.account.address });
      console.log('claim tx:', claimHash, '| claimed wei:', payout.finalRewardWei.toString(), '| wallet delta net of gas:', (ethAfter - ethBefore + gas).toString());
      assert.equal(ethAfter - ethBefore + gas, payout.finalRewardWei, 'wallet must increase by EXACTLY the claimed amount, net of the claim gas');
      await assert.rejects(
        pool.write.claimReward([TESTINGG, BigInt(epoch.epochNumber), payout.finalRewardWei, rewardRow.merkle_proof], { account: holder.account }),
        /AlreadyClaimed/,
        'double claim must revert'
      );
      const depleted = supaMock.table('holder_cost_basis').find((r: any) => r.wallet_address === holder.account.address.toLowerCase());
      console.log('holder total_invested_eth: before epoch', holderRow.total_invested_eth, '-> after', depleted.total_invested_eth);
      approx(depleted.total_invested_eth, holderRow.total_invested_eth - epoch.totalDistributedEth, 'recovery cap: cost basis depleted by EXACTLY the paid reward', 1e-9);
      console.log('PASS: real reward claimed with exact delta; double-claim rejected; cost basis depleted by exactly the payout.');

      // ------------------------------------------------------------------------
      // 6. Post-graduation: StateView.getSlot0 branch of the SAME shared logic.
      // ------------------------------------------------------------------------
      console.log('\n=== 6: graduate the real pool; benchmark switches to StateView.getSlot0 ===');
      const curve2 = await hook.read.curveStates([poolId]);
      const ethToGraduate = GRADUATION_ETH_TARGET - curve2[4] + parseEther('0.5');
      await networkHelpers.setBalance(pump.account.address, ethToGraduate + parseEther('10'));
      await publicClient.waitForTransactionReceipt({ hash: await router.write.buyToken([TESTINGG, 0n, deadline()], { account: pump.account, value: ethToGraduate }) });
      const curve3 = await hook.read.curveStates([poolId]);
      assert.equal(curve3[3], true, 'pool must now be graduated');
      const frozenCurvePrice = curvePriceEth(curve3[4], curve3[5]);
      const slot0 = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
      const sqrtP = Number(slot0[0]) / 2 ** 96;
      const independentStateViewPrice = 1 / (sqrtP * sqrtP);
      const bench2 = await worker.getTokenBenchmarkPriceEth(TESTINGG);
      console.log('post-grad benchmark:', JSON.stringify(bench2), '| independent StateView price:', independentStateViewPrice.toExponential(6), '| frozen curve price:', frozenCurvePrice.toExponential(6));
      assert.equal(bench2.source, 'v4_stateview_slot0');
      assert.equal(bench2.isGraduated, true);
      approx(bench2.priceEth, independentStateViewPrice, 'worker post-grad benchmark == independent StateView.getSlot0 read', 1e-9);
      approx(bench2.priceEth, frozenCurvePrice, "graduation's corrective swap lands the pool at the curve's final marginal price", 1e-3);
      const epoch2 = await worker.executeEpochForToken(TESTINGG, { skipFreshnessCheck: true });
      console.log('post-grad epoch:', JSON.stringify({ ...epoch2, payouts: epoch2.payouts?.length }));
      assert.ok(bench2.priceEth > holderCostBasisEth, 'after a graduating buy the holder is in profit');
      assert.equal(epoch2.eligibleHolders ?? 0, 0, 'a profitable holder must earn nothing post-graduation');
      console.log('PASS: post-graduation V4 benchmark via StateView; no reward for a non-underwater holder.');

      console.log('\n=== RESULT: Fix 2 verified end-to-end on the real TESTINGG pool — V4 rewards compute, publish, and are claimable ===');
    } finally {
      if (workerModule?.closeV4Module) await workerModule.closeV4Module().catch(() => {});
      rpcProxy.server.close();
      rpcProxy.server.closeAllConnections?.();
    }
  });
});
