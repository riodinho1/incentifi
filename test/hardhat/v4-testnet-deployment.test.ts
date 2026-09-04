import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network, artifacts } from 'hardhat';
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbi, concat, pad, toHex, getAddress, parseEther } from 'viem';

/**
 * The pre-mainnet checklist's Section 06 recommendation, exercised for real:
 * deploy a SEPARATE, low-parameter IncentifiV4HookTestnet instance (graduation
 * target ~$293, not ~$69K — see that contract's own doc comment for the exact
 * scaling), wired to a FRESH, throwaway LossRewardPool — never the real
 * production one at 0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF — and drive one
 * complete launch -> trade -> graduate lifecycle through it. Reuses the SAME
 * IncentifiV4Factory and IncentifiV4Router contracts as the production
 * deployment (they take poolManager/hook as constructor args and hold no
 * hardcoded economic parameters of their own), proving those two contracts
 * genuinely generalize to a differently-configured hook rather than being
 * implicitly coupled to the production hook's specific numbers.
 *
 * Same real-PoolManager, real-receipts standard as the production fork test —
 * the only thing "test" about this deployment is its economic scale and its
 * LossRewardPool, not the rigor of the verification.
 */

const CREATE2_FACTORY = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
const REAL_PRODUCTION_LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

const REQUIRED_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 3n);
const FLAG_MASK = (1n << 14n) - 1n;

function computeCreate2Address(deployer: `0x${string}`, salt: bigint, initCodeHash: `0x${string}`): `0x${string}` {
  const packed = concat(['0xff', deployer, pad(toHex(salt), { size: 32 }), initCodeHash]);
  const hash = keccak256(packed);
  return getAddress(`0x${hash.slice(-40)}`);
}

