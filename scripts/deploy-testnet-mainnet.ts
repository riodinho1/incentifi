import { network, artifacts } from 'hardhat';
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  concat,
  pad,
  toHex,
  getAddress,
  parseEther,
  formatEther,
} from 'viem';

/**
 * REAL ROBINHOOD CHAIN MAINNET DEPLOYMENT. Every transaction below is real,
 * costs real gas, and is irreversible. There is no fork, no snapshot, no
 * reset button. This mirrors — as closely as possible — the exact sequence
 * already proven on the fork in test/hardhat/v4-testnet-deployment.test.ts:
 * mine + deploy IncentifiV4HookTestnet, deploy a throwaway LossRewardPool,
 * deploy IncentifiV4Factory + IncentifiV4Router, wire setFactory(), launch a
 * real token, buy, sell, then drive one boundary-crossing buy through a real
 * graduation.
 *
 * Uses the SAME low, test-scale economic parameters already built and
 * verified (IncentifiV4HookTestnet.sol: ~$100 implied launch market cap,
 * ~$293 implied graduation target at a nominal $2,500/ETH) — never the real
 * $5,000/$69,000 production parameters, and never the real production
 * LossRewardPool (0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF) — a fresh,
 * throwaway LossRewardPool is deployed fresh, every run.
 *
 * Run with:
 *   ROBINHOOD_MAINNET_PRIVATE_KEY=0x... npx hardhat run scripts/deploy-testnet-mainnet.ts --network robinhoodMainnet
 *
 * Deliberately NOT a hardhat test: this needs to run once, against a real
 * network, with no retry/catch swallowing a real failure — if any step
 * reverts or throws, the script stops immediately rather than attempting to
 * proceed against a partially-broken deployment.
 */

const CREATE2_FACTORY = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
const REAL_PRODUCTION_LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const EXPLORER_URL = 'https://explorer.mainnet.chain.robinhood.com';

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const REQUIRED_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 3n);
const FLAG_MASK = (1n << 14n) - 1n;

function computeCreate2Address(deployer: `0x${string}`, salt: bigint, initCodeHash: `0x${string}`): `0x${string}` {
  const packed = concat(['0xff', deployer, pad(toHex(salt), { size: 32 }), initCodeHash]);
  return getAddress(`0x${keccak256(packed).slice(-40)}`);
}

const addrLink = (a: string) => `${EXPLORER_URL}/address/${a}`;
const txLink = (h: string) => `${EXPLORER_URL}/tx/${h}`;

let totalGasWei = 0n;
function trackGas(label: string, receipt: { gasUsed: bigint; effectiveGasPrice: bigint; transactionHash: `0x${string}`; blockNumber: bigint; status: string }) {
  const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
  totalGasWei += costWei;
  console.log(`\n[${label}]`);
  console.log(`  tx:     ${receipt.transactionHash}`);
  console.log(`  link:   ${txLink(receipt.transactionHash)}`);
  console.log(`  block:  ${receipt.blockNumber}`);
  console.log(`  status: ${receipt.status}`);
  console.log(`  gas:    ${receipt.gasUsed} units, ${formatEther(costWei)} ETH at ${formatEther(receipt.effectiveGasPrice)} ETH/gas`);
  if (receipt.status !== 'success') {
    throw new Error(`${label} did not succeed — stopping. Do not proceed with further real transactions against a failed step.`);
  }
}

