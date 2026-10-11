/**
 * AQUA — proactive TRIGGER detection (Phase 4, 2026-10-06).
 *
 * WORLD MODEL → CHANGE → TRIGGER. Pure and deterministic: given the owner's
 * canonical claims (read-model shape) and `now`, list the situations in which
 * an interruption MIGHT be worth it. Whether one fires is the policy's call
 * (policy.js), never this module's, and no model is consulted anywhere.
 *
 * Evidence rules (L3, L9, "never let an inferred fact silently become
 * authority"): a claim counts as evidence only when it is CURRENT (active /
 * trusted), an ASSERTED FACT (not negated, not an intent, hypothetical,
 * question or quote) and not machine-inferred. Disputed claims are evidence
 * only for the contradiction trigger.
 *
 * Trigger classes (bounded: ≤ 2 dependency hops, ≤ MAX_CANDIDATES out):
 *   deadline_at_risk          a deadline within HORIZON_DAYS and an unresolved
 *                             blocker on the deadline's subject (directly, via
 *                             a "waiting/blocked/delayed" status, or one
 *                             depends_on hop away)
 *   deadline_approaching      a deadline within APPROACH_DAYS, nothing blocking
 *   dependent_plan_invalidated a deadline that CHANGED in the last 7 days while
 *                             something else depends on / is blocked by it
 *   contradiction_unresolved  two current claims about one thing the policy
 *                             could not settle (state disputed)
 */
import { deadlineDate, daysUntil } from './deadlines.js';

export const HORIZON_DAYS = 14;
export const APPROACH_DAYS = 3;
export const CHANGE_WINDOW_DAYS = 7;
export const MAX_CANDIDATES = 12;
export const MAX_HOPS = 2;

const CURRENT = new Set(['active', 'trusted']);
const INFERRED_EXTRACTORS = /infer|pattern|reflection/i;
// A status literal that says the thing is held up / no longer held up.
const BLOCKED_STATUS = /\b(blocked|stuck|waiting (?:on|for)|on hold|delayed|held up|pending (?:on|review))\b/i;
const RESOLVED_STATUS = /\b(resolved|done|fixed|finished|complete(?:d)?|came through|unblocked|ready|approved|arrived|repaired|cleared|signed)\b/i;
const OWNER_PREDICATES = new Set(['owns', 'manages', 'task_owner']);

const label = (c, side) => (side === 'subject' ? c.subject : (c.object?.label ?? c.object?.value ?? c.object?.entity ?? c.object?.literal ?? null));
const objectId = c => c.object?.entityId ?? null;
const ts = c => new Date(c.assertedAt ?? 0).getTime();

export function isEvidence(c) {
  return Boolean(c) && CURRENT.has(c.state) && (c.polarity ?? 'asserted') === 'asserted'
    && (c.modality ?? 'fact') === 'fact' && !INFERRED_EXTRACTORS.test(String(c.extractor ?? ''));
}

/** The unresolved blockers of entity `eid`, ≤ MAX_HOPS through depends_on. */
export function blockersOf(eid, claims, { hops = MAX_HOPS } = {}) {
  const out = [];
  const seen = new Set([eid]);
  let frontier = [eid];
  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next = [];
    for (const e of frontier) {
      for (const c of claims) {
        if (!isEvidence(c)) continue;
        let blocker = null;
        if (c.predicate === 'blocks' && objectId(c) === e) blocker = { entityId: c.subjectEntityId, label: c.subject };
        else if (c.predicate === 'blocked_by' && c.subjectEntityId === e) blocker = { entityId: objectId(c), label: label(c, 'object') };
        else if (c.predicate === 'has_status' && c.subjectEntityId === e && BLOCKED_STATUS.test(String(label(c, 'object') ?? ''))) {
          blocker = { entityId: null, label: String(label(c, 'object')), status: true };
        } else if (c.predicate === 'depends_on' && c.subjectEntityId === e && objectId(c) && !seen.has(objectId(c))) {
          // A dependency is only a blocker if IT is held up — walk one hop further.
          seen.add(objectId(c));
          next.push(objectId(c));
          continue;
        }
        if (!blocker) continue;
        if (blocker.entityId && isResolved(blocker.entityId, c, claims)) continue;
        if (blocker.status && isStatusSuperseded(e, c, claims)) continue;
        out.push({ ...blocker, claimId: c.claimId, hop, via: c.predicate, dependsOn: hop > 1 ? e : null,
          owner: blocker.entityId ? ownerOf(blocker.entityId, claims) : null });
      }
    }
    frontier = next;
  }
  // One blocker entity once (the most recent claim wins the citation).
  const byKey = new Map();
  for (const b of out) {
    const k = b.entityId ?? `status:${b.label.toLowerCase()}`;
    const prev = byKey.get(k);
    if (!prev || ts(claims.find(c => c.claimId === b.claimId)) > ts(claims.find(c => c.claimId === prev.claimId))) byKey.set(k, b);
  }
  return [...byKey.values()];
}

