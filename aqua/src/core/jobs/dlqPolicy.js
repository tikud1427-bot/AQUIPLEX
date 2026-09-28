/**
 * AQUA — E4/PR-7: dead-letter queue alert policy.
 *
 * PURE. Takes the numbers `queueStats()` and `deadLetters()` already return and
 * says whether a human needs to look. It reads no database, sends nothing, and
 * has no env vars (L13: nothing here is a hidden gate). Delivery — a cron
 * exit code, a pager, a dashboard — is the caller's decision; this module owns
 * only the question "is this DLQ a problem?", so that question has one answer
 * and a test.
 *
 * WHY A DEAD JOB IS ALWAYS AT LEAST A WARNING
 * A job dies only after spending its whole retry budget (L5: it is never
 * deleted). That is evidence that work was asked for and did not happen. One
 * dead job is a fact; a growing or aging pile is an incident.
 *
 * Levels: ok < warn < alert. `level` is the max over all reasons.
 */

export const DLQ_THRESHOLDS = Object.freeze({
  /** Dead jobs at which a pile stops being an anecdote. */
  alertDead: 10,
  /** A dead job nobody has touched for this long is an unowned failure. */
  alertOldestDeadMs: 6 * 60 * 60 * 1000,
  /** Queued backlog that suggests the worker is down or too slow. */
  warnQueued: 1000,
  /** One kind producing this many dead jobs is a systematic bug, not noise. */
  alertDeadPerKind: 5,
});

const LEVEL_RANK = { ok: 0, warn: 1, alert: 2 };

function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{ stats?: {queued?:number,running?:number,done?:number,dead?:number},
 *           dead?: Array<{kind?:string, updated_at?:any, last_error?:string}>,
 *           now?: number, thresholds?: Partial<typeof DLQ_THRESHOLDS> }} input
 * @returns {{ level:'ok'|'warn'|'alert', reasons:string[], deadCount:number,
 *             queued:number, oldestDeadAgeMs:number|null, byKind:Record<string,number> }}
 */
export function evaluateDlq({ stats = {}, dead = [], now = Date.now(), thresholds = {} } = {}) {
  const t = { ...DLQ_THRESHOLDS, ...thresholds };
  const deadCount = Number.isFinite(stats.dead) ? stats.dead : dead.length;
  const queued = Number.isFinite(stats.queued) ? stats.queued : 0;

  const byKind = {};
  let oldest = null;
  for (const row of Array.isArray(dead) ? dead : []) {
    const kind = typeof row?.kind === 'string' && row.kind ? row.kind : 'unknown';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const ts = toMs(row?.updated_at);
    if (ts != null && (oldest == null || ts < oldest)) oldest = ts;
  }
  const oldestDeadAgeMs = oldest == null ? null : Math.max(0, now - oldest);

  let level = 'ok';
  const reasons = [];
  const raise = (lvl, why) => {
    reasons.push(why);
    if (LEVEL_RANK[lvl] > LEVEL_RANK[level]) level = lvl;
  };

  if (deadCount >= t.alertDead) raise('alert', `${deadCount} dead jobs (alert at ${t.alertDead})`);
  else if (deadCount > 0) raise('warn', `${deadCount} dead job${deadCount === 1 ? '' : 's'}`);

  if (oldestDeadAgeMs != null && oldestDeadAgeMs >= t.alertOldestDeadMs) {
    raise('alert', `oldest dead job is ${Math.round(oldestDeadAgeMs / 3600000)}h old and unhandled`);
  }

  for (const [kind, n] of Object.entries(byKind)) {
    if (n >= t.alertDeadPerKind) raise('alert', `kind "${kind}" has ${n} dead jobs — systematic failure`);
  }

  if (queued >= t.warnQueued) raise('warn', `${queued} jobs queued — is the worker running?`);

  return { level, reasons, deadCount, queued, oldestDeadAgeMs, byKind };
}
