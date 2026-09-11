/**
 * AQUA Brain — Context Engine V2 Scorer (Brain V1 / B4)
 *
 * THE SHIFT THE BRIEF ASKS FOR
 * ----------------------------
 * Old question: "What memories match?" — one lexical score, take the top N.
 * New question: "What understanding does AQUA need before answering?"
 *
 * The PIC retrieval lane scored facts on four signals (confidence, three
 * lifecycle flags, a flat graph-hop bonus, reasoning feedback). The brief
 * names TEN dimensions. This module scores every candidate on all ten, each
 * as an independent, bounded, explained contribution — so the assembler can
 * make a real selection instead of a lexical sort, and every choice can be
 * traced to why it scored the way it did.
 *
 * THE TEN DIMENSIONS (verbatim from the brief) and where each comes from:
 *
 *   importance             world-model importance (B2) — corroboration,
 *                          connectedness, salience, already blended
 *   recency                age of the candidate, exponential decay
 *   relationship_distance  graph hops from an entity the QUERY is about —
 *                          near things matter more than far things
 *   active_project         does it touch the workspace the user is in now?
 *   active_goal            does it touch a goal the user is pursuing now?
 *   confidence             the candidate's own confidence
 *   source_reliability     document-grounded > conversational > inferred
 *   conversation_continuity was it already in play earlier this thread?
 *   semantic_similarity    embedding cosine to the query (real vectors when
 *                          embeddings are on; lexical fallback when off)
 *   user_focus             lexical overlap with what the user actually typed
 *
 * Pure. No I/O, no model calls — the caller passes already-computed signals
 * (semantic scores, active project/goals, focus entities) in a context bag,
 * so this stays deterministic and unit-testable.
 */
import { recencyScore, clamp01, round3 } from '../worldModel/schema.js';

/**
 * Dimension weights. They encode a claim about what "understanding AQUA
 * needs" means: semantic + focus (is this even about the question?) and
 * importance (does this matter in the user's world?) lead; the active
 * project/goal and continuity signals sharpen relevance to THIS moment;
 * confidence, reliability, recency and distance are the quality/proximity
 * modifiers. They sum to 1 so a total score is a clean 0..1.
 */
export const DIMENSION_WEIGHTS = Object.freeze({
  semantic_similarity:     0.20,
  user_focus:              0.16,
  importance:              0.14,
  active_project:          0.10,
  active_goal:             0.09,
  confidence:              0.08,
  source_reliability:      0.08,
  relationship_distance:   0.06,
  conversation_continuity: 0.05,
  recency:                 0.04,
});

/** Source → reliability prior. Document extraction is the gold standard. */
const SOURCE_RELIABILITY = Object.freeze({
  document: 1.0, file: 1.0,
  conversation: 0.6,
  inferred: 0.45, derived: 0.45,
  unknown: 0.5,
});

/**
 * Score one candidate across all ten dimensions.
 *
 * @param {object} candidate - normalized: { id, text, confidence, timestamp,
 *          sourceType, entityIds[], hops, semanticId }
 * @param {object} ctx - the shared signal bag for this turn:
 *   { queryTokens:Set, semanticScores:Map|null, activeProjectTokens:Set,
 *     activeGoalTokens:Set, focusEntityIds:Set, priorEntityIds:Set,
 *     maxHops:number }
 * @returns {{ score:number, dimensions:object }} bounded 0..1 + the per-dim breakdown
 */
export function scoreCandidate(candidate, ctx) {
  const d = {
    semantic_similarity:     semanticSimilarity(candidate, ctx),
    user_focus:              userFocus(candidate, ctx),
    importance:              clamp01(candidate.importance ?? 0),
    active_project:          activeProject(candidate, ctx),
    active_goal:             activeGoal(candidate, ctx),
    confidence:              clamp01(candidate.confidence ?? 0.5),
    source_reliability:      sourceReliability(candidate),
    relationship_distance:   relationshipDistance(candidate, ctx),
    conversation_continuity: conversationContinuity(candidate, ctx),
    recency:                 recencyScore(candidate.timestamp),
  };

  let score = 0;
  for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) score += weight * d[dim];

  const breakdown = {};
  for (const dim of Object.keys(DIMENSION_WEIGHTS)) breakdown[dim] = round3(d[dim]);

  return { score: round3(clamp01(score)), dimensions: breakdown };
}

