import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  parseEther,
  parseUnits,
  formatEther,
  formatUnits,
  getAddress,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
} from 'viem';

/**
 * ROOT-CAUSE PROOF, against the REAL deployed production V4 hook and a REAL
 * production pool on a mainnet fork — not a re-derivation from a fresh deploy.
 *
 * The claim being proven: a generic V4 caller (standard order — swap() FIRST,
 * settle AFTER; exactly what UniversalRouter and every third-party bot do) can
 * BUY a pre-graduation token through IncentifiV4HookNoPostGradFee but can NEVER
 * SELL one, while the same sell through IncentifiV4Router succeeds. The cause is
 * settlement ORDER (the hook's mid-swap take() needs tokens already inside
 * PoolManager, which only the router pre-settles), not approvals — see
 * contracts/v4/IncentifiV4HookGenericSell.sol's header for the full argument.
 *
 * Instrument: contracts/v4/test-helpers/GenericV4Bot.sol, whose _executeSwap()
 * calls poolManager.swap() at line 158 and only settles at 169-173 — the
 * generic pattern. The seller is the REAL creator wallet, impersonated, spending
 * its REAL TESTING balance against the REAL production pool; nothing here is
 * synthetic except the fork itself.
 *
 * Three assertions, all required:
 *   1. generic SELL via GenericV4Bot  -> REVERTS   (the bug)
 *   2. same SELL via IncentifiV4Router -> SUCCEEDS  (control: the only working path)
 *   3. generic BUY  via GenericV4Bot  -> SUCCEEDS  (the asymmetry — same caller)
 *
 * Run (isolated — node:test shares a process across files):
 *   npx hardhat test nodejs --network robinhoodFork -- test/hardhat/v4-generic-sell-proof.test.ts
 */

const POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951');
const V4_FACTORY = getAddress('0xdEca2efDB578B6E5F298885b97F64d52f92f5Aa9');
const V4_ROUTER = getAddress('0x0666399367fa585d672BF793158b35290b7F4082');
const V4_HOOK = getAddress('0x5bBcf2CDAAA00c285eEc903AA1E2aB9142782888');
const TESTING = getAddress('0xB122425D30d77f37d8C237CD3a85Bf04F3dbb936');
const CREATOR = getAddress('0xba69Ca72CD2B87113471c4C38f08928761Edb5cE');

const SELL_AMOUNT = parseUnits('100000', 18);
const BUY_WEI = parseEther('0.01');

