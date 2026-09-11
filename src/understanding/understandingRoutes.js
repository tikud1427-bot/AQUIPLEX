/**
 * UUS — the Understanding read model.
 *
 * GET /api/aqua/understanding
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a store, not a profile, not a new source of truth. Every value here is
 * composed from systems that already own it:
 *
 *   Mind          beliefs by dimension, goals
 *   memoryReasoner  gaps → "unknown areas"
 *   coverage.js   the score and per-dimension confidence (pure)
 *
 * Nothing is written. A read that invents storage is how a "dashboard" turns
 * into a second world model that disagrees with the first one.
 *
 * WHY IT IS A SEPARATE ROUTE FROM /mind
 * -------------------------------------
 * `/mind` is the cognitive model's own surface — episodes, predictions, the
 * relationship graph, reflection history. It answers "what is in the Mind".
 * This answers "what does AQUA understand about me", which is a different
 * question with a different audience: one is for debugging, one is the product.
 * Merging them would mean the user-facing screen inherits every field the Mind
 * layer ever adds.
 *
 * Ungated on purpose. It reads what is there; with the flags off it reports a
 * low score honestly rather than 404ing, which is exactly what a new account
 * should see.
 */
import express from 'express';
import { resolveMindOwner, peekMind } from '../mind/mindStore.js';
import { getBeliefs } from '../mind/beliefEngine.js';
import { findGaps } from '../memory/memoryReasoner.js';
import { buildCoverage, COVERAGE_DIMENSIONS } from './coverage.js';
import { buildCard } from './summary.js';
import { nodesByType } from '../reasoning/reasoningGraph.js';
import { getConversationMeta, updateConversationMeta, listConversationIdsForUser } from '../memory/conversationStore.js';
import { applyCorrection, dismissedEntityIds, isDismissalKey } from './corrections.js';
import * as memoryEditor from '../memory/memoryEditor.js';

const router = express.Router();

/** Same owner resolution as mindRoutes — deliberately identical, not similar. */
function ownerOf(req) {
  return resolveMindOwner({
    userId: req.aquaUserId ?? null,
    conversationId: req.query.conversationId ?? req.body?.conversationId ?? null,
  });
}

/** Belief shape for the UI: enough to render and to correct, nothing more. */
function publicBelief(b) {
  return {
    ref: `belief:${b.dimension}:${b.key}`,   // what PATCH /understanding/item takes
    dimension: b.dimension,
    key: b.key,
    value: b.value,
    confidence: +Number(b.confidence ?? 0).toFixed(3),
    evidenceCount: b.evidenceCount ?? 0,
    // Provenance is shown, not hidden. "You told me this" and "I worked this
    // out" are different claims, and a trust screen that blurs them is worse
    // than one that shows less.
    source: b.privacy?.source ?? 'inference',
    locked: !!b.privacy?.locked,
    updatedAt: b.updatedAt ?? null,
  };
}

function publicGoal(g) {
  return {
    ref: `goal:${g.id}`,
    id: g.id,
    title: g.title,
    status: g.status,
    confidence: +Number(g.confidence ?? 0).toFixed(3),
    lastMentionedAt: g.lastMentionedAt ?? null,
  };
}

/** The belief key that holds what the user said they are building. Excluded
 *  from the "You" section so a project never renders twice on one card — the
 *  same technique `isDismissalKey` already uses for bookkeeping rows. It still
 *  counts toward coverage, because it IS something AQUA knows. */
export const PROJECT_BELIEF_KEY = 'project';

/** One or more project labels off a single belief. `project` is a
 *  MERGE_COLLECTION field, so its value can arrive as an array or as a
 *  comma-joined string; both mean the same thing to a reader. */
function projectLabels(belief) {
  const raw = belief?.value;
  const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return parts.map(s => String(s).trim()).filter(s => s.length >= 2).slice(0, 4);
}

/** Projects the graph knows about, newest first. Fail-open — a card without
 *  projects is fine; a 500 on the trust screen is not.
 *
 *  UNION, not replacement. A document that names a project still produces a
 *  graph entity; a person who SAYS what they are building now produces a
 *  belief. Before this, only the first existed, so the section was empty for
 *  every conversation-only account — which is everyone on day one. Stated
 *  projects lead because the person saying it outranks a file mentioning it,
 *  the same ordering U3 established for every other kind of evidence. */
