/**
 * AQUA Brain — Reflection Engine V2: Delta Applier (Brain V1 / B5)
 *
 * The reflector computes a structured WorldDelta ("what changed"). This
 * module ACTS on it — the brief's "reflection should MODIFY structured
 * knowledge". It is the only half of B5 that writes, kept separate from the
 * pure diff computation so the decision to mutate is explicit and auditable.
 *
 * WHAT IT WRITES, AND WHERE THE KNOWLEDGE STILL LIVES
 * --------------------------------------------------
 *   • obsoleted facts → a lifecycle transition to `archived` on the OWNING
 *     subsystem (knowledgeLifecycle in picStore). Archived, never deleted —
 *     the transition is reversible (lifecycle has an `archived → updated`
 *     revival edge), and the fact itself is untouched in evidenceStore. The
 *     supersession is recorded as lifecycle metadata, not a knowledge edit.
 *
 *   • assumptions revised → an annotation note on the entity (the Brain's own
 *     sidecar, which holds no knowledge) so the revision is visible without
 *     rewriting any fact.
 *
 * It deliberately does NOT: delete facts, rewrite statements, mutate the
 * reasoning graph, or touch beliefs/goals (the Mind already owns those and
 * reflected on them). B5 records world-model consequences; it does not seize
 * ownership of the subsystems.
 *
 * Every write is guarded individually — a failed transition on one fact
 * never stops the rest, and the applier always returns a report of what it
 * actually did.
 *
 * @module reflectionV2/deltaApplier
 */

/**
 * Apply a WorldDelta to the world model.
 *
 * @param {object} deps - {
 *     transition(ownerId, subject, to, opts) → lifecycle transition,
 *     annotate(ownerId, entityId, patch) → annotation write (optional),
 *   }
 * @param {string} ownerId
 * @param {object} delta - a WorldDelta from computeWorldDelta()
 * @param {object} [opts] - { applyObsolescence=true, annotateRevisions=true }
 * @returns {{ archived, annotated, skipped, errors }}
 */
export function applyWorldDelta(deps, ownerId, delta, opts = {}) {
  const { transition, annotate } = deps;
  const { applyObsolescence = true, annotateRevisions = true } = opts;
  const report = { archived: [], annotated: [], skipped: [], errors: [] };
  if (!ownerId || !delta) return report;

  // 1. Obsolescence → archive the superseded fact (reversible, non-destructive).
  if (applyObsolescence && transition && delta.obsoleted?.length) {
    for (const o of delta.obsoleted) {
      try {
        const res = transition(ownerId, `fact:${o.factId}`, 'archived', {
          reason: `reflection: superseded by fact:${o.supersededBy} — ${o.reason}`,
        });
        // knowledgeLifecycle.transition REFUSES illegal moves and reports it;
        // respect that rather than forcing state.
        if (res && res.ok === false) report.skipped.push({ factId: o.factId, reason: res.reason ?? 'transition refused' });
        else report.archived.push({ factId: o.factId, supersededBy: o.supersededBy });
      } catch (err) {
        report.errors.push({ factId: o.factId, error: err?.message ?? String(err) });
      }
    }
  }

  // 2. Revised assumptions → an annotation note on the entity, so the
  //    revision is discoverable without editing any fact.
  if (annotateRevisions && annotate && delta.assumptionsRevised?.length) {
    // Group by subject so an entity gets one consolidated note, not many.
    const bySubject = new Map();
    for (const a of delta.assumptionsRevised) {
      if (!a.subject) continue;
      if (!bySubject.has(a.subject)) bySubject.set(a.subject, []);
      bySubject.get(a.subject).push(a);
    }
    for (const [subject, revisions] of bySubject) {
      try {
        const note = revisions.map(r => `revised: "${truncate(r.from)}" → "${truncate(r.to)}"`).join(' | ');
        annotate(ownerId, subjectToEntityId(subject), {
          metadata: { lastRevisionNote: note, lastRevisionAt: Date.now() },
          tags: ['revised'],
        });
        report.annotated.push({ subject, revisions: revisions.length });
      } catch (err) {
        report.errors.push({ subject, error: err?.message ?? String(err) });
      }
    }
  }

  return report;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map a contradiction's subject label to a best-effort entity id, matching
 * the id scheme entityResolver uses. Annotation is keyed by entity id; if the
 * label doesn't resolve to a real node the annotation simply sits unattached
 * and is harmless (it holds no knowledge).
 */
function subjectToEntityId(subject) {
  const slug = String(subject).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `ent:name:${slug}`;
}

function truncate(s, n = 80) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
