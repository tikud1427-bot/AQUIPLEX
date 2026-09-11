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
import * as graph from '../reasoning/reasoningGraph.js';
import * as evidenceStore from '../files/evidenceStore.js';
import { peekMind } from '../mind/mindStore.js';
import * as annotations from './worldModel/annotationStore.js';
import * as P from './worldModel/projection.js';
import { ingestConversationTurn, ingestMetrics, ingestEnabled, factIngestEnabled } from './knowledgeExtraction/conversationIngest.js';
import { assembleTurnContext, contextEngineMetrics, contextV2Enabled } from './contextEngine/index.js';
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
import { commitUnderstanding as commitCanonicalUnderstanding } from '../core/worldModel/worldModelRepository.js';

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
const REAL_DEPS = { graph, peekMind, evidenceStore, annotations, getMind, observeSignals, canonicalIds, pic, ensureSelfEntity, entityStoreFor, selfEntityIdFor };

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
  return brainEnabled() && String(process.env.AQUA_REVISION_VOICE ?? '').toLowerCase() === 'on';
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
  if (!ownerId || !revisionVoiceEnabled()) return '';
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
  const { deps = REAL_DEPS, semanticScores = null, activeProjectId = null, priorEntityIds = null, limit = 8, charBudget = 1600, plan = null } = opts;
  const engineDeps = {
    picRetrieve: floorRetrieve,
    graph: deps.graph,
    evidenceStore: deps.evidenceStore,
    peekMind: deps.peekMind,
    formatCitation: opts.formatCitation ?? null,
    semanticScores,
    activeProjectId,
  };
  return guard('assembleContext',
    { items: [], block: '', stats: {} },
    () => assembleTurnContext(engineDeps, ownerId, query, { limit, charBudget, priorEntityIds: priorEntityIds ?? undefined, plan }));
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
  { ownerId, conversationId, turn = null, userMessage, callModel = null } = {},
  { deps = REAL_DEPS } = {},
) {
  if (!e6Enabled()) return null;
  if (!ownerId || !userMessage) return null;
  const { runUnderstandingPipeline } = await import('./understanding/pipeline.js');

  // Fail-open enrichment (L11): a store view that cannot be built leaves S6
  // unrun and S0–S5 untouched — byte-identical to the behaviour before this
  // change. Resolution is a bonus on top of extraction, never a precondition.
  let entityStore = null;
  let selfEntityId = null;
  try {
    entityStore = deps.entityStoreFor?.(ownerId) ?? null;
    selfEntityId = deps.selfEntityIdFor?.(ownerId) ?? null;
  } catch (err) {
    console.warn(`[E6] entity store unavailable (fail-open): ${err?.message ?? err}`);
    entityStore = null;
    selfEntityId = null;
  }

  const result = await runUnderstandingPipeline(userMessage, {
    ownerId, conversationId, callModel: callModel ?? (await e6Transport()),
    entityStore, selfEntityId,
  });

  // E5/E6 bridge — deliberately opt-in. Extraction and canonical persistence
  // are separate gates so a measured-but-not-promoted extractor can be wired
  // to the real turn path without silently becoming authoritative.
  if (!e6CommitEnabled() || !result?.readyForS7?.length) return result;

  try {
    const allEntities = entityStore?.all?.() ?? [];
    const byId = new Map(allEntities.map(e => [e.entityId ?? e.id, e]));
    const sourceId = deterministicUuid(
      `conversation-turn:${ownerId}:${conversationId ?? 'unknown'}:${Number.isInteger(turn) ? turn : 'unknown'}`
    );
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
    for (const segment of bySegment.values()) {
      const canonicalClaims = segment.claims.map(c => ({
        ...c,
        subjectEntityId: null,
        objectEntityId: null,
      }));
      commits.push(await commitCanonicalUnderstanding({
        ownerId, sourceId, actor, extractorVersion,
        segmentRange: { start: segment.start, end: segment.end },
        sourceKind: 'conversation',
        externalRef: conversationId
          ? `${conversationId}:turn:${Number.isInteger(turn) ? turn : 'unknown'}`
          : null,
        title: `AQUIPLEX conversation${Number.isInteger(turn) ? ` — turn ${turn}` : ''}`, 
        contentHash: crypto.createHash('sha256').update(userMessage).digest('hex'),
        assertedAt: new Date(),
        claims: canonicalClaims,
      }));
    }
    result.canonicalCommit = {
      enabled: true,
      sourceId,
      commits,
      committedClaims: commits.reduce((n, c) => n + (c.claims?.length ?? 0), 0),
    };
  } catch (error) {
    // L11: understanding is enrichment; persistence failure must never sink
    // the user's turn. The result remains available for observability.
    result.canonicalCommit = { enabled: true, committed: false, error: error?.message ?? String(error) };
  }

  return result;
}

export function e6CommitEnabled() {
  return String(process.env.AQUA_E6_COMMIT ?? 'off').toLowerCase() === 'on';
}

function deterministicUuid(seed) {
  const bytes = crypto.createHash('sha256').update(String(seed)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
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
export async function e6Transport() {
  const provider = String(process.env.AQUA_E6_PROVIDER ?? 'groq').toLowerCase();
  const model = process.env.AQUA_E6_MODEL ?? 'openai/gpt-oss-120b';
  const mod = provider === 'gemini'
    ? await import('../providers/gemini.js')
    : await import('../providers/groq.js');
  const generate = provider === 'gemini' ? mod.generateGemini : mod.generateGroq;
  return async ({ system, user, temperature, model: perCall }) => {
    const res = await generate(system, [{ role: 'user', content: user }], undefined, 1024,
      { model: perCall ?? model, temperature });
    return { text: res.text, model: res.model ?? null };
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

export function brainMetrics() {
  return { ...metrics, enabled: brainEnabled(), annotations: annotations.annotationStats(), ingest: ingestMetrics(), contextEngine: contextEngineMetrics(), reflectionV2: reflectionV2Metrics(), twin: twinMetrics() };
}

export { brainEnabled, ingestEnabled, factIngestEnabled, contextV2Enabled, reflectV2Enabled, twinV2Enabled };