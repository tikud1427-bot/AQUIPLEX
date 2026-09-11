/**
 * AQUA Importance Engine — Fact Lifecycle (Memory 5.0, Phase A)
 * ─────────────────────────────────────────────────────────────────────────────
 * Facts were immortal with a static extraction-time importance. This module
 * makes importance a LIVING score and gives facts the same lifecycle beliefs
 * already have: recompute → archive (cold, never deleted) → reactivate.
 *
 *   computeImportance(fact, ctx)   pure 1..10 score:
 *     • baseImportance (extraction seed — preserved separately so recompute
 *       is idempotent, never a feedback loop on its own output)
 *     • recency of mention (fresh ↑, months-stale ↓)
 *     • frequency        log-scaled supportCount
 *     • usage            log-scaled retrievalCount (how often retrieval
 *                        actually injected it — Phase A retriever touch)
 *     • graph degree     the value is a connected node in the relationship
 *                        graph → structurally important
 *     • pinned floor     explicit corrections / "remember this" never sink
 *
 *   applyFactLifecycle(mind)       reflection-time pass (async path only):
 *     • enforce HISTORY_PER_ITEM on every fact (bug fix — cap existed in
 *       CAPS but was never applied on the fact layer)
 *     • recompute importance for all facts
 *     • ARCHIVE stale, low-value, unused, non-identity, non-pinned facts
 *       (status='archived' — cold storage, excluded from prompts/vectors,
 *       reactivated by longTermMemory on any re-mention)
 *
 * Fail-open like every other stage: callers wrap in try/catch; this module
 * itself never throws on malformed facts (defensive defaults throughout).
 */
import { CAPS } from '../mind/mindSchema.js';
import { IDENTITY_FACT_KEYS } from './identity.js';
import { getSchema } from './memorySchema.js';

const DAY_MS = 24 * 3600 * 1000;

// Archive rule thresholds — deliberately conservative: archiving is cheap to
// undo (any re-mention reactivates) but a wrongly-archived fact is a visible
// memory failure, so we only archive what is stale AND weak AND unused.
export const ARCHIVE_AFTER_MS = 90 * DAY_MS;   // unmentioned 90 days
export const ARCHIVE_MAX_IMPORTANCE = 3;       // and recomputed importance ≤ 3
const PINNED_FLOOR = 8;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const log2p = (n) => Math.log2(1 + Math.max(0, n || 0));

/**
 * Degree map of the relationship graph: lowercase node label → edge count.
 * Built once per lifecycle pass and handed to computeImportance via ctx.
 */
export function graphDegreeMap(mind) {
  const degree = new Map();
  const nodes = mind?.graph?.nodes || {};
  const edges = mind?.graph?.edges || {};
  const byKey = new Map();
  for (const node of Object.values(nodes)) {
    if (node?.label) byKey.set(node.key, String(node.label).toLowerCase().trim());
  }
  for (const e of Object.values(edges)) {
    for (const end of [e.from, e.to]) {
      const label = byKey.get(end);
      if (label) degree.set(label, (degree.get(label) || 0) + 1);
    }
  }
  return degree;
}

/** Lowercase string forms of a fact value that could name a graph node. */
function valueLabels(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap(v => valueLabels(typeof v === 'object' && v !== null ? v.name : v));
  }
  if (typeof value === 'object') return valueLabels(value.name);
  const s = String(value).toLowerCase().trim();
  return s.length > 1 ? [s] : [];
}

/**
 * Pure importance score, 1..10.
 * @param {object} fact
 * @param {{ now?: number, degree?: Map<string,number> }} ctx
 */
export function computeImportance(fact, ctx = {}) {
  if (!fact) return 5;
  const now = ctx.now ?? Date.now();
  const base = clamp(fact.baseImportance ?? fact.importance ?? 5, 1, 10);

  let score = base;

  // Recency of mention
  const sinceMention = now - (fact.lastMentionedAt || fact.updatedAt || fact.ts || now);
  if (sinceMention <= DAY_MS) score += 2;
  else if (sinceMention <= 7 * DAY_MS) score += 1;
  else if (sinceMention > 180 * DAY_MS) score -= 2;
  else if (sinceMention > 60 * DAY_MS) score -= 1;

  // Frequency (repeated identical evidence) — log-scaled, capped
  score += Math.min(2, log2p((fact.supportCount || 1) - 1));

  // Usage (retrieval actually injected it) — log-scaled, capped
  score += Math.min(2, log2p(fact.retrievalCount || 0));

  // Graph degree — the value is a well-connected node
  if (ctx.degree) {
    const deg = Math.max(0, ...valueLabels(fact.value).map(l => ctx.degree.get(l) || 0));
    if (deg >= 3) score += 1;
  }

  if (fact.pinned) score = Math.max(score, PINNED_FLOOR);
  return clamp(Math.round(score), 1, 10);
}

