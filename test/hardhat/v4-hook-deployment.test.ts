import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network, artifacts } from 'hardhat';
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbi, concat, pad, toHex, getAddress, parseEther } from 'viem';

/**
 * Builds up the V4 system stage by stage, each stage's proof resting on the previous
 * stage's real, verified on-chain state — not re-asserted from scratch each time.
 *
 * Stage 1 (previously proven, unchanged here): mine a CREATE2 salt for
 * IncentifiV4Hook off-chain, cross-check against the REAL on-chain
 * HookMiner.computeAddress(), deploy for real through the REAL canonical CREATE2
 * singleton factory (0x4e59b44847b379578588920cA78FbF26c0B4956C), confirm the
 * resulting address's permission bits on-chain.
 *
 * Stage 2 (previously proven, unchanged here): deploy IncentifiV4Factory, wire it
 * to the hook via setFactory(), launch a real token through factory.launchToken(),
 * and independently verify the resulting pool's state via StateView — a separate,
 * real, already-deployed Uniswap contract that has no reason to agree with our own
 * hook's bookkeeping unless PoolManager.initialize() genuinely ran.
 *
 * Stage 3 (new): deploy IncentifiV4Router, drive a real buy and a real sell through
 * it, and prove the full unlock -> swap -> hook.beforeSwap -> settle/take chain
 * actually executes correctly. Every economic claim (tokens out, ETH out, the
 * 1%/1% fee split) is checked against REAL balance deltas — on the buyer/seller
 * EOA, on the hook contract, and on LossRewardPool's own actual ETH balance and its
 * own totalDeposited(token) mapping (a real, pre-existing, unmodified production
 * contract we do not control) — not against our own hook's internal bookkeeping or
 * emitted events alone. The creator's fee is also actually claimed via
 * claimCreatorFees(), with the resulting ETH balance change measured on the
 * creator's own EOA, to prove it is genuinely withdrawable and not just an internal
 * ledger entry. The swap succeeding at all is itself independent proof that
 * PoolManager's own flash-accounting invariant (all currency deltas zeroed out by
 * the end of unlock()) was satisfied — that check is enforced by Uniswap's own core
 * contract, not something this test can fake.
 */

const CREATE2_FACTORY = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

// Hooks.sol flag constants, confirmed against the actual installed library:
// BEFORE_INITIALIZE_FLAG = 1<<13, BEFORE_ADD_LIQUIDITY_FLAG = 1<<11,
// BEFORE_SWAP_FLAG = 1<<7, BEFORE_SWAP_RETURNS_DELTA_FLAG = 1<<3.
// UPDATED: IncentifiV4Hook.sol now also declares afterSwap + afterSwapReturnDelta
// (AFTER_SWAP_FLAG = 1<<6, AFTER_SWAP_RETURNS_DELTA_FLAG = 1<<2) — added for the
// post-graduation fee mechanism (see test/hardhat/v4-graduated-fee.test.ts). The
// required bit pattern below MUST track getHookPermissions() exactly, or mining
// succeeds off-chain while the real deployment reverts on permission validation.
const REQUIRED_FLAGS =
  (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 3n) | (1n << 6n) | (1n << 2n); // 10444 (0x28cc)
const FLAG_MASK = (1n << 14n) - 1n; // Hooks.ALL_HOOK_MASK

function computeCreate2Address(deployer: `0x${string}`, salt: bigint, initCodeHash: `0x${string}`): `0x${string}` {
  const packed = concat([
    '0xff',
    deployer,
    pad(toHex(salt), { size: 32 }),
    initCodeHash,
  ]);
  const hash = keccak256(packed);
  return getAddress(`0x${hash.slice(-40)}`);
}

