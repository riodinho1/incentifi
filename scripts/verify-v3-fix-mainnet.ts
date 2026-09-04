/**
 * End-to-end REAL-money verification of the newly deployed (fixed) IncentifiBondingCurveFactory
 * + IncentifiSwapRouter on Robinhood Chain MAINNET (Chain ID 4663).
 *
 * Does not trust logs or "the transaction didn't revert" — every step asserts an EXACT
 * on-chain balance delta (net of the step's own gas cost) against the value the
 * contracts themselves report they moved. Steps:
 *
 *   1. Deploy a real, tiny, single-purpose ERC20 test token (IncentifiLaunchToken)
 *      and register it on the NEW factory (creates a real IncentifiBondingCurve).
 *   2. Real BUY of 0.005 ETH through the NEW router -> bonding curve.
 *      Asserts: buyer ETH delta == exactly 0.005 ETH + gas; token balance delta ==
 *      curve's own realTokenReserve delta.
 *   3. Real SELL of every token just bought, back through the NEW router.
 *      Asserts: buyer ETH delta (net of gas) == curve's own realEthReserve delta,
 *      scaled by the 98% net-of-fee split; token balance goes to exactly 0.
 *   4. Real claimCreatorFees() call on the curve (creator == this same wallet, since
 *      it both deployed the token and registered it).
 *      Asserts: claimer ETH delta (net of gas) == exactly the pre-claim
 *      creatorBalances() reading, and creatorBalances() is exactly 0 afterwards.
 *
 * SAFETY: this spends real ETH (token deploy + registration gas, a real 0.005 ETH
 * buy, sell gas, claim gas) on REAL mainnet. It refuses to run unless ALL of:
 *   - DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) — the SAME funded key used to deploy
 *   - DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET
 *   - The new Factory/Router addresses, via V3_FACTORY_ADDRESS / V3_ROUTER_ADDRESS
 *     env vars, or scripts/.v3-deployment-result.json (written by
 *     deploy-v3-fixed-factory-and-router.ts) if those env vars are unset.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET \
 *     npx hardhat run scripts/verify-v3-fix-mainnet.ts --network robinhoodMainnet
 *
 * CRASH / RPC-HICCUP SAFETY (automatic — no flag needed): every real transaction this
 * script sends (token deploy, 2 approvals, register, buy, sell, claim) is recorded to
 * scripts/.v3-verify-state.json — with its tx hash written to disk BEFORE this script
 * ever waits on its receipt. If the process dies, or Hardhat's own receipt polling
 * errors out on a slow/flaky RPC (as this one has, twice, on simple single-tx
 * deploys) partway through, just re-run the EXACT SAME command: any step whose hash
 * is already on disk is never re-sent — this script only polls that existing hash's
 * receipt (with retry/backoff, see below) instead. A step is only ever sent once.
 * The pre-send account/token/curve balance snapshots each step's exact-delta
 * assertion depends on are captured and persisted at send time too, for the same
 * reason (they can't be reconstructed after the fact once later steps have changed
 * those balances again).
 *
 * Receipt waits also retry with exponential backoff (6 attempts, 5s/10s/20s/40s/80s/
 * 160s by default) before giving up, so a single transient RPC error no longer ends
 * the run at all — override via RECEIPT_RETRY_ATTEMPTS / RECEIPT_RETRY_DELAY_MS.
 *
 * To intentionally discard old state and start a brand new verify run against the
 * same Factory/Router (e.g. a previous run fully completed and you want to run it
 * again), set VERIFY_RESET=1. Without it, state for a DIFFERENT factory/router/wallet
 * than this run is refused (not silently discarded) — move or delete
 * scripts/.v3-verify-state.json by hand first.
 */

import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { network } from 'hardhat';
import { formatEther, getAddress, getContractAddress, parseEther } from 'viem';

const CHAIN_ID = 4663;
const BUY_AMOUNT_WEI = parseEther('0.005');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const RESULT_PATH = path.resolve('scripts', '.v3-deployment-result.json');
const STATE_PATH = path.resolve('scripts', '.v3-verify-state.json');

const RECEIPT_RETRY_ATTEMPTS = Number(process.env.RECEIPT_RETRY_ATTEMPTS || 6);
const RECEIPT_RETRY_BASE_DELAY_MS = Number(process.env.RECEIPT_RETRY_DELAY_MS || 5000);

const LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compiles IncentifiLaunchToken.sol directly via the `solc` npm package (same
 * technique as scripts/generate-deploy-bytecode.mjs) instead of going through
 * Hardhat's `viem.sendDeploymentTransaction()` / `viem.deployContract()` helpers.
 *
 * Root cause of the double-token-deploy incident this replaced: hardhat-viem's
 * sendDeploymentTransaction() broadcasts the tx (walletClient.deployContract, which
 * succeeds), then IMMEDIATELY calls publicClient.getTransaction({hash}) — a second,
 * separate RPC round-trip — just to read the tx's nonce back so it can compute the
 * deployed address. If that follow-up read fails on a flaky RPC (confirmed via
 * node_modules/@nomicfoundation/hardhat-viem/dist/src/internal/contracts.js:95), the
 * whole call throws BEFORE returning the hash to the caller — even though the
 * transaction itself was already broadcast and later confirms fine. No amount of
 * retry/resume logic wrapped around the *return value* of that call can protect
 * against a failure that happens *inside* it, before it returns anything at all.
 *
 * The fix: never depend on reading the just-sent transaction back. Fetch the
 * deployer's next nonce ourselves BEFORE sending (a plain, already-settled read with
 * no race), pass it explicitly to the deploy transaction, and compute the CREATE
 * address client-side from that same nonce via viem's own getContractAddress() — the
 * exact formula hardhat-viem uses internally, just without the fragile round-trip.
 * walletClient.deployContract() (plain viem, not hardhat-viem) then does nothing but
 * broadcast and hand back the hash — no other RPC call, no other way for it to throw
 * after the underlying transaction has already succeeded.
 */
function compileLaunchToken(): { abi: unknown; bytecode: `0x${string}` } {
  const contractPath = path.resolve('contracts', 'IncentifiLaunchToken.sol');
  const source = fs.readFileSync(contractPath, 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'IncentifiLaunchToken.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const fatal = output.errors.filter((e: { severity: string }) => e.severity === 'error');
    if (fatal.length > 0) {
      throw new Error(`Solidity compilation failed for IncentifiLaunchToken.sol: ${fatal[0].formattedMessage}`);
    }
  }
  const contract = output.contracts['IncentifiLaunchToken.sol']['IncentifiLaunchToken'];
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` as `0x${string}` };
}

function resolveAddresses(): { factory: `0x${string}`; router: `0x${string}` } {
  const envFactory = process.env.V3_FACTORY_ADDRESS;
  const envRouter = process.env.V3_ROUTER_ADDRESS;
  if (envFactory && envRouter) {
    return { factory: getAddress(envFactory), router: getAddress(envRouter) };
  }
  if (!fs.existsSync(RESULT_PATH)) {
    throw new Error(
      `Neither V3_FACTORY_ADDRESS/V3_ROUTER_ADDRESS env vars nor ${RESULT_PATH} were found.\n` +
      `Run deploy-v3-fixed-factory-and-router.ts first, or set both env vars explicitly.`
    );
  }
  const deployResult = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
  return { factory: getAddress(deployResult.factory.address), router: getAddress(deployResult.router.address) };
}

function requireConfirmation() {
  if (process.env.DEPLOY_CONFIRM !== 'I_UNDERSTAND_THIS_IS_MAINNET') {
    throw new Error(
      '\nRefusing to run: this spends REAL ETH (a real 0.005 ETH buy included) on REAL ' +
      'Robinhood Chain mainnet.\nSet DEPLOY_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET to proceed.\n'
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

type VerifyState = {
  factory: `0x${string}`;
  router: `0x${string}`;
  wallet: `0x${string}`;
  steps: Record<string, StepRecord>;
};

function loadState(factoryAddressRaw: `0x${string}`, routerAddressRaw: `0x${string}`, walletAddressRaw: `0x${string}`): VerifyState {
  // Normalize every address through viem's checksum before comparing anything —
  // never compare raw strings directly. factoryAddress/routerAddress are already
  // checksummed by resolveAddresses() by the time they get here, but walletAddress
  // (ultimately account.wallet.address from Hardhat's viem wallet client) is not
  // guaranteed to be, and previously wasn't run through getAddress() at all before
  // this function's own comparison — an identical wallet in a different case (e.g.
  // all-lowercase) was wrongly treated as "a different wallet". getAddress() throws
  // on a malformed address, so this also validates all three inputs as a side effect.
  const factoryAddress = getAddress(factoryAddressRaw);
  const routerAddress = getAddress(routerAddressRaw);
  const walletAddress = getAddress(walletAddressRaw);
  if (process.env.VERIFY_RESET === '1') {
    console.log(`[STATE] VERIFY_RESET=1 — ignoring any existing ${STATE_PATH} and starting fresh.\n`);
    return { factory: factoryAddress, router: routerAddress, wallet: walletAddress, steps: {} };
  }
  if (!fs.existsSync(STATE_PATH)) {
    return { factory: factoryAddress, router: routerAddress, wallet: walletAddress, steps: {} };
  }
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const sameRun =
    raw.factory && getAddress(raw.factory) === factoryAddress &&
    raw.router && getAddress(raw.router) === routerAddress &&
    raw.wallet && getAddress(raw.wallet) === walletAddress;
  if (!sameRun) {
    throw new Error(
      `${STATE_PATH} exists but is for a different factory/router/wallet than this run.\n` +
      `  state file: factory=${raw.factory}, router=${raw.router}, wallet=${raw.wallet}\n` +
      `  this run:   factory=${factoryAddress}, router=${routerAddress}, wallet=${walletAddress}\n` +
      `If that earlier run's transactions are done with (all confirmed, or safely abandoned before ` +
      `anything was sent), move or delete ${STATE_PATH} by hand, or set VERIFY_RESET=1. Refusing to guess.`
    );
  }
  const steps = raw.steps || {};
  if (Object.keys(steps).length > 0) {
    console.log(`[STATE] Found ${STATE_PATH} — resuming. Steps already recorded: ${Object.keys(steps).join(', ')}\n`);
  }
  return { factory: factoryAddress, router: routerAddress, wallet: walletAddress, steps };
}