function projectsFor(ownerId, mind = null) {
  const dismissed = mind ? dismissedEntityIds(mind) : new Set();
  const out = [];
  const seen = new Set();

  try {
    for (const b of getBeliefs(mind, { dimension: 'identity' })) {
      if (b?.key !== PROJECT_BELIEF_KEY || isDismissalKey(b.key)) continue;
      for (const label of projectLabels(b)) {
        const k = label.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          id: `belief:identity:${PROJECT_BELIEF_KEY}`,
          label,
          ref: `belief:identity:${PROJECT_BELIEF_KEY}`,
          confidence: Number(b.confidence ?? 0.8),
          source: b.source ?? null,
        });
      }
    }
  } catch { /* fail-open */ }

  try {
    for (const n of nodesByType(ownerId, 'entity') ?? []) {
      const t = n?.data?.entityType;
      if (t !== 'project' && t !== 'product') continue;
      if (dismissed.has(n.id)) continue;
      const k = String(n.label ?? '').toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ id: n.id, label: n.label, ref: `entity:${n.id}`, confidence: 0.8, updatedAt: n.updatedAt ?? 0 });
    }
  } catch { /* fail-open */ }

  return out;
}

/** Everything the card needs, assembled from what already exists. */
function cardFor(ownerId, mind) {
  const beliefsByDimension = {};
  for (const dim of COVERAGE_DIMENSIONS) {
    beliefsByDimension[dim] = getBeliefs(mind, { dimension: dim }).filter(b => !isDismissalKey(b.key));
  }
  const goals = Object.values(mind.goals ?? {});

  let gaps = {};
  try { gaps = findGaps(ownerId) ?? {}; } catch { /* fail-open */ }

  // Coverage sees EVERYTHING, including the project belief — it is knowledge
  // and the score must say so. The card sees the same set minus that one key,
  // because it renders in its own "Working on" section and a line appearing
  // twice under two headings reads as padding, not as understanding.
  const coverage = buildCoverage({ beliefsByDimension, goals, gaps });
  const cardBeliefs = {
    ...beliefsByDimension,
    identity: (beliefsByDimension.identity ?? []).filter(b => b?.key !== PROJECT_BELIEF_KEY),
  };
  const card = buildCard({
    beliefsByDimension: cardBeliefs, goals,
    projects: projectsFor(ownerId, mind),
    sources: [{ kind: 'conversation', count: mind.turnCount ?? 0 }],
    // The ONE score. Not recomputed here — the card and the dashboard read the
    // same number, which is the whole reason U4 moved it server-side.
    score: coverage.score,
  });
  return { card, coverage };
}

// ── POST /understanding/intro/complete ───────────────────────────────────────
//
// Marks the intro conversation and returns the assembled card. The marker is
// DERIVED first-run state living on conversation.meta — an open bag, so zero
// schema change — rather than a stored "has onboarded" flag that can end up
// disagreeing with whether the conversation actually happened.
router.post('/intro/complete', (req, res) => {
  const ownerId = ownerOf(req);
  const conversationId = req.body?.conversationId ?? null;
  if (!ownerId) {
    return res.status(400).json({ success: false, error: 'No owner: log in, or pass conversationId for the dev fallback.' });
  }

  if (conversationId) {
    try {
      updateConversationMeta(conversationId, {
        kind: 'understanding_intro',
        introCompletedAt: Date.now(),
      });
    } catch { /* a missing marker costs a re-offer, never the card */ }
  }

  const mind = peekMind(ownerId);
  if (!mind) {
    // Someone skipped immediately, or said nothing usable. Not an error, and
    // not a card pretending otherwise.
    return res.json({
      success: true, ownerId,
      card: { headline: "Here's what I understand so far", sections: [], score: 0, confidence: 'nothing yet', sources: [], isThin: true },
    });
  }

  const { card } = cardFor(ownerId, mind);
  res.json({ success: true, ownerId, card });
});

