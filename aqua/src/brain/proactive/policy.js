/**
 * AQUA — proactive INTERVENTION POLICY (Phase 4, 2026-10-06).
 *
 * The LLM may compose words; it never decides whether Aqua interrupts. This
 * module does, deterministically, for every candidate trigger (triggers.js):
 *
 *   1 owner      every evidence claim belongs to THIS owner        → wrong_owner
 *   2 evidence   every evidence claim is current, asserted, not
 *                inferred, confidence ≥ MIN_EVIDENCE_CONFIDENCE     → insufficient_evidence
 *   3 timing     inside the trigger's window                        → too_early / too_late
 *   4 redundancy same evidence fingerprint already recorded         → redundant (no row)
 *   5 prefs      user disabled / below the user's minimum severity  → user_disabled / below_min_severity
 *   6 learning   this owner dismissed this trigger type ≥ 3× in 30
 *                days with no acceptance; or dismissed this exact
 *                cooldown key in the last 7 days                    → learned_dismissal / dismissed_recently
 *   7 cooldown   same cooldown key fired < COOLDOWN_MS ago, unless
 *                severity ESCALATED                                  → cooldown
 *   8 frequency  ≥ max_per_day interventions in the last 24 h        → frequency_cap
 *   9 quiet      inside quiet hours → fires, delivery DEFERRED to the window's end
 *
 * Pure: the caller supplies the history and preferences it read. Every
 * decision carries its full trace so "why did Aqua say that?" (and "why
 * didn't it?") is always answerable.
 */
import { HORIZON_DAYS, APPROACH_DAYS } from './triggers.js';

export const COOLDOWN_MS = 72 * 3_600_000;
export const DISMISS_WINDOW_MS = 30 * 86_400_000;
export const DISMISS_RECENT_MS = 7 * 86_400_000;
export const LEARNED_DISMISSALS = 3;
export const MIN_EVIDENCE_CONFIDENCE = 0.4;
export const CONTRADICTION_SETTLE_MS = 30 * 60_000;
export const DEFAULT_PREFS = Object.freeze({ enabled: true, minSeverity: 'medium', maxPerDay: 3, quietStartMin: null, quietEndMin: null, tzOffsetMin: 0 });

const SEV_RANK = { low: 0, medium: 1, high: 2 };
const CURRENT = new Set(['active', 'trusted']);
const SINGLE_VALUED = new Set(['works_at', 'role_is', 'located_in', 'reports_to', 'has_status', 'deadline_for', 'owned_by']);

/** Severity + urgency, from the trigger alone. */
export function assess(candidate) {
  const d = candidate.daysLeft;
  switch (candidate.type) {
    case 'deadline_at_risk':
      return { severity: d <= 7 ? 'high' : 'medium', urgency: clamp01(1 - d / HORIZON_DAYS) };
    case 'deadline_approaching':
      return { severity: d <= 1 ? 'medium' : 'low', urgency: clamp01(1 - d / (APPROACH_DAYS + 1)) };
    case 'dependent_plan_invalidated':
      return { severity: 'medium', urgency: 0.5 };
    case 'contradiction_unresolved':
      return { severity: SINGLE_VALUED.has(candidate.predicate) ? 'medium' : 'low', urgency: 0.3 };
    default:
      return { severity: 'low', urgency: 0 };
  }
}

function timing(candidate, now) {
  const d = candidate.daysLeft;
  if (candidate.type === 'deadline_at_risk') {
    if (d < 0) return 'too_late';
    if (d > HORIZON_DAYS) return 'too_early';
  }
  if (candidate.type === 'deadline_approaching') {
    if (d < 0) return 'too_late';
    if (d > APPROACH_DAYS) return 'too_early';
  }
  if (candidate.type === 'contradiction_unresolved' && candidate.newestAssertedAt
    && now - new Date(candidate.newestAssertedAt).getTime() < CONTRADICTION_SETTLE_MS) return 'too_early';
  return null;
}

function inQuietHours(prefs, now) {
  if (prefs.quietStartMin == null || prefs.quietEndMin == null) return null;
  const local = new Date(now + prefs.tzOffsetMin * 60_000);
  const m = local.getUTCHours() * 60 + local.getUTCMinutes();
  const { quietStartMin: s, quietEndMin: e } = prefs;
  const inside = s <= e ? (m >= s && m < e) : (m >= s || m < e);
  if (!inside) return null;
  const minsToEnd = (e - m + 1440) % 1440 || 1440;
  return new Date(now + minsToEnd * 60_000);
}

/**
 * @param {object} candidate  from detectTriggers
 * @param {object} ctx { ownerId, claimsById: Map, history: [{triggerType, cooldownKey, idempotencyKey, severity, status, userResponse, createdAt, respondedAt}], prefs, now }
 * @returns {{fire:boolean, record:boolean, reason:string, severity, urgency, score, confidence, deliverAfter, expiresAt, idempotencyKey, trace:string[]}}
 */