/** Cap a fact's revision history in place (HISTORY_PER_ITEM bug fix). */
export function capFactHistory(fact) {
  if (Array.isArray(fact?.history) && fact.history.length > CAPS.HISTORY_PER_ITEM) {
    fact.history.splice(0, fact.history.length - CAPS.HISTORY_PER_ITEM);
    return true;
  }
  return false;
}

/**
 * Reflection-time lifecycle pass over every fact in a mind. Mutates facts in
 * place (caller — reflectionEngine — owns touchMind/persistence).
 * @returns {{ recomputed: number, archived: string[], historyCapped: number }}
 */
export function applyFactLifecycle(mind, { now = Date.now() } = {}) {
  const report = { recomputed: 0, archived: [], historyCapped: 0 };
  const facts = mind?.facts;
  if (!facts || typeof facts !== 'object') return report;

  const degree = graphDegreeMap(mind);

  for (const fact of Object.values(facts)) {
    if (!fact || typeof fact !== 'object') continue;

    if (capFactHistory(fact)) report.historyCapped++;

    // Preserve the extraction seed once, so recompute is idempotent.
    if (fact.baseImportance == null) fact.baseImportance = fact.importance ?? 5;

    fact.importance = computeImportance(fact, { now, degree });
    report.recomputed++;

    const sinceMention = now - (fact.lastMentionedAt || fact.updatedAt || fact.ts || now);
    const eligible =
      fact.status !== 'archived' &&
      !fact.pinned &&
      !IDENTITY_FACT_KEYS.has(fact.key) &&
      sinceMention > ARCHIVE_AFTER_MS &&
      (fact.retrievalCount || 0) === 0 &&
      fact.importance <= ARCHIVE_MAX_IMPORTANCE;

    if (eligible) {
      fact.status = 'archived';
      fact.archivedAt = now;
      report.archived.push(fact.key);
    }
  }
  return report;
}

// ── Phase E — duplicate-fact merge (reflection consolidation) ─────────────────
/**
 * Two keys holding the SAME scalar value are one memory wearing two names —
 * typically a free-form key from a correction ("my employer is Aquiplex")
 * alongside the canonical schema key (workplace: Aquiplex). Reflection folds
 * them: schema-keyed / pinned / better-supported / older fact wins; the
 * loser's support, usage and pin are absorbed; the merge is versioned into
 * the winner's history. Identity-keyed facts are NEVER deleted as losers —
 * each identity field is deliberately its own isolated key (organization vs
 * workplace can legitimately share a value).
 */
export function mergeDuplicateFacts(mind, { now = Date.now() } = {}) {
  const report = { merged: [] };
  const facts = mind?.facts;
  if (!facts || typeof facts !== 'object') return report;

  const groups = new Map(); // normValue → [fact]
  for (const fact of Object.values(facts)) {
    if (!fact || fact.status === 'archived') continue;
    if (typeof fact.value !== 'string') continue;      // scalars only
    const norm = fact.value.toLowerCase().trim();
    if (norm.length < 2) continue;
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(fact);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Winner preference: schema key > pinned > supportCount > oldest.
    const rank = (f) =>
      (getSchema(f.key) ? 8 : 0) + (f.pinned ? 4 : 0) +
      Math.min(3, (f.supportCount || 1) - 1) -
      (f.createdAt || 0) / Number.MAX_SAFE_INTEGER; // stable oldest-first tiebreak
    const sorted = [...group].sort((a, b) => rank(b) - rank(a) || (a.createdAt || 0) - (b.createdAt || 0));
    const winner = sorted[0];

    for (const loser of sorted.slice(1)) {
      if (IDENTITY_FACT_KEYS.has(loser.key)) continue; // identity fields stay isolated
      winner.supportCount   = (winner.supportCount || 1) + (loser.supportCount || 1);
      winner.retrievalCount = (winner.retrievalCount || 0) + (loser.retrievalCount || 0);
      winner.confidence     = Math.max(winner.confidence || 0.5, loser.confidence || 0.5);
      winner.pinned         = !!(winner.pinned || loser.pinned);
      winner.lastMentionedAt = Math.max(winner.lastMentionedAt || 0, loser.lastMentionedAt || 0);
      winner.history = [
        ...(winner.history || []),
        { reason: `duplicate_merged:${loser.key}`, value: loser.value, ts: loser.ts, supersededAt: now, revision: loser.revision || 1 },
      ];
      capFactHistory(winner);
      delete facts[loser.key];
      report.merged.push({ winner: winner.key, loser: loser.key });
    }
  }
  return report;
}
