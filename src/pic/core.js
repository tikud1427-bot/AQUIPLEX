/**
 * AQUA Persistent Intelligence Core — the facade (Phase 4)
 *
 * THE central intelligence layer. Everything connects here; nothing exists
 * in isolation:
 *
 *   fileEngine  ──►  onKnowledgeIngested()   lifecycle birth, entity-merge
 *                                            versioning, contradiction
 *                                            ledger, background consolidation
 *   chat        ──►  retrieveKnowledge()     knowledge-first retrieval —
 *                                            facts + entities + graph +
 *                                            timeline + feedback, one block
 *   chat        ──►  recordReasoningOutcome() verification → feedback loop
 *   routes      ──►  getHealth / maintain / getProjectIntelligence / metrics
 *
 * The PIC coordinates; the subsystems remain the owners:
 *   evidenceStore = facts + evidence (source of truth)   ukoStore = objects
 *   reasoningGraph = derived connections                 memory/ = memory
 *   search + embeddings = their own lanes
 * PIC state (picStore) is meta only — lifecycle, versions, feedback, ledger.
 * Delete .aqua-pic.json and AQUA degrades gracefully to Phase-3 behavior:
 * no knowledge is lost, because none lives here.
 *
 * Contracts:
 *   • FAIL-OPEN everywhere. Every public method catches; ingest and chat can
 *     never be sunk by intelligence bookkeeping. Kill switch: AQUA_PIC=off.
 *   • INCREMENTAL. Ingest schedules a debounced per-owner background
 *     consolidation (unref'd timer — never holds the process open); graphs
 *     are not rebuilt here (fileEngine already owns that), knowledge is
 *     annotated in place.
 *   • OBSERVABLE. Every operation feeds picMetrics (counts, latency EWMA,
 *     reuse, merges) — exposed via getPICMetrics() and the /intelligence
 *     routes, logged with the [PIC] prefix.
 */
import * as ES from '../files/evidenceStore.js';
import * as US from '../files/ukoStore.js';
import * as G  from '../reasoning/reasoningGraph.js';
import * as QE from '../reasoning/queryEngine.js';
import * as ER from '../files/evidenceRetrieval.js';
import { formatCitation } from '../files/evidence.js';

import { transition, advanceThrough, ingestStatesFor, getLifecycle, lifecycleStats } from './knowledgeLifecycle.js';
import { recordRevision, getHistory, confidenceTrajectory } from './versionStore.js';
import { recordReasoningSession, reasoningBoost, feedbackStats } from './reasoningFeedback.js';
import { consolidateOwner } from './consolidationEngine.js';
import { retrieveKnowledge as retrieve } from './retrievalIntelligence.js';
import { healthReport, runMaintenance } from './knowledgeHealth.js';
import { projectIntelligence } from './projectIntelligence.js';
import { ledger, getLedger, getPicStoreStats, _resetPicStoreForTests } from './picStore.js';

// ── Default dependency wiring (injectable per call for tests) ────────────────

const DEFAULT_DEPS = {
  evidenceStore: ES,
  ukoStore: US,
  graph: G,
  queryEngine: QE,
  evidenceRetrieval: ER,
  formatCitation,
};

export function picEnabled() {
  return String(process.env.AQUA_PIC ?? 'on').toLowerCase() !== 'off';
}

/**
 * Background consolidation is opt-in, subordinate to PIC.
 *
 * OFF by default like every other write-side switch in this codebase: it is
 * the first thing that MUTATES stored knowledge without a human asking —
 * merging duplicates, promoting to trusted, marking stale. Reversible (merges
 * archive rather than delete, and every change is a lifecycle transition), but
 * still a write, so it earns its own flag.
 */
export function consolidateEnabled() {
  return picEnabled() && String(process.env.AQUA_CONSOLIDATE ?? '').toLowerCase() === 'on';
}

/** Owner turns between background consolidation passes. */
export const CONSOLIDATE_EVERY_TURNS = Number(process.env.AQUA_CONSOLIDATE_EVERY) > 0
  ? Math.floor(Number(process.env.AQUA_CONSOLIDATE_EVERY))
  : 25;

// ── Observability ────────────────────────────────────────────────────────────

