/**
 * AQUA Brain Routes — World Model API (Phase 0)
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Brain V1 (B1–B7) built a unified world model, a federated timeline with
 * lifecycle chains, and an inferred Digital Twin — and then exposed none of
 * it. Before this file, `src/brain/index.js` had exactly two importers:
 * `account/accountPurge.js` (erasure) and `routes/chat.js` (four dark seams).
 * Zero routes. So `listEntities`, `describeEntity`, `getTimeline`,
 * `getChains`, `getTwin` and `worldStats` were built, tested and
 * unreachable: the frontend could not render understanding it could not
 * fetch, and no operator could see what AQUA actually understood.
 *
 * This is the read surface. Nothing else changes.
 *
 * CONTRACTS
 * ---------
 *   READ-ONLY   Every endpoint here is a GET. The Brain's one write
 *               (annotateEntity) is deliberately NOT exposed — Phase 0 is a
 *               visibility phase, and a mutation would need its own
 *               authorization story.
 *   OWNER-SCOPED  Same resolveOwner contract as /memory and /intelligence:
 *               platform session → `user:<id>`, else ?conversationId
 *               fallback, else 400. An owner never sees another's world.
 *   FAIL-OPEN   The Brain facade already guarantees no method throws (see
 *               brain/index.js:guard). Routes still wrap, so a future
 *               non-guarded addition cannot 500 the panel.
 *   NO NEW STATE  This file adds no store, no cache, no background work.
 *
 * FLAG BEHAVIOUR — read this before the Phase 0 rollout
 * -----------------------------------------------------
 * These routes work TODAY, before any flag flips, because the reasoning
 * graph is already populated by the file pipeline (fileEngine → graphBuilder)
 * independently of AQUA_BRAIN_INGEST. So an owner who has uploaded documents
 * already has a world model to inspect. What AQUA_BRAIN_INGEST adds is the
 * conversation side of it.
 *
 * Every response therefore carries `flags`, and empty results carry a `hint`
 * naming the flag most likely responsible. That is what makes the staged
 * rollout verifiable rather than hopeful.
 *
 *   GET /brain/metrics            counters + latency + flag state (no owner)
 *   GET /brain/stats              world size + federation yield
 *   GET /brain/entities           entity list, or ?q= search
 *   GET /brain/entity?id=<id>     one entity + relationships/observations/events
 *   GET /brain/entity/:id         same, for ids safe in a path segment
 *   GET /brain/timeline           unified events + chains + stats
 *   GET /brain/chains             lifecycle chains alone
 *   GET /brain/twin               inferred patterns w/ confidence + evidence
 *   GET /brain/welcome            the home screen's one-line reading of your world
 *
 * Mounted at /api/aqua/brain by aqua/router.js.
 */
import express from 'express';
import { resolveOwner } from '../memory/engine.js';
import { getLedger } from '../pic/picStore.js';
import * as Brain from '../brain/index.js';
import { selfEntityEnabled } from '../brain/identity/selfEntity.js';
import { flagReport } from '../core/flags.js';
import { ErrorCodes } from './envelope.js';
import { getRevisionFeed } from '../brain/reflectionV3/revisionFeed.js';
import { claimWithEvidence, correctClaim, readHistory } from '../core/worldModel/worldModelRepository.js';
import * as Proactive from '../brain/proactive/index.js';
import * as Welcome from '../brain/welcome/index.js';
import { selectWelcome } from '../brain/welcome/selector.js';
import * as ActionRuns from '../brain/actions/repository.js';
import * as ActionExecutor from '../brain/actions/executor.js';
import { reexplanationStats, learningStats } from '../core/worldModel/canonicalReadModel.js';
import { isConfigured as dbConfigured } from '../core/db/pool.js';

const router = express.Router();

// ── Shared helpers ───────────────────────────────────────────────────────────

function ownerOf(req) {
  return resolveOwner({
    userId: req.aquaUserId ?? null,
    conversationId: req.query.conversationId ?? null,
  });
}

function requireOwner(req, res) {
  const ownerId = ownerOf(req);
  if (!ownerId) {
    res.status(400).json({
      success: false,
      code: ErrorCodes.BAD_REQUEST,
      error: 'No owner (no session and no ?conversationId)',
    });
    return null;
  }
  return ownerId;
}

