/**
 * RPC failover for Robinhood Chain (4663).
 *
 * The public endpoint (rpc.mainnet.chain.robinhood.com) rate-limits, returns non-JSON bodies under
 * load (viem 2.55 then dies with "Cannot read properties of undefined (reading 'error')" because it
 * destructures a JSON-RPC envelope that is not there) and dropped TLS connections on 2026-09-08.
 * This module is an EIP-1193-style provider that owns the HTTP layer itself, so every failure class
 * is classified BEFORE viem sees it:
 *
 *   retryable -> rotate to the next endpoint (with per-endpoint exponential cooldown) and retry:
 *     non-JSON / malformed JSON-RPC body, HTTP 429 / 5xx, timeout, connection or TLS error,
 *     JSON-RPC rate-limit codes, "method not available" (an endpoint that lacks the method)
 *   final     -> thrown as viem's RpcRequestError so revert data still decodes:
 *     execution reverts and every other JSON-RPC error the node produced on purpose
 *
 * eth_sendRawTransaction is safe to retry: the payload is already signed, so a re-send to another
 * endpoint either lands the same hash or is refused as "already known" — which is treated as success
 * (the hash is keccak256 of the raw transaction). Nothing else is special-cased.
 *
 * Use: `const rpc = createFailoverRpc(parseRpcUrls(process.env)); createPublicClient({ transport: rpc.transport })`.
 * The active endpoint is logged on first use and on every switch ("[RPC] ...").
 *
 * Pacing (2026-09-09): `paceMs` serialises a method (concurrency 1) and enforces a minimum interval
 * between its calls (`eth_getLogs` 300 ms by default via failoverOptionsFromEnv); a 429/503 honours
 * Retry-After; per-endpoint backoff doubles for failures inside `backoffResetMs` and is capped at
 * `cooldownMaxMs`. Non-archive endpoints (`nonArchive` patterns, or learned at runtime from
 * "historical state is not available"-style errors) are skipped for historical requests — getLogs
 * ranges or state reads older than `historyDepthBlocks` behind the last seen head — and kept for
 * head reads.
 *
 * The copy under supabase/functions/loss-reward-gateway/ differs only in the viem import specifier
 * (Deno needs `npm:viem@2.55.2`); test/rpc-failover.test.mjs asserts the two stay identical otherwise.
 */
import { custom, RpcRequestError, keccak256 } from 'npm:viem@2.55.2';

export const DEFAULT_RPC_URLS = ['https://rpc.mainnet.chain.robinhood.com'];
export const RETRYABLE_RPC_CODES = new Set([
  -32005, // limit exceeded (Infura/Alchemy style)
  -32029, // public rate limit (routeme)
  -32016, // rate limit (some nodes)
  -32601, // method not found: this endpoint lacks the method (dRPC's Robinhood endpoint) -> try another
  -32603, // internal error
  -32000, // generic server error WITHOUT revert data (with data it is an execution error, kept)
  -32002, // resource unavailable
  -32004, // method not supported
]);
const ALREADY_KNOWN = /already known|known transaction|ALREADY_EXISTS|already exists|nonce too low|replacement transaction underpriced|transaction already imported/i;

