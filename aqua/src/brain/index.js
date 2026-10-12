/**
 * AQUA Brain — Facade (Brain V1 / B2)
 *
 * The ONLY module anything outside `src/brain/` should import. Callers get
 * one connected world; which subsystem actually held a given fact is an
 * implementation detail they never have to know.
 *
 * DEPENDENCY DIRECTION
 * --------------------
 * Brain sits ON TOP. It imports reasoning/, mind/ and files/ — never the
 * reverse. Nothing below this layer may import brain/, or the upward
 * dependency that the earlier architecture audit flagged comes straight
 * back. (That is also why B1's type registry lives in reasoning/ and not
 * here: reasoningGraph consumes it.)
 *
 * CONTRACTS
 * ---------
 *   READ-ONLY   The Brain never mutates reasoningGraph or the Mind. It
 *               projects. The one thing it writes is its own annotation
 *               sidecar, which by construction holds no knowledge.
 *   FAIL-OPEN   Every public method catches. The world model is an
 *               enrichment; a failure here must never sink a chat turn or an
 *               ingest. Errors return an empty result, which is always safe.
 *   KILL SWITCH AQUA_BRAIN=off short-circuits every method to empty.
 *   OBSERVABLE  [BRAIN] prefixed logs, brainMetrics() for counts + latency.
 *
 * B2 has no callers yet by design — the retrieval seam is B4's job. Landing
 * the model first keeps that change to a swap-in rather than a rewrite.
 */
import crypto from 'node:crypto';
import { mintProvisionalEntities } from './understanding/provisionalMinter.js';
import { canonicalTurnSourceId } from '../core/worldModel/turnSourceIdentity.js';
import * as graph from '../reasoning/reasoningGraph.js';
import * as evidenceStore from '../files/evidenceStore.js';
import { peekMind } from '../mind/mindStore.js';
import * as annotations from './worldModel/annotationStore.js';
import * as P from './worldModel/projection.js';
import { ingestConversationTurn, ingestMetrics, ingestEnabled, factIngestEnabled } from './knowledgeExtraction/conversationIngest.js';
import { assembleTurnContext, assembleTurnContextAsync, contextEngineMetrics, contextV2Enabled } from './contextEngine/index.js';
import { indexCanonicalClaims, canonicalClaimScores } from './contextEngine/canonicalSemantic.js';
import { selectWorldCore } from './contextEngine/worldCore.js';
import { understoodOf } from './contextEngine/index.js';
import { readingOf } from './contextEngine/assembler.js';
import { reflectWorldModel, reflectionV2Metrics, reflectV2Enabled, forgetOwner as forgetReflectionOwner } from './reflectionV2/index.js';
import { loadSurfacedAt, markSurfaced } from './reflectionV2/reflectionStore.js';
import { buildRevisionDirective, isSuitableTurn } from './reflectionV2/revisionVoice.js';
import { getLedger } from '../pic/picStore.js';
import { observeTwinTurn, twinView, twinMetrics, twinV2Enabled } from './digitalTwin/index.js';
import { buildUnifiedTimeline } from './timelineV2/timelineView.js';
import { buildChains, LIFECYCLE_STAGES } from './timelineV2/chainBuilder.js';
import { getMind } from '../mind/mindStore.js';
import { observeSignals } from '../mind/beliefEngine.js';
import { detectCrossFileContradictions } from '../reasoning/relationshipEngine.js';
import { resolveEntities } from '../reasoning/entityResolver.js';
import { transition } from '../pic/knowledgeLifecycle.js';
import { brainEnabled } from './worldModel/schema.js';
import { purgeOwner as purgeIds } from './identity/idStore.js';
import * as canonicalIds from './identity/canonicalId.js';
import * as pic from '../pic/core.js';
import { ensureSelfEntity, SELF_CANONICAL_ID } from './identity/selfEntity.js';
import { entityStoreFor } from './identity/entityStoreView.js';
import { getEntry as getIdEntry } from './identity/idStore.js';
import { commitUnderstanding as commitCanonicalUnderstanding, findClaimsForDedup, claimWithEvidence, advanceRevisionVoice } from '../core/worldModel/worldModelRepository.js';
import { selectCanonicalRevision } from './reflectionV3/canonicalRevisionVoice.js';
import { recordRevisionVoice } from '../core/observability.js';
import { resolveRelationships } from './understanding/relationshipResolver.js';
import { dedupAndDetect, inStoredVocabulary, isResolutionStatus, RESOLUTION_HISTORY_PREDICATES } from './understanding/claimDedup.js';
import { buildCommitPlan } from './understanding/commitPlan.js';
import { getPool, isConfigured as dbConfigured, isReachable as isDbReachable } from '../core/db/pool.js';
import * as canonicalReadModel from '../core/worldModel/canonicalReadModel.js';
import { singleValuedPredicateNames, singleObjectPredicateNames } from '../core/claims/predicateRegistry.js';
import { isDeictic, recallFocus, rememberFocus, purgeOwner as purgeFocus } from './contextEngine/conversationFocus.js';
import { resolveReferences } from './understanding/referenceResolver.js';
import { startSpan } from '../core/telemetry.js';

/**
 * The owner's self entity id, or null when they do not have one.
 *
 * Presence is checked rather than assumed: `SELF_CANONICAL_ID` is a single
 * constant shared across owners, and `ensureSelfEntity` only registers it when
 * `AQUA_SELF_ENTITY` is on — off by default. Returning the constant regardless
 * would tell S6 that every owner has a self node, including the ones that do
 * not, and first-person claims would resolve to an id with nothing behind it.
 */
const selfEntityIdFor = ownerId =>
  (ownerId && getIdEntry(ownerId, SELF_CANONICAL_ID) ? SELF_CANONICAL_ID : null);

/** Real dependency set. Tests inject their own via the `deps` option. */
const REAL_DEPS = { graph, peekMind, evidenceStore, annotations, getMind, observeSignals, canonicalIds, pic, ensureSelfEntity, entityStoreFor, selfEntityIdFor, canonicalClaims: { get: claimWithEvidence } };

/**
 * E10 READ MODE (2026-10-06 — the cutover, Phase 1).
 *
 *   'authoritative'  DEFAULT (AQUA_CANONICAL_READ unset/auto). The canonical
 *                    World Model is the answer context (canonical lanes only).
 *                    The legacy identity card / regex facts may only FILL GAPS:
 *                    any that the canonical model contradicts is vetoed
 *                    (legacyVetoFor). Mind, legacy graph and episodes stay out.
 *                    Why not a plain flip: users whose knowledge predates E6 —
 *                    names above all, which E6 rarely stores as a claim — would
 *                    lose it until e10:migrate backfilled them; why not legacy:
 *                    the unrevised legacy store answered changed facts stale
 *                    (D5, 7/7 live). Canonical wins every conflict either way.
 *   'canonical'      AQUA_CANONICAL_READ=on: no legacy user memory at all.
 *   'legacy'         AQUA_CANONICAL_READ=off: the complete rollback. Legacy
 *                    writes continue in every mode (dual write), so each mode
 *                    is reversible.
 * Without Postgres (or with the brain off) there is no canonical model: legacy.
 */
export function canonicalReadMode(env = process.env) {
  if (!brainEnabled() || !dbConfigured()) return 'legacy';
  const v = String(env.AQUA_CANONICAL_READ ?? '').toLowerCase();
  if (v === 'off') return 'legacy';
  if (v === 'on') return 'canonical';
  return 'authoritative';
}

export function canonicalWorldModelReadEnabled() {
  return canonicalReadMode() !== 'legacy';
}

/**
 * The read mode THIS TURN can actually serve. `canonicalReadMode()` is the
 * configured intent; it only knows whether DATABASE_URL is set. When the
 * database is configured but not answering there is no canonical model to be
 * authoritative, and the old behaviour was the worst of both: the canonical
 * lanes returned nothing AND the veto failed closed, withholding every legacy
 * fact — retrieval ranked 13 candidates and the prompt got none (P0
 * 2026-10-12). Degrading to the legacy read is what the mode table above
 * already says for "without Postgres"; `degraded` makes it visible instead of
 * pretending the World Model answered.
 *
 * @returns {Promise<{ mode: 'authoritative'|'canonical'|'legacy', configured: string, degraded: boolean, reason: string|null }>}
 */
export async function resolveReadMode({ reachable = isDbReachable } = {}) {
  const configured = canonicalReadMode();
  if (configured === 'legacy') return { mode: 'legacy', configured, degraded: false, reason: null };
  let ok = false;
  try { ok = await reachable(); } catch { ok = false; }
  if (ok) return { mode: configured, configured, degraded: false, reason: null };
  return { mode: 'legacy', configured, degraded: true, reason: 'canonical-store-unreachable' };
}

