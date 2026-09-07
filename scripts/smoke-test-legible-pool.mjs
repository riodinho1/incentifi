#!/usr/bin/env node
/**
 * Mainnet smoke test for the V4 legible pool (PR #17 deployment on Robinhood Chain, chain 4663).
 *
 * From a THROWAWAY wallet it:
 *   1. deploys a fresh IncentifiLaunchToken (1B supply) and launches it through the legible
 *      factory with rewardAsset = address(0) (ETH loss rewards);
 *   2. buys 0.01 ETH of it through Uniswap's UniversalRouter (the same path terminals use);
 *   3. sells half of what it bought back through UniversalRouter (Permit2 approvals);
 *   4. calls hook.collect(token)  -> LP fees split 1% creator (pull-payment) / 1% LossRewardPool;
 *   5. calls converter.convert(token, 0, 0) -> token-side fees sold to ETH, split the same way;
 * and prints, for every swap, the PoolManager Swap event (amounts, sqrtPrice, liquidity, tick,
 * fee) with slot0 before/after, the hook's Bought/Sold events, and the ETH that reached
 * creatorBalances and the LossRewardPool.
 *
 * Safety:
 *   - the key is read from SMOKE_TEST_PRIVATE_KEY in YOUR shell environment only, never from an
 *     argument, never from .env.local, never printed. Use a throwaway wallet funded with ~0.03 ETH.
 *   - it refuses to run unless SMOKE_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET is set.
 *   - it never touches the owner key and never calls any owner-only function.
 *
 * Usage (PowerShell):
 *   $env:SMOKE_TEST_PRIVATE_KEY = "0x<throwaway key>"; $env:SMOKE_CONFIRM = "I_UNDERSTAND_THIS_IS_MAINNET"
 *   node scripts/smoke-test-legible-pool.mjs
 *   Remove-Item Env:SMOKE_TEST_PRIVATE_KEY; Remove-Item Env:SMOKE_CONFIRM
 *
 * Optional env: LEGIBLE_HOOK, LEGIBLE_FACTORY, LEGIBLE_FEE_CONVERTER (default: the 2026-09-07
 * deployment), SMOKE_BUY_WEI (default 0.01 ETH), SMOKE_SYMBOL (default SMK<timestamp>).
 */
import { readFileSync, existsSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  encodeAbiParameters,
  parseAbiParameters,
  decodeEventLog,
  encodeDeployData,
  keccak256,
  getAddress,
  formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ----------------------------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------------------------
const env = {};
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const RPC_URL = process.env.VITE_EVM_RPC_URL || env.VITE_EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;

// PR #17 deployment (broadcast/DeployLegiblePool.s.sol/4663/run-latest.json), read back on-chain 2026-09-07.
const HOOK = getAddress(process.env.LEGIBLE_HOOK || '0x921d0bE20A21e5A687734b4dF6302EA55BD168C0');
const FACTORY = getAddress(process.env.LEGIBLE_FACTORY || '0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda');
const FEE_CONVERTER = getAddress(process.env.LEGIBLE_FEE_CONVERTER || '0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9');
// Canonical Uniswap V4 + Permit2 on Robinhood Chain (same addresses as src/lib/uniswapAddresses.ts).
const POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951');
const UNIVERSAL_ROUTER = getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904');
const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3');
const STATE_VIEW = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');

const BUY_WEI = BigInt(process.env.SMOKE_BUY_WEI || '10000000000000000'); // 0.01 ETH
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const SYMBOL = process.env.SMOKE_SYMBOL || `SMK${Math.floor(Date.now() / 1000) % 100000}`;

// UniversalRouter command + V4Router actions (Uniswap v4-periphery Actions.sol / universal-router Commands.sol)
const UR_V4_SWAP = 0x10;
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

// ----------------------------------------------------------------------------------------------
// ABIs
// ----------------------------------------------------------------------------------------------
const FACTORY_ABI = parseAbi([
  'function launchToken(address token, address rewardAsset) returns (bytes32 poolId)',
  'function isLaunched(address token) view returns (bool)',
  'function getPoolKey(address token) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  'function hook() view returns (address)',
  'event TokenLaunched(address indexed token, address indexed creator, bytes32 poolId)',
]);
const HOOK_ABI = parseAbi([
  'function collect(address token)',
  'function creatorBalances(address creator) view returns (uint256)',
  'function lossRewardPool() view returns (address)',
  'function feeConverter() view returns (address)',
  'function factory() view returns (address)',
  'function poolIdOf(address token) view returns (bytes32)',
  'function curveStates(bytes32 poolId) view returns (address token, address creator, bool initialized, bool graduated, uint256 realEthReserve, uint256 realTokenReserve)',
  'event Bought(bytes32 indexed poolId, address indexed trader, uint256 ethIn, uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event Sold(bytes32 indexed poolId, address indexed trader, uint256 tokensIn, uint256 ethOut, uint256 creatorFee, uint256 lossPoolFee)',
  'event FeesCollected(bytes32 indexed poolId, uint256 ethFees, uint256 tokenFees, uint256 creatorShare, uint256 lossPoolShare)',
  'event FeesConverted(bytes32 indexed poolId, uint256 tokensIn, uint256 ethOut)',
]);
const CONVERTER_ABI = parseAbi([
  'function convert(address token, uint256 amount, uint256 minEthOut) returns (uint256 ethOut)',
  'function pendingTokenFees(address token) view returns (uint256)',
  'function lossRewardPool() view returns (address)',
  'event Converted(address indexed token, uint256 tokensIn, uint256 ethOut, uint256 creatorShare, uint256 lossPoolShare)',
]);
const LOSS_POOL_ABI = parseAbi(['function totalDeposited(address token) view returns (uint256)']);
const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function creator() view returns (address)',
]);
const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const UR_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);
const PM_SWAP_EVENT = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'
);

