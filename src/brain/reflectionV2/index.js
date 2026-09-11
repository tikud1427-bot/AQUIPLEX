/**
 * AQUA Brain — Reflection Engine V2: Orchestrator (Brain V1 / B5)
 *
 * Ties the pure reflector (what changed) to the applier (act on it), and owns
 * the one piece of state a diff needs: the previous graph snapshot per owner,
 * so each reflection compares against the last.
 *
 * CADENCE
 * -------
 * Runs on the SAME trigger the Mind's reflection already uses — every N turns,
 * via chat's post-turn hook — so B5 adds no new schedule and no new timer. It
 * receives the Mind's structured reflection report (already computed that
 * turn) and folds its goal/belief slices into the WorldDelta rather than
 * recomputing them. Composition, not duplication.
 *
 * CONTRACT
 *   • STRUCTURED. Emits a WorldDelta object and (optionally) applies it via
 *     reversible lifecycle transitions. Never a text summary as the artifact.
 *   • FAIL-OPEN. Every path catches; a reflection failure never affects the
 *     turn or the Mind's own reflection.
 *   • OFF BY DEFAULT. AQUA_REFLECT_V2=on enables application; even off, the
 *     delta can be COMPUTED for observability without writing (dry-run).
 *   • BOUNDED. One snapshot per owner (structural fingerprint, not a copy),
 *     evicted with a simple LRU cap so long-lived processes don't grow.
 *
 * Impure only at the store boundary (reads graph, writes lifecycle); the diff
 * it delegates to is pure.
 */
import { snapshotGraph, diffSnapshots, detectObsolescence, computeWorldDelta } from './deltaReflector.js';
import { applyWorldDelta } from './deltaApplier.js';
import { brainEnabled } from '../worldModel/schema.js';
import {
  loadSnapshot, loadWatermark, saveReflectionState,
  forgetReflectionState, reflectionStoreStats,
} from './reflectionStore.js';
import { ledger } from '../../pic/picStore.js';
import { SELF_LABEL } from '../identity/selfEntity.js';

/** owner → last snapshot. LRU-capped. */
const snapshots = new Map();
const MAX_SNAPSHOTS = 1000;
/** owner → last reflection timestamp, for the obsolescence `since` window. */
const lastReflectionAt = new Map();

const metrics = {
  reflections: 0, applied: 0, dryRuns: 0, errors: 0,
  entitiesChanged: 0, relationshipsChanged: 0, obsoleted: 0,
  lastDurationMs: 0,
};

/** Application is opt-in on top of the read-side switch. */
export function reflectV2Enabled() {
  return brainEnabled() && String(process.env.AQUA_REFLECT_V2 ?? '').toLowerCase() === 'on';
}

function rememberSnapshot(ownerId, snap) {
  snapshots.set(ownerId, snap);
  if (snapshots.size > MAX_SNAPSHOTS) {
    // Evict oldest insertion (Map preserves order).
    const oldest = snapshots.keys().next().value;
    snapshots.delete(oldest);
  }
}

/**
 * Reflect on the world model for one owner.
 *
 * @param {object} deps - {
 *     graph, evidenceStore,
 *     detectContradictions, buildEntitiesForOwner,   // for obsolescence
 *     transition, annotate,                          // for application
 *   }
 * @param {string} ownerId
 * @param {object} [opts] - { mindReport, apply? }
 * @returns {{ delta, applied, report? }}
 */
