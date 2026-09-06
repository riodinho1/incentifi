/**
 * End-to-end REAL-money verification of IncentifiV4HookProductionLogicTest —
 * byte-for-byte the same logic as the production IncentifiV4Hook.sol (six
 * permission flags, including the never-before-real-mainnet-tested afterSwap
 * post-graduation fee mechanism), at ~1/50th the ETH cost of a production-scale
 * graduation. Same shape and rigor as verify-v4-hook-production-mainnet.ts —
 * see that file for the full design rationale — targeting the cheap
 * test-parameter deployment instead.
 *
 * The LossRewardPool this script checks balances against is whatever THROWAWAY
 * pool deploy-v4-hook-production-logic-test-mainnet.ts deployed and recorded —
 * this script never references the real production LossRewardPool address at
 * all, anywhere, so there is no code path that could touch it.
 *
 * Steps (identical shape to the production verify script):
 *   1. Launch a real test token through the test-scale factory.
 *   2. Real pre-graduation BUY (0.005 ETH) through the router.
 *   3. Real pre-graduation SELL of everything just bought.
 *   4. Drive a REAL graduation (cheap here — GRADUATION_ETH_TARGET is ~0.117 ETH,
 *      not ~5.85 ETH). Verifies graduation state, GraduationLiquidityDeployed,
 *      and an independent StateView cross-check.
 *   5. Deploy GenericV4Bot (the router is pre-graduation-only, same as production).
 *   6. Real POST-graduation BUY via the bot — beforeSwap graduated-branch skim.
 *   7. Real POST-graduation SELL via the bot — afterSwap fee mechanism, THE
 *      never-before-mainnet-tested code path, exercised here cheaply first.
 *   8. claimCreatorFees() across everything accrued in steps 2, 3, 4, 6, 7.
 *
 * SAFETY GATES:
 *   - DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) — the SAME funded key used to deploy
 *   - DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET
 *   - The hook/factory/router/lossRewardPool addresses, via V4_HOOK_ADDRESS /
 *     V4_FACTORY_ADDRESS / V4_ROUTER_ADDRESS / V4_LOSS_REWARD_POOL_ADDRESS env
 *     vars, or scripts/.v4-logic-test-deployment-result.json (written by
 *     deploy-v4-hook-production-logic-test-mainnet.ts) if unset.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET \
 *     npx hardhat run scripts/verify-v4-hook-production-logic-test-mainnet.ts --network robinhoodMainnet
 *
 * CRASH / RPC-HICCUP SAFETY (automatic — no flag needed): identical mechanism
 * to every other script in this batch — every tx hash (and any pre-send
 * snapshot its exact-delta assertion needs) is written to
 * scripts/.v4-logic-test-verify-state.json before this script ever waits on a
 * receipt. Re-running the exact same command resumes rather than resends.
 */

import fs from 'node:fs';
import path from 'node:path';
import { network, artifacts } from 'hardhat';
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbi, getAddress, getContractAddress, formatEther, parseEther } from 'viem';

const CHAIN_ID = 4663;
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const BUY_AMOUNT_WEI = parseEther('0.005');

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

const RESULT_PATH = path.resolve('scripts', '.v4-logic-test-deployment-result.json');
const STATE_PATH = path.resolve('scripts', '.v4-logic-test-verify-state.json');
const RECEIPT_RETRY_ATTEMPTS = Number(process.env.RECEIPT_RETRY_ATTEMPTS || 6);
const RECEIPT_RETRY_BASE_DELAY_MS = Number(process.env.RECEIPT_RETRY_DELAY_MS || 5000);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAddresses(): { hook: `0x${string}`; factory: `0x${string}`; router: `0x${string}`; lossRewardPool: `0x${string}` } {
  const envHook = process.env.V4_HOOK_ADDRESS;
  const envFactory = process.env.V4_FACTORY_ADDRESS;
  const envRouter = process.env.V4_ROUTER_ADDRESS;
  const envLrp = process.env.V4_LOSS_REWARD_POOL_ADDRESS;
  if (envHook && envFactory && envRouter && envLrp) {
    return { hook: getAddress(envHook), factory: getAddress(envFactory), router: getAddress(envRouter), lossRewardPool: getAddress(envLrp) };
  }
  if (!fs.existsSync(RESULT_PATH)) {
    throw new Error(
      `Neither V4_HOOK_ADDRESS/V4_FACTORY_ADDRESS/V4_ROUTER_ADDRESS/V4_LOSS_REWARD_POOL_ADDRESS env vars nor ` +
      `${RESULT_PATH} were found.\nRun deploy-v4-hook-production-logic-test-mainnet.ts first, or set all four env vars explicitly.`
    );
  }
  const deployResult = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
  return {
    hook: getAddress(deployResult.hook.address),
    factory: getAddress(deployResult.factory.address),
    router: getAddress(deployResult.router.address),
    lossRewardPool: getAddress(deployResult.lossRewardPool.address),
  };
}