// ── Dimension implementations ────────────────────────────────────────────────

/**
 * Real embedding cosine when the semantic lane is live; a lexical Jaccard
 * fallback when embeddings are off — so the dimension always contributes
 * something rather than silently zeroing on the embeddings-off path.
 */
function semanticSimilarity(candidate, ctx) {
  if (ctx.semanticScores && candidate.semanticId != null) {
    const s = ctx.semanticScores.get(candidate.semanticId);
    if (typeof s === 'number') return clamp01(s);
  }
  // Fallback: token Jaccard against the query.
  return jaccard(tokensOf(candidate.text), ctx.queryTokens);
}

/** Lexical overlap with the user's literal words — "is this about the question?" */
function userFocus(candidate, ctx) {
  if (!ctx.queryTokens?.size) return 0;
  const toks = tokensOf(candidate.text);
  if (!toks.size) return 0;
  let hit = 0;
  for (const t of toks) if (ctx.queryTokens.has(t)) hit++;
  // Coverage of the QUERY's terms, not the candidate's — a candidate that
  // covers more of what was asked scores higher, regardless of its length.
  let covered = 0;
  for (const t of ctx.queryTokens) if (toks.has(t)) covered++;
  return clamp01(0.5 * (hit / toks.size) + 0.5 * (covered / ctx.queryTokens.size));
}

function activeProject(candidate, ctx) {
  return tokenTouch(candidate, ctx.activeProjectTokens) ? 1 : 0;
}

function activeGoal(candidate, ctx) {
  return tokenTouch(candidate, ctx.activeGoalTokens) ? 1 : 0;
}

function sourceReliability(candidate) {
  return SOURCE_RELIABILITY[candidate.sourceType] ?? SOURCE_RELIABILITY.unknown;
}

/**
 * Closeness to an entity the query is about. hops=0 (the focus entity itself)
 * scores 1; each hop out decays. A candidate with no path to any focus entity
 * gets the neutral floor, not zero — it may still be relevant on other dims.
 */
function relationshipDistance(candidate, ctx) {
  if (candidate.hops == null) return 0.5;
  if (candidate.hops <= 0) return 1;
  const maxHops = ctx.maxHops ?? 3;
  return clamp01(1 - candidate.hops / (maxHops + 1));
}

/** Was any of this candidate's entities already in play earlier this thread? */
function conversationContinuity(candidate, ctx) {
  if (!ctx.priorEntityIds?.size || !candidate.entityIds?.length) return 0;
  return candidate.entityIds.some(id => ctx.priorEntityIds.has(id)) ? 1 : 0;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tokenTouch(candidate, tokenSet) {
  if (!tokenSet?.size) return false;
  const toks = tokensOf(candidate.text);
  for (const t of toks) if (tokenSet.has(t)) return true;
  return false;
}

export function tokensOf(text) {
  return new Set(
    [...String(text ?? '').toLowerCase().matchAll(/[a-z0-9][\w\-.]{1,}/g)]
      .map(m => m[0])
      .filter(t => t.length > 2),
  );
}

function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return clamp01(inter / (a.size + b.size - inter));
}

/** The dimensions in descending weight — for explainability output. */
export function rankedDimensions(breakdown) {
  return Object.entries(breakdown)
    .map(([dim, val]) => ({ dim, val, weight: DIMENSION_WEIGHTS[dim] ?? 0, contribution: round3((DIMENSION_WEIGHTS[dim] ?? 0) * val) }))
    .sort((a, b) => b.contribution - a.contribution);
}
