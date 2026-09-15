#!/usr/bin/env node
/**
 * Plan a sell of a LEGACY V4 token (one launched on a factory the site no longer resolves) through
 * Uniswap's UniversalRouter, and print the exact `cast` commands to run it from a Foundry keystore.
 *
 * READ-ONLY. This script never signs, never sends, never reads a key: it quotes, checks approvals,
 * simulates the swap from the holder's address when the approvals are in place, and prints commands.
 *
 * Why it exists (2026-09-15): V4MAINTEST (0x5e7C…33A0), from the very first V4 mainnet test, lives
 * on factory 0xe003e…ada27 / hook 0x76E8…6888 - a trio no current code knows - and has graduated.
 * IncentifiV4Router only trades pre-graduation, the wallet app's aggregator has no route to a hooked
 * V4 pool ("No quotes available"), but a graduated Incentifi pool is a plain V4 pool for swaps and
 * the V4 Quoter prices it, so UniversalRouter V4_SWAP (exactly what src/lib/legiblePool.ts does for
 * legible tokens) sells it. The pool key comes from the factory (getPoolKey) or, failing that, from
 * the PoolManager Initialize event in the launch receipt.
 *
 * Usage:
 *   node scripts/ops/v4-legacy-sell.mjs --token 0x5e7C…33A0 --wallet 0x78a4…c726 \
 *        [--amount full|<wei>] [--slippage 2] [--account incentifi-owner] [--rpc <url>] [--deadline-hours 24] [--factory <addr>]
 * Env: RPC_URLS (comma list; needs one archive-capable endpoint for the launch lookup) - nothing else. --rpc is only
 *      the URL written into the cast commands.
 */
import { createPublicClient, getAddress, parseAbi, parseAbiParameters, encodeAbiParameters, encodeFunctionData, decodeEventLog, decodeErrorResult, formatEther, isAddress } from 'viem';
import { createFailoverRpc, parseRpcUrls, failoverOptionsFromEnv } from '../lib/rpcFailover.mjs';

// ---- canonical Robinhood Chain addresses (same defaults as src/lib/uniswapAddresses.ts)
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const UNIVERSAL_ROUTER = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
export const V4_QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
export const V4_STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
export const V4_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const PERMIT2_ABI = parseAbi(['function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)']);
const FACTORY_ABI = parseAbi(['function getPoolKey(address token) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))', 'function isLaunched(address) view returns (bool)']);
const HOOK_ABI = parseAbi(['function curveStates(bytes32) view returns (address token, address creator, bool initialized, bool graduated, uint256 a, uint256 b)']);
const STATE_VIEW_ABI = parseAbi(['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)', 'function getLiquidity(bytes32) view returns (uint128)']);
const QUOTER_ABI = parseAbi(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']);
const UR_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const EVENTS = parseAbi(['event TokenLaunched(address indexed token, address indexed creator, bytes32 poolId)', 'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);

/** Byte-identical to src/lib/legiblePool.ts encodeUniversalRouterV4Swap (V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL). */
export function encodeUniversalRouterV4Swap(poolKey, zeroForOne, amountIn, amountOutMinimum, deadline) {
  const actions = '0x060c0f';
  const swapParams = encodeAbiParameters(parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)'), [{ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData: '0x' }]);
  const inCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const outCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const settle = encodeAbiParameters(parseAbiParameters('address, uint256'), [inCurrency, amountIn]);
  const take = encodeAbiParameters(parseAbiParameters('address, uint256'), [outCurrency, amountOutMinimum]);
  const input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [actions, [swapParams, settle, take]]);
  return encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: ['0x10', [input], deadline] });
}

export function poolIdOf(poolKey) {
  return encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]);
}

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }

export async function planLegacySell({ client, rpc, token, wallet, amount = 'full', slippagePct = 2, deadlineHours = 24, account = 'incentifi-owner', rpcUrlForCast, factoryHint = null, log = (m) => console.log(m) }) {
  const TOKEN = getAddress(token); const W = getAddress(wallet);
  const [symbol, decimals, balance, ethBalance] = await Promise.all([
    client.readContract({ address: TOKEN, abi: ERC20, functionName: 'symbol' }).catch(() => '?'), client.readContract({ address: TOKEN, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
    client.readContract({ address: TOKEN, abi: ERC20, functionName: 'balanceOf', args: [W] }), client.getBalance({ address: W }),
  ]);
  const amountIn = amount === 'full' ? BigInt(balance) : BigInt(amount);
  if (amountIn <= 0n) throw new Error(`${W} holds no ${symbol}`);
  if (amountIn > BigInt(balance)) throw new Error(`amount ${amountIn} exceeds the wallet balance ${balance}`);
  log(`Token ${symbol} ${TOKEN} | wallet ${W} holds ${formatEther(balance)} | ETH for gas ${formatEther(ethBalance)}`);

  // 1. pool key. Preferred: --factory (getPoolKey). Otherwise find the launch: the token's deployment
  //    block by binary search on eth_getCode, then the 1B-token transfer INTO the factory within the
  //    next 200k blocks, whose receipt carries TokenLaunched (factory) and PoolManager Initialize (key).
  let poolKey = null; let factory = factoryHint ? getAddress(factoryHint) : null; let poolId = null;
  if (!factory) {
    const head = await client.getBlockNumber();
    let lo = 0n; let hi = head; // first block where the token has code
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      let code;
      try { code = await client.getCode({ address: TOKEN, blockNumber: mid }); }
      catch (err) { throw new Error(`historical eth_getCode at block ${mid} failed on every endpoint (${err.shortMessage || err.message}); the deployment-block search needs an archive endpoint in RPC_URLS, or pass --factory <address>`); }
      if (code && code !== '0x') hi = mid; else lo = mid;
    }
    const deployedAt = hi;
    log(`Token code first present at block ${deployedAt}; looking for the 1B launch transfer after it`);
    let launchLog = null;
    for (let f = deployedAt; f <= deployedAt + 200_000n && !launchLog; f += 9000n) {
      const logs = await client.getLogs({ address: TOKEN, event: EVENTS[2], fromBlock: f, toBlock: f + 8999n });
      launchLog = logs.find((l) => l.args.value === 10n ** 27n && l.args.from !== ZERO) || null;
    }
    if (!launchLog) throw new Error(`no 1,000,000,000-token launch transfer found within 200k blocks of ${deployedAt}; pass --factory <address>`);
    const rcpt = await client.getTransactionReceipt({ hash: launchLog.transactionHash });
    for (const l of rcpt.logs) {
      try { const d = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics }); if (d.eventName === 'Initialize') { poolKey = { currency0: d.args.currency0, currency1: d.args.currency1, fee: Number(d.args.fee), tickSpacing: Number(d.args.tickSpacing), hooks: d.args.hooks }; poolId = d.args.id; } if (d.eventName === 'TokenLaunched') factory = l.address; } catch { /* other event */ }
    }
    log(`Launch tx ${launchLog.transactionHash} (block ${launchLog.blockNumber})`);
  }
  if (false) {
    const rcpt = await client.getTransactionReceipt({ hash: launchLog.transactionHash });
    for (const l of rcpt.logs) {
      try { const d = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics }); if (d.eventName === 'Initialize') { poolKey = { currency0: d.args.currency0, currency1: d.args.currency1, fee: Number(d.args.fee), tickSpacing: Number(d.args.tickSpacing), hooks: d.args.hooks }; poolId = d.args.id; } if (d.eventName === 'TokenLaunched') factory = l.address; } catch { /* other event */ }
    }
  }
  if (factory) {
    try { const k = await client.readContract({ address: getAddress(factory), abi: FACTORY_ABI, functionName: 'getPoolKey', args: [TOKEN] }); poolKey = { currency0: k.currency0, currency1: k.currency1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks }; } catch { /* keep Initialize */ }
  }
  if (!poolKey) throw new Error(`could not determine the V4 pool key for ${TOKEN} (no launch receipt with a PoolManager Initialize found)`);
  poolId = poolId || poolIdOf(poolKey);
  log(`Factory ${factory || 'unknown'} | hook ${poolKey.hooks} | pool ETH/${symbol} fee ${poolKey.fee} tickSpacing ${poolKey.tickSpacing} | poolId ${poolId}`);
  const tokenIs1 = poolKey.currency1.toLowerCase() === TOKEN.toLowerCase();
  const zeroForOne = !tokenIs1; // selling the token: token -> ETH

  // 2. state
  const [cs, slot0, liq] = await Promise.all([
    client.readContract({ address: poolKey.hooks, abi: HOOK_ABI, functionName: 'curveStates', args: [poolId] }).catch(() => null),
    client.readContract({ address: V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] }), client.readContract({ address: V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] }),
  ]);
  const graduated = cs ? Boolean(cs[3]) : null;
  log(`Graduated: ${graduated === null ? 'unknown (no curveStates)' : graduated} | tick ${slot0[1]} | liquidity ${liq}`);
  if (graduated === false) log('WARNING: not graduated - a pre-graduation Incentifi pool may only accept its own router; the quote below decides.');

  // 3. quotes
  const quote = async (amt) => { const { result } = await client.simulateContract({ address: V4_QUOTER, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne, exactAmount: amt, hookData: '0x' }] }); return result[0]; };
  const rows = [];
  for (const [label, amt] of [['requested', amountIn], ['10% of balance', BigInt(balance) / 10n], ['1% of balance', BigInt(balance) / 100n]]) {
    try { const out = await quote(amt); rows.push({ label, tokens: formatEther(amt), eth: formatEther(out) }); } catch (e) { rows.push({ label, tokens: formatEther(amt), eth: 'QUOTE FAILED: ' + (e.shortMessage || e.message).split('\n')[0] }); }
  }
  for (const r of rows) log(`  quote ${r.label.padEnd(15)} ${r.tokens} ${symbol} -> ${r.eth} ETH`);
  const quotedOut = await quote(amountIn);
  const bps = BigInt(Math.round(slippagePct * 100));
  const minOut = (quotedOut * (10_000n - bps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineHours * 3600);
  const calldata = encodeUniversalRouterV4Swap(poolKey, zeroForOne, amountIn, minOut, deadline);

  // 4. approvals
  const [erc20Allowance, permit] = await Promise.all([
    client.readContract({ address: TOKEN, abi: ERC20, functionName: 'allowance', args: [W, PERMIT2] }),
    client.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [W, TOKEN, UNIVERSAL_ROUTER] }),
  ]);
  const nowSec = Math.floor(Date.now() / 1000);
  const needErc20 = BigInt(erc20Allowance) < amountIn;
  const needPermit = BigInt(permit[0]) < amountIn || Number(permit[1]) <= nowSec + 3600;
  const permitExpiration = nowSec + 30 * 24 * 3600;

  // 5. simulate the swap from the wallet when approvals are already in place
  let simulation = 'skipped (approvals missing - run steps 1-2 first, then re-run this script to simulate)';
  if (!needErc20 && !needPermit) {
    try { await client.request({ method: 'eth_call', params: [{ from: W, to: UNIVERSAL_ROUTER, data: calldata }, 'latest'] }); simulation = 'SUCCESS'; }
    catch (e) { const raw = e?.cause?.data ?? e?.data; let d = null; try { d = decodeErrorResult({ abi: parseAbi(['error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)', 'error DeadlinePassed(uint256 deadline)', 'error InsufficientAllowance(uint256 amount)', 'error AllowanceExpired(uint256 deadline)']), data: typeof raw === 'string' ? raw : raw?.data }); } catch {} simulation = `REVERT ${d ? `${d.errorName}(${d.args.map(String).join(', ')})` : JSON.stringify(raw) || (e.shortMessage || e.message).split('\n')[0]}`; }
  }

  const rpcFlag = rpcUrlForCast ? ` --rpc-url ${rpcUrlForCast}` : ' --rpc-url $RPC_URL';
  const acct = ` --account ${account}`;
  const commands = [];
  if (needErc20) commands.push({ step: `approve ${symbol} to Permit2 (once)`, cmd: `cast send ${TOKEN} "approve(address,uint256)" ${PERMIT2} ${MAX_UINT256}${acct}${rpcFlag}` });
  if (needPermit) commands.push({ step: 'Permit2: allow UniversalRouter to pull the token (once, 30 days)', cmd: `cast send ${PERMIT2} "approve(address,address,uint160,uint48)" ${TOKEN} ${UNIVERSAL_ROUTER} ${MAX_UINT160} ${permitExpiration}${acct}${rpcFlag}` });
  commands.push({ step: `sell ${formatEther(amountIn)} ${symbol} for >= ${formatEther(minOut)} ETH (quote ${formatEther(quotedOut)}, ${slippagePct}% slippage, deadline ${new Date(Number(deadline) * 1000).toISOString()})`, cmd: `cast send ${UNIVERSAL_ROUTER} ${calldata}${acct}${rpcFlag}` });
  return { symbol, decimals, balance: BigInt(balance), ethBalance, amountIn, poolKey, poolId, factory, graduated, quotedOut, minOut, deadline, calldata, needErc20, needPermit, simulation, commands };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/ops/v4-legacy-sell.mjs')) {
  const token = arg('token'); const wallet = arg('wallet');
  if (!token || !wallet || !isAddress(token) || !isAddress(wallet)) { console.error('usage: node scripts/ops/v4-legacy-sell.mjs --token <addr> --wallet <addr> [--amount full|wei] [--slippage 2] [--account incentifi-owner] [--rpc url] [--deadline-hours 24] [--factory addr]'); process.exit(2); }
  // Reads go through RPC_URLS (or the documented public list, which includes an archive-capable endpoint);
  // --rpc only sets the --rpc-url printed in the cast commands.
  const urls = process.env.RPC_URLS ? parseRpcUrls(process.env) : ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc-robinhood.blockmachine.io', 'https://robinhood.api.pocket.network'];
  const rpc = createFailoverRpc(urls, { name: 'legacy-sell', ...failoverOptionsFromEnv(process.env), log: () => {} });
  const client = createPublicClient({ transport: rpc.transport, cacheTime: 0 });
  const plan = await planLegacySell({ client, rpc, token, wallet, amount: arg('amount', 'full'), slippagePct: Number(arg('slippage', '2')), deadlineHours: Number(arg('deadline-hours', '24')), account: arg('account', 'incentifi-owner'), rpcUrlForCast: arg('rpc', null), factoryHint: arg('factory', null) });
  console.log(`\nApprovals: token->Permit2 ${plan.needErc20 ? 'MISSING' : 'ok'}, Permit2->UniversalRouter ${plan.needPermit ? 'MISSING' : 'ok'} | swap simulation: ${plan.simulation}`);
  console.log(`\nRun these in order (the key never leaves the Foundry keystore; nothing here signs):\n`);
  plan.commands.forEach((c, i) => console.log(`# ${i + 1}. ${c.step}\n${c.cmd}\n`));
  console.log('Then verify: cast balance ' + getAddress(wallet) + ' --rpc-url $RPC_URL   and   cast call ' + getAddress(token) + ' "balanceOf(address)(uint256)" ' + getAddress(wallet) + ' --rpc-url $RPC_URL');
  process.exit(0);
}
