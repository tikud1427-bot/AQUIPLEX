/**
 * AQUA — BOUNDED ACTION planner (Phase 5, 2026-10-06).
 *
 * WORLD MODEL → REASONING (a fired intervention) → PLAN. Pure and
 * deterministic: it proposes AT MOST ONE small plan per intervention, from a
 * closed set of action kinds, built only from the intervention's evidence
 * (which already passed the policy's evidence gate — current, asserted,
 * user-stated, never inferred). Nothing here executes; every plan carries
 * `requiresApproval: true` and a dry-run preview of exactly what would happen.
 *
 *   draft_message        compose a message the USER can send (no external send
 *                        exists — Aqua never acts outside the product on its own)
 *   create_reminder      an internal reminder, delivered like an intervention
 *   resolve_contradiction the user picks the true value → the canonical
 *                        correction path writes it (actor: user)
 *
 * Bounds (G6): MAX_STEPS per plan, a per-step timeout, MAX_ATTEMPTS retries,
 * and an expiry no later than the intervention's own.
 */
export const ACTION_KINDS = Object.freeze(['draft_message', 'create_reminder', 'resolve_contradiction']);
export const MAX_STEPS = 3;
export const STEP_TIMEOUT_MS = 10_000;
export const MAX_ATTEMPTS = 3;

const day = iso => new Date(`${iso}T00:00:00.000Z`);
const fmtDay = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

/** @returns {object|null} a plan, or null when no bounded action fits */
export function proposeAction(candidate) {
  if (!candidate) return null;
  if (candidate.type === 'deadline_at_risk') {
    const b = (candidate.blockers ?? []).find(x => x.owner?.label) ?? null;
    if (b) {
      const due = candidate.deadline?.date ? fmtDay(day(candidate.deadline.date)) : 'the deadline';
      const draft = `Hi ${b.owner.label}, quick check on ${b.label}: ${candidate.subjectLabel} is due ${due} and is waiting on it. What's the current status, and is there anything I can do to help unblock it?`;
      return plan('draft_message', `Draft a status check to ${b.owner.label} about ${b.label}`, [
        { op: 'compose_draft', to: b.owner.label, body: draft },
      ], { evidenceClaimIds: [b.claimId, b.owner.claimId, candidate.deadline?.claimId].filter(Boolean), preview: { to: b.owner.label, body: draft } });
    }
    if (candidate.deadline?.date && candidate.daysLeft > 2) {
      const at = new Date(day(candidate.deadline.date).getTime() - 2 * 86_400_000 + 9 * 3_600_000);
      return reminder(candidate, at);
    }
    return null;
  }
  if (candidate.type === 'deadline_approaching' && candidate.deadline?.date && candidate.daysLeft >= 1) {
    const at = new Date(day(candidate.deadline.date).getTime() - 86_400_000 + 9 * 3_600_000);
    return reminder(candidate, at);
  }
  if (candidate.type === 'contradiction_unresolved' && (candidate.evidenceClaimIds ?? []).length >= 2) {
    return plan('resolve_contradiction', `Settle which statement about ${candidate.subjectLabel} is true`, [
      { op: 'apply_choice', claimIds: candidate.evidenceClaimIds.slice(0, 4) },
    ], { evidenceClaimIds: candidate.evidenceClaimIds.slice(0, 4), needsChoice: true,
      preview: { options: candidate.evidenceClaimIds.slice(0, 4), effect: 'the chosen claim stays current; each other one is superseded through the user-correction path (history kept)' } });
  }
  return null;
}

function reminder(candidate, at) {
  return plan('create_reminder', `Remind about ${candidate.subjectLabel} on ${fmtDay(at)}`, [
    { op: 'schedule_reminder', at: at.toISOString(), message: `Reminder: ${candidate.subjectLabel} is due ${fmtDay(day(candidate.deadline.date))}.` },
  ], { evidenceClaimIds: [candidate.deadline.claimId], preview: { at: at.toISOString() } });
}

function plan(kind, title, steps, extra = {}) {
  if (!ACTION_KINDS.includes(kind)) throw new Error(`unknown action kind ${kind}`);
  if (steps.length > MAX_STEPS) throw new Error('plan exceeds MAX_STEPS');
  return { kind, title, steps, requiresApproval: true, stepBudget: MAX_STEPS, stepTimeoutMs: STEP_TIMEOUT_MS,
    maxAttempts: MAX_ATTEMPTS, dryRun: true, ...extra };
}