describe('V4 generic-sell root-cause proof (real production hook + pool, mainnet fork)', () => {
  it('generic sell reverts, router sell succeeds, generic buy succeeds — same caller, same pool', async () => {
    const { viem, networkHelpers } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();

    console.log('--- Fork setup ---');
    console.log('Forked at block:', await publicClient.getBlockNumber());
    for (const [name, addr] of [
      ['PoolManager', POOL_MANAGER],
      ['IncentifiV4Factory (production)', V4_FACTORY],
      ['IncentifiV4Router (production)', V4_ROUTER],
      ['IncentifiV4HookNoPostGradFee (production)', V4_HOOK],
      ['TESTING token', TESTING],
    ] as const) {
      const code = await publicClient.getCode({ address: addr });
      assert.ok(code && code !== '0x', `${name} must have deployed code on the fork`);
      console.log(`  ${name}: deployed (${(code.length - 2) / 2} bytes)`);
    }

    // The REAL creator wallet, impersonated. It is nearly drained of ETH on real
    // mainnet (a deposit into the bot swept it), so gas is topped up here — the
    // TESTING balance being spent is its real one.
    await networkHelpers.impersonateAccount(CREATOR);
    await networkHelpers.setBalance(CREATOR, parseEther('10'));
    // impersonateAccount/setBalance edit state without mining, so "latest" is still
    // the fork block itself — and EDR refuses to EXECUTE a call at exactly the fork
    // block on a chain it has no hardfork history for ("No known hardfork for
    // execution on historical block N (relative to fork block number N) in chain
    // with id 4663"). Mining one local block first makes "latest" a local block
    // with a known hardfork. Hit for real on the first run of this test; the other
    // fork tests never saw it only because their first EVM read always came after
    // a mined deployment.
    await networkHelpers.mine(1);
    const creator = await viem.getWalletClient(CREATOR);

    const factory = await viem.getContractAt('IncentifiV4Factory', V4_FACTORY);
    const token = await viem.getContractAt('IncentifiLaunchToken', TESTING);
    const router = await viem.getContractAt('IncentifiV4Router', V4_ROUTER);
    const hook = await viem.getContractAt('IncentifiV4HookNoPostGradFee', V4_HOOK);

    // Real PoolKey from the real factory; poolId derived exactly as PoolIdLibrary.toId().
    const rawKey = await factory.read.getPoolKey([TESTING]);
    const poolKey = {
      currency0: getAddress(rawKey.currency0),
      currency1: getAddress(rawKey.currency1),
      fee: Number(rawKey.fee),
      tickSpacing: Number(rawKey.tickSpacing),
      hooks: getAddress(rawKey.hooks),
    };
    const poolId = keccak256(
      encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [
        poolKey.currency0,
        poolKey.currency1,
        poolKey.fee,
        poolKey.tickSpacing,
        poolKey.hooks,
      ])
    );
    assert.equal(poolKey.hooks, V4_HOOK, 'the real pool must be bound to the real production hook');
    assert.equal(poolKey.currency1, TESTING);

    const curve = await hook.read.curveStates([poolId]);
    assert.equal(curve[2], true, 'pool must be initialized');
    assert.equal(curve[3], false, 'pool must be PRE-graduation — the constraint under test only applies there');
    console.log('Real poolId:', poolId, '| initialized:', curve[2], '| graduated:', curve[3]);

    const balStart = await token.read.balanceOf([CREATOR]);
    assert.ok(balStart >= SELL_AMOUNT, `creator must hold >= ${formatUnits(SELL_AMOUNT, 18)} TESTING (has ${formatUnits(balStart, 18)})`);
    console.log('Creator real TESTING balance:', formatUnits(balStart, 18));

    // The generic caller: zero Incentifi knowledge, standard swap-then-settle order.
    const bot = await viem.deployContract('GenericV4Bot', [POOL_MANAGER]);
    console.log('GenericV4Bot deployed:', bot.address);

    // ------------------------------------------------------------------------
    // ASSERTION 1 — the bug: generic SELL reverts.
    // ------------------------------------------------------------------------
    console.log('\n=== ASSERTION 1: generic (swap-then-settle) SELL via GenericV4Bot ===');
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([bot.address, SELL_AMOUNT], { account: creator.account }),
    });
    // Note: hardhat-viem simulates before broadcasting, so this fails at the same
    // stage a real bot's "pre-broadcast simulation" does — no tx hash ever exists,
    // exactly the symptom observed on mainnet.
    let genericSellError: Error | null = null;
    try {
      await bot.write.swap([poolKey, false, SELL_AMOUNT, 0n], { account: creator.account });
    } catch (err) {
      genericSellError = err as Error;
    }
    assert.ok(genericSellError, 'generic sell MUST revert against the production hook (it did not — root cause not reproduced)');
    console.log('Reverted as expected. First line:', genericSellError.message.split('\n')[0]);
    assert.equal(await token.read.balanceOf([CREATOR]), balStart, 'a reverted sell must move no tokens');
    console.log('PASS: generic sell reverts; balance unchanged.');

    // ------------------------------------------------------------------------
    // ASSERTION 2 — control: the SAME sell through IncentifiV4Router succeeds.
    // (Its _executeSell pre-settles tokens INTO PoolManager before swap().)
    // ------------------------------------------------------------------------
    console.log('\n=== ASSERTION 2: same SELL via IncentifiV4Router ===');
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([V4_ROUTER, SELL_AMOUNT], { account: creator.account }),
    });
    const ethBeforeRouterSell = await publicClient.getBalance({ address: CREATOR });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const sellHash = await router.write.sellToken([TESTING, SELL_AMOUNT, 0n, deadline], { account: creator.account });
    const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellHash });
    assert.equal(sellReceipt.status, 'success');
    const sellGas = sellReceipt.gasUsed * sellReceipt.effectiveGasPrice;
    const ethAfterRouterSell = await publicClient.getBalance({ address: CREATOR });
    const balAfterRouterSell = await token.read.balanceOf([CREATOR]);
    const ethReceived = ethAfterRouterSell - ethBeforeRouterSell + sellGas;
    console.log('Router sell tx:', sellHash, '| gas:', sellReceipt.gasUsed.toString());
    console.log('TESTING delta:', formatUnits(balStart - balAfterRouterSell, 18), '| ETH received (net of gas):', formatEther(ethReceived));
    assert.equal(balStart - balAfterRouterSell, SELL_AMOUNT, 'router sell must remove exactly SELL_AMOUNT');
    assert.ok(ethReceived > 0n, 'router sell must pay out real ETH');
    console.log('PASS: router sell succeeds — the only working pre-graduation sell path.');

    // ------------------------------------------------------------------------
    // ASSERTION 3 — the asymmetry: the SAME generic caller CAN buy.
    // (The hook take()s native ETH there, borrowing against PoolManager's real
    // ETH from other pools; a fresh token has no such shared reserve.)
    // ------------------------------------------------------------------------
    console.log('\n=== ASSERTION 3: generic BUY via GenericV4Bot (same caller) ===');
    const balBeforeBuy = await token.read.balanceOf([CREATOR]);
    const buyHash = await bot.write.swap([poolKey, true, BUY_WEI, 0n], { account: creator.account, value: BUY_WEI });
    const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
    assert.equal(buyReceipt.status, 'success');
    const balAfterBuy = await token.read.balanceOf([CREATOR]);
    console.log('Generic buy tx:', buyHash, '| tokens out:', formatUnits(balAfterBuy - balBeforeBuy, 18));
    assert.ok(balAfterBuy > balBeforeBuy, 'generic buy must deliver tokens');
    console.log('PASS: generic buy succeeds — buy works, sell does not, for the identical generic caller.');

    console.log('\n=== RESULT: root cause CONFIRMED on the real production hook — settlement order, not approvals ===');
  });
});