describe('IncentifiV4HookTestnet: a separate, low-parameter deployment per the pre-mainnet checklist', () => {
  it('mines+deploys a throwaway-parameter hook, wires a fresh LossRewardPool, and drives one full launch-through-graduation cycle', async () => {
    const { viem } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [deployerWallet, creatorWallet, buyerWallet, notDeployerWallet, graduatingBuyerWallet] = await viem.getWalletClients();
    const deployerAddress = getAddress(deployerWallet.account.address);

    // --- Step 1: a FRESH, throwaway LossRewardPool. Never the real production
    // one — this is the whole point of a test-parameter deployment. ---
    console.log('--- Throwaway LossRewardPool (NOT the real production one) ---');
    const realProdPoolBalanceBefore = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
    console.log('Real production LossRewardPool balance BEFORE any of this:', realProdPoolBalanceBefore.toString(), 'wei (pre-existing real mainnet state from the fork — not ours, not zero, and not the point; the point is whether it CHANGES)');
    const testLossRewardPool = await viem.deployContract('LossRewardPool', [deployerAddress]);
    console.log('Throwaway LossRewardPool deployed at:', testLossRewardPool.address);
    assert.notEqual(getAddress(testLossRewardPool.address), REAL_PRODUCTION_LOSS_REWARD_POOL, 'the test deployment must NEVER point at the real production LossRewardPool address');

    // --- Step 2: mine + deploy IncentifiV4HookTestnet, same real technique as
    // the production hook (real CREATE2 singleton factory, real HookMiner
    // cross-check, real permission-bit confirmation). ---
    console.log('\n--- Mining + deploying IncentifiV4HookTestnet ---');
    const hookArtifact = await artifacts.readArtifact('IncentifiV4HookTestnet');
    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address, address, address'),
      [POOL_MANAGER, getAddress(testLossRewardPool.address), deployerAddress]
    );
    const initCode = concat([hookArtifact.bytecode as `0x${string}`, constructorArgs]);
    const initCodeHash = keccak256(initCode);

    let foundSalt: bigint | null = null;
    let foundAddress: `0x${string}` | null = null;
    for (let salt = 0n; salt < 300_000n; salt++) {
      const candidate = computeCreate2Address(CREATE2_FACTORY, salt, initCodeHash);
      if ((BigInt(candidate) & FLAG_MASK) === REQUIRED_FLAGS) {
        foundSalt = salt;
        foundAddress = candidate;
        break;
      }
    }
    assert.ok(foundSalt !== null && foundAddress !== null, 'no valid salt found');
    console.log('Mined salt', foundSalt!.toString(), '-> predicted address', foundAddress);

    const checkerContract = await viem.deployContract('HookMinerCheck');
    const onChainComputed = await checkerContract.read.computeAddress([CREATE2_FACTORY, foundSalt!, initCode]);
    assert.equal(getAddress(onChainComputed), foundAddress, 'JS-computed address must match the real HookMiner library');

    const deployData = concat([pad(toHex(foundSalt!), { size: 32 }), initCode]);
    const deployHash = await deployerWallet.sendTransaction({ to: CREATE2_FACTORY, data: deployData });
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    console.log('Deployment tx:', deployHash, '| block:', deployReceipt.blockNumber.toString(), '| gas used:', deployReceipt.gasUsed.toString(), '| status:', deployReceipt.status);
    assert.equal(deployReceipt.status, 'success');

    const deployedFlags = BigInt(foundAddress!) & FLAG_MASK;
    assert.equal(deployedFlags, REQUIRED_FLAGS, 'deployed address must carry the exact required permission bits');

    const hookContract = await viem.getContractAt('IncentifiV4HookTestnet', foundAddress!);
    assert.equal(getAddress(await hookContract.read.deployer()), deployerAddress);
    assert.equal(getAddress(await hookContract.read.lossRewardPool()), getAddress(testLossRewardPool.address));
    console.log('Confirmed: hook.lossRewardPool() is the throwaway pool, not the real production one.');

    // --- Step 3: OnlyDeployer, the guard-revert this deployment is uniquely
    // positioned to test — the production hook's setFactory() was already
    // called once in the main fork test, so OnlyDeployer (as distinct from
    // FactoryAlreadySet) could never be isolated there. This hook is fresh. ---
    console.log('\n--- OnlyDeployer guard on setFactory() ---');
    const notDeployerAddress = getAddress(notDeployerWallet.account.address);
    assert.notEqual(notDeployerAddress, deployerAddress);
    let onlyDeployerReverted = false;
    try {
      await hookContract.write.setFactory([notDeployerAddress], { account: notDeployerWallet.account });
    } catch {
      onlyDeployerReverted = true;
    }
    assert.ok(onlyDeployerReverted, 'setFactory() called by anyone other than the recorded deployer must revert (OnlyDeployer)');
    console.log('Confirmed: setFactory() from a non-deployer account reverts (OnlyDeployer).');
    assert.equal(getAddress(await hookContract.read.factory()), '0x0000000000000000000000000000000000000000', 'factory must still be unset after the rejected attempt');

    // --- Step 4: deploy the SAME, unmodified IncentifiV4Factory and
    // IncentifiV4Router contracts used in production, wired to this test hook.
    // Proves those two contracts genuinely generalize — they hold no hardcoded
    // reference to the production hook's specific economic parameters. ---
    console.log('\n--- Factory + router (same contracts as production, wired to the test hook) ---');
    const factory = await viem.deployContract('IncentifiV4Factory', [POOL_MANAGER, foundAddress!]);
    const setFactoryHash = await deployerWallet.writeContract({
      address: foundAddress!,
      abi: hookArtifact.abi,
      functionName: 'setFactory',
      args: [factory.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: setFactoryHash });
    assert.equal(getAddress(await hookContract.read.factory()), getAddress(factory.address), 'setFactory() from the real deployer must succeed this time');
    console.log('Factory deployed at', factory.address, 'and wired.');

    const router = await viem.deployContract('IncentifiV4Router', [POOL_MANAGER, foundAddress!, factory.address]);
    console.log('Router deployed at', router.address);

    // --- Step 5: real, permissionless token launch at TEST-SCALE pricing. ---
    console.log('\n--- Real token launch, test-scale pricing ---');
    const creatorAddress = getAddress(creatorWallet.account.address);
    const token = await viem.deployContract('IncentifiLaunchToken', ['V4 Testnet Token', 'V4TEST', TOTAL_SUPPLY], {
      client: { wallet: creatorWallet },
    });
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([factory.address, TOTAL_SUPPLY], { account: creatorWallet.account }),
    });
    const launchHash = await factory.write.launchToken([token.address], { account: creatorWallet.account });
    const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: launchHash });
    console.log('launchToken() tx:', launchHash, '| gas used:', launchReceipt.gasUsed.toString(), '| status:', launchReceipt.status);
    assert.equal(launchReceipt.status, 'success');

    const poolId = keccak256(
      encodeAbiParameters(
        parseAbiParameters('address, address, uint24, int24, address'),
        [getAddress('0x0000000000000000000000000000000000000000'), getAddress(token.address), 0, 200, foundAddress!]
      )
    );

    const slot0Launch = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
    const expectedLaunchPrice = await hookContract.read.launchSqrtPriceX96();
    assert.equal(slot0Launch[0], expectedLaunchPrice, 'StateView must confirm the real, independent launch price for the test-parameter pool');

    const Q192 = 2n ** 96n * 2n ** 96n;
    const impliedLaunchMcapWei = (TOTAL_SUPPLY * Q192) / (slot0Launch[0] * slot0Launch[0]);
    const impliedLaunchMcapEth = Number(impliedLaunchMcapWei) / 1e18;
    console.log('Implied launch market cap (from StateView\'s real price, independent of the hook\'s own formula):', impliedLaunchMcapEth, 'ETH (~$', (impliedLaunchMcapEth * 2500).toFixed(2), 'at a nominal $2,500/ETH)');
    assert.ok(impliedLaunchMcapEth > 0.03 && impliedLaunchMcapEth < 0.05, `implied launch mcap must be ~0.04 ETH (test scale), got ${impliedLaunchMcapEth}`);

    // --- Step 6: real buy/sell at test scale, then drive to the (much smaller)
    // graduation boundary via the same router clamp+refund logic. ---
    console.log('\n--- Real buy + sell at test scale ---');
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const buyerAddress = getAddress(buyerWallet.account.address);
    const smallBuyEth = parseEther('0.005');
    const buyHash = await router.write.buyToken([token.address, 0n, deadline], { value: smallBuyEth, account: buyerWallet.account });
    const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
    assert.equal(buyReceipt.status, 'success');
    const buyerTokenBalance = await token.read.balanceOf([buyerAddress]);
    console.log('Buy tx:', buyHash, '| tokens received:', buyerTokenBalance.toString());
    assert.ok(buyerTokenBalance > 0n);

    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([router.address, buyerTokenBalance], { account: buyerWallet.account }),
    });
    const sellHash = await router.write.sellToken([token.address, buyerTokenBalance, 0n, deadline], { account: buyerWallet.account });
    const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellHash });
    assert.equal(sellReceipt.status, 'success');
    console.log('Sell tx:', sellHash, '| status:', sellReceipt.status);

    const testLossPoolDeposited = await testLossRewardPool.read.totalDeposited([token.address]);
    console.log('Throwaway LossRewardPool.totalDeposited(token):', testLossPoolDeposited.toString(), '(real fee flow confirmed on the THROWAWAY pool)');
    assert.ok((testLossPoolDeposited as bigint) > 0n, 'real trading fees must have flowed into the throwaway LossRewardPool');

    const realProdPoolBalanceAfterTrading = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
    assert.equal(realProdPoolBalanceAfterTrading, realProdPoolBalanceBefore, 'the real production LossRewardPool\'s real ETH balance must be EXACTLY unchanged by any of this test-parameter deployment\'s trading — the actual proof it was never touched, not just a single reading');
    console.log('Confirmed: real production LossRewardPool balance is byte-for-byte unchanged (', realProdPoolBalanceAfterTrading.toString(), 'wei, same as before) — it was never called.');

    console.log('\n--- Driving to the test-scale graduation boundary ---');
    const graduationTarget = await hookContract.read.GRADUATION_ETH_TARGET();
    const stateBeforeGrad = await hookContract.read.curveStates([poolId]);
    const realEthReserveBeforeGrad = stateBeforeGrad[4] as bigint;
    const maxNetEth = graduationTarget - realEthReserveBeforeGrad;
    const maxGrossEth = 100n * (maxNetEth / 98n) + (maxNetEth % 98n);
    const overshootGrossEth = maxGrossEth * 3n;
    console.log('GRADUATION_ETH_TARGET (test scale):', graduationTarget.toString(), '(~$', (Number(graduationTarget) / 1e18 * 2500).toFixed(2), ')');
    console.log('Exact clamp target:', maxGrossEth.toString());

    const graduatingBuyerAddress = getAddress(graduatingBuyerWallet.account.address);
    const graduatingBuyerEthBefore = await publicClient.getBalance({ address: graduatingBuyerAddress });
    const gradHash = await router.write.buyToken([token.address, 0n, deadline], { value: overshootGrossEth, account: graduatingBuyerWallet.account });
    const gradReceipt = await publicClient.waitForTransactionReceipt({ hash: gradHash });
    console.log('Graduating buyToken() tx:', gradHash, '| block:', gradReceipt.blockNumber.toString(), '| gas used:', gradReceipt.gasUsed.toString(), '| status:', gradReceipt.status);
    assert.equal(gradReceipt.status, 'success', 'the test-scale graduating buy, including its real liquidity deposit, must succeed');

    const graduatingBuyerEthAfter = await publicClient.getBalance({ address: graduatingBuyerAddress });
    const gradGasCost = gradReceipt.gasUsed * gradReceipt.effectiveGasPrice;
    const graduatingBuyerNetOutflow = graduatingBuyerEthBefore - graduatingBuyerEthAfter - gradGasCost;
    console.log('Buyer real net ETH outflow:', graduatingBuyerNetOutflow.toString(), 'vs exact clamp target:', maxGrossEth.toString());
    assert.equal(graduatingBuyerNetOutflow, maxGrossEth, 'clamp+refund must land exactly at test scale too');

    const stateAfterGrad = await hookContract.read.curveStates([poolId]);
    assert.equal(stateAfterGrad[3], true, 'state.graduated must be true');
    assert.equal(stateAfterGrad[4], graduationTarget, 'realEthReserve must land exactly on the test-scale GRADUATION_ETH_TARGET');

    const gradLogs = await publicClient.getContractEvents({
      address: foundAddress!,
      abi: hookArtifact.abi,
      eventName: 'GraduationLiquidityDeployed',
      fromBlock: gradReceipt.blockNumber,
      toBlock: gradReceipt.blockNumber,
    });
    assert.equal(gradLogs.length, 1);
    const gradEvent = gradLogs[0].args as { bootstrapLiquidity: bigint; finalLiquidity: bigint; correctedSqrtPriceX96: bigint; ethDust: bigint; tokenDust: bigint };
    console.log('GraduationLiquidityDeployed (test scale):', {
      bootstrapLiquidity: gradEvent.bootstrapLiquidity.toString(),
      finalLiquidity: gradEvent.finalLiquidity.toString(),
      correctedSqrtPriceX96: gradEvent.correctedSqrtPriceX96.toString(),
      ethDust: gradEvent.ethDust.toString(),
      tokenDust: gradEvent.tokenDust.toString(),
    });
    assert.ok(gradEvent.bootstrapLiquidity > 0n && gradEvent.finalLiquidity > 0n, 'test-scale liquidity deposit must be real and nonzero');

    const slot0PostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
    const liquidityPostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] });
    assert.equal(slot0PostGrad[0], gradEvent.correctedSqrtPriceX96, 'StateView must independently confirm the test-scale pool\'s corrected price');
    assert.equal(liquidityPostGrad, gradEvent.bootstrapLiquidity + gradEvent.finalLiquidity, 'StateView must independently confirm the test-scale pool\'s real liquidity');
    console.log('StateView (independent): sqrtPriceX96 =', slot0PostGrad[0].toString(), '| liquidity =', liquidityPostGrad.toString());

    const ethDustStored = await hookContract.read.ethDustBalances([poolId]);
    const tokenDustStored = await hookContract.read.tokenDustBalances([poolId]);
    const hookTokenBalancePostGrad = await token.read.balanceOf([foundAddress!]);
    assert.equal(ethDustStored, gradEvent.ethDust);
    assert.equal(tokenDustStored, gradEvent.tokenDust);
    assert.equal(hookTokenBalancePostGrad, tokenDustStored, 'dust tracking must hold at test scale too');

    let postGradRouterReverted = false;
    try {
      await router.write.buyToken([token.address, 0n, deadline], { value: parseEther('0.0001'), account: buyerWallet.account });
    } catch {
      postGradRouterReverted = true;
    }
    assert.ok(postGradRouterReverted, 'router must refuse further curve trading post-graduation at test scale too');

    const realProdPoolBalanceFinal = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
    assert.equal(realProdPoolBalanceFinal, realProdPoolBalanceBefore, 'the real production LossRewardPool must remain exactly untouched even after this deployment\'s full graduation, not just after its early trading');
    console.log('\nConfirmed once more, after the full graduation: real production LossRewardPool balance still exactly unchanged.');

    console.log('\n--- RESULT: a fully separate, low-parameter IncentifiV4HookTestnet instance was mined, deployed, wired to a throwaway LossRewardPool (never the real production one), and driven through a complete real launch -> trade -> graduate lifecycle at ~$100 launch / ~$293 graduation scale. The real production LossRewardPool\'s balance was checked before, during, and after — byte-for-byte unchanged throughout, not just asserted. OnlyDeployer was forced to revert for real on a hook that had never had setFactory() called before, closing the one guard-revert gap the already-wired production hook could not test. ---');
  });
});
