/**
 * AQUA — Postgres connection pool
 * Blueprint E3/PR-1 · the first step of the storage substrate
 *
 * WHAT THIS IS NOT, YET
 * ---------------------
 * Nothing reads or writes through this module. No store uses it. The engine
 * behaves identically whether or not `DATABASE_URL` is set, and a test asserts
 * that no production module imports it.
 *
 * That is the point of shipping it alone. E3 replaces the substrate under 24
 * stores holding every user's world, and the ordering rule from the blueprint
 * is that two risky things never move at once. This PR moves zero: it adds a
 * connection primitive, proves it is inert, and stops.
 *
 * INERT MEANS INERT
 * -----------------
 *   · no connection is attempted at import — a `pg.Pool` is constructed
 *     lazily, on the first `getPool()`, and never during module load
 *   · with no `DATABASE_URL`, `isConfigured()` is false and `dbHealth()`
 *     reports `not-configured` rather than erroring
 *   · a malformed URL fails at CONFIG time with a readable message, not at
 *     the first query in production
 *
 * If this module ever throws during import, every route in the engine dies at
 * boot. Laziness here is a safety property, not a performance one.
 *
 * CREDENTIALS NEVER REACH A LOG
 * -----------------------------
 * `describe()` returns host, port and database and NEVER the password or the
 * raw URL. The boot line uses it. A connection string in a log file is a
 * credential in a log file, and log files get pasted into issues.
 */
import { URL } from 'node:url';
import { errorText } from '../errorText.js';

let pool = null;
let cachedConfig = null;

export class DbConfigError extends Error {
  constructor(message) { super(message); this.name = 'DbConfigError'; }
}

/** Is a database configured at all? Cheap, no I/O, safe to call anywhere. */
export function isConfigured() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

/**
 * Parse and validate `DATABASE_URL` without connecting.
 *
 * Validation is separated from connection on purpose: a typo in a deploy
 * environment should surface as a clear message at boot, not as a confusing
 * timeout on whichever request first happens to touch the database.
 */
export function readConfig({ force = false } = {}) {
  if (cachedConfig && !force) return cachedConfig;
  if (!isConfigured()) return null;

  const raw = process.env.DATABASE_URL.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DbConfigError('DATABASE_URL is not a valid URL');
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new DbConfigError(`DATABASE_URL must be postgres:// or postgresql:// (got ${url.protocol}//)`);
  }
  const database = url.pathname.replace(/^\//, '');
  if (!database) throw new DbConfigError('DATABASE_URL has no database name');

  // sslmode=require is what every managed provider hands out. `rejectUnauthorized:
  // false` matches how those providers issue certificates; it is recorded here
  // rather than buried so that tightening it later is a visible decision.
  const sslMode = url.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? null;
  const ssl = sslMode && sslMode !== 'disable' ? { rejectUnauthorized: false } : false;

  cachedConfig = {
    connectionString: raw,
    host: url.hostname,
    port: Number(url.port || 5432),
    database,
    ssl,
    sslMode,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.PGPOOL_CONNECT_MS ?? 5_000),
  };
  return cachedConfig;
}

/** Host, port, database — never the password, never the raw URL. */
export function describe() {
  if (!isConfigured()) return { configured: false };
  let cfg;
  try {
    cfg = readConfig();
  } catch (err) {
    return { configured: true, valid: false, error: err.message };
  }
  return {
    configured: true, valid: true,
    host: cfg.host, port: cfg.port, database: cfg.database,
    ssl: Boolean(cfg.ssl), max: cfg.max,
  };
}

/**
 * The pool, created on first use. Returns null when nothing is configured —
 * callers are expected to check, exactly as they would a missing API key.
 */
export async function getPool() {
  if (!isConfigured()) return null;
  if (pool) return pool;
  const cfg = readConfig();
  const { default: pg } = await import('pg');
  pool = new pg.Pool(cfg);
  // An idle-client error is emitted on the pool, not on a query. Without a
  // listener Node treats it as an unhandled 'error' event and kills the
  // process — the single most common way a pg pool takes down a server.
  pool.on('error', err => {
    console.error(`[DB] idle client error: ${errorText(err)}`);
  });
  return pool;
}