function requireConfirmation() {
  if (process.env.DEPLOY_CONFIRM !== 'I_UNDERSTAND_THIS_IS_MAINNET') {
    throw new Error('\nSet DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET to proceed.\n');
  }
  const key = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
  if (!key) {
    throw new Error('DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) env var is required.');
  }
}

type StepRecord = { hash?: `0x${string}`; confirmed?: boolean; blockNumber?: string; gasUsed?: string; effectiveGasPrice?: string; [key: string]: unknown };
type VerifyState = { hook: `0x${string}`; factory: `0x${string}`; router: `0x${string}`; lossRewardPool: `0x${string}`; wallet: `0x${string}`; steps: Record<string, StepRecord> };

function loadState(hook: `0x${string}`, factory: `0x${string}`, router: `0x${string}`, lossRewardPool: `0x${string}`, walletRaw: `0x${string}`): VerifyState {
  const wallet = getAddress(walletRaw);
  if (!fs.existsSync(STATE_PATH)) return { hook, factory, router, lossRewardPool, wallet, steps: {} };
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const sameRun =
    raw.hook && getAddress(raw.hook) === hook &&
    raw.factory && getAddress(raw.factory) === factory &&
    raw.router && getAddress(raw.router) === router &&
    raw.lossRewardPool && getAddress(raw.lossRewardPool) === lossRewardPool &&
    raw.wallet && getAddress(raw.wallet) === wallet;
  if (!sameRun) {
    throw new Error(
      `${STATE_PATH} exists but is for different addresses than this run.\n` +
      `  state file: hook=${raw.hook}, factory=${raw.factory}, router=${raw.router}, lossRewardPool=${raw.lossRewardPool}, wallet=${raw.wallet}\n` +
      `  this run:   hook=${hook}, factory=${factory}, router=${router}, lossRewardPool=${lossRewardPool}, wallet=${wallet}\n` +
      `Move or delete ${STATE_PATH} by hand if that earlier run is done with.`
    );
  }
  const steps = raw.steps || {};
  if (Object.keys(steps).length > 0) {
    console.log(`[STATE] Found ${STATE_PATH} — resuming. Steps already recorded: ${Object.keys(steps).join(', ')}\n`);
  }
  return { hook, factory, router, lossRewardPool, wallet, steps };
}

function persistState(state: VerifyState) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

