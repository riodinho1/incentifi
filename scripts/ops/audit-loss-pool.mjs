#!/usr/bin/env node
/**
 * Read-only audit of the loss-reward pools (V1 + V2) against the CHAIN.
 *
 * Reproduces the 2026-09-20 audit: scans every log each pool has emitted since its deployment,
 * reconciles the event sums with the contracts' own counters (totalDeposited / totalAllocated /
 * totalClaimed), checks that pool ETH == unallocated + still-owed to the wei, and — when Supabase
 * credentials are available — cross-checks the database's published epochs, Merkle roots and claim
 * flags, sums what is still owed per holder, and lists who is underwater RIGHT NOW (chain balance,
 * database cost basis, current on-chain price) and whether they were in the last 3 epochs.
 *
 * Nothing is signed or sent. No private key is read. The database is only used to find candidates
 * and per-holder leaves; every number in the summary comes from the chain.
 *
 * Usage:
 *   RPC_URLS=<archive-capable endpoint>,... node scripts/ops/audit-loss-pool.mjs [--json out.json] [--no-db] [--resume]
 *
 *   --resume  reuses the log checkpoints in .audit-cache/ (AUDIT_CACHE_DIR to change; the full scan is ~25 min on public RPCs)
 *   --no-db   chain-only: skip Supabase (no per-holder or underwater sections)
 *   --json    also write the full result as JSON
 *
 * Env: RPC_URLS (or the documented public list); VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for the DB
 * sections (read from .env.local when present, the LAST occurrence of a key wins).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, getAddress, parseAbi, decodeEventLog, formatEther } from 'viem';
import { createFailoverRpc, parseRpcUrls, failoverOptionsFromEnv } from '../lib/rpcFailover.mjs';

const POOLS = {
  V1: getAddress('0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF'),
  V2: getAddress('0x5d94246CD31064Da02E953DB357F0001F0E9A631'),
};
// Known mainnet deployment blocks (verified 2026-09-20 by eth_getCode binary search). Used when the pool
// address matches; otherwise the block is found by binary search, which needs an archive endpoint.
const KNOWN_DEPLOY_BLOCK = { '0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf': 52_114_089n, '0x5d94246cd31064da02e953db357f0001f0e9a631': 57_140_594n };
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO = '0x0000000000000000000000000000000000000000';
const REASONS = ['ForcedEth', 'AssetDisabled', 'RegistryMismatch', 'AssetPaused', 'ClaimantBlocked', 'NoLiquidity', 'ReferenceUnavailable', 'BelowMinimum', 'BelowProtocolBound', 'SwapFailed'];
const EVENTS = parseAbi([
  'event RewardDeposited(address indexed token, address indexed sender, uint256 amount)',
  'event EpochRootPublished(address indexed token, uint256 indexed epochId, bytes32 merkleRoot, uint256 allocatedAmount)',
  'event RewardClaimed(address indexed token, uint256 indexed epochId, address indexed claimant, uint256 amount)',
  'event RewardPaid(address indexed token, address indexed claimant, uint256 ethAmount, address indexed asset, uint256 assetAmount)',
  'event RewardPaidInEthFallback(address indexed claimant, address indexed token, address indexed asset, uint8 reason, bytes data)',
  'event OperatorUpdated(address indexed previousOperator, address indexed newOperator)',
]);
const POOL_ABI = parseAbi([
  'function totalDeposited(address) view returns (uint256)', 'function totalAllocated(address) view returns (uint256)', 'function totalClaimed(address) view returns (uint256)',
  'function getUnallocatedBalance(address) view returns (uint256)', 'function operator() view returns (address)', 'function owner() view returns (address)',
  'function rewardAsset(address) view returns (address asset, bool assetSet, bool forcedEth)', 'function minStockRewardWei() view returns (uint256)',
  'function hasClaimed(address token, uint256 epochId, address claimant) view returns (bool)',
]);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)']);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const fe = (w) => formatEther(BigInt(w));
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0n);

// ---- env (.env.local, last occurrence wins — the file has a stray early SUPABASE_SERVICE_ROLE_KEY line)
if (fs.existsSync('.env.local')) for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[`__ENVLOCAL_${m[1]}`] = m[2].replace(/^['"]|['"]$/g, ''); }
const envv = (k) => process.env[k] || process.env[`__ENVLOCAL_${k}`] || '';

const urls = process.env.RPC_URLS ? parseRpcUrls(process.env) : ['https://rpc-robinhood.blockmachine.io', 'https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.api.pocket.network'];
const rpc = createFailoverRpc(urls, { name: 'audit', ...failoverOptionsFromEnv(process.env), paceMs: { eth_getLogs: Number(process.env.RPC_GETLOGS_MIN_INTERVAL_MS ?? 100) }, log: () => {} });
const client = createPublicClient({ transport: rpc.transport, cacheTime: 0 });

// ---- 1. every log each pool ever emitted (resumable)
const cacheDir = process.env.AUDIT_CACHE_DIR || '.audit-cache'; fs.mkdirSync(cacheDir, { recursive: true });
async function scanPool(name, address) {
  const ckFile = path.join(cacheDir, `${name}.checkpoint.json`), logFile = path.join(cacheDir, `${name}.logs.ndjson`);
  // A checkpoint is written atomically (tmp + rename); one left unreadable by a hard kill just restarts the pool's scan.
  let ck = null;
  if (flag('resume') && fs.existsSync(ckFile)) { try { ck = JSON.parse(fs.readFileSync(ckFile, 'utf8')); if (!ck || !ck.deployedAt || !ck.next) ck = null; } catch { ck = null; } }
  // Checkpoint unreadable (hard kill mid-write) but the append-only log file survived: every chunk's logs
  // are appended BEFORE its checkpoint, so resuming at (highest logged block + 1) neither skips nor
  // duplicates anything — chunks past that block were either never scanned or scanned empty.
  const knownDeploy = KNOWN_DEPLOY_BLOCK[address.toLowerCase()] ?? null;
  if (!ck && flag('resume') && knownDeploy !== null && fs.existsSync(logFile)) {
    let maxBlock = -1n, n = 0;
    for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) { if (!line.trim()) continue; try { const b = BigInt(JSON.parse(line).blockNumber); n++; if (b > maxBlock) maxBlock = b; } catch { /* torn last line: ignore */ } }
    if (maxBlock >= 0n) { ck = { deployedAt: knownDeploy.toString(), next: (maxBlock + 1n).toString(), logs: n, failed: [] }; process.stderr.write(`[scan ${name}] checkpoint unreadable; resuming from the log file at block ${maxBlock + 1n} (${n} logs kept)
`); }
  }
  const saveCk = () => {
    fs.writeFileSync(ckFile + '.tmp', JSON.stringify(ck));
    try { fs.renameSync(ckFile + '.tmp', ckFile); }
    catch { fs.copyFileSync(ckFile + '.tmp', ckFile); fs.unlinkSync(ckFile + '.tmp'); } // Windows: EPERM while another process reads the target
  };
  const head = (await client.getBlockNumber()) - 5n;
  if (!ck) {
    let hi = KNOWN_DEPLOY_BLOCK[address.toLowerCase()] ?? null;
    if (hi !== null && hi > head) hi = null; // not this chain (a fork or test chain): search instead
    if (hi === null) { // deployment block: first block with code (binary search from genesis, ~26 eth_getCode calls)
      let lo = 0n; hi = head;
      while (hi - lo > 1n) { const mid = (lo + hi) / 2n; const code = await client.getCode({ address, blockNumber: mid }); if (code && code !== '0x') hi = mid; else lo = mid; }
    }
    ck = { deployedAt: hi.toString(), next: hi.toString(), logs: 0, failed: [] }; fs.writeFileSync(logFile, '');
  }
  const total = Number(head - BigInt(ck.deployedAt)); let lastPct = -1;
  for (let b = BigInt(ck.next); b <= head; b += 9000n) {
    const t = b + 8999n > head ? head : b + 8999n;
    let logs = null;
    for (let attempt = 0; attempt < 3 && logs === null; attempt++) { try { logs = await client.request({ method: 'eth_getLogs', params: [{ address, fromBlock: '0x' + b.toString(16), toBlock: '0x' + t.toString(16) }] }); } catch { if (attempt === 2) ck.failed.push(b.toString()); } }
    if (logs && logs.length) { fs.appendFileSync(logFile, logs.map((l) => JSON.stringify(l)).join('\n') + '\n'); ck.logs += logs.length; }
    ck.next = (t + 1n).toString(); saveCk();
    const pct = Math.floor((Number(t - BigInt(ck.deployedAt)) / total) * 10) * 10; if (pct !== lastPct) { lastPct = pct; process.stderr.write(`[scan ${name}] ${pct}% (${ck.logs} logs${ck.failed.length ? `, ${ck.failed.length} failed chunks` : ''})\n`); }
  }
  const events = [];
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) { if (!line.trim()) continue; const l = JSON.parse(line); try { const d = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics }); events.push({ name: d.eventName, args: d.args, block: BigInt(l.blockNumber), tx: l.transactionHash }); } catch { /* not one of ours */ } }
  return { deployedAt: ck.deployedAt, head: head.toString(), failedChunks: ck.failed, events };
}
const scans = {}; for (const [name, address] of Object.entries(POOLS)) scans[name] = await scanPool(name, address);