/**
 * Has this ACCOUNT ever done the intro?
 *
 * This used to read the meta of whichever conversation the client happened to
 * pass — which answers a different question: "is THIS conversation the intro".
 * At the exact moment the gate matters (a fresh tab, no conversation open yet)
 * there is no id to pass, so it always answered false. `shouldOffer` then
 * rested entirely on `score === 0`, and the NEVER RE-OFFER rule held only for
 * as long as the score stayed above zero. Someone who skipped the intro, or
 * gave answers nothing could be extracted from, would be offered it again on
 * every single visit — which is the one thing the rule exists to prevent.
 *
 * Still derived, still zero new storage: any conversation belonging to this
 * user that carries the `understanding_intro` marker /intro/complete already
 * writes. In-memory Map scan, once per app boot.
 *
 * Fail-open to false: an unreadable store should cost at most one re-offer,
 * never a crash on the first screen a new account sees.
 */
function accountHasIntro(req, conversationId) {
  try {
    if (conversationId && getConversationMeta(conversationId)?.kind === 'understanding_intro') return true;
    const userId = req.aquaUserId ?? null;
    if (!userId) return false;
    return listConversationIdsForUser(userId)
      .some(id => getConversationMeta(id)?.kind === 'understanding_intro');
  } catch { return false; }
}

// ── GET /understanding/intro/state ───────────────────────────────────────────
//
// What the first-run gate asks at boot. Deliberately cheap and deliberately
// derived: `hasIntro` comes from the account's own conversation markers,
// `score` from the coverage model. Nothing here is stored state that could
// drift.
router.get('/intro/state', (req, res) => {
  const ownerId = ownerOf(req);
  const conversationId = req.query.conversationId ?? null;
  const hasIntro = accountHasIntro(req, conversationId);

  const mind = ownerId ? peekMind(ownerId) : null;
  const score = mind ? buildCoverage({
    beliefsByDimension: Object.fromEntries(
      COVERAGE_DIMENSIONS.map(d => [d, getBeliefs(mind, { dimension: d })]),
    ),
    goals: Object.values(mind.goals ?? {}),
  }).score : 0;

  const shouldOffer = !hasIntro && score === 0;

  // The gate was dark: this endpoint answered correctly for weeks and nothing
  // recorded that it had been asked. When the intro fails to appear there is
  // then no way to tell "the browser never called" from "the answer was no" —
  // which is exactly the ambiguity that cost a day. One line, read-only.
  console.log(`[UUS] gate owner=${ownerId ?? 'none'} hasIntro=${hasIntro} score=${score} offer=${shouldOffer}`);

  res.json({
    success: true,
    ownerId: ownerId ?? null,
    hasIntro,
    score,
    // The gate's actual question. Offer the intro to someone AQUA knows
    // nothing about — and never to someone who already did it, even if their
    // score is still low, because re-offering reads as "you failed".
    shouldOffer,
  });
});

/**
 * What taught AQUA what. Counted off belief provenance rather than tracked
 * separately — a second counter would drift from the beliefs it describes.
 */
function sourcesFor(mind, beliefsByDimension) {
  const counts = new Map();
  for (const list of Object.values(beliefsByDimension ?? {})) {
    for (const b of list ?? []) {
      const src = b.privacy?.source ?? 'inference';
      counts.set(src, (counts.get(src) ?? 0) + 1);
    }
  }
  const LABELS = {
    explicit:    'Things you told me',
    correction:  'Things you corrected',
    fact_bridge: 'Things I read in your files',
    inference:   'Things I worked out',
  };
  const out = [...counts.entries()]
    .filter(([, n]) => n > 0)
    .map(([kind, count]) => ({ kind, label: LABELS[kind] ?? kind, count }))
    // Strongest provenance first: what the user said outranks what we guessed.
    .sort((a, b) => (LABELS[a.kind] ? Object.keys(LABELS).indexOf(a.kind) : 9)
                  - (LABELS[b.kind] ? Object.keys(LABELS).indexOf(b.kind) : 9));

  const turns = mind?.turnCount ?? 0;
  if (turns > 0) out.push({ kind: 'conversation', label: 'Conversations', count: turns });
  return out;
}

