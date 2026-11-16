/**
 * AQUA — pending-charge recovery (scalability Phase 4B)
 *
 * A credit charge is a row (migration 0031) that moves through
 *
 *   PENDING → COMMITTED                  the turn committed (same DB transaction)
 *   PENDING → REFUND_PENDING → REFUNDED  the request failed, or was abandoned
 *   open    → VOID                       the account no longer exists
 *
 * Every move is ONE conditional UPDATE (`WHERE state = <expected>`), so two
 * actors racing for the same charge (the request's own failure path and the
 * reconciler, two reconcilers) cannot both move it; and each move writes an
 * event row in the same transaction (the audit trail).
 *
 * The wallet (Mongo) is injected (`wallet`):
 *   debit(charge)   → { applied: boolean, fromFree, fromPaid, freeResetAt }
 *   refund(charge)  → { outcome: 'refunded'|'already-refunded'|'never-deducted'|'user-gone', refunded }
 *   userExists(userId) → boolean
 * both conditional on the charge id inside the wallet document, so a debit or
 * a refund is applied at most once however often it is retried.
 *
 * FAILURE MODEL. A process may die between any two steps. Every state a death
 * can leave is resolvable by `reconcileCharges` (run by the scheduler-owning
 * worker): an old PENDING becomes REFUND_PENDING (no turn committed it — the
 * commit is atomic with the turn), and REFUND_PENDING is retried until the
 * wallet says refunded / never-deducted / user-gone. Test seam:
 * AQUA_CHARGE_CRASH_AT=<point> kills the process at that point.
 *
 * Gate: AQUA_PENDING_CHARGES=on (needs DATABASE_URL). Off = the wallet's
 * deduct-on-entry and refund exactly as before.
 */
import crypto from 'node:crypto';
import { getPool, isConfigured } from '../core/db/pool.js';

export const STATES = Object.freeze(['PENDING', 'COMMITTED', 'REFUND_PENDING', 'REFUNDED', 'VOID']);

export function pendingChargesEnabled() {
  return String(process.env.AQUA_PENDING_CHARGES ?? '').toLowerCase() === 'on' && isConfigured();
}

/** An unanswered charge older than this is abandoned (its process died). Must exceed any request's lifetime. */
export const ABANDON_MS = (() => {
  const v = Number(process.env.AQUA_CHARGE_ABANDON_MS);
  return Number.isFinite(v) && v >= 1_000 ? v : 15 * 60_000;
})();

/** Test seam: die at a named point (never set in production). */
function crashAt(point) {
  if (process.env.AQUA_CHARGE_CRASH_AT === point) {
    console.log(`[CHARGE] crash point ${point} — exiting (test seam)`);
    process.exit(71);
  }
}

async function pool(p) {
  const x = p ?? await getPool();
  if (!x) throw new Error('pending charges: DATABASE_URL is not configured');
  return x;
}

