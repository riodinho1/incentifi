import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network, artifacts } from 'hardhat';
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbi, concat, pad, toHex, getAddress, parseEther } from 'viem';

/**
 * Proves the NEW post-graduation fee mechanism added to IncentifiV4Hook.sol:
 * once a pool has graduated, the hook no longer passes every swap through
 * untouched — it now skims the same 2% (1% creator / 1% LossRewardPool) fee
 * pre-graduation swaps always paid, while letting the REAL AMM price the trade
 * on the net amount. This is a genuinely different mechanism from anything
 * tested before this file:
 *   - BUY: fee comes off the ETH input via beforeSwap's specified-delta, before
 *     the core pool ever sees it (mirrors _executeBuy's grossEth-based fee).
 *   - SELL: the fee has to come from the real, core-pool-computed ETH OUTPUT,
 *     which isn't known until the core pool actually runs — this hook now
 *     implements a real afterSwap for the first time in this codebase to do it.
 *
 * This changed the hook's declared permissions (added afterSwap +
 * afterSwapReturnDelta), which changes the required CREATE2 permission-bit
 * pattern — a fresh salt must be mined against the new getHookPermissions().
 *
 * Both the buy and the sell below are driven through GenericV4Bot — the same
 * zero-Incentifi-knowledge contract used throughout this engagement — on
 * purpose: the whole point of this change (prompted by a real third-party
 * contract trading against the real mainnet deployment and paying us nothing)
 * is that the fee must apply no matter who initiates the swap, not just when
 * our own router is used.
 */

const CREATE2_FACTORY = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

// NEW permission set: beforeInitialize, beforeAddLiquidity, beforeSwap,
// beforeSwapReturnDelta, afterSwap, afterSwapReturnDelta — confirmed against
// the actual installed Hooks.sol flag constants, not assumed:
// BEFORE_INITIALIZE=1<<13, BEFORE_ADD_LIQUIDITY=1<<11, BEFORE_SWAP=1<<7,
// BEFORE_SWAP_RETURNS_DELTA=1<<3, AFTER_SWAP=1<<6, AFTER_SWAP_RETURNS_DELTA=1<<2.
const REQUIRED_FLAGS =
  (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 3n) | (1n << 6n) | (1n << 2n); // 10444 (0x28cc)
const FLAG_MASK = (1n << 14n) - 1n;

function computeCreate2Address(deployer: `0x${string}`, salt: bigint, initCodeHash: `0x${string}`): `0x${string}` {
  const packed = concat(['0xff', deployer, pad(toHex(salt), { size: 32 }), initCodeHash]);
  return getAddress(`0x${keccak256(packed).slice(-40)}`);
}