/** Bounded integer query param. Rejects NaN, clamps to [min,max]. */
function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Bounded float query param, for the 0..1 scores the world model derives. */
function clampFloat(raw, def, min, max) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function boolParam(raw) {
  const s = String(raw ?? '').toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * The lifecycle vocabulary as an ORDERED array.
 *
 * chainBuilder holds LIFECYCLE_STAGES as an object keyed by stage name, with
 * sparse `order` values so new stages can be inserted without renumbering.
 * Serialising that object directly would leave a UI's stage ordering
 * dependent on JS object key order — correct today by accident, wrong the
 * first time a stage is inserted rather than appended. Sorting on the
 * declared `order` makes the contract explicit.
 */
function orderedStages() {
  return Object.entries(Brain.LIFECYCLE_STAGES)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([stage, meta]) => ({ stage, ...meta }));
}

/**
 * The live state of every Brain flag, on every response.
 *
 * Phase 0 turns four flags on one at a time; without this, "did it take
 * effect?" is answered by reading Render's env panel and guessing. With it,
 * the answer is in the payload the frontend already has.
 */
function flagState() {
  const registered = Object.fromEntries(flagReport().map(f => [f.name, f.value === 'on' || f.value === 'shadow']));
  return {
    AQUA_BRAIN: Brain.brainEnabled(),
    AQUA_BRAIN_INGEST: Brain.ingestEnabled(),
    AQUA_BRAIN_INGEST_FACTS: Brain.factIngestEnabled(),
    AQUA_CONTEXT_V2: Brain.contextV2Enabled(),
    AQUA_TWIN_V2: Brain.twinV2Enabled(),
    AQUA_REFLECT_V2: Brain.reflectV2Enabled(),
    // Phase 3: the sixth switch. It gated a call that was dead anyway until
    // the deps-forwarding fix, so nothing reported it. Now that it can take
    // effect, it has to be visible here too.
    AQUA_SELF_ENTITY: selfEntityEnabled(),
    AQUA_CANONICAL_READ: Brain.canonicalWorldModelReadEnabled(),
    // The eighth switch. Every other flag here changes what AQUA KNOWS or does
    // silently; this one changes what it SAYS, unprompted. That is the one most
    // worth being able to read off a running instance.
    AQUA_REVISION_VOICE: Brain.revisionVoiceEnabled(),
    // L13: expose every registered gate, not only the historical Brain subset.
    // Existing keys remain booleans for frontend compatibility.
    ...registered,
  };
}

/**
 * Why is this empty? Answered once, here, rather than in five handlers.
 *
 * Deliberately ordered most-likely-cause first: the master switch beats the
 * subordinate flag, and a disabled flag beats "you have no data yet" —
 * because a disabled flag is a configuration answer and an empty world is a
 * usage answer, and confusing the two wastes a rollout day.
 */
function emptyHint(kind) {
  if (!Brain.brainEnabled()) {
    return 'AQUA_BRAIN=off — the world model is disabled entirely. Unset it (or set anything other than "off") to enable.';
  }
  if (kind === 'twin' && !Brain.twinV2Enabled()) {
    return 'AQUA_TWIN_V2 is off, so no turns have been observed for style inference. Set AQUA_TWIN_V2=on and hold a few conversations.';
  }
  if (!Brain.ingestEnabled()) {
    return 'AQUA_BRAIN_INGEST is off, so conversations do not enter the world model. File uploads still do. Set AQUA_BRAIN_INGEST=on to include chat.';
  }
  if (kind === 'changes') {
    // The generic hint below would misdiagnose this one. An owner can have a
    // full world model and still no revisions: nothing has CHANGED yet. Saying
    // "the world model fills from uploaded files" would send someone off to
    // fix a pipeline that is working.
    return 'No revisions yet. AQUA records a change only when its understanding actually shifts, and it reflects every few turns rather than on each one.';
  }
  return 'No data yet for this owner — the world model fills from uploaded files and (with ingest on) conversation turns.';
}

/** One response envelope, so every endpoint is shaped alike. */
function ok(res, ownerId, payload, { empty = false, kind = null } = {}) {
  const body = { success: true, ownerId, flags: flagState(), ...payload };
  if (empty) body.hint = emptyHint(kind);
  res.json(body);
}

