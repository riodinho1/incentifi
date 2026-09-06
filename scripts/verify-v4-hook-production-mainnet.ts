/**
 * End-to-end REAL-money verification of the production IncentifiV4Hook +
 * IncentifiV4Factory + IncentifiV4Router deployment on Robinhood Chain MAINNET,
 * specifically exercising the ONE code path that has never touched real mainnet
 * before: the post-graduation fee mechanism (afterSwap sell-side skim, and the
 * beforeSwap graduated-branch buy-side skim).
 *
 * ============================================================================
 * THE REAL COST — read before running:
 * ============================================================================
 * GRADUATION_ETH_TARGET (5.853863234375 ETH, net) is a hardcoded constant in the
 * PRODUCTION hook — there is no cheaper parameter to reach it with, unlike the
 * testnet hook. Reaching it requires ~5.97 ETH gross across the buys in this
 * script (~$14,660 at ~$2,454/ETH, the price at the time this script was written
 * — check a live price before running, it will have moved). Of that:
 *   - ~5.854 ETH (~$14,368) becomes PERMANENTLY LOCKED AMM liquidity — by design,
 *     non-refundable, not recoverable by anyone, ever (same as _graduate()'s own
 *     doc comment describes).
 *   - The remaining ~0.12 ETH splits into a creator fee (recoverable via
 *     claimCreatorFees(), this script claims it at the end) and a real deposit
 *     into the REAL production LossRewardPool (not recoverable by you — a
 *     genuine deposit into the actual protocol pool).
 * Plus real gas for every step, including the graduation transaction itself
 * (2 liquidity mints + 1 corrective swap — meaningfully more gas than an
 * ordinary trade).
 *
 * This is why GRADUATION_COST_CONFIRM below exists as its own explicit,
 * separately-worded flag, distinct from DEPLOY_CONFIRM/V4_PRODUCTION_CONFIRM.
 * ============================================================================
 *
 * Steps:
 *   1. Launch a real, tiny, single-purpose test token through the production
 *      IncentifiV4Factory. Verifies pool initialization independently via
 *      StateView (a separate, real, already-deployed Uniswap contract).
 *   2. Real pre-graduation BUY (0.005 ETH) through IncentifiV4Router.
 *   3. Real pre-graduation SELL of everything just bought, through the router.
 *   4. Drives a REAL graduation: one buy sized (with a modest overshoot, to
 *      genuinely exercise the router's clamp+refund path) to cross
 *      GRADUATION_ETH_TARGET. Verifies graduation state, the
 *      GraduationLiquidityDeployed event, and independently cross-checks the
 *      resulting pool price/liquidity via StateView.
 *   5. Deploys GenericV4Bot — a minimal, Incentifi-agnostic PoolManager caller
 *      (contracts/v4/test-helpers/GenericV4Bot.sol). IncentifiV4Router.buyToken()
 *      /sellToken() both revert once a pool is graduated (PoolGraduated()) — it
 *      is deliberately pre-graduation-only. Post-graduation trading, and the
 *      hook's post-graduation fee mechanism specifically, can only be exercised
 *      via a raw PoolManager caller like this one (or a real generic V4 router).
 *   6. Real POST-graduation BUY via GenericV4Bot — exercises the hook's
 *      beforeSwap graduated-branch fee skim (buy side).
 *   7. Real POST-graduation SELL via GenericV4Bot — exercises the hook's
 *      afterSwap fee mechanism (sell side) — THE specific code path that exists
 *      only in the production hook and has never run against a real PoolManager
 *      before this.
 *   8. claimCreatorFees() — claims everything accrued across steps 2, 3, 4, 6, 7
 *      in one call, proving pre- and post-graduation credits land in the same
 *      pull-payment ledger.
 *
 * Every step asserts EXACT on-chain balance deltas (net of that step's own gas)
 * against what the contracts themselves report moving — wallet ETH/token
 * balances, the hook's own curveStates, and the REAL production LossRewardPool's
 * own ETH balance and totalDeposited(token) mapping (a real, pre-existing,
 * unmodified contract this script does not control). Where the exact AMM output
 * of a post-graduation trade isn't independently predictable off-chain without
 * reimplementing Uniswap's full concentrated-liquidity math, this script uses
 * publicClient.simulateContract() immediately before sending as the independent
 * oracle, then asserts the REAL observed balance delta matches that prediction
 * exactly — not just "the transaction didn't revert".
 *
 * SAFETY GATES — ALL required:
 *   - DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) — the SAME funded key used to deploy
 *   - DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET
 *   - V4_PRODUCTION_CONFIRM=I_ACKNOWLEDGE_V4_HOOK_IS_UNTESTED_ON_REAL_POOLMANAGER
 *   - GRADUATION_COST_CONFIRM=I_ACCEPT_PERMANENTLY_LOCKING_ABOUT_5_9_ETH_IN_AMM_LIQUIDITY
 *   - The hook/factory/router addresses, via V4_HOOK_ADDRESS / V4_FACTORY_ADDRESS /
 *     V4_ROUTER_ADDRESS env vars, or scripts/.v4-hook-deployment-result.json
 *     (written by deploy-v4-hook-production-mainnet.ts) if unset.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... \
 *   DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET \
 *   V4_PRODUCTION_CONFIRM=I_ACKNOWLEDGE_V4_HOOK_IS_UNTESTED_ON_REAL_POOLMANAGER \
 *   GRADUATION_COST_CONFIRM=I_ACCEPT_PERMANENTLY_LOCKING_ABOUT_5_9_ETH_IN_AMM_LIQUIDITY \
 *     npx hardhat run scripts/verify-v4-hook-production-mainnet.ts --network robinhoodMainnet
 *
 * CRASH / RPC-HICCUP SAFETY (automatic — no flag needed): identical mechanism to
 * verify-v3-fix-mainnet.ts and deploy-v4-hook-production-mainnet.ts. Every step's
 * tx hash (and any pre-send snapshot its later exact-delta assertion depends on)
 * is written to scripts/.v4-verify-state.json BEFORE this script ever waits on a
 * receipt. Re-running the exact same command resumes from whatever's already on
 * disk rather than resending anything — this matters enormously more here than in
 * the deploy script, given the graduating buy alone moves ~6 real ETH.
 */