/** Legacy identity/fact keys → the canonical self predicates that own that attribute. */
const LEGACY_KEY_PREDICATES = Object.freeze({
  workplace: ['works_at'], organization: ['works_at', 'member_of'], profession: ['role_is'],
  city: ['located_in'], country: ['located_in'],
});

/**
 * The veto the 'authoritative' read applies to legacy user memory: a legacy
 * fact is dropped when the canonical World Model (a) holds a CURRENT asserted
 * value for the same attribute of the user, or (b) has retired that exact value
 * (superseded) or negated it. One bounded, owner-scoped query per turn.
 * Fail-CLOSED for legacy: if the canonical read fails, every legacy fact is
 * vetoed rather than risking a stale override.
 */
export async function legacyVetoFor(ownerId) {
  if (!ownerId || !dbConfigured()) return () => false;
  try {
    const p = await getPool();
    const { rows } = await p.query(`
      SELECT c.predicate, c.polarity, c.state, c.modality, se.type AS subject_type,
             lower(COALESCE(oe.canonical_label, c.object_literal, '')) AS val
        FROM aqua_claims c
        JOIN aqua_entities se ON se.entity_id=c.subject_entity_id AND se.owner_id=c.owner_id
        LEFT JOIN aqua_entities oe ON oe.entity_id=c.object_entity_id AND oe.owner_id=c.owner_id
       WHERE c.owner_id=$1 AND c.state IN ('active','trusted','disputed','superseded')
       ORDER BY c.asserted_at DESC LIMIT 2000`, [ownerId]);
    const currentSelf = new Set(rows.filter(r => r.subject_type === 'self' && ['active', 'trusted'].includes(r.state)
      && r.polarity === 'asserted' && r.modality === 'fact').map(r => r.predicate));
    const retired = new Set(rows.filter(r => (r.state === 'superseded' || r.polarity === 'negated') && r.val.length >= 2).map(r => r.val));
    return ({ key, value } = {}) => {
      if ((LEGACY_KEY_PREDICATES[key] ?? []).some(pr => currentSelf.has(pr))) return true;
      const vals = (Array.isArray(value) ? value : [value]).map(v => String(v?.name ?? v ?? '').trim().toLowerCase()).filter(Boolean);
      return vals.some(v => retired.has(v));
    };
  } catch (err) {
    console.warn(`[BRAIN] legacy veto unavailable — legacy memory withheld this turn: ${err?.message ?? err}`);
    return () => true;
  }
}

/**
 * E10 READ FLIP for the ANSWER CONTEXT (D5, 2026-10-05).
 *
 * With AQUA_CANONICAL_READ=on the Context Engine assembles from the canonical
 * Postgres lanes only (structured, dense, graph over aqua_claims). The legacy
 * stores — PIC floor, in-memory reasoning graph, evidence store, Mind — are
 * NOT consulted: they are never revised by supersession, and when they
 * disagreed with the World Model the model followed them ("I moved to Porto"
 * → canonical Porto, legacy city=Lisbon, answer "Lisbon", 7/7 live).
 * Legacy writes continue unchanged, so =off is a complete rollback.
 */
const NO_LEGACY_GRAPH = Object.freeze({ nodesByType: () => [], neighbors: () => [] });
const noLegacyFloor = () => ({ items: [], block: '', stats: {} });
function contextDeps(deps, floorRetrieve, canonicalOnly) {
  return canonicalOnly
    ? { picRetrieve: noLegacyFloor, graph: NO_LEGACY_GRAPH, evidenceStore: null, peekMind: null }
    : { picRetrieve: floorRetrieve, graph: deps.graph, evidenceStore: deps.evidenceStore, peekMind: deps.peekMind };
}

async function guardAsync(label, fallback, fn) {
  if (!brainEnabled()) { metrics.disabled += 1; return fallback; }
  const t0 = Date.now();
  try {
    metrics.calls += 1;
    return await fn();
  } catch (err) {
    metrics.errors += 1;
    console.warn(`[BRAIN] ${label} failed (fail-open): ${err?.message ?? err}`);
    return fallback;
  } finally {
    track(Date.now() - t0);
  }
}

const metrics = {
  calls: 0, errors: 0, disabled: 0,
  lastDurationMs: 0, avgDurationMs: 0,
};

function track(ms) {
  metrics.lastDurationMs = ms;
  // EWMA, same smoothing the PIC uses for its latency figures.
  metrics.avgDurationMs = metrics.avgDurationMs ? Math.round((metrics.avgDurationMs * 0.8 + ms * 0.2) * 100) / 100 : ms;
}

/**
 * Fail-open wrapper. One place to enforce the kill switch, catch, time and
 * count — so no individual method can forget to.
 */
function guard(label, fallback, fn) {
  if (!brainEnabled()) { metrics.disabled += 1; return fallback; }
  const t0 = Date.now();
  try {
    metrics.calls += 1;
    return fn();
  } catch (err) {
    metrics.errors += 1;
    console.warn(`[BRAIN] ${label} failed (fail-open): ${err?.message ?? err}`);
    return fallback;
  } finally {
    track(Date.now() - t0);
  }
}

// ── World model reads ────────────────────────────────────────────────────────

/** @returns {Array} entities across both graphs, most important first. */
export function listEntities(ownerId, opts = {}) {
  const { deps = REAL_DEPS, ...rest } = opts;
  return guard('listEntities', [], () => P.projectEntities(deps, ownerId, rest));
}

/** @returns {object|null} one unified entity by id (`ent:…` or `mind:…`). */
export function getEntity(ownerId, entityId, opts = {}) {
  const { deps = REAL_DEPS } = opts;
  return guard('getEntity', null, () => P.projectEntity(deps, ownerId, entityId));
}

/** @returns {Array} entities matching a name or alias. */
export function findEntities(ownerId, query, opts = {}) {
  const { deps = REAL_DEPS, ...rest } = opts;
  return guard('findEntities', [], () => P.findEntities(deps, ownerId, query, rest));
}

/**
 * Everything AQUA knows about one thing, assembled: the entity plus its
 * relationships, grounded observations and events — from both graphs.
 *
 * This is the call B4's Context Engine will build on, and the reason the
 * projection exposes a shared index: four lookups, one join.
 */
export function describeEntity(ownerId, entityId, opts = {}) {
  const { deps = REAL_DEPS, relationships = 20, observations = 15, events = 15 } = opts;
  return guard('describeEntity', null, () => {
    const index = P.buildWorldIndex(deps, ownerId);
    const entity = P.projectEntity(deps, ownerId, entityId, index);
    if (!entity) return null;
    return {
      entity,
      relationships: P.projectRelationships(deps, ownerId, entity.id, { limit: relationships, index }),
      observations: P.projectObservations(deps, ownerId, entity.id, { limit: observations, index }),
      events: P.projectEvents(deps, ownerId, entity.id, { limit: events, index }),
    };
  });
}

export function getRelationships(ownerId, entityId, opts = {}) {
  const { deps = REAL_DEPS, ...rest } = opts;
  return guard('getRelationships', [], () => P.projectRelationships(deps, ownerId, entityId, rest));
}

export function getObservations(ownerId, entityId, opts = {}) {
  const { deps = REAL_DEPS, ...rest } = opts;
  return guard('getObservations', [], () => P.projectObservations(deps, ownerId, entityId, rest));
}

export function getEvents(ownerId, entityId, opts = {}) {
  const { deps = REAL_DEPS, ...rest } = opts;
  return guard('getEvents', [], () => P.projectEvents(deps, ownerId, entityId, rest));
}

// ── Timeline V2 (B7) ─────────────────────────────────────────────────────────

/**
 * The unified timeline — every event from the reasoning graph, the Mind's own
 * timeline and conversation ingest, ordered, with each event linked to the
 * projects, people, goals, documents and conversations it touches, plus the
 * lifecycle chains detected across them (idea → build → ship → outcome).
 *
 * Read-only. Linking leans on B2's federated entity types: the file side types
 * every proper noun `name`, so without the federation there would be no way to
 * say which of an event's entities is a person and which is a project.
 */
export function getTimeline(ownerId, opts = {}) {
  const { deps = REAL_DEPS, ...rest } = opts;
  return guard('getTimeline', { events: [], chains: [], stats: {} },
    () => buildUnifiedTimeline(deps, ownerId, rest));
}

/**
 * The lifecycle chains alone — the "what is the story of X" view. A chain is
 * temporal + stage-ordered evidence of a progression, never a claim that one
 * stage caused the next.
 */
