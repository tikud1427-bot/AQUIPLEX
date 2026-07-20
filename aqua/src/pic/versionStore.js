/**
 * AQUA Knowledge Versioning — Persistent Intelligence Core (Phase 4)
 *
 * "Every important object should maintain history. Never destroy historical
 * knowledge." Revisions are COMPACT DELTAS — { kind, before, after, reason }
 * with only the fields that changed — referencing knowledge by subject id.
 * The current truth stays in evidenceStore / the graph; this is the
 * evolution trail beside it. A revision is never a copy of the object.
 *
 * Revision kinds (the brief's list, one-to-one):
 *   fact_supersession   a duplicate fact was merged into a survivor
 *   entity_merge        entity resolution fused aliases into one canonical
 *   confidence          a fact's confidence moved (consolidation, dispute)
 *   relationship        an entity relationship appeared or strengthened
 *   memory              a memory-layer fact evolved (bridged from Memory 5.0)
 *   state               a lifecycle flag changed (archived, disputed, trusted)
 *
 * Bounded per subject (oldest revisions roll off — recent history is the
 * useful history), persisted through picStore.
 */
import {
  picBucket, schedulePicSave, pushBounded, MAX_REVISIONS_PER_SUBJ,
} from './picStore.js';

export const REVISION_KINDS = Object.freeze([
  'fact_supersession', 'entity_merge', 'confidence', 'relationship', 'memory', 'state',
]);

/**
 * Record one revision against a subject ('fact:<id>' | 'entity:<id>' | 'uko:<id>').
 * Unknown kinds are refused (returns null) rather than thrown — versioning
 * is bookkeeping and must never sink its caller.
 */
export function recordRevision(ownerId, subject, { kind, before = null, after = null, reason = null, actor = 'pic' } = {}) {
  if (!REVISION_KINDS.includes(kind)) return null;
  const b = picBucket(ownerId);
  if (!b.versions.has(subject)) b.versions.set(subject, []);
  const revs = b.versions.get(subject);
  const rev = {
    rev: (revs[revs.length - 1]?.rev ?? 0) + 1,
    at: Date.now(),
    kind, before, after, reason, actor,
  };
  pushBounded(revs, rev, MAX_REVISIONS_PER_SUBJ);
  schedulePicSave();
  return rev;
}

export function getHistory(ownerId, subject) {
  return picBucket(ownerId).versions.get(subject) ?? [];
}

/** Confidence evolution for one subject — [{ at, from, to, reason }]. */
export function confidenceTrajectory(ownerId, subject) {
  return getHistory(ownerId, subject)
    .filter(r => r.kind === 'confidence')
    .map(r => ({ at: r.at, from: r.before, to: r.after, reason: r.reason }));
}

export function versionStats(ownerId) {
  const b = picBucket(ownerId);
  let revisions = 0;
  const byKind = {};
  for (const revs of b.versions.values()) {
    revisions += revs.length;
    for (const r of revs) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  }
  return { subjects: b.versions.size, revisions, byKind };
}