/** `RPC_URLS` (comma-separated) wins; otherwise the single legacy variable; otherwise the public endpoint. */
export function parseRpcUrls(env = process.env) {
  const list = String(env.RPC_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return [...new Set(list)];
  const single = String(env.VITE_EVM_RPC_URL || env.EVM_RPC_URL || env.RPC_URL || '').trim();
  return single ? [single] : [...DEFAULT_RPC_URLS];
}

export const DEFAULT_NON_ARCHIVE_HOSTS = ['robinhood.api.pocket.network', 'publicnode.com'];
const NON_ARCHIVE_MESSAGE = /historical state is not available|archive requests require|missing trie node|state (is )?not available|pruned|block not found|header not found|not available for block/i;
const HISTORICAL_STATE_METHODS = new Set(['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount']);

/** Failover options from the environment (both services read the same variables). */
export function failoverOptionsFromEnv(env = (typeof process !== 'undefined' ? process.env : {})) {
  const list = (v, d) => (v === undefined || v === null ? d : String(v).split(',').map((x) => x.trim()).filter(Boolean));
  return {
    paceMs: { eth_getLogs: Number(env.RPC_GETLOGS_MIN_INTERVAL_MS ?? 300) },
    nonArchive: list(env.RPC_NON_ARCHIVE_URLS, DEFAULT_NON_ARCHIVE_HOSTS),
    historyDepthBlocks: Number(env.RPC_HISTORY_DEPTH_BLOCKS ?? 256),
    cooldownMaxMs: Number(env.RPC_COOLDOWN_MAX_MS ?? 120_000),
    timeoutMs: Number(env.RPC_TIMEOUT_MS ?? 20_000),
  };
}

/** Parses an HTTP Retry-After header (seconds or HTTP-date) into milliseconds, or null. */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

const hexToBig = (h) => (typeof h === 'string' && /^0x[0-9a-fA-F]+$/.test(h) ? BigInt(h) : null);
/**
 * Does this request need state or logs older than `depth` blocks behind `head`? With no head known
 * yet, any explicit block number counts as historical (conservative: prefer an archive endpoint).
 */
export function isHistoricalRequest(method, params, head, depth) {
  const old = (bn) => (bn === null ? false : head === null ? true : bn < head - BigInt(depth));
  if (method === 'eth_getLogs') {
    const f = params && params[0];
    if (!f || typeof f !== 'object') return false;
    const to = hexToBig(f.toBlock);
    const from = hexToBig(f.fromBlock);
    if (to !== null) return old(to);
    return from !== null && old(from); // fromBlock..latest still needs history from fromBlock
  }
  if (HISTORICAL_STATE_METHODS.has(method)) {
    const tag = params && params[params.length - 1];
    return old(hexToBig(typeof tag === 'string' ? tag : tag && tag.blockNumber));
  }
  return false;
}

/** Classifies a failure. Returns a short reason string when the request should rotate, else null. */
export function retryableReason({ httpStatus, jsonError, parseError, networkError, timedOut } = {}) {
  if (timedOut) return 'timeout';
  if (networkError) return `network: ${networkError}`;
  if (httpStatus === 429) return 'HTTP 429 rate limited';
  if (httpStatus !== undefined && httpStatus >= 500) return `HTTP ${httpStatus}`;
  if (parseError) return `malformed response: ${parseError}`;
  if (jsonError) {
    const code = Number(jsonError.code);
    const msg = String(jsonError.message || '');
    // a node that has already seen this signed transaction answered on purpose: final (the caller
    // decides what "already known" means; request() turns it into success after a re-send)
    if (ALREADY_KNOWN.test(msg)) return null;
    if (NON_ARCHIVE_MESSAGE.test(msg)) return `non-archive: ${msg.slice(0, 80)}`;
    if (/rate limit|too many requests|capacity|overloaded|try again/i.test(msg)) return `rpc rate limit: ${msg.slice(0, 80)}`;
    // an endpoint that cannot serve this request class (publicnode: "Archive requests require a personal
    // token"; pocket: relay errors; nodes that do not support the method) -> another endpoint can
    if (/archive requests|personal token|not supported|unsupported|does not exist\/is not available|relay: error|internal error/i.test(msg)) return `endpoint cannot serve request: ${msg.slice(0, 80)}`;
    if (RETRYABLE_RPC_CODES.has(code) && !(code === -32000 && jsonError.data && jsonError.data !== '0x')) return `rpc error ${code}: ${msg.slice(0, 80)}`;
  }
  return null;
}

/**
 * @param {string[]} urls
 * @param {object} [opts]
 * @param {number}  [opts.timeoutMs=20000]       per-request timeout
 * @param {number}  [opts.maxAttempts]           total tries per request (default 2 x endpoints, min 3)
 * @param {number}  [opts.cooldownBaseMs=2000]   first cooldown after a failure (doubles per consecutive failure)
 * @param {number}  [opts.cooldownMaxMs=60000]
 * @param {number}  [opts.allBusyWaitMs=1500]    wait when every endpoint is cooling, before retrying the least-cooled
 * @param {function}[opts.log]                   (message) => void, default console.log
 * @param {function}[opts.fetchImpl]             fetch replacement (tests)
 * @param {function}[opts.now]                   clock (tests)
 * @param {function}[opts.sleep]                 sleep (tests)
 * @param {string}  [opts.name='rpc']            label in log lines
 */
export function createFailoverRpc(urls, opts = {}) {
  const endpoints = [...new Set((urls || []).filter(Boolean))];
  if (!endpoints.length) throw new Error('createFailoverRpc: at least one RPC URL is required');
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxAttempts = opts.maxAttempts ?? Math.max(3, endpoints.length * 2);
  const cooldownBaseMs = opts.cooldownBaseMs ?? 2_000;
  const cooldownMaxMs = opts.cooldownMaxMs ?? 60_000;
  const allBusyWaitMs = opts.allBusyWaitMs ?? 1_500;
  const log = opts.log ?? ((m) => console.log(m));
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const name = opts.name ?? 'rpc';
  const paceMs = opts.paceMs ?? {};
  const backoffResetMs = opts.backoffResetMs ?? 60_000;
  const historyDepthBlocks = opts.historyDepthBlocks ?? 256;
  const nonArchivePatterns = (opts.nonArchive ?? []).map((x) => (x instanceof RegExp ? x : String(x).toLowerCase()));
  const matchesNonArchive = (url) => nonArchivePatterns.some((x) => (x instanceof RegExp ? x.test(url) : url.toLowerCase().includes(x)));

  const state = {
    endpoints,
    current: 0,
    cooldownUntil: endpoints.map(() => 0),
    consecutiveFailures: endpoints.map(() => 0),
    switches: 0,
    requests: 0,
    failures: 0,
    announced: false,
    lastFailureAt: endpoints.map(() => 0),
    nonArchive: endpoints.map((u) => matchesNonArchive(u)),
    head: null, // latest block number seen from eth_blockNumber / eth_getBlockByNumber('latest')
    historicalSkips: 0,
    paced: 0,
    get activeUrl() { return endpoints[state.current]; },
  };
  let idCounter = 0;
  const lanes = new Map(); // method -> { last, queue } for paced methods (concurrency 1 + min interval)
  async function paced(method, fn) {
    const interval = Number(paceMs[method] || 0);
    if (!(interval > 0)) return fn();
    if (!lanes.has(method)) lanes.set(method, { last: 0, queue: Promise.resolve() });
    const lane = lanes.get(method);
    const run = lane.queue.then(async () => {
      const wait = lane.last + interval - now();
      if (wait > 0) { state.paced++; await sleep(wait); }
      lane.last = now();
      try { return await fn(); } finally { lane.last = now(); }
    });
    lane.queue = run.catch(() => {});
    return run;
  }

  const eligible = (i, historical) => !(historical && state.nonArchive[i]);
  function pickEndpoint(historical = false) {
    const t = now();
    if (state.cooldownUntil[state.current] <= t && eligible(state.current, historical)) return state.current;
    // first non-cooling eligible endpoint after the current one
    for (let k = 1; k <= endpoints.length; k++) {
      const i = (state.current + k) % endpoints.length;
      if (state.cooldownUntil[i] <= t && eligible(i, historical)) return i;
    }
    return -1; // everybody eligible is cooling
  }
  function fail(i, reason, retryAfterMs = null) {
    const t = now();
    state.failures++;
    // Exponential per endpoint: doubles for failures that follow each other within backoffResetMs;
    // a success does NOT reset it (an endpoint alternating 200/429 would otherwise sit at 2s forever).
    if (t - state.lastFailureAt[i] > backoffResetMs) state.consecutiveFailures[i] = 0;
    state.consecutiveFailures[i]++;
    state.lastFailureAt[i] = t;
    let cool = Math.min(cooldownMaxMs, cooldownBaseMs * 2 ** (state.consecutiveFailures[i] - 1));
    if (retryAfterMs !== null && retryAfterMs > cool) cool = Math.min(cooldownMaxMs * 5, retryAfterMs); // honour Retry-After
    state.cooldownUntil[i] = t + cool;
    return cool;
  }
  function switchTo(from, to, reason, cool) {
    if (to !== from) {
      state.switches++;
      log(`[RPC] ${name}: ${endpoints[from]} failed (${reason}) -> switching to ${endpoints[to]} (cooldown ${Math.round(cool / 1000)}s on the failed endpoint)`);
    } else {
      log(`[RPC] ${name}: ${endpoints[from]} failed (${reason}); it is the only endpoint left, retrying after ${Math.round(cool / 1000)}s`);
    }
    state.current = to;
  }

  async function call(url, method, params) {
    const body = { jsonrpc: '2.0', id: ++idCounter, method, params: params ?? [] };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
    } catch (err) {
      const timedOut = err && (err.name === 'AbortError' || /aborted|timeout/i.test(String(err.message)));
      return { retry: retryableReason({ timedOut, networkError: timedOut ? undefined : String(err?.cause?.code || err?.cause?.message || err?.message || err).slice(0, 80) }), body };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok && (res.status === 429 || res.status >= 500)) {
      const retryAfterMs = parseRetryAfterMs(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null, now());
      if (NON_ARCHIVE_MESSAGE.test(text)) return { retry: `non-archive: HTTP ${res.status} ${text.slice(0, 60).replace(/\s+/g, ' ')}`, body, retryAfterMs };
      return { retry: retryableReason({ httpStatus: res.status }), body, retryAfterMs };
    }
    let json;
    try { json = JSON.parse(text); } catch { return { retry: retryableReason({ parseError: `non-JSON body: ${text.slice(0, 60).replace(/\s+/g, ' ')}` }), body }; }
    if (!json || typeof json !== 'object' || Array.isArray(json) || (!('result' in json) && !('error' in json))) {
      return { retry: retryableReason({ parseError: `not a JSON-RPC envelope: ${text.slice(0, 60).replace(/\s+/g, ' ')}` }), body };
    }
    // A response for another request (proxy/cache mix-up) must never be taken as ours.
    if (json.id !== undefined && json.id !== null && String(json.id) !== String(body.id)) {
      return { retry: retryableReason({ parseError: `response id ${JSON.stringify(json.id)} does not match request id ${body.id}` }), body };
    }
    if (json.error) {
      const retry = retryableReason({ jsonError: json.error });
      if (retry) return { retry, body, error: json.error };
      return { final: json.error, body };
    }
    if (method === 'eth_blockNumber') { const h = hexToBig(json.result); if (h !== null) state.head = h; }
    if (method === 'eth_getBlockByNumber' && params && params[0] === 'latest' && json.result && typeof json.result === 'object') { const h = hexToBig(json.result.number); if (h !== null) state.head = h; }
    return { result: json.result, body };
  }

  async function request({ method, params }) {
    return paced(method, () => requestNow({ method, params }));
  }

  async function requestNow({ method, params }) {
    state.requests++;
    let lastReason = 'no endpoint';
    let sentRawTo = null; // eth_sendRawTransaction: an endpoint that may have broadcast before failing
    const historical = isHistoricalRequest(method, params, state.head, historyDepthBlocks);
    if (historical && state.nonArchive.every(Boolean)) {
      const err = new Error(`[RPC] ${name}: ${method} needs historical data (older than ${historyDepthBlocks} blocks behind head ${state.head ?? 'unknown'}) but every configured endpoint is non-archive (${endpoints.join(', ')}); configure an archive endpoint in RPC_URLS`);
      err.code = -32603;
      throw err;
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let i = pickEndpoint(historical);
      if (i === -1) {
        // every eligible endpoint is cooling: wait for the soonest one
        const candidates = state.cooldownUntil.map((c, idx) => idx).filter((idx) => eligible(idx, historical));
        if (!candidates.length) {
          // every endpoint was (just) learned to be non-archive
          const err = new Error(`[RPC] ${name}: ${method} needs historical data but every configured endpoint is non-archive (${endpoints.join(', ')}); configure an archive endpoint in RPC_URLS (last: ${lastReason})`);
          err.code = -32603;
          throw err;
        }
        const soonest = candidates.reduce((a, c) => (state.cooldownUntil[c] < state.cooldownUntil[a] ? c : a), candidates[0]);
        const wait = Math.max(0, Math.min(allBusyWaitMs, state.cooldownUntil[soonest] - now()));
        log(`[RPC] ${name}: all ${endpoints.length} endpoint(s) cooling down; waiting ${Math.round(wait)}ms for ${endpoints[soonest]}`);
        await sleep(wait);
        state.cooldownUntil[soonest] = now();
        i = soonest;
      }
      if (i !== state.current) {
        if (historical && state.nonArchive[state.current]) state.historicalSkips++;
        log(`[RPC] ${name}: using ${endpoints[i]}${historical && state.nonArchive[state.current] ? ` (historical ${method}; ${endpoints[state.current]} is non-archive)` : ''}`);
        state.current = i;
      }
      if (!state.announced) { state.announced = true; log(`[RPC] ${name}: using ${endpoints[i]} (${endpoints.length} endpoint(s) configured)`); }
      const url = endpoints[i];
      const out = await call(url, method, params);
      if ('result' in out) {
        return out.result; // backoff level is left to decay by time (see fail())
      }
      if (out.final) {
        // A node produced this error on purpose (revert, bad params, ...). For a re-sent raw tx,
        // "already known" means the earlier attempt did broadcast: report its hash.
        if (method === 'eth_sendRawTransaction' && sentRawTo !== null && ALREADY_KNOWN.test(String(out.final.message || ''))) {
          log(`[RPC] ${name}: ${url} says the transaction is already known (first sent via ${endpoints[sentRawTo]}); treating as success`);
          return keccak256(params[0]);
        }
        throw new RpcRequestError({ body: out.body, error: out.final, url });
      }
      lastReason = out.retry;
      // Any retryable failure of a raw send (timeout, garbage body, 5xx, ...) may have happened AFTER the
      // node accepted the transaction, so remember the endpoint: a later "already known" is then success.
      if (method === 'eth_sendRawTransaction' && sentRawTo === null) sentRawTo = i;
      if (String(out.retry).startsWith('non-archive') && !state.nonArchive[i]) {
        state.nonArchive[i] = true;
        log(`[RPC] ${name}: ${url} cannot serve historical data (${out.retry}); marking it non-archive - it stays in rotation for head reads only`);
      }
      const cool = fail(i, out.retry, out.retryAfterMs ?? null);
      const next = pickEndpoint(historical);
      switchTo(i, next === -1 ? i : next, out.retry + (out.retryAfterMs ? `, Retry-After ${Math.round(out.retryAfterMs / 1000)}s` : ''), cool);
      if (next === i || next === -1) await sleep(Math.min(cool, allBusyWaitMs));
    }
    const err = new Error(`[RPC] ${name}: ${method} failed on every endpoint after ${maxAttempts} attempts (last: ${lastReason})`);
    err.code = -32603;
    throw err;
  }

  /**
   * One request on ONE specific endpoint (by index), no rotation, no cooldown bookkeeping: for
   * independent confirmation reads (scripts/lib/reliableBalance.mjs). Throws on any failure.
   */
  async function requestVia(index, { method, params }) {
    const url = endpoints[index];
    if (!url) throw new Error(`[RPC] ${name}: no endpoint at index ${index}`);
    const out = await call(url, method, params);
    if ('result' in out) return out.result;
    if (out.final) throw new RpcRequestError({ body: out.body, error: out.final, url });
    const err = new Error(`[RPC] ${name}: ${method} on ${url} failed (${out.retry})`);
    err.code = -32603;
    throw err;
  }

  const provider = { request };
  return { provider, state, requestVia, transport: custom(provider, { retryCount: 0, name: `failover(${endpoints.length})`, key: 'failover' }) };
}