import fs from 'node:fs';
import path from 'node:path';
import { network, artifacts } from 'hardhat';
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  getAddress,
  getContractAddress,
  formatEther,
  parseEther,
} from 'viem';

const CHAIN_ID = 4663;
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
const REAL_PRODUCTION_LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const BUY_AMOUNT_WEI = parseEther('0.005');

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

const RESULT_PATH = path.resolve('scripts', '.v4-hook-deployment-result.json');
const STATE_PATH = path.resolve('scripts', '.v4-verify-state.json');
const RECEIPT_RETRY_ATTEMPTS = Number(process.env.RECEIPT_RETRY_ATTEMPTS || 6);
const RECEIPT_RETRY_BASE_DELAY_MS = Number(process.env.RECEIPT_RETRY_DELAY_MS || 5000);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAddresses(): { hook: `0x${string}`; factory: `0x${string}`; router: `0x${string}` } {
  const envHook = process.env.V4_HOOK_ADDRESS;
  const envFactory = process.env.V4_FACTORY_ADDRESS;
  const envRouter = process.env.V4_ROUTER_ADDRESS;
  if (envHook && envFactory && envRouter) {
    return { hook: getAddress(envHook), factory: getAddress(envFactory), router: getAddress(envRouter) };
  }
  if (!fs.existsSync(RESULT_PATH)) {
    throw new Error(
      `Neither V4_HOOK_ADDRESS/V4_FACTORY_ADDRESS/V4_ROUTER_ADDRESS env vars nor ${RESULT_PATH} were found.\n` +
      `Run deploy-v4-hook-production-mainnet.ts first, or set all three env vars explicitly.`
    );
  }
  const deployResult = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
  return {
    hook: getAddress(deployResult.hook.address),
    factory: getAddress(deployResult.factory.address),
    router: getAddress(deployResult.router.address),
  };
}

