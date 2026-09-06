/**
 * Deploys the PRODUCTION IncentifiV4Hook (contracts/v4/IncentifiV4Hook.sol — NOT
 * contracts/v4/test-deployment/IncentifiV4HookTestnet.sol) to REAL Robinhood Chain
 * mainnet, wired to the REAL production LossRewardPool
 * (0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF), using the production $5,000-launch /
 * $69,000-graduation economic constants (identical to the v3 IncentifiBondingCurve).
 * Then deploys IncentifiV4Factory and IncentifiV4Router wired to that hook.
 *
 * ============================================================================
 * READ THIS BEFORE RUNNING — risk this script cannot verify away:
 * ============================================================================
 * contracts/v4/IncentifiV4Hook.sol and contracts/v4/IncentifiV4Router.sol both carry
 * their own header comment: "STATUS: UNTESTED ... has never executed against a real
 * PoolManager." The only V4 code proven end-to-end on REAL Robinhood Chain mainnet so
 * far is IncentifiV4HookTestnet.sol (scripts/deploy-testnet-mainnet.ts) — a DIFFERENT
 * contract with a SMALLER permission-bit set (4 flags: beforeInitialize,
 * beforeAddLiquidity, beforeSwap, beforeSwapReturnDelta). The PRODUCTION hook this
 * script deploys adds TWO more flags (afterSwap, afterSwapReturnDelta) for an entirely
 * new code path — the post-graduation sell-side fee mechanism — that has ONLY ever run
 * on a simulated EDR fork (test/hardhat/v4-graduated-fee.test.ts), never against a
 * real PoolManager. This deployment is also the FIRST time any V4 code touches the
 * REAL production LossRewardPool — every prior real-mainnet V4 run deliberately used a
 * fresh throwaway pool instead, specifically because of this same untested status.
 * None of that makes the contract wrong — the fork tests that do exist found and fixed
 * several real bugs already (see the "FIXED"/"CORRECTED" comments in
 * IncentifiV4Router.sol) — but it is a materially different risk profile from "same
 * process as the testnet deployment," and this script cannot make that determination
 * for you. Hence V4_PRODUCTION_CONFIRM below, in addition to DEPLOY_CONFIRM.
 * ============================================================================
 *
 * Mirrors the mining/verification process already proven in
 * test/hardhat/v4-hook-deployment.test.ts (Stage 1) and scripts/deploy-testnet-mainnet.ts,
 * with two deliberate departures from both:
 *   1. Uses IncentifiV4Hook (production), the real production LossRewardPool, and the
 *      correct 6-flag REQUIRED_FLAGS for its actual getHookPermissions() — NOT the
 *      4-flag testnet value.
 *   2. Every transaction goes through the plain viem WalletClient (deployContract /
 *      sendTransaction / writeContract), never Hardhat's own
 *      viem.sendDeploymentTransaction() helper — that helper makes an extra
 *      publicClient.getTransaction() round-trip immediately after broadcasting, purely
 *      to recover the tx's nonce for CREATE address computation, and a real incident
 *      during the v3 mainnet redeploy proved that follow-up call can throw on this RPC
 *      even though the underlying transaction already succeeded — before ever handing
 *      the hash back to the caller, defeating any retry/resume logic built on top of
 *      it. This script computes ordinary-CREATE addresses itself from a nonce fetched
 *      BEFORE sending (CREATE2 addresses need no such trick — they're already fully
 *      deterministic from the salt+initcode alone), so a hash is always known and
 *      persisted to disk the instant a transaction is actually broadcast.
 *
 * CRASH / RPC-HICCUP SAFETY (automatic — no flag needed): identical mechanism to
 * verify-v3-fix-mainnet.ts. Every step's tx hash (and anything else needed to resume
 * it, e.g. a pre-computed CREATE address) is written to
 * scripts/.v4-hook-deployment-state.json BEFORE this script ever waits on its receipt.
 * If a receipt wait fails (retried with backoff first — 6 attempts, 5s/10s/20s/40s/
 * 80s/160s by default; override via RECEIPT_RETRY_ATTEMPTS / RECEIPT_RETRY_DELAY_MS)
 * or the process dies outright, re-run the EXACT SAME command: any step already on
 * disk is never re-sent, only re-polled for its receipt.
 *
 * SAFETY GATES — ALL required:
 *   - DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) — a funded Robinhood Chain mainnet key
 *   - DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET
 *   - V4_PRODUCTION_CONFIRM=I_ACKNOWLEDGE_V4_HOOK_IS_UNTESTED_ON_REAL_POOLMANAGER
 *     (see the risk section above — this is deliberately a separate, explicitly-named
 *     flag from DEPLOY_CONFIRM, not reused, because the risk it acknowledges is
 *     specific to this contract's test status and this being the real production
 *     LossRewardPool's first-ever exposure to V4 code, not just "this is mainnet.")
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... \
 *   DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET \
 *   V4_PRODUCTION_CONFIRM=I_ACKNOWLEDGE_V4_HOOK_IS_UNTESTED_ON_REAL_POOLMANAGER \
 *     npx hardhat run scripts/deploy-v4-hook-production-mainnet.ts --network robinhoodMainnet
 *
 * Does NOT launch a token, buy, sell, or drive graduation — scope here is exactly
 * "deploy hook + factory + router, verify every constructor argument on-chain." A
 * separate verify script (mirroring verify-v3-fix-mainnet.ts) is the natural next step
 * once this is done, not folded into this one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { network, artifacts } from 'hardhat';
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  pad,
  toHex,
  getAddress,
  getContractAddress,
  formatEther,
} from 'viem';

const CHAIN_ID = 4663;
const CREATE2_FACTORY = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
// The REAL production pool — deliberately hardcoded, not an env var or CLI arg, so
// there is no way to accidentally point this specific script at a throwaway one.
const REAL_PRODUCTION_LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');

// getHookPermissions() for the PRODUCTION hook (contracts/v4/IncentifiV4Hook.sol):
// beforeInitialize(1<<13) | beforeAddLiquidity(1<<11) | beforeSwap(1<<7) |
// beforeSwapReturnDelta(1<<3) | afterSwap(1<<6) | afterSwapReturnDelta(1<<2).
// Independently confirmed against test/hardhat/v4-hook-deployment.test.ts's own
// REQUIRED_FLAGS constant (= 10444 = 0x28cc), which that fork test asserts on-chain
// against the actually-deployed hook's address. NOT the same value as the 4-flag
// testnet hook (IncentifiV4HookTestnet.sol) used by scripts/deploy-testnet-mainnet.ts.
const REQUIRED_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 3n) | (1n << 6n) | (1n << 2n); // 10444 (0x28cc)
const FLAG_MASK = (1n << 14n) - 1n; // Hooks.ALL_HOOK_MASK
const MAX_SALT_SEARCH = 160_444; // same cap HookMiner.sol's own find() loop uses

const STATE_PATH = path.resolve('scripts', '.v4-hook-deployment-state.json');
const RESULT_PATH = path.resolve('scripts', '.v4-hook-deployment-result.json');
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
      '\nRefusing to run: this deploys NEW, IMMUTABLE contracts to REAL Robinhood Chain ' +
      'mainnet using REAL ETH.\nSet DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET to proceed.\n'
    );
  }
  if (process.env.V4_PRODUCTION_CONFIRM !== 'I_ACKNOWLEDGE_V4_HOOK_IS_UNTESTED_ON_REAL_POOLMANAGER') {
    throw new Error(
      '\nRefusing to run: IncentifiV4Hook.sol / IncentifiV4Router.sol are self-documented as ' +
      '"UNTESTED ... has never executed against a real PoolManager", and this is the first time ' +
      'any V4 code touches the REAL production LossRewardPool (every prior real-mainnet V4 run used ' +
      'a throwaway pool instead). Read the header comment in this file for the full risk explanation.\n' +
      'Set V4_PRODUCTION_CONFIRM=I_ACKNOWLEDGE_V4_HOOK_IS_UNTESTED_ON_REAL_POOLMANAGER to proceed.\n'
    );
  }
  const key = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
  if (!key) {
    throw new Error('DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) env var is required to deploy.');
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
type DeployState = { wallet: `0x${string}`; steps: Record<string, StepRecord> };

function loadState(walletAddressRaw: `0x${string}`): DeployState {
  const walletAddress = getAddress(walletAddressRaw);
  if (!fs.existsSync(STATE_PATH)) {
    return { wallet: walletAddress, steps: {} };
  }
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (!raw.wallet || getAddress(raw.wallet) !== walletAddress) {
    throw new Error(
      `${STATE_PATH} exists but is for a different wallet than this run (state: ${raw.wallet}, this run: ${walletAddress}).\n` +
      `If that earlier run's transactions are done with (all confirmed, or safely abandoned before anything was ` +
      `sent), move or delete ${STATE_PATH} by hand before re-running with a different wallet.`
    );
  }
  const steps = raw.steps || {};
  if (Object.keys(steps).length > 0) {
    console.log(`[STATE] Found ${STATE_PATH} — resuming. Steps already recorded: ${Object.keys(steps).join(', ')}\n`);
  }
  return { wallet: walletAddress, steps };
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
  if (chainId !== CHAIN_ID) {
    throw new Error(`Chain ID mismatch! Expected ${CHAIN_ID}, got ${chainId}.`);
  }

  const [wallet] = await viem.getWalletClients();
  const account = getAddress(wallet.account.address);
  const balanceBefore = await publicClient.getBalance({ address: account });

  console.log('\n============================================================');
  console.log('[DEPLOY V4 HOOK — PRODUCTION] Robinhood Chain MAINNET (Chain ID 4663)');
  console.log('============================================================');
  console.log(`Deployer:                    ${account}`);
  console.log(`Balance:                     ${formatEther(balanceBefore)} ETH`);
  console.log(`CREATE2 singleton factory:   ${CREATE2_FACTORY}`);
  console.log(`PoolManager:                 ${POOL_MANAGER}`);
  console.log(`REAL production LossRewardPool: ${REAL_PRODUCTION_LOSS_REWARD_POOL}`);
  console.log(`Required permission flags:   ${REQUIRED_FLAGS} (0x${REQUIRED_FLAGS.toString(16)})`);
  console.log('============================================================\n');

  if (balanceBefore === 0n) {
    throw new Error(`Deployer ${account} has zero ETH balance on mainnet. Fund it before deploying.`);
  }

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
        console.warn(
          `  [${label}] receipt wait attempt ${attempt}/${RECEIPT_RETRY_ATTEMPTS} failed ` +
          `(${err instanceof Error ? err.message : String(err)})` +
          (attempt < RECEIPT_RETRY_ATTEMPTS ? `; retrying in ${Math.round(delay / 1000)}s...` : '')
        );
        if (attempt < RECEIPT_RETRY_ATTEMPTS) await sleep(delay);
      }
    }
    throw new Error(
      `[${label}] Could not confirm receipt for tx ${hash} after ${RECEIPT_RETRY_ATTEMPTS} attempts. The ` +
      `transaction itself may still be pending or may already have succeeded — check a block explorer before ` +
      `re-running. Its hash is already saved in ${STATE_PATH}; re-running this exact command resumes from here, ` +
      `it will not resend it.\nLast error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
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
      if (receipt.status !== 'success') {
        throw new Error(`[${name}] transaction reverted (status: ${receipt.status}). Tx: ${record.hash}`);
      }
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

  // ------------------------------------------------------------------------
  // Step 1: mine the CREATE2 salt off-chain (free, deterministic — not a
  // transaction, so nothing here needs to be persisted/resumed).
  // ------------------------------------------------------------------------
  console.log('[1/6] Mining CREATE2 salt for IncentifiV4Hook...');
  const hookArtifact = await artifacts.readArtifact('IncentifiV4Hook');
  const hookConstructorArgs = encodeAbiParameters(
    parseAbiParameters('address, address, address'),
    [POOL_MANAGER, REAL_PRODUCTION_LOSS_REWARD_POOL, account]
  );
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
  if (foundSalt === null || foundHookAddress === null) {
    throw new Error(`No valid CREATE2 salt found within ${MAX_SALT_SEARCH} attempts. Stopping before spending any gas.`);
  }
  console.log(`  Found salt ${foundSalt} after ${Date.now() - searchStart}ms (off-chain, zero gas)`);
  console.log(`  Predicted hook address: ${foundHookAddress}`);

  // ------------------------------------------------------------------------
  // Step 2: deploy HookMinerCheck and cross-check the mined address against the
  // REAL, actual, installed HookMiner library — not just this script's own JS
  // reimplementation of the CREATE2 formula.
  // ------------------------------------------------------------------------
  console.log('\n[2/6] Deploying HookMinerCheck (cross-check helper)...');
  const hookMinerCheckArtifact = await artifacts.readArtifact('HookMinerCheck');
  const hmcNonce = state.steps.hookMinerCheckDeploy?.nonce !== undefined
    ? Number(state.steps.hookMinerCheckDeploy.nonce)
    : await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
  const hookMinerCheckAddress = getContractAddress({ from: account, nonce: BigInt(hmcNonce) });
  await runStep(
    'hookMinerCheckDeploy',
    async () => ({
      hash: await wallet.deployContract({ abi: hookMinerCheckArtifact.abi, bytecode: hookMinerCheckArtifact.bytecode as `0x${string}`, nonce: hmcNonce }),
    }),
    { nonce: hmcNonce, address: hookMinerCheckAddress }
  );
  const hookMinerCheck = await viem.getContractAt('HookMinerCheck', hookMinerCheckAddress);
  const onChainComputed = getAddress(await hookMinerCheck.read.computeAddress([CREATE2_FACTORY, foundSalt, hookInitCode]));
  console.log(`  Off-chain JS computed:  ${foundHookAddress}`);
  console.log(`  Real on-chain computed: ${onChainComputed}`);
  if (onChainComputed !== foundHookAddress) {
    throw new Error('JS-computed hook address does not match the REAL on-chain HookMiner library. Stopping — do not deploy.');
  }
  console.log('  Cross-check: MATCH\n');

  // Only meaningful before hookDeploy has ever been sent — on a resume where
  // state.steps.hookDeploy is already on record, code at this address is the
  // EXPECTED, successful outcome of that prior run, not a collision to abort
  // on. Checking unconditionally here previously broke every resume: the
  // legitimate "already deployed" case looked identical to the genuinely
  // impossible "salt collision" case this check exists to catch.
  if (!state.steps.hookDeploy) {
    const codeAtPredicted = await publicClient.getCode({ address: foundHookAddress });
    if (codeAtPredicted && codeAtPredicted !== '0x') {
      throw new Error(`Predicted hook address ${foundHookAddress} already has code on real mainnet. Stopping — this should never happen for a freshly-mined salt.`);
    }
  }

  // ------------------------------------------------------------------------
  // Step 3: the REAL CREATE2 deployment, through the REAL singleton factory.
  // CREATE2 addresses are fully deterministic from (deployer, salt, initCodeHash)
  // alone — unlike an ordinary CREATE deploy, no nonce-based address recovery is
  // needed here, so there is no equivalent of the v3-redeploy sendDeploymentTransaction
  // bug to work around for this specific step.
  // ------------------------------------------------------------------------
  console.log('[3/6] Deploying IncentifiV4Hook via CREATE2...');
  const hookDeployData = concat([pad(toHex(foundSalt), { size: 32 }), hookInitCode]);
  await runStep('hookDeploy', async () => ({
    hash: await wallet.sendTransaction({ to: CREATE2_FACTORY, data: hookDeployData }),
  }));

  const hookCode = await publicClient.getCode({ address: foundHookAddress });
  if (!hookCode || hookCode === '0x') {
    throw new Error(`Hook deployment transaction succeeded but no code landed at ${foundHookAddress}. Stopping.`);
  }
  const deployedFlags = BigInt(foundHookAddress) & FLAG_MASK;
  if (deployedFlags !== REQUIRED_FLAGS) {
    throw new Error(`Deployed hook address permission bits (${deployedFlags}) != required (${REQUIRED_FLAGS}). Stopping — do not wire a factory to this.`);
  }
  console.log(`  eth_getCode: NON-EMPTY (${(hookCode.length - 2) / 2} bytes)`);
  console.log('  Permission bits confirmed on real deployed bytecode.');

  const hookContract = await viem.getContractAt('IncentifiV4Hook', foundHookAddress);
  const hookDeployerOnChain = getAddress(await hookContract.read.deployer());
  const hookLossRewardPoolOnChain = getAddress(await hookContract.read.lossRewardPool());
  if (hookDeployerOnChain !== account) throw new Error(`hook.deployer() mismatch: got ${hookDeployerOnChain}, expected ${account}.`);
  if (hookLossRewardPoolOnChain !== REAL_PRODUCTION_LOSS_REWARD_POOL) {
    throw new Error(`hook.lossRewardPool() mismatch: got ${hookLossRewardPoolOnChain}, expected ${REAL_PRODUCTION_LOSS_REWARD_POOL} (REAL production pool).`);
  }
  console.log(`  hook.deployer() == ${hookDeployerOnChain} (confirmed)`);
  console.log(`  hook.lossRewardPool() == ${hookLossRewardPoolOnChain} (confirmed == REAL production pool)\n`);

  // ------------------------------------------------------------------------
  // Step 4: IncentifiV4Factory — ordinary CREATE, so its address depends on the
  // deployer's nonce. Fetched BEFORE sending (never read back from the just-sent
  // tx) so the address is known immediately, with no post-broadcast lookup that
  // could fail independently of the underlying transaction's own success.
  // ------------------------------------------------------------------------
  console.log('[4/6] Deploying IncentifiV4Factory...');
  const factoryArtifact = await artifacts.readArtifact('IncentifiV4Factory');
  const factoryNonce = state.steps.factoryDeploy?.nonce !== undefined
    ? Number(state.steps.factoryDeploy.nonce)
    : await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
  const factoryAddress = getContractAddress({ from: account, nonce: BigInt(factoryNonce) });
  await runStep(
    'factoryDeploy',
    async () => ({
      hash: await wallet.deployContract({
        abi: factoryArtifact.abi,
        bytecode: factoryArtifact.bytecode as `0x${string}`,
        args: [POOL_MANAGER, foundHookAddress],
        nonce: factoryNonce,
      }),
    }),
    { nonce: factoryNonce, address: factoryAddress }
  );

  const factoryCode = await publicClient.getCode({ address: factoryAddress });
  if (!factoryCode || factoryCode === '0x') throw new Error(`Factory has EMPTY code at ${factoryAddress}.`);
  const factoryContract = await viem.getContractAt('IncentifiV4Factory', factoryAddress);
  const factoryPoolManagerOnChain = getAddress(await factoryContract.read.poolManager());
  const factoryHookOnChain = getAddress(await factoryContract.read.hook());
  if (factoryPoolManagerOnChain !== POOL_MANAGER) throw new Error(`factory.poolManager() mismatch: got ${factoryPoolManagerOnChain}.`);
  if (factoryHookOnChain !== foundHookAddress) throw new Error(`factory.hook() mismatch: got ${factoryHookOnChain}, expected ${foundHookAddress}.`);
  console.log(`  Factory address: ${factoryAddress}`);
  console.log(`  factory.poolManager() == ${factoryPoolManagerOnChain} (confirmed)`);
  console.log(`  factory.hook() == ${factoryHookOnChain} (confirmed)\n`);

  // ------------------------------------------------------------------------
  // Step 5: setFactory() — one-time wiring, must be called by `account` (the
  // exact address passed as `_deployer` in the hook's constructor).
  // ------------------------------------------------------------------------
  console.log('[5/6] setFactory() (one-time wiring)...');
  const factoryBeforeWiring = getAddress(await hookContract.read.factory());
  if (factoryBeforeWiring === '0x0000000000000000000000000000000000000000') {
    await runStep('setFactory', async () => ({
      hash: await wallet.writeContract({
        address: foundHookAddress,
        abi: hookArtifact.abi,
        functionName: 'setFactory',
        args: [factoryAddress],
      }),
    }));
  } else {
    console.log(`  hook.factory() is already set to ${factoryBeforeWiring} — skipping (already wired).`);
  }
  const factoryAfterWiring = getAddress(await hookContract.read.factory());
  if (factoryAfterWiring !== factoryAddress) {
    throw new Error(`hook.factory() (${factoryAfterWiring}) does not match the deployed Factory (${factoryAddress}) after wiring.`);
  }
  console.log(`  hook.factory() == ${factoryAfterWiring} (confirmed)\n`);

  // ------------------------------------------------------------------------
  // Step 6: IncentifiV4Router — same nonce-prefetch pattern as the Factory.
  // ------------------------------------------------------------------------
  console.log('[6/6] Deploying IncentifiV4Router...');
  const routerArtifact = await artifacts.readArtifact('IncentifiV4Router');
  const routerNonce = state.steps.routerDeploy?.nonce !== undefined
    ? Number(state.steps.routerDeploy.nonce)
    : await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
  const routerAddress = getContractAddress({ from: account, nonce: BigInt(routerNonce) });
  await runStep(
    'routerDeploy',
    async () => ({
      hash: await wallet.deployContract({
        abi: routerArtifact.abi,
        bytecode: routerArtifact.bytecode as `0x${string}`,
        args: [POOL_MANAGER, foundHookAddress, factoryAddress],
        nonce: routerNonce,
      }),
    }),
    { nonce: routerNonce, address: routerAddress }
  );

  const routerCode = await publicClient.getCode({ address: routerAddress });
  if (!routerCode || routerCode === '0x') throw new Error(`Router has EMPTY code at ${routerAddress}.`);
  const routerContract = await viem.getContractAt('IncentifiV4Router', routerAddress);
  const routerPoolManagerOnChain = getAddress(await routerContract.read.poolManager());
  const routerHookOnChain = getAddress(await routerContract.read.hook());
  const routerFactoryOnChain = getAddress(await routerContract.read.factory());
  if (routerPoolManagerOnChain !== POOL_MANAGER) throw new Error(`router.poolManager() mismatch: got ${routerPoolManagerOnChain}.`);
  if (routerHookOnChain !== foundHookAddress) throw new Error(`router.hook() mismatch: got ${routerHookOnChain}, expected ${foundHookAddress}.`);
  if (routerFactoryOnChain !== factoryAddress) throw new Error(`router.factory() mismatch: got ${routerFactoryOnChain}, expected ${factoryAddress}.`);
  console.log(`  Router address: ${routerAddress}`);
  console.log(`  router.poolManager() == ${routerPoolManagerOnChain} (confirmed)`);
  console.log(`  router.hook() == ${routerHookOnChain} (confirmed)`);
  console.log(`  router.factory() == ${routerFactoryOnChain} (confirmed)\n`);

  // ------------------------------------------------------------------------
  // Final paranoid safety check: nothing in this script should ever move the
  // real production LossRewardPool's balance — only a real trade would.
  // ------------------------------------------------------------------------
  const prodPoolBalanceAfter = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
  if (prodPoolBalanceAfter !== prodPoolBalanceBefore) {
    throw new Error(
      `Real production LossRewardPool balance CHANGED (${formatEther(prodPoolBalanceBefore)} -> ` +
      `${formatEther(prodPoolBalanceAfter)} ETH) during a deployment script that should never move it. ` +
      `Investigate before trusting anything above.`
    );
  }
  console.log(`Confirmed: real production LossRewardPool balance unchanged (${formatEther(prodPoolBalanceAfter)} ETH).\n`);

  const balanceAfter = await publicClient.getBalance({ address: account });
  const result = {
    chainId,
    deployer: account,
    hook: {
      address: foundHookAddress,
      salt: foundSalt.toString(),
      txHash: state.steps.hookDeploy.hash,
      blockNumber: state.steps.hookDeploy.blockNumber,
      gasUsed: state.steps.hookDeploy.gasUsed,
      constructorArgs: { poolManager: POOL_MANAGER, lossRewardPool: REAL_PRODUCTION_LOSS_REWARD_POOL, deployer: account },
      permissionFlags: REQUIRED_FLAGS.toString(),
    },
    factory: {
      address: factoryAddress,
      txHash: state.steps.factoryDeploy.hash,
      blockNumber: state.steps.factoryDeploy.blockNumber,
      gasUsed: state.steps.factoryDeploy.gasUsed,
      constructorArgs: { poolManager: POOL_MANAGER, hook: foundHookAddress },
    },
    router: {
      address: routerAddress,
      txHash: state.steps.routerDeploy.hash,
      blockNumber: state.steps.routerDeploy.blockNumber,
      gasUsed: state.steps.routerDeploy.gasUsed,
      constructorArgs: { poolManager: POOL_MANAGER, hook: foundHookAddress, factory: factoryAddress },
    },
    hookMinerCheck: hookMinerCheckAddress,
    gasSpentWei: (balanceBefore - balanceAfter).toString(),
    gasSpentEth: formatEther(balanceBefore - balanceAfter),
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));

  console.log('============================================================');
  console.log('[DEPLOY V4 HOOK — PRODUCTION] COMPLETE — every constructor arg confirmed on-chain');
  console.log('============================================================');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSaved to ${RESULT_PATH}`);
  console.log('\nThis script did NOT launch a token, buy, sell, or drive graduation — that scope was');
  console.log('deliberately left for a separate verify script, mirroring verify-v3-fix-mainnet.ts.');
}

main().catch((err) => {
  console.error('\n[DEPLOY V4 HOOK ERROR]', err instanceof Error ? err.message : err);
  console.error(`Progress so far (including any tx hashes already sent) is saved in ${STATE_PATH}.`);
  console.error('Re-running the exact same command will resume from here, not resend anything already sent.');
  process.exitCode = 1;
});