export function getChains(ownerId, opts = {}) {
  const { deps = REAL_DEPS, ...rest } = opts;
  return guard('getChains', [], () => buildUnifiedTimeline(deps, ownerId, rest).chains);
}
/** Canonical Postgres read views (E10). Legacy projections remain the fail-open floor. */
export async function listEntitiesAsync(ownerId, opts = {}) {
  return guardAsync('listEntitiesAsync', listEntities(ownerId, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return listEntities(ownerId, opts);
    return canonicalReadModel.listEntities(ownerId, opts);
  });
}

export async function findEntitiesAsync(ownerId, query, opts = {}) {
  return guardAsync('findEntitiesAsync', findEntities(ownerId, query, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return findEntities(ownerId, query, opts);
    return canonicalReadModel.findEntities(ownerId, query, opts);
  });
}

export async function getEntityAsync(ownerId, entityId, opts = {}) {
  return guardAsync('getEntityAsync', getEntity(ownerId, entityId, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return getEntity(ownerId, entityId, opts);
    return canonicalReadModel.getEntity(ownerId, entityId, opts);
  });
}

export async function describeEntityAsync(ownerId, entityId, opts = {}) {
  return guardAsync('describeEntityAsync', describeEntity(ownerId, entityId, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return describeEntity(ownerId, entityId, opts);
    const entity = await canonicalReadModel.getEntity(ownerId, entityId, opts);
    if (!entity) return null;
    const [relationships, observations, events] = await Promise.all([
      canonicalReadModel.getRelationships(ownerId, entityId, { limit: opts.relationships ?? 20, retrospective: opts.retrospective === true, pool: opts.pool ?? null }),
      canonicalReadModel.getObservations(ownerId, entityId, { limit: opts.observations ?? 15, retrospective: opts.retrospective === true, pool: opts.pool ?? null }),
      canonicalReadModel.getEvents(ownerId, entityId, { limit: opts.events ?? 15, retrospective: opts.retrospective === true, pool: opts.pool ?? null }),
    ]);
    return { entity, relationships, observations, events, source: 'canonical' };
  });
}

export async function getRelationshipsAsync(ownerId, entityId, opts = {}) {
  return guardAsync('getRelationshipsAsync', getRelationships(ownerId, entityId, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return getRelationships(ownerId, entityId, opts);
    return canonicalReadModel.getRelationships(ownerId, entityId, opts);
  });
}

export async function getObservationsAsync(ownerId, entityId, opts = {}) {
  return guardAsync('getObservationsAsync', getObservations(ownerId, entityId, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return getObservations(ownerId, entityId, opts);
    return canonicalReadModel.getObservations(ownerId, entityId, opts);
  });
}

export async function getEventsAsync(ownerId, entityId, opts = {}) {
  return guardAsync('getEventsAsync', getEvents(ownerId, entityId, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return getEvents(ownerId, entityId, opts);
    return canonicalReadModel.getEvents(ownerId, entityId, opts);
  });
}

export async function getTimelineAsync(ownerId, opts = {}) {
  return guardAsync('getTimelineAsync', getTimeline(ownerId, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return getTimeline(ownerId, opts);
    return canonicalReadModel.getTimeline(ownerId, opts);
  });
}

export async function getChainsAsync(ownerId, opts = {}) {
  return guardAsync('getChainsAsync', getChains(ownerId, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return getChains(ownerId, opts);
    return (await canonicalReadModel.getTimeline(ownerId, opts)).chains ?? [];
  });
}

export { LIFECYCLE_STAGES, buildChains };

// ── Digital Twin (B6) ────────────────────────────────────────────────────────

/**
 * Observe a turn for the six inferred patterns the Mind does not yet cover
 * (writing style, coding style, working hours, learning preference, product
 * philosophy, engineering philosophy).
 *
 * Signals go through the Mind's ONE belief writer, so the new patterns get
 * confidence math, evidence windows, contradiction handling, versioning and
 * decay identically to the existing seven dimensions — no mindSchema change.
 * Fail-open; gated by AQUA_TWIN_V2 (off by default).
 */
export function observeTwin(args = {}, opts = {}) {
  const { deps = REAL_DEPS } = opts;
  return guard('observeTwin', { ok: false }, () =>
    observeTwinTurn({ getMind: deps.getMind, observeSignals: deps.observeSignals }, args));
}

/**
 * What AQUA has inferred about the user — every inference carrying the three
 * things the brief requires: confidence, supporting evidence, last verified
 * (plus the confidence trend). Only patterns past the anti-fabrication bar are
 * reported unless `includeTentative` is set.
 */
export function getTwin(ownerId, opts = {}) {
  const { deps = REAL_DEPS, ...rest } = opts;
  return guard('getTwin', { inferences: [], tentative: 0, patternsCovered: 0 },
    () => twinView({ peekMind: deps.peekMind }, ownerId, rest));
}

export function twinV2Active() { return twinV2Enabled(); }

// ── Reflection Engine V2 (B5) ────────────────────────────────────────────────

/**
 * Build resolved entities from an owner's facts — the same mention→resolve
 * pipeline graphBuilder uses, packaged so the obsolescence detector can reuse
 * the graph's OWN contradiction judgement rather than a divergent one.
 */
function buildEntitiesForOwner(deps, ownerId, facts) {
  const ES = deps.evidenceStore;
  const mentions = [];
  for (const fact of facts) {
    const evidence = ES.evidenceForFact(ownerId, fact.id) ?? [];
    const fileId = evidence[0]?.sourceFileId ?? null;
    for (const raw of fact.entities ?? []) {
      mentions.push({ value: raw, type: guessMentionType(raw), fileId, factId: fact.id, evidenceId: evidence[0]?.id ?? null });
    }
  }
  return resolveEntities(mentions).entities;
}

function guessMentionType(raw) {
  return /@/.test(String(raw)) ? 'email' : 'name';
}

/**
 * Reflect on the world model — compute a STRUCTURED delta of what changed
 * (entities, relationships, obsoleted facts, revised assumptions) since the
 * last reflection, and apply it via reversible lifecycle transitions.
 *
 * Runs on the Mind's existing reflection cadence (chat post-turn), takes the
 * Mind's already-computed report to fold in goal/belief changes, and never
 * recomputes what another subsystem owns. Fail-open; application gated by
 * AQUA_REFLECT_V2 (off → the delta is still computed as a dry-run for
 * observability, nothing is written).
 */
export function reflectTurn(ownerId, opts = {}) {
  const { deps = REAL_DEPS, mindReport = null, apply = undefined } = opts;
  const reflectDeps = {
    graph: deps.graph,
    evidenceStore: deps.evidenceStore,
    detectContradictions: detectCrossFileContradictions,
    buildEntitiesForOwner: (d, oid, facts) => buildEntitiesForOwner({ evidenceStore: deps.evidenceStore }, oid, facts),
    transition,
    annotate: (oid, eid, patch) => deps.annotations.annotate(oid, eid, patch),
  };
  return guard('reflectTurn', { delta: null, applied: false },
    () => reflectWorldModel(reflectDeps, ownerId, { mindReport, apply }));
}

export function reflectV2Active() { return reflectV2Enabled(); }

/**
 * Is AQUA allowed to RAISE a revision in conversation?
 *
 * Its own flag, subordinate to the master switch and independent of
 * `AQUA_REFLECT_V2`. Deliberately not folded into that one: REFLECT_V2 controls
 * whether AQUA ACTS on a delta (archiving, annotating), which is invisible.
 * This controls whether AQUA SPEAKS about one, which every user sees. Those
 * should not share a switch — you may well want the first without the second,
 * and nobody should get the second by accident.
 */
export function revisionVoiceEnabled() {
  return revisionVoiceMode() !== 'off';
}

/**
 * Which voice runs (2026-10-04). The CANONICAL voice is on by default since it
 * passed its L14 evaluation (eval/suites/revision-voice.suite.mjs, baseline
 * revision-voice.v1.json, plus revisionVoice.live.test.js on Postgres). The
 * LEGACY ledger voice was never evaluated that way, so it stays opt-in:
 *   unset → 'canonical' · 'on' → 'canonical+legacy' · 'off' → 'off' (rollback)
 */
export function revisionVoiceMode() {
  if (!brainEnabled()) return 'off';
  const v = String(process.env.AQUA_REVISION_VOICE ?? '').toLowerCase();
  if (v === 'off') return 'off';
  return v === 'on' ? 'canonical+legacy' : 'canonical';
}

/**
 * The one revision worth raising on THIS turn, as a prompt directive.
 *
 * Returns '' for almost every turn, which is the point. Empty when: the flag is
 * off, the turn is not a suitable moment, no revision has been recorded since
 * the last one raised, or the newest one is too small to be news.
 *
 * SIDE EFFECT, and it is the important one: a non-empty return ADVANCES the
 * surfaced watermark. Reading this twice for one turn would burn the revision.
 * Called exactly once per turn, from the prompt assembly seam.
 */