function requireConfirmation() {
  if (process.env.DEPLOY_CONFIRM !== 'I_UNDERSTAND_THIS_IS_MAINNET') {
    throw new Error('\nSet DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET to proceed.\n');
  }
  if (process.env.V4_PRODUCTION_CONFIRM !== 'I_ACKNOWLEDGE_V4_HOOK_IS_UNTESTED_ON_REAL_POOLMANAGER') {
    throw new Error('\nSet V4_PRODUCTION_CONFIRM=I_ACKNOWLEDGE_V4_HOOK_IS_UNTESTED_ON_REAL_POOLMANAGER to proceed.\n');
  }
  if (process.env.GRADUATION_COST_CONFIRM !== 'I_ACCEPT_PERMANENTLY_LOCKING_ABOUT_5_9_ETH_IN_AMM_LIQUIDITY') {
    throw new Error(
      '\nThis script drives a REAL graduation, permanently locking ~5.85 ETH (~$14,000+ at recent prices) as ' +
      'AMM liquidity — non-refundable, by design, forever. See this file\'s header comment for the full breakdown.\n' +
      'Set GRADUATION_COST_CONFIRM=I_ACCEPT_PERMANENTLY_LOCKING_ABOUT_5_9_ETH_IN_AMM_LIQUIDITY to proceed.\n'
    );
  }
  const key = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
  if (!key) {
    throw new Error('DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) env var is required.');
  }
}

type StepRecord = {
  hash?: `0x${string}`;
  confirmed?: boolean;
  blockNumber?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  [key: string]: unknown;
};
type VerifyState = { hook: `0x${string}`; factory: `0x${string}`; router: `0x${string}`; wallet: `0x${string}`; steps: Record<string, StepRecord> };

function loadState(hook: `0x${string}`, factory: `0x${string}`, router: `0x${string}`, walletRaw: `0x${string}`): VerifyState {
  const wallet = getAddress(walletRaw);
  if (!fs.existsSync(STATE_PATH)) {
    return { hook, factory, router, wallet, steps: {} };
  }
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const sameRun =
    raw.hook && getAddress(raw.hook) === hook &&
    raw.factory && getAddress(raw.factory) === factory &&
    raw.router && getAddress(raw.router) === router &&
    raw.wallet && getAddress(raw.wallet) === wallet;
  if (!sameRun) {
    throw new Error(
      `${STATE_PATH} exists but is for a different hook/factory/router/wallet than this run.\n` +
      `  state file: hook=${raw.hook}, factory=${raw.factory}, router=${raw.router}, wallet=${raw.wallet}\n` +
      `  this run:   hook=${hook}, factory=${factory}, router=${router}, wallet=${wallet}\n` +
      `Move or delete ${STATE_PATH} by hand if that earlier run is done with. Refusing to guess, given a ` +
      `~6 ETH graduating buy may be involved.`
    );
  }
  const steps = raw.steps || {};
  if (Object.keys(steps).length > 0) {
    console.log(`[STATE] Found ${STATE_PATH} — resuming. Steps already recorded: ${Object.keys(steps).join(', ')}\n`);
  }
  return { hook, factory, router, wallet, steps };
}

function persistState(state: VerifyState) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

