/**
 * Restore deleted `tokens` rows as hidden = true (docs/AUDIT_2026-09-08.md finding 5) from on-chain
 * discovery data, so the loss-reward worker sees the tokens again. NEVER DELETE A tokens ROW — set
 * hidden = true instead (supabase/tokens_hidden_and_indexed_tokens.sql).
 *
 * For each address: name/symbol from the ERC-20; creator + hook + launch block from the factory that
 * launched it (legible factory, then the GenericSell factory: TokenLaunched logs via Blockscout);
 * Blockscout's contract creator as the last resort for the creator. Prints the rows (and the SQL);
 * with --apply upserts them through the service key, never overwriting an existing visible row's
 * fields (only sets hidden = true on an existing row when --hide-existing is given).
 *
 *   node scripts/ops/restore-hidden-tokens.mjs 0xabc... 0xdef...            # dry run (prints rows + SQL)
 *   node scripts/ops/restore-hidden-tokens.mjs --apply 0xabc... 0xdef...    # upsert as hidden = true
 * Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local when present), VITE_EVM_RPC_URL.
 */
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const HIDE_EXISTING = args.includes('--hide-existing');
const addresses = args.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => getAddress(a));
if (!addresses.length) { console.error('usage: node scripts/ops/restore-hidden-tokens.mjs [--apply] [--hide-existing] <token address>...'); process.exit(2); }

function loadEnvLocal() {
  if (!fs.existsSync('.env.local')) return;
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
}
loadEnvLocal();
const RPC = process.env.VITE_EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const client = createPublicClient({ transport: http(RPC, { timeout: 60_000 }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0', Accept: 'application/json' };
const FACTORIES = [
  { venue: 'legible', factory: '0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda', hook: '0x921d0be20a21e5a687734b4df6302ea55bd168c0' },
  { venue: 'v4-generic', factory: '0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0', hook: '0xc5ef9cb8c95cd8540e71b6d4c00a90257625a888' },
];
const ERC20 = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']);
const FACT = parseAbi(['function isLaunched(address) view returns (bool)']);
const V3F = parseAbi(['function getBondingCurve(address) view returns (address)']);
const CURVE = parseAbi(['function creator() view returns (address)']);

async function blockscoutLaunch(factory, token) {
  // TokenLaunched(address indexed token, address indexed creator, bytes32 poolId): topic1 = token
  let next = null; let pages = 0;
  do {
    const qs = next ? '?' + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)])).toString() : '';
    const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${factory}/logs${qs}`, { headers: UA }).catch(() => null);
    if (!res || !res.ok) return null;
    const j = await res.json();
    for (const it of j.items || []) {
      if ((it.decoded?.method_call || '').startsWith('TokenLaunched(') && it.topics?.[1] && getAddress('0x' + it.topics[1].slice(26)) === token) {
        return { creator: getAddress('0x' + it.topics[2].slice(26)), poolId: it.data?.slice(0, 66), block: Number(it.block_number) };
      }
    }
    next = j.next_page_params || null; pages++; await sleep(300);
  } while (next && pages < 10);
  return null;
}

const rows = [];
for (const token of addresses) {
  const [name, symbol] = await Promise.all([
    client.readContract({ address: token, abi: ERC20, functionName: 'name' }).catch(() => null),
    client.readContract({ address: token, abi: ERC20, functionName: 'symbol' }).catch(() => null),
  ]);
  let venue = null, hook = null, creator = null, block = null, poolId = null;
  for (const f of FACTORIES) {
    const launched = await client.readContract({ address: f.factory, abi: FACT, functionName: 'isLaunched', args: [token] }).catch(() => false);
    if (launched) { venue = f.venue; hook = f.hook; const l = await blockscoutLaunch(f.factory, token); if (l) { creator = l.creator; block = l.block; poolId = l.poolId; } break; }
  }
  if (!venue) {
    const curve = await client.readContract({ address: '0xa0143de84fba1753b887e4e32941e4fb342e473f', abi: V3F, functionName: 'getBondingCurve', args: [token] }).catch(() => null);
    if (curve && curve !== '0x0000000000000000000000000000000000000000') { venue = 'v3'; creator = await client.readContract({ address: curve, abi: CURVE, functionName: 'creator' }).catch(() => null); }
  }
  if (!creator) {
    const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${token}`, { headers: UA }).catch(() => null);
    const j = res && res.ok ? await res.json().catch(() => null) : null;
    if (j?.creator_address_hash) creator = getAddress(j.creator_address_hash);
  }
  rows.push({ name, symbol, mint_address: token, creator_address: creator, hook_address: hook, hidden: true, venue: venue || 'unknown', first_block: block, pool_id: poolId });
  await sleep(500);
}

console.log(JSON.stringify(rows, null, 2));
const sql = rows.map((r) => `insert into public.tokens (name, symbol, mint_address, creator_address, hook_address, hidden) select ${[r.name, r.symbol, r.mint_address, r.creator_address, r.hook_address].map((v) => (v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`)).join(', ')}, true where not exists (select 1 from public.tokens where lower(mint_address) = lower('${r.mint_address}'));`).join('\n');
console.log('\n-- SQL equivalent:\n' + sql);

if (!APPLY) { console.log('\n(dry run; add --apply to upsert through the service key)'); process.exit(0); }
const { createClient } = await import('@supabase/supabase-js');
const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required for --apply'); process.exit(2); }
const supabase = createClient(url, key);
for (const r of rows) {
  const { data: existing } = await supabase.from('tokens').select('id, hidden').ilike('mint_address', r.mint_address).maybeSingle();
  if (existing) {
    if (HIDE_EXISTING && !existing.hidden) { const { error } = await supabase.from('tokens').update({ hidden: true }).eq('id', existing.id); console.log(error ? `hide FAILED ${r.mint_address}: ${error.message}` : `hidden existing row ${r.mint_address}`); }
    else console.log(`exists, left alone: ${r.mint_address}`);
    continue;
  }
  const { venue, first_block, pool_id, ...row } = r;
  const { error } = await supabase.from('tokens').insert(row);
  console.log(error ? `insert FAILED ${r.mint_address}: ${error.message}` : `restored hidden ${r.symbol} ${r.mint_address}`);
}