// ----------------------------------------------------------------------------------------------
// Guards
// ----------------------------------------------------------------------------------------------
const key = process.env.SMOKE_TEST_PRIVATE_KEY;
if (!key) {
  console.error('SMOKE_TEST_PRIVATE_KEY is not set. Export a THROWAWAY wallet key in your shell (never pass it as an argument).');
  process.exit(1);
}
if (process.env.SMOKE_CONFIRM !== 'I_UNDERSTAND_THIS_IS_MAINNET') {
  console.error('Refusing to run: set SMOKE_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET. This spends real ETH on Robinhood Chain mainnet.');
  process.exit(1);
}
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
const chain = { id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });
const me = account.address;

const fmt = (wei) => `${formatEther(BigInt(wei))} ETH`;
const fmtTok = (wei) => `${(Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${SYMBOL}`;

// Gas policy (2026-09-07 post-mortem, tx 0x81c6b0e8...): the first buy was sent with viem's bare
// estimate (194,373) and ran out of gas inside the nested token transfer (the node itself
// estimates 198,695; a V4 swap through UniversalRouter is ~6 calls deep and needs the 1/64
// reserve at every level). Every transaction now carries the node estimate + 30%, and the two
// swaps and convert() never go below 300,000.
const SWAP_GAS_FLOOR = 300_000n;
function withHeadroom(estimate, floor = 0n) {
  const padded = estimate + (estimate * 30n) / 100n;
  return padded < floor ? floor : padded;
}

async function send(label, request, floor = 0n) {
  const estimate = await publicClient.estimateContractGas({ ...request, account });
  const gas = withHeadroom(estimate, floor);
  console.log(`  -> ${label}: gas estimate ${estimate}, limit ${gas}`);
  const hash = await walletClient.writeContract({ ...request, gas });
  console.log(`     tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted (${hash})`);
  console.log(`     mined in block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed}`);
  return receipt;
}

function decodeAll(receipt, address, abi) {
  const out = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      out.push(decodeEventLog({ abi, data: log.data, topics: log.topics }));
    } catch { /* not one of ours */ }
  }
  return out;
}

