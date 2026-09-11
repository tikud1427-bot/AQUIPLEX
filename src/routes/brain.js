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
 *
 * Mounted at /api/aqua/brain by aqua/router.js.
 */
import express from 'express';
import { resolveOwner } from '../memory/engine.js';
import { getLedger } from '../pic/picStore.js';
import * as Brain from '../brain/index.js';
import { selfEntityEnabled } from '../brain/identity/selfEntity.js';

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
    // The eighth switch. Every other flag here changes what AQUA KNOWS or does
    // silently; this one changes what it SAYS, unprompted. That is the one most
    // worth being able to read off a running instance.
    AQUA_REVISION_VOICE: Brain.revisionVoiceEnabled(),
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
      handler(req, res);
    } catch (err) {
      console.error(`[BRAIN_API] ${req.method} ${req.path} failed:`, err?.stack ?? err?.message ?? err);
      res.status(500).json({ success: false, error: err?.message ?? 'Internal error' });
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
router.get('/stats', guarded((req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const stats = Brain.worldStats(ownerId);
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
router.get('/entities', guarded((req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const q = String(req.query.q ?? '').trim().slice(0, 200);
  const limit = clampInt(req.query.limit, 50, 1, 200);

  const entities = q
    ? Brain.findEntities(ownerId, q, { limit })
    : Brain.listEntities(ownerId, {
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
function entityDetail(req, res) {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const id = String(req.params.id ?? req.query.id ?? '').trim();
  if (!id) {
    return res.status(400).json({ success: false, error: 'id is required (?id=<entityId>)' });
  }

  const detail = Brain.describeEntity(ownerId, id, {
    relationships: clampInt(req.query.relationships, 20, 1, 100),
    observations: clampInt(req.query.observations, 15, 1, 100),
    events: clampInt(req.query.events, 15, 1, 100),
  });

  if (!detail) {
    return res.status(404).json({
      success: false,
      error: `Unknown entity: ${id}`,
      flags: flagState(),
    });
  }
  ok(res, ownerId, detail);
}

router.get('/entity', guarded(entityDetail));
router.get('/entity/:id', guarded(entityDetail));

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
router.get('/timeline', guarded((req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const timeline = Brain.getTimeline(ownerId, {
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
router.get('/chains', guarded((req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const chains = Brain.getChains(ownerId, {
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
 * WHAT CHANGED — AQUA's revisions to its own understanding, newest first.
 *
 * Every other endpoint here answers "what does AQUA know". This one answers
 * "what did AQUA change its mind about, and when", which is the thing an
 * unlimited context window cannot do: a transcript gives you recall, not a
 * position that can be revised.
 *
 * The data was being thrown away until now. `reflectWorldModel` computed a
 * structured WorldDelta on every cadence turn, applied it, logged one line to
 * the console, and returned it to `turnPostProcess`, which discards the return
 * value. Nothing persisted, nothing readable, nothing a user could ever see.
 *
 * READ-ONLY over the PIC ledger, which was already per-owner, bounded,
 * persisted and mirrored. No new store, and this is its first reader.
 *
 * Ledger entries whose `op` is not a reflection are filtered out here rather
 * than at write time — consolidation and ingest write to the same ring, and
 * they are legitimate entries that simply are not revisions.
 */
router.get('/changes', guarded((req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const limit = clampInt(req.query.limit, 20, 1, 100);
  let entries = [];
  try {
    entries = getLedger(ownerId, { limit: 300 })
      .filter(e => e?.op === 'reflection')
      .slice(-limit)
      .reverse();                       // newest first — this reads as a feed
  } catch { /* fail-open: an empty history is not an error */ }

  ok(res, ownerId, {
    changes: entries.map(e => ({
      at: e.at,
      summary: e.summary ?? null,
      entities: e.entities ?? 0,
      relationships: e.relationships ?? 0,
      obsoleted: e.obsoleted ?? 0,
      revised: e.revised ?? 0,
      // Whether AQUA acted on the revision or merely noticed it. With
      // AQUA_REFLECT_V2 off the delta is still computed (dry-run), so an
      // unapplied entry is real history, not a failure.
      applied: e.applied === true,
    })),
  }, { empty: entries.length === 0, kind: 'changes' });
}));

export default router;