/** Routes cannot throw today (the facade guards), but must not start to. */
function guarded(handler) {
  return (req, res) => {
    try {
      const result = handler(req, res);
      if (result && typeof result.then === 'function') {
        result.catch(err => {
          console.error(`[BRAIN_API] ${req.method} ${req.path} failed:`, err?.stack ?? err?.message ?? err);
          if (!res.headersSent) {
            res.status(500).json({ success: false, code: ErrorCodes.INTERNAL, error: err?.message ?? 'Internal error' });
          }
        });
      }
    } catch (err) {
      console.error(`[BRAIN_API] ${req.method} ${req.path} failed:`, err?.stack ?? err?.message ?? err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, code: ErrorCodes.INTERNAL, error: err?.message ?? 'Internal error' });
      }
    }
  };
}

// ── Observability ────────────────────────────────────────────────────────────

/**
 * Counters, latency EWMAs and flag state. No owner required — these are
 * process-wide, same contract as /intelligence/metrics.
 *
 * This is THE endpoint for the Phase 0 rollout: after flipping a flag,
 * `metrics.ingest.conversationsSeen` climbing is the proof it took.
 */
router.get('/metrics', guarded((_req, res) => {
  res.json({
    success: true,
    enabled: Brain.brainEnabled(),
    flags: flagState(),
    metrics: Brain.brainMetrics(),
  });
}));

/**
 * World size + the federation's actual yield.
 *
 * `federated` is the number worth watching: entities present in BOTH the
 * file-derived graph and the conversation-derived Mind. Before
 * AQUA_BRAIN_INGEST it counts documents corroborated by the Mind's own chat
 * graph; after, it should climb as chat and documents land on one node.
 */
router.get('/stats', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const stats = await Brain.worldStatsAsync(ownerId);
  ok(res, ownerId, { stats }, { empty: stats.entities === 0 });
}));

// ── Entities ─────────────────────────────────────────────────────────────────

/**
 * The owner's world, most important first.
 *
 *   ?q=<text>          search by name or alias instead of listing
 *   ?limit=            1..200        (default 50)
 *   ?type=             person | organization | project | goal | technology | …
 *   ?minImportance=    0..1          (default 0)
 *
 * Importance is derived, never stored (brain/worldModel/schema.js), so
 * filtering on it is always consistent with what the detail view shows.
 */
router.get('/entities', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const q = String(req.query.q ?? '').trim().slice(0, 200);
  const limit = clampInt(req.query.limit, 50, 1, 200);

  const entities = q
    ? await Brain.findEntitiesAsync(ownerId, q, { limit })
    : await Brain.listEntitiesAsync(ownerId, {
        limit,
        type: req.query.type ? String(req.query.type).slice(0, 40) : null,
        minImportance: clampFloat(req.query.minImportance, 0, 0, 1),
      });

  ok(res, ownerId, { query: q || null, count: entities.length, entities },
    { empty: entities.length === 0 });
}));

/**
 * Everything AQUA knows about one thing: the entity plus its relationships,
 * grounded observations and events, from both graphs in one join.
 *
 * Two spellings, one handler. The query form is canonical because entity ids
 * are not guaranteed path-safe: file-side ids normalize cleanly
 * (`ent:name:priya_sharma`), but Mind-side ids are built from the raw label
 * (`mind:technology:ai/ml`) and can contain a slash. The path form stays for
 * the common case and for readable logs.
 */
async function entityDetail(req, res) {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const id = String(req.params.id ?? req.query.id ?? '').trim();
  if (!id) {
    return res.status(400).json({ success: false, code: ErrorCodes.BAD_REQUEST, error: 'id is required (?id=<entityId>)' });
  }

  const detail = await Brain.describeEntityAsync(ownerId, id, {
    relationships: clampInt(req.query.relationships, 20, 1, 100),
    observations: clampInt(req.query.observations, 15, 1, 100),
    events: clampInt(req.query.events, 15, 1, 100),
  });

  if (!detail) {
    return res.status(404).json({
      success: false,
      code: ErrorCodes.NOT_FOUND,
      error: `Unknown entity: ${id}`,
      flags: flagState(),
    });
  }
  ok(res, ownerId, detail);
}

router.get('/entity', guarded(entityDetail));
router.get('/entity/:id', guarded(entityDetail));

// ── Canonical claims + correction surface (E5/L6/L20) ────────────────────────

