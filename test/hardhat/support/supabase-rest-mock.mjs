/**
 * Minimal in-memory PostgREST-compatible mock for @supabase/supabase-js, used to run
 * scripts/loss-reward-worker.mjs's real, unmodified `executeEpochForToken()` end-to-end
 * against a real Hardhat fork (real contracts, real transactions, real balance deltas)
 * WITHOUT touching the real production Supabase project.
 *
 * This does not reimplement PostgREST filtering — it implements exactly the request
 * shapes scripts/loss-reward-worker.mjs is known to issue (via `.eq()`/`.gt()` filters,
 * `.order()/.limit()/.maybeSingle()/.single()`, and plain `.insert()/.update()`), verified
 * by reading @supabase/postgrest-js's own source (node_modules/@supabase/postgrest-js) for
 * exactly how `.single()`/`.maybeSingle()` set the `Accept` header and how the client
 * interprets the response — see the two branches below for `wantsObject`.
 *
 * IMPORTANT: @supabase/postgrest-js captures its `fetch` reference ONCE, at
 * `createClient()` time (module-evaluation time of loss-reward-worker.mjs), not fresh on
 * every request — so `globalThis.fetch` MUST be replaced with this mock's `fetchImpl`
 * BEFORE `scripts/loss-reward-worker.mjs` is ever imported in this process. Since Node's
 * built-in test runner runs each `--test` file in its own child process, this is safe as
 * long as this mock is installed at the top of loss-reward-fork.test.ts before its own
 * dynamic `import('../../scripts/loss-reward-worker.mjs')`.
 */

function coercePrimitive(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(raw)) return Number(raw);
  return raw;
}