async function main() {
  requireConfirmation();
  const { hook: hookAddress, factory: factoryAddress, router: routerAddress } = resolveAddresses();

  const { viem } = await network.create('robinhoodMainnet');
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Chain ID mismatch! Expected ${CHAIN_ID}, got ${chainId}.`);

  const [wallet] = await viem.getWalletClients();
  const account = getAddress(wallet.account.address);

  console.log('\n============================================================');
  console.log('[VERIFY V4 HOOK — PRODUCTION] Robinhood Chain MAINNET (Chain ID 4663)');
  console.log('============================================================');
  console.log(`Wallet:  ${account}`);
  console.log(`Hook:    ${hookAddress}`);
  console.log(`Factory: ${factoryAddress}`);
  console.log(`Router:  ${routerAddress}`);
  console.log('============================================================\n');

  const state = loadState(hookAddress, factoryAddress, routerAddress, account);

  async function waitForReceiptWithRetry(hash: `0x${string}`, label: string) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RECEIPT_RETRY_ATTEMPTS; attempt++) {
      try {
        return await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 });
      } catch (err) {
        lastErr = err;
        const delay = RECEIPT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(
          `  [${label}] receipt wait attempt ${attempt}/${RECEIPT_RETRY_ATTEMPTS} failed ` +
          `(${err instanceof Error ? err.message : String(err)})` +
          (attempt < RECEIPT_RETRY_ATTEMPTS ? `; retrying in ${Math.round(delay / 1000)}s...` : '')
        );
        if (attempt < RECEIPT_RETRY_ATTEMPTS) await sleep(delay);
      }
    }
    throw new Error(
      `[${label}] Could not confirm receipt for tx ${hash} after ${RECEIPT_RETRY_ATTEMPTS} attempts. Check a block ` +
      `explorer before re-running — its hash is already in ${STATE_PATH}, so re-running resumes rather than resends.\n` +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  }

  async function runStep(
    name: string,
    sendFn: () => Promise<{ hash: `0x${string}`; [key: string]: unknown }>,
    precomputedExtra: Record<string, unknown> = {}
  ): Promise<StepRecord> {
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

  // Pre-flight: confirm the target contracts are real and correctly wired.
  const hookArtifact = await artifacts.readArtifact('IncentifiV4Hook');
  const hook = await viem.getContractAt('IncentifiV4Hook', hookAddress);
  const factory = await viem.getContractAt('IncentifiV4Factory', factoryAddress);
  const router = await viem.getContractAt('IncentifiV4Router', routerAddress);
  for (const [label, addr] of [['Hook', hookAddress], ['Factory', factoryAddress], ['Router', routerAddress]] as const) {
    const code = await publicClient.getCode({ address: addr });
    if (!code || code === '0x') throw new Error(`${label} ${addr} has empty code.`);
  }
  if (getAddress(await factory.read.hook()) !== hookAddress) throw new Error('factory.hook() does not match the given Hook.');
  if (getAddress(await router.read.hook()) !== hookAddress) throw new Error('router.hook() does not match the given Hook.');
  if (getAddress(await router.read.factory()) !== factoryAddress) throw new Error('router.factory() does not match the given Factory.');
  console.log('[PRE-FLIGHT] Hook/Factory/Router all have live code and are correctly cross-wired. OK.\n');

  // ==========================================================================
  // STAGE 1: launch a real test token
  // ==========================================================================
  console.log('[1/8] Test token launch...');
  const tokenDeployRecord = await runStep('tokenDeploy', async () => {
    const launchTokenArtifact = await artifacts.readArtifact('IncentifiLaunchToken');
    const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
    const address = getContractAddress({ from: account, nonce: BigInt(nonce) });
    const tokenName = `Incentifi V4 Verify ${Date.now()}`;
    const hash = await wallet.deployContract({
      abi: launchTokenArtifact.abi,
      bytecode: launchTokenArtifact.bytecode as `0x${string}`,
      args: [tokenName, 'IFV4', TOTAL_SUPPLY],
      nonce,
    });
    return { hash, address, tokenName };
  });
  const tokenAddress = getAddress(tokenDeployRecord.address as string);
  const launchTokenArtifact = await artifacts.readArtifact('IncentifiLaunchToken');
  const token = await viem.getContractAt('IncentifiLaunchToken', tokenAddress);
  console.log(`  Token: ${tokenAddress} ("${tokenDeployRecord.tokenName}")`);

  await runStep('approveFactory', async () => ({ hash: await token.write.approve([factoryAddress, TOTAL_SUPPLY]) }));
  await runStep('launchToken', async () => ({ hash: await factory.write.launchToken([tokenAddress]) }));

  const poolKey = await factory.read.getPoolKey([tokenAddress]);
  const poolId = keccak256(
    encodeAbiParameters(
      parseAbiParameters('address, address, uint24, int24, address'),
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    )
  );
  const curveAfterLaunch = await hook.read.curveStates([poolId]);
  // curveStates tuple order: token, creator, initialized, graduated, realEthReserve, realTokenReserve
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
    lossPoolBalanceBefore: (await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL })).toString(),
    lossPoolDepositedBefore: (
      await publicClient.readContract({
        address: REAL_PRODUCTION_LOSS_REWARD_POOL,
        abi: parseAbi(['function totalDeposited(address) view returns (uint256)']),
        functionName: 'totalDeposited',
        args: [tokenAddress],
      })
    ).toString(),
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
    const curveEthReserveAfter = ((await hook.read.curveStates([poolId]))[4] as bigint);
    const lossPoolBalanceAfter = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
    const lossPoolDepositedAfter = await publicClient.readContract({
      address: REAL_PRODUCTION_LOSS_REWARD_POOL,
      abi: parseAbi(['function totalDeposited(address) view returns (uint256)']),
      functionName: 'totalDeposited',
      args: [tokenAddress],
    });

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
    if (lossPoolDelta !== expectedFee) throw new Error(`Pre-grad buy: REAL LossRewardPool balance delta ${lossPoolDelta} != expected ${expectedFee}.`);
    if (lossPoolDepositedDelta !== expectedFee) throw new Error(`Pre-grad buy: LossRewardPool.totalDeposited(token) delta ${lossPoolDepositedDelta} != expected ${expectedFee}.`);
    console.log(`  Tokens received: ${tokensReceived}. Exact balance-delta assertions (wallet, curve, REAL LossRewardPool): PASS\n`);

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
    lossPoolBalanceBefore: (await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL })).toString(),
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
    const lossPoolBalanceAfter = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });

    const ethReceived = ethAfter - BigInt(b.ethBefore) + gasCost(sell1Record);
    const curveDelta = BigInt(b.curveEthReserveBefore) - curveEthReserveAfter; // gross released
    const expectedNet = curveDelta - curveDelta / 100n - curveDelta / 100n;
    const lossPoolDelta = lossPoolBalanceAfter - BigInt(b.lossPoolBalanceBefore);

    if (tokensAfter !== 0n) throw new Error(`Pre-grad sell: wallet still holds ${tokensAfter} tokens after selling all of them.`);
    if (ethReceived !== expectedNet) throw new Error(`Pre-grad sell: wallet received ${ethReceived}, expected exactly ${expectedNet}.`);
    if (lossPoolDelta !== curveDelta / 100n) throw new Error(`Pre-grad sell: LossRewardPool balance delta ${lossPoolDelta} != expected ${curveDelta / 100n}.`);
    console.log('  Exact balance-delta assertions: PASS\n');
  }

  // ==========================================================================
  // STAGE 4: drive a REAL graduation
  // ==========================================================================
  console.log('[4/8] Driving to a REAL graduation...');
  // Only compute (and choose an msg.value) when actually about to send for the
  // first time — resuming reuses whatever amount was already chosen and
  // persisted, never a freshly recomputed one, since live state has moved on.
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
    overshootGrossEth = (maxGrossEth * 105n) / 100n; // modest 1.05x to genuinely exercise the clamp+refund path
    const gasBuffer = parseEther('0.02'); // generous pad for 2 mints + 1 corrective swap
    const walletBalance = await publicClient.getBalance({ address: account });
    console.log(`  realEthReserve now: ${formatEther(realEthReserveNow)} ETH`);
    console.log(`  GRADUATION_ETH_TARGET: ${formatEther(graduationTarget)} ETH`);
    console.log(`  Exact clamp target (gross): ${formatEther(maxGrossEth)} ETH`);
    console.log(`  Sending (1.05x, to force the real clamp path): ${formatEther(overshootGrossEth)} ETH`);
    if (walletBalance < overshootGrossEth + gasBuffer) {
      throw new Error(
        `Wallet balance (${formatEther(walletBalance)} ETH) is insufficient for the graduating buy: needs ` +
        `${formatEther(overshootGrossEth)} ETH (msg.value, ~5% refunded in this same tx) plus a ${formatEther(gasBuffer)} ETH ` +
        `gas buffer. Fund the wallet before re-running.`
      );
    }
    gradSnapshotBefore = {
      ethBefore: walletBalance.toString(),
      curveEthReserveBefore: realEthReserveNow.toString(),
      lossPoolBalanceBefore: (await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL })).toString(),
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
    const lossPoolBalanceAfter = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });

    const netOutflow = BigInt(b.ethBefore) - ethAfter - gasCost(gradRecord);
    const curveDelta = curveEthReserveAfter - BigInt(b.curveEthReserveBefore);
    // Derive the ACTUAL grossEth the contract processed from the real netOutflow
    // (== whatever the contract's own live clamp decided), rather than trusting
    // the off-chain guess used only to size msg.value — robust to any live-state
    // drift between reading realEthReserve and this transaction executing.
    const actualGrossEth = netOutflow;
    const expectedCurveDelta = actualGrossEth - actualGrossEth / 100n - actualGrossEth / 100n;
    const expectedFee = actualGrossEth / 100n;
    const lossPoolDelta = lossPoolBalanceAfter - BigInt(b.lossPoolBalanceBefore);

    if (!graduated) throw new Error('state.graduated is not true after the graduating buy.');
    if (curveEthReserveAfter !== graduationTarget) throw new Error(`realEthReserve (${curveEthReserveAfter}) did not land exactly on GRADUATION_ETH_TARGET (${graduationTarget}).`);
    if (curveDelta !== expectedCurveDelta) throw new Error(`Graduating buy: curve delta ${curveDelta} != expected ${expectedCurveDelta} (derived from real netOutflow ${actualGrossEth}).`);
    if (lossPoolDelta !== expectedFee) throw new Error(`Graduating buy: LossRewardPool delta ${lossPoolDelta} != expected ${expectedFee}.`);
    console.log(`  Real gross ETH processed (derived from wallet outflow): ${formatEther(actualGrossEth)} ETH`);
    console.log('  state.graduated == true, realEthReserve == GRADUATION_ETH_TARGET exactly (confirmed)');

    const gradLogs = await publicClient.getContractEvents({
      address: hookAddress,
      abi: hookArtifact.abi,
      eventName: 'GraduationLiquidityDeployed',
      fromBlock: BigInt(gradRecord.blockNumber!),
      toBlock: BigInt(gradRecord.blockNumber!),
    });
    if (gradLogs.length !== 1) throw new Error(`Expected exactly 1 GraduationLiquidityDeployed event, got ${gradLogs.length}.`);
    const gradEvent = gradLogs[0].args as { bootstrapLiquidity: bigint; finalLiquidity: bigint; correctedSqrtPriceX96: bigint };
    const slot0PostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
    const liquidityPostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] });
    if (slot0PostGrad[0] !== gradEvent.correctedSqrtPriceX96) throw new Error('StateView post-grad price does not match the GraduationLiquidityDeployed event.');
    if (liquidityPostGrad !== gradEvent.bootstrapLiquidity + gradEvent.finalLiquidity) throw new Error('StateView post-grad liquidity does not match the event.');
    console.log('  Independent StateView cross-check of post-graduation price/liquidity: MATCH\n');
  }

  // ==========================================================================
  // STAGE 5: deploy GenericV4Bot — the only way to reach post-graduation trading
  // ==========================================================================
  console.log('[5/8] Deploying GenericV4Bot (Incentifi-agnostic raw PoolManager caller)...');
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
  // STAGE 6: real POST-graduation buy — exercises the beforeSwap graduated-branch skim
  // ==========================================================================
  console.log(`[6/8] Post-graduation buy of ${formatEther(BUY_AMOUNT_WEI)} ETH via GenericV4Bot...`);
  const buy2Before = (state.steps.postGradBuy?.before as Record<string, string>) ?? {
    ethBefore: (await publicClient.getBalance({ address: account })).toString(),
    tokensBefore: (await token.read.balanceOf([account])).toString(),
    lossPoolBalanceBefore: (await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL })).toString(),
    creatorBalanceBefore: ((await hook.read.creatorBalances([account])) as bigint).toString(),
  };
  let predictedBuy2Out: bigint | undefined = state.steps.postGradBuy?.predictedOut !== undefined
    ? BigInt(state.steps.postGradBuy.predictedOut as string)
    : undefined;
  if (predictedBuy2Out === undefined) {
    const sim = await publicClient.simulateContract({
      address: botAddress,
      abi: botArtifact.abi,
      functionName: 'swap',
      args: [poolKey, true, BUY_AMOUNT_WEI, 0n],
      account,
      value: BUY_AMOUNT_WEI,
    });
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
    const lossPoolBalanceAfter = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
    const creatorBalanceAfter = (await hook.read.creatorBalances([account])) as bigint;

    const ethSpent = BigInt(b.ethBefore) - ethAfter - gasCost(buy2Record);
    const tokensReceived = tokensAfter - BigInt(b.tokensBefore);

    const feeLogs = await publicClient.getContractEvents({
      address: hookAddress,
      abi: hookArtifact.abi,
      eventName: 'GraduatedFeeCollected',
      fromBlock: BigInt(buy2Record.blockNumber!),
      toBlock: BigInt(buy2Record.blockNumber!),
    });
    if (feeLogs.length !== 1) throw new Error(`Expected exactly 1 GraduatedFeeCollected event on post-grad buy, got ${feeLogs.length}.`);
    const feeEvent = feeLogs[0].args as { zeroForOne: boolean; creatorFee: bigint; lossPoolFee: bigint };
    if (feeEvent.zeroForOne !== true) throw new Error('Post-grad buy GraduatedFeeCollected.zeroForOne should be true.');

    if (ethSpent !== BUY_AMOUNT_WEI) throw new Error(`Post-grad buy: wallet spent ${ethSpent}, expected exactly ${BUY_AMOUNT_WEI}.`);
    if (tokensReceived !== predicted) throw new Error(`Post-grad buy: tokens received ${tokensReceived} != simulated prediction ${predicted}.`);
    if (lossPoolBalanceAfter - BigInt(b.lossPoolBalanceBefore) !== feeEvent.lossPoolFee) throw new Error('Post-grad buy: LossRewardPool delta != event.lossPoolFee.');
    if (creatorBalanceAfter - BigInt(b.creatorBalanceBefore) !== feeEvent.creatorFee) throw new Error('Post-grad buy: creatorBalances delta != event.creatorFee.');
    console.log(`  Tokens received: ${tokensReceived} (== simulated prediction, exact)`);
    console.log(`  GraduatedFeeCollected(zeroForOne=true): creatorFee=${feeEvent.creatorFee}, lossPoolFee=${feeEvent.lossPoolFee}`);
    console.log('  Exact balance-delta assertions (wallet ETH, tokens, REAL LossRewardPool, creatorBalances): PASS\n');

    if (buy2Record.tokensReceived === undefined) {
      buy2Record.tokensReceived = tokensReceived.toString();
      state.steps.postGradBuy = buy2Record;
      persistState(state);
    }
  }
  const postGradTokens = BigInt(buy2Record.tokensReceived as string);

  // ==========================================================================
  // STAGE 7: real POST-graduation sell — exercises the afterSwap fee mechanism,
  // the specific code path that has never run against a real PoolManager before.
  // ==========================================================================
  console.log(`[7/8] Post-graduation sell of ${postGradTokens} tokens via GenericV4Bot (afterSwap fee path)...`);
  await runStep('postGradSellApprove', async () => ({ hash: await token.write.approve([botAddress, postGradTokens]) }));

  const sell2Before = (state.steps.postGradSell?.before as Record<string, string>) ?? {
    ethBefore: (await publicClient.getBalance({ address: account })).toString(),
    lossPoolBalanceBefore: (await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL })).toString(),
    creatorBalanceBefore: ((await hook.read.creatorBalances([account])) as bigint).toString(),
  };
  let predictedSell2Out: bigint | undefined = state.steps.postGradSell?.predictedOut !== undefined
    ? BigInt(state.steps.postGradSell.predictedOut as string)
    : undefined;
  if (predictedSell2Out === undefined) {
    const sim = await publicClient.simulateContract({
      address: botAddress,
      abi: botArtifact.abi,
      functionName: 'swap',
      args: [poolKey, false, postGradTokens, 0n],
      account,
    });
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
    const lossPoolBalanceAfter = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
    const creatorBalanceAfter = (await hook.read.creatorBalances([account])) as bigint;

    const ethReceived = ethAfter - BigInt(b.ethBefore) + gasCost(sell2Record);

    const feeLogs = await publicClient.getContractEvents({
      address: hookAddress,
      abi: hookArtifact.abi,
      eventName: 'GraduatedFeeCollected',
      fromBlock: BigInt(sell2Record.blockNumber!),
      toBlock: BigInt(sell2Record.blockNumber!),
    });
    if (feeLogs.length !== 1) throw new Error(`Expected exactly 1 GraduatedFeeCollected event on post-grad sell, got ${feeLogs.length}.`);
    const feeEvent = feeLogs[0].args as { zeroForOne: boolean; creatorFee: bigint; lossPoolFee: bigint };
    if (feeEvent.zeroForOne !== false) throw new Error('Post-grad sell GraduatedFeeCollected.zeroForOne should be false — this is THE never-before-tested code path.');

    if (tokensAfter !== 0n) throw new Error(`Post-grad sell: wallet still holds ${tokensAfter} tokens after selling all of them.`);
    if (ethReceived !== predicted) throw new Error(`Post-grad sell: ETH received ${ethReceived} != simulated prediction ${predicted}.`);
    if (lossPoolBalanceAfter - BigInt(b.lossPoolBalanceBefore) !== feeEvent.lossPoolFee) throw new Error('Post-grad sell: LossRewardPool delta != event.lossPoolFee.');
    if (creatorBalanceAfter - BigInt(b.creatorBalanceBefore) !== feeEvent.creatorFee) throw new Error('Post-grad sell: creatorBalances delta != event.creatorFee.');
    console.log(`  ETH received: ${formatEther(ethReceived)} ETH (== simulated prediction, exact)`);
    console.log(`  GraduatedFeeCollected(zeroForOne=false): creatorFee=${feeEvent.creatorFee}, lossPoolFee=${feeEvent.lossPoolFee}`);
    console.log('  *** afterSwap sell-side fee mechanism confirmed working on REAL mainnet, real PoolManager, real production LossRewardPool ***');
    console.log('  Exact balance-delta assertions: PASS\n');
  }

  // ==========================================================================
  // STAGE 8: claim everything accrued across pre- and post-graduation trades
  // ==========================================================================
  console.log('[8/8] Claiming accrued creator fees (pre- + post-graduation, one ledger)...');
  const claimBefore = (state.steps.claim?.before as Record<string, string>) ?? {
    ethBefore: (await publicClient.getBalance({ address: account })).toString(),
    accruedBefore: ((await hook.read.creatorBalances([account])) as bigint).toString(),
  };
  const accruedBeforeClaim = BigInt(claimBefore.accruedBefore);
  console.log(`  creatorBalances(${account}) before claim: ${formatEther(accruedBeforeClaim)} ETH`);
  if (!state.steps.claim && accruedBeforeClaim <= 0n) {
    throw new Error('Expected a non-zero accrued creator balance from all the trades above, got 0.');
  }
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
  console.log('[VERIFY V4 HOOK — PRODUCTION] COMPLETE');
  console.log('============================================================');
  console.log('Every step confirmed on-chain with exact balance deltas, including the post-graduation');
  console.log('beforeSwap AND afterSwap fee mechanisms — both now proven against real mainnet, real');
  console.log('PoolManager, and the real production LossRewardPool for the first time.');
  console.log(JSON.stringify({
    hook: hookAddress,
    factory: factoryAddress,
    router: routerAddress,
    testToken: tokenAddress,
    poolId,
    genericV4Bot: botAddress,
    verifiedAt: new Date().toISOString(),
    result: 'ALL EXACT BALANCE-DELTA ASSERTIONS PASSED, INCLUDING POST-GRADUATION FEE MECHANISM',
  }, null, 2));
}

main().catch((err) => {
  console.error('\n[VERIFY V4 HOOK ERROR]', err instanceof Error ? err.message : err);
  console.error(`Progress so far (including any tx hashes already sent) is saved in ${STATE_PATH}.`);
  console.error('Re-running the exact same command will resume from here, not resend anything already sent —');
  console.error('this matters a great deal given the graduating buy alone moves ~6 real ETH.');
  process.exitCode = 1;
});
