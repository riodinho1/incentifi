/**
 * Deploys IncentifiV4HookProductionLogicTest — byte-for-byte the SAME logic as
 * the production IncentifiV4Hook.sol (six permission flags, including the
 * afterSwap post-graduation fee mechanism), with ONLY VIRTUAL_ETH and
 * GRADUATION_ETH_TARGET scaled down by the same 1/50 factor already proven on
 * real mainnet by IncentifiV4HookTestnet.sol — to REAL Robinhood Chain mainnet,
 * at roughly 1/50th the ETH cost of a production-scale run.
 *
 * ============================================================================
 * THE REAL PRODUCTION LossRewardPool IS NEVER TOUCHED BY THIS SCRIPT.
 * ============================================================================
 * This file never even references the real production LossRewardPool address
 * (0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF) as a usable value — it exists
 * below ONLY inside one impossible-equality safety assertion (mirroring the
 * same check scripts/deploy-testnet-mainnet.ts already used), so there is no
 * code path in this script that could wire the hook to it. This script deploys
 * a FRESH LossRewardPool from contracts/LossRewardPool.sol on every run and
 * wires the hook to THAT throwaway instance, exactly like
 * scripts/deploy-testnet-mainnet.ts already did for the 4-flag testnet hook.
 * ============================================================================
 *
 * Deploys, in order: a fresh throwaway LossRewardPool, then
 * IncentifiV4HookProductionLogicTest (mined CREATE2 salt, cross-checked
 * on-chain via HookMinerCheck — identical process to
 * deploy-v4-hook-production-mainnet.ts, same REQUIRED_FLAGS since the
 * permission set is identical to production), then the SAME, unmodified
 * IncentifiV4Factory.sol and IncentifiV4Router.sol contracts already deployed
 * for production (their logic has no dependency on the hook's economic
 * constants — they just call through to whatever hook address they're given).
 *
 * Every transaction goes through the plain viem WalletClient
 * (deployContract/sendTransaction/writeContract) — never Hardhat's own
 * viem.sendDeploymentTransaction() helper, for the same reason documented in
 * deploy-v4-hook-production-mainnet.ts (a real incident during the v3 mainnet
 * redeploy proved that helper's extra post-broadcast lookup can throw even
 * after the underlying transaction already succeeded, defeating resume logic
 * built on top of it).
 *
 * SAFETY GATES:
 *   - DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) — a funded Robinhood Chain mainnet key
 *   - DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET \
 *     npx hardhat run scripts/deploy-v4-hook-production-logic-test-mainnet.ts --network robinhoodMainnet
 *
 * CRASH / RPC-HICCUP SAFETY (automatic — no flag needed): identical mechanism
 * to every other script in this batch. Every step's tx hash is written to
 * scripts/.v4-logic-test-deployment-state.json BEFORE this script ever waits on
 * its receipt. Re-running the exact same command resumes rather than resends.
 */

import fs from 'node:fs';
import path from 'node:path';
import { network, artifacts } from 'hardhat';
import { keccak256, encodeAbiParameters, parseAbiParameters, concat, pad, toHex, getAddress, getContractAddress, formatEther } from 'viem';

const CHAIN_ID = 4663;
const CREATE2_FACTORY = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
// Present ONLY for the impossible-equality safety check below — never used as
// a constructor arg or wired to anything in this script. See the header comment.
const REAL_PRODUCTION_LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');

// getHookPermissions() is identical to the production hook's — same 6 flags,
// same REQUIRED_FLAGS, independently confirmed against
// test/hardhat/v4-hook-deployment.test.ts's own tested constant.
const REQUIRED_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 3n) | (1n << 6n) | (1n << 2n); // 10444 (0x28cc)
const FLAG_MASK = (1n << 14n) - 1n;
const MAX_SALT_SEARCH = 160_444;