const metrics = {
  ingests: 0, retrievals: 0, retrievalsNonEmpty: 0,
  knowledgeItemsServed: 0, knowledgeReused: 0,
  consolidations: 0, factsMerged: 0, entitiesMerged: 0, confidenceAdjusted: 0,
  reasoningSessions: 0, maintenanceRuns: 0, failures: 0,
  latency: { ingestMs: 0, retrieveMs: 0, consolidateMs: 0 },   // EWMA, α=0.2
};
const ewma = (prev, x) => (prev === 0 ? x : Math.round((prev * 0.8 + x * 0.2) * 10) / 10);

export function getPICMetrics() {
  return { enabled: picEnabled(), ...metrics, store: getPicStoreStats() };
}

// ── Background consolidation (debounced per owner, incremental by design) ────

const CONSOLIDATE_DEBOUNCE_MS = 3000;
const pending = new Map();   // ownerId → timeout

function scheduleConsolidation(ownerId, deps) {
  if (pending.has(ownerId)) clearTimeout(pending.get(ownerId));
  const t = setTimeout(() => {
    pending.delete(ownerId);
    try {
      const report = consolidateOwner(deps, ownerId);
      metrics.consolidations += 1;
      metrics.factsMerged += report.duplicatesMerged;
      metrics.confidenceAdjusted += report.confidenceAdjusted;
      metrics.latency.consolidateMs = ewma(metrics.latency.consolidateMs, report.durationMs);
      console.log(`[PIC] Consolidated owner=${ownerId} merged=${report.duplicatesMerged} conf=${report.confidenceAdjusted} disputed=${report.disputed} stale=${report.stale} promoted=${report.promoted} in ${report.durationMs}ms`);
    } catch (err) {
      metrics.failures += 1;
      console.warn(`[PIC] Background consolidation failed (non-fatal) owner=${ownerId}: ${err.message}`);
    }
  }, CONSOLIDATE_DEBOUNCE_MS);
  t.unref?.();   // never hold the process open
  pending.set(ownerId, t);
}

// ── Ingest synchronization ───────────────────────────────────────────────────

/**
 * Called by fileEngine after a batch lands and the reasoning graph is built.
 * Registers lifecycle for every new object + fact, records entity-merge
 * revisions from the resolver's output, ledgers contradictions, schedules
 * background consolidation. Fail-open: returns { ok:false } on any error.
 *
 * @param {object} args
 * @param {string}   args.ownerId
 * @param {string[]} args.ukoIds
 * @param {Array}   [args.entities]        resolver output (canonical + aliases)
 * @param {Array}   [args.contradictions]  cross-file contradictions detected
 * @param {string}  [args.traceId]
 * @param {object}  [args.deps]
 */
/**
 * Entity resolution happened, but not from a document.
 *
 * `onKnowledgeIngested` is document-shaped: it requires `ukoIds`, walks each
 * UKO through the ingest lifecycle, and reads facts via
 * `evidenceStore.factsForFile`. A conversation turn has none of those. It
 * could be given a synthetic UKO id, but that would push conversational
 * claims through a path that treats them as document objects — the exact
 * thing conversationIngest is careful NOT to do when it keeps chat-derived
 * facts out of evidenceStore.
 *
 * So this is the narrow entry point for the part that DOES apply to a
 * conversation: the resolver merged surface forms, and that merge is a
 * revision worth recording. No lifecycle, no UKO, no evidence.
 *
 * Without it, PIC's versioning and health machinery is blind to everything
 * learned from chat — which matters most once AQUA_BRAIN_INGEST is on.
 */