function printSwapEvents(receipt, poolId) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== POOL_MANAGER.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [PM_SWAP_EVENT], data: log.data, topics: log.topics });
      if (ev.args.id.toLowerCase() !== poolId.toLowerCase()) continue;
      console.log('     PoolManager.Swap:');
      console.log(`       sender       ${ev.args.sender}`);
      console.log(`       amount0 (ETH)   ${ev.args.amount0}  (${fmt(ev.args.amount0 < 0n ? -ev.args.amount0 : ev.args.amount0)})`);
      console.log(`       amount1 (token) ${ev.args.amount1}  (${fmtTok(ev.args.amount1 < 0n ? -ev.args.amount1 : ev.args.amount1)})`);
      console.log(`       sqrtPriceX96 ${ev.args.sqrtPriceX96}`);
      console.log(`       liquidity    ${ev.args.liquidity}`);
      console.log(`       tick         ${ev.args.tick}`);
      console.log(`       fee (pips)   ${ev.args.fee}  (${Number(ev.args.fee) / 10_000}%)`);
    } catch { /* not a Swap */ }
  }
}

async function slot0(poolId) {
  const [sqrtPriceX96, tick, , lpFee] = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] });
  const liquidity = await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] });
  return { sqrtPriceX96, tick, lpFee, liquidity };
}

function printSlot0(label, s) {
  console.log(`     slot0 ${label}: sqrtPriceX96=${s.sqrtPriceX96} tick=${s.tick} liquidity=${s.liquidity} lpFee=${s.lpFee}`);
}

function urInputs(poolKey, zeroForOne, amountIn) {
  const actions = `0x${[ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL].map((a) => a.toString(16).padStart(2, '0')).join('')}`;
  const swapParams = encodeAbiParameters(
    parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)'),
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum: 0n, hookData: '0x' }]
  );
  const settle = encodeAbiParameters(parseAbiParameters('address, uint256'), [zeroForOne ? poolKey.currency0 : poolKey.currency1, amountIn]);
  const take = encodeAbiParameters(parseAbiParameters('address, uint256'), [zeroForOne ? poolKey.currency1 : poolKey.currency0, 0n]);
  const input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [actions, [swapParams, settle, take]]);
  return { commands: `0x${UR_V4_SWAP.toString(16).padStart(2, '0')}`, inputs: [input] };
}