async function main() {
  const { viem } = await network.create('robinhoodMainnet');
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  if (!wallet) {
    throw new Error(
      'No signer configured for robinhoodMainnet. Set ROBINHOOD_MAINNET_PRIVATE_KEY before running this script — see the header comment for the exact command.'
    );
  }
  const walletAddress = getAddress(wallet.account.address);

  const chainId = await publicClient.getChainId();
  if (chainId !== 4663) {
    throw new Error(`Connected to chain ID ${chainId}, expected 4663 (Robinhood Chain mainnet). Refusing to proceed.`);
  }

  const balance = await publicClient.getBalance({ address: walletAddress });
  console.log('=== REAL ROBINHOOD CHAIN MAINNET DEPLOYMENT ===');
  console.log('Wallet:', walletAddress, '|', addrLink(walletAddress));
  console.log('Chain ID:', chainId, '(confirmed == 4663)');
  console.log('Balance:', formatEther(balance), 'ETH');
  // EARLY floor: covers every step up through the first buy/sell round-trip.
  // Gas for that whole span is padded generously (up to ~6M units, well above
  // anything actually measured on the fork, at up to 1 gwei — above the
  // observed 0.3-0.5 gwei real range) plus the 0.005 ETH test buy itself
  // (recovered, minus ~2% fee, moments later by the immediate sell). This is
  // NOT sized to cover the graduating buy — that has its own, precise,
  // just-in-time check right before it fires, using the real on-chain numbers
  // instead of a number guessed this early.
  const EARLY_FLOOR = parseEther('0.03');
  if (balance < EARLY_FLOOR) {
    throw new Error(`Wallet balance (${formatEther(balance)} ETH) is below ${formatEther(EARLY_FLOOR)} ETH, which comfortably covers gas through the first buy/sell round-trip. Fund the wallet further before proceeding.`);
  }

  const realProdPoolBalanceBefore = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
  console.log('\nReal production LossRewardPool balance BEFORE anything below:', formatEther(realProdPoolBalanceBefore), 'ETH (', addrLink(REAL_PRODUCTION_LOSS_REWARD_POOL), ') — recorded so it can be proven unchanged at the end.');

  // --- Step 1: fresh, throwaway LossRewardPool ---
  console.log('\n\n--- STEP 1: throwaway LossRewardPool (never the real production one) ---');
  const lossRewardPoolArtifact = await artifacts.readArtifact('LossRewardPool');
  const lossRewardPoolDeployHash = await wallet.deployContract({
    abi: lossRewardPoolArtifact.abi,
    bytecode: lossRewardPoolArtifact.bytecode as `0x${string}`,
    args: [walletAddress],
  });
  const lossRewardPoolReceipt = await publicClient.waitForTransactionReceipt({ hash: lossRewardPoolDeployHash });
  trackGas('LossRewardPool (throwaway) deploy', lossRewardPoolReceipt);
  const lossRewardPoolAddress = getAddress(lossRewardPoolReceipt.contractAddress!);
  console.log('  address:', lossRewardPoolAddress, '|', addrLink(lossRewardPoolAddress));
  if (lossRewardPoolAddress === REAL_PRODUCTION_LOSS_REWARD_POOL) {
    throw new Error('IMPOSSIBLE SAFETY CHECK FAILED: freshly deployed address matches the real production LossRewardPool. Stopping immediately.');
  }

  // --- Step 2: mine + deploy IncentifiV4HookTestnet ---
  console.log('\n\n--- STEP 2: mining + deploying IncentifiV4HookTestnet ---');
  const hookArtifact = await artifacts.readArtifact('IncentifiV4HookTestnet');
  const constructorArgs = encodeAbiParameters(
    parseAbiParameters('address, address, address'),
    [POOL_MANAGER, lossRewardPoolAddress, walletAddress]
  );
  const initCode = concat([hookArtifact.bytecode as `0x${string}`, constructorArgs]);
  const initCodeHash = keccak256(initCode);

  let foundSalt: bigint | null = null;
  let foundAddress: `0x${string}` | null = null;
  const searchStart = Date.now();
  for (let salt = 0n; salt < 500_000n; salt++) {
    const candidate = computeCreate2Address(CREATE2_FACTORY, salt, initCodeHash);
    if ((BigInt(candidate) & FLAG_MASK) === REQUIRED_FLAGS) {
      foundSalt = salt;
      foundAddress = candidate;
      break;
    }
  }
  if (foundSalt === null || foundAddress === null) {
    throw new Error('No valid CREATE2 salt found within the search bound. Stopping before spending any gas.');
  }
  console.log('  mined salt', foundSalt, 'after', Date.now() - searchStart, 'ms (off-chain, zero gas) -> predicted address', foundAddress);

  const codeAtPredicted = await publicClient.getCode({ address: foundAddress });
  if (codeAtPredicted && codeAtPredicted !== '0x') {
    throw new Error(`Predicted address ${foundAddress} already has code on real mainnet. Stopping — this should never happen for a freshly-mined salt.`);
  }

  const deployData = concat([pad(toHex(foundSalt), { size: 32 }), initCode]);
  const hookDeployHash = await wallet.sendTransaction({ to: CREATE2_FACTORY, data: deployData });
  const hookDeployReceipt = await publicClient.waitForTransactionReceipt({ hash: hookDeployHash });
  trackGas('IncentifiV4HookTestnet deploy (via real CREATE2 singleton factory)', hookDeployReceipt);

  const codeAfter = await publicClient.getCode({ address: foundAddress });
  if (!codeAfter || codeAfter === '0x') {
    throw new Error('Hook deployment transaction succeeded but no code landed at the predicted address. Stopping.');
  }
  const deployedFlags = BigInt(foundAddress) & FLAG_MASK;
  if (deployedFlags !== REQUIRED_FLAGS) {
    throw new Error('Deployed hook address does not carry the required permission bits. Stopping — do not wire a factory to this.');
  }
  console.log('  hook address:', foundAddress, '|', addrLink(foundAddress));
  console.log('  permission bits confirmed on real deployed bytecode.');

  const hookContract = await viem.getContractAt('IncentifiV4HookTestnet', foundAddress);
  const deployerOnChain = getAddress(await hookContract.read.deployer());
  const lossRewardPoolOnChain = getAddress(await hookContract.read.lossRewardPool());
  if (deployerOnChain !== walletAddress) throw new Error('hook.deployer() mismatch — stopping.');
  if (lossRewardPoolOnChain !== lossRewardPoolAddress) throw new Error('hook.lossRewardPool() mismatch — stopping.');
  console.log('  hook.deployer() ==', deployerOnChain, '(confirmed)');
  console.log('  hook.lossRewardPool() ==', lossRewardPoolOnChain, '(confirmed == throwaway pool, not production)');

  // --- Step 3: factory ---
  console.log('\n\n--- STEP 3: IncentifiV4Factory ---');
  const factoryArtifact = await artifacts.readArtifact('IncentifiV4Factory');
  const factoryDeployHash = await wallet.deployContract({
    abi: factoryArtifact.abi,
    bytecode: factoryArtifact.bytecode as `0x${string}`,
    args: [POOL_MANAGER, foundAddress],
  });
  const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryDeployHash });
  trackGas('IncentifiV4Factory deploy', factoryReceipt);
  const factoryAddress = getAddress(factoryReceipt.contractAddress!);
  console.log('  address:', factoryAddress, '|', addrLink(factoryAddress));

  // --- Step 4: setFactory() — one-time wiring ---
  console.log('\n\n--- STEP 4: setFactory() (one-time wiring) ---');
  const setFactoryHash = await wallet.writeContract({
    address: foundAddress,
    abi: hookArtifact.abi,
    functionName: 'setFactory',
    args: [factoryAddress],
  });
  const setFactoryReceipt = await publicClient.waitForTransactionReceipt({ hash: setFactoryHash });
  trackGas('setFactory()', setFactoryReceipt);
  const factoryOnChain = getAddress(await hookContract.read.factory());
  if (factoryOnChain !== factoryAddress) throw new Error('hook.factory() mismatch after setFactory() — stopping.');
  console.log('  hook.factory() ==', factoryOnChain, '(confirmed)');

  // --- Step 5: router ---
  console.log('\n\n--- STEP 5: IncentifiV4Router ---');
  const routerArtifact = await artifacts.readArtifact('IncentifiV4Router');
  const routerDeployHash = await wallet.deployContract({
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode as `0x${string}`,
    args: [POOL_MANAGER, foundAddress, factoryAddress],
  });
  const routerReceipt = await publicClient.waitForTransactionReceipt({ hash: routerDeployHash });
  trackGas('IncentifiV4Router deploy', routerReceipt);
  const routerAddress = getAddress(routerReceipt.contractAddress!);
  console.log('  address:', routerAddress, '|', addrLink(routerAddress));

  // --- Step 6: real token launch ---
  console.log('\n\n--- STEP 6: real token launch (test-scale pricing) ---');
  const launchTokenArtifact = await artifacts.readArtifact('IncentifiLaunchToken');
  const tokenDeployHash = await wallet.deployContract({
    abi: launchTokenArtifact.abi,
    bytecode: launchTokenArtifact.bytecode as `0x${string}`,
    args: ['Incentifi V4 Mainnet Test', 'V4MAINTEST', TOTAL_SUPPLY],
  });
  const tokenDeployReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenDeployHash });
  trackGas('Token deploy (IncentifiLaunchToken)', tokenDeployReceipt);
  const tokenAddress = getAddress(tokenDeployReceipt.contractAddress!);
  console.log('  token address:', tokenAddress, '|', addrLink(tokenAddress));

  const tokenContract = await viem.getContractAt('IncentifiLaunchToken', tokenAddress);
  const approveHash = await tokenContract.write.approve([factoryAddress, TOTAL_SUPPLY]);
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  trackGas('Token approve(factory, TOTAL_SUPPLY)', approveReceipt);

  const factoryContract = await viem.getContractAt('IncentifiV4Factory', factoryAddress);
  const launchHash = await factoryContract.write.launchToken([tokenAddress]);
  const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: launchHash });
  trackGas('factory.launchToken() — includes real PoolManager.initialize()', launchReceipt);

  const poolId = keccak256(
    encodeAbiParameters(
      parseAbiParameters('address, address, uint24, int24, address'),
      [getAddress('0x0000000000000000000000000000000000000000'), tokenAddress, 0, 200, foundAddress]
    )
  );
  const slot0Launch = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
  const expectedLaunchPrice = await hookContract.read.launchSqrtPriceX96();
  if (slot0Launch[0] !== expectedLaunchPrice) throw new Error('StateView launch price does not match hook.launchSqrtPriceX96() — stopping.');
  const Q192 = 2n ** 96n * 2n ** 96n;
  const impliedLaunchMcapEth = Number((TOTAL_SUPPLY * Q192) / (slot0Launch[0] * slot0Launch[0])) / 1e18;
  console.log('  PoolId:', poolId);
  console.log('  StateView (independent) confirms launch sqrtPriceX96:', slot0Launch[0].toString());
  console.log('  Implied launch market cap:', impliedLaunchMcapEth.toFixed(4), 'ETH (~$', (impliedLaunchMcapEth * 2500).toFixed(2), 'at a nominal $2,500/ETH)');

  // --- Step 7: real buy + sell, test scale ---
  console.log('\n\n--- STEP 7: real buy + sell ---');
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const routerContract = await viem.getContractAt('IncentifiV4Router', routerAddress);
  const smallBuyEth = parseEther('0.005');
  const buyHash = await routerContract.write.buyToken([tokenAddress, 0n, deadline], { value: smallBuyEth });
  const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
  trackGas('buyToken() (0.005 ETH)', buyReceipt);
  const tokenBalanceAfterBuy = await tokenContract.read.balanceOf([walletAddress]);
  console.log('  tokens received:', tokenBalanceAfterBuy.toString());

  const sellApproveHash = await tokenContract.write.approve([routerAddress, tokenBalanceAfterBuy]);
  await publicClient.waitForTransactionReceipt({ hash: sellApproveHash });
  const sellHash = await routerContract.write.sellToken([tokenAddress, tokenBalanceAfterBuy, 0n, deadline]);
  const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellHash });
  trackGas('sellToken() (full balance)', sellReceipt);

  const testLossPoolDeposited = await publicClient.readContract({
    address: lossRewardPoolAddress,
    abi: lossRewardPoolArtifact.abi,
    functionName: 'totalDeposited',
    args: [tokenAddress],
  });
  console.log('  throwaway LossRewardPool.totalDeposited(token):', testLossPoolDeposited, '(real fee flow on the THROWAWAY pool)');

  // --- Step 8: drive to the real, test-scale graduation boundary ---
  console.log('\n\n--- STEP 8: driving to the test-scale graduation boundary ---');
  const graduationTarget = await hookContract.read.GRADUATION_ETH_TARGET();
  const stateBeforeGrad = await hookContract.read.curveStates([poolId]);
  const realEthReserveBeforeGrad = stateBeforeGrad[4] as bigint;
  const maxNetEth = graduationTarget - realEthReserveBeforeGrad;
  const maxGrossEth = 100n * (maxNetEth / 98n) + (maxNetEth % 98n);
  // A modest 1.05x overshoot — enough to exercise the real clamp+refund path
  // (any amount over the exact target triggers it), without sending 3x real
  // ETH out of the wallet the way the fork's stress test deliberately did.
  const overshootGrossEth = (maxGrossEth * 105n) / 100n;
  console.log('  realEthReserve before:', formatEther(realEthReserveBeforeGrad), 'ETH');
  console.log('  GRADUATION_ETH_TARGET:', formatEther(graduationTarget), 'ETH (~$', (Number(graduationTarget) / 1e18 * 2500).toFixed(2), ')');
  console.log('  exact clamp target:', formatEther(maxGrossEth), 'ETH');
  console.log('  sending (1.05x, to force the clamp path for real):', formatEther(overshootGrossEth), 'ETH');

  // JUST-IN-TIME floor: computed from the REAL on-chain state right before
  // this transaction, not guessed in advance. overshootGrossEth is msg.value
  // for this one call — the wallet needs at least that much plus real gas for
  // this transaction specifically. Of that, ~5% (the overshoot) comes straight
  // back in this same transaction; the clamped 100% is genuinely spent — see
  // the breakdown below, not "transiently needed".
  const gradGasBuffer = parseEther('0.005'); // generous pad above the ~500-520K units x real gas price actually measured on the fork
  const walletBalanceBeforeGrad = await publicClient.getBalance({ address: walletAddress });
  if (walletBalanceBeforeGrad < overshootGrossEth + gradGasBuffer) {
    throw new Error(
      `Wallet balance (${formatEther(walletBalanceBeforeGrad)} ETH) is insufficient for the graduating buy: needs ${formatEther(overshootGrossEth)} ETH (msg.value, ~5% of which is refunded in this same transaction) plus a ${formatEther(gradGasBuffer)} ETH gas buffer. Fund the wallet before re-running — stopping before sending, not after a failed transaction.`
    );
  }
  const creatorFeePortion = maxGrossEth / 100n;
  const lossPoolFeePortion = maxGrossEth / 100n;
  const lockedLiquidityPortion = maxGrossEth - creatorFeePortion - lossPoolFeePortion;
  console.log('  of the clamped', formatEther(maxGrossEth), 'ETH (NOT refunded — this is a real purchase):');
  console.log('    ->', formatEther(creatorFeePortion), 'ETH to creatorBalances[wallet] (claimable later via claimCreatorFees())');
  console.log('    ->', formatEther(lossPoolFeePortion), 'ETH deposited into the throwaway LossRewardPool (stuck without manually operating its epoch/merkle-root system)');
  console.log('    ->', formatEther(lockedLiquidityPortion), 'ETH becomes real, PERMANENTLY LOCKED AMM liquidity (not withdrawable by anyone, ever, by design)');
  console.log('  in exchange, the wallet receives real tokens from this buy, tradeable against that same locked liquidity.');

  const gradHash = await routerContract.write.buyToken([tokenAddress, 0n, deadline], { value: overshootGrossEth });
  const gradReceipt = await publicClient.waitForTransactionReceipt({ hash: gradHash });
  trackGas('Graduating buyToken() — includes real liquidity deposit (2 mints + 1 corrective swap)', gradReceipt);

  const walletBalanceAfterGrad = await publicClient.getBalance({ address: walletAddress });
  const gradGasCost = gradReceipt.gasUsed * gradReceipt.effectiveGasPrice;
  const netOutflow = walletBalanceBeforeGrad - walletBalanceAfterGrad - gradGasCost;
  console.log('  real net ETH outflow (excl. this tx\'s own gas):', formatEther(netOutflow), 'ETH vs exact clamp target', formatEther(maxGrossEth), 'ETH');
  if (netOutflow !== maxGrossEth) {
    throw new Error(`Clamp/refund mismatch: expected exactly ${maxGrossEth} wei outflow, got ${netOutflow}. Stopping — this needs investigation before trusting anything past this point.`);
  }

  const stateAfterGrad = await hookContract.read.curveStates([poolId]);
  if (stateAfterGrad[3] !== true) throw new Error('state.graduated is not true after the graduating buy. Stopping.');
  if (stateAfterGrad[4] !== graduationTarget) throw new Error('realEthReserve did not land exactly on GRADUATION_ETH_TARGET. Stopping.');
  console.log('  state.graduated: true (confirmed)');
  console.log('  realEthReserve landed exactly on GRADUATION_ETH_TARGET (confirmed)');

  const gradLogs = await publicClient.getContractEvents({
    address: foundAddress,
    abi: hookArtifact.abi,
    eventName: 'GraduationLiquidityDeployed',
    fromBlock: gradReceipt.blockNumber,
    toBlock: gradReceipt.blockNumber,
  });
  if (gradLogs.length !== 1) throw new Error(`Expected exactly 1 GraduationLiquidityDeployed event, got ${gradLogs.length}. Stopping.`);
  const gradEvent = gradLogs[0].args as { bootstrapLiquidity: bigint; finalLiquidity: bigint; correctedSqrtPriceX96: bigint; ethDust: bigint; tokenDust: bigint };
  console.log('  GraduationLiquidityDeployed:', {
    bootstrapLiquidity: gradEvent.bootstrapLiquidity.toString(),
    finalLiquidity: gradEvent.finalLiquidity.toString(),
    correctedSqrtPriceX96: gradEvent.correctedSqrtPriceX96.toString(),
    ethDust: gradEvent.ethDust.toString(),
    tokenDust: gradEvent.tokenDust.toString(),
  });

  const slot0PostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
  const liquidityPostGrad = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] });
  if (slot0PostGrad[0] !== gradEvent.correctedSqrtPriceX96) throw new Error('StateView price does not match the graduation event. Stopping.');
  if (liquidityPostGrad !== gradEvent.bootstrapLiquidity + gradEvent.finalLiquidity) throw new Error('StateView liquidity does not match the graduation event. Stopping.');
  console.log('  StateView (independent, real): sqrtPriceX96 =', slot0PostGrad[0].toString(), '| liquidity =', liquidityPostGrad.toString(), '(both confirmed to match the hook\'s own reported numbers)');

  const realProdPoolBalanceAfter = await publicClient.getBalance({ address: REAL_PRODUCTION_LOSS_REWARD_POOL });
  if (realProdPoolBalanceAfter !== realProdPoolBalanceBefore) {
    throw new Error(`Real production LossRewardPool balance CHANGED (${formatEther(realProdPoolBalanceBefore)} -> ${formatEther(realProdPoolBalanceAfter)} ETH). This should be structurally impossible — investigate before trusting anything above.`);
  }
  console.log('\nConfirmed: real production LossRewardPool balance is unchanged (', formatEther(realProdPoolBalanceAfter), 'ETH, same as before this script ran).');

  const finalWalletBalance = await publicClient.getBalance({ address: walletAddress });
  console.log('\n\n=== SUMMARY ===');
  console.log('LossRewardPool (throwaway):', lossRewardPoolAddress, '|', addrLink(lossRewardPoolAddress));
  console.log('IncentifiV4HookTestnet:    ', foundAddress, '|', addrLink(foundAddress));
  console.log('IncentifiV4Factory:        ', factoryAddress, '|', addrLink(factoryAddress));
  console.log('IncentifiV4Router:         ', routerAddress, '|', addrLink(routerAddress));
  console.log('Token:                     ', tokenAddress, '|', addrLink(tokenAddress));
  console.log('PoolId:                    ', poolId);
  console.log('Total real gas spent across all transactions:', formatEther(totalGasWei), 'ETH');
  console.log('Wallet balance: before', formatEther(balance), 'ETH -> after', formatEther(finalWalletBalance), 'ETH');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n!!! SCRIPT STOPPED:', err.message ?? err);
    process.exit(1);
  });
