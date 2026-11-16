/**
 * AQUA — scheduler leases (scalability Phase 3 preparation)
 *
 * Exactly one process at a time runs each periodic scheduler (stale-job reap,
 * consolidation scan, proactive scan). Table aqua_scheduler_leases (0029).
 *
 *   isLeader()  true while this process holds the lease. Renews when held,
 *               takes it when expired or free, one conditional statement either
 *               way — two processes racing for a free lease: exactly one wins.
 *   release()   give it up at shutdown so a successor takes over at once
 *               rather than after the TTL.
 *
 * A database error means NOT leader (fail closed): a scheduler that cannot
 * prove ownership does not run, and the queue is unaffected either way.
 * Clock: expiry is compared with the DATABASE's now(), never a host clock.
 */
import { getPool, isConfigured } from '../db/pool.js';

export const DEFAULT_LEASE_MS = (() => {
  const v = Number(process.env.AQUA_SCHEDULER_LEASE_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 60_000;
})();

export function createSchedulerLease({ name, holder, ttlMs = DEFAULT_LEASE_MS, pool: injected = null }) {
  let leader = false;
  let lastError = null;
  const stats = { acquired: 0, lost: 0, renewed: 0, errors: 0 };
  const pool = async () => injected ?? (isConfigured() ? await getPool() : null);

  return {
    name, holder,
    async isLeader() {
      try {
        const p = await pool();
        if (!p) { leader = false; return false; }
        const { rows } = await p.query(
          `INSERT INTO aqua_scheduler_leases AS l (name, holder, expires_at)
                VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'))
           ON CONFLICT (name) DO UPDATE
                 SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at, renewed_at = now(),
                     acquired_at = CASE WHEN l.holder = EXCLUDED.holder THEN l.acquired_at ELSE now() END
               WHERE l.holder = EXCLUDED.holder OR l.expires_at < now()
           RETURNING holder`, [name, holder, ttlMs]);
        const now = rows[0]?.holder === holder;
        if (now && !leader) stats.acquired++;
        else if (now) stats.renewed++;
        if (!now && leader) stats.lost++;
        leader = now;
        return leader;
      } catch (err) {
        stats.errors++;
        lastError = String(err?.message ?? err);
        if (leader) stats.lost++;
        leader = false;
        return false;
      }
    },
    async release() {
      if (!leader) return;
      leader = false;
      try {
        const p = await pool();
        await p?.query('DELETE FROM aqua_scheduler_leases WHERE name = $1 AND holder = $2', [name, holder]);
      } catch { /* the TTL releases it anyway */ }
    },
    status: () => ({ name, holder, leader, lastError, ...stats }),
  };
}