async function main() {
  requireConfirmation();
  const { hook: hookAddress, factory: factoryAddress, router: routerAddress, lossRewardPool: lossRewardPoolAddress } = resolveAddresses();

  const { viem } = await network.create('robinhoodMainnet');
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Chain ID mismatch! Expected ${CHAIN_ID}, got ${chainId}.`);

  const [wallet] = await viem.getWalletClients();
  const account = getAddress(wallet.account.address);

  console.log('\n============================================================');
  console.log('[VERIFY V4 HOOK — PRODUCTION LOGIC, TEST SCALE] Robinhood Chain MAINNET');
  console.log('============================================================');
  console.log(`Wallet:         ${account}`);
  console.log(`Hook:           ${hookAddress}`);
  console.log(`Factory:        ${factoryAddress}`);
  console.log(`Router:         ${routerAddress}`);
  console.log(`LossRewardPool: ${lossRewardPoolAddress} (throwaway — NOT the real production pool)`);
  console.log('============================================================\n');

  const state = loadState(hookAddress, factoryAddress, routerAddress, lossRewardPoolAddress, account);

  async function waitForReceiptWithRetry(hash: `0x${string}`, label: string) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RECEIPT_RETRY_ATTEMPTS; attempt++) {
      try {
        return await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 });
      } catch (err) {
        lastErr = err;
        const delay = RECEIPT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(`  [${label}] receipt wait attempt ${attempt}/${RECEIPT_RETRY_ATTEMPTS} failed (${err instanceof Error ? err.message : String(err)})` + (attempt < RECEIPT_RETRY_ATTEMPTS ? `; retrying in ${Math.round(delay / 1000)}s...` : ''));
        if (attempt < RECEIPT_RETRY_ATTEMPTS) await sleep(delay);
      }
    }
    throw new Error(`[${label}] Could not confirm receipt for tx ${hash} after ${RECEIPT_RETRY_ATTEMPTS} attempts. Its hash is already in ${STATE_PATH}; re-running resumes rather than resends.\nLast error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  async function runStep(name: string, sendFn: () => Promise<{ hash: `0x${string}`; [key: string]: unknown }>, precomputedExtra: Record<string, unknown> = {}): Promise<StepRecord> {
    let record = state.steps[name];
    if (!record) {
      console.log(`[${name}] sending transaction...`);
      const sent = await sendFn();
      record = { confirmed: false, ...precomputedExtra, ...sent };
      state.steps[name] = record;
      persistState(state);
      console.log(`  Tx sent: ${record.hash}`);
    } else {
      console.log(`[${name}] resuming — tx already on record: ${record.hash} (confirmed: ${Boolean(record.confirmed)})`);
    }
    if (!record.confirmed) {
      const receipt = await waitForReceiptWithRetry(record.hash as `0x${string}`, name);
      if (receipt.status !== 'success') throw new Error(`[${name}] transaction reverted (status: ${receipt.status}). Tx: ${record.hash}`);
      record.confirmed = true;
      record.blockNumber = receipt.blockNumber.toString();
      record.gasUsed = receipt.gasUsed.toString();
      record.effectiveGasPrice = receipt.effectiveGasPrice.toString();
      state.steps[name] = record;
      persistState(state);
      console.log(`  Confirmed in block #${receipt.blockNumber} (gas used ${receipt.gasUsed})\n`);
    }
    return record;
  }

  function gasCost(record: StepRecord): bigint {
    return BigInt(record.gasUsed!) * BigInt(record.effectiveGasPrice!);
  }

  const hookArtifact = await artifacts.readArtifact('IncentifiV4HookProductionLogicTest');
  const hook = await viem.getContractAt('IncentifiV4HookProductionLogicTest', hookAddress);
  const factory = await viem.getContractAt('IncentifiV4Factory', factoryAddress);
  const router = await viem.getContractAt('IncentifiV4Router', routerAddress);
  for (const [label, addr] of [['Hook', hookAddress], ['Factory', factoryAddress], ['Router', routerAddress], ['LossRewardPool', lossRewardPoolAddress]] as const) {
    const code = await publicClient.getCode({ address: addr });
    if (!code || code === '0x') throw new Error(`${label} ${addr} has empty code.`);
  }
  if (getAddress(await factory.read.hook()) !== hookAddress) throw new Error('factory.hook() does not match the given Hook.');
  if (getAddress(await router.read.hook()) !== hookAddress) throw new Error('router.hook() does not match the given Hook.');
  if (getAddress(await router.read.factory()) !== factoryAddress) throw new Error('router.factory() does not match the given Factory.');
  if (getAddress(await hook.read.lossRewardPool()) !== lossRewardPoolAddress) throw new Error('hook.lossRewardPool() does not match the given (throwaway) LossRewardPool.');
  console.log('[PRE-FLIGHT] Hook/Factory/Router/LossRewardPool all have live code and are correctly cross-wired. OK.\n');

  const totalDepositedAbi = parseAbi(['function totalDeposited(address) view returns (uint256)']);
  async function lossPoolBalance() { return publicClient.getBalance({ address: lossRewardPoolAddress }); }
  async function lossPoolDeposited(token: `0x${string}`) {
    return publicClient.readContract({ address: lossRewardPoolAddress, abi: totalDepositedAbi, functionName: 'totalDeposited', args: [token] });
  }

  // ==========================================================================
  // STAGE 1: launch a real test token
  // ==========================================================================
  console.log('[1/8] Test token launch...');
  const tokenDeployRecord = await runStep('tokenDeploy', async () => {
    const launchTokenArtifact = await artifacts.readArtifact('IncentifiLaunchToken');
    const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
    const address = getContractAddress({ from: account, nonce: BigInt(nonce) });
    const tokenName = `Incentifi V4 Logic Test ${Date.now()}`;
    const hash = await wallet.deployContract({ abi: launchTokenArtifact.abi, bytecode: launchTokenArtifact.bytecode as `0x${string}`, args: [tokenName, 'IFV4T', TOTAL_SUPPLY], nonce });
    return { hash, address, tokenName };
  });
  const tokenAddress = getAddress(tokenDeployRecord.address as string);
  const token = await viem.getContractAt('IncentifiLaunchToken', tokenAddress);
  console.log(`  Token: ${tokenAddress} ("${tokenDeployRecord.tokenName}")`);

  await runStep('approveFactory', async () => ({ hash: await token.write.approve([factoryAddress, TOTAL_SUPPLY]) }));
  await runStep('launchToken', async () => ({ hash: await factory.write.launchToken([tokenAddress]) }));

  const poolKey = await factory.read.getPoolKey([tokenAddress]);
  const poolId = keccak256(
    encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks])
  );
  const curveAfterLaunch = await hook.read.curveStates([poolId]);
  if (getAddress(curveAfterLaunch[0]) !== tokenAddress) throw new Error('curveStates.token mismatch after launch.');
  if (getAddress(curveAfterLaunch[1]) !== account) throw new Error('curveStates.creator mismatch after launch.');
  if (curveAfterLaunch[2] !== true) throw new Error('curveStates.initialized is not true after launch.');
  if (curveAfterLaunch[5] !== TOTAL_SUPPLY) throw new Error('curveStates.realTokenReserve != TOTAL_SUPPLY after launch.');

  const slot0Launch = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
  const expectedLaunchPrice = await hook.read.launchSqrtPriceX96();
  if (slot0Launch[0] !== expectedLaunchPrice) throw new Error('StateView launch price does not match hook.launchSqrtPriceX96().');
  console.log(`  PoolId: ${poolId}`);
  console.log('  curveStates + independent StateView launch-price cross-check: MATCH\n');

  // ==========================================================================
  // STAGE 2: real pre-graduation buy
  // ==========================================================================
  console.log(`[2/8] Pre-graduation buy of ${formatEther(BUY_AMOUNT_WEI)} ETH...`);
  const buy1Before = (state.steps.preGradBuy?.before as Record<string, string>) ?? {
    ethBefore: (await publicClient.getBalance({ address: account })).toString(),
    tokensBefore: (await token.read.balanceOf([account])).toString(),
    curveEthReserveBefore: ((await hook.read.curveStates([poolId]))[4] as bigint).toString(),
    lossPoolBalanceBefore: (await lossPoolBalance()).toString(),
    lossPoolDepositedBefore: (await lossPoolDeposited(tokenAddress)).toString(),
  };
  const buy1Record = await runStep(
    'preGradBuy',
    async () => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      return { hash: await router.write.buyToken([tokenAddress, 0n, deadline], { value: BUY_AMOUNT_WEI }) };
    },
    { before: buy1Before }
  );
  {
    const b = buy1Record.before as Record<string, string>;
    const ethAfter = await publicClient.getBalance({ address: account });
    const tokensAfter = await token.read.balanceOf([account]);
    const curveEthReserveAfter = (await hook.read.curveStates([poolId]))[4] as bigint;
    const lossPoolBalanceAfter = await lossPoolBalance();
    const lossPoolDepositedAfter = await lossPoolDeposited(tokenAddress);

    const ethSpent = BigInt(b.ethBefore) - ethAfter - gasCost(buy1Record);
    const tokensReceived = tokensAfter - BigInt(b.tokensBefore);
    const curveDelta = curveEthReserveAfter - BigInt(b.curveEthReserveBefore);
    const lossPoolDelta = lossPoolBalanceAfter - BigInt(b.lossPoolBalanceBefore);
    const lossPoolDepositedDelta = lossPoolDepositedAfter - BigInt(b.lossPoolDepositedBefore);
    const expectedNetEth = BUY_AMOUNT_WEI - BUY_AMOUNT_WEI / 100n - BUY_AMOUNT_WEI / 100n;
    const expectedFee = BUY_AMOUNT_WEI / 100n;

    if (ethSpent !== BUY_AMOUNT_WEI) throw new Error(`Pre-grad buy: wallet spent ${ethSpent}, expected exactly ${BUY_AMOUNT_WEI}.`);
    if (tokensReceived <= 0n) throw new Error('Pre-grad buy produced zero tokens.');
    if (curveDelta !== expectedNetEth) throw new Error(`Pre-grad buy: curve realEthReserve delta ${curveDelta} != expected ${expectedNetEth}.`);
    if (lossPoolDelta !== expectedFee) throw new Error(`Pre-grad buy: LossRewardPool balance delta ${lossPoolDelta} != expected ${expectedFee}.`);
    if (lossPoolDepositedDelta !== expectedFee) throw new Error(`Pre-grad buy: LossRewardPool.totalDeposited(token) delta ${lossPoolDepositedDelta} != expected ${expectedFee}.`);
    console.log(`  Tokens received: ${tokensReceived}. Exact balance-delta assertions: PASS\n`);

    if (buy1Record.tokensReceived === undefined) {
      buy1Record.tokensReceived = tokensReceived.toString();
      state.steps.preGradBuy = buy1Record;
      persistState(state);
    }
  }
  const preGradTokens = BigInt(buy1Record.tokensReceived as string);

  // ==========================================================================
  // STAGE 3: real pre-graduation sell
  // ==========================================================================
  console.log(`[3/8] Pre-graduation sell of all ${preGradTokens} tokens...`);
  await runStep('preGradSellApprove', async () => ({ hash: await token.write.approve([routerAddress, preGradTokens]) }));

  const sell1Before = (state.steps.preGradSell?.before as Record<string, string>) ?? {
    ethBefore: (await publicClient.getBalance({ address: account })).toString(),
    curveEthReserveBefore: ((await hook.read.curveStates([poolId]))[4] as bigint).toString(),
    lossPoolBalanceBefore: (await lossPoolBalance()).toString(),
  };
  const sell1Record = await runStep(
    'preGradSell',
    async () => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      return { hash: await router.write.sellToken([tokenAddress, preGradTokens, 0n, deadline]) };
    },
    { before: sell1Before }
  );
  {
    const b = sell1Record.before as Record<string, string>;
    const ethAfter = await publicClient.getBalance({ address: account });
    const tokensAfter = await token.read.balanceOf([account]);
    const curveEthReserveAfter = (await hook.read.curveStates([poolId]))[4] as bigint;
    const lossPoolBalanceAfter = await lossPoolBalance();

    const ethReceived = ethAfter - BigInt(b.ethBefore) + gasCost(sell1Record);
    const curveDelta = BigInt(b.curveEthReserveBefore) - curveEthReserveAfter;
    const expectedNet = curveDelta - curveDelta / 100n - curveDelta / 100n;
    const lossPoolDelta = lossPoolBalanceAfter - BigInt(b.lossPoolBalanceBefore);

    if (tokensAfter !== 0n) throw new Error(`Pre-grad sell: wallet still holds ${tokensAfter} tokens.`);
    if (ethReceived !== expectedNet) throw new Error(`Pre-grad sell: wallet received ${ethReceived}, expected exactly ${expectedNet}.`);
    if (lossPoolDelta !== curveDelta / 100n) throw new Error(`Pre-grad sell: LossRewardPool balance delta ${lossPoolDelta} != expected ${curveDelta / 100n}.`);
    console.log('  Exact balance-delta assertions: PASS\n');
  }

  // ==========================================================================
  // STAGE 4: drive a REAL graduation (cheap here)
  // ==========================================================================
  console.log('[4/8] Driving to a REAL graduation (test-scale target)...');
  let overshootGrossEth: bigint;
  let gradSnapshotBefore: Record<string, string>;
  if (state.steps.graduatingBuy?.before) {
    gradSnapshotBefore = state.steps.graduatingBuy.before as Record<string, string>;
    overshootGrossEth = BigInt(state.steps.graduatingBuy.overshootGrossEth as string);
  } else {
    const graduationTarget = await hook.read.GRADUATION_ETH_TARGET();
    const realEthReserveNow = (await hook.read.curveStates([poolId]))[4] as bigint;
    const maxNetEth = graduationTarget - realEthReserveNow;
    const maxGrossEth = 100n * (maxNetEth / 98n) + (maxNetEth % 98n);
    overshootGrossEth = (maxGrossEth * 105n) / 100n;
    const gasBuffer = parseEther('0.01');
    const walletBalance = await publicClient.getBalance({ address: account });
    console.log(`  realEthReserve now: ${formatEther(realEthReserveNow)} ETH`);
    console.log(`  GRADUATION_ETH_TARGET: ${formatEther(graduationTarget)} ETH`);
    console.log(`  Exact clamp target (gross): ${formatEther(maxGrossEth)} ETH`);
    console.log(`  Sending (1.05x, to force the real clamp path): ${formatEther(overshootGrossEth)} ETH`);
    if (walletBalance < overshootGrossEth + gasBuffer) {
      throw new Error(`Wallet balance (${formatEther(walletBalance)} ETH) is insufficient for the graduating buy (${formatEther(overshootGrossEth)} ETH + ${formatEther(gasBuffer)} ETH gas buffer).`);
    }
    gradSnapshotBefore = {
      ethBefore: walletBalance.toString(),
      curveEthReserveBefore: realEthReserveNow.toString(),
      lossPoolBalanceBefore: (await lossPoolBalance()).toString(),
    };
  }

  const gradRecord = await runStep(
    'graduatingBuy',
    async () => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      return { hash: await router.write.buyToken([tokenAddress, 0n, deadline], { value: overshootGrossEth }) };
    },
    { before: gradSnapshotBefore, overshootGrossEth: overshootGrossEth.toString() }
  );
  {
    const b = gradRecord.before as Record<string, string>;
    const ethAfter = await publicClient.getBalance({ address: account });
    const curveEthReserveAfter = (await hook.read.curveStates([poolId]))[4] as bigint;
    const graduated = (await hook.read.curveStates([poolId]))[3] as boolean;
    const graduationTarget = await hook.read.GRADUATION_ETH_TARGET();
    const lossPoolBalanceAfter = await lossPoolBalance();

    const netOutflow = BigInt(b.ethBefore) - ethAfter - gasCost(gradRecord);
    const curveDelta = curveEthReserveAfter - BigInt(b.curveEthReserveBefore);
    const actualGrossEth = netOutflow;
    const expectedCurveDelta = actualGrossEth - actualGrossEth / 100n - actualGrossEth / 100n;
    const expectedFee = actualGrossEth / 100n;
    const lossPoolDelta = lossPoolBalanceAfter - BigInt(b.lossPoolBalanceBefore);

    if (!graduated) throw new Error('state.graduated is not true after the graduating buy.');
    if (curveEthReserveAfter !== graduationTarget) throw new Error(`realEthReserve (${curveEthReserveAfter}) did not land exactly on GRADUATION_ETH_TARGET (${graduationTarget}).`);
    if (curveDelta !== expectedCurveDelta) throw new Error(`Graduating buy: curve delta ${curveDelta} != expected ${expectedCurveDelta}.`);
    if (lossPoolDelta !== expectedFee) throw new Error(`Graduating buy: LossRewardPool delta ${lossPoolDelta} != expected ${expectedFee}.`);
    console.log(`  Real gross ETH processed: ${formatEther(actualGrossEth)} ETH`);
    console.log('  state.graduated == true, realEthReserve == GRADUATION_ETH_TARGET exactly (confirmed)');

    const gradLogs = await publicClient.getContractEvents({ address: hookAddress, abi: hookArtifact.abi, eventName: 'GraduationLiquidityDeployed', fromBlock: BigInt(gradRecord.blockNumber!), toBlock: BigInt(gradRecord.blockNumber!) });
    if (gradLogs.length !== 1) throw new Error(`Expected exactly 1 GraduationLiquidityDeployed event, got ${gradLogs.length}.`);
    const gradEvent = gradLogs[0].args as { bootstrapLiquidity: bigint; finalLiquidity: bigint; correctedSqrtPriceX96: bigint };
    const slot0PostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
    const liquidityPostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] });
    if (slot0PostGrad[0] !== gradEvent.correctedSqrtPriceX96) throw new Error('StateView post-grad price does not match the event.');
    if (liquidityPostGrad !== gradEvent.bootstrapLiquidity + gradEvent.finalLiquidity) throw new Error('StateView post-grad liquidity does not match the event.');
    console.log('  Independent StateView cross-check of post-graduation price/liquidity: MATCH\n');
  }

  // ==========================================================================
  // STAGE 5: deploy GenericV4Bot
  // ==========================================================================
  console.log('[5/8] Deploying GenericV4Bot...');
  const botArtifact = await artifacts.readArtifact('GenericV4Bot');
  const botRecord = await runStep('botDeploy', async () => {
    const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
    const address = getContractAddress({ from: account, nonce: BigInt(nonce) });
    const hash = await wallet.deployContract({ abi: botArtifact.abi, bytecode: botArtifact.bytecode as `0x${string}`, args: [POOL_MANAGER], nonce });
    return { hash, address };
  });
  const botAddress = getAddress(botRecord.address as string);
  const bot = await viem.getContractAt('GenericV4Bot', botAddress);
  console.log(`  GenericV4Bot: ${botAddress}\n`);

  // ==========================================================================
  // STAGE 6: real POST-graduation buy
  // ==========================================================================
  console.log(`[6/8] Post-graduation buy of ${formatEther(BUY_AMOUNT_WEI)} ETH via GenericV4Bot...`);
  const buy2Before = (state.steps.postGradBuy?.before as Record<string, string>) ?? {
    ethBefore: (await publicClient.getBalance({ address: account })).toString(),
    tokensBefore: (await token.read.balanceOf([account])).toString(),
    lossPoolBalanceBefore: (await lossPoolBalance()).toString(),
    creatorBalanceBefore: ((await hook.read.creatorBalances([account])) as bigint).toString(),
  };
  let predictedBuy2Out: bigint | undefined = state.steps.postGradBuy?.predictedOut !== undefined ? BigInt(state.steps.postGradBuy.predictedOut as string) : undefined;
  if (predictedBuy2Out === undefined) {
    const sim = await publicClient.simulateContract({ address: botAddress, abi: botArtifact.abi, functionName: 'swap', args: [poolKey, true, BUY_AMOUNT_WEI, 0n], account, value: BUY_AMOUNT_WEI });
    predictedBuy2Out = sim.result as bigint;
  }
  const buy2Record = await runStep(
    'postGradBuy',
    async () => ({ hash: await bot.write.swap([poolKey, true, BUY_AMOUNT_WEI, 0n], { value: BUY_AMOUNT_WEI }) }),
    { before: buy2Before, predictedOut: predictedBuy2Out.toString() }
  );
  {
    const b = buy2Record.before as Record<string, string>;
    const predicted = BigInt(buy2Record.predictedOut as string);
    const ethAfter = await publicClient.getBalance({ address: account });
    const tokensAfter = await token.read.balanceOf([account]);
    const lossPoolBalanceAfter = await lossPoolBalance();
    const creatorBalanceAfter = (await hook.read.creatorBalances([account])) as bigint;

    const ethSpent = BigInt(b.ethBefore) - ethAfter - gasCost(buy2Record);
    const tokensReceived = tokensAfter - BigInt(b.tokensBefore);

    const feeLogs = await publicClient.getContractEvents({ address: hookAddress, abi: hookArtifact.abi, eventName: 'GraduatedFeeCollected', fromBlock: BigInt(buy2Record.blockNumber!), toBlock: BigInt(buy2Record.blockNumber!) });
    if (feeLogs.length !== 1) throw new Error(`Expected exactly 1 GraduatedFeeCollected event on post-grad buy, got ${feeLogs.length}.`);
    const feeEvent = feeLogs[0].args as { zeroForOne: boolean; creatorFee: bigint; lossPoolFee: bigint };
    if (feeEvent.zeroForOne !== true) throw new Error('Post-grad buy GraduatedFeeCollected.zeroForOne should be true.');

    if (ethSpent !== BUY_AMOUNT_WEI) throw new Error(`Post-grad buy: wallet spent ${ethSpent}, expected exactly ${BUY_AMOUNT_WEI}.`);
    if (tokensReceived !== predicted) throw new Error(`Post-grad buy: tokens received ${tokensReceived} != simulated prediction ${predicted}.`);
    if (lossPoolBalanceAfter - BigInt(b.lossPoolBalanceBefore) !== feeEvent.lossPoolFee) throw new Error('Post-grad buy: LossRewardPool delta != event.lossPoolFee.');
    if (creatorBalanceAfter - BigInt(b.creatorBalanceBefore) !== feeEvent.creatorFee) throw new Error('Post-grad buy: creatorBalances delta != event.creatorFee.');
    console.log(`  Tokens received: ${tokensReceived} (== simulated prediction, exact)`);
    console.log(`  GraduatedFeeCollected(zeroForOne=true): creatorFee=${feeEvent.creatorFee}, lossPoolFee=${feeEvent.lossPoolFee}`);
    console.log('  Exact balance-delta assertions: PASS\n');

    if (buy2Record.tokensReceived === undefined) {
      buy2Record.tokensReceived = tokensReceived.toString();
      state.steps.postGradBuy = buy2Record;
      persistState(state);
    }
  }
  const postGradTokens = BigInt(buy2Record.tokensReceived as string);

  // ==========================================================================
  // STAGE 7: real POST-graduation sell — the never-before-mainnet-tested path
  // ==========================================================================
  console.log(`[7/8] Post-graduation sell of ${postGradTokens} tokens via GenericV4Bot (afterSwap fee path)...`);
  await runStep('postGradSellApprove', async () => ({ hash: await token.write.approve([botAddress, postGradTokens]) }));

  const sell2Before = (state.steps.postGradSell?.before as Record<string, string>) ?? {
    ethBefore: (await publicClient.getBalance({ address: account })).toString(),
    lossPoolBalanceBefore: (await lossPoolBalance()).toString(),
    creatorBalanceBefore: ((await hook.read.creatorBalances([account])) as bigint).toString(),
  };
  let predictedSell2Out: bigint | undefined = state.steps.postGradSell?.predictedOut !== undefined ? BigInt(state.steps.postGradSell.predictedOut as string) : undefined;
  if (predictedSell2Out === undefined) {
    const sim = await publicClient.simulateContract({ address: botAddress, abi: botArtifact.abi, functionName: 'swap', args: [poolKey, false, postGradTokens, 0n], account });
    predictedSell2Out = sim.result as bigint;
  }
  const sell2Record = await runStep(
    'postGradSell',
    async () => ({ hash: await bot.write.swap([poolKey, false, postGradTokens, 0n]) }),
    { before: sell2Before, predictedOut: predictedSell2Out.toString() }
  );
  {
    const b = sell2Record.before as Record<string, string>;
    const predicted = BigInt(sell2Record.predictedOut as string);
    const ethAfter = await publicClient.getBalance({ address: account });
    const tokensAfter = await token.read.balanceOf([account]);
    const lossPoolBalanceAfter = await lossPoolBalance();
    const creatorBalanceAfter = (await hook.read.creatorBalances([account])) as bigint;

    const ethReceived = ethAfter - BigInt(b.ethBefore) + gasCost(sell2Record);

    const feeLogs = await publicClient.getContractEvents({ address: hookAddress, abi: hookArtifact.abi, eventName: 'GraduatedFeeCollected', fromBlock: BigInt(sell2Record.blockNumber!), toBlock: BigInt(sell2Record.blockNumber!) });
    if (feeLogs.length !== 1) throw new Error(`Expected exactly 1 GraduatedFeeCollected event on post-grad sell, got ${feeLogs.length}.`);
    const feeEvent = feeLogs[0].args as { zeroForOne: boolean; creatorFee: bigint; lossPoolFee: bigint };
    if (feeEvent.zeroForOne !== false) throw new Error('Post-grad sell GraduatedFeeCollected.zeroForOne should be false — this is THE never-before-tested code path.');

    if (tokensAfter !== 0n) throw new Error(`Post-grad sell: wallet still holds ${tokensAfter} tokens.`);
    if (ethReceived !== predicted) throw new Error(`Post-grad sell: ETH received ${ethReceived} != simulated prediction ${predicted}.`);
    if (lossPoolBalanceAfter - BigInt(b.lossPoolBalanceBefore) !== feeEvent.lossPoolFee) throw new Error('Post-grad sell: LossRewardPool delta != event.lossPoolFee.');
    if (creatorBalanceAfter - BigInt(b.creatorBalanceBefore) !== feeEvent.creatorFee) throw new Error('Post-grad sell: creatorBalances delta != event.creatorFee.');
    console.log(`  ETH received: ${formatEther(ethReceived)} ETH (== simulated prediction, exact)`);
    console.log(`  GraduatedFeeCollected(zeroForOne=false): creatorFee=${feeEvent.creatorFee}, lossPoolFee=${feeEvent.lossPoolFee}`);
    console.log('  *** afterSwap sell-side fee mechanism confirmed working on real mainnet (test-scale, throwaway pool) ***');
    console.log('  Exact balance-delta assertions: PASS\n');
  }

  // ==========================================================================
  // STAGE 8: claim
  // ==========================================================================
  console.log('[8/8] Claiming accrued creator fees (pre- + post-graduation, one ledger)...');
  const claimBefore = (state.steps.claim?.before as Record<string, string>) ?? {
    ethBefore: (await publicClient.getBalance({ address: account })).toString(),
    accruedBefore: ((await hook.read.creatorBalances([account])) as bigint).toString(),
  };
  const accruedBeforeClaim = BigInt(claimBefore.accruedBefore);
  console.log(`  creatorBalances(${account}) before claim: ${formatEther(accruedBeforeClaim)} ETH`);
  if (!state.steps.claim && accruedBeforeClaim <= 0n) throw new Error('Expected a non-zero accrued creator balance, got 0.');
  const claimRecord = await runStep('claim', async () => ({ hash: await hook.write.claimCreatorFees() }), { before: claimBefore });
  {
    const b = claimRecord.before as Record<string, string>;
    const ethAfter = await publicClient.getBalance({ address: account });
    const accruedAfter = (await hook.read.creatorBalances([account])) as bigint;
    const netClaimed = ethAfter - BigInt(b.ethBefore) + gasCost(claimRecord);

    if (accruedAfter !== 0n) throw new Error(`creatorBalances() is ${accruedAfter} after claim, expected exactly 0.`);
    if (netClaimed !== accruedBeforeClaim) throw new Error(`Claimed ETH (net of gas) ${netClaimed} != pre-claim reading ${accruedBeforeClaim}.`);
    console.log(`  Claimed exactly ${formatEther(netClaimed)} ETH (net of gas). Exact balance-delta assertion: PASS\n`);
  }

  console.log('============================================================');
  console.log('[VERIFY V4 HOOK — PRODUCTION LOGIC, TEST SCALE] COMPLETE');
  console.log('============================================================');
  console.log('Every step confirmed on-chain with exact balance deltas, including the post-graduation');
  console.log('beforeSwap AND afterSwap fee mechanisms, at test scale, against a throwaway LossRewardPool.');
  console.log(JSON.stringify({
    hook: hookAddress,
    factory: factoryAddress,
    router: routerAddress,
    lossRewardPool: lossRewardPoolAddress,
    testToken: tokenAddress,
    poolId,
    genericV4Bot: botAddress,
    verifiedAt: new Date().toISOString(),
    result: 'ALL EXACT BALANCE-DELTA ASSERTIONS PASSED, INCLUDING POST-GRADUATION FEE MECHANISM (TEST SCALE)',
  }, null, 2));
}

main().catch((err) => {
  console.error('\n[VERIFY ERROR]', err instanceof Error ? err.message : err);
  console.error(`Progress so far is saved in ${STATE_PATH}. Re-running the exact same command resumes, not resends.`);
  process.exitCode = 1;
});