function claimApi(claim) {
  if (!claim) return null;
  return {
    ...claim,
    ref: `/brain/claims/${encodeURIComponent(String(claim.claimId))}`,
    confidence: {
      extraction: claim.confidenceExtraction,
      corroboration: claim.confidenceCorroboration,
      source: null,
      recency: null,
      consistency: null,
    },
  };
}

router.get('/claims/:id', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  if (!dbConfigured()) return res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: 'Canonical world model is not configured' });
  const id = String(req.params.id ?? '').trim();
  const claim = await claimWithEvidence(ownerId, id);
  if (!claim) return res.status(404).json({ success: false, code: ErrorCodes.NOT_FOUND, error: 'Claim not found', flags: flagState() });
  ok(res, ownerId, { claim: claimApi(claim) });
}));

// Re-explanation rate (Blueprint §2.10) for THIS owner, derived from the
// canonical World Model. The product promise is a falling weekly series.
router.get('/reexplanation', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  if (!dbConfigured()) return res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: 'Canonical world model is not configured' });
  const sinceDays = clampInt(req.query.days, 90, 1, 366);
  ok(res, ownerId, { reexplanation: await reexplanationStats(ownerId, { sinceDays }) });
}));

// Phase 3 learning metrics: corrections, correction latency, repeated errors,
// re-explanation — derived from the canonical tables for THIS owner.
router.get('/learning', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  if (!dbConfigured()) return res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: 'Canonical world model is not configured' });
  ok(res, ownerId, { learning: await learningStats(ownerId, { sinceDays: clampInt(req.query.days, 90, 1, 366) }) });
}));

router.get('/claims/:id/history', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  if (!dbConfigured()) return res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: 'Canonical world model is not configured' });
  const id = String(req.params.id ?? '').trim();
  const history = await readHistory({ ownerId, targetKind: 'claim', targetId: id });
  ok(res, ownerId, { ref: `/brain/claims/${encodeURIComponent(id)}`, history });
}));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validUuid = v => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null);

router.post('/claims/:id/correct', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  if (!dbConfigured()) return res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: 'Canonical world model is not configured' });
  const id = String(req.params.id ?? '').trim();
  const statementText = String(req.body?.statementText ?? '').trim();
  if (!statementText) return res.status(400).json({ success: false, code: ErrorCodes.BAD_REQUEST, error: 'statementText is required', flags: flagState() });
  try {
    const result = await correctClaim({
      ownerId,
      actor: 'user',
      claimId: id,
      statementText: statementText.slice(0, 20_000),
      object: req.body?.object ?? null,
      polarity: req.body?.polarity,
      modality: req.body?.modality,
      validFrom: req.body?.validFrom,
      validTo: req.body?.validTo,
      oldValidTo: req.body?.oldValidTo,
      timePrecision: req.body?.timePrecision,
      reason: String(req.body?.reason ?? 'user-correction').slice(0, 500),
      // Client retry/double-submit key (header or body) → idempotent replay.
      correctionId: validUuid(req.get?.('Idempotency-Key') ?? req.body?.correctionId) ?? undefined,
    });
    const claim = await claimWithEvidence(ownerId, result.claimId);
    ok(res, ownerId, {
      correction: result,
      claim: claimApi(claim),
      replaced: `/brain/claims/${encodeURIComponent(id)}`,
    });
  } catch (error) {
    if (/already superseded/i.test(String(error?.message ?? ''))) {
      return res.status(409).json({ success: false, code: 'CLAIM_ALREADY_SUPERSEDED', error: error.message, flags: flagState() });
    }
    const status = /not found|cannot be corrected|object must contain|not belong/i.test(String(error?.message ?? '')) ? 400 : 500;
    return res.status(status).json({ success: false, code: status === 400 ? ErrorCodes.BAD_REQUEST : ErrorCodes.INTERNAL, error: error?.message ?? 'Correction failed', flags: flagState() });
  }
}));

