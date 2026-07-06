/**
 * AQUA Long-Term Memory — Fact Layer v4 (UNIFIED)
 * ─────────────────────────────────────────────────────────────────────────────
 * v4: facts live INSIDE the unified Mind store (`mind.facts`), keyed by
 * ownerId (see memory/ownerResolver.js). This module owns fact lifecycle —
 * conflict resolution, revision history, confidence, contradiction tracking —
 * but NOT persistence: mindStore.js is the single writer (.aqua-mind.json).
 *
 *   • ONE store        — no more .aqua-memory.json (see migrate.js)
 *   • ONE owner model  — ownerId (`user:<id>` | `conv:<id>`), never a bare
 *                        conversationId as a permanent key
 *   • Contradictions   — differing values update confidence + history +
 *                        contradiction count; never a blind overwrite
 *   • Support          — repeated identical evidence raises confidence
 *
 * API shape unchanged (first param was always a string key) → every caller
 * and existing test keeps working; the key is now an ownerId.
 */
import { getMind, peekMind, touchMind } from '../mind/mindStore.js';
import { resolveMemoryConflict } from './memoryConflictResolver.js';
import { RESOLUTION_ACTIONS } from './memoryResolver.js';

const MIN_CONF = 0.5;
// Confidence penalty per prior supporting observation when a contradiction
// (non-correction overwrite) arrives — the more established the old value,
// the less certain the new one starts out. Capped so recency still wins.
const CONTRADICTION_PENALTY_PER_SUPPORT = 0.03;
const CONTRADICTION_PENALTY_CAP = 0.15;

function factsOf(ownerId, { create = true } = {}) {
  if (!ownerId) return null;
  const mind = create ? getMind(ownerId) : peekMind(ownerId);
  if (!mind) return null;
  if (!mind.facts) mind.facts = {};
  return mind;
}

function buildVersionHistory(existing, reason) {
  const prevHistory = Array.isArray(existing.history) ? existing.history : [];
  return [
    ...prevHistory,
    {
      value: existing.value,
      normalizedValue: existing.normalizedValue ?? existing.value,
      ts: existing.ts,
      supersededAt: Date.now(),
      confidence: existing.confidence ?? 0.5,
      reason,
      sourceMessage: existing.sourceMessage || existing.sourceText || '',
      revision: existing.revision || 1,
    },
  ];
}

function makeFactId(ownerId, key) {
  return `${ownerId}:${key}`;
}

function upgradeFact(fact, ownerId) {
  const now = Date.now();
  return {
    id: fact.id || makeFactId(ownerId, fact.key),
    category: fact.category || null,
    key: fact.key,
    value: fact.value,
    normalizedValue: fact.normalizedValue ?? fact.value,
    confidence: fact.confidence ?? 0.5,
    importance: fact.importance ?? 5,
    createdAt: fact.createdAt || fact.ts || now,
    updatedAt: fact.updatedAt || fact.ts || now,
    lastMentionedAt: fact.lastMentionedAt || fact.ts || now,
    ts: fact.ts || now,
    sourceConversation: fact.sourceConversation || null,
    sourceMessage: fact.sourceMessage || fact.sourceText || '',
    sourceText: fact.sourceText || fact.sourceMessage || '',
    metadata: fact.metadata || {},
    revision: fact.revision ?? 1,
    history: Array.isArray(fact.history) ? fact.history : [],
    status: fact.status || 'active',
    supportCount: fact.supportCount ?? 1,       // observations agreeing with value
    contradictions: fact.contradictions ?? 0,   // times a different value arrived
  };
}

/** Reinforce: identical evidence seen again. */
function reinforce(existing, now) {
  existing.updatedAt = now;
  existing.lastMentionedAt = now;
  existing.ts = now;
  existing.confidence = Math.min(1.0, (existing.confidence || 0.5) + 0.05);
  existing.supportCount = (existing.supportCount || 1) + 1;
}

/**
 * Contradiction-aware confidence for a value REPLACING an established one.
 * Not a blind overwrite: the incoming confidence is damped in proportion to
 * how well-supported the previous value was (Acceptance Test 15). Explicit
 * corrections are exempt — the user said so.
 */
function contradictionConfidence(candidateConf, existing) {
  const penalty = Math.min(
    CONTRADICTION_PENALTY_CAP,
    (existing.supportCount || 1) * CONTRADICTION_PENALTY_PER_SUPPORT
  );
  return Math.max(MIN_CONF, (candidateConf ?? 0.5) - penalty);
}

export function storeFact(ownerId, fact, { trace = null } = {}) {
  if (!fact || (fact.confidence ?? 0) < MIN_CONF) {
    trace?.rejected?.push({ key: fact?.key, reason: 'below_min_confidence' });
    return;
  }
  const mind = factsOf(ownerId);
  if (!mind) return;
  const existing = mind.facts[fact.key] ?? null;
  const now = Date.now();

  if (fact.action && Object.values(RESOLUTION_ACTIONS).includes(fact.action)) {
    return storeResolved(ownerId, fact, { trace });
  }

  const { action, reason } = resolveMemoryConflict(fact, existing);
  console.log(`[LTM] CONFLICT_RESOLVED owner=${ownerId} key=${fact.key} action=${action} reason=${reason}`);
  trace?.actions?.push({ key: fact.key, action, reason });

  if (action === 'keep' && reason === 'identical_value' && existing) {
    reinforce(existing, now);
    touchMind(mind);
    return;
  }

  if (action === 'keep') return;

  const history = existing ? buildVersionHistory(existing, reason) : [];
  const { isCorrection, action: _drop2, ...persistableFact } = fact;
  const upgraded = upgradeFact(persistableFact, ownerId);
  upgraded.history = history;

  if (existing) {
    upgraded.revision = (existing.revision || 1) + 1;
    upgraded.createdAt = existing.createdAt || upgraded.createdAt;
    upgraded.contradictions = (existing.contradictions || 0) + 1;
    upgraded.supportCount = 1; // fresh value starts its own support count
    if (!isCorrection) {
      upgraded.confidence = contradictionConfidence(fact.confidence, existing);
    }
  }

  mind.facts[fact.key] = upgraded;
  touchMind(mind);
}

