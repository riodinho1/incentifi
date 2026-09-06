import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { network } from 'hardhat';
import {
  parseEther,
  formatEther,
  formatUnits,
  getAddress,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  encodeDeployData,
  getContractAddress,
  concat,
  toHex,
  parseAbi,
  decodeEventLog,
} from 'viem';

/**
 * Proves the FIX in contracts/v4/IncentifiV4HookGenericSell.sol on a mainnet fork,
 * end-to-end, with real transactions: deploys the new hook via the SAME CREATE2
 * singleton factory and the SAME 0x2888 permission-flag mask the production deploy
 * used (so the address-mining path is exercised, not just the logic), a fresh
 * factory + router pointed at it, and a FRESH throwaway LossRewardPool (never the
 * production one). Then, against a freshly launched token:
 *
 *   1. generic BUY  via GenericV4Bot            -> succeeds   (was already fine)
 *   2. generic SELL via GenericV4Bot            -> SUCCEEDS   (THE FIX — reverts on the old hook)
 *        - seller's tokens leave, real ETH arrives, the Sold event's lossPoolFee
 *          lands in the LossRewardPool exactly, and the hook's ERC-6909 claim
 *          balance == tokens sold (proves the claims path, not a physical take)
 *   3. router SELL                              -> still succeeds (regression: pre-settle order stays compatible)
 *   4. router BUY after sells                   -> claim balance DEcreases (proves _payToken's burn path)
 *   5. full graduation                          -> claim balance ends at 0 (proves claims × _settleMintDelta)
 *   6. generic SELL post-graduation             -> succeeds (ZERO_DELTA pass-through regression)
 *
 * Companion: v4-generic-sell-proof.test.ts proves the same generic sell REVERTS on
 * the real deployed production hook — together they bracket the root cause.
 *
 * Run (isolated — node:test shares a process across files):
 *   npx hardhat test nodejs --network robinhoodFork -- test/hardhat/v4-generic-sell-hook.test.ts
 */

const POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951');
const CREATE2_FACTORY = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');
// beforeInitialize(13) | beforeAddLiquidity(11) | beforeSwap(7) | beforeSwapReturnDelta(3)
// — identical to the production NoPostGradFee deploy; the new hook declares the same four.
const REQUIRED_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 3n); // 0x2888
const FLAG_MASK = (1n << 14n) - 1n;
const MAX_SALT_SEARCH = 200_000;

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const ERC6909_ABI = parseAbi(['function balanceOf(address owner, uint256 id) view returns (uint256)']);

function findArtifact(name: string): { abi: any; bytecode: `0x${string}` } {
  const root = path.resolve('artifacts');
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === `${name}.json`) return JSON.parse(fs.readFileSync(full, 'utf8'));
    }
  }
  throw new Error(`artifact ${name}.json not found under ${root} — run \`npx hardhat compile\``);
}