export function revisionDirectiveFor(ownerId, { taskType = null, mode = null } = {}) {
  if (!ownerId || revisionVoiceMode() !== 'canonical+legacy') return '';
  if (!isSuitableTurn({ taskType, mode })) return '';
  return guard('revisionDirectiveFor', '', () => {
    const since = loadSurfacedAt(ownerId);
    // Insertion order IS chronology — `getLedger` returns the ring in the order
    // entries were appended. Deliberately NOT sorted by `at`: two reflections
    // can land in the same millisecond (the codebase already has one
    // millisecond-resolution note, on obsolescence), and a stable sort on tied
    // keys then INVERTS the real order. Walking the array backwards is exact.
    const pending = getLedger(ownerId, { limit: 50 })
      .filter(e => e?.op === 'reflection' && Number(e.at) > since);
    if (!pending.length) return '';

    // NEWEST FIRST, BUT KEEP LOOKING.
    //
    // The first version took `[0]` after sorting and gave up if it was not
    // worth raising. That is a real product bug, not a near miss: reflection
    // runs on a cadence and most deltas are small, so a trivial one-entity
    // revision arriving after an interesting one would MASK it permanently —
    // the interesting revision stays pending forever behind a revision that
    // will never be raised, and the feature is silent in practice. Caught by
    // flagproof failing on Ananya's machine (and, once looked at properly,
    // 2 runs in 5 on mine).
    //
    // Preference for recency is kept — it is still the current picture — but
    // "prefer the newest" was never meant to mean "give up if the newest is
    // boring".
    let chosen = null;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const directive = buildRevisionDirective(pending[i]);
      if (directive) { chosen = { entry: pending[i], directive }; break; }
    }

    // The watermark advances past EVERYTHING considered, not just what was
    // raised. Entries examined and judged not worth raising are decided, not
    // deferred; leaving them pending means rescanning them on every subsequent
    // turn forever, and — worse — a future interesting revision would sit
    // behind them in exactly the way this fix exists to prevent.
    const highest = pending.reduce((m, e) => Math.max(m, Number(e.at) || 0), 0);
    if (!chosen) {
      markSurfaced(ownerId, highest || Date.now());
      return '';
    }
    markSurfaced(ownerId, highest || Date.now());
    console.log(`[BRAIN] Revision raised owner=${ownerId} at=${chosen.entry.at} summary="${chosen.entry.summary}"`);
    return chosen.directive;
  });
}

/**
 * The revision voice for THIS turn, canonical World Model first (2026-10-04).
 *
 * When the canonical World Model is live (Postgres + E6 commit) the changes
 * worth raising are claim supersessions / disputes there
 * (reflectionV3/canonicalRevisionVoice.js); the watermark is a Postgres row
 * advanced by compare-and-set, so across any number of server processes a
 * revision is raised at most once and only by the process whose advance
 * landed. Without Postgres, or when nothing canonical is pending, it falls
 * back to the legacy ledger voice unchanged. Same flag, same suitability rule.
 * Fail-open: any error yields '' — never a failed turn.
 */
export async function revisionDirectiveForTurn(ownerId, { taskType = null, mode = null, conversationId = null } = {}) {
  // Counted (aqua_revision_voice_*): skipped = the turn never selected;
  // considered = candidates examined; suppressed = a candidate decided against
  // (its exclusion reason, 'newer-chosen', or 'lost-race'); emitted = raised.
  if (!ownerId) { recordRevisionVoice('skipped', { reason: 'no-owner' }); return ''; }
  if (!revisionVoiceEnabled()) { recordRevisionVoice('skipped', { reason: 'flag-off' }); return ''; }
  if (!isSuitableTurn({ taskType, mode })) { recordRevisionVoice('skipped', { reason: 'unsuitable-turn' }); return ''; }
  if (dbConfigured() && e6CommitEnabled()) {
    try {
      const candidates = await canonicalReadModel.revisionVoiceCandidates(ownerId);
      if (candidates.length) {
        const pick = selectCanonicalRevision(candidates, { conversationId });
        recordRevisionVoice('considered', { n: pick.considered.length });
        const won = await advanceRevisionVoice(ownerId, {
          at: pick.watermark.at, transitionId: pick.watermark.transitionId,
          raisedTransitionId: pick.chosen?.transitionId ?? null,
        });
        for (const c of pick.considered) {
          if (c.transitionId === pick.chosen?.transitionId) continue;
          recordRevisionVoice('suppressed', { reason: c.excluded ?? 'newer-chosen' });
        }
        if (pick.chosen && (!won || !pick.directive)) {
          recordRevisionVoice('suppressed', { reason: won ? 'missing-statement' : 'lost-race' });
          return '';
        }
        if (!pick.directive) return '';
        recordRevisionVoice('emitted');
        console.log(`[BRAIN] Canonical revision raised owner=${ownerId} transition=${pick.chosen.transitionId} kind=${pick.chosen.toState}`);
        return pick.directive;
      }
    } catch (err) {
      recordRevisionVoice('skipped', { reason: 'error' });
      console.warn(`[BRAIN] canonical revision voice failed (fail-open): ${err?.message ?? err}`);
      return '';
    }
  }
  const legacy = revisionDirectiveFor(ownerId, { taskType, mode });
  if (legacy) recordRevisionVoice('emitted');
  else recordRevisionVoice('skipped', { reason: 'no-candidates' });
  return legacy;
}

// ── Context Engine V2 (B4) ───────────────────────────────────────────────────

/**
 * Assemble the optimal context for a turn — the ten-dimension scorer +
 * budgeted, diversity-aware selection. Returns the SAME { items, block, stats }
 * shape the PIC lane returns (superset — extra data in stats.contextEngine),
 * so it drops into the existing chat seam with no downstream change.
 *
 * The caller supplies the PIC retrieval fn as the floor and, when embeddings
 * are on, the pre-awaited semantic scores (the async boundary stays in chat,
 * not here). Fail-safe: any failure returns the PIC floor unchanged — the
 * user never gets a worse answer than V1 produced. Off unless
 * AQUA_CONTEXT_V2=on, in which case this is a pure passthrough of the floor.
 */
export function assembleContext(ownerId, query, floorRetrieve, opts = {}) {
  const {
    deps = REAL_DEPS,
    semanticScores = null,
    semanticClaimScores = null,
    activeProjectId = null,
    priorEntityIds = null,
    limit = 8,
    charBudget = 1600,
    plan = null,
    queryPlan = null,
    taskType = 'conversation',
    retrievalV3Lanes = null,
  } = opts;
  const engineDeps = {
    ...contextDeps(deps, floorRetrieve, opts.canonicalOnly ?? canonicalWorldModelReadEnabled()),
    formatCitation: opts.formatCitation ?? null,
    semanticScores: semanticClaimScores ?? semanticScores,
    canonicalClaimsById: (semanticClaimScores ?? semanticScores)?.canonicalClaimsById ?? null,
    canonicalClaimLoader: claimWithEvidence,
    canonicalGraphPool: async () => { if (!dbConfigured()) throw new Error('DATABASE_URL is not configured'); return getPool(); },
    enableCanonicalGraph: true,
    activeProjectId,
  };
  return guard('assembleContext',
    { items: [], block: '', stats: {} },
    () => assembleTurnContext(engineDeps, ownerId, query, {
      limit,
      charBudget,
      priorEntityIds: priorEntityIds ?? undefined,
      plan,
      queryPlan,
      taskType,
      semanticScores,
      semanticClaimScores,
      retrievalV3Lanes: Array.isArray(retrievalV3Lanes) ? retrievalV3Lanes : null,
    }));
}

/**
 * Prepare the E7 canonical claim semantic lane. Existing evidence-store facts
 * are backfilled on demand; new facts are indexed at write time. The returned
 * Map is keyed by evidence-store fact.id, which is Context Engine's
 * candidate.semanticId.
 */