// ----------------------------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------------------------
async function main() {
  console.log('=== V4 legible pool mainnet smoke test ===');
  console.log(`wallet   ${me} (throwaway)`);
  console.log(`hook     ${HOOK}\nfactory  ${FACTORY}\nconverter ${FEE_CONVERTER}`);
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`wrong chain: ${chainId}`);
  const [hookOfFactory, converterOfHook, factoryOfHook, lossPool] = await Promise.all([
    publicClient.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'hook' }),
    publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: 'feeConverter' }),
    publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: 'factory' }),
    publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: 'lossRewardPool' }),
  ]);
  if (getAddress(hookOfFactory) !== HOOK || getAddress(converterOfHook) !== FEE_CONVERTER || getAddress(factoryOfHook) !== FACTORY) {
    throw new Error('wiring mismatch between hook, factory and converter - refusing to continue');
  }
  const LOSS_POOL = getAddress(lossPool);
  console.log(`lossRewardPool ${LOSS_POOL}`);

  const balance = await publicClient.getBalance({ address: me });
  console.log(`balance  ${fmt(balance)}`);
  if (balance < BUY_WEI + 5_000_000_000_000_000n) throw new Error(`fund the throwaway with at least ${fmt(BUY_WEI + 5_000_000_000_000_000n)} (buy + gas)`);

  // 1. deploy + launch --------------------------------------------------------------------------
  console.log(`\n[1] deploy ${SYMBOL} and launch it (rewardAsset = ETH)`);
  const artifact = JSON.parse(readFileSync('artifacts/contracts/IncentifiLaunchToken.sol/IncentifiLaunchToken.json', 'utf8'));
  const deployData = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [SYMBOL, SYMBOL, TOTAL_SUPPLY] });
  const deployEstimate = await publicClient.estimateGas({ account, data: deployData });
  const deployGas = withHeadroom(deployEstimate);
  console.log(`  -> deploy: gas estimate ${deployEstimate}, limit ${deployGas}`);
  const deployHash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [SYMBOL, SYMBOL, TOTAL_SUPPLY], gas: deployGas });
  console.log(`     tx ${deployHash}`);
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== 'success' || !deployReceipt.contractAddress) throw new Error('token deployment failed');
  const TOKEN = getAddress(deployReceipt.contractAddress);
  console.log(`     token ${TOKEN}`);
  await send('approve(factory, supply)', { address: TOKEN, abi: ERC20_ABI, functionName: 'approve', args: [FACTORY, TOTAL_SUPPLY] });
  const launchReceipt = await send('factory.launchToken(token, address(0))', { address: FACTORY, abi: FACTORY_ABI, functionName: 'launchToken', args: [TOKEN, '0x0000000000000000000000000000000000000000'] });
  const launched = decodeAll(launchReceipt, FACTORY, FACTORY_ABI).find((e) => e.eventName === 'TokenLaunched');
  const poolId = launched?.args?.poolId ?? (await publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: 'poolIdOf', args: [TOKEN] }));
  const poolKey = await publicClient.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getPoolKey', args: [TOKEN] });
  console.log(`     poolId ${poolId}`);
  console.log(`     poolKey currency0=${poolKey.currency0} currency1=${poolKey.currency1} fee=${poolKey.fee} tickSpacing=${poolKey.tickSpacing} hooks=${poolKey.hooks}`);
  printSlot0('after launch', await slot0(poolId));

  const creatorBefore = await publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: 'creatorBalances', args: [me] });
  const poolDepositedBefore = await publicClient.readContract({ address: LOSS_POOL, abi: LOSS_POOL_ABI, functionName: 'totalDeposited', args: [TOKEN] });

  // 2. buy via UniversalRouter -----------------------------------------------------------------
  console.log(`\n[2] buy ${fmt(BUY_WEI)} via UniversalRouter`);
  const before = await slot0(poolId);
  printSlot0('before', before);
  const buy = urInputs(poolKey, true, BUY_WEI);
  const buyReceipt = await send('UniversalRouter.execute (V4_SWAP zeroForOne)', {
    address: UNIVERSAL_ROUTER, abi: UR_ABI, functionName: 'execute', args: [buy.commands, buy.inputs, BigInt(Math.floor(Date.now() / 1000) + 600)], value: BUY_WEI,
  }, SWAP_GAS_FLOOR);
  printSwapEvents(buyReceipt, poolId);
  const bought = decodeAll(buyReceipt, HOOK, HOOK_ABI).find((e) => e.eventName === 'Bought');
  if (bought) console.log(`     hook.Bought: trader=${bought.args.trader} ethIn=${fmt(bought.args.ethIn)} tokensOut=${fmtTok(bought.args.tokensOut)} creatorFee=${fmt(bought.args.creatorFee)} lossPoolFee=${fmt(bought.args.lossPoolFee)}`);
  printSlot0('after', await slot0(poolId));
  const tokenBalance = await publicClient.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] });
  console.log(`     wallet now holds ${fmtTok(tokenBalance)}`);

  // 3. sell half via UniversalRouter (Permit2) ---------------------------------------------------
  const sellAmount = tokenBalance / 2n;
  console.log(`\n[3] sell half (${fmtTok(sellAmount)}) via UniversalRouter`);
  await send('token.approve(Permit2, max)', { address: TOKEN, abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, (1n << 256n) - 1n] });
  await send('Permit2.approve(token, UniversalRouter, amount, 1 day)', { address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve', args: [TOKEN, UNIVERSAL_ROUTER, sellAmount, Math.floor(Date.now() / 1000) + 86400] });
  printSlot0('before', await slot0(poolId));
  const ethBeforeSell = await publicClient.getBalance({ address: me });
  const sell = urInputs(poolKey, false, sellAmount);
  const sellReceipt = await send('UniversalRouter.execute (V4_SWAP oneForZero)', {
    address: UNIVERSAL_ROUTER, abi: UR_ABI, functionName: 'execute', args: [sell.commands, sell.inputs, BigInt(Math.floor(Date.now() / 1000) + 600)],
  }, SWAP_GAS_FLOOR);
  printSwapEvents(sellReceipt, poolId);
  const sold = decodeAll(sellReceipt, HOOK, HOOK_ABI).find((e) => e.eventName === 'Sold');
  if (sold) console.log(`     hook.Sold: trader=${sold.args.trader} tokensIn=${fmtTok(sold.args.tokensIn)} ethOut=${fmt(sold.args.ethOut)} creatorFee=${fmt(sold.args.creatorFee)} lossPoolFee=${fmt(sold.args.lossPoolFee)}`);
  printSlot0('after', await slot0(poolId));
  const ethAfterSell = await publicClient.getBalance({ address: me });
  console.log(`     wallet ETH delta (incl. gas): ${formatEther(ethAfterSell - ethBeforeSell)} ETH`);

  // 4. collect -----------------------------------------------------------------------------------
  console.log('\n[4] hook.collect(token)');
  const collectReceipt = await send('hook.collect', { address: HOOK, abi: HOOK_ABI, functionName: 'collect', args: [TOKEN] });
  const collected = decodeAll(collectReceipt, HOOK, HOOK_ABI).find((e) => e.eventName === 'FeesCollected');
  if (collected) console.log(`     FeesCollected: ethFees=${fmt(collected.args.ethFees)} tokenFees=${fmtTok(collected.args.tokenFees)} creatorShare=${fmt(collected.args.creatorShare)} lossPoolShare=${fmt(collected.args.lossPoolShare)}`);
  const pending = await publicClient.readContract({ address: FEE_CONVERTER, abi: CONVERTER_ABI, functionName: 'pendingTokenFees', args: [TOKEN] });
  console.log(`     converter.pendingTokenFees = ${fmtTok(pending)}`);

  // 5. convert ----------------------------------------------------------------------------------
  console.log('\n[5] converter.convert(token, 0, 0)');
  if (pending === 0n) {
    console.log('     nothing to convert (no token-side fees)');
  } else {
    const convertReceipt = await send('converter.convert', { address: FEE_CONVERTER, abi: CONVERTER_ABI, functionName: 'convert', args: [TOKEN, 0n, 0n] }, SWAP_GAS_FLOOR);
    printSwapEvents(convertReceipt, poolId);
    const converted = decodeAll(convertReceipt, FEE_CONVERTER, CONVERTER_ABI).find((e) => e.eventName === 'Converted');
    if (converted) console.log(`     Converted: tokensIn=${fmtTok(converted.args.tokensIn)} ethOut=${fmt(converted.args.ethOut)} creatorShare=${fmt(converted.args.creatorShare)} lossPoolShare=${fmt(converted.args.lossPoolShare)}`);
    const fc = decodeAll(convertReceipt, HOOK, HOOK_ABI).find((e) => e.eventName === 'FeesConverted');
    if (fc) console.log(`     hook.FeesConverted: tokensIn=${fmtTok(fc.args.tokensIn)} ethOut=${fmt(fc.args.ethOut)} (tagged as conversion, not Sold)`);
  }

  // Summary ---------------------------------------------------------------------------------------
  const creatorAfter = await publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: 'creatorBalances', args: [me] });
  const poolDepositedAfter = await publicClient.readContract({ address: LOSS_POOL, abi: LOSS_POOL_ABI, functionName: 'totalDeposited', args: [TOKEN] });
  const state = await publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: 'curveStates', args: [poolId] });
  console.log('\n=== summary ===');
  console.log(`token                       ${TOKEN} (${SYMBOL})`);
  console.log(`poolId                      ${poolId}`);
  console.log(`creatorBalances (this wallet) ${fmt(creatorBefore)} -> ${fmt(creatorAfter)}  (+${fmt(creatorAfter - creatorBefore)})`);
  console.log(`LossRewardPool.totalDeposited ${fmt(poolDepositedBefore)} -> ${fmt(poolDepositedAfter)}  (+${fmt(poolDepositedAfter - poolDepositedBefore)})`);
  console.log(`curveStates: realEthReserve=${fmt(state[4])} realTokenReserve=${fmtTok(state[5])} graduated=${state[3]}`);
  printSlot0('final', await slot0(poolId));
  console.log('\nExpectation: creator and LossRewardPool each received ~1% of the buy ETH plus ~1% of the sell proceeds (the latter via convert). The Swap events must show a nonzero liquidity and fee = 20000. DexScreener should index this poolId within minutes.');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err.shortMessage || err.message);
  process.exit(1);
});
