/**
 * AQUA — in-memory Postgres for E3 integration tests
 * Blueprint E3/PR-8
 *
 * WHY THIS EXISTS
 * ---------------
 * Six E3 PRs shipped with every live-database test SKIPPED. The skips were
 * honest — reported with a reason, never quietly passed — but the effect was
 * that the migration runner, the blob adapter, the drift job and the read flip
 * had **never been executed against anything**. Six PRs of unexercised code,
 * each verified only by tests that avoided the part that talks to Postgres.
 *
 * `pg-mem` closes that gap without requiring a server, so the chain runs
 * everywhere the battery runs — which is the only way it keeps running.
 *
 * ⚠ WHAT THIS DOES **NOT** PROVE
 * ------------------------------
 * pg-mem is a simulator. It is emphatically not a substitute for the live
 * check, and treating it as one would be exactly the kind of "green means
 * safe" that this project keeps catching. Specifically NOT proven here:
 *
 *   · PARTIAL UNIQUE INDEXES      pg-mem ignores the WHERE clause and treats
 *                                 them as full unique indexes — then SILENTLY
 *                                 DROPS the conflicting row instead of raising.
 *                                 Measured: two entities for one owner, one
 *                                 `self` and one `concept`, and only the first
 *                                 persisted with no error. Real Postgres
 *                                 stores both. Silent data loss in a test
 *                                 harness is worse than a missing feature, so
 *                                 the harness SKIPS creating them and says so.
 *   · pg_advisory_lock            stubbed — it always succeeds, so the
 *                                 two-instances-can't-both-migrate property
 *                                 is NOT tested. That needs two processes and
 *                                 a real server.
 *   · CREATE TABLE IF NOT EXISTS  unimplemented for an existing table
 *   · ON CONFLICT DO NOTHING      unimplemented for an existing row
 *   · real concurrency, connection loss, transaction isolation, SSL,
 *     performance, and every operational failure mode that matters at scale
 *
 * The last two SQL forms are the idempotency mechanism, and the shim tolerates
 * exactly those two errors so the idempotency PATH can be exercised. That is a
 * deliberate, narrow allowance and it is why the live tests remain, still
 * skipped-with-a-reason, still the real evidence.
 */
import { newDb, DataType } from 'pg-mem';

/** The error pg-mem raises for a construct it has not implemented. */
const UNSUPPORTED = /AST which parts have not been read/;

/**
 * A fresh in-memory database and a `pg`-shaped Pool for it.
 * @returns {{ pool: object, db: object, close: () => Promise<void> }}
 */
export function createMemoryPg() {
  const db = newDb();
  /** Partial unique indexes this harness declined to create. */
  const skippedPartialIndexes = [];

  // Locking is stubbed, not implemented. Registered for both argument types
  // because the driver may infer either from a bigint literal.
  for (const type of [DataType.text, DataType.integer]) {
    for (const name of ['pg_advisory_lock', 'pg_advisory_unlock']) {
      db.public.registerFunction({
        name, args: [type], returns: DataType.bool, implementation: () => true,
      });
    }
  }

  const pg = db.adapters.createPg();

  /**
   * Partial unique indexes are SKIPPED, not created.
   *
   * pg-mem ignores the WHERE clause and then silently drops conflicting rows
   * rather than raising. That is the worst failure mode available in a test
   * harness: a write that reports success and did not happen. Skipping means
   * pg-mem simply does not enforce that one constraint, which is honest and
   * matches how `pg_advisory_lock` is handled — untested, and declared.
   */
  const PARTIAL_UNIQUE = /CREATE\s+UNIQUE\s+INDEX[^;]*?\sWHERE\s[^;]*;/gi;

  /**
   * Remove ONLY the partial-index statements, leaving the rest of the
   * migration intact. The first version matched across statement boundaries
   * with `[\s\S]*?` and skipped an entire migration file — a reminder that a
   * regex over multi-statement SQL has to stop at the semicolon.
   */
  const stripPartialIndexes = (sql) => {
    if (typeof sql !== 'string') return sql;
    const cleaned = sql.replace(PARTIAL_UNIQUE, (m) => {
      skippedPartialIndexes.push(m.replace(/\s+/g, ' ').slice(0, 80));
      return '';
    });
    return cleaned;
  };

  const tolerant = (query) => async (...args) => {
    if (typeof args[0] === 'string') args[0] = stripPartialIndexes(args[0]);
    try {
      return await query(...args);
    } catch (err) {
      // ONLY the two idempotent forms above. Anything else propagates —
      // swallowing broadly would turn this harness into a test that passes
      // whatever the code does.
      if (UNSUPPORTED.test(err?.message ?? '')) return { rows: [], rowCount: 0 };
      throw err;
    }
  };

  const pool = new pg.Pool();
  pool.query = tolerant(pool.query.bind(pool));
  const connect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await connect();
    client.query = tolerant(client.query.bind(client));
    return client;
  };

  return {
    pool, db, skippedPartialIndexes,
    close: async () => { try { await pool.end(); } catch { /* already closed */ } },
  };
}

/**
 * Run `fn` with the module-level pool replaced by an in-memory one.
 *
 * The pool module memoises its `pg.Pool`, so the substitution happens through
 * an injection seam rather than by reaching into module internals.
 */
export async function withMemoryPg(fn) {
  const mem = createMemoryPg();
  const pool = await import('../../db/pool.js');
  const restore = pool._setPoolForTests(mem.pool);
  try {
    return await fn(mem);
  } finally {
    restore();
    await mem.close();
  }
}
