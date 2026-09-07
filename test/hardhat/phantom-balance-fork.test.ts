import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { parseEther, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import http from 'node:http';
import { createSupabaseRestMock } from './support/supabase-rest-mock.mjs';

/**
 * PHANTOM-BALANCE FORK TEST — the 2026-09-07 incident, reproduced and closed.
 *
 * What happened in production: a holder sold their ENTIRE position on-chain, the indexer missed
 * the sell (V4 discovery had silently died), holder_cost_basis kept saying 18.7M tokens, and the
 * REAL worker published 15 epochs of rewards against a position that no longer existed.
 *
 * What this test does, all on a mainnet fork with real contracts (production source), real
 * trades, the REAL unmodified executeEpochForToken(), and Supabase mocked in-memory:
 *   1. two holders (A, B) buy into a pump; the pump dumps; both are genuinely underwater;
 *   2. their holder_cost_basis rows are seeded from the REAL post-buy on-chain numbers (as the
 *      indexer would have written them);
 *   3. THEN, without touching the DB: A sells 100% on-chain, B sells exactly 50% — the stale-DB
 *      situation the incident was made of;
 *   4. the real worker runs an epoch. Required: A gets NOTHING; B is paid on exactly half of the
 *      recorded position (balance AND invested halved → basis preserved), strictly less than what
 *      the uncapped formula would have paid; the epoch publishes on-chain only B's amount; B's
 *      real claim lands exactly that amount net of gas.
 *
 * Run (isolated): npx hardhat test nodejs --network robinhoodFork -- test/hardhat/phantom-balance-fork.test.ts
 */

const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
const UNISWAP_V3_FACTORY = getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
const UNISWAP_POSITION_MANAGER = getAddress('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3');
const SWAP_ROUTER02 = getAddress('0xcaf681a66D020601342297493863e78C959e5Cb2');
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

async function startRpcProxy(provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const handleOne = async (item: any) => {
          try { return { jsonrpc: '2.0', id: item.id, result: await provider.request({ method: item.method, params: item.params }) }; }
          catch (err: any) { return { jsonrpc: '2.0', id: item.id, error: { code: err?.code ?? -32000, message: err?.shortMessage || err?.message || String(err) } }; }
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

describe('Phantom-balance guard (real worker, real contracts on a mainnet fork, stale DB vs on-chain truth)', () => {
  it('pays nothing to a fully-sold holder, pays a half-sold holder on exactly half, and publishes/claims exactly that', async () => {
    const { viem, networkHelpers, provider } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [, creator, holderA, holderB, pumpDump] = await viem.getWalletClients();
    for (const w of [creator, holderA, holderB, pumpDump]) await networkHelpers.setBalance(w.account.address, parseEther('1000'));
    await networkHelpers.mine(1);
    console.log('--- Fork setup ---');
    console.log('Forked at block:', await publicClient.getBlockNumber());

    const rpcProxy = await startRpcProxy(provider);
    try {
      const operatorPrivateKey = generatePrivateKey();
      const operatorAccount = privateKeyToAccount(operatorPrivateKey);
      await networkHelpers.setBalance(operatorAccount.address, parseEther('1000'));

      // Fresh, throwaway pool/factory/router/token — production source, never the real pool.
      const pool = await viem.deployContract('LossRewardPool', [operatorAccount.address]);
      const factory = await viem.deployContract('IncentifiBondingCurveFactory', [pool.address, WETH, UNISWAP_POSITION_MANAGER, UNISWAP_V3_FACTORY]);
      const router = await viem.deployContract('IncentifiSwapRouter', [SWAP_ROUTER02, WETH, pool.address, factory.address]);
      const totalSupply = 1_000_000_000n * 10n ** 18n;
      const token = await viem.deployContract('IncentifiLaunchToken', ['Phantom Balance Test', 'PHNT', totalSupply], { client: { wallet: creator } });
      await publicClient.waitForTransactionReceipt({ hash: await token.write.approve([factory.address, totalSupply], { account: creator.account }) });
      await publicClient.waitForTransactionReceipt({ hash: await factory.write.registerExistingToken([token.address, creator.account.address], { account: creator.account }) });
      const curve = await viem.getContractAt('IncentifiBondingCurve', getAddress(await factory.read.getBondingCurve([token.address])));
      const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
      console.log('Token:', token.address, '| Curve:', curve.address, '| Pool (fresh):', pool.address);

      // 1. pump, two real buys, dump → A and B genuinely underwater
      await publicClient.waitForTransactionReceipt({ hash: await router.write.buyToken([token.address, 0n, deadline()], { account: pumpDump.account, value: parseEther('3') }) });
      await publicClient.waitForTransactionReceipt({ hash: await router.write.buyToken([token.address, 0n, deadline()], { account: holderA.account, value: parseEther('1') }) });
      await publicClient.waitForTransactionReceipt({ hash: await router.write.buyToken([token.address, 0n, deadline()], { account: holderB.account, value: parseEther('1') }) });
      const pumpBal = await token.read.balanceOf([pumpDump.account.address]);
      await publicClient.waitForTransactionReceipt({ hash: await token.write.approve([router.address, pumpBal], { account: pumpDump.account }) });
      await publicClient.waitForTransactionReceipt({ hash: await router.write.sellToken([token.address, pumpBal, 0n, deadline()], { account: pumpDump.account }) });

      // 2. DB rows exactly as the indexer would have written them after the buys
      const balA = await token.read.balanceOf([holderA.account.address]);
      const balB = await token.read.balanceOf([holderB.account.address]);
      const dbBalanceA = Number(balA) / 1e18, dbBalanceB = Number(balB) / 1e18;
      const investedA = 1, investedB = 1;
      const priceAfterDump = Number(await curve.read.getCurrentPrice()) / 1e18;
      assert.ok(priceAfterDump < investedA / dbBalanceA && priceAfterDump < investedB / dbBalanceB, 'both holders must be genuinely underwater');
      console.log(`A: ${dbBalanceA.toFixed(2)} tokens for 1 ETH | B: ${dbBalanceB.toFixed(2)} tokens for 1 ETH | curve price after dump ${priceAfterDump.toExponential(6)} ETH`);

      // 3. THE INCIDENT: A sells 100%, B sells 50% — on-chain only; the DB rows below stay stale.
      await publicClient.waitForTransactionReceipt({ hash: await token.write.approve([router.address, balA], { account: holderA.account }) });
      await publicClient.waitForTransactionReceipt({ hash: await router.write.sellToken([token.address, balA, 0n, deadline()], { account: holderA.account }) });
      const halfB = balB / 2n;
      await publicClient.waitForTransactionReceipt({ hash: await token.write.approve([router.address, halfB], { account: holderB.account }) });
      await publicClient.waitForTransactionReceipt({ hash: await router.write.sellToken([token.address, halfB, 0n, deadline()], { account: holderB.account }) });
      assert.equal(await token.read.balanceOf([holderA.account.address]), 0n, 'A holds nothing on-chain');
      const onChainB = await token.read.balanceOf([holderB.account.address]);
      assert.equal(onChainB, balB - halfB, 'B holds exactly half on-chain');
      console.log(`On-chain now: A = 0 tokens, B = ${(Number(onChainB) / 1e18).toFixed(2)} tokens. DB will still say A=${dbBalanceA.toFixed(2)}, B=${dbBalanceB.toFixed(2)}.`);

      // fund the pool generously so funding never masks the cap
      await publicClient.waitForTransactionReceipt({ hash: await pool.write.depositReward([token.address], { account: creator.account, value: parseEther('0.5') }) });

      // 4. the REAL worker against the stale DB
      const supaMock = createSupabaseRestMock('https://phantom-balance-fork-test.supabase.co');
      globalThis.fetch = supaMock.fetchImpl as unknown as typeof fetch;
      process.env.SUPABASE_URL = 'https://phantom-balance-fork-test.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key-fork-test';
      process.env.VITE_EVM_RPC_URL = rpcProxy.url;
      process.env.VITE_LOSS_REWARD_POOL = pool.address;
      process.env.VITE_INCENTIFI_BONDING_CURVE_FACTORY = factory.address;
      process.env.OPERATOR_PRIVATE_KEY = operatorPrivateKey;
      const worker = await import('../../scripts/loss-reward-worker.mjs');

      const rowA = { token_address: token.address.toLowerCase(), wallet_address: holderA.account.address.toLowerCase(), token_balance: dbBalanceA, avg_cost_basis_eth: investedA / dbBalanceA, total_invested_eth: investedA, is_eligible: true, is_underwater_seller: false };
      const rowB = { token_address: token.address.toLowerCase(), wallet_address: holderB.account.address.toLowerCase(), token_balance: dbBalanceB, avg_cost_basis_eth: investedB / dbBalanceB, total_invested_eth: investedB, is_eligible: true, is_underwater_seller: false };
      supaMock.seed('holder_cost_basis', [rowA, rowB]);

      console.log('\n=== Real executeEpochForToken() against the stale DB ===');
      const res = await worker.executeEpochForToken(token.address, { skipFreshnessCheck: true });
      console.log('Epoch result:', JSON.stringify({ ...res, payouts: res.payouts?.map((p: any) => ({ wallet: p.wallet, finalRewardEth: p.finalRewardEth, balance: p.balance, invested: p.invested })) }, null, 2));

      const price = res.benchmarkPriceEth as number;
      const payouts: any[] = res.payouts || [];
      const payoutA = payouts.find((p) => p.wallet === rowA.wallet_address);
      const payoutB = payouts.find((p) => p.wallet === rowB.wallet_address);

      // A: phantom → nothing. (Uncapped code would have paid 10% of (1 ETH − 0) = 0.1 ETH.)
      assert.equal(payoutA, undefined, 'the fully-sold holder must receive NO payout');
      console.log(`PASS: A (sold 100% on-chain, DB says ${dbBalanceA.toFixed(2)}) → no payout. Uncapped formula would have paid ${(0.1 * investedA).toFixed(4)} ETH.`);

      // B: paid on exactly half — balance AND invested halved, basis preserved.
      assert.ok(payoutB, 'the half-sold holder must still be paid');
      const cappedBalance = Number(onChainB) / 1e18;
      const expectedB = 0.1 * Math.max(0, investedB * 0.5 - cappedBalance * price);
      const uncappedB = 0.1 * Math.max(0, investedB - dbBalanceB * price);
      assert.ok(Math.abs(payoutB.balance - cappedBalance) < 1e-6, 'payout balance must be the ON-CHAIN balance');
      assert.ok(Math.abs(payoutB.invested - investedB * 0.5) < 1e-12, 'invested must be scaled by the same ratio (half)');
      assert.ok(Math.abs(payoutB.finalRewardEth - expectedB) / expectedB < 1e-9, `B payout ${payoutB.finalRewardEth} must equal 10% of the loss on the HALF position (${expectedB})`);
      assert.ok(payoutB.finalRewardEth < uncappedB, 'capped payout must be strictly less than the stale-DB payout');
      console.log(`PASS: B paid ${payoutB.finalRewardEth.toExponential(6)} ETH == 10% × (0.5 ETH − ${cappedBalance.toFixed(2)} × ${price.toExponential(4)}); uncapped would have been ${uncappedB.toExponential(6)} ETH.`);
      assert.equal(res.eligibleHolders, 1);
      assert.ok(Math.abs(res.totalDistributedEth - payoutB.finalRewardEth) < 1e-15, 'epoch total must be exactly B alone');

      // Published on-chain with exactly B's amount; B's real claim lands exactly that.
      const root = await pool.read.epochMerkleRoots([token.address, BigInt(res.epochNumber)]);
      assert.notEqual(root, ZERO32, 'epoch must be published (B is a real underwater holder)');
      assert.equal(root, res.merkleRoot);
      const allocated = await pool.read.epochAllocatedAmounts([token.address, BigInt(res.epochNumber)]);
      assert.equal(allocated, payoutB.finalRewardWei, 'on-chain allocation must be exactly B\'s capped reward');
      const proofB = supaMock.table('epoch_holder_rewards').find((r: any) => r.wallet_address === rowB.wallet_address)?.merkle_proof;
      assert.ok(proofB);
      const before = await publicClient.getBalance({ address: holderB.account.address });
      const claimRc = await publicClient.waitForTransactionReceipt({ hash: await pool.write.claimReward([token.address, BigInt(res.epochNumber), payoutB.finalRewardWei, proofB], { account: holderB.account }) });
      const after = await publicClient.getBalance({ address: holderB.account.address });
      assert.equal(after - before + claimRc.gasUsed * claimRc.effectiveGasPrice, payoutB.finalRewardWei, 'B claims exactly the capped amount, net of gas');
      console.log(`PASS: root ${root.slice(0, 10)}… on-chain, allocated ${allocated} wei == B's reward; B claimed it, exact delta.`);
      assert.equal(supaMock.table('epoch_holder_rewards').some((r: any) => r.wallet_address === rowA.wallet_address), false, 'no proof row may exist for A');

      console.log('\n=== RESULT: phantom position paid 0; half-sold position paid on exactly half; published and claimed exactly ===');
    } finally {
      rpcProxy.server.close();
      rpcProxy.server.closeAllConnections?.();
    }
  });
});