/** Async E7 PR-8 variant. Keeps the existing synchronous API untouched. */
export async function assembleContextAsync(ownerId, query, floorRetrieve, opts = {}) {
  const {
    deps = REAL_DEPS,
    semanticScores = null,
    semanticClaimScores = null,
    activeProjectId = null,
    priorEntityIds = null,
    limit = 8,
    charBudget = 1600,
    plan = null,
    queryPlan = null,
    taskType = 'conversation',
    retrievalV3Lanes = null,
    crossEncoder = null,
  } = opts;
  const engineDeps = {
    ...contextDeps(deps, floorRetrieve, opts.canonicalOnly ?? canonicalWorldModelReadEnabled()),
    formatCitation: opts.formatCitation ?? null,
    semanticScores: semanticClaimScores ?? semanticScores,
    canonicalClaimsById: (semanticClaimScores ?? semanticScores)?.canonicalClaimsById ?? null,
    canonicalClaimLoader: claimWithEvidence,
    canonicalGraphPool: async () => { if (!dbConfigured()) throw new Error('DATABASE_URL is not configured'); return getPool(); },
    enableCanonicalGraph: true,
    activeProjectId,
  };
  // DEICTIC FOLLOW-UPS (2026-10-04): "who owns this?" anchors on what the
  // previous turn of THIS conversation was about (conversationFocus.js).
  const conversationId = opts.conversationId ?? null;
  const prior = priorEntityIds
    ?? (conversationId && isDeictic(query) ? recallFocus(ownerId, conversationId) : null);
  // Sentences behind a retired claim — neither section may quote them whole
  // (2026-10-11). One bounded read per turn; fail-open to "none known".
  let retiredTexts = null;
  if (ownerId && dbConfigured()) {
    try { retiredTexts = await canonicalReadModel.retiredStatements(ownerId, { limit: 400 }); } catch { retiredTexts = null; }
  }
  const span = startSpan('context.assemble', { 'aqua.task_type': String(taskType) });
  let result;
  try {
  result = await assembleTurnContextAsync(engineDeps, ownerId, query, {
    limit, charBudget, retiredTexts,
    priorEntityIds: prior?.length ? prior : undefined,
    plan,
    queryPlan,
    taskType,
    semanticScores,
    semanticClaimScores,
    retrievalV3Lanes: Array.isArray(retrievalV3Lanes) ? retrievalV3Lanes : null,
    crossEncoder,
  });
  span.setAttribute('aqua.retrieved_count', (result?.items ?? []).length);
  } catch (err) { span.setStatus('error'); throw err; } finally { span.end(); }
  result = await withWorldCore(ownerId, result, { semanticScores: semanticClaimScores ?? semanticScores, retiredTexts });
  if (conversationId) {
    try { rememberFocus(ownerId, conversationId, (result?.items ?? []).flatMap(i => i.entityIds ?? [])); }
    catch { /* focus is a convenience; never fail a turn over it (L11) */ }
  }
  return result;
}

/** AQUA_WORLD_CORE gate — ON unless explicitly 'off' (the rollback). */
export function worldCoreEnabled() {
  return String(process.env.AQUA_WORLD_CORE ?? 'on').toLowerCase() !== 'off';
}

/**
 * Append the owner's CURRENT WORLD (contextEngine/worldCore.js) to an assembled
 * context: every current claim the relevance section did not already show, as
 * the user's own statements, within a fixed budget. Fail-open (L11): a read
 * error leaves the context exactly as assembled.
 */
async function withWorldCore(ownerId, result, { semanticScores = null, retiredTexts = null } = {}) {
  if (!result || !ownerId || !worldCoreEnabled() || !dbConfigured()) return result;
  try {
    const claims = await canonicalReadModel.currentWorld(ownerId, { limit: 120 });
    const facts = (result.items ?? []).filter(i => i.kind === 'fact');
    const core = selectWorldCore(claims, {
      excludeIds: facts.map(i => i.id).filter(Boolean),
      excludeTexts: facts.map(i => i.statement).filter(Boolean),
      scores: semanticScores instanceof Map ? semanticScores : null,
      retiredTexts: retiredTexts ?? [],
      reading: c => { const u = understoodOf(c); return u ? readingOf(u) : null; },
    });
    const ce = result.stats?.contextEngine;
    const coreStats = { considered: core.considered, rendered: core.lines.length, omitted: core.omitted, chars: core.chars };
    if (!core.block) return { ...result, stats: { ...result.stats, worldCore: coreStats } };
    return {
      ...result,
      block: [result.block, core.block].filter(s => s && String(s).trim()).join('\n\n'),
      worldCore: { claimIds: core.claimIds, lines: core.lines },
      stats: { ...result.stats, worldCore: coreStats, ...(ce ? { contextEngine: { ...ce, worldCore: coreStats } } : {}) },
    };
  } catch (err) {
    console.warn(`[BRAIN] world core unavailable (fail-open): ${err?.message ?? err}`);
    return result;
  }
}

export async function canonicalSemanticScores(ownerId, query) {
  if (!ownerId || !query) return null;
  try {
    const facts = evidenceStore.listFacts(ownerId, { limit: 5000 });
    await indexCanonicalClaims(ownerId, facts);
    const scores = await canonicalClaimScores(ownerId, query);
    if (!(scores instanceof Map) || !scores.size) return scores;

    // Hydrate canonical candidates once, at the async retrieval seam. This
    // prevents Context Engine from needing a DB call inside its synchronous
    // scorer while also eliminating the old requirement that every canonical
    // claim have a legacy evidence-store fact row.
    const canonicalClaimsById = new Map();
    const ids = [...scores.keys()].filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id)));
    await Promise.all(ids.slice(0, 64).map(async id => {
      try {
        const claim = await claimWithEvidence(ownerId, String(id));
        if (claim) canonicalClaimsById.set(String(id), claim);
      } catch (err) {
        console.warn(`[BRAIN] canonical claim hydration skipped id=${id}: ${err?.message ?? err}`);
      }
    }));
    Object.defineProperty(scores, 'canonicalClaimsById', { value: canonicalClaimsById, enumerable: false });
    return scores;
  } catch (err) {
    console.warn(`[BRAIN] canonical semantic lane failed (non-fatal): ${err?.message ?? err}`);
    return null;
  }
}

export function contextV2Active() { return contextV2Enabled(); }

// ── E6 — semantic understanding on the turn path ─────────────────────────────

/**
 * Is E6 turned on?
 *
 * OFF unless explicitly enabled, and read per call rather than captured at
 * import, so turning it off is a restart and not a redeploy. E6 does not pass
 * its own promotion gate — negation detection sits at 85% against a 95% bar on
 * both valid full shadow runs — so the default is the honest one.
 */
export function e6Enabled() {
  return String(process.env.AQUA_E6 ?? 'off').toLowerCase() === 'on';
}

/**
 * Run one turn through the E6 understanding pipeline.
 *
 * Closes blueprint §8's non-negotiable: until this existed,
 * `runUnderstandingPipeline` had zero production consumers — the exact
 * "beautiful code + unit tests + nobody calls it" shape §8 names.
 *
 * ⚠️ IT EXTRACTS AND RETURNS; IT DOES NOT COMMIT. The claim substrate is a
 * separate wiring decision with its own correctness bar, and an extractor that
 * fails its own negation gate must not be writing into the world model on the
 * way to being evaluated. Shadow first, commit second. `stats` comes back so a
 * caller can log what the pipeline saw without the pipeline deciding anything.
 *
 * 🔴 S6 WAS STRUCTURALLY UNREACHABLE UNTIL THIS PASSED `entityStore`.
 *
 * `pipeline.js` returns at its own guard — `entityResolution: 'unresolved'`,
 * `stagesRun: STAGES` — before S6 runs, when no store is supplied. This function
 * supplied none, so the resolver was built, tested, and could not execute on a
 * real turn no matter what the flag said. The pipeline's guard was right to
 * exist: resolving against no store marks every subject provisional and reports
 * a resolution rate of zero, which reads like a measurement of the resolver and
 * is a measurement of the caller forgetting an argument.
 *
 * The store is a READ VIEW over the canonical identity map, not a new one — see
 * `identity/entityStoreView.js`. Injected via `deps` so a wiring test proves the
 * production default rather than a fixture.
 *
 * SELF ENTITY IS PASSED ONLY WHEN IT EXISTS. `SELF_CANONICAL_ID` is one constant
 * shared by every owner (owner scoping lives in the store, not the id), so
 * handing it to S6 unconditionally would assert an identity for owners who have
 * none — `AQUA_SELF_ENTITY` is off by default and nothing has created it. S6
 * then reports first person as `tier: self-grammar, reason: no-self-entity`,
 * which is the honest reading and keeps deixis out of the store exactly as its
 * never-fuse invariant requires. This increment does not change that flag.
 *
 * STILL SHADOW. S6 resolving does not make S7–S9 run; the pipeline does not
 * invoke them and nothing here commits.
 */