async function event(q, chargeId, from, to, ev, actor, detail = null) {
  await q.query(
    `INSERT INTO aqua_charge_events (charge_id, from_state, to_state, event, actor, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
    [chargeId, from, to, ev, actor, detail == null ? null : JSON.stringify(detail)]);
}

/** Run fn(client) in one transaction. */
async function tx(p, fn) {
  const client = await (await pool(p)).connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * Begin a charge: PENDING row, then the wallet debit (idempotent on the
 * charge id), then the fact that it was deducted. Returns the charge.
 * Throws when the row cannot be created (no database: the request must not be
 * charged untracked) or when the wallet refuses (insufficient credits: the
 * charge is then closed as REFUNDED/never-deducted at once).
 */
export async function beginCharge({ userId, ownerId, requestId = null, actionType, amount, wallet, actor = 'api', pool: p = null }) {
  const chargeId = crypto.randomUUID();
  await tx(p, async c => {
    await c.query(
      `INSERT INTO aqua_charges (charge_id, user_id, owner_id, request_id, action_type, amount) VALUES ($1, $2, $3, $4, $5, $6)`,
      [chargeId, String(userId), String(ownerId), requestId, actionType, amount]);
    await event(c, chargeId, null, 'PENDING', 'created', actor, { amount, actionType });
  });
  crashAt('after-charge-created');
  let debit;
  try {
    debit = await wallet.debit({ chargeId, userId, amount, actionType });
  } catch (err) {
    // Nothing was taken (insufficient credits, user gone): close the charge, then rethrow.
    await requestRefund(chargeId, { reason: `debit-refused: ${String(err?.message ?? err).slice(0, 80)}`, actor, pool: p }).catch(() => {});
    await processRefund(chargeId, { wallet, actor, pool: p }).catch(() => {});
    throw err;
  }
  crashAt('after-wallet-debit');
  await tx(p, async c => {
    await c.query(
      `UPDATE aqua_charges SET deducted = true, from_free = $2, from_paid = $3, free_reset_at = $4, updated_at = now() WHERE charge_id = $1`,
      [chargeId, debit.fromFree ?? 0, debit.fromPaid ?? 0, debit.freeResetAt ?? null]);
    await event(c, chargeId, 'PENDING', 'PENDING', 'deducted', actor, { fromFree: debit.fromFree ?? 0, fromPaid: debit.fromPaid ?? 0, applied: debit.applied !== false });
  });
  crashAt('after-deducted-recorded');
  return { chargeId, ...debit };
}

/**
 * PENDING → COMMITTED inside the caller's transaction (the turn's). Returns
 * true when this call committed it. A charge already moved (refunded because
 * the request was considered failed) is NOT committed: false.
 */
export async function commitChargeIn(client, chargeId, { actor = 'turn-commit', reason = 'turn-committed' } = {}) {
  if (!chargeId) return false;
  const { rowCount } = await client.query(
    `UPDATE aqua_charges SET state = 'COMMITTED', reason = $2, settled_at = now(), updated_at = now()
      WHERE charge_id = $1 AND state = 'PENDING'`, [chargeId, reason]);
  if (rowCount) await event(client, chargeId, 'PENDING', 'COMMITTED', 'committed', actor, { reason });
  return rowCount === 1;
}

/** PENDING → COMMITTED on its own (a successful non-chat request). */
export async function commitCharge(chargeId, { actor = 'api', reason = 'request-succeeded', pool: p = null } = {}) {
  const ok = await tx(p, c => commitChargeIn(c, chargeId, { actor, reason }));
  crashAt('after-commit');
  return ok;
}

/** PENDING → REFUND_PENDING. Returns the state the charge is in afterwards. */
export async function requestRefund(chargeId, { reason = 'request-failed', actor = 'api', pool: p = null } = {}) {
  const state = await tx(p, async c => {
    const { rows } = await c.query(
      `UPDATE aqua_charges SET state = 'REFUND_PENDING', reason = $2, updated_at = now()
        WHERE charge_id = $1 AND state = 'PENDING' RETURNING state`, [chargeId, reason]);
    if (rows.length) { await event(c, chargeId, 'PENDING', 'REFUND_PENDING', 'refund-requested', actor, { reason }); return 'REFUND_PENDING'; }
    const cur = await c.query('SELECT state FROM aqua_charges WHERE charge_id = $1', [chargeId]);
    return cur.rows[0]?.state ?? null;
  });
  crashAt('after-refund-requested');
  return state;
}

/**
 * REFUND_PENDING → REFUNDED (or VOID when the account is gone). Applies the
 * wallet refund, which is idempotent on the charge id; then records it. Safe
 * to call any number of times, concurrently: the wallet applies the refund at
 * most once, and the state moves once.
 */
export async function processRefund(chargeId, { wallet, actor = 'api', pool: p = null } = {}) {
  const P = await pool(p);
  const { rows: [charge] } = await P.query('SELECT * FROM aqua_charges WHERE charge_id = $1', [chargeId]);
  if (!charge) return { state: null };
  if (charge.state !== 'REFUND_PENDING') return { state: charge.state };
  let result;
  try {
    result = await wallet.refund({
      chargeId, userId: charge.user_id, amount: charge.amount, reason: charge.reason,
      breakdown: charge.deducted ? { fromFree: charge.from_free, fromPaid: charge.from_paid, freeResetAt: charge.free_reset_at } : null,
    });
  } catch (err) {
    await P.query(`UPDATE aqua_charges SET refund_attempts = refund_attempts + 1, last_error = $2, updated_at = now()
                    WHERE charge_id = $1 AND state = 'REFUND_PENDING'`, [chargeId, String(err?.message ?? err).slice(0, 300)]);
    throw err;
  }
  crashAt('after-wallet-refund');
  const to = result.outcome === 'user-gone' ? 'VOID' : 'REFUNDED';
  const moved = await tx(p, async c => {
    const r = await c.query(
      `UPDATE aqua_charges SET state = $2, settled_at = now(), updated_at = now(), refund_attempts = refund_attempts + 1
        WHERE charge_id = $1 AND state = 'REFUND_PENDING'`, [chargeId, to]);
    if (r.rowCount) await event(c, chargeId, 'REFUND_PENDING', to, to === 'VOID' ? 'voided' : 'refunded', actor, { outcome: result.outcome, refunded: result.refunded ?? 0 });
    return r.rowCount === 1;
  });
  crashAt('after-refunded-recorded');
  return { state: to, outcome: result.outcome, moved };
}

/**
 * The recovery pass (scheduler-owning worker, or the CLI). Abandoned PENDING
 * charges (older than abandonMs: their process died before a commit or a
 * refund) become REFUND_PENDING; every REFUND_PENDING is then processed.
 */
export async function reconcileCharges({ wallet, abandonMs = ABANDON_MS, limit = 200, actor = 'reconciler', pool: p = null } = {}) {
  const P = await pool(p);
  const out = { abandoned: 0, refunded: 0, voided: 0, alreadyRefunded: 0, neverDeducted: 0, errors: 0 };
  const { rows: stale } = await P.query(
    `SELECT charge_id FROM aqua_charges WHERE state = 'PENDING' AND updated_at < now() - ($1::int * interval '1 millisecond')
      ORDER BY updated_at LIMIT $2`, [Math.round(abandonMs), limit]);
  for (const { charge_id: id } of stale) {
    if (await requestRefund(id, { reason: 'abandoned', actor, pool: p }) === 'REFUND_PENDING') out.abandoned++;
  }
  const { rows: open } = await P.query(
    `SELECT charge_id FROM aqua_charges WHERE state = 'REFUND_PENDING' ORDER BY updated_at LIMIT $1`, [limit]);
  for (const { charge_id: id } of open) {
    try {
      const r = await processRefund(id, { wallet, actor, pool: p });
      if (r.state === 'VOID') out.voided++;
      else if (r.outcome === 'already-refunded') out.alreadyRefunded++;
      else if (r.outcome === 'never-deducted') out.neverDeducted++;
      else if (r.outcome === 'refunded') out.refunded++;
    } catch { out.errors++; }
  }
  return out;
}

/** Account deletion: every charge of the owner closes (VOID), recorded; then the rows go with the account. */
export async function purgeOwnerCharges(ownerId, { pool: p = null } = {}) {
  if (!isConfigured() && !p) return { voided: 0, deleted: 0, skipped: 'postgres not configured' };
  return tx(p, async c => {
    const { rows } = await c.query(
      `UPDATE aqua_charges SET state = 'VOID', reason = 'account-deleted', settled_at = now(), updated_at = now()
        WHERE owner_id = $1 AND state IN ('PENDING', 'REFUND_PENDING') RETURNING charge_id`, [String(ownerId)]);
    const del = await c.query(
      `WITH gone AS (DELETE FROM aqua_charges WHERE owner_id = $1 RETURNING charge_id)
       DELETE FROM aqua_charge_events e USING gone WHERE e.charge_id = gone.charge_id`, [String(ownerId)]);
    return { voided: rows.length, deletedEvents: del.rowCount };
  });
}

/**
 * Credit-ledger reconciliation. `ledger`: Mongo Transaction rows carrying
 * metadata.chargeId ({ chargeId, type: 'DEBIT'|'REFUND' }). Returns the
 * charges whose ledger does not match their state — e.g. a COMMITTED charge
 * with a refund, a REFUNDED one refunded twice, a deducted one without a debit.
 */
export async function reconcileLedger({ ledger, sinceMs = 7 * 24 * 3600_000, userIds = null, pool: p = null } = {}) {
  const P = await pool(p);
  // What the recorded refund event says was actually returned: a refund can
  // legitimately return nothing (the free credits expired with the day's
  // allowance), and then there is no REFUND row to expect.
  const { rows } = await P.query(
    `SELECT c.charge_id, c.state, c.deducted, c.amount, ev.outcome,
            COALESCE(ev.refunded, 0) AS refunded_amount
       FROM aqua_charges c
       LEFT JOIN LATERAL (SELECT e.detail->>'outcome' AS outcome, (e.detail->>'refunded')::int AS refunded
                            FROM aqua_charge_events e
                           WHERE e.charge_id = c.charge_id AND e.event = 'refunded'
                           ORDER BY e.event_id DESC LIMIT 1) ev ON true
      WHERE c.created_at > now() - ($1::bigint * interval '1 millisecond')
        AND ($2::text[] IS NULL OR c.user_id = ANY($2))`, [sinceMs, userIds ? userIds.map(String) : null]);
  const byCharge = new Map();
  for (const t of ledger) {
    const id = t.chargeId; if (!id) continue;
    const e = byCharge.get(id) ?? { debits: 0, refunds: 0 };
    if (t.type === 'DEBIT') e.debits++; else if (t.type === 'REFUND') e.refunds++;
    byCharge.set(id, e);
  }
  const anomalies = [];
  for (const c of rows) {
    const e = byCharge.get(c.charge_id) ?? { debits: 0, refunds: 0 };
    const problem =
      e.debits > 1 ? 'debited-twice'
      : e.refunds > 1 ? 'refunded-twice'
      : c.state === 'COMMITTED' && e.refunds ? 'committed-but-refunded'
      : c.state === 'COMMITTED' && !e.debits ? 'committed-without-debit'
      // The recorded outcome of the refund step decides what the ledger must show:
      //   refunded (n > 0)   one REFUND row          refunded (0): free part expired → none
      //   already-refunded   one REFUND row (written by the earlier, interrupted attempt)
      //   never-deducted     no debit, no refund
      : c.state === 'REFUNDED' && c.outcome === 'refunded' && c.refunded_amount > 0 && !e.refunds ? 'refunded-state-without-refund-row'
      : c.state === 'REFUNDED' && c.outcome === 'refunded' && c.refunded_amount === 0 && e.refunds ? 'refund-row-for-nothing-returned'
      : c.state === 'REFUNDED' && c.outcome === 'already-refunded' && !e.refunds ? 'refund-row-missing'
      : c.state === 'REFUNDED' && c.outcome === 'never-deducted' && (e.debits || e.refunds) ? 'never-deducted-but-in-ledger'
      : null;
    if (problem) anomalies.push({ chargeId: c.charge_id, state: c.state, problem, ...e });
  }
  return { charges: rows.length, anomalies };
}

/** Counts by state (operators, tests). */
export async function chargeStats({ pool: p = null } = {}) {
  const P = await pool(p);
  const { rows } = await P.query(`SELECT state, count(*)::int AS n FROM aqua_charges GROUP BY state`);
  return Object.fromEntries(rows.map(r => [r.state, r.n]));
}
