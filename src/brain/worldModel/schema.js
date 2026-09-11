/**
 * AQUA Brain — World Model Schema (Brain V1 / B2)
 *
 * WHY THIS EXISTS
 * ---------------
 * AQUA knows things in two disconnected places:
 *
 *   reasoning/reasoningGraph.js   file-derived. Provenance-enforced, typed
 *                                 edges (B1), entity resolution across files.
 *   mind/relationshipGraph.js     conversation-derived. Weighted nodes,
 *                                 its own frozen vocabulary, inside mindStore.
 *
 * Neither can see the other, so "Ananya" learned from a PDF and "Ananya"
 * learned from six months of chat are two unrelated things. The brief asks
 * for one connected world: people, projects, goals, documents, timelines as
 * a single model.
 *
 * This module defines the SHAPE of that unified view. It defines no storage.
 *
 * THE FOUR PRIMITIVES (as specified in the brief)
 *   Entity        a thing: person, project, organization, technology, …
 *   Relationship  a typed, provenance-bearing link between entities
 *   Observation   a grounded fact about entities (evidenceStore owns these)
 *   Event         something that happened, with a time
 *
 * DERIVED, NOT STORED
 * -------------------
 * `confidence` and `importance` are computed here from observable signals —
 * how many independent sources corroborate the entity, how connected it is,
 * how much is known about it, how salient it is in conversation, how
 * recently it was seen. They are never guessed and never persisted: recompute
 * from the underlying graphs and you get the same number. That keeps the
 * annotation sidecar free of anything AQUA would lose if it were deleted.
 *
 * Pure. No I/O, no imports from storage layers. Safe for any layer.
 */

/** Rounding used for every derived score, so equality checks are stable. */
export function round3(n) { return Math.round(n * 1000) / 1000; }

export function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

/**
 * Smooth saturating curve: 0 at n=0, rising fast, asymptotic to 1.
 * Preferred over n/max clamping because there is no cliff — the 9th
 * corroborating file still counts for something, just less than the 2nd.
 */
export function saturate(n, k) {
  if (!(n > 0)) return 0;
  return 1 - Math.exp(-n / k);
}

/** Exponential recency decay. 1.0 today, ~0.5 at one half-life. */
export function recencyScore(timestamp, { halfLifeDays = 45 } = {}) {
  if (!timestamp) return 0;
  const days = (Date.now() - timestamp) / 86_400_000;
  if (days <= 0) return 1;
  return Math.pow(0.5, days / halfLifeDays);
}

// ── Confidence ───────────────────────────────────────────────────────────────

/**
 * How sure is AQUA that this entity is real and correctly resolved?
 *
 * Two ingredients, both observable:
 *   resolution    entityResolver's own merge confidence (1.0 when the entity
 *                 never had to be merged, lower when aliases were unified).
 *   corroboration how many INDEPENDENT sources mention it. One file saying
 *                 something is weaker than four files and a conversation.
 *
 * A mind-only entity has no resolver confidence, so it leans entirely on
 * corroboration and starts low — which is correct: a name mentioned once in
 * chat is a weaker claim than one extracted from a document with evidence.
 */
export function computeConfidence({ resolutionConfidence = null, sourceCount = 0 } = {}) {
  const corroboration = saturate(sourceCount, 2);
  if (resolutionConfidence == null) return round3(clamp01(0.25 + 0.5 * corroboration));
  return round3(clamp01(resolutionConfidence * 0.7 + corroboration * 0.3));
}

// ── Importance ───────────────────────────────────────────────────────────────

/**
 * How much should this entity matter when assembling context?
 *
 * Weighted blend of five observable signals. The weights encode a claim:
 * corroboration and connectedness matter most (a thing many sources touch,
 * connected to many other things, is central to the user's world), then how
 * much is actually known about it, then conversational salience, then
 * recency as a tiebreaker rather than a driver — an important project does
 * not stop being important during a quiet fortnight.
 *
 * B4's Context Engine consumes this directly as its `importance` dimension.
 */
export const IMPORTANCE_WEIGHTS = Object.freeze({
  sources: 0.30,       // independent files/conversations mentioning it
  degree: 0.25,        // relationships to other entities
  observations: 0.20,  // grounded facts about it
  salience: 0.15,      // conversational weight (mind node weight)
  recency: 0.10,       // decayed last-seen
});