// ── What Aqua holds NOW, with where it learned it (2026-10-16) ───────────────
// The Memory page listed the legacy fact store while, with Postgres, answers
// come from canonical claims — so the screen promising "see what it knows and
// delete it" showed a different store from the one answering. This is the
// store that answers: current claims only, each with the sentence it was
// learned from, the source kind and when it was said.
function currentItem(c) {
  const quote = (c.evidence ?? []).map(e => e?.quote).find(q => typeof q === 'string' && q.trim()) ?? null;
  const loc = (c.evidence ?? []).map(e => e?.locator).find(Boolean) ?? null;
  const validFrom = c.validFrom ? new Date(c.validFrom) : null;
  return {
    claimId: c.claimId,
    statement: c.statementText ?? c.statement ?? '',
    quote,
    sourceKind: c.sourceKind ?? 'conversation',
    sourceName: loc && typeof loc === 'object' ? (loc.name ?? loc.file ?? loc.fileName ?? null) : null,
    assertedAt: c.assertedAt ?? null,
    disputed: c.state === 'disputed',
    scheduledFrom: validFrom && validFrom.getTime() > Date.now() ? validFrom.toISOString() : null,
  };
}

router.get('/current', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  if (!dbConfigured()) return ok(res, ownerId, { configured: false, claims: [] }, { empty: true, kind: 'current' });
  const { currentWorld } = await import('../core/worldModel/canonicalReadModel.js');
  const rows = await currentWorld(ownerId, { limit: clampInt(req.query.limit, 120, 1, 160) });
  const claims = rows.filter(c => c.predicate !== 'unresolved').map(currentItem);
  ok(res, ownerId, { configured: true, claims }, { empty: claims.length === 0, kind: 'current' });
}));

router.post('/claims/:id/forget', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  if (!dbConfigured()) return res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: 'Canonical world model is not configured' });
  const { forgetClaim, MemoryControlUnavailable } = await import('../memory/forget.js');
  try {
    const out = await forgetClaim(ownerId, String(req.params.id ?? '').trim());
    if (!out) return res.status(404).json({ success: false, code: ErrorCodes.NOT_FOUND, error: 'Claim not found' });
    ok(res, ownerId, { forgotten: out.claimId, archivedClaims: out.claims.length, conversationFacts: out.conversationFacts.length, legacyFacts: out.legacyFacts.length });
  } catch (err) {
    if (err instanceof MemoryControlUnavailable) {
      return res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: err.message });
    }
    throw err;
  }
}));

router.post('/claims/:id/correct-value', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  if (!dbConfigured()) return res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: 'Canonical world model is not configured' });
  const value = String(req.body?.value ?? '').trim().slice(0, 500);
  if (!value) return res.status(400).json({ success: false, code: ErrorCodes.BAD_REQUEST, error: 'value is required' });
  const { correctClaimValue, MemoryControlUnavailable } = await import('../memory/forget.js');
  try {
    const out = await correctClaimValue(ownerId, String(req.params.id ?? '').trim(), value);
    if (!out) return res.status(404).json({ success: false, code: ErrorCodes.NOT_FOUND, error: 'Claim not found' });
    ok(res, ownerId, { corrected: out.from, claimId: out.to, statement: out.statementText, legacyFacts: out.legacyFacts.length });
  } catch (err) {
    if (err instanceof MemoryControlUnavailable) return res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: err.message });
    if (/already superseded|archived claim cannot/i.test(String(err?.message ?? ''))) {
      return res.status(409).json({ success: false, code: 'CLAIM_NOT_CURRENT', error: 'That fact changed since you loaded the page. Refresh and try again.' });
    }
    throw err;
  }
}));

// ── The home screen's welcome line ───────────────────────────────────────────
// The SESSION identity only: no ?conversationId fallback, because the line is
// a statement about a person and an anonymous conversation id is not one.
// Fail-open by contract — the home screen must render whatever happens here —
// so an error is a 200 carrying the neutral line, never a 500.
router.get('/welcome', async (req, res) => {
  if (!req.aquaUserId) {
    return res.status(401).json({ success: false, code: ErrorCodes.UNAUTHORIZED, error: 'Sign in to see your welcome' });
  }
  const ownerId = resolveOwner({ userId: req.aquaUserId });
  const history = req.query.history === '1';
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, welcome: await Welcome.welcomeFor(ownerId, { history }) });
  } catch (err) {
    console.error(`[BRAIN_API] GET /welcome failed (neutral line served): ${err?.message ?? err}`);
    if (!res.headersSent) res.json({ success: true, welcome: selectWelcome({ unavailable: true, history }) });
  }
});

// ── Proactive interventions (Phase 4) + bounded actions (Phase 5) ────────────
// Every route is owner-scoped through requireOwner; ids from another owner are
// indistinguishable from missing ones (404).
const needDb = res => (dbConfigured() ? false : (res.status(503).json({ success: false, code: 'WORLD_MODEL_UNAVAILABLE', error: 'Canonical world model is not configured' }), true));

