/**
 * Deploys IncentifiV4HookNoPostGradFee — the CORE IncentifiV4Hook bonding-curve
 * + graduation logic, WITHOUT the afterSwap post-graduation fee mechanism (four
 * permission flags, not six) — to REAL Robinhood Chain mainnet, at FULL
 * production economics ($5,000 launch / $69,000 graduation, unscaled), wired to
 * the REAL production LossRewardPool (0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF).
 *
 * ============================================================================
 * WHAT THIS IS AND ISN'T:
 * ============================================================================
 * contracts/v4/IncentifiV4HookNoPostGradFee.sol is NOT a from-scratch strip-down
 * of IncentifiV4Hook.sol. There is no separate git commit for "the hook before
 * afterSwap was added" — the whole V4 system landed in one commit. Instead, this
 * is contracts/v4/test-deployment/IncentifiV4HookTestnet.sol's logic verbatim
 * (that file already IS this exact pre-afterSwap shape: 4 permission flags, a
 * plain ZERO_DELTA pass-through once graduated, no fee of any kind on
 * post-graduation trades) — already proven on a fork AND on real Robinhood
 * Chain mainnet this morning via scripts/deploy-testnet-mainnet.ts — with ONLY
 * its economic constants restored to full production scale and wired to the
 * real production LossRewardPool instead of a throwaway one.
 *
 * Once graduated, a pool deployed against this hook becomes a completely
 * standard, fee-free-from-Incentifi permissionless V4 pool — no 2% protocol
 * fee, no creator fee, no LossRewardPool deposit on ANY post-graduation trade.
 * That is the deliberate trade-off for dropping afterSwap: real post-graduation
 * revenue, in exchange for only ever running logic already proven end-to-end on
 * real mainnet (at smaller scale).
 *
 * This IS the first time production economics + the real production
 * LossRewardPool have been combined with this specific logic anywhere (fork or
 * mainnet) — the graduation/liquidity-deposit mechanics themselves are
 * unchanged from what already ran on real mainnet this morning, so the risk is
 * materially lower than deploying the six-flag hook untested, but this exact
 * combination has not itself been exercised end-to-end before this deployment.
 *
 * Mines a CREATE2 salt for the 4-flag permission set (a DIFFERENT REQUIRED_FLAGS
 * value than the six-flag production hook), deploys IncentifiV4HookNoPostGradFee,
 * then the SAME, unmodified IncentifiV4Factory.sol and IncentifiV4Router.sol
 * contracts already used everywhere else in this V4 batch (their logic has no
 * dependency on the hook's economics or permission set — they just call through
 * to whatever hook address they're given), with setFactory() wiring in between.
 *
 * Every transaction goes through the plain viem WalletClient
 * (deployContract/sendTransaction/writeContract) — never Hardhat's own
 * viem.sendDeploymentTransaction() helper, for the same reason documented in
 * every other deploy script in this batch (a real incident during the v3
 * mainnet redeploy proved that helper's extra post-broadcast lookup can throw
 * even after the underlying transaction already succeeded, defeating any
 * resume logic built on top of it).
 *
 * SAFETY GATES:
 *   - DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) — a funded Robinhood Chain mainnet key
 *   - DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET \
 *     npx hardhat run scripts/deploy-v4-hook-no-postgrad-fee-mainnet.ts --network robinhoodMainnet
 *
 * Does NOT launch a token, buy, sell, or drive graduation — scope here is
 * exactly "deploy hook + factory + router, verify every constructor argument
 * on-chain", matching deploy-v4-hook-production-mainnet.ts's scope. Note that
 * driving a real graduation on THIS hook still costs the same ~5.9 ETH
 * production graduation target as the six-flag hook — dropping afterSwap
 * changes what happens AFTER graduation, not the cost of reaching it.
 *
 * CRASH / RPC-HICCUP SAFETY (automatic — no flag needed): every step's tx hash
 * is written to scripts/.v4-no-postgrad-fee-deployment-state.json BEFORE this
 * script ever waits on its receipt. Re-running the exact same command resumes
 * rather than resends.
 */

