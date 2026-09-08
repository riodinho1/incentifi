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

  const state = {
    endpoints,
    current: 0,
    cooldownUntil: endpoints.map(() => 0),
    consecutiveFailures: endpoints.map(() => 0),
    switches: 0,
    requests: 0,
    failures: 0,
    announced: false,
    get activeUrl() { return endpoints[state.current]; },
  };
  let idCounter = 0;

  function pickEndpoint() {
    const t = now();
    if (state.cooldownUntil[state.current] <= t) return state.current;
    // first non-cooling endpoint after the current one
    for (let k = 1; k <= endpoints.length; k++) {
      const i = (state.current + k) % endpoints.length;
      if (state.cooldownUntil[i] <= t) return i;
    }
    return -1; // everybody is cooling
  }
  function fail(i, reason) {
    state.failures++;
    state.consecutiveFailures[i]++;
    const cool = Math.min(cooldownMaxMs, cooldownBaseMs * 2 ** (state.consecutiveFailures[i] - 1));
    state.cooldownUntil[i] = now() + cool;
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
    if (!res.ok && (res.status === 429 || res.status >= 500)) return { retry: retryableReason({ httpStatus: res.status }), body };
    let json;
    try { json = JSON.parse(text); } catch { return { retry: retryableReason({ parseError: `non-JSON body: ${text.slice(0, 60).replace(/\s+/g, ' ')}` }), body }; }
    if (!json || typeof json !== 'object' || Array.isArray(json) || (!('result' in json) && !('error' in json))) {
      return { retry: retryableReason({ parseError: `not a JSON-RPC envelope: ${text.slice(0, 60).replace(/\s+/g, ' ')}` }), body };
    }
    if (json.error) {
      const retry = retryableReason({ jsonError: json.error });
      if (retry) return { retry, body, error: json.error };
      return { final: json.error, body };
    }
    return { result: json.result, body };
  }

  async function request({ method, params }) {
    state.requests++;
    let lastReason = 'no endpoint';
    let sentRawTo = null; // eth_sendRawTransaction: an endpoint that may have broadcast before failing
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let i = pickEndpoint();
      if (i === -1) {
        // every endpoint is cooling: wait for the soonest one
        const soonest = state.cooldownUntil.reduce((a, c, idx) => (c < state.cooldownUntil[a] ? idx : a), 0);
        const wait = Math.max(0, Math.min(allBusyWaitMs, state.cooldownUntil[soonest] - now()));
        log(`[RPC] ${name}: all ${endpoints.length} endpoint(s) cooling down; waiting ${Math.round(wait)}ms for ${endpoints[soonest]}`);
        await sleep(wait);
        state.cooldownUntil[soonest] = now();
        i = soonest;
      }
      if (i !== state.current) { log(`[RPC] ${name}: using ${endpoints[i]}`); state.current = i; }
      if (!state.announced) { state.announced = true; log(`[RPC] ${name}: using ${endpoints[i]} (${endpoints.length} endpoint(s) configured)`); }
      const url = endpoints[i];
      const out = await call(url, method, params);
      if ('result' in out) {
        state.consecutiveFailures[i] = 0;
        return out.result;
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
      const cool = fail(i, out.retry);
      const next = pickEndpoint();
      switchTo(i, next === -1 ? i : next, out.retry, cool);
      if (next === i || next === -1) await sleep(Math.min(cool, allBusyWaitMs));
    }
    const err = new Error(`[RPC] ${name}: ${method} failed on every endpoint after ${maxAttempts} attempts (last: ${lastReason})`);
    err.code = -32603;
    throw err;
  }

  const provider = { request };
  return { provider, state, transport: custom(provider, { retryCount: 0, name: `failover(${endpoints.length})`, key: 'failover' }) };
}