router.get('/interventions', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId || needDb(res)) return;
  const status = typeof req.query.status === 'string' ? req.query.status.slice(0, 20) : null;
  ok(res, ownerId, {
    enabled: Proactive.proactiveEnabled(),
    interventions: await Proactive.proactiveRepository.listInterventions(ownerId, { status, includeSuppressed: req.query.all === '1', limit: clampInt(req.query.limit, 50, 1, 200) }),
    stats: await Proactive.proactiveRepository.interventionStats(ownerId),
  });
}));

router.post('/interventions/evaluate', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId || needDb(res)) return;
  if (!Proactive.proactiveEnabled()) return res.status(409).json({ success: false, code: 'PROACTIVE_DISABLED', error: 'AQUA_PROACTIVE is off', flags: flagState() });
  ok(res, ownerId, { evaluation: await Proactive.evaluateOwner(ownerId) });
}));

router.get('/interventions/preferences', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId || needDb(res)) return;
  ok(res, ownerId, { preferences: await Proactive.proactiveRepository.loadPrefs(ownerId) });
}));

router.put('/interventions/preferences', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId || needDb(res)) return;
  const b = req.body ?? {};
  const sev = ['low', 'medium', 'high'].includes(b.minSeverity) ? b.minSeverity : undefined;
  const mins = v => (v === null ? null : Number.isInteger(v) && v >= 0 && v < 1440 ? v : undefined);
  try {
    ok(res, ownerId, { preferences: await Proactive.proactiveRepository.savePrefs(ownerId, {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, minSeverity: sev,
      maxPerDay: Number.isInteger(b.maxPerDay) ? Math.max(0, Math.min(20, b.maxPerDay)) : undefined,
      quietStartMin: mins(b.quietStartMin), quietEndMin: mins(b.quietEndMin),
      tzOffsetMin: Number.isInteger(b.tzOffsetMin) ? Math.max(-840, Math.min(840, b.tzOffsetMin)) : undefined,
    }) });
  } catch (error) {
    res.status(400).json({ success: false, code: ErrorCodes.BAD_REQUEST, error: String(error?.message ?? error).slice(0, 200), flags: flagState() });
  }
}));

router.post('/interventions/:id/respond', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId || needDb(res)) return;
  const id = validUuid(String(req.params.id ?? ''));
  const response = String(req.body?.response ?? '');
  if (!id) return res.status(404).json({ success: false, code: ErrorCodes.NOT_FOUND, error: 'Intervention not found', flags: flagState() });
  if (!['accepted', 'dismissed', 'corrected', 'snoozed'].includes(response)) {
    return res.status(400).json({ success: false, code: ErrorCodes.BAD_REQUEST, error: 'response must be accepted|dismissed|corrected|snoozed', flags: flagState() });
  }
  const r = await Proactive.respondToIntervention(ownerId, id, response, {
    note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null,
    snoozeHours: clampInt(req.body?.snoozeHours, 24, 1, 24 * 14),
  });
  if (!r) return res.status(404).json({ success: false, code: ErrorCodes.NOT_FOUND, error: 'Intervention not found', flags: flagState() });
  ok(res, ownerId, { intervention: r });
}));

router.get('/actions', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId || needDb(res)) return;
  const status = typeof req.query.status === 'string' ? req.query.status.slice(0, 20) : null;
  ok(res, ownerId, { actions: await ActionRuns.listRuns(ownerId, { status, limit: clampInt(req.query.limit, 50, 1, 200) }) });
}));

router.post('/actions/:id/approve', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId || needDb(res)) return;
  const id = validUuid(String(req.params.id ?? ''));
  if (!id) return res.status(404).json({ success: false, code: ErrorCodes.NOT_FOUND, error: 'Action not found', flags: flagState() });
  const r = await ActionExecutor.approve(ownerId, id, { choice: validUuid(req.body?.choice) });
  if (r.code === 'NOT_FOUND') return res.status(404).json({ success: false, code: ErrorCodes.NOT_FOUND, error: 'Action not found', flags: flagState() });
  if (!r.ok) return res.status(409).json({ success: false, code: r.code, options: r.options ?? null, run: r.run ?? null, flags: flagState() });
  ok(res, ownerId, { action: r.run, jobId: r.jobId });
}));