import fs from 'node:fs';
import path from 'node:path';
import { network, artifacts } from 'hardhat';
import { keccak256, encodeAbiParameters, parseAbiParameters, concat, pad, toHex, getAddress, getContractAddress, formatEther } from 'viem';

const CHAIN_ID = 4663;
const CREATE2_FACTORY = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const REAL_PRODUCTION_LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');

// getHookPermissions() for IncentifiV4HookNoPostGradFee: beforeInitialize(1<<13) |
// beforeAddLiquidity(1<<11) | beforeSwap(1<<7) | beforeSwapReturnDelta(1<<3) only —
// NO afterSwap/afterSwapReturnDelta. Same value scripts/deploy-testnet-mainnet.ts
// already used and proved correct on real mainnet this morning (same 4-flag shape,
// different economics/pool).
const REQUIRED_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 3n); // 10376 (0x2888)
const FLAG_MASK = (1n << 14n) - 1n;
const MAX_SALT_SEARCH = 160_444;

const STATE_PATH = path.resolve('scripts', '.v4-no-postgrad-fee-deployment-state.json');
const RESULT_PATH = path.resolve('scripts', '.v4-no-postgrad-fee-deployment-result.json');
const RECEIPT_RETRY_ATTEMPTS = Number(process.env.RECEIPT_RETRY_ATTEMPTS || 6);
const RECEIPT_RETRY_BASE_DELAY_MS = Number(process.env.RECEIPT_RETRY_DELAY_MS || 5000);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeCreate2Address(deployer: `0x${string}`, salt: bigint, initCodeHash: `0x${string}`): `0x${string}` {
  const packed = concat(['0xff', deployer, pad(toHex(salt), { size: 32 }), initCodeHash]);
  return getAddress(`0x${keccak256(packed).slice(-40)}`);
}

function requireConfirmation() {
  if (process.env.DEPLOY_CONFIRM !== 'I_UNDERSTAND_THIS_IS_MAINNET') {
    throw new Error(
      '\nRefusing to run: this deploys NEW, IMMUTABLE contracts to REAL Robinhood Chain mainnet, wired to the ' +
      'REAL production LossRewardPool, at real production economics.\n' +
      'Set DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET to proceed.\n'
    );
  }
  const key = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
  if (!key) {
    throw new Error('DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) env var is required to deploy.');
  }
}

type StepRecord = { hash?: `0x${string}`; confirmed?: boolean; blockNumber?: string; gasUsed?: string; effectiveGasPrice?: string; [key: string]: unknown };
type DeployState = { wallet: `0x${string}`; steps: Record<string, StepRecord> };

function loadState(walletRaw: `0x${string}`): DeployState {
  const wallet = getAddress(walletRaw);
  if (!fs.existsSync(STATE_PATH)) return { wallet, steps: {} };
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (!raw.wallet || getAddress(raw.wallet) !== wallet) {
    throw new Error(
      `${STATE_PATH} exists but is for a different wallet than this run (state: ${raw.wallet}, this run: ${wallet}).\n` +
      `Move or delete ${STATE_PATH} by hand before re-running with a different wallet.`
    );
  }
  const steps = raw.steps || {};
  if (Object.keys(steps).length > 0) {
    console.log(`[STATE] Found ${STATE_PATH} — resuming. Steps already recorded: ${Object.keys(steps).join(', ')}\n`);
  }
  return { wallet, steps };
}

function persistState(state: DeployState) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