// ── PATCH /understanding/item ────────────────────────────────────────────────
//
// "Correct my understanding" — ONE endpoint for every kind of thing AQUA
// believes. It invents no storage: it parses the `ref` every item already
// carries and dispatches to whichever existing API owns that thing.
//
// The point is that the USER does not have to care. Asking someone to know
// that "founder" is a belief while "launch the beta" is a goal is asking them
// to learn our schema in order to tell us we are wrong.
router.patch('/item', (req, res) => {
  const ownerId = ownerOf(req);
  const { ref, value = null, action = 'correct' } = req.body ?? {};

  const result = applyCorrection({
    ownerId, ref, value, action,
    deps: { memoryEditor },
  });

  if (!result.ok) return res.status(result.status ?? 400).json({ success: false, error: result.error });
  res.json({ success: true, ...result });
});

// ── GET /understanding ───────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) {
    return res.status(400).json({
      success: false,
      error: 'No owner: log in, or pass ?conversationId= for the dev fallback.',
    });
  }

  const mind = peekMind(ownerId);

  // A brand-new account is the NORMAL case for this endpoint, not an error.
  // 404 would make the first-run gate treat "nothing learned yet" as a failure
  // and hide the very screen that exists to fix it.
  if (!mind) {
    return res.json({
      success: true, ownerId, isNew: true,
      score: 0, confidence: 'nothing yet',
      dimensions: {}, sections: [], goals: [], unknowns: [], sources: [],
      updatedAt: null,
    });
  }

  const beliefsByDimension = {};
  for (const dim of COVERAGE_DIMENSIONS) {
    // Dismissal records are bookkeeping, not understanding. A dashboard row
    // reading "dismissed:ent:proj:x = true" would be showing the user our
    // filing system instead of their world — and it would drag the coverage
    // score up for knowing nothing.
    beliefsByDimension[dim] = getBeliefs(mind, { dimension: dim }).filter(b => !isDismissalKey(b.key));
  }
  const goals = Object.values(mind.goals ?? {});

  // Gaps come from the memory reasoner, which owns that question already.
  // Fail-open: a degraded unknowns list is worth far more than a 500 on the
  // screen whose entire job is to make the user feel understood.
  let gaps = {};
  try { gaps = findGaps(ownerId) ?? {}; } catch { /* fail-open */ }

  const coverage = buildCoverage({ beliefsByDimension, goals, gaps });

  // Sections are ordered by what a person would want to read first, not by
  // internal dimension order — and an empty section is DROPPED rather than
  // rendered as "unknown". Three true sentences beat nine padded ones.
  const sections = COVERAGE_DIMENSIONS
    .map(dim => ({
      id: dim,
      label: coverage.dimensions[dim].label,
      confidence: coverage.dimensions[dim].avg,
      confidenceLabel: coverage.dimensions[dim].confidence,
      items: beliefsByDimension[dim].map(publicBelief),
    }))
    .filter(s => s.items.length > 0);

  res.json({
    success: true,
    ownerId,
    isNew: coverage.score === 0,
    score: coverage.score,
    confidence: coverage.confidence,
    dimensions: coverage.dimensions,
    sections,
    // Projects come from two lanes now — the graph (a document named it) and
    // the Mind (the user said it) — so each carries the ref that actually
    // corrects it rather than being stamped as an entity it may not be.
    projects: projectsFor(ownerId, mind).map(p => ({ ...p, ref: p.ref ?? `entity:${p.id}` })),
    goals: goals
      .sort((a, b) => (b.lastMentionedAt ?? 0) - (a.lastMentionedAt ?? 0))
      .map(publicGoal),
    unknowns: coverage.unknowns,
    // Knowledge sources — what taught AQUA what. Derived from provenance
    // already on every belief, so nothing new is tracked to produce it. The
    // user should be able to answer "why do you think that?" without asking.
    sources: sourcesFor(mind, beliefsByDimension),
    updatedAt: mind.updatedAt ?? null,
  });
});

export default router;