/** A blocker is resolved when a NEWER current status says so, or a newer negation denies it. */
function isResolved(blockerId, blockingClaim, claims) {
  const t = ts(blockingClaim);
  return claims.some(c => CURRENT.has(c.state) && ts(c) >= t && c.claimId !== blockingClaim.claimId && (
    (c.subjectEntityId === blockerId && c.predicate === 'has_status' && (c.polarity ?? 'asserted') === 'asserted'
      && RESOLVED_STATUS.test(String(label(c, 'object') ?? '')))
    || ((c.polarity ?? 'asserted') === 'negated' && c.predicate === blockingClaim.predicate
      && c.subjectEntityId === blockingClaim.subjectEntityId && objectId(c) === objectId(blockingClaim))));
}

/** A "waiting/blocked" status is moot once a newer status on the same subject exists. */
function isStatusSuperseded(eid, statusClaim, claims) {
  const t = ts(statusClaim);
  return claims.some(c => c.claimId !== statusClaim.claimId && isEvidence(c) && c.subjectEntityId === eid
    && c.predicate === 'has_status' && ts(c) > t);
}

/** Who is responsible for a thing: "Kavya owns X", "X owned_by Kavya", the newest current one. */
export function ownerOf(entityId, claims) {
  const cands = claims.filter(c => isEvidence(c) && (
    (OWNER_PREDICATES.has(c.predicate) && objectId(c) === entityId)
    || (c.predicate === 'owned_by' && c.subjectEntityId === entityId)));
  if (!cands.length) return null;
  const c = cands.sort((a, b) => ts(b) - ts(a))[0];
  return c.predicate === 'owned_by'
    ? { label: label(c, 'object'), entityId: objectId(c), claimId: c.claimId }
    : { label: c.subject, entityId: c.subjectEntityId, claimId: c.claimId };
}

const fmtDay = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const fingerprint = ids => [...new Set(ids)].sort().join(',');

/**
 * @param {object[]} claims  canonical claims of ONE owner (current + recently superseded/disputed)
 * @param {Date|number} now
 * @returns {object[]} candidates, most urgent first, ≤ MAX_CANDIDATES
 */