/**
 * Liveness. Never throws — a health endpoint that throws is not a health
 * endpoint.
 */
export async function dbHealth({ timeoutMs = 3_000 } = {}) {
  if (!isConfigured()) return { configured: false, status: 'not-configured' };

  let cfg;
  try {
    cfg = readConfig();
  } catch (err) {
    return { configured: true, status: 'misconfigured', error: errorText(err) };
  }

  const started = Date.now();
  try {
    const p = await getPool();
    const result = await Promise.race([
      p.query('SELECT 1 AS ok'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`health check exceeded ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return {
      configured: true, status: 'ok',
      latencyMs: Date.now() - started,
      database: cfg.database,
      rows: result?.rowCount ?? null,
    };
  } catch (err) {
    return {
      configured: true, status: 'unreachable',
      latencyMs: Date.now() - started,
      error: errorText(err),
    };
  }
}

/**
 * Is the configured database answering RIGHT NOW? Cached so the turn path pays
 * at most one probe per window: `isConfigured()` only says a URL is set, and
 * the P0 of 2026-10-12 was exactly that gap — DATABASE_URL set, the server down
 * for five days, every read treated as if the canonical store existed.
 * Never throws. `false` when nothing is configured.
 */
const REACH_OK_TTL_MS = 10_000;
const REACH_DOWN_TTL_MS = 3_000;
let reach = { at: 0, ok: false, error: null, inflight: null };
export async function isReachable({ timeoutMs = 1_500, now = Date.now() } = {}) {
  if (!isConfigured()) return false;
  const ttl = reach.ok ? REACH_OK_TTL_MS : REACH_DOWN_TTL_MS;
  if (reach.at && now - reach.at < ttl) return reach.ok;
  if (!reach.inflight) {
    reach.inflight = dbHealth({ timeoutMs }).then(h => {
      const ok = h.status === 'ok';
      if (ok !== reach.ok || !reach.at) {
        console[ok ? 'log' : 'error'](ok
          ? '[DB] postgres reachable — canonical World Model serving'
          : `[DB] postgres UNREACHABLE (${h.error ?? h.status}) — canonical reads degraded to legacy memory until it answers`);
      }
      reach = { at: Date.now(), ok, error: ok ? null : (h.error ?? h.status), inflight: null };
      return ok;
    });
  }
  return reach.inflight;
}

/** Last reachability verdict without probing (for status endpoints). */
export function reachability() {
  return { configured: isConfigured(), checkedAt: reach.at || null, reachable: reach.at ? reach.ok : null, error: reach.error };
}

/** Close the pool. Idempotent; safe on SIGTERM. */
export async function closePool() {
  if (!pool) return false;
  const p = pool;
  pool = null;
  try { await p.end(); } catch { /* already closing */ }
  return true;
}

/** One boot line, always printed — a configured database must never be a surprise (L13). */
export function bootLine() {
  const d = describe();
  if (!d.configured) return '[DB] postgres=not-configured (JSON stores remain authoritative)';
  if (!d.valid) return `[DB] postgres=MISCONFIGURED — ${d.error}`;
  return `[DB] postgres=configured host=${d.host} port=${d.port} db=${d.database} ssl=${d.ssl} max=${d.max}`;
}

/**
 * Tests only — substitute the pool.
 *
 * An INJECTION SEAM rather than tests reaching into module internals: ESM
 * exports are read-only, so the alternative is patching `node_modules`, which
 * is what the E3/PR-8 diagnostic had to do before this existed. Returns a
 * restore function.
 */
export function _setPoolForTests(replacement) {
  const previous = pool;
  pool = replacement;
  reach = { at: 0, ok: false, error: null, inflight: null };
  return () => { pool = previous; reach = { at: 0, ok: false, error: null, inflight: null }; };
}

/** Tests only — clears the memoised config so env changes take effect. */
export function _resetForTests() {
  cachedConfig = null;
  reach = { at: 0, ok: false, error: null, inflight: null };
  const had = Boolean(pool);
  pool = null;
  return had;
}