export function computeImportance({
  sourceCount = 0, degree = 0, observationCount = 0, mindWeight = 0, lastSeenAt = null,
} = {}) {
  const w = IMPORTANCE_WEIGHTS;
  const score =
      w.sources      * saturate(sourceCount, 3)
    + w.degree       * saturate(degree, 6)
    + w.observations * saturate(observationCount, 5)
    + w.salience     * saturate(mindWeight, 8)
    + w.recency      * recencyScore(lastSeenAt);
  return round3(clamp01(score));
}

/** The signal breakdown behind an importance score, for explainability. */
export function importanceBreakdown(signals = {}) {
  const { sourceCount = 0, degree = 0, observationCount = 0, mindWeight = 0, lastSeenAt = null } = signals;
  return {
    sources:      round3(saturate(sourceCount, 3)),
    degree:       round3(saturate(degree, 6)),
    observations: round3(saturate(observationCount, 5)),
    salience:     round3(saturate(mindWeight, 8)),
    recency:      round3(recencyScore(lastSeenAt)),
  };
}

// ── Entity ───────────────────────────────────────────────────────────────────

/**
 * The unified Entity — every field the brief asks for.
 *
 * `ids` keeps the underlying identifiers rather than replacing them: the
 * Brain is a VIEW, so a caller can always walk back to the owning subsystem.
 * Nothing here is a copy of knowledge; it is an assembled read.
 *
 * @returns {object} frozen-shape entity (plain object, safe to serialize)
 */
export function createEntityView({
  id, type, title,
  aliases = [], description = '',
  metadata = {}, sourceRefs = {},
  ids = {}, signals = {},
  confidence = 0, importance = 0,
  firstSeenAt = null, lastSeenAt = null, updatedAt = null,
  annotated = false,
}) {
  return {
    id, type, title,
    aliases: [...new Set(aliases.filter(Boolean).map(String))],
    description,
    metadata,
    confidence,
    importance,
    firstSeenAt, lastSeenAt, updatedAt,
    sourceRefs,          // { files: [ukoId], conversations: [id], mindKey }
    ids,                 // { reasoning, mind }
    signals,             // raw inputs behind confidence/importance
    annotated,           // true when a sidecar annotation contributed
  };
}

/**
 * A Relationship as the world model exposes it — the B1 registry supplies
 * the type vocabulary, so this stays open-ended by construction.
 */
export function createRelationshipView({
  id, from, to, type, kind = 'derived',
  confidence = 0.5, reason = '', evidence = [], sourceFiles = [],
  origin = 'reasoning', weight = null, typeSource = null, otherId = null,
}) {
  // `otherId` is the far end relative to the entity the caller asked about.
  // Edges are stored directionally, so without it every consumer has to
  // re-derive "which end is not me" — B4's relationship-distance scoring
  // walks these in bulk and should not have to.
  return { id, from, to, otherId, type, kind, confidence, reason, evidence, sourceFiles, origin, weight, typeSource };
}

/** An Observation — a grounded fact. evidenceStore remains its owner. */
export function createObservationView({
  id, statement, entities = [], confidence = 0.5, evidence = [], sourceFiles = [], observedAt = null,
}) {
  return { id, statement, entities, confidence, evidence, sourceFiles, observedAt, kind: 'observed' };
}

/** An Event — something that happened. */
export function createEventView({
  id, label, eventType = null, timestamp = null, certainty = null,
  entities = [], sourceFiles = [], origin = 'reasoning',
}) {
  return { id, label, eventType, timestamp, certainty, entities, sourceFiles, origin, kind: 'derived' };
}

// ── Kill switch ──────────────────────────────────────────────────────────────

/**
 * AQUA_BRAIN=off disables the world model entirely. B2 is read-only and has
 * no callers yet, so the switch exists for the same reason PIC's does: one
 * env var must be able to take the whole layer out of the request path once
 * B4 wires it into chat.
 */
export function brainEnabled() {
  return String(process.env.AQUA_BRAIN ?? '').toLowerCase() !== 'off';
}