export function detectTriggers(claims, now = Date.now()) {
  const list = Array.isArray(claims) ? claims : [];
  const out = [];

  // ── deadlines: at risk / approaching / passed ─────────────────────────────
  const deadlines = list.filter(c => isEvidence(c) && c.predicate === 'deadline_for')
    .map(c => ({ c, d: deadlineDate(c) })).filter(x => x.d);
  // The newest current deadline per subject is the deadline (older ones are history).
  const bySubject = new Map();
  for (const x of deadlines) {
    const prev = bySubject.get(x.c.subjectEntityId);
    if (!prev || ts(x.c) > ts(prev.c)) bySubject.set(x.c.subjectEntityId, x);
  }
  for (const { c, d } of bySubject.values()) {
    const daysLeft = daysUntil(d.date, now);
    const blockers = blockersOf(c.subjectEntityId, list);
    const base = {
      subjectEntityId: c.subjectEntityId, subjectLabel: c.subject,
      deadline: { date: d.date.toISOString().slice(0, 10), claimId: c.claimId, how: d.how, said: c.object?.value ?? c.object?.literal ?? null },
      daysLeft, blockers,
    };
    if (blockers.length) {
      const evidence = [c.claimId, ...blockers.map(b => b.claimId), ...blockers.map(b => b.owner?.claimId).filter(Boolean)];
      const who = blockers.map(b => `${b.label}${b.owner ? ` (owned by ${b.owner.label})` : ''}${b.dependsOn ? ` — ${c.subject} depends on it` : ''}`).join('; ');
      out.push({ ...base, type: 'deadline_at_risk', evidenceClaimIds: [...new Set(evidence)],
        cooldownKey: `deadline_at_risk:${c.subjectEntityId}`, fingerprint: fingerprint(evidence),
        benefit: 0.9,
        reason: `${c.subject} is due ${fmtDay(d.date)} (${daysLeft} day${daysLeft === 1 ? '' : 's'}) and is still blocked: ${who}.`,
        message: `Heads-up: ${c.subject} is due ${fmtDay(d.date)}, ${daysLeft <= 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}, and ${who} is still blocking it. Want to plan around it or chase it?` });
    } else {
      out.push({ ...base, type: 'deadline_approaching', evidenceClaimIds: [c.claimId],
        cooldownKey: `deadline_approaching:${c.subjectEntityId}`, fingerprint: fingerprint([c.claimId]),
        benefit: 0.5,
        reason: `${c.subject} is due ${fmtDay(d.date)} (${daysLeft} day${daysLeft === 1 ? '' : 's'}); nothing known is blocking it.`,
        message: `Reminder: ${c.subject} is due ${fmtDay(d.date)}, ${daysLeft <= 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}.` });
    }
  }

  // ── a deadline that changed, with something depending on it ──────────────
  const nowMs = new Date(now).getTime();
  for (const old of list.filter(c => c.state === 'superseded' && c.predicate === 'deadline_for' && c.supersededBy)) {
    const changedAt = new Date(old.validTo ?? old.updatedAt ?? 0).getTime();
    if (!(changedAt && nowMs - changedAt <= CHANGE_WINDOW_DAYS * 86_400_000)) continue;
    const succ = list.find(c => c.claimId === old.supersededBy && isEvidence(c));
    if (!succ) continue;
    const dependents = list.filter(c => isEvidence(c) && (
      (c.predicate === 'depends_on' && objectId(c) === old.subjectEntityId)
      || (c.predicate === 'blocked_by' && objectId(c) === old.subjectEntityId)
      || (c.predicate === 'blocks' && c.subjectEntityId === old.subjectEntityId)));
    if (!dependents.length) continue;
    const names = dependents.map(c => (c.predicate === 'blocks' ? label(c, 'object') : c.subject)).filter(Boolean);
    const evidence = [old.claimId, succ.claimId, ...dependents.map(c => c.claimId)];
    out.push({ type: 'dependent_plan_invalidated', subjectEntityId: old.subjectEntityId, subjectLabel: old.subject,
      daysLeft: null, blockers: [], evidenceClaimIds: [...new Set(evidence)],
      cooldownKey: `dependent_plan_invalidated:${old.subjectEntityId}`, fingerprint: fingerprint(evidence), benefit: 0.7,
      reason: `${old.subject}'s date changed (${label(old, 'object')} → ${label(succ, 'object')}) and ${names.join(', ')} depend${names.length === 1 ? 's' : ''} on it.`,
      message: `${old.subject} moved from ${label(old, 'object')} to ${label(succ, 'object')}. ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} tied to it — anything to re-plan?` });
  }

  // ── a dispute the policy could not settle ────────────────────────────────
  const disputed = list.filter(c => c.state === 'disputed' && (c.modality ?? 'fact') === 'fact');
  const groups = new Map();
  for (const c of disputed) {
    const k = `${c.subjectEntityId}|${c.predicate}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const [k, cs] of groups) {
    if (cs.length < 2) continue;
    const ids = cs.map(c => c.claimId);
    const who = /^you$/i.test(String(cs[0].subject)) ? "you" : cs[0].subject;
    const values = [...new Set(cs.map(c => `${(c.polarity ?? 'asserted') === 'negated' ? 'not ' : ''}${label(c, 'object')}`))];
    out.push({ type: 'contradiction_unresolved', subjectEntityId: cs[0].subjectEntityId, subjectLabel: cs[0].subject,
      predicate: cs[0].predicate, daysLeft: null, blockers: [], evidenceClaimIds: ids,
      cooldownKey: `contradiction_unresolved:${k}`, fingerprint: fingerprint(ids), benefit: 0.6,
      newestAssertedAt: new Date(Math.max(...cs.map(ts))).toISOString(),
      reason: `Conflicting statements about ${cs[0].subject} (${cs[0].predicate}): ${values.join(' vs ')}.`,
      message: `I have conflicting notes about ${who}: ${values.join(' vs ')}. Which is right?` });
  }

  return out
    .sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99) || b.benefit - a.benefit)
    .slice(0, MAX_CANDIDATES);
}