function normalize(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function jsonResponse(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Matched by PATH ONLY ("/rest/v1/<table>"), not tied to a specific host. This is
// deliberate, not lazy: scripts/loss-reward-worker.mjs loads .env.local at import time
// and OVERWRITES whatever SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY a caller set beforehand
// with real production credentials if that file defines them — confirmed the hard way
// (see git history / the report this test backs) when an origin-scoped version of this
// mock let one such call silently fall through to the REAL production Supabase project
// and write a real row there. Matching on path alone means every Supabase REST call the
// worker makes is intercepted regardless of which project's URL actually won that race,
// so this mock can never again be bypassed by an unexpected env var.
const REST_PATH_MARKER = '/rest/v1/';

// `upsertKeys` maps table name -> the column(s) PostgREST would treat as the conflict
// target for that table (its primary key), so a POST carrying
// `Prefer: resolution=merge-duplicates` (supabase-js `.upsert()`) MERGES into the existing
// row instead of appending a duplicate — required by scripts/evm-indexer.mjs, whose
// processBuyTrade/processSellTrade upsert holder_cost_basis and token_candles_1m
// repeatedly and then re-read them with `.maybeSingle()`. An explicit `?on_conflict=`
// query param (supabase-js `{ onConflict }`) takes precedence when present. Tables not
// listed here keep the original append behaviour.
export function createSupabaseRestMock(supabaseUrl, passthroughFetch = globalThis.fetch, { upsertKeys = {} } = {}) {
  const restBase = new URL('/rest/v1/', supabaseUrl);
  const tables = new Map();
  const counters = new Map();
  const calls = [];

  function table(name) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  }

  function seed(name, rows) {
    table(name).push(...rows.map((r) => ({ ...r })));
  }

  function nextId(name) {
    const n = (counters.get(name) || 0) + 1;
    counters.set(name, n);
    return n;
  }

  function applyFilters(rows, searchParams) {
    let result = rows;
    for (const [key, raw] of searchParams.entries()) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      const dot = raw.indexOf('.');
      const op = raw.slice(0, dot);
      const val = coercePrimitive(raw.slice(dot + 1));
      result = result.filter((row) => {
        const rv = normalize(row[key]);
        const cv = normalize(val);
        switch (op) {
          case 'eq':
            return rv === cv;
          case 'gt':
            return Number(row[key]) > Number(val);
          case 'gte':
            return Number(row[key]) >= Number(val);
          case 'lt':
            return Number(row[key]) < Number(val);
          case 'lte':
            return Number(row[key]) <= Number(val);
          default:
            throw new Error(`[supabase-rest-mock] unsupported filter operator "${op}" for key "${key}"`);
        }
      });
    }
    return result;
  }

  function applyOrder(rows, searchParams) {
    const orderParam = searchParams.get('order');
    if (!orderParam) return rows;
    const [col, dir] = orderParam.split('.');
    return [...rows].sort((a, b) => {
      if (a[col] === b[col]) return 0;
      const lt = a[col] < b[col];
      if (dir === 'desc') return lt ? 1 : -1;
      return lt ? -1 : 1;
    });
  }

  function applyLimit(rows, searchParams) {
    const limitParam = searchParams.get('limit');
    if (!limitParam) return rows;
    return rows.slice(0, Number(limitParam));
  }

  async function fetchImpl(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url);
    const restIdx = u.pathname.indexOf(REST_PATH_MARKER);
    // Anything that isn't a Supabase REST call (e.g. the worker's own real RPC calls,
    // which also go through global fetch via viem's http() transport) must reach the
    // real network unmodified — only "/rest/v1/*" calls are intercepted, from ANY host
    // (see the module-level comment on REST_PATH_MARKER for why host is not checked).
    if (restIdx === -1) {
      return passthroughFetch(input, init);
    }
    if (u.origin !== restBase.origin) {
      console.warn(
        `[supabase-rest-mock] intercepted a Supabase REST call to an UNEXPECTED host (${u.origin}, expected ${restBase.origin}) — ` +
          'this usually means something (e.g. .env.local\'s own loader inside the imported module) overwrote the configured ' +
          'SUPABASE_URL after this mock was installed. Intercepting it anyway (by design) rather than letting it reach a real project.'
      );
    }
    const tableName = u.pathname.slice(restIdx + REST_PATH_MARKER.length).split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    const hdrs = new Headers(init.headers || {});
    const accept = hdrs.get('accept') || '';
    const prefer = hdrs.get('prefer') || '';
    const wantsObject = accept.includes('vnd.pgrst.object+json');
    const wantsRepresentation = prefer.includes('return=representation');

    calls.push({ method, tableName, url });
    const rows = table(tableName);

    if (method === 'GET') {
      let result = applyFilters(rows, u.searchParams);
      result = applyOrder(result, u.searchParams);
      result = applyLimit(result, u.searchParams);
      if (wantsObject) {
        if (result.length === 1) return jsonResponse(200, result[0]);
        return jsonResponse(406, {
          code: 'PGRST116',
          details: `Results contain ${result.length} rows, application/vnd.pgrst.object+json requires 1 row`,
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        });
      }
      return jsonResponse(200, result);
    }

    if (method === 'POST') {
      const bodyText = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      const parsed = JSON.parse(bodyText);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const onConflictParam = u.searchParams.get('on_conflict');
      const mergeKeys = prefer.includes('resolution=merge-duplicates')
        ? (onConflictParam ? onConflictParam.split(',') : upsertKeys[tableName]) || null
        : null;
      const inserted = items.map((item) => {
        if (mergeKeys) {
          const existing = rows.find((r) => mergeKeys.every((k) => normalize(r[k]) === normalize(item[k])));
          if (existing) {
            Object.assign(existing, item);
            return existing;
          }
        }
        const row = { ...item };
        if (tableName === 'reward_epochs' && row.epoch_id === undefined) row.epoch_id = nextId(tableName);
        if (tableName === 'epoch_holder_rewards' && row.id === undefined) row.id = nextId(tableName);
        rows.push(row);
        return row;
      });
      if (!wantsRepresentation) return new Response(null, { status: 201, statusText: 'Created' });
      if (wantsObject) {
        if (inserted.length === 1) return jsonResponse(201, inserted[0]);
        return jsonResponse(406, {
          code: 'PGRST116',
          details: `Results contain ${inserted.length} rows, application/vnd.pgrst.object+json requires 1 row`,
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        });
      }
      return jsonResponse(201, inserted);
    }

    if (method === 'PATCH') {
      const bodyText = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      const patch = JSON.parse(bodyText);
      const matches = applyFilters(rows, u.searchParams);
      for (const row of matches) Object.assign(row, patch);
      if (!wantsRepresentation) return new Response(null, { status: 204, statusText: 'No Content' });
      return jsonResponse(200, matches);
    }

    throw new Error(`[supabase-rest-mock] unsupported method: ${method}`);
  }

  return { fetchImpl, tables, seed, table, calls };
}