export async function understandTurn(
  { ownerId, conversationId, turn = null, userMessage, callModel = null, source = null, assertedAt = null } = {},
  { deps = REAL_DEPS } = {},
) {
  // `source` (2026-10-11): an UPLOADED DOCUMENT chunk rather than a chat turn —
  // { kind: 'document', name, hash, chunk }. Same pipeline, same S8/S9; only the
  // provenance differs (files/documentUnderstanding.js).
  const doc = source?.kind === 'document' ? source : null;
  // WHEN IT WAS SAID (2026-10-11): the S5 anchor for "next month" / "in March".
  // It was never passed, so every relative date stayed unanchored and a future
  // change read as a timeless — i.e. current — fact. Durable jobs carry the
  // enqueue time, so a retry resolves against the turn, not the retry.
  const saidAt = (() => { const d = assertedAt ? new Date(assertedAt) : new Date(); return Number.isNaN(d.getTime()) ? new Date() : d; })();
  if (!e6Enabled()) return null;
  if (!ownerId || !userMessage) return null;
  const { runUnderstandingPipeline } = await import('./understanding/pipeline.js');

  // Fail-open enrichment (L11): a store view that cannot be built leaves S6
  // unrun and S0–S5 untouched — byte-identical to the behaviour before this
  // change. Resolution is a bonus on top of extraction, never a precondition.
  let entityStore = null;
  let selfEntityId = null;
  try {
    // S6 OWNS ITS SELF PRECONDITION (2026-10-03). The self node used to be
    // created only as a side effect of conversation ingest — a different
    // subsystem, and in production a different PROCESS from the durable worker
    // that runs this function. Measured on live Postgres: with
    // AQUA_SELF_ENTITY=on, every first-person claim ("I am building X", "I use
    // Y") came back `blockedBy: subject:self-grammar, reason: no-self-entity`
    // and never reached the world model. ensureSelfEntity is idempotent and
    // returns null unless the flag is on, so this changes nothing for owners
    // with the flag off.
    try { deps.ensureSelfEntity?.(deps, ownerId); } catch { /* fail-open (L11) */ }
    entityStore = deps.entityStoreFor?.(ownerId) ?? null;
    selfEntityId = deps.selfEntityIdFor?.(ownerId) ?? null;
  } catch (err) {
    console.warn(`[E6] entity store unavailable (fail-open): ${err?.message ?? err}`);
    entityStore = null;
    selfEntityId = null;
  }

  // Prompt rule 9 ("prefer these exact names") was never fed on this path, so
  // a change about "the backend" or "the launch date" minted a new subject
  // instead of naming the one the old claim is about — and two subjects never
  // conflict, so the old value was never retired (D6 live check, 2026-10-05).
  // The owner's most important canonical entities, never "You". Fail-open.
  let knownEntities = [];
  // Rule 12: what was said earlier in THIS conversation and what is currently
  // known — so "It's written in Rust" / "No, it's Rust" / "the launch date
  // changed" can name the subject they refer to (D6). Fail-open: no context is
  // exactly the old behaviour.
  let context = null;
  if (dbConfigured()) {
    try {
      knownEntities = (await canonicalReadModel.listEntities(ownerId, { limit: 40 }))
        .filter(e => e.type !== 'self').map(e => e.label).filter(Boolean);
    } catch { knownEntities = []; }
    try {
      context = await canonicalReadModel.extractionContext(ownerId, { conversationId, turn });
    } catch { context = null; }
  }
  // A document line ("Monthly rent: $6,400") names no subject; what it is FROM
  // is the reference rule 12 resolves against. Context only — never extracted.
  if (doc?.name) {
    context = { ...(context ?? {}), conversation: [`(The sentence is from the user's uploaded file "${doc.name}".)`, ...(context?.conversation ?? [])] };
  }

  const result = await runUnderstandingPipeline(userMessage, {
    ownerId, conversationId, callModel: callModel ?? (await e6Transport()),
    entityStore, selfEntityId, knownEntities, context, assertedAt: saidAt.toISOString(),
    documentFallback: Boolean(doc),   // key/value lines of an uploaded file are never silently lost
  });

  // S6's missing half — see understanding/provisionalMinter.js. A claim about a
  // name the identity map has never seen comes back `new-provisional` and
  // UNREADY, and nothing ever inserted it, so the world model could only learn
  // about things it already knew. Minting happens only when the claim would
  // otherwise be COMMITTED: an extractor whose commit is off must not be
  // growing the identity map on the way to being evaluated. Fail-open (L11).
  // S6½ — references the minter would refuse ("my company", "it", "the
  // project") resolved against the owner's EXISTING canonical World Model,
  // only when unambiguous (understanding/referenceResolver.js). Fail-open (L11).
  if (e6CommitEnabled() && dbConfigured() && result?.entityResolution === 'resolved' && result.claims?.length) {
    try {
      const prevSource = Number.isInteger(turn) && turn > 1 && conversationId
        ? canonicalTurnSourceId(ownerId, conversationId, turn - 1) : null;
      const refs = await resolveReferences(result.claims, {
        pronoun: () => canonicalReadModel.referencePreviousTurn(ownerId, prevSource),
        role: predicates => canonicalReadModel.referenceRoleObjects(ownerId, predicates),
        headNoun: head => canonicalReadModel.referenceHeadNoun(ownerId, head),
      });
      result.claims = refs.claims;
      result.stats = { ...result.stats, s6: { ...result.stats?.s6, references: refs.stats } };
    } catch (err) {
      console.warn(`[E6] reference resolution failed (fail-open): ${err?.message ?? err}`);
    }
  }

  if (e6CommitEnabled() && e6MintEnabled() && result?.entityResolution === 'resolved' && result.claims?.length) {
    try {
      const minted = mintProvisionalEntities(result.claims, {
        ownerId, mint: (o, spec) => deps.canonicalIds.resolve(o, spec),
      });
      result.claims = minted.claims;
      result.readyForS7 = minted.readyForS7;
      result.stats = {
        ...result.stats,
        s6: { ...result.stats?.s6, ready: minted.readyForS7.length,
          minted: minted.stats.minted, reused: minted.stats.reused, refused: minted.stats.refused },
      };
    } catch (err) {
      console.warn(`[E6] entity minting failed (fail-open): ${err?.message ?? err}`);
    }
  }

  // E5/E6 bridge — deliberately opt-in. Extraction and canonical persistence
  // are separate gates so a measured-but-not-promoted extractor can be wired
  // to the real turn path without silently becoming authoritative.
  if (!e6CommitEnabled() || !result?.readyForS7?.length) return result;

  try {
    const allEntities = entityStore?.all?.() ?? [];
    // The store view speaks `kind` (idStore's vocabulary); the repository
    // reads `type`. Passed through as-is, EVERY entity reached Postgres as
    // 'concept' — the self node included, so `type='self'` (and the schema's
    // one-self-per-owner index) never matched anything and first-person
    // questions could not anchor on the user. The repository still owns the
    // allowed set and maps unknown kinds ('name', ...) to 'concept'.
    const byId = new Map(allEntities.map(e => [e.entityId ?? e.id, { ...e, type: e.type ?? e.kind ?? undefined }]));
    // One recipe, shared with the E10 reconciliation report — see
    // core/worldModel/turnSourceIdentity.js. A private copy here would let the
    // report's join and the writer's key drift apart without a test noticing.
    const sourceId = canonicalTurnSourceId(ownerId, conversationId, turn);
    const extractorVersion = process.env.AQUA_E6_EXTRACTOR_VERSION ?? 'e6-v1';
    const actor = `e6:${extractorVersion}`;

    const bySegment = new Map();
    for (const claim of result.readyForS7) {
      const range = claim.segment ?? {};
      const key = `${range.start}:${range.end}`;
      if (!bySegment.has(key)) bySegment.set(key, { start: range.start, end: range.end, claims: [] });
      const subject = byId.get(claim.resolution?.subject?.entityId) ?? {
        entityId: claim.resolution?.subject?.entityId,
        canonical: claim.subject,
        name: claim.subject,
        type: 'concept',
      };
      const object = claim.objectKind === 'entity'
        ? (byId.get(claim.resolution?.object?.entityId) ?? {
            entityId: claim.resolution?.object?.entityId,
            canonical: claim.object?.entity,
            name: claim.object?.entity,
            type: 'concept',
          })
        : null;
      bySegment.get(key).claims.push({
        ...claim,
        _canonicalSubject: subject,
        _canonicalObject: object,
      });
    }

    const commits = [];
    const s7s8s9 = [];
    for (const segment of bySegment.values()) {
      // S8 compares the incoming structured claims with persisted owner-scoped
      // history before S9. The repository supplies history only; it never
      // decides deduplication or contradiction.
      const existing = await findClaimsForDedup({ ownerId, claims: segment.claims,
        extraPredicates: segment.claims.some(isResolutionStatus) ? RESOLUTION_HISTORY_PREDICATES : [] });
      // S8 compares by KEY, and stored claims carry the entity's canonical label
      // ("You") while incoming claims carry the surface text ("I"). Measured on
      // real Postgres: the keys never matched, so history was never consulted —
      // no corroboration across turns, no contradiction, whatever the flags. The
      // incoming side is put into the stored vocabulary before comparing; the
      // mapping below this call is the same one, so it is idempotent.
      // Claim ids are assigned BEFORE S8 (2026-10-03). S8's contradictions
      // reference the incoming claim object; ids used to be minted only after
      // S8, so every `claim.contradiction.detected` event carried
      // `incomingClaimId: null` and the contradiction worker — which requires
      // both ids — threw on every one. Contradiction resolution had never run
      // on a real turn. The same id flows on to S7 and the commit plan.
      for (const c of segment.claims) c.claimId ??= crypto.randomUUID();
      const forS8 = segment.claims.map(inStoredVocabulary);
      const s8 = dedupAndDetect(forS8, existing, { functionalPredicates: singleValuedPredicates(), singleObjectPredicates: singleObjectPredicates() });

      // S7 receives canonical entity labels for deterministic relationship
      // direction. Persistence later maps those endpoints to Postgres ids; S7
      // itself never writes storage.
      const s7Claims = s8.claims.map(c => ({
        ...c,
        claimId: c.claimId ?? crypto.randomUUID(),
        subject: c._canonicalSubject?.canonical ?? c._canonicalSubject?.name ?? c.subject,
        object: c.objectKind === 'entity'
          ? { entity: c._canonicalObject?.canonical ?? c._canonicalObject?.name ?? c.object?.entity }
          : c.object,
      }));
      const s7 = resolveRelationships(s7Claims);

      // Build the inspectable S9 plan from the actual S7/S8 output. The plan
      // remains pure; the repository is the sole transaction executor.
      const plan = buildCommitPlan({
        sourceId, segmentRange: { start: segment.start, end: segment.end },
        extractorVersion, claims: s7Claims.filter(c => !c._persisted), edges: s7.edges.filter(e => !s7Claims.find(c => c.claimId === e.claimId)?._persisted),
        contradictions: s8.contradictions,
      });
      if (!plan.stats.atomicPossible) throw new Error(`S9 plan blocked: ${plan.stats.blockedTargets.join(',')}`);

      const canonicalClaims = s7Claims.map(c => ({
        ...c,
        _s7Edge: s7.edges.find(e => e.claimId === c.claimId) ?? null,
        _s8Existing: Boolean(c._persisted),
      }));
      commits.push(await commitCanonicalUnderstanding({
        ownerId, sourceId, actor, extractorVersion,
        segmentRange: { start: segment.start, end: segment.end },
        ...(doc ? {
          // L10: an uploaded document is the user's own material — file tier
          // (worldModelRepository maps trust_tier ≥ 3 to 'file').
          sourceKind: 'document', trustTier: 3,
          externalRef: `file:${doc.name}:chunk:${Number.isInteger(doc.chunk) ? doc.chunk : 0}`,
          title: `Uploaded file — ${doc.name}`,
        } : {
          sourceKind: 'conversation',
          externalRef: conversationId
            ? `${conversationId}:turn:${Number.isInteger(turn) ? turn : 'unknown'}`
            : null,
          title: `AQUIPLEX conversation${Number.isInteger(turn) ? ` — turn ${turn}` : ''}`,
        }),
        contentHash: crypto.createHash('sha256').update(userMessage).digest('hex'),
        assertedAt: saidAt,
        claims: canonicalClaims,
        evidenceAttachments: s8.evidenceAttachments,
        contradictions: s8.contradictions,
        s7Edges: s7.edges,
        s9Plan: plan,
      }));
      s7s8s9.push({ segment: { start: segment.start, end: segment.end }, s7, s8, s9: plan });
    }
    result.canonicalCommit = {
      enabled: true,
      sourceId,
      commits,
      committedClaims: commits.reduce((n, c) => n + (c.claims?.length ?? 0), 0),
      stages: s7s8s9,
    };
  } catch (error) {
    // L11: understanding is enrichment; persistence failure must never sink
    // the user's turn. The result remains available for observability.
    result.canonicalCommit = { enabled: true, committed: false, error: error?.message ?? String(error) };
  }

  return result;
}