export function decide(candidate, ctx = {}) {
  const now = new Date(ctx.now ?? Date.now()).getTime();
  const prefs = { ...DEFAULT_PREFS, ...(ctx.prefs ?? {}) };
  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const trace = [];
  const { severity, urgency } = assess(candidate);
  const idempotencyKey = `${candidate.cooldownKey}|${candidate.fingerprint}`;
  const expiresAt = candidate.deadline?.date
    ? new Date(`${candidate.deadline.date}T23:59:59.999Z`)
    : new Date(now + 7 * 86_400_000);
  const base = { severity, urgency, idempotencyKey, expiresAt, deliverAfter: null };
  const stop = (reason, record = true) => ({ ...base, fire: false, record, reason, score: 0, confidence: null, trace: [...trace, `✗ ${reason}`] });

  // 1–2. owner + evidence
  const ev = (candidate.evidenceClaimIds ?? []).map(id => ctx.claimsById?.get(id));
  if (!ev.length) return stop('insufficient_evidence', false);
  if (ev.some(c => c && ctx.ownerId && c.ownerId && c.ownerId !== ctx.ownerId)) return stop('wrong_owner', false);
  if (ev.some(c => !c)) return stop('insufficient_evidence', false);
  const assertedFact = c => (c.polarity ?? 'asserted') === 'asserted' && (c.modality ?? 'fact') === 'fact';
  const usable = c => {
    if (candidate.type === 'contradiction_unresolved') return c.state === 'disputed';
    // A CHANGE is evidenced by the value it replaced: the superseded deadline
    // (and only it) is admissible for dependent_plan_invalidated.
    if (candidate.type === 'dependent_plan_invalidated' && c.state === 'superseded' && c.predicate === 'deadline_for'
      && c.supersededBy && candidate.evidenceClaimIds.includes(c.supersededBy)) return assertedFact(c);
    return CURRENT.has(c.state) && assertedFact(c);
  };
  if (!ev.every(usable)) return stop('insufficient_evidence', false);
  const evConf = Math.min(...ev.map(c => Number(c.confidence?.derived ?? c.confidence ?? 0.5)));
  if (candidate.type !== 'contradiction_unresolved' && evConf < MIN_EVIDENCE_CONFIDENCE) return stop('insufficient_evidence', false);
  trace.push(`evidence ${ev.length} claim(s), min confidence ${evConf.toFixed(2)}`);

  // 3. timing
  const t = timing(candidate, now);
  if (t) return stop(t, false);
  trace.push(`timing ok (${candidate.daysLeft ?? '—'} day(s))`);

  // 4. redundancy — the same world state has already been judged
  if (history.some(h => h.idempotencyKey === idempotencyKey)) return stop('redundant', false);

  const confidence = { evidence: round(evConf), urgency: round(urgency), benefit: round(candidate.benefit ?? 0.5),
    relevance: 1 };
  const score = round(0.4 * urgency + 0.4 * (candidate.benefit ?? 0.5) + 0.2 * evConf);
  const withScore = r => ({ ...r, score, confidence });

  // 5. preferences
  if (prefs.enabled === false) return withScore(stop('user_disabled'));
  if (SEV_RANK[severity] < SEV_RANK[prefs.minSeverity ?? 'medium']) return withScore(stop('below_min_severity'));

  // 6. learning from the user's responses
  const sameType = history.filter(h => h.triggerType === candidate.type && h.respondedAt && now - new Date(h.respondedAt).getTime() <= DISMISS_WINDOW_MS);
  const dismissed = sameType.filter(h => h.userResponse === 'dismissed').length;
  const accepted = sameType.filter(h => h.userResponse === 'accepted').length;
  if (dismissed >= LEARNED_DISMISSALS && accepted === 0) return withScore(stop('learned_dismissal'));
  const prevSameKey = history.filter(h => h.cooldownKey === candidate.cooldownKey)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const lastFired = prevSameKey.find(h => h.status !== 'suppressed');
  const escalated = lastFired && SEV_RANK[severity] > SEV_RANK[lastFired.severity ?? 'low'];
  const recentDismiss = prevSameKey.find(h => h.userResponse === 'dismissed' && h.respondedAt && now - new Date(h.respondedAt).getTime() <= DISMISS_RECENT_MS);
  if (recentDismiss && !escalated) return withScore(stop('dismissed_recently'));

  // 7. cooldown (escalation may break through)
  if (lastFired && now - new Date(lastFired.createdAt).getTime() < COOLDOWN_MS && !escalated) return withScore(stop('cooldown'));
  if (escalated) trace.push(`escalated ${lastFired.severity} → ${severity}`);

  // 8. frequency cap
  const firedToday = history.filter(h => h.status !== 'suppressed' && now - new Date(h.createdAt).getTime() < 86_400_000).length;
  if (firedToday >= Number(prefs.maxPerDay ?? 3)) return withScore(stop('frequency_cap'));

  // 9. quiet hours defer delivery, never the decision
  const deliverAfter = inQuietHours(prefs, now);
  if (deliverAfter) trace.push(`quiet hours — delivery deferred to ${deliverAfter.toISOString()}`);
  trace.push(`✓ fire (${severity}, score ${score})`);
  return { ...base, deliverAfter, fire: true, record: true, reason: 'fire', score, confidence, trace };
}

const clamp01 = x => Math.max(0, Math.min(1, Number(x) || 0));
const round = x => Number(Number(x).toFixed(3));