router.post('/actions/:id/reject', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId || needDb(res)) return;
  const id = validUuid(String(req.params.id ?? ''));
  const r = id ? await ActionExecutor.reject(ownerId, id) : { ok: false };
  if (!r.ok) return res.status(409).json({ success: false, code: 'NOT_PROPOSED', flags: flagState() });
  ok(res, ownerId, { action: r.run });
}));

// ── Timeline (B7) ────────────────────────────────────────────────────────────

/**
 * The unified timeline — reasoning-graph events, the Mind's own timeline and
 * conversation events, ordered, each linked to the projects, people, goals,
 * documents and conversations it touches, plus the lifecycle chains detected
 * across them.
 *
 *   ?limit=      1..500  (default 100)
 *   ?subject=    restrict to one subject's story
 *   ?minStages=  2..10   how many lifecycle stages a run needs to be a chain
 */
router.get('/timeline', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const timeline = await Brain.getTimelineAsync(ownerId, {
    limit: clampInt(req.query.limit, 100, 1, 500),
    minStages: clampInt(req.query.minStages, 2, 2, 10),
    subject: req.query.subject ? String(req.query.subject).slice(0, 200) : null,
  });

  ok(res, ownerId, {
    events: timeline.events,
    chains: timeline.chains,
    stats: timeline.stats,
  }, { empty: timeline.events.length === 0 });
}));

/**
 * The lifecycle chains alone — "what is the story of X".
 *
 * A chain is temporal + stage-ordered evidence of a progression
 * (idea → decision → build → artifact → ship → outreach → outcome). The
 * field is called `progression`, not causation: the chain builder asserts
 * order, never that one stage caused the next. Events that regress a stage
 * are returned as `offSequence` rather than reordered or dropped.
 */
router.get('/chains', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const chains = await Brain.getChainsAsync(ownerId, {
    limit: clampInt(req.query.limit, 100, 1, 500),
    minStages: clampInt(req.query.minStages, 2, 2, 10),
    subject: req.query.subject ? String(req.query.subject).slice(0, 200) : null,
  });

  ok(res, ownerId, {
    count: chains.length,
    stages: orderedStages(),
    chains,
  }, { empty: chains.length === 0 });
}));

// ── Digital Twin (B6) ────────────────────────────────────────────────────────

/**
 * What AQUA has inferred about how the user works — each inference carrying
 * confidence, the supporting evidence, and when it was last verified.
 *
 *   ?includeTentative=1   also return inferences below the anti-fabrication
 *                         bar (minEvidence 3, minConfidence 0.45)
 *   ?patterns=a,b,c       restrict to named patterns
 *
 * Tentative inferences are excluded by default on purpose: the bar exists so
 * one phrase can never establish a claim about someone, and a UI that shows
 * unbarred guesses as findings defeats it.
 */
router.get('/twin', guarded((req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const patterns = String(req.query.patterns ?? '')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);

  const twin = Brain.getTwin(ownerId, {
    includeTentative: boolParam(req.query.includeTentative),
    patterns: patterns.length ? patterns : null,
  });

  ok(res, ownerId, { twin }, { empty: twin.inferences.length === 0, kind: 'twin' });
}));

/**
 * Canonical revision feed. Prefer the Postgres World Model revision ledger;
 * fall back to the legacy PIC reflection ring while older tenants migrate.
 * No second history is written here.
 */
router.get('/changes', guarded(async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const limit = clampInt(req.query.limit, 20, 1, 100);
  const legacyReader = async (owner) => {
    try {
      return getLedger(owner, { limit: 300 })
        .filter(e => e?.op === 'reflection')
        .slice(-limit)
        .reverse()
        .map(e => ({
          at: e.at,
          summary: e.summary ?? null,
          entities: e.entities ?? 0,
          relationships: e.relationships ?? 0,
          obsoleted: e.obsoleted ?? 0,
          revised: e.revised ?? 0,
          applied: e.applied === true,
        }));
    } catch {
      return [];
    }
  };

  const feed = await getRevisionFeed(ownerId, { limit, legacyReader });
  ok(res, ownerId, {
    source: feed.source,
    changes: feed.changes,
  }, { empty: feed.changes.length === 0, kind: 'changes' });
}));

export default router;