async function main() {
  requireConfirmation();

  const { viem } = await network.create('robinhoodMainnet');
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Chain ID mismatch! Expected ${CHAIN_ID}, got ${chainId}.`);

  const [wallet] = await viem.getWalletClients();
  const account = getAddress(wallet.account.address);
  const balanceBefore = await publicClient.getBalance({ address: account });

  console.log('\n============================================================');
  console.log('[DEPLOY V4 HOOK — NO POST-GRAD FEE, PRODUCTION ECONOMICS] Robinhood Chain MAINNET');
  console.log('============================================================');
  console.log(`Deployer:                       ${account}`);
  console.log(`Balance:                        ${formatEther(balanceBefore)} ETH`);
  console.log(`CREATE2 singleton factory:      ${CREATE2_FACTORY}`);
  console.log(`PoolManager:                    ${POOL_MANAGER}`);
  console.log(`REAL production LossRewardPool: ${REAL_PRODUCTION_LOSS_REWARD_POOL}`);
  console.log(`Required permission flags:      ${REQUIRED_FLAGS} (0x${REQUIRED_FLAGS.toString(16)}) — FOUR flags, no afterSwap`);
  console.log('============================================================\n');

  if (balanceBefore === 0n) throw new Error(`Deployer ${account} has zero ETH balance on mainnet. Fund it before deploying.`);

  const prodPoolBalanceBefore = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });

  const state = loadState(account);

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

  // ==========================================================================
  // Step 1: mine the CREATE2 salt for IncentifiV4HookNoPostGradFee
  // ==========================================================================
  console.log('[1/5] Mining CREATE2 salt for IncentifiV4HookNoPostGradFee...');
  const hookArtifact = await artifacts.readArtifact('IncentifiV4HookNoPostGradFee');
  const hookConstructorArgs = encodeAbiParameters(parseAbiParameters('address, address, address'), [POOL_MANAGER, REAL_PRODUCTION_LOSS_REWARD_POOL, account]);
  const hookInitCode = concat([hookArtifact.bytecode as `0x${string}`, hookConstructorArgs]);
  const hookInitCodeHash = keccak256(hookInitCode);

  let foundSalt: bigint | null = null;
  let foundHookAddress: `0x${string}` | null = null;
  const searchStart = Date.now();
  for (let salt = 0n; salt < BigInt(MAX_SALT_SEARCH); salt++) {
    const candidate = computeCreate2Address(CREATE2_FACTORY, salt, hookInitCodeHash);
    if ((BigInt(candidate) & FLAG_MASK) === REQUIRED_FLAGS) {
      foundSalt = salt;
      foundHookAddress = candidate;
      break;
    }
  }
  if (foundSalt === null || foundHookAddress === null) throw new Error(`No valid CREATE2 salt found within ${MAX_SALT_SEARCH} attempts.`);
  console.log(`  Found salt ${foundSalt} after ${Date.now() - searchStart}ms (off-chain, zero gas)`);
  console.log(`  Predicted hook address: ${foundHookAddress}`);

  const hookMinerCheckArtifact = await artifacts.readArtifact('HookMinerCheck');
  const hmcRecord = await runStep('hookMinerCheckDeploy', async () => {
    const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
    const address = getContractAddress({ from: account, nonce: BigInt(nonce) });
    const hash = await wallet.deployContract({ abi: hookMinerCheckArtifact.abi, bytecode: hookMinerCheckArtifact.bytecode as `0x${string}`, nonce });
    return { hash, address };
  });
  const hookMinerCheck = await viem.getContractAt('HookMinerCheck', getAddress(hmcRecord.address as string));
  const onChainComputed = getAddress(await hookMinerCheck.read.computeAddress([CREATE2_FACTORY, foundSalt, hookInitCode]));
  if (onChainComputed !== foundHookAddress) throw new Error('JS-computed hook address does not match the REAL on-chain HookMiner library. Stopping.');
  console.log(`  Cross-checked against real HookMiner.computeAddress(): MATCH\n`);

  // Only meaningful before hookDeploy has ever been sent — on a resume where
  // state.steps.hookDeploy is already on record, code at this address is the
  // EXPECTED, successful outcome of that prior run, not a collision to abort
  // on. Checking unconditionally here previously broke every resume: the
  // legitimate "already deployed" case looked identical to the genuinely
  // impossible "salt collision" case this check exists to catch.
  if (!state.steps.hookDeploy) {
    const codeAtPredicted = await publicClient.getCode({ address: foundHookAddress });
    if (codeAtPredicted && codeAtPredicted !== '0x') throw new Error(`Predicted hook address ${foundHookAddress} already has code. Stopping.`);
  }

  // ==========================================================================
  // Step 2: deploy the hook via CREATE2
  // ==========================================================================
  console.log('[2/5] Deploying IncentifiV4HookNoPostGradFee via CREATE2...');
  const hookDeployData = concat([pad(toHex(foundSalt), { size: 32 }), hookInitCode]);
  await runStep('hookDeploy', async () => ({ hash: await wallet.sendTransaction({ to: CREATE2_FACTORY, data: hookDeployData }) }));

  const hookCode = await publicClient.getCode({ address: foundHookAddress });
  if (!hookCode || hookCode === '0x') throw new Error(`Hook deployment succeeded but no code landed at ${foundHookAddress}.`);
  const deployedFlags = BigInt(foundHookAddress) & FLAG_MASK;
  if (deployedFlags !== REQUIRED_FLAGS) throw new Error(`Deployed hook permission bits (${deployedFlags}) != required (${REQUIRED_FLAGS}).`);
  console.log(`  eth_getCode: NON-EMPTY (${(hookCode.length - 2) / 2} bytes). Permission bits confirmed.`);

  const hookContract = await viem.getContractAt('IncentifiV4HookNoPostGradFee', foundHookAddress);
  const hookDeployerOnChain = getAddress(await hookContract.read.deployer());
  const hookLossRewardPoolOnChain = getAddress(await hookContract.read.lossRewardPool());
  if (hookDeployerOnChain !== account) throw new Error(`hook.deployer() mismatch: got ${hookDeployerOnChain}.`);
  if (hookLossRewardPoolOnChain !== REAL_PRODUCTION_LOSS_REWARD_POOL) {
    throw new Error(`hook.lossRewardPool() mismatch: got ${hookLossRewardPoolOnChain}, expected the REAL production pool ${REAL_PRODUCTION_LOSS_REWARD_POOL}.`);
  }
  const hookGraduationTarget = await hookContract.read.GRADUATION_ETH_TARGET();
  if (hookGraduationTarget !== 5_853_863_234_375_000_000n) throw new Error(`hook.GRADUATION_ETH_TARGET() (${hookGraduationTarget}) is not the full production value.`);
  console.log(`  hook.deployer() == ${hookDeployerOnChain} (confirmed)`);
  console.log(`  hook.lossRewardPool() == ${hookLossRewardPoolOnChain} (confirmed == REAL production pool)`);
  console.log(`  hook.GRADUATION_ETH_TARGET() == ${formatEther(hookGraduationTarget)} ETH (confirmed == full production target)\n`);

  // ==========================================================================
  // Step 3: IncentifiV4Factory (same, unmodified production contract)
  // ==========================================================================
  console.log('[3/5] Deploying IncentifiV4Factory...');
  const factoryArtifact = await artifacts.readArtifact('IncentifiV4Factory');
  const factoryRecord = await runStep('factoryDeploy', async () => {
    const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
    const address = getContractAddress({ from: account, nonce: BigInt(nonce) });
    const hash = await wallet.deployContract({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode as `0x${string}`, args: [POOL_MANAGER, foundHookAddress], nonce });
    return { hash, address };
  });
  const factoryAddress = getAddress(factoryRecord.address as string);
  const factoryContract = await viem.getContractAt('IncentifiV4Factory', factoryAddress);
  if (getAddress(await factoryContract.read.poolManager()) !== POOL_MANAGER) throw new Error('factory.poolManager() mismatch.');
  if (getAddress(await factoryContract.read.hook()) !== foundHookAddress) throw new Error('factory.hook() mismatch.');
  console.log(`  Factory: ${factoryAddress} (confirmed)\n`);

  // ==========================================================================
  // Step 4: setFactory()
  // ==========================================================================
  console.log('[4/5] setFactory() (one-time wiring)...');
  const factoryBeforeWiring = getAddress(await hookContract.read.factory());
  if (factoryBeforeWiring === '0x0000000000000000000000000000000000000000') {
    await runStep('setFactory', async () => ({ hash: await wallet.writeContract({ address: foundHookAddress, abi: hookArtifact.abi, functionName: 'setFactory', args: [factoryAddress] }) }));
  } else {
    console.log(`  hook.factory() already set to ${factoryBeforeWiring} — skipping.`);
  }
  if (getAddress(await hookContract.read.factory()) !== factoryAddress) throw new Error('hook.factory() does not match the deployed Factory after wiring.');
  console.log('  hook.factory() confirmed.\n');

  // ==========================================================================
  // Step 5: IncentifiV4Router (same, unmodified production contract)
  // ==========================================================================
  console.log('[5/5] Deploying IncentifiV4Router...');
  const routerArtifact = await artifacts.readArtifact('IncentifiV4Router');
  const routerRecord = await runStep('routerDeploy', async () => {
    const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
    const address = getContractAddress({ from: account, nonce: BigInt(nonce) });
    const hash = await wallet.deployContract({ abi: routerArtifact.abi, bytecode: routerArtifact.bytecode as `0x${string}`, args: [POOL_MANAGER, foundHookAddress, factoryAddress], nonce });
    return { hash, address };
  });
  const routerAddress = getAddress(routerRecord.address as string);
  const routerContract = await viem.getContractAt('IncentifiV4Router', routerAddress);
  if (getAddress(await routerContract.read.poolManager()) !== POOL_MANAGER) throw new Error('router.poolManager() mismatch.');
  if (getAddress(await routerContract.read.hook()) !== foundHookAddress) throw new Error('router.hook() mismatch.');
  if (getAddress(await routerContract.read.factory()) !== factoryAddress) throw new Error('router.factory() mismatch.');
  console.log(`  Router: ${routerAddress} (confirmed)\n`);

  // Deployment itself should never touch the real production LossRewardPool's balance.
  const prodPoolBalanceAfter = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
  if (prodPoolBalanceAfter !== prodPoolBalanceBefore) {
    throw new Error(`Real production LossRewardPool balance CHANGED during deployment (${formatEther(prodPoolBalanceBefore)} -> ${formatEther(prodPoolBalanceAfter)} ETH). Investigate before trusting anything above.`);
  }
  console.log(`Confirmed: real production LossRewardPool balance unchanged (${formatEther(prodPoolBalanceAfter)} ETH).\n`);

  const balanceAfter = await publicClient.getBalance({ address: account });
  const result = {
    chainId,
    deployer: account,
    hook: {
      address: foundHookAddress,
      salt: foundSalt.toString(),
      permissionFlags: REQUIRED_FLAGS.toString(),
      hasPostGraduationFee: false,
      constructorArgs: { poolManager: POOL_MANAGER, lossRewardPool: REAL_PRODUCTION_LOSS_REWARD_POOL, deployer: account },
    },
    factory: { address: factoryAddress, constructorArgs: { poolManager: POOL_MANAGER, hook: foundHookAddress } },
    router: { address: routerAddress, constructorArgs: { poolManager: POOL_MANAGER, hook: foundHookAddress, factory: factoryAddress } },
    gasSpentWei: (balanceBefore - balanceAfter).toString(),
    gasSpentEth: formatEther(balanceBefore - balanceAfter),
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));

  console.log('============================================================');
  console.log('[DEPLOY V4 HOOK — NO POST-GRAD FEE] COMPLETE');
  console.log('============================================================');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSaved to ${RESULT_PATH}`);
  console.log(`Total gas spent: ${formatEther(balanceBefore - balanceAfter)} ETH`);
  console.log('\nReminder: this hook takes NO fee of any kind on post-graduation trades. Driving a real');
  console.log('graduation on it still costs the full ~5.9 ETH production target — that cost is unchanged.');
}

main().catch((err) => {
  console.error('\n[DEPLOY ERROR]', err instanceof Error ? err.message : err);
  console.error(`Progress so far is saved in ${STATE_PATH}. Re-running the exact same command resumes, not resends.`);
  process.exitCode = 1;
});