/**
 * Predicates that hold ONE value at a time, handed to S8 so a changed employer
 * is EMITTED as a contradiction instead of two silent active claims.
 *
 * MEASURED: with this unset, "I work at Intercom" then "I work at Nummo" left
 * both claims active and raised nothing — `dedupAndDetect` only flags a
 * differing object for predicates the caller declares single-valued, and the
 * facade declared none, so the revision the whole loop exists to notice could
 * not happen.
 *
 * OPT-IN (`AQUA_E6_SINGLE_VALUED=on`), default OFF, because the cost of being
 * wrong is an accusation: two jobs, or a move mid-sentence, are legitimate and
 * the detector cannot tell them from a change. It is also EMIT-ONLY — S8 never
 * resolves, both claims stay — and validity-disjoint claims ("until 2024") are
 * already exempt upstream. There is no eval for this yet; promote it by
 * measuring false fires on real turns, not by flipping it.
 */
//
// 2026-10-04: the set is no longer a hardcoded ['works_at'] — it is DERIVED
// from the predicate registry's declared cardinality (predicateRegistry.js,
// SINGLE_PER_SUBJECT), the one place that says which facts hold one value at a
// time. Default ON, measured by eval/suites/claim-lifecycle.suite.mjs (A→B,
// A→B→C, polarity flips stay disputed, multi-valued never conflict, explicit
// correction wins, history kept). AQUA_E6_SINGLE_VALUED=off is the rollback and
// restores "emit nothing on a changed value" exactly.
export function singleValuedPredicates() {
  return String(process.env.AQUA_E6_SINGLE_VALUED ?? 'on').toLowerCase() === 'off'
    ? new Set() : new Set(singleValuedPredicateNames());
}

/** One-per-object predicates (inverse of a single-valued one), same gate. */
export function singleObjectPredicates() {
  return String(process.env.AQUA_E6_SINGLE_VALUED ?? 'on').toLowerCase() === 'off'
    ? new Set() : new Set(singleObjectPredicateNames());
}

/**
 * Follows the commit gate unless set explicitly. Minting only makes sense when
 * there is a commit for the minted id to reach; `AQUA_E6_MINT=off` is the
 * explicit rollback and restores the pre-existing behaviour exactly.
 */
export function e6MintEnabled() {
  return String(process.env.AQUA_E6_MINT ?? (e6CommitEnabled() ? 'on' : 'off')).toLowerCase() === 'on';
}

export function e6CommitEnabled() {
  // Follows AQUA_E6 unless set explicitly: once understanding is ON it should
  // reach the canonical world model by default, or the loop writes nowhere.
  // `AQUA_E6_COMMIT=off` is the explicit rollback. With AQUA_E6 off (today's
  // production state) this is still 'off' — no behaviour change until E6 is
  // deliberately promoted past its gate.
  return String(process.env.AQUA_E6_COMMIT ?? (e6Enabled() ? 'on' : 'off')).toLowerCase() === 'on';
}

/**
 * The transport E6 actually speaks through.
 *
 * 🔴 WITHOUT THIS, THE SEAM WAS WIRED AND DEAD. `runUnderstandingPipeline`
 * takes `callModel` from its caller and has NO default — its own docs say
 * "without it S3 yields nothing". The first version of `understandTurn` did not
 * pass one, so `AQUA_E6=on` produced, on every turn:
 *
 *     segments 1 · gated 1 · called 1 · errors 1 · admitted 0
 *
 * Silently, because the post-turn seam is fail-open by design. Zero claims
 * forever, indistinguishable from an extractor that simply finds nothing —
 * the exact failure `e6-shadow.mjs` refuses to publish and which was
 * reintroduced here in production.
 *
 * SAME CALL SHAPE AS THE SHADOW HARNESS, deliberately. The measured numbers —
 * strict accuracy 0.495, predicate 0.473 — describe `generateGroq` with
 * `openai/gpt-oss-120b` pinned at 1024 tokens. A production transport that
 * differs in provider, model or token budget is not the thing that was
 * measured, and the shadow result would no longer transfer.
 *
 * The model is pinned rather than left to rotate: `getCandidateModels` cycles
 * for both providers, and an unpinned run cannot attribute a change to the
 * prompt rather than to whichever model answered.
 */
/**
 * Which provider/model E6 extraction uses — the ONE resolver, shared by the
 * transport below and by eval scripts that record it (world-model-lift-live).
 * Recording a different default than the transport uses would misattribute a
 * run. Unknown providers keep the historical Groq fallback.
 *
 * nvidia (2026-10): AQUA_E6_PROVIDER=nvidia, model defaulting to NVIDIA's
 * registered model (NVIDIA_DEFAULT_MODEL → openai/gpt-oss-20b). Its token
 * budget differs from Groq's — see maxTokens in e6Transport.
 */