describe('IncentifiV4Hook: post-graduation fee collection (real AMM execution + real fee skim)', () => {
  it('mines the new 6-flag hook, graduates a pool, then proves the 2% fee applies on both a real buy and a real sell against real AMM liquidity, via a zero-Incentifi-knowledge caller', async () => {
    const { viem } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [deployerWallet, creatorWallet, buyerWallet, graduatingBuyerWallet, traderWallet] = await viem.getWalletClients();
    const deployerAddress = getAddress(deployerWallet.account.address);

    // --- Mine + deploy the hook with the NEW permission set ---
    console.log('--- Mining + deploying the hook with the new 6-flag (afterSwap-enabled) permission set ---');
    const lossRewardPool = await viem.deployContract('LossRewardPool', [deployerAddress]);
    const hookArtifact = await artifacts.readArtifact('IncentifiV4Hook');
    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address, address, address'),
      [POOL_MANAGER, getAddress(lossRewardPool.address), deployerAddress]
    );
    const initCode = concat([hookArtifact.bytecode as `0x${string}`, constructorArgs]);
    const initCodeHash = keccak256(initCode);

    let foundSalt: bigint | null = null;
    let foundAddress: `0x${string}` | null = null;
    for (let salt = 0n; salt < 500_000n; salt++) {
      const candidate = computeCreate2Address(CREATE2_FACTORY, salt, initCodeHash);
      if ((BigInt(candidate) & FLAG_MASK) === REQUIRED_FLAGS) {
        foundSalt = salt;
        foundAddress = candidate;
        break;
      }
    }
    assert.ok(foundSalt !== null && foundAddress !== null, 'no valid salt found for the new 6-flag pattern');
    console.log('Mined salt', foundSalt, '-> address', foundAddress);

    const checkerContract = await viem.deployContract('HookMinerCheck');
    const onChainComputed = await checkerContract.read.computeAddress([CREATE2_FACTORY, foundSalt!, initCode]);
    assert.equal(getAddress(onChainComputed), foundAddress, 'JS-computed address must match the real HookMiner library');

    const deployData = concat([pad(toHex(foundSalt!), { size: 32 }), initCode]);
    const deployHash = await deployerWallet.sendTransaction({ to: CREATE2_FACTORY, data: deployData });
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    assert.equal(deployReceipt.status, 'success', 'hook deployment (new permission set) must succeed for real');
    const deployedFlags = BigInt(foundAddress!) & FLAG_MASK;
    assert.equal(deployedFlags, REQUIRED_FLAGS, 'deployed address must carry the exact new permission bits');
    console.log('Hook deployed for real, permission bits confirmed on-chain. Gas used:', deployReceipt.gasUsed.toString());

    const hookContract = await viem.getContractAt('IncentifiV4Hook', foundAddress!);

    // --- Factory, router, launch (all proven patterns, unchanged) ---
    console.log('\n--- Factory + router + real token launch ---');
    const factory = await viem.deployContract('IncentifiV4Factory', [POOL_MANAGER, foundAddress!]);
    await publicClient.waitForTransactionReceipt({
      hash: await deployerWallet.writeContract({ address: foundAddress!, abi: hookArtifact.abi, functionName: 'setFactory', args: [factory.address] }),
    });
    const router = await viem.deployContract('IncentifiV4Router', [POOL_MANAGER, foundAddress!, factory.address]);
    const bot = await viem.deployContract('GenericV4Bot', [POOL_MANAGER]);

    const creatorAddress = getAddress(creatorWallet.account.address);
    const token = await viem.deployContract('IncentifiLaunchToken', ['V4 Graduated-Fee Test', 'V4GRADFEE', TOTAL_SUPPLY], {
      client: { wallet: creatorWallet },
    });
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([factory.address, TOTAL_SUPPLY], { account: creatorWallet.account }),
    });
    const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: await factory.write.launchToken([token.address], { account: creatorWallet.account }) });
    assert.equal(launchReceipt.status, 'success');

    const poolId = keccak256(
      encodeAbiParameters(
        parseAbiParameters('address, address, uint24, int24, address'),
        [getAddress('0x0000000000000000000000000000000000000000'), getAddress(token.address), 0, 200, foundAddress!]
      )
    );
    const poolKeyStruct = await factory.read.getPoolKey([token.address]);
    console.log('Token launched:', token.address, '| PoolId:', poolId);

    // --- Drive to graduation (proven clamp+refund pattern) ---
    console.log('\n--- Driving to graduation ---');
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const graduationTarget = await hookContract.read.GRADUATION_ETH_TARGET();
    const maxGrossEth = 100n * (graduationTarget / 98n) + (graduationTarget % 98n);
    const overshootGrossEth = maxGrossEth * 2n;
    const gradReceipt = await publicClient.waitForTransactionReceipt({
      hash: await router.write.buyToken([token.address, 0n, deadline], { value: overshootGrossEth, account: graduatingBuyerWallet.account }),
    });
    assert.equal(gradReceipt.status, 'success', 'the graduating buy must succeed');
    const stateAfterGrad = await hookContract.read.curveStates([poolId]);
    assert.equal(stateAfterGrad[3], true, 'pool must be graduated before proceeding');
    console.log('Graduated. realEthReserve:', stateAfterGrad[4].toString());

    // ========================================================================
    // THE ACTUAL NEW BEHAVIOR: real buy, real fee, via a zero-Incentifi-
    // knowledge caller (GenericV4Bot) — not our own router.
    // ========================================================================
    console.log('\n--- Post-graduation BUY via GenericV4Bot (zero Incentifi-specific code) ---');
    const traderAddress = getAddress(traderWallet.account.address);
    const buyAmountIn = parseEther('0.05');
    const expectedBuyCreatorFee = buyAmountIn / 100n;
    const expectedBuyLossPoolFee = buyAmountIn / 100n;
    console.log('Expected buy fee: creatorFee=', expectedBuyCreatorFee.toString(), 'lossPoolFee=', expectedBuyLossPoolFee.toString());

    const creatorBalBeforeBuy = await hookContract.read.creatorBalances([creatorAddress]);
    const lossPoolEthBeforeBuy = await publicClient.getBalance({ address: getAddress(lossRewardPool.address) });
    const lossPoolDepositedBeforeBuy = await lossRewardPool.read.totalDeposited([token.address]);
    const traderEthBeforeBuy = await publicClient.getBalance({ address: traderAddress });
    const traderTokenBeforeBuy = await token.read.balanceOf([traderAddress]);

    const buyHash = await bot.write.swap([poolKeyStruct, true, buyAmountIn, 0n], { value: buyAmountIn, account: traderWallet.account });
    const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
    console.log('Buy tx:', buyHash, '| gas used:', buyReceipt.gasUsed.toString(), '| status:', buyReceipt.status);
    assert.equal(buyReceipt.status, 'success', 'a real post-graduation buy through a generic, zero-knowledge caller must succeed with the fee applied');

    // Independent cross-check #1: our own GraduatedFeeCollected event.
    const buyFeeLogs = await publicClient.getContractEvents({
      address: foundAddress!, abi: hookArtifact.abi, eventName: 'GraduatedFeeCollected',
      fromBlock: buyReceipt.blockNumber, toBlock: buyReceipt.blockNumber,
    });
    assert.equal(buyFeeLogs.length, 1, 'exactly one GraduatedFeeCollected event must fire for this buy');
    const buyFeeEvent = buyFeeLogs[0].args as { zeroForOne: boolean; creatorFee: bigint; lossPoolFee: bigint };
    console.log('GraduatedFeeCollected (buy):', buyFeeEvent);
    assert.equal(buyFeeEvent.zeroForOne, true);
    assert.equal(buyFeeEvent.creatorFee, expectedBuyCreatorFee);
    assert.equal(buyFeeEvent.lossPoolFee, expectedBuyLossPoolFee);

    // Independent cross-check #2: real balance deltas, not just our own event.
    const creatorBalAfterBuy = await hookContract.read.creatorBalances([creatorAddress]);
    assert.equal(creatorBalAfterBuy - creatorBalBeforeBuy, expectedBuyCreatorFee, 'creatorBalances must grow by exactly the buy fee, measured via real state, not just the event');

    const lossPoolEthAfterBuy = await publicClient.getBalance({ address: getAddress(lossRewardPool.address) });
    assert.equal(lossPoolEthAfterBuy - lossPoolEthBeforeBuy, expectedBuyLossPoolFee, 'LossRewardPool\'s own real ETH balance must grow by exactly the buy fee');

    const lossPoolDepositedAfterBuy = await lossRewardPool.read.totalDeposited([token.address]);
    assert.equal((lossPoolDepositedAfterBuy as bigint) - (lossPoolDepositedBeforeBuy as bigint), expectedBuyLossPoolFee, 'LossRewardPool.totalDeposited(token) must reflect the real depositReward() call exactly');

    // Independent cross-check #3: the buyer really did pay the FULL amountIn
    // (not amountIn-fee) — the fee comes out of what reaches the AMM, not off
    // the trader's own payment.
    const traderEthAfterBuy = await publicClient.getBalance({ address: traderAddress });
    const buyGasCost = buyReceipt.gasUsed * buyReceipt.effectiveGasPrice;
    const traderNetOutflow = traderEthBeforeBuy - traderEthAfterBuy - buyGasCost;
    console.log('Trader real ETH outflow (excl. gas):', traderNetOutflow.toString(), 'vs full amountIn:', buyAmountIn.toString());
    assert.equal(traderNetOutflow, buyAmountIn, 'the buyer must pay the FULL amountIn — the fee is skimmed before the AMM sees it, not refunded off the buyer\'s payment');

    // Independent cross-check #4: the buyer received a real, positive amount of
    // tokens, priced by the real AMM on the NET (post-fee) amount.
    const traderTokenAfterBuy = await token.read.balanceOf([traderAddress]);
    const tokensReceived = traderTokenAfterBuy - traderTokenBeforeBuy;
    console.log('Trader real tokens received (from real AMM, on the net-of-fee amount):', tokensReceived.toString());
    assert.ok(tokensReceived > 0n, 'buyer must receive a real, positive amount of tokens from the real AMM');

    console.log('--- BUY-SIDE GRADUATED FEE VERIFIED ---');

    // ========================================================================
    // The sell side — the actually novel mechanism (afterSwap, fee computed
    // from a real, already-executed AMM output).
    // ========================================================================
    console.log('\n--- Post-graduation SELL via GenericV4Bot (zero Incentifi-specific code) ---');
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([bot.address, tokensReceived], { account: traderWallet.account }),
    });

    const creatorBalBeforeSell = await hookContract.read.creatorBalances([creatorAddress]);
    const lossPoolEthBeforeSell = await publicClient.getBalance({ address: getAddress(lossRewardPool.address) });
    const lossPoolDepositedBeforeSell = await lossRewardPool.read.totalDeposited([token.address]);
    const traderEthBeforeSell = await publicClient.getBalance({ address: traderAddress });

    const sellHash = await bot.write.swap([poolKeyStruct, false, tokensReceived, 0n], { account: traderWallet.account });
    const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellHash });
    console.log('Sell tx:', sellHash, '| gas used:', sellReceipt.gasUsed.toString(), '| status:', sellReceipt.status);
    assert.equal(sellReceipt.status, 'success', 'a real post-graduation sell through a generic, zero-knowledge caller must succeed with the fee applied via the new afterSwap path');

    // Independent cross-check #1: the REAL PoolManager Swap event — a
    // completely separate, real, unmodified Uniswap contract's own report of
    // what the core AMM actually computed for this trade BEFORE our fee. This
    // is the exact real grossEthOut the new _afterSwap logic had to work from.
    const swapEventAbi = parseAbi([
      'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
    ]);
    const poolManagerSwapLogs = await publicClient.getContractEvents({
      address: POOL_MANAGER, abi: swapEventAbi, eventName: 'Swap',
      fromBlock: sellReceipt.blockNumber, toBlock: sellReceipt.blockNumber,
    });
    const realSwap = poolManagerSwapLogs.find((l) => (l.args.id as string).toLowerCase() === poolId.toLowerCase());
    assert.ok(realSwap, 'PoolManager must have emitted a real Swap event for this pool in this transaction');
    const realGrossEthOut = realSwap!.args.amount0 as bigint;
    assert.ok(realGrossEthOut > 0n, 'the core pool\'s own real Swap event must show it owing the trader ETH');
    const expectedSellCreatorFee = realGrossEthOut / 100n;
    const expectedSellLossPoolFee = realGrossEthOut / 100n;
    console.log('REAL PoolManager Swap event (independent of our hook): grossEthOut =', realGrossEthOut.toString());
    console.log('Expected sell fee (computed from that independent number): creatorFee=', expectedSellCreatorFee.toString(), 'lossPoolFee=', expectedSellLossPoolFee.toString());

    // Independent cross-check #2: our own GraduatedFeeCollected event, checked
    // against the fee derived from PoolManager's OWN independent number, not
    // our hook's internal math re-deriving its own answer.
    const sellFeeLogs = await publicClient.getContractEvents({
      address: foundAddress!, abi: hookArtifact.abi, eventName: 'GraduatedFeeCollected',
      fromBlock: sellReceipt.blockNumber, toBlock: sellReceipt.blockNumber,
    });
    assert.equal(sellFeeLogs.length, 1, 'exactly one GraduatedFeeCollected event must fire for this sell');
    const sellFeeEvent = sellFeeLogs[0].args as { zeroForOne: boolean; creatorFee: bigint; lossPoolFee: bigint };
    console.log('GraduatedFeeCollected (sell):', sellFeeEvent);
    assert.equal(sellFeeEvent.zeroForOne, false);
    assert.equal(sellFeeEvent.creatorFee, expectedSellCreatorFee, 'the afterSwap-collected creator fee must match 1% of PoolManager\'s own independently-reported real output');
    assert.equal(sellFeeEvent.lossPoolFee, expectedSellLossPoolFee);

    // Independent cross-check #3: real balance deltas.
    const creatorBalAfterSell = await hookContract.read.creatorBalances([creatorAddress]);
    assert.equal(creatorBalAfterSell - creatorBalBeforeSell, expectedSellCreatorFee, 'creatorBalances must grow by exactly the sell fee');

    const lossPoolEthAfterSell = await publicClient.getBalance({ address: getAddress(lossRewardPool.address) });
    assert.equal(lossPoolEthAfterSell - lossPoolEthBeforeSell, expectedSellLossPoolFee, 'LossRewardPool\'s real ETH balance must grow by exactly the sell fee');

    const lossPoolDepositedAfterSell = await lossRewardPool.read.totalDeposited([token.address]);
    assert.equal((lossPoolDepositedAfterSell as bigint) - (lossPoolDepositedBeforeSell as bigint), expectedSellLossPoolFee);

    // Independent cross-check #4: the seller actually received grossEthOut MINUS
    // the fee, not the full real AMM output.
    const traderEthAfterSell = await publicClient.getBalance({ address: traderAddress });
    const sellGasCost = sellReceipt.gasUsed * sellReceipt.effectiveGasPrice;
    const traderNetInflow = traderEthAfterSell - traderEthBeforeSell + sellGasCost;
    const expectedNetToSeller = realGrossEthOut - expectedSellCreatorFee - expectedSellLossPoolFee;
    console.log('Seller real ETH received (net of gas):', traderNetInflow.toString(), 'vs expected (real AMM output minus 2% fee):', expectedNetToSeller.toString());
    assert.equal(traderNetInflow, expectedNetToSeller, 'the seller must receive exactly the real AMM output minus the 2% fee — not the full real output');

    console.log('--- SELL-SIDE GRADUATED FEE VERIFIED (afterSwap, fee derived from an independently-confirmed real AMM output) ---');

    // ========================================================================
    // Creator can genuinely withdraw the newly-collected post-graduation fees.
    // ========================================================================
    console.log('\n--- Creator claims the post-graduation fees ---');
    const totalClaimable = await hookContract.read.creatorBalances([creatorAddress]);
    const creatorEthBefore = await publicClient.getBalance({ address: creatorAddress });
    const claimReceipt = await publicClient.waitForTransactionReceipt({
      hash: await hookContract.write.claimCreatorFees({ account: creatorWallet.account }),
    });
    assert.equal(claimReceipt.status, 'success');
    const creatorEthAfter = await publicClient.getBalance({ address: creatorAddress });
    const claimGasCost = claimReceipt.gasUsed * claimReceipt.effectiveGasPrice;
    assert.equal(creatorEthAfter - creatorEthBefore + claimGasCost, totalClaimable, 'creator must be able to genuinely withdraw fees collected via the new post-graduation mechanism, same pull-payment pattern as before');
    console.log('Creator claimed', totalClaimable.toString(), 'wei, confirmed via real EOA balance delta.');

    console.log('\n--- RESULT: post-graduation fee collection proven on both directions, via a caller with zero Incentifi-specific knowledge (not our own router), with the sell-side fee independently cross-checked against PoolManager\'s own real Swap event rather than re-deriving our own hook\'s math. Real ETH balance deltas confirmed on LossRewardPool and creatorBalances for both trades, and the creator successfully withdrew the result. ---');
  });
});