export function reflectWorldModel(deps, ownerId, opts = {}) {
  if (!ownerId) return { delta: null, applied: false };
  const started = Date.now();
  try {
    metrics.reflections += 1;

    // 1. Snapshot now, diff against the previous snapshot for this owner.
    // DURABLE baseline. Read from disk, not a Map that dies with the process —
    // an empty `before` makes every node look new, which is why the first
    // reflection after every deploy used to fabricate a full-graph delta.
    const before = loadSnapshot(ownerId) ?? { nodes: new Map(), edges: new Map(), takenAt: 0 };
    const after = snapshotGraph(deps, ownerId);
    const diff = diffSnapshots(before, after);

    // 2. Obsolescence over facts that arrived since the last reflection.
    const since = loadWatermark(ownerId);
    const obsolescence = detectObsolescence(deps, ownerId, { since });

    // 3. Assemble the structured delta (folding in the Mind's report slices).
    const delta = computeWorldDelta({ diff, obsolescence, mindReport: opts.mindReport ?? null });

    // 4. Apply — or dry-run for observability when application is disabled.
    const wantApply = opts.apply ?? reflectV2Enabled();
    let report = null;
    if (wantApply && delta.worldModelUpdated) {
      report = applyWorldDelta(deps, ownerId, delta);
      metrics.applied += 1;
    } else if (delta.worldModelUpdated) {
      metrics.dryRuns += 1;
    }

    // 5. Roll state forward — to disk, so the next process diffs against this
    //    and not against nothing.
    rememberSnapshot(ownerId, after);
    saveReflectionState(ownerId, after, after.takenAt);

    // 6. RECORD IT. The delta was previously computed, applied, logged to the
    //    console and then dropped on the floor: `turnPostProcess` calls
    //    `reflectTurn(ownerId)` and discards the return value, so nothing could
    //    ever tell a user what AQUA changed its mind about.
    //
    //    Written to the EXISTING PIC ledger rather than a new journal — it is
    //    already per-owner, bounded, persisted and mirrored, and it is exactly
    //    what that ring was described as holding ("intelligence operations").
    //    Its read side (`getLedger`) had zero callers before this.
    //
    //    Only real deltas are recorded. A no-change reflection is not an event.
    if (delta.worldModelUpdated) {
      try {
        ledger(ownerId, 'reflection', {
          summary:  delta.summary,
          entities: delta.entitiesChanged.length,
          relationships: delta.relationshipsChanged.length,
          obsoleted: delta.obsoleted.length,
          revised:   delta.assumptionsRevised?.length ?? 0,
          applied:   !!report,
          // SUBSTANCE, not just counts. The first version of this stored only
          // the numbers, and the directive built from it read "your
          // understanding changed: 5 entities changed" — which is the exact
          // changelog voice the directive then forbids the model from using.
          // The delta already carries labels; throwing them away and asking the
          // model to sound human about arithmetic was the bug.
          //
          // Bounded hard: this rides a 300-entry ring per owner, and a question
          // that names five things is already one thing too many to ask.
          //
          // The SELF entity is excluded. Its label is the literal word "You",
          // and a directive reading "what you understand about You, Maya and
          // Nummo has shifted" is incoherent — the self node IS the person being
          // spoken to, never a third party they can be asked about. (Fourth
          // place that label has had to be special-cased; a non-lexical one
          // would have prevented all of them.)
          subjects: delta.entitiesChanged
            .map(e => String(e?.label ?? '').trim())
            .filter(l => l && l.toLowerCase() !== String(SELF_LABEL).toLowerCase())
            .slice(0, 5),
          // A superseded assumption is the strongest material there is: AQUA
          // believed something and no longer does. from/to are what make the
          // question answerable instead of vague.
          revisions: (delta.assumptionsRevised ?? [])
            .slice(0, 2)
            .map(a => ({
              subject: String(a?.subject ?? '').slice(0, 120),
              from:    String(a?.from ?? '').slice(0, 200),
              to:      String(a?.to ?? '').slice(0, 200),
            }))
            .filter(a => a.subject || a.to),
        });
      } catch { /* fail-open: bookkeeping must never break reflection */ }
    }

    metrics.entitiesChanged += delta.entitiesChanged.length;
    metrics.relationshipsChanged += delta.relationshipsChanged.length;
    metrics.obsoleted += delta.obsoleted.length;
    metrics.lastDurationMs = Date.now() - started;

    if (delta.worldModelUpdated) {
      console.log(`[BRAIN] Reflection V2 owner=${ownerId} ${delta.summary}${report ? ` — applied: archived=${report.archived.length} annotated=${report.annotated.length}` : ' (dry-run)'}`);
    }

    return { delta, applied: !!report, report };
  } catch (err) {
    metrics.errors += 1;
    console.warn(`[BRAIN] Reflection V2 failed (fail-open): ${err?.message ?? err}`);
    return { delta: null, applied: false, error: err?.message ?? String(err) };
  }
}

/** Drop an owner's snapshot state (account deletion / tests). */
export function forgetOwner(ownerId) {
  snapshots.delete(ownerId);
  lastReflectionAt.delete(ownerId);
  forgetReflectionState(ownerId);
}

export function reflectionV2Metrics() {
  const persisted = reflectionStoreStats();
  return {
    ...metrics,
    enabled: reflectV2Enabled(),
    trackedOwners: snapshots.size,
    // Durable count, reported separately: the in-memory number is whatever this
    // process has seen since boot, which is exactly the thing that used to be
    // mistaken for the whole picture.
    persistedOwners: persisted.owners,
  };
}

export function _resetReflectionV2ForTests() {
  snapshots.clear();
  lastReflectionAt.clear();
}