export function onEntitiesResolved({ ownerId, entities = [], source = null, traceId = null } = {}) {
  if (!picEnabled() || !ownerId || !entities.length) return { ok: false, skipped: true };
  try {
    let merges = 0;
    for (const e of entities) {
      if (!e.aliases?.length) continue;
      recordRevision(ownerId, e.id, {
        kind: 'entity_merge',
        before: { surfaceForms: [e.canonical, ...e.aliases] },
        after:  { canonical: e.canonical, aliases: e.aliases },
        // Provenance names the conversation, so a merge sourced from chat is
        // never mistaken later for one a document justified.
        reason: `resolved in conversation ${source ?? 'unknown'}, confidence ${e.confidence}`,
      });
      merges += 1;
    }
    if (!merges) return { ok: true, entityMerges: 0 };

    metrics.entitiesMerged += merges;
    ledger(ownerId, 'conversation-entities-resolved', { entities: entities.length, entityMerges: merges, source, traceId });
    return { ok: true, entityMerges: merges };
  } catch (err) {
    console.warn(`[PIC] onEntitiesResolved failed (non-fatal): ${err?.message ?? err}`);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Give conversationally-derived facts lifecycle standing.
 *
 * WHY A SECOND NARROW ENTRY POINT
 * -------------------------------
 * Same reasoning as `onEntitiesResolved` above: `onKnowledgeIngested` is
 * document-shaped (needs ukoIds, walks UKO stages, reads `factsForFile`), and
 * routing a turn through it would make a conversation pretend to be a
 * document. This is the part that genuinely applies — the facts exist and they
 * are linked into the graph — and nothing more.
 *
 * WHICH STATES, AND WHY NOT THE DOCUMENT SET
 * ------------------------------------------
 * Documents walk created → parsed → enriched → verified → linked. A turn earns
 * exactly two of those:
 *
 *   created  the fact exists.
 *   linked   `about` edges to entities and `asserts` from the conversation node
 *            were actually written — this is a claim about work performed.
 *
 * NOT `parsed` or `enriched`: no parser and no enrichment pipeline ran, and
 * asserting a processing stage that did not happen is the same lie as faking
 * provenance. NOT `verified` — that state means evidence-grounded, and the
 * entire reason conversational confidence is capped is that it is not. A chat
 * claim reaches `verified` only through consolidation, by being corroborated
 * by an independent source and repeatedly retrieved. That promotion path stays
 * open; it is simply not granted at birth.
 *
 * WHAT THIS UNLOCKS (deliberately modest)
 * ---------------------------------------
 * Retrieval already auto-creates a lifecycle record on first hit, so this is
 * not the difference between "tracked" and "untracked". It is the difference
 * between a truthful history and one that skips straight to `retrieved`,
 * silently omitting the linking that happened. Concretely: staleness is
 * measured from when the claim was learned rather than when it was first read
 * back, `lifecycleStats` and `subjectsInState('linked')` stop under-reporting
 * the conversational corpus, and the promotion preconditions are evaluated
 * against a record that reflects reality.
 *
 * Fail-open. Bookkeeping must never cost a turn.
 */
export function onConversationFactsWritten({ ownerId, factIds = [], source = null, traceId = null } = {}) {
  if (!picEnabled() || !ownerId || !factIds.length) return { ok: false, skipped: true };
  try {
    for (const factId of factIds) {
      advanceThrough(ownerId, `fact:${factId}`, ['created', 'linked'], {
        reason: `stated in conversation ${source ?? 'unknown'}`,
      });
    }
    ledger(ownerId, 'conversation-facts-written', { facts: factIds.length, source, traceId });
    return { ok: true, facts: factIds.length };
  } catch (err) {
    console.warn(`[PIC] onConversationFactsWritten failed (non-fatal): ${err?.message ?? err}`);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export function onKnowledgeIngested({ ownerId, ukoIds = [], entities = [], contradictions = [], traceId = null, deps = {} } = {}) {
  if (!picEnabled() || !ownerId || !ukoIds.length) return { ok: false, skipped: true };
  const d = { ...DEFAULT_DEPS, ...deps };
  const started = Date.now();
  try {
    let subjects = 0;

    // Lifecycle: every ingested object walks created → … → linked.
    for (const ukoId of ukoIds) {
      const uko = d.ukoStore.getUKO(ownerId, ukoId);
      const states = uko ? ingestStatesFor(uko) : ['created', 'parsed', 'enriched'];
      advanceThrough(ownerId, `uko:${ukoId}`, [...states, 'linked'], { reason: 'ingest' });
      subjects += 1;
      for (const fact of d.evidenceStore.factsForFile(ownerId, ukoId)) {
        advanceThrough(ownerId, `fact:${fact.id}`, ['created', 'parsed', 'enriched', 'verified', 'linked'], { reason: 'ingest' });
        subjects += 1;
      }
    }

    // Versioning: entity merges the resolver performed this build.
    let merges = 0;
    for (const e of entities) {
      if (!e.aliases?.length) continue;
      recordRevision(ownerId, e.id, {
        kind: 'entity_merge',
        before: { surfaceForms: [e.canonical, ...e.aliases] },
        after:  { canonical: e.canonical, aliases: e.aliases },
        reason: `resolved across ${e.files?.size ?? e.mentions?.length ?? 0} file(s), confidence ${e.confidence}`,
      });
      merges += 1;
    }
    metrics.entitiesMerged += merges;

    if (contradictions.length) {
      ledger(ownerId, 'contradictions-detected', { count: contradictions.length, traceId });
    }
    ledger(ownerId, 'ingest', { ukos: ukoIds.length, subjects, entityMerges: merges, traceId });

    scheduleConsolidation(ownerId, d);

    metrics.ingests += 1;
    const durationMs = Date.now() - started;
    metrics.latency.ingestMs = ewma(metrics.latency.ingestMs, durationMs);
    console.log(`[PIC] Ingest synced owner=${ownerId} objects=${ukoIds.length} subjects=${subjects} entityMerges=${merges} in ${durationMs}ms`);
    return { ok: true, subjects, entityMerges: merges, durationMs };
  } catch (err) {
    metrics.failures += 1;
    console.warn(`[PIC] onKnowledgeIngested failed (non-fatal): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── Knowledge-first retrieval ────────────────────────────────────────────────

/**
 * The one retrieval call chat (and any future consumer) makes. Fail-open:
 * an empty result is always safe to inject (empty block = byte-identical
 * prompt to pre-PIC behavior).
 */
export function retrieveKnowledge(ownerId, query, opts = {}) {
  const empty = { items: [], block: '', stats: {} };
  if (!picEnabled() || !ownerId) return empty;
  try {
    const d = { ...DEFAULT_DEPS, ...(opts.deps ?? {}) };
    const out = retrieve(d, ownerId, query, opts);
    metrics.retrievals += 1;
    if (out.items.length) metrics.retrievalsNonEmpty += 1;
    metrics.knowledgeItemsServed += out.items.length;
    metrics.knowledgeReused += out.stats.reusedSignals ?? 0;
    metrics.latency.retrieveMs = ewma(metrics.latency.retrieveMs, out.stats.durationMs ?? 0);
    return out;
  } catch (err) {
    metrics.failures += 1;
    console.warn(`[PIC] retrieveKnowledge failed (non-fatal): ${err.message}`);
    return empty;
  }
}

// ── Reasoning feedback ───────────────────────────────────────────────────────

export function recordReasoningOutcome(ownerId, session) {
  if (!picEnabled() || !ownerId) return null;
  try {
    const entry = recordReasoningSession(ownerId, session);
    if (entry) {
      metrics.reasoningSessions += 1;
      for (const factId of entry.usedFacts) {
        transition(ownerId, `fact:${factId}`, 'reasoned', { reason: `outcome:${entry.outcome}` });
      }
    }
    return entry;
  } catch (err) {
    metrics.failures += 1;
    console.warn(`[PIC] recordReasoningOutcome failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ── Health / maintenance / project intelligence ──────────────────────────────

export function getHealth(ownerId, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  return healthReport(d, ownerId);
}

/**
 * Consolidation on a cadence — the maturation half of the loop.
 *
 * WHY THIS EXISTS ALONGSIDE `maintain()`
 * --------------------------------------
 * `maintain()` is dashboard-shaped: it brackets consolidation with a health
 * report before and after and returns a ledger dump, because a human is
 * looking at the response. Its only caller is the manual
 * `POST /intelligence/maintain` endpoint.
 *
 * That meant consolidation had exactly one trigger: someone remembering to
 * curl it. So knowledge accumulated and never matured — duplicates were never
 * merged, corroborated claims were never promoted to trusted, and nothing ever
 * went stale. The audit called this M6.
 *
 * This entry point is the background one: consolidation only, no health
 * reports, no payload. `consolidateOwner` already writes its own ledger entry,
 * so observability is unchanged.
 *
 * SAFE TO RE-RUN, WHICH IS WHAT MAKES THE CADENCE CHEAP
 * -----------------------------------------------------
 * Measured: a first pass over 300 facts merged 250 duplicates; the second and
 * third passes merged 0 and left the store identical. Because re-running is a
 * no-op, the caller's cadence watermark does not need to be durable — losing
 * it on redeploy costs one extra pass, not correctness.
 */
export function consolidate(ownerId, opts = {}) {
  if (!picEnabled() || !ownerId) return { ok: false, skipped: true };
  try {
    const d = { ...DEFAULT_DEPS, ...(opts.deps ?? {}) };
    const report = consolidateOwner(d, ownerId);
    metrics.maintenanceRuns += 1;
    return { ok: true, ...report };
  } catch (err) {
    console.warn(`[PIC] consolidate failed (non-fatal): ${err?.message ?? err}`);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export function maintain(ownerId, opts = {}) {
  const d = { ...DEFAULT_DEPS, ...(opts.deps ?? {}) };
  metrics.maintenanceRuns += 1;
  return runMaintenance(d, ownerId, opts);
}

export function getProjectIntelligence(ownerId, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  return projectIntelligence(d, ownerId);
}

// ── File Intelligence 2.0 (forensics + research + causal) ────────────────────
// Same contract as every facade method: consumers call the PIC, deps are
// injectable, AQUA_PIC=off silences everything, failures return a neutral
// value — file intelligence can never sink a route.

import { forensicReport, fileForensics } from '../files/forensicEngine.js';
import * as researchEngine from '../reasoning/researchEngine.js';

export function getForensics(ownerId, { ukoId = null, deps = {} } = {}) {
  if (!picEnabled() || !ownerId) return null;
  try {
    const d = { ...DEFAULT_DEPS, ...deps };
    return ukoId ? fileForensics(d, ownerId, ukoId) : forensicReport(d, ownerId);
  } catch (err) {
    metrics.failures += 1;
    console.warn('[PIC] forensics failed (non-fatal):', err.message);
    return null;
  }
}

export function getResearch(ownerId, { mode = 'consensus', deps = {}, ...opts } = {}) {
  if (!picEnabled() || !ownerId) return null;
  try {
    const d = { ...DEFAULT_DEPS, ...deps };
    switch (mode) {
      case 'hypotheses': return researchEngine.hypothesisCandidates(d, ownerId, opts);
      case 'gaps':       return researchEngine.researchGaps(d, ownerId, opts);
      case 'overview':   return researchEngine.literatureOverview(d, ownerId, opts);
      case 'consensus':
      default:           return researchEngine.consensusReport(d, ownerId, opts);
    }
  } catch (err) {
    metrics.failures += 1;
    console.warn('[PIC] research failed (non-fatal):', err.message);
    return null;
  }
}

export function compareKnowledgeFiles(ownerId, ukoIdA, ukoIdB, deps = {}) {
  if (!picEnabled() || !ownerId || !ukoIdA || !ukoIdB) return null;
  try {
    const d = { ...DEFAULT_DEPS, ...deps };
    return researchEngine.compareFiles(d, ownerId, ukoIdA, ukoIdB);
  } catch (err) {
    metrics.failures += 1;
    console.warn('[PIC] compare failed (non-fatal):', err.message);
    return null;
  }
}

export function whatCaused(ownerId, effectQuery, deps = {}) {
  if (!picEnabled() || !ownerId || !effectQuery) return null;
  try {
    const d = { ...DEFAULT_DEPS, ...deps };
    return d.queryEngine.whatCausedThis(d.evidenceStore, ownerId, effectQuery);
  } catch (err) {
    metrics.failures += 1;
    console.warn('[PIC] causal query failed (non-fatal):', err.message);
    return null;
  }
}

// ── Pass-through inspection surface (routes + tests) ─────────────────────────

export { getLifecycle, lifecycleStats, getHistory, confidenceTrajectory, reasoningBoost, feedbackStats, getLedger };

export function _resetPICForTests() {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  _resetPicStoreForTests();
  for (const k of Object.keys(metrics)) {
    if (typeof metrics[k] === 'number') metrics[k] = 0;
  }
  metrics.latency = { ingestMs: 0, retrieveMs: 0, consolidateMs: 0 };
}