describe('IncentifiV4 system: mining, deployment, and first real pool launch', () => {
  it('mines+deploys the hook, wires the factory, and launches a real token through PoolManager.initialize()', async () => {
    const { viem } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [deployerWallet] = await viem.getWalletClients();
    const deployerAddress = getAddress(deployerWallet.account.address);

    console.log('--- Setup ---');
    console.log('CREATE2 factory:', CREATE2_FACTORY);
    const factoryCode = await publicClient.getCode({ address: CREATE2_FACTORY });
    assert.ok(factoryCode && factoryCode !== '0x', 'CREATE2 singleton factory must have real deployed code on the fork');
    console.log('  confirmed deployed:', ((factoryCode.length - 2) / 2), 'bytes');

    // --- Step 1: build the real creation bytecode + constructor args ---
    const hookArtifact = await artifacts.readArtifact('IncentifiV4Hook');
    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address, address, address'),
      [POOL_MANAGER, LOSS_REWARD_POOL, deployerAddress]
    );
    const initCode = concat([hookArtifact.bytecode as `0x${string}`, constructorArgs]);
    const initCodeHash = keccak256(initCode);

    console.log('--- Mining ---');
    console.log('Required permission flags:', REQUIRED_FLAGS.toString(), '(0x' + REQUIRED_FLAGS.toString(16) + ')');
    console.log('Init code size:', (initCode.length - 2) / 2, 'bytes');
    console.log('Init code hash:', initCodeHash);

    // --- Step 2: off-chain brute-force search (the expensive part, done for free here
    // instead of costing ~46M+ gas on-chain per HookMiner.find()'s own loop structure) ---
    const searchStart = Date.now();
    let foundSalt: bigint | null = null;
    let foundAddress: `0x${string}` | null = null;
    const MAX_LOOP = 160_444; // same cap HookMiner.sol itself uses
    for (let salt = 0n; salt < BigInt(MAX_LOOP); salt++) {
      const candidate = computeCreate2Address(CREATE2_FACTORY, salt, initCodeHash);
      if ((BigInt(candidate) & FLAG_MASK) === REQUIRED_FLAGS) {
        foundSalt = salt;
        foundAddress = candidate;
        break;
      }
    }
    const searchMs = Date.now() - searchStart;
    assert.ok(foundSalt !== null && foundAddress !== null, `no valid salt found within ${MAX_LOOP} attempts`);
    console.log(`Found salt ${foundSalt} after ${searchMs}ms (off-chain search, zero gas cost)`);
    console.log('Predicted hook address:', foundAddress);
    console.log('Predicted address low-14-bits:', (BigInt(foundAddress!) & FLAG_MASK).toString(2).padStart(14, '0'), 'vs required', REQUIRED_FLAGS.toString(2).padStart(14, '0'));

    // --- Step 3: cross-check against the REAL on-chain HookMiner.computeAddress(),
    // not just trusting this file's own JS reimplementation of the same formula ---
    const checkerContract = await viem.deployContract('HookMinerCheck');
    const onChainComputed = await checkerContract.read.computeAddress([CREATE2_FACTORY, foundSalt!, initCode]);
    console.log('--- Cross-check against real HookMiner.computeAddress() ---');
    console.log('Off-chain JS computed: ', foundAddress);
    console.log('Real on-chain computed:', getAddress(onChainComputed));
    assert.equal(getAddress(onChainComputed), foundAddress, 'JS-computed address must exactly match the REAL HookMiner library');

    // --- Step 4: confirm the target address is actually empty before deploying ---
    const codeBefore = await publicClient.getCode({ address: foundAddress! });
    assert.ok(!codeBefore || codeBefore === '0x', 'predicted address must have no code yet');

    // --- Step 5: the REAL CREATE2 deployment, through the REAL singleton factory ---
    console.log('--- Real CREATE2 deployment ---');
    const deployData = concat([pad(toHex(foundSalt!), { size: 32 }), initCode]);
    const txHash = await deployerWallet.sendTransaction({ to: CREATE2_FACTORY, data: deployData });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log('Deployment tx hash:', txHash);
    console.log('Block:', receipt.blockNumber.toString());
    console.log('Gas used:', receipt.gasUsed.toString());
    console.log('Status:', receipt.status);
    assert.equal(receipt.status, 'success', 'the real CREATE2 deployment transaction must succeed');

    // --- Step 6: prove the hook actually landed at the predicted address, with real code ---
    const codeAfter = await publicClient.getCode({ address: foundAddress! });
    assert.ok(codeAfter && codeAfter !== '0x', 'hook must have real deployed bytecode at the predicted address');
    console.log('Deployed bytecode size:', ((codeAfter!.length - 2) / 2), 'bytes');

    // --- Step 7: prove the permission bits are actually correct on the REAL deployed address ---
    const deployedFlags = BigInt(foundAddress!) & FLAG_MASK;
    assert.equal(deployedFlags, REQUIRED_FLAGS, 'deployed hook address must carry the exact required permission bits');
    console.log('Confirmed: deployed address permission bits match exactly.');

    // --- Step 8: prove the deployed hook is actually the right contract, not just
    // "some contract at the right address" — call a real view function on it ---
    const hookContract = await viem.getContractAt('IncentifiV4Hook', foundAddress!);
    const deployerOnChain = await hookContract.read.deployer();
    const lossRewardPoolOnChain = await hookContract.read.lossRewardPool();
    console.log('hook.deployer() on-chain:      ', deployerOnChain);
    console.log('hook.lossRewardPool() on-chain:', lossRewardPoolOnChain);
    assert.equal(getAddress(deployerOnChain), deployerAddress, 'deployed hook must report the correct deployer');
    assert.equal(getAddress(lossRewardPoolOnChain), LOSS_REWARD_POOL, 'deployed hook must report the correct LossRewardPool');

    console.log('--- STAGE 1 RESULT: hook mined and deployed for real, permission bits and constructor state verified on-chain ---\n');

    // ========================================================================
    // STAGE 2: factory deployment, setFactory() wiring, real token launch,
    // first real PoolManager.initialize() call.
    // ========================================================================

    // --- Deploy the factory. Ordinary CREATE (no address constraints on a
    // factory — only the hook needs a mined address). ---
    console.log('--- Factory deployment ---');
    const factory = await viem.deployContract('IncentifiV4Factory', [POOL_MANAGER, foundAddress!]);
    console.log('IncentifiV4Factory deployed at:', factory.address);
    const factoryPoolManagerOnChain = await factory.read.poolManager();
    const factoryHookOnChain = await factory.read.hook();
    assert.equal(getAddress(factoryPoolManagerOnChain), POOL_MANAGER);
    assert.equal(getAddress(factoryHookOnChain), foundAddress!);
    console.log('Confirmed factory.poolManager() and factory.hook() report the correct addresses.');

    // --- setFactory() wiring: the one-time bootstrap step that resolves the
    // circular dependency (hook needs factory's address, factory needs hook's
    // address to even be deployed). Must be called by the SAME address passed
    // as `_deployer` in the hook's constructor args (deployerAddress here) —
    // NOT by the CREATE2 factory proxy, which is what msg.sender would have
    // been had the hook recorded it directly instead of taking it as an arg. ---
    console.log('\n--- setFactory() wiring ---');
    const factoryBeforeWiring = await hookContract.read.factory();
    assert.equal(getAddress(factoryBeforeWiring), getAddress('0x0000000000000000000000000000000000000000'), 'factory must be unset before wiring');

    const setFactoryHash = await deployerWallet.writeContract({
      address: foundAddress!,
      abi: hookArtifact.abi,
      functionName: 'setFactory',
      args: [factory.address],
    });
    const setFactoryReceipt = await publicClient.waitForTransactionReceipt({ hash: setFactoryHash });
    console.log('setFactory() tx hash:', setFactoryHash);
    console.log('Gas used:', setFactoryReceipt.gasUsed.toString());
    console.log('Status:', setFactoryReceipt.status);
    assert.equal(setFactoryReceipt.status, 'success');

    const factoryAfterWiring = await hookContract.read.factory();
    assert.equal(getAddress(factoryAfterWiring), getAddress(factory.address), 'hook.factory() must now report the real factory address');
    console.log('Confirmed hook.factory() now reports the real, deployed factory address.');

    // Re-attempting setFactory() must revert — it's one-time-only, not an ongoing
    // admin lever. Proving the guard actually fires, not just that it's written.
    let secondSetFactoryReverted = false;
    try {
      await deployerWallet.writeContract({
        address: foundAddress!,
        abi: hookArtifact.abi,
        functionName: 'setFactory',
        args: [factory.address],
      });
    } catch {
      secondSetFactoryReverted = true;
    }
    assert.ok(secondSetFactoryReverted, 'a second setFactory() call must revert (FactoryAlreadySet)');
    console.log('Confirmed a second setFactory() call reverts — the one-time guard actually fires, not just written.');

    // --- Real token launch. Deploy a fresh IncentifiLaunchToken (existing,
    // unmodified v3 contract) as a distinct "creator" account, approve the
    // factory, then call launchToken(). ---
    console.log('\n--- Real token launch ---');
    const [, creatorWallet] = await viem.getWalletClients();
    const creatorAddress = getAddress(creatorWallet.account.address);

    const token = await viem.deployContract('IncentifiLaunchToken', ['V4 Fork Test Token', 'V4FORK', TOTAL_SUPPLY], {
      client: { wallet: creatorWallet },
    });
    console.log('Token deployed at:', token.address, '(creator:', creatorAddress, ')');
    const tokenCreatorOnChain = await token.read.creator();
    assert.equal(getAddress(tokenCreatorOnChain), creatorAddress, 'token.creator() must be the real creator EOA, not the factory');

    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([factory.address, TOTAL_SUPPLY], { account: creatorWallet.account }),
    });
    console.log('Creator approved factory for the full supply.');

    const launchHash = await factory.write.launchToken([token.address], { account: creatorWallet.account });
    const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: launchHash });
    console.log('launchToken() tx hash:', launchHash);
    console.log('Block:', launchReceipt.blockNumber.toString());
    console.log('Gas used:', launchReceipt.gasUsed.toString());
    console.log('Status:', launchReceipt.status);
    console.log('Log count:', launchReceipt.logs.length);
    assert.equal(launchReceipt.status, 'success', 'launchToken() — which internally calls PoolManager.initialize() — must succeed as one atomic transaction');

    // --- Independent verification, not just "the transaction didn't revert" ---
    console.log('\n--- Independent verification ---');

    // 1. Real ERC20 balance check: the full supply actually moved to the hook.
    const hookTokenBalance = await token.read.balanceOf([foundAddress!]);
    assert.equal(hookTokenBalance, TOTAL_SUPPLY, 'hook must hold the full token supply after launch');
    console.log('Hook token balance:', hookTokenBalance.toString(), '== TOTAL_SUPPLY:', hookTokenBalance === TOTAL_SUPPLY);

    // 2. Compute the PoolId exactly as PoolIdLibrary.toId() does (keccak256 of the
    // ABI-packed 5-field PoolKey struct) and read the hook's OWN curveStates for it.
    const poolKeyEncoded = encodeAbiParameters(
      parseAbiParameters('address, address, uint24, int24, address'),
      [getAddress('0x0000000000000000000000000000000000000000'), getAddress(token.address), 0, 200, foundAddress!]
    );
    const poolId = keccak256(poolKeyEncoded);
    console.log('Computed PoolId:', poolId);

    const curveState = await hookContract.read.curveStates([poolId]);
    console.log('hook.curveStates(poolId):', {
      token: curveState[0],
      creator: curveState[1],
      initialized: curveState[2],
      graduated: curveState[3],
      realEthReserve: curveState[4].toString(),
      realTokenReserve: curveState[5].toString(),
    });
    assert.equal(getAddress(curveState[0] as string), getAddress(token.address), 'curveStates.token must match');
    assert.equal(getAddress(curveState[1] as string), creatorAddress, 'curveStates.creator must match');
    assert.equal(curveState[2], true, 'curveStates.initialized must be true');
    assert.equal(curveState[3], false, 'curveStates.graduated must be false at launch');
    assert.equal(curveState[4], 0n, 'realEthReserve must start at 0');
    assert.equal(curveState[5], TOTAL_SUPPLY, 'realTokenReserve must start at TOTAL_SUPPLY');

    // 3. THE key independent check: ask a completely separate, real, already-
    // deployed Uniswap contract (StateView) what price the pool is ACTUALLY at.
    // StateView has no reason to agree with our hook's own bookkeeping unless
    // PoolManager.initialize() genuinely set this pool's real, on-chain slot0.
    const [sqrtPriceX96OnChain, tickOnChain] = await publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId],
    });
    const expectedSqrtPriceX96 = await hookContract.read.launchSqrtPriceX96();
    console.log('StateView.getSlot0(poolId):');
    console.log('  sqrtPriceX96 (real, from PoolManager via StateView):', sqrtPriceX96OnChain.toString());
    console.log('  expected (hook.launchSqrtPriceX96()):                ', expectedSqrtPriceX96.toString());
    console.log('  tick:', tickOnChain);
    assert.equal(sqrtPriceX96OnChain, expectedSqrtPriceX96, 'the REAL PoolManager pool price (via an independent contract, StateView) must exactly match the intended $5,000-market-cap starting price');
    assert.notEqual(sqrtPriceX96OnChain, 0n, 'a genuinely-initialized pool must not have a zero sqrtPriceX96 (which is what an uninitialized pool reports)');

    // 4. Independent of the hook's own launchSqrtPriceX96() formula entirely:
    // convert the REAL, StateView-reported sqrtPriceX96 into an implied market
    // cap in ETH from first principles (mcap = TOTAL_SUPPLY * 2^192 / sqrtP^2),
    // and check it against the ~2 ETH (~$5,000 at a nominal ~$2,500/ETH) figure
    // the spec actually calls for — not just that the on-chain value matches
    // whatever the hook's own function happens to compute (a bug in that
    // function's formula, found and fixed this session, would previously have
    // passed the check above while still being economically wrong). This is the
    // "verified independently at the launch step specifically" check.
    const Q192 = 2n ** 96n * 2n ** 96n;
    const impliedLaunchMcapWei = (TOTAL_SUPPLY * Q192) / (sqrtPriceX96OnChain * sqrtPriceX96OnChain);
    const impliedLaunchMcapEth = Number(impliedLaunchMcapWei) / 1e18;
    console.log('Implied launch market cap, computed from StateView\'s real sqrtPriceX96 alone (mcap = TOTAL_SUPPLY * 2^192 / sqrtP^2):', impliedLaunchMcapWei.toString(), 'wei =', impliedLaunchMcapEth, 'ETH');
    assert.ok(
      impliedLaunchMcapEth > 1.9 && impliedLaunchMcapEth < 2.1,
      `implied launch market cap must be ~2 ETH (~$5,000 at a nominal ~$2,500/ETH) — got ${impliedLaunchMcapEth} ETH, computed purely from StateView's real on-chain price, independent of the hook's own launchSqrtPriceX96() formula`
    );

    console.log('\n--- STAGE 2 RESULT: factory deployed, hook wired, token launched, and PoolManager.initialize() genuinely ran — confirmed by an independent contract (StateView), not just our own hook\'s bookkeeping. Launch price independently converted to an implied ~2 ETH (~$5,000) market cap from first principles, not merely matched against the hook\'s own formula. ---');

    // ========================================================================
    // STAGE 3: real buy + real sell through IncentifiV4Router, proving the full
    // unlock -> swap -> hook.beforeSwap -> settle/take chain, and independently
    // verifying the 2% fee split.
    // ========================================================================
    console.log('\n--- Structural check: router has no reference to the old bonding curve ---');
    const fs = await import('node:fs');
    const routerSource = fs.readFileSync('contracts/v4/IncentifiV4Router.sol', 'utf8');
    // Strip block comments (/* ... */) and line comments (// ...) before checking —
    // the file's NatSpec prose legitimately discusses IncentifiBondingCurve.buy()'s
    // clamp formula by name (that's the whole point of the ROUTER DECISION doc
    // comment); what actually matters is that no live Solidity code — an import, a
    // type reference, a function call — ever names it.
    const codeOnly = routerSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(!codeOnly.includes('IncentifiBondingCurve'), 'router\'s actual Solidity code (comments stripped) must not reference IncentifiBondingCurve anywhere — no fallback path can exist if the symbol is never even imported');
    console.log('Confirmed: contracts/v4/IncentifiV4Router.sol\'s live code (excluding NatSpec prose that merely discusses it by name) contains no reference to IncentifiBondingCurve.');

    console.log('\n--- Router deployment ---');
    const router = await viem.deployContract('IncentifiV4Router', [POOL_MANAGER, foundAddress!, factory.address]);
    console.log('IncentifiV4Router deployed at:', router.address);

    // Pull the hook's own economic constants from its real, deployed getters rather
    // than re-transcribing magic numbers into this test — if the contract's
    // constants ever change, this test's expectations move with them automatically.
    const VIRTUAL_ETH = await hookContract.read.VIRTUAL_ETH();
    const VIRTUAL_TOKEN = await hookContract.read.VIRTUAL_TOKEN();
    const INVARIANT_K = await hookContract.read.INVARIANT_K();

    function computeBuy(grossEth: bigint, realEthReserve: bigint, realTokenReserve: bigint) {
      const creatorFee = grossEth / 100n;
      const lossPoolFee = grossEth / 100n;
      const netEth = grossEth - creatorFee - lossPoolFee;
      const newEth = VIRTUAL_ETH + realEthReserve + netEth;
      const tokensOut = (VIRTUAL_TOKEN + realTokenReserve) - (INVARIANT_K / newEth);
      return { creatorFee, lossPoolFee, netEth, tokensOut };
    }
    function computeSell(tokensIn: bigint, realEthReserve: bigint, realTokenReserve: bigint) {
      const currentEth = VIRTUAL_ETH + realEthReserve;
      const currentToken = VIRTUAL_TOKEN + realTokenReserve;
      const newToken = currentToken + tokensIn;
      const newEth = INVARIANT_K / newToken;
      const grossEthOut = currentEth - newEth;
      const creatorFee = grossEthOut / 100n;
      const lossPoolFee = grossEthOut / 100n;
      const netEthOut = grossEthOut - creatorFee - lossPoolFee;
      return { creatorFee, lossPoolFee, grossEthOut, netEthOut };
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const lossRewardPoolContract = await viem.getContractAt('LossRewardPool', LOSS_REWARD_POOL);

    // --- REAL BUY ---
    console.log('\n--- Real buy through IncentifiV4Router ---');
    const [, , buyerWallet] = await viem.getWalletClients();
    const buyerAddress = getAddress(buyerWallet.account.address);
    const grossEthBuy = parseEther('0.1');

    const stateBeforeBuy = await hookContract.read.curveStates([poolId]);
    const expectedBuy = computeBuy(grossEthBuy, stateBeforeBuy[4] as bigint, stateBeforeBuy[5] as bigint);
    console.log('Expected: creatorFee=', expectedBuy.creatorFee.toString(), 'lossPoolFee=', expectedBuy.lossPoolFee.toString(), 'tokensOut=', expectedBuy.tokensOut.toString());

    const buyerTokenBalBefore = await token.read.balanceOf([buyerAddress]);
    const hookEthBalBefore = await publicClient.getBalance({ address: foundAddress! });
    const lossPoolEthBalBefore = await publicClient.getBalance({ address: LOSS_REWARD_POOL });
    const lossPoolDepositedBefore = await lossRewardPoolContract.read.totalDeposited([token.address]);
    const creatorClaimableBefore = await hookContract.read.creatorBalances([creatorAddress]);
    const slot0BeforeBuy = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });

    const buyHash = await router.write.buyToken([token.address, 0n, deadline], { value: grossEthBuy, account: buyerWallet.account });
    const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
    console.log('buyToken() tx hash:', buyHash);
    console.log('Block:', buyReceipt.blockNumber.toString());
    console.log('Gas used:', buyReceipt.gasUsed.toString());
    console.log('Status:', buyReceipt.status);
    console.log('Log count:', buyReceipt.logs.length);
    assert.equal(buyReceipt.status, 'success', 'buyToken() — unlock() -> swap() -> beforeSwap -> settle/take — must succeed as one atomic transaction; PoolManager itself would revert this if any currency delta were left unsettled');

    console.log('\n--- Buy: independent verification ---');
    const buyerTokenBalAfter = await token.read.balanceOf([buyerAddress]);
    const tokensReceived = (buyerTokenBalAfter as bigint) - (buyerTokenBalBefore as bigint);
    console.log('Buyer real token balance delta:', tokensReceived.toString(), 'vs expected:', expectedBuy.tokensOut.toString());
    assert.equal(tokensReceived, expectedBuy.tokensOut, 'buyer must receive exactly the tokensOut computed by the curve formula, measured via a real ERC20 balanceOf delta, not the router\'s return value or an event');

    const hookEthBalAfterBuy = await publicClient.getBalance({ address: foundAddress! });
    const hookEthDeltaBuy = hookEthBalAfterBuy - hookEthBalBefore;
    const expectedHookEthDeltaBuy = grossEthBuy - expectedBuy.lossPoolFee; // gross minus what left for LossRewardPool (netEth + creatorFee stay in the hook)
    console.log('Hook real ETH balance delta:', hookEthDeltaBuy.toString(), 'vs expected (netEth+creatorFee):', expectedHookEthDeltaBuy.toString());
    assert.equal(hookEthDeltaBuy, expectedHookEthDeltaBuy, 'hook\'s own real ETH balance must grow by exactly grossEth minus the portion forwarded to LossRewardPool');

    const lossPoolEthBalAfterBuy = await publicClient.getBalance({ address: LOSS_REWARD_POOL });
    const lossPoolEthDeltaBuy = lossPoolEthBalAfterBuy - lossPoolEthBalBefore;
    console.log('LossRewardPool real ETH balance delta:', lossPoolEthDeltaBuy.toString(), 'vs expected lossPoolFee:', expectedBuy.lossPoolFee.toString());
    assert.equal(lossPoolEthDeltaBuy, expectedBuy.lossPoolFee, 'LossRewardPool\'s own real ETH balance (not our bookkeeping) must have grown by exactly the 1% loss-pool fee');

    const lossPoolDepositedAfterBuy = await lossRewardPoolContract.read.totalDeposited([token.address]);
    const lossPoolDepositedDeltaBuy = (lossPoolDepositedAfterBuy as bigint) - (lossPoolDepositedBefore as bigint);
    console.log('LossRewardPool.totalDeposited(token) delta:', lossPoolDepositedDeltaBuy.toString(), 'vs expected:', expectedBuy.lossPoolFee.toString());
    assert.equal(lossPoolDepositedDeltaBuy, expectedBuy.lossPoolFee, 'LossRewardPool\'s own totalDeposited(token) mapping — external state we do not control — must reflect the real depositReward() call exactly');

    const creatorClaimableAfterBuy = await hookContract.read.creatorBalances([creatorAddress]);
    const creatorClaimableDeltaBuy = (creatorClaimableAfterBuy as bigint) - (creatorClaimableBefore as bigint);
    console.log('hook.creatorBalances(creator) delta:', creatorClaimableDeltaBuy.toString(), 'vs expected creatorFee:', expectedBuy.creatorFee.toString());
    assert.equal(creatorClaimableDeltaBuy, expectedBuy.creatorFee, 'creator\'s claimable balance must have grown by exactly the 1% creator fee');

    const curveStateAfterBuy = await hookContract.read.curveStates([poolId]);
    assert.equal(curveStateAfterBuy[4], (stateBeforeBuy[4] as bigint) + expectedBuy.netEth, 'realEthReserve must track netEth exactly');
    assert.equal(curveStateAfterBuy[5], (stateBeforeBuy[5] as bigint) - expectedBuy.tokensOut, 'realTokenReserve must decrease by exactly tokensOut');

    // Independent, slightly counter-intuitive check: because the hook fully absorbs
    // the swap via custom accounting (hookDeltaSpecified cancels 100% of
    // amountSpecified) and the core pool has zero real liquidity (beforeAddLiquidity
    // blocks all LPs forever), the CORE POOL's own internal price (as reported by
    // StateView, a completely separate contract) must NOT move on a swap — only
    // PoolManager.initialize() ever sets it. If this ever changes, the "full
    // absorption" design assumption documented in the hook has been violated.
    const slot0AfterBuy = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
    console.log('StateView sqrtPriceX96 before buy:', slot0BeforeBuy[0].toString(), '| after buy:', slot0AfterBuy[0].toString(), '(expected: unchanged — core pool has no real liquidity to move)');
    assert.equal(slot0AfterBuy[0], slot0BeforeBuy[0], 'the core pool\'s own price must not move on a fully-hook-absorbed swap — confirms the custom-accounting design is behaving as documented, not silently falling back to real AMM liquidity that does not exist');

    console.log('--- BUY VERIFIED: real receipts + independent balance/state checks all match the expected 1%/1% fee split ---');

    // --- REAL SELL ---
    console.log('\n--- Real sell through IncentifiV4Router ---');
    const tokenAmountToSell = tokensReceived / 2n; // sell half of what was just bought
    const stateBeforeSell = await hookContract.read.curveStates([poolId]);
    const expectedSell = computeSell(tokenAmountToSell, stateBeforeSell[4] as bigint, stateBeforeSell[5] as bigint);
    console.log('Expected: creatorFee=', expectedSell.creatorFee.toString(), 'lossPoolFee=', expectedSell.lossPoolFee.toString(), 'netEthOut=', expectedSell.netEthOut.toString());

    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([router.address, tokenAmountToSell], { account: buyerWallet.account }),
    });
    console.log('Seller approved router for', tokenAmountToSell.toString(), 'tokens.');

    const sellerEthBalBefore = await publicClient.getBalance({ address: buyerAddress });
    const sellerTokenBalBefore = await token.read.balanceOf([buyerAddress]);
    const hookEthBalBeforeSell = await publicClient.getBalance({ address: foundAddress! });
    const lossPoolEthBalBeforeSell = await publicClient.getBalance({ address: LOSS_REWARD_POOL });
    const lossPoolDepositedBeforeSell = await lossRewardPoolContract.read.totalDeposited([token.address]);
    const creatorClaimableBeforeSell = await hookContract.read.creatorBalances([creatorAddress]);

    const sellHash = await router.write.sellToken([token.address, tokenAmountToSell, 0n, deadline], { account: buyerWallet.account });
    const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellHash });
    console.log('sellToken() tx hash:', sellHash);
    console.log('Block:', sellReceipt.blockNumber.toString());
    console.log('Gas used:', sellReceipt.gasUsed.toString());
    console.log('Status:', sellReceipt.status);
    assert.equal(sellReceipt.status, 'success', 'sellToken() — unlock() -> swap() -> beforeSwap -> settle/take — must succeed as one atomic transaction');

    console.log('\n--- Sell: independent verification ---');
    const sellerTokenBalAfter = await token.read.balanceOf([buyerAddress]);
    const tokensSpent = (sellerTokenBalBefore as bigint) - (sellerTokenBalAfter as bigint);
    console.log('Seller real token balance delta:', tokensSpent.toString(), 'vs expected:', tokenAmountToSell.toString());
    assert.equal(tokensSpent, tokenAmountToSell, 'seller must have parted with exactly tokenAmountToSell, measured via a real ERC20 balanceOf delta');

    const sellerEthBalAfter = await publicClient.getBalance({ address: buyerAddress });
    const effectiveGasPrice = sellReceipt.effectiveGasPrice;
    const gasCost = sellReceipt.gasUsed * effectiveGasPrice;
    const sellerEthDeltaNetOfGas = sellerEthBalAfter - sellerEthBalBefore + gasCost;
    console.log('Seller real ETH balance delta (net of its own tx gas):', sellerEthDeltaNetOfGas.toString(), 'vs expected netEthOut:', expectedSell.netEthOut.toString());
    assert.equal(sellerEthDeltaNetOfGas, expectedSell.netEthOut, 'seller must receive exactly netEthOut in real ETH, net of the gas the seller\'s own transaction spent');

    const hookEthBalAfterSell = await publicClient.getBalance({ address: foundAddress! });
    const hookEthDeltaSell = hookEthBalBeforeSell - hookEthBalAfterSell; // hook pays out on a sell
    // netEthOut leaves to PoolManager (for the seller's take()) and lossPoolFee
    // leaves to LossRewardPool; creatorFee stays inside the hook as a claimable
    // ledger balance, so the real outflow is grossEthOut minus creatorFee (which
    // equals netEthOut + lossPoolFee).
    const expectedHookEthDeltaSell = expectedSell.grossEthOut - expectedSell.creatorFee;
    console.log('Hook real ETH balance decrease:', hookEthDeltaSell.toString(), 'vs expected (netEthOut+lossPoolFee):', expectedHookEthDeltaSell.toString());
    assert.equal(hookEthDeltaSell, expectedHookEthDeltaSell, 'hook\'s own real ETH balance must shrink by exactly netEthOut plus lossPoolFee — creatorFee stays inside as a claimable ledger balance rather than leaving the contract');

    const lossPoolEthBalAfterSell = await publicClient.getBalance({ address: LOSS_REWARD_POOL });
    const lossPoolEthDeltaSell = lossPoolEthBalAfterSell - lossPoolEthBalBeforeSell;
    console.log('LossRewardPool real ETH balance delta:', lossPoolEthDeltaSell.toString(), 'vs expected lossPoolFee:', expectedSell.lossPoolFee.toString());
    assert.equal(lossPoolEthDeltaSell, expectedSell.lossPoolFee, 'LossRewardPool\'s own real ETH balance must have grown by exactly the sell\'s 1% loss-pool fee');

    const lossPoolDepositedAfterSell = await lossRewardPoolContract.read.totalDeposited([token.address]);
    const lossPoolDepositedDeltaSell = (lossPoolDepositedAfterSell as bigint) - (lossPoolDepositedBeforeSell as bigint);
    console.log('LossRewardPool.totalDeposited(token) delta:', lossPoolDepositedDeltaSell.toString(), 'vs expected:', expectedSell.lossPoolFee.toString());
    assert.equal(lossPoolDepositedDeltaSell, expectedSell.lossPoolFee, 'LossRewardPool\'s own external totalDeposited(token) mapping must reflect the sell\'s real depositReward() call exactly');

    const creatorClaimableAfterSell = await hookContract.read.creatorBalances([creatorAddress]);
    const creatorClaimableDeltaSell = (creatorClaimableAfterSell as bigint) - (creatorClaimableBeforeSell as bigint);
    console.log('hook.creatorBalances(creator) delta:', creatorClaimableDeltaSell.toString(), 'vs expected creatorFee:', expectedSell.creatorFee.toString());
    assert.equal(creatorClaimableDeltaSell, expectedSell.creatorFee, 'creator\'s claimable balance must have grown by exactly the sell\'s 1% creator fee');

    const slot0AfterSell = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
    assert.equal(slot0AfterSell[0], slot0BeforeBuy[0], 'the core pool\'s own price must still not have moved after a second, fully-hook-absorbed swap');

    console.log('--- SELL VERIFIED: real receipts + independent balance/state checks all match the expected 1%/1% fee split ---');

    // --- Creator actually claims, proving the balance is genuinely withdrawable ---
    console.log('\n--- Creator claim: proving the fee is genuinely withdrawable, not just an internal ledger entry ---');
    const totalCreatorClaimable = await hookContract.read.creatorBalances([creatorAddress]);
    console.log('Total claimable by creator:', totalCreatorClaimable.toString(), '(= buy creatorFee + sell creatorFee =', (expectedBuy.creatorFee + expectedSell.creatorFee).toString(), ')');
    assert.equal(totalCreatorClaimable, expectedBuy.creatorFee + expectedSell.creatorFee);

    const creatorEthBalBeforeClaim = await publicClient.getBalance({ address: creatorAddress });
    const claimHash = await hookContract.write.claimCreatorFees({ account: creatorWallet.account });
    const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimHash });
    console.log('claimCreatorFees() tx hash:', claimHash);
    console.log('Gas used:', claimReceipt.gasUsed.toString());
    console.log('Status:', claimReceipt.status);
    assert.equal(claimReceipt.status, 'success');

    const creatorEthBalAfterClaim = await publicClient.getBalance({ address: creatorAddress });
    const claimGasCost = claimReceipt.gasUsed * claimReceipt.effectiveGasPrice;
    const creatorEthDeltaNetOfGas = creatorEthBalAfterClaim - creatorEthBalBeforeClaim + claimGasCost;
    console.log('Creator real ETH balance delta (net of its own claim-tx gas):', creatorEthDeltaNetOfGas.toString());
    assert.equal(creatorEthDeltaNetOfGas, totalCreatorClaimable, 'creator\'s real EOA ETH balance must increase by exactly the claimed amount, net of the claim transaction\'s own gas — proving the fee is genuinely withdrawable cash, not just a mapping value');

    const creatorClaimableAfterClaim = await hookContract.read.creatorBalances([creatorAddress]);
    assert.equal(creatorClaimableAfterClaim, 0n, 'claimable balance must be zeroed after claiming (pull-payment pattern)');

    console.log('\n--- STAGE 3 RESULT: real buy and real sell both executed through IncentifiV4Router via the genuine unlock -> swap -> hook.beforeSwap -> settle/take chain. The 1%/1% fee split was verified against LossRewardPool\'s own real ETH balance and its own totalDeposited(token) mapping (external, unmodified production state — not our bookkeeping), and the creator fee was actually claimed and confirmed via a real EOA balance delta. No reference to IncentifiBondingCurve exists anywhere in the router\'s source. NOT yet proven: graduation (still a stub — see _graduate()), the sell-side clamp/refund equivalent (sells don\'t need one), and behavior once GRADUATION_ETH_TARGET is actually reached. ---');

    // ========================================================================
    // STAGE 4: previously-deferred router hardening checks — deadline and
    // slippage revert paths — proven now, pre-graduation, while the router is
    // still willing to operate on this pool at all.
    // ========================================================================
    console.log('\n--- Router hardening: deadline and slippage revert paths ---');
    const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600);
    let expiredReverted = false;
    try {
      await router.write.buyToken([token.address, 0n, pastDeadline], { value: parseEther('0.001'), account: buyerWallet.account });
    } catch {
      expiredReverted = true;
    }
    assert.ok(expiredReverted, 'buyToken() with a deadline in the past must revert (Expired)');
    console.log('Confirmed: buyToken() with an expired deadline reverts.');

    let buySlippageReverted = false;
    try {
      await router.write.buyToken([token.address, TOTAL_SUPPLY, deadline], { value: parseEther('0.001'), account: buyerWallet.account });
    } catch {
      buySlippageReverted = true;
    }
    assert.ok(buySlippageReverted, 'buyToken() with an impossibly high minTokensOut must revert (SlippageExceeded)');
    console.log('Confirmed: buyToken() with an impossible minTokensOut reverts.');

    const dustTokenBalance = await token.read.balanceOf([buyerAddress]);
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([router.address, dustTokenBalance], { account: buyerWallet.account }),
    });
    let sellSlippageReverted = false;
    try {
      await router.write.sellToken([token.address, dustTokenBalance, parseEther('1000'), deadline], { account: buyerWallet.account });
    } catch {
      sellSlippageReverted = true;
    }
    assert.ok(sellSlippageReverted, 'sellToken() with an impossibly high minEthOut must revert (SlippageExceeded)');
    console.log('Confirmed: sellToken() with an impossible minEthOut reverts.');

    // ========================================================================
    // STAGE 5: a raw, non-router caller hitting the pool directly, PRE-graduation
    // — GenericV4Bot has zero Incentifi-specific knowledge (see its own header
    // comment) and still successfully trades against the curve via
    // PoolManager.unlock()/swap() alone, proving there is no hidden dependency
    // on IncentifiV4Router for ordinary trading to work.
    // ========================================================================
    console.log('\n--- Generic bot (zero Incentifi-specific code), PRE-graduation ---');
    const bot = await viem.deployContract('GenericV4Bot', [POOL_MANAGER]);
    console.log('GenericV4Bot deployed at:', bot.address);
    const poolKeyStruct = await factory.read.getPoolKey([token.address]);

    const [, , , botTraderWallet] = await viem.getWalletClients();
    const botTraderAddress = getAddress(botTraderWallet.account.address);
    const preGradStateBefore = await hookContract.read.curveStates([poolId]);
    const preGradBotBuyEth = parseEther('0.01');
    const expectedPreGradBotBuy = computeBuy(preGradBotBuyEth, preGradStateBefore[4] as bigint, preGradStateBefore[5] as bigint);

    const botTokenBalBefore = await token.read.balanceOf([botTraderAddress]);
    const preGradBotHash = await bot.write.swap([poolKeyStruct, true, preGradBotBuyEth, 0n], { value: preGradBotBuyEth, account: botTraderWallet.account });
    const preGradBotReceipt = await publicClient.waitForTransactionReceipt({ hash: preGradBotHash });
    assert.equal(preGradBotReceipt.status, 'success', 'a raw, non-router caller must be able to buy directly against the curve pre-graduation');
    const botTokenBalAfter = await token.read.balanceOf([botTraderAddress]);
    console.log('Generic bot pre-graduation buy tx:', preGradBotHash, '| tokens received:', (botTokenBalAfter - botTokenBalBefore).toString(), 'vs expected:', expectedPreGradBotBuy.tokensOut.toString());
    assert.equal(botTokenBalAfter - botTokenBalBefore, expectedPreGradBotBuy.tokensOut, 'generic bot must receive exactly the curve-formula tokensOut, with zero Incentifi-specific code involved');
    console.log('Confirmed: a raw PoolManager.unlock()/swap() caller with no Incentifi-specific knowledge can trade the curve directly.');

    // ========================================================================
    // STAGE 6: drive real buys up to the graduation boundary, exercising the
    // router's clamp+refund logic on the boundary-crossing buy, then prove the
    // real V4 liquidity deposit and the resulting price correction — the part
    // that actually answers whether _graduate() works.
    // ========================================================================
    console.log('\n--- Driving to the graduation boundary ---');
    const graduationTarget = await hookContract.read.GRADUATION_ETH_TARGET();
    const preGradState = await hookContract.read.curveStates([poolId]);
    const realEthReserveBeforeGrad = preGradState[4] as bigint;
    const maxNetEth = graduationTarget - realEthReserveBeforeGrad;
    const maxGrossEth = 100n * (maxNetEth / 98n) + (maxNetEth % 98n);
    const overshootGrossEth = maxGrossEth * 3n; // deliberately oversized, to force the clamp+refund path
    console.log('realEthReserve before graduating buy:', realEthReserveBeforeGrad.toString());
    console.log('GRADUATION_ETH_TARGET:', graduationTarget.toString());
    console.log('Exact clamp target (maxGrossEth):', maxGrossEth.toString());
    console.log('Deliberately overshooting buy (3x maxGrossEth):', overshootGrossEth.toString());

    const [, , , , graduatingBuyerWallet] = await viem.getWalletClients();
    const graduatingBuyerAddress = getAddress(graduatingBuyerWallet.account.address);
    const graduatingBuyerEthBefore = await publicClient.getBalance({ address: graduatingBuyerAddress });

    const gradHash = await router.write.buyToken([token.address, 0n, deadline], { value: overshootGrossEth, account: graduatingBuyerWallet.account });
    const gradReceipt = await publicClient.waitForTransactionReceipt({ hash: gradHash });
    console.log('Graduating buyToken() tx hash:', gradHash);
    console.log('Block:', gradReceipt.blockNumber.toString());
    console.log('Gas used:', gradReceipt.gasUsed.toString());
    console.log('Status:', gradReceipt.status);
    assert.equal(gradReceipt.status, 'success', 'the boundary-crossing buy, including the real liquidity deposit inside _graduate(), must succeed as one atomic transaction');

    console.log('\n--- Clamp/refund verification ---');
    const graduatingBuyerEthAfter = await publicClient.getBalance({ address: graduatingBuyerAddress });
    const gradGasCost = gradReceipt.gasUsed * gradReceipt.effectiveGasPrice;
    const graduatingBuyerNetOutflow = graduatingBuyerEthBefore - graduatingBuyerEthAfter - gradGasCost;
    console.log('Buyer real net ETH outflow (excl. own gas):', graduatingBuyerNetOutflow.toString(), 'vs exact clamp target:', maxGrossEth.toString(), '(sent', overshootGrossEth.toString(), ')');
    assert.equal(graduatingBuyerNetOutflow, maxGrossEth, 'even though the buyer sent 3x the needed amount, their real net ETH outflow must be exactly the clamped amount — proving the excess was genuinely refunded, not merely computed');

    console.log('\n--- Graduation state verification ---');
    const postGradState = await hookContract.read.curveStates([poolId]);
    console.log('curveStates(poolId) after:', {
      graduated: postGradState[3],
      realEthReserve: postGradState[4].toString(),
      realTokenReserve: postGradState[5].toString(),
    });
    assert.equal(postGradState[3], true, 'state.graduated must now be true');
    assert.equal(postGradState[4], graduationTarget, 'realEthReserve must land EXACTLY on GRADUATION_ETH_TARGET — proof the clamp math is exact, not approximate');

    console.log('\n--- Real liquidity deposit verification ---');
    const gradLogs = await publicClient.getContractEvents({
      address: foundAddress!,
      abi: hookArtifact.abi,
      eventName: 'GraduationLiquidityDeployed',
      fromBlock: gradReceipt.blockNumber,
      toBlock: gradReceipt.blockNumber,
    });
    assert.equal(gradLogs.length, 1, 'exactly one GraduationLiquidityDeployed event must be emitted');
    const gradEvent = gradLogs[0].args as {
      bootstrapLiquidity: bigint; finalLiquidity: bigint; correctedSqrtPriceX96: bigint; ethDust: bigint; tokenDust: bigint;
    };
    console.log('GraduationLiquidityDeployed:', {
      bootstrapLiquidity: gradEvent.bootstrapLiquidity.toString(),
      finalLiquidity: gradEvent.finalLiquidity.toString(),
      correctedSqrtPriceX96: gradEvent.correctedSqrtPriceX96.toString(),
      ethDust: gradEvent.ethDust.toString(),
      tokenDust: gradEvent.tokenDust.toString(),
    });
    assert.ok(gradEvent.bootstrapLiquidity > 0n, 'bootstrap liquidity must be real and nonzero');
    assert.ok(gradEvent.finalLiquidity > 0n, 'final liquidity must be real and nonzero');

    // THE key independent checks: ask StateView (a real, separate, unmodified
    // Uniswap contract) what the pool's ACTUAL on-chain price and liquidity are
    // now — it has no reason to agree with our own hook's event unless
    // modifyLiquidity()/swap() genuinely executed as described.
    const slot0PostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
    const liquidityPostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] });
    console.log('StateView.getSlot0(poolId).sqrtPriceX96 (real, independent):', slot0PostGrad[0].toString());
    console.log('StateView.getLiquidity(poolId) (real, independent):', liquidityPostGrad.toString());
    console.log('Launch price (for comparison):', (await hookContract.read.launchSqrtPriceX96()).toString());

    assert.equal(slot0PostGrad[0], gradEvent.correctedSqrtPriceX96, 'StateView\'s real, independently-read price must exactly match the hook\'s own reported corrected price');
    assert.notEqual(slot0PostGrad[0], await hookContract.read.launchSqrtPriceX96(), 'the pool\'s real on-chain price must have actually moved away from the stale launch price — the whole point of the corrective swap');
    assert.ok((slot0PostGrad[0] as bigint) < (await hookContract.read.launchSqrtPriceX96()), 'price must have moved DOWN (fewer tokens per ETH), matching this curve\'s known price direction');
    assert.equal(liquidityPostGrad, gradEvent.bootstrapLiquidity + gradEvent.finalLiquidity, 'StateView\'s real, independently-read liquidity must equal the sum of both minted positions (same salt => merged into one position)');
    assert.ok((liquidityPostGrad as bigint) > 0n, 'the pool must now carry real, nonzero, independently-confirmed liquidity — it had none before graduation');

    console.log('\n--- Dust tracking: storage mappings, not just the event ---');
    const ethDustStored = await hookContract.read.ethDustBalances([poolId]);
    const tokenDustStored = await hookContract.read.tokenDustBalances([poolId]);
    console.log('hook.ethDustBalances(poolId):', ethDustStored.toString(), 'vs event ethDust:', gradEvent.ethDust.toString());
    console.log('hook.tokenDustBalances(poolId):', tokenDustStored.toString(), 'vs event tokenDust:', gradEvent.tokenDust.toString());
    assert.equal(ethDustStored, gradEvent.ethDust, 'ethDustBalances(poolId) must be written to storage, not just emitted');
    assert.equal(tokenDustStored, gradEvent.tokenDust, 'tokenDustBalances(poolId) must be written to storage, not just emitted');

    // Independent cross-check #1: post-graduation, nothing else ever touches this
    // token's balance on the hook again (confirmed structurally by the graduated
    // pass-through in _beforeSwap) — so the token's OWN real ERC20 balanceOf(hook)
    // must equal tokenDustBalances(poolId) exactly, verified against the token
    // contract directly, not our own hook's bookkeeping.
    const hookTokenBalancePostGrad = await token.read.balanceOf([foundAddress!]);
    console.log('Real token.balanceOf(hook) post-graduation:', hookTokenBalancePostGrad.toString(), '(must equal tokenDustBalances exactly)');
    assert.equal(hookTokenBalancePostGrad, tokenDustStored, 'the token\'s own real balanceOf(hook) must equal tokenDustBalances(poolId) exactly — proof there is nothing else unaccounted-for sitting in that token\'s balance');

    // Independent cross-check #2: unlike token dust, native ETH is one pooled
    // balance shared with creatorBalances — this is exactly the risk flagged when
    // the mappings were proposed. In THIS test's specific setup (one creator, one
    // graduated token, no other pending claims), the hook's total real ETH
    // balance should equal ethDustBalances(poolId) plus that creator's current
    // claimable balance, with nothing left over. This does NOT generalize to a
    // hook serving many creators/tokens simultaneously — it's a sanity check on
    // this run's specific numbers, not a claim that the two ledgers can always be
    // reconciled this cleanly against a raw contract balance.
    const hookEthBalanceFinal = await publicClient.getBalance({ address: foundAddress! });
    const creatorClaimableFinal = await hookContract.read.creatorBalances([creatorAddress]);
    console.log('Hook real ETH balance:', hookEthBalanceFinal.toString(), '= ethDustBalances (', ethDustStored.toString(), ') + creatorBalances[creator] (', creatorClaimableFinal.toString(), ')?');
    assert.equal(hookEthBalanceFinal, ethDustStored + creatorClaimableFinal, 'in this single-creator/single-token test, the hook\'s total real ETH balance must decompose exactly into ethDustBalances + the one creator\'s claimable balance, with nothing unaccounted for');

    console.log('\n--- Router refuses further curve-style trading post-graduation ---');
    let postGradRouterReverted = false;
    try {
      await router.write.buyToken([token.address, 0n, deadline], { value: parseEther('0.001'), account: buyerWallet.account });
    } catch {
      postGradRouterReverted = true;
    }
    assert.ok(postGradRouterReverted, 'IncentifiV4Router.buyToken() must refuse to operate on an already-graduated pool (PoolGraduated)');
    console.log('Confirmed: router refuses to buy against a graduated pool.');

    console.log('\n--- STAGE 6 RESULT: the pool transitioned from 100% custom-accounting absorption to genuine, real, independently-verified AMM-backed liquidity. The boundary-crossing buy\'s clamp+refund landed realEthReserve EXACTLY on GRADUATION_ETH_TARGET, real liquidity was minted via two real modifyLiquidity() calls bridged by one real corrective swap, and StateView (unmodified, independent) confirms both the price moved to the intended corrected value and real liquidity now backs the pool. Honest gap, reported not hidden: ethDust/tokenDust above show a small leftover from the bonding curve\'s virtual-reserve ratio not matching the real AMM\'s marginal-price ratio exactly. ---');

    // ========================================================================
    // STAGE 7: the same generic, zero-Incentifi-knowledge bot, now POST-
    // graduation — this time trading against REAL concentrated liquidity via
    // the core AMM, not hook absorption. The independent proof that the
    // transition actually changed how trades execute, not just an internal flag.
    // ========================================================================
    console.log('\n--- Generic bot (zero Incentifi-specific code), POST-graduation ---');
    const sqrtPriceBeforeBotSwap = (await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] }))[0];

    const botEthBalBefore = await publicClient.getBalance({ address: botTraderAddress });
    const botTokenBalBeforePostGrad = await token.read.balanceOf([botTraderAddress]);
    const postGradBuyEth = parseEther('0.01');
    const postGradBotBuyHash = await bot.write.swap([poolKeyStruct, true, postGradBuyEth, 0n], { value: postGradBuyEth, account: botTraderWallet.account });
    const postGradBotBuyReceipt = await publicClient.waitForTransactionReceipt({ hash: postGradBotBuyHash });
    assert.equal(postGradBotBuyReceipt.status, 'success', 'a raw, non-router caller must be able to buy directly against the REAL AMM post-graduation');
    const botTokenBalAfterPostGrad = await token.read.balanceOf([botTraderAddress]);
    const postGradTokensReceived = botTokenBalAfterPostGrad - botTokenBalBeforePostGrad;
    console.log('Generic bot post-graduation buy tx:', postGradBotBuyHash, '| tokens received from REAL AMM liquidity:', postGradTokensReceived.toString());
    assert.ok(postGradTokensReceived > 0n, 'generic bot must receive a real, positive amount of tokens from the real AMM pool');

    const sqrtPriceAfterBotSwap = (await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] }))[0];
    console.log('StateView sqrtPriceX96 before this swap:', sqrtPriceBeforeBotSwap.toString(), '| after:', sqrtPriceAfterBotSwap.toString());
    assert.notEqual(sqrtPriceAfterBotSwap, sqrtPriceBeforeBotSwap, 'post-graduation, a real swap against real liquidity MUST move the pool\'s own tracked price — the opposite of the pre-graduation behavior confirmed in Stage 3, and independent proof the pool is now a genuine AMM rather than still being hook-absorbed');

    // Sell back through the same generic bot, completing the round trip entirely
    // through real AMM liquidity with zero Incentifi-specific code.
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([bot.address, postGradTokensReceived], { account: botTraderWallet.account }),
    });
    const botEthBalBeforeSell = await publicClient.getBalance({ address: botTraderAddress });
    const postGradSellHash = await bot.write.swap([poolKeyStruct, false, postGradTokensReceived, 0n], { account: botTraderWallet.account });
    const postGradSellReceipt = await publicClient.waitForTransactionReceipt({ hash: postGradSellHash });
    assert.equal(postGradSellReceipt.status, 'success', 'a raw, non-router caller must be able to sell directly against the REAL AMM post-graduation');
    const botEthBalAfterSell = await publicClient.getBalance({ address: botTraderAddress });
    const sellGasCost = postGradSellReceipt.gasUsed * postGradSellReceipt.effectiveGasPrice;
    const botEthReceivedFromSell = botEthBalAfterSell - botEthBalBeforeSell + sellGasCost;
    console.log('Generic bot post-graduation sell tx:', postGradSellHash, '| real ETH received from REAL AMM liquidity (net of gas):', botEthReceivedFromSell.toString());
    assert.ok(botEthReceivedFromSell > 0n, 'generic bot must receive a real, positive amount of ETH from the real AMM pool on the sell side too');
    void botEthBalBefore; // (recorded above for narration; the buy-side ETH cost isn't asserted precisely since real AMM slippage/fees make it path-dependent, unlike the curve's closed-form math)

    console.log('\n--- STAGE 7 RESULT: a generic, zero-Incentifi-knowledge caller successfully bought AND sold directly against the graduated pool\'s real AMM liquidity, with the pool\'s own tracked price genuinely moving on each trade (independently confirmed via StateView) — the clearest possible proof that trading has genuinely transitioned from hook-absorbed custom accounting to real, permissionless, liquidity-backed AMM execution. ---');

    // ========================================================================
    // STAGE 8: double-graduation guard. Fund-safety-critical: if _graduate()
    // could ever fire a second time for the same pool, it would attempt to mint
    // MORE real liquidity using reserve numbers that no longer mean what they
    // meant the first time (state.realEthReserve/realTokenReserve are meant to
    // be a one-time, final snapshot), a real double-spend/corruption risk.
    // ========================================================================
    console.log('\n--- Double-graduation guard ---');

    // The Stage 7 swaps above ALREADY constitute an attempt: post-graduation,
    // every swap re-enters _beforeSwap, and if the graduated short-circuit ever
    // failed to short-circuit, _executeBuy's `>= GRADUATION_ETH_TARGET &&
    // !state.graduated` check is the only other thing standing between a swap
    // and a second _graduate() call. Verify directly, after those swaps, that
    // none of this happened.
    const gradLogsAll = await publicClient.getContractEvents({
      address: foundAddress!,
      abi: hookArtifact.abi,
      eventName: 'GraduationLiquidityDeployed',
      fromBlock: receipt.blockNumber, // hook's own deployment block (Stage 1) — the earliest block this event could possibly exist
      toBlock: 'latest',
    });
    console.log('Total GraduationLiquidityDeployed events for this hook, ever (deployment through the Stage 7 swaps):', gradLogsAll.length);
    assert.equal(gradLogsAll.length, 1, '_graduate() must have fired EXACTLY once across the hook\'s entire history, despite multiple post-graduation swaps having since occurred');

    const curveStateAfterPostGradSwaps = await hookContract.read.curveStates([poolId]);
    console.log('curveStates(poolId) after Stage 7\'s post-graduation swaps:', {
      realEthReserve: curveStateAfterPostGradSwaps[4].toString(),
      realTokenReserve: curveStateAfterPostGradSwaps[5].toString(),
    });
    assert.equal(curveStateAfterPostGradSwaps[4], postGradState[4], 'realEthReserve must remain frozen at its exact graduation-time value — the curve\'s own accounting must never be touched again once graduated, no matter how many real-AMM trades happen afterward');
    assert.equal(curveStateAfterPostGradSwaps[5], postGradState[5], 'realTokenReserve must remain frozen at its exact graduation-time value for the same reason');

    const ethDustAfterPostGradSwaps = await hookContract.read.ethDustBalances([poolId]);
    const tokenDustAfterPostGradSwaps = await hookContract.read.tokenDustBalances([poolId]);
    assert.equal(ethDustAfterPostGradSwaps, ethDustStored, 'ethDustBalances(poolId) must not change after graduation — a second _graduate() run would have overwritten or added to it');
    assert.equal(tokenDustAfterPostGradSwaps, tokenDustStored, 'tokenDustBalances(poolId) must not change after graduation for the same reason');
    console.log('Confirmed: graduation state (event count, curve reserves, dust) is frozen exactly as it was the instant graduation completed — no double-graduation occurred despite further real trading.');

    console.log('\n--- STAGE 8 RESULT: exactly one GraduationLiquidityDeployed event exists across this hook\'s entire history, and every graduation-related piece of state (curveStates reserves, dust mappings) is byte-for-byte unchanged after multiple further post-graduation trades — the double-graduation guard holds under real, repeated exercise, not just by code inspection. ---');

    // ========================================================================
    // STAGE 9: multi-token/creator isolation. Fund-safety-critical: this is a
    // SHARED hook serving many tokens out of one contract's storage — if a
    // second token's launch, trades, or fees ever leaked into or read from the
    // first token's state (curveStates, creatorBalances, dust mappings), that
    // would be a real cross-token fund-safety bug, not a cosmetic one.
    // ========================================================================
    console.log('\n--- Multi-token / multi-creator isolation ---');

    // Snapshot Token A's (already graduated) state before touching Token B at
    // all, so any leakage from B's activity into A's storage is directly
    // observable by comparing against this snapshot afterward.
    const tokenACurveStateBefore = await hookContract.read.curveStates([poolId]);
    const tokenACreatorBalanceBefore = await hookContract.read.creatorBalances([creatorAddress]);
    const tokenAEthDustBefore = await hookContract.read.ethDustBalances([poolId]);
    const tokenATokenDustBefore = await hookContract.read.tokenDustBalances([poolId]);
    const tokenALossPoolDepositedBefore = await lossRewardPoolContract.read.totalDeposited([token.address]);

    const [, , , , , creatorBWallet, buyerBWallet] = await viem.getWalletClients();
    const creatorBAddress = getAddress(creatorBWallet.account.address);
    const buyerBAddress = getAddress(buyerBWallet.account.address);
    console.log('Creator B:', creatorBAddress, '| Buyer B:', buyerBAddress);

    const tokenB = await viem.deployContract('IncentifiLaunchToken', ['V4 Fork Test Token B', 'V4FORKB', TOTAL_SUPPLY], {
      client: { wallet: creatorBWallet },
    });
    console.log('Token B deployed at:', tokenB.address);
    await publicClient.waitForTransactionReceipt({
      hash: await tokenB.write.approve([factory.address, TOTAL_SUPPLY], { account: creatorBWallet.account }),
    });
    const launchBHash = await factory.write.launchToken([tokenB.address], { account: creatorBWallet.account });
    const launchBReceipt = await publicClient.waitForTransactionReceipt({ hash: launchBHash });
    console.log('Token B launchToken() tx:', launchBHash, '| status:', launchBReceipt.status);
    assert.equal(launchBReceipt.status, 'success');
    assert.equal(await factory.read.isLaunched([tokenB.address]), true, 'factory.isLaunched(tokenB) must be true');
    assert.equal(await factory.read.isLaunched([token.address]), true, 'factory.isLaunched(tokenA) must remain true — independent of tokenB\'s launch');

    const poolKeyStructB = await factory.read.getPoolKey([tokenB.address]);
    const poolIdB = keccak256(
      encodeAbiParameters(
        parseAbiParameters('address, address, uint24, int24, address'),
        [getAddress('0x0000000000000000000000000000000000000000'), getAddress(tokenB.address), 0, 200, foundAddress!]
      )
    );
    assert.notEqual(poolIdB, poolId, 'Token B must have a genuinely different PoolId from Token A');

    const curveStateB0 = await hookContract.read.curveStates([poolIdB]);
    assert.equal(getAddress(curveStateB0[0] as string), getAddress(tokenB.address));
    assert.equal(getAddress(curveStateB0[1] as string), creatorBAddress);
    assert.equal(curveStateB0[2], true, 'Token B curveStates.initialized must be true');
    assert.equal(curveStateB0[3], false, 'Token B curveStates.graduated must start false, independent of Token A\'s (already-true) graduated flag');
    assert.equal(curveStateB0[5], TOTAL_SUPPLY, 'Token B must start with its own full, independent TOTAL_SUPPLY as realTokenReserve');

    console.log('\n--- Buying and selling Token B, checking Token A is never touched ---');
    const grossEthBuyB = parseEther('0.05');
    const expectedBuyB = computeBuy(grossEthBuyB, curveStateB0[4] as bigint, curveStateB0[5] as bigint);
    const buyBHash = await router.write.buyToken([tokenB.address, 0n, deadline], { value: grossEthBuyB, account: buyerBWallet.account });
    const buyBReceipt = await publicClient.waitForTransactionReceipt({ hash: buyBHash });
    assert.equal(buyBReceipt.status, 'success', 'the SAME router must correctly handle a SECOND, independent token\'s buy');
    const buyerBTokenBal = await tokenB.read.balanceOf([buyerBAddress]);
    console.log('Token B buy tx:', buyBHash, '| buyerB tokens received:', buyerBTokenBal.toString(), 'vs expected:', expectedBuyB.tokensOut.toString());
    assert.equal(buyerBTokenBal, expectedBuyB.tokensOut, 'Token B\'s buy must follow Token B\'s OWN independent curve math, using Token B\'s own (fresh) reserves — not anything left over from Token A');

    await publicClient.waitForTransactionReceipt({
      hash: await tokenB.write.approve([router.address, buyerBTokenBal], { account: buyerBWallet.account }),
    });
    const curveStateBBeforeSell = await hookContract.read.curveStates([poolIdB]);
    const expectedSellB = computeSell(buyerBTokenBal, curveStateBBeforeSell[4] as bigint, curveStateBBeforeSell[5] as bigint);
    const sellBHash = await router.write.sellToken([tokenB.address, buyerBTokenBal, 0n, deadline], { account: buyerBWallet.account });
    const sellBReceipt = await publicClient.waitForTransactionReceipt({ hash: sellBHash });
    assert.equal(sellBReceipt.status, 'success', 'the SAME router must correctly handle a SECOND, independent token\'s sell');
    console.log('Token B sell tx:', sellBHash, '| expected netEthOut:', expectedSellB.netEthOut.toString());

    console.log('\n--- Cross-token isolation verification ---');
    const creatorBBalance = await hookContract.read.creatorBalances([creatorBAddress]);
    const expectedCreatorBTotal = expectedBuyB.creatorFee + expectedSellB.creatorFee;
    console.log('creatorBalances[creatorB]:', creatorBBalance.toString(), 'vs expected:', expectedCreatorBTotal.toString());
    assert.equal(creatorBBalance, expectedCreatorBTotal, 'Creator B\'s claimable balance must reflect ONLY Token B\'s fees');

    const creatorABalanceAfter = await hookContract.read.creatorBalances([creatorAddress]);
    console.log('creatorBalances[creatorA] before Token B activity:', tokenACreatorBalanceBefore.toString(), '| after:', creatorABalanceAfter.toString());
    assert.equal(creatorABalanceAfter, tokenACreatorBalanceBefore, 'Creator A\'s claimable balance must be COMPLETELY UNAFFECTED by any of Token B\'s trading — no cross-creator leakage');

    const tokenBLossPoolDeposited = await lossRewardPoolContract.read.totalDeposited([tokenB.address]);
    const expectedLossPoolB = expectedBuyB.lossPoolFee + expectedSellB.lossPoolFee;
    console.log('LossRewardPool.totalDeposited(tokenB):', tokenBLossPoolDeposited.toString(), 'vs expected:', expectedLossPoolB.toString());
    assert.equal(tokenBLossPoolDeposited, expectedLossPoolB, 'LossRewardPool must track Token B\'s deposited rewards completely independently of Token A\'s');

    const tokenALossPoolDepositedAfter = await lossRewardPoolContract.read.totalDeposited([token.address]);
    assert.equal(tokenALossPoolDepositedAfter, tokenALossPoolDepositedBefore, 'LossRewardPool.totalDeposited(tokenA) must be UNCHANGED by Token B\'s trading — real, external, production-contract-enforced isolation, not just our own hook\'s bookkeeping');

    const tokenACurveStateAfter = await hookContract.read.curveStates([poolId]);
    console.log('Token A curveStates before vs after Token B\'s entire launch+buy+sell:', {
      graduatedBefore: tokenACurveStateBefore[3], graduatedAfter: tokenACurveStateAfter[3],
      realEthReserveBefore: tokenACurveStateBefore[4].toString(), realEthReserveAfter: tokenACurveStateAfter[4].toString(),
      realTokenReserveBefore: tokenACurveStateBefore[5].toString(), realTokenReserveAfter: tokenACurveStateAfter[5].toString(),
    });
    assert.equal(tokenACurveStateAfter[3], tokenACurveStateBefore[3], 'Token A\'s graduated flag must be untouched by Token B\'s activity');
    assert.equal(tokenACurveStateAfter[4], tokenACurveStateBefore[4], 'Token A\'s realEthReserve must be untouched by Token B\'s activity');
    assert.equal(tokenACurveStateAfter[5], tokenACurveStateBefore[5], 'Token A\'s realTokenReserve must be untouched by Token B\'s activity');

    const tokenAEthDustAfter = await hookContract.read.ethDustBalances([poolId]);
    const tokenATokenDustAfter = await hookContract.read.tokenDustBalances([poolId]);
    assert.equal(tokenAEthDustAfter, tokenAEthDustBefore, 'Token A\'s ethDustBalances must be untouched by Token B\'s activity');
    assert.equal(tokenATokenDustAfter, tokenATokenDustBefore, 'Token A\'s tokenDustBalances must be untouched by Token B\'s activity');

    console.log('\n--- STAGE 9 RESULT: a second, independent token/creator pair was launched, bought, and sold through the SAME shared hook and the SAME router while Token A (already graduated) was live in storage — every piece of Token A\'s state (curveStates, creatorBalances, dust mappings) and Token A\'s external LossRewardPool record were verified byte-for-byte unchanged afterward, and Token B\'s own state was verified to follow its own independent curve math from a fresh starting reserve. Cross-token/cross-creator isolation holds under real, simultaneous, shared-storage exercise — not just by code inspection of the mapping keys. ---');

    // ========================================================================
    // STAGE 10: guard reverts, forced on purpose. Closing the "the require
    // exists vs. the require actually fires" gap flagged in the pre-mainnet
    // checklist.
    // ========================================================================
    console.log('\n--- Guard reverts, triggered for real ---');

    // OnlyFactory: the ONE thing standing between "any account can register
    // arbitrary pendingCreator entries" and the real system.
    let onlyFactoryReverted = false;
    try {
      await hookContract.write.registerToken([token.address, buyerAddress], { account: buyerWallet.account });
    } catch {
      onlyFactoryReverted = true;
    }
    assert.ok(onlyFactoryReverted, 'hook.registerToken() called by a non-factory account must revert (OnlyFactory)');
    console.log('Confirmed: registerToken() from a non-factory account reverts (OnlyFactory).');

    // Router's OnlyPoolManager: unlockCallback must refuse anyone but the real
    // PoolManager — otherwise anyone could fabricate a fake CallbackData and
    // have the router act on it outside of a real, accounted-for swap.
    let onlyPoolManagerReverted = false;
    try {
      await router.write.unlockCallback(['0x'], { account: buyerWallet.account });
    } catch {
      onlyPoolManagerReverted = true;
    }
    assert.ok(onlyPoolManagerReverted, 'router.unlockCallback() called by anyone other than PoolManager must revert (OnlyPoolManager)');
    console.log('Confirmed: router.unlockCallback() called directly (not by PoolManager) reverts (OnlyPoolManager).');

    // Factory's NotTokenCreator: launching someone else's token.
    let notTokenCreatorReverted = false;
    try {
      await factory.write.launchToken([tokenB.address], { account: buyerWallet.account }); // tokenB's real creator is creatorBWallet, not buyerWallet
    } catch {
      notTokenCreatorReverted = true;
    }
    assert.ok(notTokenCreatorReverted, 'factory.launchToken() called by anyone other than the token\'s own creator() must revert (NotTokenCreator)');
    console.log('Confirmed: launchToken() by a non-creator account reverts (NotTokenCreator).');

    // Factory's AlreadyLaunched: launching the same token twice.
    let alreadyLaunchedReverted = false;
    try {
      await factory.write.launchToken([token.address], { account: creatorWallet.account }); // token A, already launched in Stage 2
    } catch {
      alreadyLaunchedReverted = true;
    }
    assert.ok(alreadyLaunchedReverted, 'factory.launchToken() called twice for the same token must revert (AlreadyLaunched)');
    console.log('Confirmed: launching the same token twice reverts (AlreadyLaunched).');

    // WrongStartingPrice: this one deserves an honest note before the code.
    // Reading the real factory (contracts/v4/IncentifiV4Factory.sol) shows
    // registerToken() and poolManager.initialize() are called back-to-back in
    // the SAME atomic transaction (launchToken()) — no other transaction can
    // ever land between them. That means the exact front-running scenario the
    // guard's own doc comment describes is structurally impossible to trigger
    // via any real external call today: an attacker's initialize() attempt
    // arriving BEFORE launchToken() finds pendingCreator unset and hits
    // TokenNotRegistered first, never reaching this check at all. The
    // atomicity of the real factory is what actually closes this gap; the
    // price check is a second, independent layer behind it.
    //
    // To exercise the check ITSELF (defense-in-depth is still worth proving
    // correct even when the outer layer already makes it unreachable in
    // practice — a future factory reusing this same hook might not preserve
    // that atomicity), this impersonates the real, already-deployed factory
    // via Hardhat's test-only account impersonation to call registerToken()
    // on its own, WITHOUT the immediate correct initialize() call that always
    // follows it in real usage — a state no real transaction can actually
    // produce, constructed here deliberately to test the fallback guard.
    console.log('\n--- WrongStartingPrice (via account impersonation — see the note above on why this can\'t be reached any other way) ---');
    const testClient = await viem.getTestClient();
    await testClient.impersonateAccount({ address: factory.address });
    await testClient.setBalance({ address: factory.address, value: parseEther('10') });
    const factoryWallet = await viem.getWalletClient(factory.address);

    const [, , , , , , , creatorCWallet] = await viem.getWalletClients();
    const tokenC = await viem.deployContract('IncentifiLaunchToken', ['V4 Fork Test Token C', 'V4FORKC', TOTAL_SUPPLY], {
      client: { wallet: creatorCWallet },
    });
    await publicClient.waitForTransactionReceipt({
      hash: await tokenC.write.transfer([foundAddress!, TOTAL_SUPPLY], { account: creatorCWallet.account }),
    }); // satisfies InsufficientSupply's check ahead of the price check
    await publicClient.waitForTransactionReceipt({
      hash: await hookContract.write.registerToken([tokenC.address, creatorCWallet.account.address], { account: factoryWallet.account }),
    });
    console.log('Impersonated factory registered Token C directly, WITHOUT the immediate correct initialize() call that real usage always pairs it with.');

    const poolKeyStructC = await factory.read.getPoolKey([tokenC.address]);
    const wrongPrice = (await hookContract.read.launchSqrtPriceX96()) + 1n;
    let wrongStartingPriceReverted = false;
    try {
      await publicClient.simulateContract({
        address: POOL_MANAGER,
        abi: parseAbi(['function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) external returns (int24)']),
        functionName: 'initialize',
        args: [[poolKeyStructC.currency0, poolKeyStructC.currency1, poolKeyStructC.fee, poolKeyStructC.tickSpacing, poolKeyStructC.hooks], wrongPrice],
        account: buyerAddress,
      });
    } catch {
      wrongStartingPriceReverted = true;
    }
    assert.ok(wrongStartingPriceReverted, 'PoolManager.initialize() with any price other than launchSqrtPriceX96() must revert (WrongStartingPrice), even in the artificial state constructed above');
    console.log('Confirmed: initialize() with the wrong price reverts (WrongStartingPrice), even though no real transaction sequence can reach this state given the real factory\'s atomicity.');

    // Bonus, using the same leftover state: AlreadyPending.
    let alreadyPendingReverted = false;
    try {
      await hookContract.write.registerToken([tokenC.address, creatorCWallet.account.address], { account: factoryWallet.account });
    } catch {
      alreadyPendingReverted = true;
    }
    assert.ok(alreadyPendingReverted, 'registerToken() called twice for the same not-yet-initialized token must revert (AlreadyPending)');
    console.log('Confirmed: registering the same pending token twice reverts (AlreadyPending).');

    await testClient.stopImpersonatingAccount({ address: factory.address });

    console.log('\n--- STAGE 10 RESULT: OnlyFactory, router\'s OnlyPoolManager, factory\'s NotTokenCreator and AlreadyLaunched all forced to revert via real, ordinary external calls. WrongStartingPrice and AlreadyPending were also forced to revert, but only via account impersonation constructing a state the real factory\'s own atomicity never actually produces — reported honestly as a defense-in-depth check, not a reachable real-world attack path. ---');

    // ========================================================================
    // STAGE 11: third-party liquidity addition, post-graduation. GenericV4Bot
    // (zero Incentifi-specific knowledge, same contract used for the Stage 5/7
    // trading proofs) now adds real liquidity as a genuine external LP — proving
    // _beforeAddLiquidity's post-graduation "open to anyone" change actually
    // works for someone who isn't the hook itself, not just in code review.
    // A negative control on Token B (not yet graduated at this point) confirms
    // the SAME restriction still correctly blocks external LPs pre-graduation.
    // ========================================================================
    console.log('\n--- Third-party LP addition, POST-graduation (Token A) ---');
    const FULL_RANGE_TICK_LOWER = -887200;
    const FULL_RANGE_TICK_UPPER = 887200;
    const thirdPartyLpSalt = pad(toHex(1n), { size: 32 });

    const [, , , , , , , , thirdPartyLpWallet] = await viem.getWalletClients();
    const thirdPartyLpAddress = getAddress(thirdPartyLpWallet.account.address);

    // Acquire some real Token A first (through the same zero-knowledge bot,
    // against the real AMM) so there's something to provide as the token side.
    await publicClient.waitForTransactionReceipt({
      hash: await bot.write.swap([poolKeyStruct, true, parseEther('0.02'), 0n], { value: parseEther('0.02'), account: thirdPartyLpWallet.account }),
    });
    const lpTokenBalance = await token.read.balanceOf([thirdPartyLpAddress]);
    console.log('Third-party LP acquired', lpTokenBalance.toString(), 'Token A via the real AMM, to provide as the liquidity\'s token side.');
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([bot.address, lpTokenBalance], { account: thirdPartyLpWallet.account }),
    });

    const liquidityBeforeThirdPartyLp = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] });
    const lpLiquidityDelta = 10_000_000_000_000_000_000n; // 1e19 — a modest, real slice of the pool's ~3.5e22 existing liquidity
    const generousEth = parseEther('0.05'); // generous upper bound; unused portion must come back as a real refund

    const lpEthBefore = await publicClient.getBalance({ address: thirdPartyLpAddress });
    const lpTokenBeforeAdd = await token.read.balanceOf([thirdPartyLpAddress]);
    const addLiquidityHash = await bot.write.addLiquidity(
      [poolKeyStruct, FULL_RANGE_TICK_LOWER, FULL_RANGE_TICK_UPPER, lpLiquidityDelta, thirdPartyLpSalt],
      { value: generousEth, account: thirdPartyLpWallet.account }
    );
    const addLiquidityReceipt = await publicClient.waitForTransactionReceipt({ hash: addLiquidityHash });
    console.log('addLiquidity() tx hash:', addLiquidityHash, '| status:', addLiquidityReceipt.status, '| gas used:', addLiquidityReceipt.gasUsed.toString());
    assert.equal(addLiquidityReceipt.status, 'success', 'a genuine third party (zero Incentifi-specific code) must be able to add real liquidity to the graduated pool');

    const lpEthAfter = await publicClient.getBalance({ address: thirdPartyLpAddress });
    const lpGasCost = addLiquidityReceipt.gasUsed * addLiquidityReceipt.effectiveGasPrice;
    const ethActuallyUsed = lpEthBefore - lpEthAfter - lpGasCost;
    console.log('Real ETH actually consumed by the mint (out of the generous', generousEth.toString(), 'sent):', ethActuallyUsed.toString());
    assert.ok(ethActuallyUsed > 0n && ethActuallyUsed < generousEth, 'the mint must consume a real, positive amount of ETH strictly less than the generous upper bound sent — proving the unused portion was genuinely refunded, not silently kept');

    const lpTokenAfterAdd = await token.read.balanceOf([thirdPartyLpAddress]);
    const tokenActuallyUsed = lpTokenBeforeAdd - lpTokenAfterAdd;
    console.log('Real Token A actually consumed by the mint:', tokenActuallyUsed.toString());
    assert.ok(tokenActuallyUsed > 0n, 'the mint must consume a real, positive amount of Token A from the third-party LP\'s own balance');

    const liquidityAfterThirdPartyLp = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] });
    console.log('StateView.getLiquidity(poolId): before', liquidityBeforeThirdPartyLp.toString(), '| after', liquidityAfterThirdPartyLp.toString());
    assert.equal((liquidityAfterThirdPartyLp as bigint) - (liquidityBeforeThirdPartyLp as bigint), lpLiquidityDelta, 'StateView\'s real, independently-read liquidity must have grown by EXACTLY the third party\'s liquidityDelta — proof the mint genuinely landed in the real pool, not just inside our own bookkeeping');

    console.log('\n--- Negative control: the SAME external LP addition on Token B, which has NOT graduated yet ---');
    let preGradLpReverted = false;
    try {
      await bot.write.addLiquidity(
        [poolKeyStructB, FULL_RANGE_TICK_LOWER, FULL_RANGE_TICK_UPPER, lpLiquidityDelta, thirdPartyLpSalt],
        { value: generousEth, account: thirdPartyLpWallet.account }
      );
    } catch {
      preGradLpReverted = true;
    }
    assert.ok(preGradLpReverted, 'the exact same third-party addLiquidity() call must still revert (CannotAddLiquidity) on a pool that has not graduated yet');
    console.log('Confirmed: the identical external-LP call reverts pre-graduation (Token B) — the post-graduation opening is genuinely conditional, not a blanket permission change.');

    console.log('\n--- STAGE 11 RESULT: a genuine third party, with zero Incentifi-specific code, added real liquidity to the graduated pool — StateView independently confirms the pool\'s total liquidity grew by exactly the amount requested, and the unused portion of the generous ETH sent was genuinely refunded. The identical call against a not-yet-graduated pool reverts, confirming the restriction is conditional on graduation, not removed altogether. ---');

    // ========================================================================
    // STAGE 12: a second token's OWN full graduation sequence — not just the
    // buy/sell isolation Stage 9 already proved, but Token B driven all the way
    // through its own boundary-crossing buy, its own real liquidity deposit,
    // and its own independent StateView confirmation, using its own (different
    // from Token A's) accumulated reserve numbers.
    // ========================================================================
    console.log('\n--- Driving Token B to its own graduation boundary ---');
    const preGradStateB = await hookContract.read.curveStates([poolIdB]);
    const realEthReserveBeforeGradB = preGradStateB[4] as bigint;
    const maxNetEthB = graduationTarget - realEthReserveBeforeGradB;
    const maxGrossEthB = 100n * (maxNetEthB / 98n) + (maxNetEthB % 98n);
    const overshootGrossEthB = maxGrossEthB * 3n;
    console.log('Token B realEthReserve before graduating buy:', realEthReserveBeforeGradB.toString(), '(different from Token A\'s own history, by design)');
    console.log('Token B exact clamp target (maxGrossEth):', maxGrossEthB.toString());

    const [, , , , , , , , , graduatingBuyerBWallet] = await viem.getWalletClients();
    const graduatingBuyerBAddress = getAddress(graduatingBuyerBWallet.account.address);
    const graduatingBuyerBEthBefore = await publicClient.getBalance({ address: graduatingBuyerBAddress });

    const gradBHash = await router.write.buyToken([tokenB.address, 0n, deadline], { value: overshootGrossEthB, account: graduatingBuyerBWallet.account });
    const gradBReceipt = await publicClient.waitForTransactionReceipt({ hash: gradBHash });
    console.log('Token B graduating buyToken() tx hash:', gradBHash, '| block:', gradBReceipt.blockNumber.toString(), '| gas used:', gradBReceipt.gasUsed.toString(), '| status:', gradBReceipt.status);
    assert.equal(gradBReceipt.status, 'success', 'Token B\'s boundary-crossing buy, including its own real liquidity deposit, must succeed as one atomic transaction');

    const graduatingBuyerBEthAfter = await publicClient.getBalance({ address: graduatingBuyerBAddress });
    const gradBGasCost = gradBReceipt.gasUsed * gradBReceipt.effectiveGasPrice;
    const graduatingBuyerBNetOutflow = graduatingBuyerBEthBefore - graduatingBuyerBEthAfter - gradBGasCost;
    console.log('Token B buyer real net ETH outflow (excl. own gas):', graduatingBuyerBNetOutflow.toString(), 'vs exact clamp target:', maxGrossEthB.toString());
    assert.equal(graduatingBuyerBNetOutflow, maxGrossEthB, 'Token B\'s clamp+refund must also land exactly, using its own independent reserve numbers');

    const postGradStateB = await hookContract.read.curveStates([poolIdB]);
    console.log('Token B curveStates after:', { graduated: postGradStateB[3], realEthReserve: postGradStateB[4].toString(), realTokenReserve: postGradStateB[5].toString() });
    assert.equal(postGradStateB[3], true, 'Token B state.graduated must now be true');
    assert.equal(postGradStateB[4], graduationTarget, 'Token B realEthReserve must land EXACTLY on GRADUATION_ETH_TARGET, same as Token A did, despite a completely different trading history');

    const gradBLogs = await publicClient.getContractEvents({
      address: foundAddress!,
      abi: hookArtifact.abi,
      eventName: 'GraduationLiquidityDeployed',
      fromBlock: gradBReceipt.blockNumber,
      toBlock: gradBReceipt.blockNumber,
    });
    assert.equal(gradBLogs.length, 1, 'exactly one GraduationLiquidityDeployed event must be emitted for Token B\'s graduation');
    const gradEventB = gradBLogs[0].args as {
      bootstrapLiquidity: bigint; finalLiquidity: bigint; correctedSqrtPriceX96: bigint; ethDust: bigint; tokenDust: bigint;
    };
    console.log('Token B GraduationLiquidityDeployed:', {
      bootstrapLiquidity: gradEventB.bootstrapLiquidity.toString(),
      finalLiquidity: gradEventB.finalLiquidity.toString(),
      correctedSqrtPriceX96: gradEventB.correctedSqrtPriceX96.toString(),
      ethDust: gradEventB.ethDust.toString(),
      tokenDust: gradEventB.tokenDust.toString(),
    });
    assert.ok(gradEventB.bootstrapLiquidity > 0n && gradEventB.finalLiquidity > 0n, 'Token B\'s liquidity deposit must be real and nonzero, independently of Token A\'s own numbers');

    const slot0PostGradB = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolIdB] });
    const liquidityPostGradB = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolIdB] });
    console.log('StateView (Token B, independent): sqrtPriceX96 =', slot0PostGradB[0].toString(), '| liquidity =', liquidityPostGradB.toString());
    assert.equal(slot0PostGradB[0], gradEventB.correctedSqrtPriceX96, 'StateView\'s real, independently-read price for Token B\'s pool must exactly match the hook\'s own reported corrected price');
    assert.equal(liquidityPostGradB, gradEventB.bootstrapLiquidity + gradEventB.finalLiquidity, 'StateView\'s real, independently-read liquidity for Token B\'s pool must equal the sum of its own two minted positions');
    assert.ok((liquidityPostGradB as bigint) > 0n, 'Token B\'s pool must now carry real, nonzero, independently-confirmed liquidity');

    const ethDustBStored = await hookContract.read.ethDustBalances([poolIdB]);
    const tokenDustBStored = await hookContract.read.tokenDustBalances([poolIdB]);
    const hookTokenBBalancePostGrad = await tokenB.read.balanceOf([foundAddress!]);
    assert.equal(ethDustBStored, gradEventB.ethDust, 'Token B\'s ethDustBalances must be written to storage');
    assert.equal(tokenDustBStored, gradEventB.tokenDust, 'Token B\'s tokenDustBalances must be written to storage');
    assert.equal(hookTokenBBalancePostGrad, tokenDustBStored, 'Token B\'s own real balanceOf(hook) must equal its OWN tokenDustBalances exactly — the same per-token isolation proven for Token A now holds for a second, independent token');

    let postGradRouterBReverted = false;
    try {
      await router.write.buyToken([tokenB.address, 0n, deadline], { value: parseEther('0.001'), account: buyerBWallet.account });
    } catch {
      postGradRouterBReverted = true;
    }
    assert.ok(postGradRouterBReverted, 'the router must refuse to buy against Token B\'s pool too, now that it has graduated');
    console.log('Confirmed: router refuses to buy against Token B\'s pool post-graduation.');

    // Confirm, one more time, that Token A's own state is STILL completely
    // unaffected — now by a second token's entire graduation, not just its
    // buy/sell activity.
    const tokenACurveStateAfterBGrad = await hookContract.read.curveStates([poolId]);
    assert.equal(tokenACurveStateAfterBGrad[4], tokenACurveStateBefore[4], 'Token A\'s realEthReserve must remain untouched even by Token B\'s entire graduation');
    assert.equal(tokenACurveStateAfterBGrad[5], tokenACurveStateBefore[5], 'Token A\'s realTokenReserve must remain untouched even by Token B\'s entire graduation');
    console.log('Confirmed: Token A\'s state is still completely unaffected after a second token\'s full, independent graduation.');

    console.log('\n--- STAGE 12 RESULT: Token B was driven through its own complete, independent graduation — its own clamp+refund, its own real two-mint liquidity deposit, its own StateView-confirmed price and liquidity, and its own dust accounting — using reserve numbers shaped by its own distinct trading history rather than Token A\'s. The graduation mechanism generalizes to a second token sharing the same hook, and Token A\'s state remains provably untouched throughout. ---');
  });
});