// ---- 2. optional DB candidates
let db = null;
if (!flag('no-db') && envv('VITE_SUPABASE_URL') && envv('SUPABASE_SERVICE_ROLE_KEY')) {
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(envv('VITE_SUPABASE_URL'), envv('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const page = async (table, cols, order) => { const all = []; for (let o = 0; ; o += 1000) { const { data, error } = await sb.from(table).select(cols).order(order, { ascending: true }).range(o, o + 999); if (error) throw new Error(`${table}: ${error.message}`); all.push(...data); if (data.length < 1000) break; } return all; };
  db = { epochs: await page('reward_epochs', 'epoch_id, token_address, epoch_number, status, pool_address, total_distributed_eth, merkle_root, created_at', 'epoch_id'), rewards: await page('epoch_holder_rewards', 'id, epoch_id, token_address, wallet_address, final_reward_eth, claimed', 'id'), hcb: await page('holder_cost_basis', 'token_address, wallet_address, token_balance, total_invested_eth, avg_cost_basis_eth, is_eligible, is_underwater_seller', 'token_address') };
  const { data: tokens } = await sb.from('tokens').select('mint_address, hidden'); const { data: indexed } = await sb.from('indexed_tokens').select('mint_address'); db.tokens = tokens || []; db.indexed = indexed || [];
} else process.stderr.write('[db] skipped (no Supabase credentials or --no-db): chain-only audit\n');

// ---- 3. token universe = every token in the events (+ DB epochs)
const tokens = new Set();
for (const s of Object.values(scans)) for (const e of s.events) if (e.args.token) tokens.add(e.args.token.toLowerCase());
if (db) for (const e of db.epochs) tokens.add(e.token_address.toLowerCase());

// ---- 4. chain state per token/pool at ONE block
const B = (await client.getBlockNumber()) - 3n; const blk = await client.getBlock({ blockNumber: B });
const tsCache = new Map(); const ts = async (b) => { if (!tsCache.has(b)) tsCache.set(b, new Date(Number((await client.getBlock({ blockNumber: b })).timestamp) * 1000).toISOString()); return tsCache.get(b); };
const worker = db ? await import('../loss-reward-worker.mjs').catch(() => null) : null;
const result = { block: B.toString(), blockTime: new Date(Number(blk.timestamp) * 1000).toISOString(), pools: {}, tokens: [], flags: [] };
for (const [name, address] of Object.entries(POOLS)) {
  const [operator, owner] = await Promise.all([client.readContract({ address, abi: POOL_ABI, functionName: 'operator', blockNumber: B }), client.readContract({ address, abi: POOL_ABI, functionName: 'owner', blockNumber: B })]);
  result.pools[name] = { address, ethBalance: (await client.getBalance({ address, blockNumber: B })).toString(), operator, owner, deployedAt: scans[name].deployedAt, failedChunks: scans[name].failedChunks, totals: { deposited: 0n, allocated: 0n, claimed: 0n, unallocated: 0n } };
}
for (const tl of tokens) {
  const T = getAddress(tl); const symbol = await client.readContract({ address: T, abi: ERC20, functionName: 'symbol' }).catch(() => '?');
  for (const [name, address] of Object.entries(POOLS)) {
    const E = scans[name].events.filter((e) => e.args.token && e.args.token.toLowerCase() === tl);
    const [dep, alloc, claimed, unalloc] = await client.multicall({ multicallAddress: MULTICALL3, blockNumber: B, allowFailure: false, contracts: ['totalDeposited', 'totalAllocated', 'totalClaimed', 'getUnallocatedBalance'].map((fn) => ({ address, abi: POOL_ABI, functionName: fn, args: [T] })) });
    if (dep === 0n && !E.length) continue;
    const T0 = result.pools[name].totals; T0.deposited += dep; T0.allocated += alloc; T0.claimed += claimed; T0.unallocated += unalloc;
    const deps = E.filter((e) => e.name === 'RewardDeposited'), pubs = E.filter((e) => e.name === 'EpochRootPublished'), claims = E.filter((e) => e.name === 'RewardClaimed'), paid = E.filter((e) => e.name === 'RewardPaid'), fb = E.filter((e) => e.name === 'RewardPaidInEthFallback');
    const row = { symbol, token: T, pool: name, state: { deposited: dep.toString(), allocated: alloc.toString(), claimed: claimed.toString(), unallocated: unalloc.toString(), stillOwed: (alloc - claimed).toString() },
      events: { deposits: deps.length, depositedSum: sum(deps, (e) => e.args.amount).toString(), depositors: [...new Set(deps.map((e) => e.args.sender))], published: pubs.length, allocatedSum: sum(pubs, (e) => e.args.allocatedAmount).toString(), claims: claims.length, claimants: new Set(claims.map((e) => e.args.claimant.toLowerCase())).size, claimedSum: sum(claims, (e) => e.args.amount).toString() },
      firstEpoch: pubs.length ? { epoch: Number(pubs[0].args.epochId), time: await ts(pubs[0].block) } : null, lastEpoch: pubs.length ? { epoch: Number(pubs.at(-1).args.epochId), time: await ts(pubs.at(-1).block), tx: pubs.at(-1).tx } : null, lastDeposit: deps.length ? await ts(deps.at(-1).block) : null, lastClaim: claims.length ? await ts(claims.at(-1).block) : null };
    if (row.events.depositedSum !== row.state.deposited) result.flags.push(`${symbol}/${name}: deposit events (${fe(row.events.depositedSum)}) != totalDeposited (${fe(dep)})`);
    if (row.events.allocatedSum !== row.state.allocated) result.flags.push(`${symbol}/${name}: EpochRootPublished sum (${fe(row.events.allocatedSum)}) != totalAllocated (${fe(alloc)})`);
    if (row.events.claimedSum !== row.state.claimed) result.flags.push(`${symbol}/${name}: RewardClaimed sum (${fe(row.events.claimedSum)}) != totalClaimed (${fe(claimed)})`);
    if (name === 'V2') {
      const ra = await client.readContract({ address, abi: POOL_ABI, functionName: 'rewardAsset', args: [T] }).catch(() => null);
      row.rewardAsset = ra && ra[1] && ra[0] !== ZERO ? { asset: ra[0], symbol: await client.readContract({ address: ra[0], abi: ERC20, functionName: 'symbol' }).catch(() => '?'), forcedEth: ra[2] } : { asset: null, symbol: 'ETH', forcedEth: ra ? ra[2] : false };
      const stock = paid.filter((e) => e.args.asset !== ZERO);
      row.payouts = { rewardPaid: paid.length, stock: stock.length, stockEth: sum(stock, (e) => e.args.ethAmount).toString(), stockAmountRaw: sum(stock, (e) => e.args.assetAmount).toString(), eth: paid.length - stock.length, fallbacks: fb.length, reasons: fb.reduce((m, e) => { const k = REASONS[Number(e.args.reason)] || String(e.args.reason); m[k] = (m[k] || 0) + 1; return m; }, {}) };
    }
    if (db) {
      const poolLower = address.toLowerCase(); const chainPub = new Set(pubs.map((e) => Number(e.args.epochId)));
      const dbEpochs = db.epochs.filter((e) => e.token_address === tl && (e.pool_address || POOLS.V1).toLowerCase() === poolLower); const dbPub = dbEpochs.filter((e) => e.status === 'published');
      row.db = { statuses: dbEpochs.reduce((m, e) => { m[e.status] = (m[e.status] || 0) + 1; return m; }, {}), publishedInDbNotOnChain: dbPub.filter((e) => !chainPub.has(e.epoch_number)).map((e) => e.epoch_number), onChainNotInDb: [...chainPub].filter((n) => !dbPub.some((e) => e.epoch_number === n)), rootMismatch: dbPub.filter((e) => { const o = pubs.find((x) => Number(x.args.epochId) === e.epoch_number); return o && o.args.merkleRoot.toLowerCase() !== String(e.merkle_root).toLowerCase(); }).map((e) => e.epoch_number), lastRow: dbEpochs.at(-1) ? { epoch: dbEpochs.at(-1).epoch_number, status: dbEpochs.at(-1).status, at: dbEpochs.at(-1).created_at } : null };
      const claimedKey = new Set(claims.map((e) => `${Number(e.args.epochId)}|${e.args.claimant.toLowerCase()}`)); const epochById = new Map(dbEpochs.map((e) => [e.epoch_id, e]));
      const leaves = db.rewards.filter((x) => x.token_address === tl && epochById.has(x.epoch_id) && chainPub.has(epochById.get(x.epoch_id).epoch_number)).map((x) => ({ ...x, epoch: epochById.get(x.epoch_id).epoch_number }));
      const unclaimed = leaves.filter((x) => !claimedKey.has(`${x.epoch}|${x.wallet_address}`) && Number(x.final_reward_eth) > 0); const owedBy = {}; for (const x of unclaimed) owedBy[x.wallet_address] = (owedBy[x.wallet_address] || 0) + Number(x.final_reward_eth);
      row.owed = { holders: Object.keys(owedBy).length, dbSumEth: unclaimed.reduce((a, x) => a + Number(x.final_reward_eth), 0), largestLeafEth: unclaimed.reduce((m, x) => Math.max(m, Number(x.final_reward_eth)), 0), largestHolder: Object.entries(owedBy).sort((a, b) => b[1] - a[1])[0] || null };
      row.claimFlags = { dbClaimedChainNot: leaves.filter((x) => x.claimed && !claimedKey.has(`${x.epoch}|${x.wallet_address}`)).length, chainClaimedDbNot: leaves.filter((x) => !x.claimed && claimedKey.has(`${x.epoch}|${x.wallet_address}`)).length, chainClaimsWithoutDbRow: claims.filter((e) => !leaves.some((x) => x.epoch === Number(e.args.epochId) && x.wallet_address === e.args.claimant.toLowerCase())).length };
      for (const [k, v] of Object.entries(row.claimFlags)) if (v) result.flags.push(`${symbol}/${name}: ${k} = ${v}`);
      if (row.db.publishedInDbNotOnChain.length || row.db.onChainNotInDb.length || row.db.rootMismatch.length) result.flags.push(`${symbol}/${name}: DB/chain epoch mismatch ${JSON.stringify({ dbOnly: row.db.publishedInDbNotOnChain, chainOnly: row.db.onChainNotInDb, rootMismatch: row.db.rootMismatch })}`);
      const tokRow = db.tokens.find((x) => x.mint_address.toLowerCase() === tl); row.site = { inTokens: Boolean(tokRow), hidden: tokRow ? Boolean(tokRow.hidden) : null, indexed: db.indexed.some((x) => x.mint_address.toLowerCase() === tl) };
      // underwater now: chain balances at block B, DB cost basis, current price from the worker's own benchmark
      const holders = db.hcb.filter((h) => h.token_address === tl);
      if (holders.length && worker) {
        let price = 0, source = 'n/a'; try { const p = await worker.getTokenBenchmarkPriceEth(T); price = p.priceEth; source = p.source; } catch (e) { source = 'error: ' + String(e.message).split('\n')[0]; }
        const bals = []; for (let i = 0; i < holders.length; i += 150) { const part = holders.slice(i, i + 150); const r = await client.multicall({ multicallAddress: MULTICALL3, blockNumber: B, allowFailure: true, contracts: part.map((h) => ({ address: T, abi: ERC20, functionName: 'balanceOf', args: [getAddress(h.wallet_address)] })) }); bals.push(...r.map((x) => (x.status === 'success' ? Number(x.result) / 1e18 : null))); }
        const last3 = pubs.slice(-3).map((e) => Number(e.args.epochId)); const last3Ids = dbEpochs.filter((e) => last3.includes(e.epoch_number)).map((e) => e.epoch_id);
        const inLast3 = {}; for (const x of db.rewards) if (x.token_address === tl && last3Ids.includes(x.epoch_id)) inLast3[x.wallet_address] = (inLast3[x.wallet_address] || 0) + 1;
        const under = holders.map((h, i) => { const chain = bals[i]; const bal = chain === null ? Number(h.token_balance) : Math.min(Number(h.token_balance), chain); const invested = Number(h.token_balance) > 0 ? Number(h.total_invested_eth) * (bal / Number(h.token_balance)) : 0; const loss = Math.max(0, invested - bal * price); return { wallet: h.wallet_address, chainBalance: chain, dbBalance: Number(h.token_balance), avgCost: Number(h.avg_cost_basis_eth), lossEth: loss, rewardEth: 0.1 * loss, eligible: h.is_eligible && !h.is_underwater_seller, inLast3: inLast3[h.wallet_address] || 0 }; }).filter((h) => price > 0 && h.avgCost > price && h.lossEth > 0 && h.eligible).sort((a, b) => b.lossEth - a.lossEth);
        row.underwater = { price, priceSource: source, holdersInDb: holders.length, dbBalanceStale: holders.filter((h, i) => bals[i] !== null && Math.abs(bals[i] - Number(h.token_balance)) > Math.max(1, Number(h.token_balance) * 1e-6)).length, count: under.length, demandEth: under.reduce((a, h) => a + h.rewardEth, 0), last3, notInLast3: under.filter((h) => h.inLast3 === 0 && h.rewardEth >= 1e-5).map((h) => h.wallet), top: under.slice(0, 10) };
        if (row.underwater.notInLast3.length) result.flags.push(`${symbol}/${name}: ${row.underwater.notInLast3.length} underwater holder(s) with a reward >= 1e-5 ETH got NO allocation in the last 3 epochs (${last3.join(',')})`);
        if (under.length && row.lastEpoch && Date.now() - Date.parse(row.lastEpoch.time) > 3 * 3600e3) result.flags.push(`${symbol}/${name}: ${under.length} holder(s) underwater (demand ${row.underwater.demandEth.toFixed(6)} ETH, unallocated ${fe(unalloc)}) but the last epoch was ${row.lastEpoch.time}`);
      }
    }
    result.tokens.push(row);
  }
}
if (worker) await worker.closeV4Module().catch(() => {});

// ---- 5. reconciliation + operator
for (const [name, p] of Object.entries(result.pools)) {
  const T0 = p.totals; const owed = T0.allocated - T0.claimed; const gap = BigInt(p.ethBalance) - (T0.unallocated + owed);
  p.reconciliation = { unallocatedPlusOwed: (T0.unallocated + owed).toString(), gapWei: gap.toString() }; if (gap !== 0n) result.flags.push(`${name}: pool ETH balance differs from unallocated + owed by ${gap} wei`);
  for (const k of Object.keys(T0)) T0[k] = T0[k].toString();
  const ops = scans[name].events.filter((e) => e.name === 'OperatorUpdated'); p.operatorHistory = []; for (const e of ops) p.operatorHistory.push({ from: e.args.previousOperator, to: e.args.newOperator, time: await ts(e.block) });
}
const allPubs = Object.entries(scans).flatMap(([n, s]) => s.events.filter((e) => e.name === 'EpochRootPublished').map((e) => ({ ...e, pool: n }))).sort((a, b) => (a.block < b.block ? -1 : 1));
const last = allPubs.at(-1);
const opAddr = result.pools.V2.operator; const opBal = await client.getBalance({ address: opAddr, blockNumber: B }); const gasPrice = await client.getGasPrice();
result.operator = { address: opAddr, balance: opBal.toString(), nonce: await client.getTransactionCount({ address: opAddr, blockNumber: B }), gasPrice: gasPrice.toString(), publishCostEstimate: (80_000n * gasPrice).toString(), canPublish: opBal >= 80_000n * gasPrice };
if (last) { const rc = await client.getTransactionReceipt({ hash: last.tx }); const tx = await client.getTransaction({ hash: last.tx }); result.lastPublishAnywhere = { pool: last.pool, token: last.args.token, epoch: Number(last.args.epochId), time: await ts(last.block), tx: last.tx, from: tx.from, cost: (rc.gasUsed * rc.effectiveGasPrice).toString() }; }
if (!result.operator.canPublish) result.flags.push(`operator ${opAddr} holds ${fe(opBal)} ETH, below one publish (~${fe(80_000n * gasPrice)} ETH at the current gas price): publishing has stopped${last ? `; last epoch anywhere ${result.lastPublishAnywhere.time}` : ''}`);

// ---- 6. print
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nLOSS-REWARD POOL AUDIT — chain state at block ${result.block} (${result.blockTime}); events scanned V1 from ${result.pools.V1.deployedAt}, V2 from ${result.pools.V2.deployedAt}${Object.values(result.pools).some((p) => p.failedChunks.length) ? ' — WARNING: some log chunks failed, event sums may be incomplete' : ''}`);
console.log(`\n${pad('pool', 5)}${pad('token', 12)}${pad('deposited', 22)}${pad('allocated', 22)}${pad('claimed', 22)}${pad('still owed', 22)}unallocated`);
for (const t of [...result.tokens].sort((a, b) => (a.pool + a.symbol).localeCompare(b.pool + b.symbol))) console.log(`${pad(t.pool, 5)}${pad(t.symbol, 12)}${pad(fe(t.state.deposited), 22)}${pad(fe(t.state.allocated), 22)}${pad(fe(t.state.claimed), 22)}${pad(fe(t.state.stillOwed), 22)}${fe(t.state.unallocated)}`);
for (const [name, p] of Object.entries(result.pools)) console.log(`${pad(name, 5)}${pad('TOTAL', 12)}${pad(fe(p.totals.deposited), 22)}${pad(fe(p.totals.allocated), 22)}${pad(fe(p.totals.claimed), 22)}${pad(fe(BigInt(p.totals.allocated) - BigInt(p.totals.claimed)), 22)}${fe(p.totals.unallocated)}   | pool ETH ${fe(p.ethBalance)} = unallocated + owed ${fe(p.reconciliation.unallocatedPlusOwed)} (gap ${p.reconciliation.gapWei} wei)`);
console.log('\nPER TOKEN');
for (const t of result.tokens) {
  console.log(`\n${t.pool} ${t.symbol} ${t.token}${t.rewardAsset ? ` — pays ${t.rewardAsset.symbol}${t.rewardAsset.forcedEth ? ' (forced ETH)' : ''}` : ''}${t.site ? ` — site: ${t.site.inTokens ? (t.site.hidden ? 'hidden' : 'listed') : 'no row'}, ${t.site.indexed ? 'indexed' : 'not indexed'}` : ''}`);
  console.log(`  deposits ${t.events.deposits} (${fe(t.events.depositedSum)} ETH, last ${t.lastDeposit || '-'}) | epochs ${t.events.published}${t.firstEpoch ? ` #${t.firstEpoch.epoch} ${t.firstEpoch.time} -> #${t.lastEpoch.epoch} ${t.lastEpoch.time}` : ''} | claims ${t.events.claims} by ${t.events.claimants} holder(s), ${fe(t.events.claimedSum)} ETH${t.lastClaim ? `, last ${t.lastClaim}` : ''}`);
  if (t.payouts) console.log(`  payouts: ${t.payouts.stock} in stock (${fe(t.payouts.stockEth)} ETH -> ${Number(t.payouts.stockAmountRaw) / 1e18} raw), ${t.payouts.eth} in ETH, fallbacks ${t.payouts.fallbacks} ${JSON.stringify(t.payouts.reasons)}`);
  if (t.owed) console.log(`  still owed ${fe(t.state.stillOwed)} ETH to ${t.owed.holders} holder(s); largest leaf ${t.owed.largestLeafEth.toFixed(9)}, largest holder ${t.owed.largestHolder ? `${t.owed.largestHolder[0]} ${t.owed.largestHolder[1].toFixed(9)}` : '-'}`);
  if (t.db) console.log(`  DB rows ${JSON.stringify(t.db.statuses)}; last row ${t.db.lastRow ? `#${t.db.lastRow.epoch} ${t.db.lastRow.status} ${t.db.lastRow.at}` : '-'}`);
  if (t.underwater) { const u = t.underwater; console.log(`  underwater now: ${u.count} eligible holder(s), demand ${u.demandEth.toFixed(8)} ETH vs unallocated ${fe(t.state.unallocated)} (price ${u.price} from ${u.priceSource}; ${u.dbBalanceStale} DB balance(s) differ from chain)`); for (const h of u.top) console.log(`     ${h.wallet} bal ${Number(h.chainBalance ?? h.dbBalance).toFixed(0)} loss ${h.lossEth.toFixed(8)} reward ${h.rewardEth.toFixed(8)} in last 3 epochs: ${h.inLast3}/3`); }
}
console.log(`\nOPERATOR ${result.operator.address}: ${fe(result.operator.balance)} ETH, nonce ${result.operator.nonce}, one publish ≈ ${fe(result.operator.publishCostEstimate)} ETH -> ${result.operator.canPublish ? 'can publish' : 'CANNOT PUBLISH'}`);
if (result.lastPublishAnywhere) console.log(`last epoch published anywhere: ${result.lastPublishAnywhere.pool} ${result.lastPublishAnywhere.token} #${result.lastPublishAnywhere.epoch} at ${result.lastPublishAnywhere.time} by ${result.lastPublishAnywhere.from}`);
console.log(`\nFLAGS (${result.flags.length})`); for (const f of result.flags) console.log(' - ' + f);
if (opt('json')) { fs.writeFileSync(opt('json'), JSON.stringify(result, null, 1)); console.log(`\nfull result written to ${opt('json')}`); }
process.exit(0);