export function storeResolved(ownerId, resolved, { trace = null } = {}) {
  if (!resolved || (resolved.confidence ?? 0) < MIN_CONF) {
    trace?.rejected?.push({ key: resolved?.key, reason: 'below_min_confidence' });
    return;
  }
  const mind = factsOf(ownerId);
  if (!mind) return;
  const existing = mind.facts[resolved.key] ?? null;
  const now = Date.now();
  trace?.actions?.push({ key: resolved.key, action: resolved.action, reason: resolved.reason });

  switch (resolved.action) {
    case RESOLUTION_ACTIONS.DUPLICATE: {
      if (existing) {
        reinforce(existing, now);
        touchMind(mind);
      }
      return;
    }
    case RESOLUTION_ACTIONS.MERGE: {
      // The legacy-fact mapper (memoryExtractor.toLegacyFact) folds the merged
      // collection into `value` and does NOT carry `mergedValue` through, so a
      // cross-message merge arriving via the observe pipeline has mergedValue
      // === undefined. Fall back to `value` so the merged array is actually
      // persisted (previously this stored a valueless fact — the collection was
      // silently lost on the SECOND mention).
      const merged = resolved.mergedValue !== undefined ? resolved.mergedValue : resolved.value;
      const history = existing ? buildVersionHistory(existing, 'collection_merge') : [];
      const upgraded = upgradeFact({ ...resolved, value: merged, normalizedValue: merged }, ownerId);
      upgraded.history = history;
      upgraded.revision = (existing?.revision || 0) + 1;
      upgraded.createdAt = existing?.createdAt || now;
      upgraded.lastMentionedAt = now;
      upgraded.supportCount = (existing?.supportCount || 0) + 1;
      upgraded.contradictions = existing?.contradictions || 0;
      mind.facts[resolved.key] = upgraded;
      touchMind(mind);
      return;
    }
    case RESOLUTION_ACTIONS.OVERWRITE:
    case RESOLUTION_ACTIONS.CORRECTION: {
      const history = existing ? buildVersionHistory(existing, resolved.reason) : [];
      const upgraded = upgradeFact(resolved, ownerId);
      upgraded.history = history;
      upgraded.revision = (existing?.revision || 0) + 1;
      upgraded.createdAt = existing?.createdAt || now;
      upgraded.lastMentionedAt = now;
      if (existing) {
        upgraded.contradictions = (existing.contradictions || 0) + 1;
        upgraded.supportCount = 1;
        if (resolved.action === RESOLUTION_ACTIONS.OVERWRITE) {
          upgraded.confidence = contradictionConfidence(resolved.confidence, existing);
        }
      }
      mind.facts[resolved.key] = upgraded;
      touchMind(mind);
      return;
    }
    default: {
      const upgraded = upgradeFact(resolved, ownerId);
      upgraded.createdAt = now;
      upgraded.lastMentionedAt = now;
      mind.facts[resolved.key] = upgraded;
      touchMind(mind);
      return;
    }
  }
}

export function getFacts(ownerId) {
  const mind = factsOf(ownerId, { create: false });
  if (!mind || !Object.keys(mind.facts).length) return [];
  return Object.values(mind.facts).sort((a, b) => (b.importance || 0) - (a.importance || 0));
}

export function getFact(ownerId, key) {
  const mind = factsOf(ownerId, { create: false });
  return mind?.facts?.[key] ?? null;
}

export function clearFacts(ownerId) {
  const mind = factsOf(ownerId, { create: false });
  if (!mind) return;
  mind.facts = {};
  touchMind(mind);
}

export function storeFacts(ownerId, facts = [], { trace = null } = {}) {
  if (!Array.isArray(facts)) return;
  for (const fact of facts) {
    storeFact(ownerId, fact, { trace });
  }
}

export function deleteFact(ownerId, key) {
  const mind = factsOf(ownerId, { create: false });
  if (!mind || !(key in mind.facts)) return false;
  delete mind.facts[key];
  touchMind(mind);
  return true;
}

export function getFactHistory(ownerId, key) {
  const fact = getFact(ownerId, key);
  if (!fact) return [];
  return Array.isArray(fact.history) ? fact.history : [];
}

export function getMemoryStats() {
  // Unified: iterate minds via the single store.
  let owners = 0;
  let facts = 0;
  let contradictions = 0;
  for (const mind of _allMinds()) {
    const f = Object.values(mind.facts || {});
    if (f.length) owners++;
    facts += f.length;
    for (const fact of f) contradictions += fact.contradictions || 0;
  }
  return { owners, facts, contradictions };
}

// Internal: enumerate minds without exporting the raw map from mindStore.
import { _iterateMindsForStats } from '../mind/mindStore.js';
function _allMinds() { return _iterateMindsForStats(); }