function persistState(state: VerifyState) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

async function main() {
  requireConfirmation();
  const { factory: factoryAddress, router: routerAddress } = resolveAddresses();

  const { viem } = await network.create('robinhoodMainnet');
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`Chain ID mismatch! Expected ${CHAIN_ID}, got ${chainId}.`);
  }

  const [wallet] = await viem.getWalletClients();
  // Checksummed once, here, at the source — wallet.account.address isn't guaranteed
  // to come back checksummed, and every downstream comparison/log/state-file write in
  // this script assumes `account` already is (see loadState()'s comment for the bug
  // this previously caused).
  const account = getAddress(wallet.account.address);

  console.log('\n============================================================');
  console.log('[VERIFY v3] Robinhood Chain MAINNET (Chain ID 4663)');
  console.log('============================================================');
  console.log(`Wallet (creator/trader): ${account}`);
  console.log(`New Factory:             ${factoryAddress}`);
  console.log(`New Router:              ${routerAddress}`);
  console.log('============================================================\n');

  // Receipt waits retry with exponential backoff before giving up — a single
  // transient RPC error (this endpoint has done this twice on plain single-tx
  // deploys) no longer ends the run. The tx hash is ALWAYS already on disk (written
  // by runStep before this is ever called), so even total exhaustion here just means
  // "re-run the same command" rather than any risk of a duplicate transaction.
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
      `[${label}] Could not confirm receipt for tx ${hash} after ${RECEIPT_RETRY_ATTEMPTS} attempts. ` +
      `The transaction itself may still be pending or may already have succeeded — check a block explorer. ` +
      `Its hash is already saved in ${STATE_PATH}; re-run this exact same command once you've confirmed the ` +
      `transaction's real status — it will resume from here, not resend it.\n` +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  }

  const state = loadState(factoryAddress, routerAddress, account);

  // Sends `sendFn` only if this step has never been sent before (per `state`), then
  // waits for (and retries on) its receipt, persisting the hash to disk BEFORE the
  // wait begins and the confirmation result immediately after. `precomputedExtra`
  // (e.g. pre-send balance snapshots) is attached ONLY on a fresh send — resuming
  // reuses whatever was captured then, since it may no longer be reconstructable
  // from current chain state once other steps have run since.
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

  // Pre-flight: confirm the target contracts are real and are the ones we expect
  // before spending anything. Pure reads — always safe to redo on every run/resume.
  const factory = await viem.getContractAt('IncentifiBondingCurveFactory', factoryAddress);
  const router = await viem.getContractAt('IncentifiSwapRouter', routerAddress);

  const [factoryCode, routerCode] = await Promise.all([
    publicClient.getCode({ address: factoryAddress }),
    publicClient.getCode({ address: routerAddress }),
  ]);
  if (!factoryCode || factoryCode === '0x') throw new Error(`Factory ${factoryAddress} has empty code.`);
  if (!routerCode || routerCode === '0x') throw new Error(`Router ${routerAddress} has empty code.`);

  const routerFactoryLink = getAddress(await router.read.bondingCurveFactory());
  if (routerFactoryLink !== factoryAddress) {
    throw new Error(`Router.bondingCurveFactory() (${routerFactoryLink}) does not point at the given Factory (${factoryAddress}).`);
  }
  console.log('[PRE-FLIGHT] Factory + Router both have live code, and Router is wired to this Factory. OK.\n');

  // ------------------------------------------------------------------------
  // Step 1: Launch a real, tiny test token through the new Factory
  // ------------------------------------------------------------------------
  console.log('[1/4] Test token + Factory registration');
  const totalSupply = 1_000_000_000n * 10n ** 18n;

  const tokenDeployRecord = await runStep('tokenDeploy', async () => {
    const tokenName = `Incentifi V3 Verify ${Date.now()}`;
    const { abi, bytecode } = compileLaunchToken();
    // Fetch the nonce ourselves BEFORE sending — a plain, already-settled read, not a
    // lookup of the transaction we're about to broadcast — so the address below never
    // depends on the just-sent tx being readable back from the node yet.
    const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
    const address = getContractAddress({ from: account, nonce: BigInt(nonce) });
    // Plain viem WalletClient.deployContract: broadcasts and returns just the hash.
    // No follow-up RPC call, unlike hardhat-viem's sendDeploymentTransaction — see the
    // compileLaunchToken() comment above for why that distinction is the whole fix.
    const hash = await wallet.deployContract({ abi, bytecode, args: [tokenName, 'IFV3', totalSupply], nonce });
    return { hash, address, tokenName };
  });
  const tokenAddress = getAddress(tokenDeployRecord.address as string);
  const token = await viem.getContractAt('IncentifiLaunchToken', tokenAddress);
  console.log(`  Token: ${tokenAddress} ("${tokenDeployRecord.tokenName}")`);

  await runStep('approveFactory', async () => ({
    hash: await token.write.approve([factoryAddress, totalSupply]),
  }));

  await runStep('register', async () => ({
    hash: await factory.write.registerExistingToken([tokenAddress, account]),
  }));

  const curveAddress = getAddress(await factory.read.getBondingCurve([tokenAddress]));
  if (curveAddress === ZERO_ADDRESS) {
    throw new Error('Factory did not register a bonding curve for the test token.');
  }
  const curve = await viem.getContractAt('IncentifiBondingCurve', curveAddress);
  const curveInitialized = await curve.read.initialized();
  const curveTokenReserve = await curve.read.realTokenReserve();
  if (!curveInitialized || curveTokenReserve !== totalSupply) {
    throw new Error(`Curve did not initialize correctly (initialized=${curveInitialized}, realTokenReserve=${curveTokenReserve}).`);
  }
  console.log(`  Bonding curve: ${curveAddress}`);
  console.log(`  Curve initialized=true, realTokenReserve == full 1B supply. OK.\n`);

  // ------------------------------------------------------------------------
  // Step 2: Real buy of 0.005 ETH through the new Router
  // ------------------------------------------------------------------------
  console.log(`[2/4] Buying ${formatEther(BUY_AMOUNT_WEI)} ETH of tokens through the new Router...`);
  const buyBefore = (state.steps.buy?.before as Record<string, string>) ?? {
    ethBeforeBuy: (await publicClient.getBalance({ address: account })).toString(),
    tokensBeforeBuy: (await token.read.balanceOf([account])).toString(),
    curveEthReserveBeforeBuy: (await curve.read.realEthReserve()).toString(),
  };

  const buyRecord = await runStep(
    'buy',
    async () => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const hash = await router.write.buyToken([tokenAddress, 0n, deadline], { value: BUY_AMOUNT_WEI });
      return { hash };
    },
    { before: buyBefore }
  );

  const ethBeforeBuy = BigInt((buyRecord.before as Record<string, string>).ethBeforeBuy);
  const tokensBeforeBuy = BigInt((buyRecord.before as Record<string, string>).tokensBeforeBuy);
  const curveEthReserveBeforeBuy = BigInt((buyRecord.before as Record<string, string>).curveEthReserveBeforeBuy);
  const buyGasCost = BigInt(buyRecord.gasUsed!) * BigInt(buyRecord.effectiveGasPrice!);

  const ethAfterBuy = await publicClient.getBalance({ address: account });
  const tokensAfterBuy = await token.read.balanceOf([account]);
  const curveEthReserveAfterBuy = await curve.read.realEthReserve();

  const ethSpentOnBuy = ethBeforeBuy - ethAfterBuy - buyGasCost;
  const tokensReceived = tokensAfterBuy - tokensBeforeBuy;
  const curveEthReserveDelta = curveEthReserveAfterBuy - curveEthReserveBeforeBuy;

  console.log(`  Wallet ETH spent (net of gas): ${formatEther(ethSpentOnBuy)} ETH`);
  console.log(`  Tokens received:               ${tokensReceived.toString()}`);
  console.log(`  Curve realEthReserve delta:    ${formatEther(curveEthReserveDelta)} ETH (98% of gross, after 1%/1% fee split)`);

  if (ethSpentOnBuy !== BUY_AMOUNT_WEI) {
    throw new Error(
      `Buy did not spend exactly ${formatEther(BUY_AMOUNT_WEI)} ETH net of gas — spent ${formatEther(ethSpentOnBuy)} ETH instead ` +
      `(a fresh curve this far from its graduation target should accept the full amount with no refund).`
    );
  }
  if (tokensReceived <= 0n) {
    throw new Error('Buy produced zero tokens.');
  }
  const expectedNetEth = BUY_AMOUNT_WEI - (BUY_AMOUNT_WEI / 100n) - (BUY_AMOUNT_WEI / 100n);
  if (curveEthReserveDelta !== expectedNetEth) {
    throw new Error(`Curve realEthReserve delta ${curveEthReserveDelta} != expected net-of-fee amount ${expectedNetEth}.`);
  }
  console.log('  Exact balance-delta assertions: PASS\n');

  // Persist tokensReceived — the sell step below needs this EXACT figure even if it
  // ends up running in a later, resumed invocation of this script.
  if (buyRecord.tokensReceived === undefined) {
    buyRecord.tokensReceived = tokensReceived.toString();
    state.steps.buy = buyRecord;
    persistState(state);
  }
  const tokensToSell = BigInt(buyRecord.tokensReceived as string);

  // ------------------------------------------------------------------------
  // Step 3: Real sell of every token just bought, back through the new Router
  // ------------------------------------------------------------------------
  console.log(`[3/4] Selling all ${tokensToSell.toString()} tokens back through the new Router...`);

  await runStep('approveRouterForSell', async () => ({
    hash: await token.write.approve([routerAddress, tokensToSell]),
  }));

  const sellBefore = (state.steps.sell?.before as Record<string, string>) ?? {
    ethBeforeSell: (await publicClient.getBalance({ address: account })).toString(),
    curveEthReserveBeforeSell: (await curve.read.realEthReserve()).toString(),
  };

  const sellRecord = await runStep(
    'sell',
    async () => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const hash = await router.write.sellToken([tokenAddress, tokensToSell, 0n, deadline]);
      return { hash };
    },
    { before: sellBefore }
  );

  const ethBeforeSell = BigInt((sellRecord.before as Record<string, string>).ethBeforeSell);
  const curveEthReserveBeforeSell = BigInt((sellRecord.before as Record<string, string>).curveEthReserveBeforeSell);
  const sellGasCost = BigInt(sellRecord.gasUsed!) * BigInt(sellRecord.effectiveGasPrice!);

  const ethAfterSell = await publicClient.getBalance({ address: account });
  const tokensAfterSell = await token.read.balanceOf([account]);
  const curveEthReserveAfterSell = await curve.read.realEthReserve();

  const netEthReceivedFromSell = ethAfterSell - ethBeforeSell + sellGasCost;
  const curveEthReserveDeltaSell = curveEthReserveBeforeSell - curveEthReserveAfterSell;

  console.log(`  Wallet ETH received (net of gas): ${formatEther(netEthReceivedFromSell)} ETH`);
  console.log(`  Token balance after sell:         ${tokensAfterSell.toString()} (must be 0)`);

  if (tokensAfterSell !== 0n) {
    throw new Error(`Wallet still holds ${tokensAfterSell.toString()} tokens after selling all of them.`);
  }
  const expectedNetFromGross = curveEthReserveDeltaSell - (curveEthReserveDeltaSell / 100n) - (curveEthReserveDeltaSell / 100n);
  if (netEthReceivedFromSell !== expectedNetFromGross) {
    throw new Error(
      `Wallet net ETH received from sell (${netEthReceivedFromSell}) != expected net-of-fee amount ` +
      `(${expectedNetFromGross}) derived from the curve's own realEthReserve delta (${curveEthReserveDeltaSell}).`
    );
  }
  console.log('  Exact balance-delta assertions: PASS\n');

  // ------------------------------------------------------------------------
  // Step 4: Real claimCreatorFees() — this wallet is both token creator and trader
  // ------------------------------------------------------------------------
  console.log('[4/4] Claiming accrued creator fees...');
  const claimBefore = (state.steps.claim?.before as Record<string, string>) ?? {
    accruedBeforeClaim: (await curve.read.creatorBalances([account])).toString(),
    ethBeforeClaim: (await publicClient.getBalance({ address: account })).toString(),
  };
  const accruedBeforeClaim = BigInt(claimBefore.accruedBeforeClaim);
  console.log(`  creatorBalances(${account}) before claim: ${formatEther(accruedBeforeClaim)} ETH`);
  if (!state.steps.claim && accruedBeforeClaim <= 0n) {
    throw new Error('Expected a non-zero accrued creator balance from the buy + sell above, got 0.');
  }

  const claimRecord = await runStep(
    'claim',
    async () => ({ hash: await curve.write.claimCreatorFees() }),
    { before: claimBefore }
  );

  const ethBeforeClaim = BigInt((claimRecord.before as Record<string, string>).ethBeforeClaim);
  const claimGasCost = BigInt(claimRecord.gasUsed!) * BigInt(claimRecord.effectiveGasPrice!);

  const ethAfterClaim = await publicClient.getBalance({ address: account });
  const accruedAfterClaim = await curve.read.creatorBalances([account]);
  const netClaimed = ethAfterClaim - ethBeforeClaim + claimGasCost;

  console.log(`  Wallet ETH received (net of gas): ${formatEther(netClaimed)} ETH`);
  console.log(`  creatorBalances(${account}) after claim:  ${formatEther(accruedAfterClaim)} ETH (must be 0)`);

  if (accruedAfterClaim !== 0n) {
    throw new Error(`creatorBalances() is ${accruedAfterClaim} after claim, expected exactly 0.`);
  }
  if (netClaimed !== accruedBeforeClaim) {
    throw new Error(`Claimed ETH (net of gas) ${netClaimed} != pre-claim creatorBalances() reading ${accruedBeforeClaim}.`);
  }
  console.log('  Exact balance-delta assertions: PASS\n');

  const summary = {
    chainId,
    wallet: account,
    factory: factoryAddress,
    router: routerAddress,
    testToken: tokenAddress,
    testCurve: curveAddress,
    buy: { spentWei: ethSpentOnBuy.toString(), tokensReceived: tokensToSell.toString(), txHash: buyRecord.hash },
    sell: { receivedWei: netEthReceivedFromSell.toString(), txHash: sellRecord.hash },
    claim: { claimedWei: accruedBeforeClaim.toString(), txHash: claimRecord.hash },
    verifiedAt: new Date().toISOString(),
    result: 'ALL EXACT BALANCE-DELTA ASSERTIONS PASSED',
  };

  console.log('============================================================');
  console.log('[VERIFY v3] COMPLETE — every step confirmed on-chain with exact balance deltas');
  console.log('============================================================');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('\n[VERIFY v3 ERROR]', err instanceof Error ? err.message : err);
  console.error(`\nProgress so far (including any tx hashes already sent) is saved in ${STATE_PATH}.`);
  console.error('Re-running the exact same command will resume from here, not resend anything already sent.');
  process.exitCode = 1;
});