export async function e6TransportConfig(env = process.env) {
  const requested = String(env.AQUA_E6_PROVIDER ?? 'groq').toLowerCase();
  const provider = ['gemini', 'nvidia'].includes(requested) ? requested : 'groq';
  let defaultModel = 'openai/gpt-oss-120b';
  if (provider === 'nvidia') {
    const { pickModel } = await import('../providers/modelRegistry.js');
    defaultModel = pickModel('nvidia')?.modelId ?? 'openai/gpt-oss-20b';
  }
  const model = env.AQUA_E6_MODEL ?? defaultModel;
  return { provider, model };
}

// Test seam for the extraction MODEL only (same pattern as the embedder's
// __setEmbedderForTests): live suites drive durable jobs whose handlers call
// understandTurn without a callModel. Everything around the model stays real.
let e6TransportOverride = null;
export function __setE6TransportForTests(fn) { e6TransportOverride = typeof fn === 'function' ? fn : null; }

export async function e6Transport() {
  if (e6TransportOverride) return e6TransportOverride;
  const { provider, model } = await e6TransportConfig();
  const mod = provider === 'gemini'
    ? await import('../providers/gemini.js')
    : provider === 'nvidia'
      ? await import('../providers/nvidia.js')
      : await import('../providers/groq.js');
  const generate = provider === 'gemini' ? mod.generateGemini
    : provider === 'nvidia' ? mod.generateNvidia
      : mod.generateGroq;
  // Gemini 2.5+ spends output tokens on hidden reasoning before the answer; at
  // 1024 the JSON was cut off mid-object ("bad-json") on ordinary sentences
  // (measured 2026-10-04). NVIDIA's gpt-oss-20b does the same: at 1024 the
  // budget ran out mid-JSON or before any content; 4096 finished with
  // 1.2k-2.3k output tokens (measured 2026-10). The Groq budget — the measured
  // call shape — is unchanged.
  const maxTokens = provider === 'gemini' ? 8192 : provider === 'nvidia' ? 4096 : 1024;
  // TRUNCATION HEADROOM (P0 2026-10-12). gpt-oss-120b on Groq is a reasoning
  // model too: on a multi-clause turn ("My biggest client is now Juniper Hotel;
  // Fennel stopped ordering.") hidden reasoning used the whole 1024 and Groq
  // returned an empty truncated response, every retry, so the World Model never
  // learned the change and kept serving the old client. A call that completes
  // inside the budget is untouched (the measured call shape); only a TRUNCATED
  // one is retried once with headroom — previously it failed and dead-lettered.
  const callWithHeadroom = withTruncationHeadroom(generate, { maxTokens, headroomTokens: Math.max(maxTokens, 4096), label: provider });
  return async ({ system, user, temperature, model: perCall }) => {
    const res = await callWithHeadroom(system, [{ role: 'user', content: user }],
      { model: perCall ?? model, temperature, purpose: 'extraction' });
    return { text: res.text, model: res.model ?? null };
  };
}

/**
 * One extraction call at `maxTokens`; retried ONCE at `headroomTokens` only if
 * the provider truncated it (threw "…truncated…" or returned truncated:true).
 * Completed calls are exactly one call at the original budget.
 */
export function withTruncationHeadroom(generate, { maxTokens, headroomTokens, label = 'provider' }) {
  return async (system, messages, opts) => {
    const call = budget => generate(system, messages, undefined, budget, opts);
    let res;
    try {
      res = await call(maxTokens);
    } catch (err) {
      if (headroomTokens <= maxTokens || !/truncated/i.test(String(err?.message ?? ''))) throw err;
      console.warn(`[E6] ${label} extraction truncated at ${maxTokens} tokens (${err.message}) — retrying once at ${headroomTokens}`);
      return call(headroomTokens);
    }
    if (res?.truncated && headroomTokens > maxTokens) {
      console.warn(`[E6] ${label} extraction cut off at ${maxTokens} tokens — retrying once at ${headroomTokens}`);
      return call(headroomTokens);
    }
    return res;
  };
}

// ── Conversation ingest (B3) ─────────────────────────────────────────────────

/**
 * Feed one conversation turn into the world model — the seam that finally
 * gives conversations the same standing as files. Fail-open and gated behind
 * AQUA_BRAIN_INGEST (separately from the read-side switch), so it is inert
 * until deliberately turned on. The graph module is the only real dependency.
 *
 * Called from chat.js §9b, right after the turn is persisted.
 *
 * DEPENDENCY FORWARDING (fixed)
 * -----------------------------
 * This used to pass `{ graph: deps.graph }` only. conversationIngest also
 * reaches for `deps.pic` and `deps.ensureSelfEntity`, both via optional
 * chaining — so in production both silently resolved to undefined and did
 * nothing, while `brain/tests/picConversationSync.test.js` passed because it
 * injects `pic` directly into the module. The module was proven; the WIRING
 * was not. Same class of gap the audit called W6.
 *
 * Consequences of the gap, both now closed:
 *   • PIC was never told the resolver merged conversational surface forms,
 *     so those merges recorded no revision.
 *   • The owner's self entity was never created on ingest, leaving
 *     user-anchored conversational knowledge nothing to attach to.
 *
 * Forwarding the whole set (not a hand-picked subset) is the fix AND the
 * guard against it recurring: a dependency conversationIngest starts using
 * arrives already wired.
 */
export function observeConversationTurn(args = {}, opts = {}) {
  const { deps = REAL_DEPS } = opts;
  return guard('observeConversationTurn', { ok: false }, () =>
    ingestConversationTurn(deps, args));
}

// ── Annotations ──────────────────────────────────────────────────────────────

/**
 * Attach curated context to an entity — description, extra aliases, tags, or
 * an explicit importance/confidence override.
 *
 * This is the ONLY write the Brain makes, and it deliberately cannot hold
 * knowledge: delete `.aqua-brain.json` and every entity, relationship, fact
 * and event survives untouched in the subsystems that own them.
 */
export function annotateEntity(ownerId, entityId, patch = {}, opts = {}) {
  const { deps = REAL_DEPS } = opts;
  return guard('annotateEntity', null, () => deps.annotations.annotate(ownerId, entityId, patch));
}

export function removeAnnotation(ownerId, entityId, opts = {}) {
  const { deps = REAL_DEPS } = opts;
  return guard('removeAnnotation', false, () => deps.annotations.removeAnnotation(ownerId, entityId));
}

// ── Lifecycle + observability ────────────────────────────────────────────────

/**
 * Account deletion hook. Both Brain sidecars are ours to purge — annotations
 * and the canonical id map. The graphs, Mind and evidence store are purged by
 * their own owners.
 *
 * Neither sidecar holds knowledge, so this erases the Brain's view of an owner
 * without touching what the other stores must also delete for the erasure to
 * be complete.
 */
export function purgeOwner(ownerId, opts = {}) {
  const { deps = REAL_DEPS } = opts;
  const out = { annotations: 0, canonicalIds: 0 };
  try {
    forgetReflectionOwner(ownerId);   // drop reflection snapshot state too
    purgeFocus(ownerId);              // deictic focus memory (conversationFocus.js)
    const ann = deps.annotations.purgeOwner(ownerId);
    out.annotations = typeof ann === 'number' ? ann : (ann?.annotations ?? 0);
  } catch (err) {
    console.warn(`[BRAIN] purgeOwner (annotations) failed: ${err?.message ?? err}`);
  }
  try {
    out.canonicalIds = purgeIds(ownerId) ?? 0;
  } catch (err) {
    console.warn(`[BRAIN] purgeOwner (ids) failed: ${err?.message ?? err}`);
  }
  return out;
}
 

/** Where the owner's world came from — file side, chat side, or both. */
export function worldStats(ownerId, opts = {}) {
  const { deps = REAL_DEPS } = opts;
  return guard('worldStats', { entities: 0, fileOnly: 0, mindOnly: 0, federated: 0 },
    () => P.worldStats(deps, ownerId));
}


export async function worldStatsAsync(ownerId, opts = {}) {
  return guardAsync('worldStatsAsync', worldStats(ownerId, opts), async () => {
    if (!canonicalWorldModelReadEnabled()) return worldStats(ownerId, opts);
    return canonicalReadModel.worldStats(ownerId, opts);
  });
}

export function brainMetrics() {
  return { ...metrics, enabled: brainEnabled(), annotations: annotations.annotationStats(), ingest: ingestMetrics(), contextEngine: contextEngineMetrics(), reflectionV2: reflectionV2Metrics(), twin: twinMetrics() };
}

export { brainEnabled, ingestEnabled, factIngestEnabled, contextV2Enabled, reflectV2Enabled, twinV2Enabled };