const STATE_PATH = path.resolve('scripts', '.v4-logic-test-deployment-state.json');
const RESULT_PATH = path.resolve('scripts', '.v4-logic-test-deployment-result.json');
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
    throw new Error('\nSet DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET to proceed.\n');
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
  console.log('[DEPLOY V4 HOOK — PRODUCTION LOGIC, TEST SCALE] Robinhood Chain MAINNET');
  console.log('============================================================');
  console.log(`Deployer:                  ${account}`);
  console.log(`Balance:                   ${formatEther(balanceBefore)} ETH`);
  console.log(`CREATE2 singleton factory: ${CREATE2_FACTORY}`);
  console.log(`PoolManager:               ${POOL_MANAGER}`);
  console.log(`Required permission flags: ${REQUIRED_FLAGS} (0x${REQUIRED_FLAGS.toString(16)}) — same as production`);
  console.log('============================================================\n');

  if (balanceBefore === 0n) throw new Error(`Deployer ${account} has zero ETH balance on mainnet. Fund it before deploying.`);

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
  // Step 1: fresh, throwaway LossRewardPool — never the real production one.
  // ==========================================================================
  console.log('[1/6] Deploying a FRESH, throwaway LossRewardPool (never the real production one)...');
  const lossRewardPoolArtifact = await artifacts.readArtifact('LossRewardPool');
  const lrpRecord = await runStep('lossRewardPoolDeploy', async () => {
    const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
    const address = getContractAddress({ from: account, nonce: BigInt(nonce) });
    const hash = await wallet.deployContract({ abi: lossRewardPoolArtifact.abi, bytecode: lossRewardPoolArtifact.bytecode as `0x${string}`, args: [account], nonce });
    return { hash, address };
  });
  const lossRewardPoolAddress = getAddress(lrpRecord.address as string);
  if (lossRewardPoolAddress === REAL_PRODUCTION_LOSS_REWARD_POOL) {
    throw new Error('IMPOSSIBLE SAFETY CHECK FAILED: freshly deployed address matches the real production LossRewardPool. Stopping immediately.');
  }
  console.log(`  Throwaway LossRewardPool: ${lossRewardPoolAddress} (confirmed != real production pool)\n`);

  // ==========================================================================
  // Step 2: mine the CREATE2 salt for IncentifiV4HookProductionLogicTest
  // ==========================================================================
  console.log('[2/6] Mining CREATE2 salt for IncentifiV4HookProductionLogicTest...');
  const hookArtifact = await artifacts.readArtifact('IncentifiV4HookProductionLogicTest');
  const hookConstructorArgs = encodeAbiParameters(parseAbiParameters('address, address, address'), [POOL_MANAGER, lossRewardPoolAddress, account]);
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
  // Step 3: deploy the hook via CREATE2
  // ==========================================================================
  console.log('[3/6] Deploying IncentifiV4HookProductionLogicTest via CREATE2...');
  const hookDeployData = concat([pad(toHex(foundSalt), { size: 32 }), hookInitCode]);
  await runStep('hookDeploy', async () => ({ hash: await wallet.sendTransaction({ to: CREATE2_FACTORY, data: hookDeployData }) }));

  const hookCode = await publicClient.getCode({ address: foundHookAddress });
  if (!hookCode || hookCode === '0x') throw new Error(`Hook deployment succeeded but no code landed at ${foundHookAddress}.`);
  const deployedFlags = BigInt(foundHookAddress) & FLAG_MASK;
  if (deployedFlags !== REQUIRED_FLAGS) throw new Error(`Deployed hook permission bits (${deployedFlags}) != required (${REQUIRED_FLAGS}).`);
  console.log(`  eth_getCode: NON-EMPTY (${(hookCode.length - 2) / 2} bytes). Permission bits confirmed.`);

  const hookContract = await viem.getContractAt('IncentifiV4HookProductionLogicTest', foundHookAddress);
  const hookDeployerOnChain = getAddress(await hookContract.read.deployer());
  const hookLossRewardPoolOnChain = getAddress(await hookContract.read.lossRewardPool());
  if (hookDeployerOnChain !== account) throw new Error(`hook.deployer() mismatch: got ${hookDeployerOnChain}.`);
  if (hookLossRewardPoolOnChain !== lossRewardPoolAddress) throw new Error(`hook.lossRewardPool() mismatch: got ${hookLossRewardPoolOnChain}, expected the throwaway pool ${lossRewardPoolAddress}.`);
  if (hookLossRewardPoolOnChain === REAL_PRODUCTION_LOSS_REWARD_POOL) throw new Error('IMPOSSIBLE SAFETY CHECK FAILED: hook.lossRewardPool() is the REAL production pool. Stopping.');
  console.log(`  hook.deployer() == ${hookDeployerOnChain} (confirmed)`);
  console.log(`  hook.lossRewardPool() == ${hookLossRewardPoolOnChain} (confirmed == throwaway pool, NOT production)\n`);

  // ==========================================================================
  // Step 4: IncentifiV4Factory (same, unmodified production contract)
  // ==========================================================================
  console.log('[4/6] Deploying IncentifiV4Factory...');
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
  // Step 5: setFactory()
  // ==========================================================================
  console.log('[5/6] setFactory() (one-time wiring)...');
  const factoryBeforeWiring = getAddress(await hookContract.read.factory());
  if (factoryBeforeWiring === '0x0000000000000000000000000000000000000000') {
    await runStep('setFactory', async () => ({ hash: await wallet.writeContract({ address: foundHookAddress, abi: hookArtifact.abi, functionName: 'setFactory', args: [factoryAddress] }) }));
  } else {
    console.log(`  hook.factory() already set to ${factoryBeforeWiring} — skipping.`);
  }
  if (getAddress(await hookContract.read.factory()) !== factoryAddress) throw new Error('hook.factory() does not match the deployed Factory after wiring.');
  console.log('  hook.factory() confirmed.\n');

  // ==========================================================================
  // Step 6: IncentifiV4Router (same, unmodified production contract)
  // ==========================================================================
  console.log('[6/6] Deploying IncentifiV4Router...');
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

  const balanceAfter = await publicClient.getBalance({ address: account });
  const result = {
    chainId,
    deployer: account,
    lossRewardPool: { address: lossRewardPoolAddress, throwaway: true },
    hook: { address: foundHookAddress, salt: foundSalt.toString(), constructorArgs: { poolManager: POOL_MANAGER, lossRewardPool: lossRewardPoolAddress, deployer: account } },
    factory: { address: factoryAddress, constructorArgs: { poolManager: POOL_MANAGER, hook: foundHookAddress } },
    router: { address: routerAddress, constructorArgs: { poolManager: POOL_MANAGER, hook: foundHookAddress, factory: factoryAddress } },
    gasSpentWei: (balanceBefore - balanceAfter).toString(),
    gasSpentEth: formatEther(balanceBefore - balanceAfter),
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));

  console.log('============================================================');
  console.log('[DEPLOY V4 HOOK — PRODUCTION LOGIC, TEST SCALE] COMPLETE');
  console.log('============================================================');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSaved to ${RESULT_PATH}`);
  console.log(`Total gas spent: ${formatEther(balanceBefore - balanceAfter)} ETH`);
}

main().catch((err) => {
  console.error('\n[DEPLOY ERROR]', err instanceof Error ? err.message : err);
  console.error(`Progress so far is saved in ${STATE_PATH}. Re-running the exact same command resumes, not resends.`);
  process.exitCode = 1;
});