describe('IncentifiV4HookGenericSell fork test (real CREATE2 deploy, generic sell must succeed)', () => {
  it('generic swap-then-settle sells succeed pre-graduation; claims flow through buys and graduation', async () => {
    const { viem, networkHelpers } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [deployer, creator, buyer, seller, buyer2] = await viem.getWalletClients();
    for (const w of [deployer, creator, buyer, seller, buyer2]) {
      await networkHelpers.setBalance(w.account.address, parseEther('100'));
    }
    // See v4-generic-sell-proof.test.ts: EDR cannot execute a call at exactly the
    // fork block on chain 4663 (no hardfork history configured). Every EVM call in
    // this test already follows a mined deployment, but mining one block up front
    // makes that guarantee explicit rather than incidental.
    await networkHelpers.mine(1);

    console.log('--- Fork setup ---');
    console.log('Forked at block:', await publicClient.getBlockNumber());
    for (const [name, addr] of [['PoolManager', POOL_MANAGER], ['CREATE2 singleton factory', CREATE2_FACTORY]] as const) {
      const code = await publicClient.getCode({ address: addr });
      assert.ok(code && code !== '0x', `${name} must have code on the fork`);
    }

    // Fresh, throwaway LossRewardPool — never the production one.
    const lossPool = await viem.deployContract('LossRewardPool', [deployer.account.address]);
    console.log('Throwaway LossRewardPool:', lossPool.address);

    // ------------------------------------------------------------------------
    // Deploy the new hook via CREATE2 — same singleton factory, same flag mask.
    // ------------------------------------------------------------------------
    const artifact = findArtifact('IncentifiV4HookGenericSell');
    const initCode = encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [POOL_MANAGER, lossPool.address, deployer.account.address],
    });
    const initCodeHash = keccak256(initCode);
    let salt: `0x${string}` | null = null;
    let hookAddr: `0x${string}` | null = null;
    for (let i = 0; i < MAX_SALT_SEARCH; i++) {
      const candidateSalt = toHex(BigInt(i), { size: 32 });
      const candidate = getContractAddress({ opcode: 'CREATE2', from: CREATE2_FACTORY, salt: candidateSalt, bytecodeHash: initCodeHash });
      if ((BigInt(candidate) & FLAG_MASK) === REQUIRED_FLAGS) {
        salt = candidateSalt;
        hookAddr = getAddress(candidate);
        break;
      }
    }
    assert.ok(salt && hookAddr, `no CREATE2 salt found within ${MAX_SALT_SEARCH} attempts`);
    console.log('Mined salt:', salt, '-> hook address:', hookAddr);

    await publicClient.waitForTransactionReceipt({
      hash: await deployer.sendTransaction({ to: CREATE2_FACTORY, data: concat([salt!, initCode]) }),
    });
    const hookCode = await publicClient.getCode({ address: hookAddr! });
    assert.ok(hookCode && hookCode !== '0x', 'hook must be deployed at the mined address');
    assert.equal(BigInt(hookAddr!) & FLAG_MASK, REQUIRED_FLAGS, 'deployed address must carry the 4 permission flags');
    const hook = await viem.getContractAt('IncentifiV4HookGenericSell', hookAddr!);
    assert.equal(getAddress(await hook.read.lossRewardPool()), getAddress(lossPool.address));
    console.log('Hook deployed via CREATE2; flags verified (0x' + REQUIRED_FLAGS.toString(16) + ').');

    const factory = await viem.deployContract('IncentifiV4Factory', [POOL_MANAGER, hookAddr!]);
    await publicClient.waitForTransactionReceipt({ hash: await hook.write.setFactory([factory.address]) });
    assert.equal(getAddress(await hook.read.factory()), getAddress(factory.address));
    const router = await viem.deployContract('IncentifiV4Router', [POOL_MANAGER, hookAddr!, factory.address]);
    console.log('Factory:', factory.address, '| Router:', router.address);

    // ------------------------------------------------------------------------
    // Launch a fresh token through the new factory.
    // ------------------------------------------------------------------------
    const token = await viem.deployContract('IncentifiLaunchToken', ['GenericSell Test', 'GST', TOTAL_SUPPLY], {
      client: { wallet: creator },
    });
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([factory.address, TOTAL_SUPPLY], { account: creator.account }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await factory.write.launchToken([token.address], { account: creator.account }),
    });
    const rawKey = await factory.read.getPoolKey([token.address]);
    const poolKey = {
      currency0: getAddress(rawKey.currency0),
      currency1: getAddress(rawKey.currency1),
      fee: Number(rawKey.fee),
      tickSpacing: Number(rawKey.tickSpacing),
      hooks: getAddress(rawKey.hooks),
    };
    const poolId = keccak256(
      encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [
        poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks,
      ])
    );
    assert.equal(poolKey.hooks, hookAddr, 'launched pool must be bound to the NEW hook');
    assert.equal((await hook.read.curveStates([poolId]))[2], true, 'pool must be initialized');
    console.log('Token:', token.address, '| poolId:', poolId);

    const claimId = BigInt(token.address); // CurrencyLibrary.toId() == uint160(address)
    const claimsOf = () => publicClient.readContract({ address: POOL_MANAGER, abi: ERC6909_ABI, functionName: 'balanceOf', args: [hookAddr!, claimId] });
    const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);
    const bot = await viem.deployContract('GenericV4Bot', [POOL_MANAGER]);

    // ------------------------------------------------------------------------
    // 1. generic BUY (buyer) + router BUY (seller, to hold a balance to sell)
    // ------------------------------------------------------------------------
    console.log('\n=== 1. buys ===');
    await publicClient.waitForTransactionReceipt({
      hash: await bot.write.swap([poolKey, true, parseEther('0.5'), 0n], { account: buyer.account, value: parseEther('0.5') }),
    });
    assert.ok((await token.read.balanceOf([buyer.account.address])) > 0n, 'generic buy must deliver tokens');
    await publicClient.waitForTransactionReceipt({
      hash: await router.write.buyToken([token.address, 0n, deadline()], { account: seller.account, value: parseEther('1') }),
    });
    const sellerBal = await token.read.balanceOf([seller.account.address]);
    assert.ok(sellerBal > 0n);
    console.log('generic buy OK | seller holds', formatUnits(sellerBal, 18), 'GST');
    assert.equal(await claimsOf(), 0n, 'no claims should exist before any sell');

    // ------------------------------------------------------------------------
    // 2. THE FIX — generic swap-then-settle SELL succeeds.
    // ------------------------------------------------------------------------
    console.log('\n=== 2. generic SELL via GenericV4Bot (THE FIX) ===');
    const sellAmt = sellerBal / 2n;
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([bot.address, sellAmt], { account: seller.account }),
    });
    const poolDepositedBefore = await lossPool.read.totalDeposited([token.address]);
    const ethBefore = await publicClient.getBalance({ address: seller.account.address });
    const sellHash = await bot.write.swap([poolKey, false, sellAmt, 0n], { account: seller.account });
    const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellHash });
    assert.equal(sellReceipt.status, 'success');
    const gas = sellReceipt.gasUsed * sellReceipt.effectiveGasPrice;
    const ethAfter = await publicClient.getBalance({ address: seller.account.address });
    const ethReceived = ethAfter - ethBefore + gas;
    assert.equal(sellerBal - (await token.read.balanceOf([seller.account.address])), sellAmt, 'exactly sellAmt must leave the seller');
    assert.ok(ethReceived > 0n, 'seller must receive real ETH');

    let soldFee: bigint | null = null;
    for (const log of sellReceipt.logs) {
      if (getAddress(log.address) !== hookAddr) continue;
      try {
        const ev = decodeEventLog({ abi: hook.abi, data: log.data, topics: log.topics });
        if (ev.eventName === 'Sold') soldFee = (ev.args as any).lossPoolFee as bigint;
      } catch {}
    }
    assert.ok(soldFee !== null && soldFee > 0n, 'Sold event with a lossPoolFee must be emitted');
    const poolDepositedAfter = await lossPool.read.totalDeposited([token.address]);
    assert.equal(poolDepositedAfter - poolDepositedBefore, soldFee!, 'LossRewardPool must receive exactly the emitted lossPoolFee');
    const claimsAfterSell = await claimsOf();
    assert.equal(claimsAfterSell, sellAmt, 'hook must hold ERC-6909 claims == tokens sold (claims path, not a physical take)');
    console.log('generic sell tx:', sellHash);
    console.log('  sold', formatUnits(sellAmt, 18), 'GST | received', formatEther(ethReceived), 'ETH | lossPoolFee', formatEther(soldFee!), 'ETH -> pool (exact)');
    console.log('  hook claim balance:', formatUnits(claimsAfterSell, 18), '(== sold)');
    console.log('PASS: generic swap-then-settle sell SUCCEEDS on the new hook.');

    // ------------------------------------------------------------------------
    // 3. router SELL still works (pre-settle order remains compatible)
    // ------------------------------------------------------------------------
    console.log('\n=== 3. router SELL (regression) ===');
    const buyerBal = await token.read.balanceOf([buyer.account.address]);
    const routerSellAmt = buyerBal / 4n;
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([router.address, routerSellAmt], { account: buyer.account }),
    });
    const rs = await publicClient.waitForTransactionReceipt({
      hash: await router.write.sellToken([token.address, routerSellAmt, 0n, deadline()], { account: buyer.account }),
    });
    assert.equal(rs.status, 'success');
    const claimsAfterRouterSell = await claimsOf();
    assert.equal(claimsAfterRouterSell, sellAmt + routerSellAmt, 'router sell must also accrue as claims');
    console.log('router sell OK | claims now', formatUnits(claimsAfterRouterSell, 18));

    // ------------------------------------------------------------------------
    // 4. BUY after sells — _payToken must burn claims first
    // ------------------------------------------------------------------------
    console.log('\n=== 4. buy after sells (burn path) ===');
    await publicClient.waitForTransactionReceipt({
      hash: await router.write.buyToken([token.address, 0n, deadline()], { account: buyer2.account, value: parseEther('0.3') }),
    });
    const claimsAfterBuy = await claimsOf();
    assert.ok(claimsAfterBuy < claimsAfterRouterSell, 'a buy must spend claims first (burn), reducing the claim balance');
    console.log('claims', formatUnits(claimsAfterRouterSell, 18), '->', formatUnits(claimsAfterBuy, 18), 'after buy');
    console.log('PASS: _payToken burn path exercised.');

    // ------------------------------------------------------------------------
    // 5. graduation — claims must be fully consumed by _settleMintDelta
    // ------------------------------------------------------------------------
    console.log('\n=== 5. graduation ===');
    let buys = 0;
    while (!(await hook.read.curveStates([poolId]))[3]) {
      const w = buys % 2 === 0 ? buyer : buyer2;
      await publicClient.waitForTransactionReceipt({
        hash: await router.write.buyToken([token.address, 0n, deadline()], { account: w.account, value: parseEther('2'), gas: 3_000_000n }),
      });
      buys++;
      assert.ok(buys < 12, 'did not graduate within a reasonable number of buys');
    }
    assert.equal((await hook.read.curveStates([poolId]))[3], true, 'must be graduated');
    const claimsAfterGrad = await claimsOf();
    assert.equal(claimsAfterGrad, 0n, 'all claims must be burned into the graduation liquidity mints');
    console.log('graduated after', buys, 'buys | hook claim balance:', claimsAfterGrad.toString(), '(== 0)');
    console.log('PASS: claims × _settleMintDelta handled at graduation.');

    // ------------------------------------------------------------------------
    // 6. post-graduation generic SELL — ZERO_DELTA pass-through regression
    // ------------------------------------------------------------------------
    console.log('\n=== 6. post-graduation generic SELL (pass-through) ===');
    const pgBal = await token.read.balanceOf([buyer2.account.address]);
    const pgSell = pgBal / 10n;
    assert.ok(pgSell > 0n);
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([bot.address, pgSell], { account: buyer2.account }),
    });
    const pg = await publicClient.waitForTransactionReceipt({
      hash: await bot.write.swap([poolKey, false, pgSell, 0n], { account: buyer2.account }),
    });
    assert.equal(pg.status, 'success');
    assert.equal(pgBal - (await token.read.balanceOf([buyer2.account.address])), pgSell);
    console.log('post-graduation generic sell OK.');

    console.log('\n=== RESULT: IncentifiV4HookGenericSell — generic sells work pre- AND post-graduation; claims accounting holds through buys and graduation ===');
  });
});
