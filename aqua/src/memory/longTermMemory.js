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
import { getMind, peekMind, touchMind, deleteItem } from '../mind/mindStore.js';
import { resolveMemoryConflict } from './memoryConflictResolver.js';
import { RESOLUTION_ACTIONS } from './memoryResolver.js';
import { CAPS } from '../mind/mindSchema.js';

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
  const history = [
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
  // Phase A bug fix: CAPS.HISTORY_PER_ITEM existed but was never enforced on
  // the fact layer — history grew unbounded. Keep the newest N revisions.
  if (history.length > CAPS.HISTORY_PER_ITEM) {
    history.splice(0, history.length - CAPS.HISTORY_PER_ITEM);
  }
  return history;
}

/**
 * Memory 5.1 — additive export for memoryEditor.js. Same revision shape,
 * same HISTORY_PER_ITEM cap, one implementation. Editing operations that
 * mutate a fact outside storeFact/storeResolved (merge, split, archive)
 * snapshot the pre-edit state through THIS so "never silently overwrite"
 * holds for every write path in the system.
 */
export function buildRevisionHistory(existing, reason) {
  return buildVersionHistory(existing, reason);
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
    // Phase A — lifecycle fields (importanceEngine)
    baseImportance: fact.baseImportance ?? fact.importance ?? 5,
    retrievalCount: fact.retrievalCount ?? 0,   // times retrieval injected it
    lastRetrievedAt: fact.lastRetrievedAt ?? null,
    pinned: fact.pinned ?? false,               // exempt from archive, floor-8 importance
    // memory/sensitivity.js: 'health' | 'mood' | null. Tagged at write (opt-in)
    // or by scripts/backfill-sensitivity.mjs; reads also classify untagged text.
    sensitivity: fact.sensitivity ?? null,
    sensitivityReviewedAt: fact.sensitivityReviewedAt ?? null,   // "Keep" on the Memory page
  };
}

/** Reinforce: identical evidence seen again. Re-mention also REACTIVATES a
 *  cold (archived) fact — Phase A "reactivation on demand". */
function reinforce(existing, now) {
  existing.updatedAt = now;
  existing.lastMentionedAt = now;
  existing.ts = now;
  existing.confidence = Math.min(1.0, (existing.confidence || 0.5) + 0.05);
  existing.supportCount = (existing.supportCount || 1) + 1;
  if (existing.status === 'archived') {
    existing.status = 'active';
    delete existing.archivedAt;
  }
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
  // The record of earlier changes (memory/propagation.js) belongs to the fact, not to one value of it.
  if (existing?.transitions?.length) upgraded.transitions = existing.transitions;
  // Phase A: an explicit correction is the user saying "remember this" —
  // pin it (archive-exempt, importance floor). Pins survive later overwrites.
  upgraded.pinned = upgraded.pinned || !!existing?.pinned || !!isCorrection;

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
        // Restated as it was: the earlier later-word is no longer the last word.
        if (existing.laterWord) { (existing.laterWords ??= []).push(existing.laterWord); delete existing.laterWord; }
        // Restated without a hedge: the user now says it plainly — confirmed.
        if (existing.metadata?.hedged && !resolved.metadata?.hedged) delete existing.metadata.hedged;
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
      if (existing?.transitions?.length) upgraded.transitions = existing.transitions;
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
      if (existing?.transitions?.length) upgraded.transitions = existing.transitions;
      upgraded.revision = (existing?.revision || 0) + 1;
      upgraded.createdAt = existing?.createdAt || now;
      upgraded.lastMentionedAt = now;
      upgraded.pinned = upgraded.pinned || !!existing?.pinned ||
        resolved.action === RESOLUTION_ACTIONS.CORRECTION;
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

/**
 * Facts for an owner, importance-sorted. Archived (cold) facts are excluded
 * by default — they left the active working set at reflection and only a
 * re-mention (reinforce/overwrite) brings them back. Pass includeArchived
 * for inspector/export views.
 */
export function getFacts(ownerId, { includeArchived = false } = {}) {
  const mind = factsOf(ownerId, { create: false });
  if (!mind || !Object.keys(mind.facts).length) return [];
  let facts = Object.values(mind.facts);
  if (!includeArchived) facts = facts.filter(f => f.status !== 'archived');
  return facts.sort((a, b) => (b.importance || 0) - (a.importance || 0));
}

/**
 * Phase A — retrieval usage feedback. The retriever reports which facts it
 * actually injected; usage feeds computeImportance (a fact the system keeps
 * needing is important, whatever extraction guessed). One touchMind per call.
 */
export function touchRetrieved(ownerId, keys = []) {
  if (!keys.length) return;
  const mind = factsOf(ownerId, { create: false });
  if (!mind) return;
  const now = Date.now();
  let touched = false;
  for (const key of keys) {
    const fact = mind.facts[key];
    if (!fact) continue;
    fact.retrievalCount = (fact.retrievalCount || 0) + 1;
    fact.lastRetrievedAt = now;
    touched = true;
  }
  if (touched) touchMind(mind);
}

/**
 * The user's later word on a fact (memory/factChange.js laterWordsOnFacts):
 * their own sentence that ended, resolved or changed it, with when and which.
 * The value is NOT changed — it stays as what was true before — and earlier
 * later-words are kept in `laterWords`. A new value for the key (correction,
 * overwrite, merge) replaces the whole fact and so clears it; restating the
 * same value clears it too (storeResolved DUPLICATE).
 * @returns {boolean} whether anything changed
 */
export function noteLaterWord(ownerId, key, { text, kind, at = Date.now() } = {}) {
  const mind = factsOf(ownerId, { create: false });
  const fact = mind?.facts?.[key];
  if (!fact || !text || fact.laterWord?.text === text) return false;
  if (fact.laterWord) (fact.laterWords ??= []).push(fact.laterWord);
  if (fact.laterWords?.length > 10) fact.laterWords.splice(0, fact.laterWords.length - 10);
  fact.laterWord = { text: String(text).slice(0, 200), kind, at };
  touchMind(mind);
  return true;
}

/**
 * Apply a resolved later word (memory/factChange.js resolveCurrentState) to
 * the CURRENT state, keeping everything that was true before:
 *   replace  value ← the user's new value; the old one is a revision in
 *            `history` (buildVersionHistory) and a `transitions` entry
 *            {from, to, kind, text, at}
 *   end      the fact is kept with `ended` = {text, kind, at} (not current);
 *            for a collection only the linked item retires, to `retiredItems`
 *   scoped   a separate fact `<key>__<scope>` holds the narrower value; the
 *            broader fact is untouched
 * Provenance: `sourceText` is the user's sentence; confidence of a replaced
 * value is that of an explicit statement (0.9).
 * @returns {string|null} the key written, or null when nothing changed
 */
export function applyCurrentState(ownerId, key, resolved, { text, kind, item = null, at = Date.now() } = {}) {
  const mind = factsOf(ownerId, { create: false });
  const fact = mind?.facts?.[key];
  if (!fact || !resolved) return null;
  const transition = (from, to) => { (fact.transitions ??= []).push({ from, to, kind, text, at }); if (fact.transitions.length > 10) fact.transitions.shift(); };
  if (resolved.action === 'replace' && !Array.isArray(fact.value)) {
    const from = fact.value;
    fact.history = buildVersionHistory(fact, `later_word:${kind}`);
    fact.value = resolved.value;
    fact.normalizedValue = resolved.value;
    fact.sourceText = text;
    fact.sourceMessage = text;
    fact.ts = at;
    fact.updatedAt = at;
    fact.lastMentionedAt = at;
    fact.revision = (fact.revision || 1) + 1;
    fact.confidence = Math.max(fact.confidence ?? 0, 0.9);
    delete fact.laterWord;
    delete fact.ended;
    transition(from, resolved.value);
  } else if (resolved.action === 'end') {
    if (Array.isArray(fact.value) && item != null) {
      fact.history = buildVersionHistory(fact, `later_word:${kind}`);
      fact.value = fact.value.filter(v => v !== item);
      (fact.retiredItems ??= []).push({ item, text, kind, at });
      if (!fact.value.length) fact.ended = { text, kind, at };
    } else {
      fact.history = buildVersionHistory(fact, `later_word:${kind}`);
      fact.ended = { text, kind, at };
    }
    delete fact.laterWord;
    fact.updatedAt = at;
  } else if (resolved.action === 'scoped') {
    const slug = String(resolved.scope).toLowerCase().replace(/^(?:for|with|to|on|only)\s+/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    const scopedKey = `${key}__${slug}`;
    const existing = mind.facts[scopedKey];
    mind.facts[scopedKey] = {
      ...(existing ?? {}), id: `${ownerId}:${scopedKey}`, key: scopedKey, category: fact.category, value: resolved.value, normalizedValue: resolved.value,
      scope: resolved.scope.replace(/^(?:only\s+)?(?:for|with|to|on)\s+/i, ''), scopeOf: key,
      confidence: 0.9, importance: fact.importance ?? 6, sourceText: text, sourceMessage: text, ts: at, createdAt: existing?.createdAt ?? at, updatedAt: at,
      lastMentionedAt: at, revision: (existing?.revision || 0) + 1, history: existing ? buildVersionHistory(existing, `later_word:${kind}`) : [],
      supportCount: 1, status: 'active',
    };
    touchMind(mind);
    return scopedKey;
  } else {
    return null;
  }
  touchMind(mind);
  return key;
}

export function getFact(ownerId, key) {
  const mind = factsOf(ownerId, { create: false });
  return mind?.facts?.[key] ?? null;
}

export function clearFacts(ownerId) {
  const mind = factsOf(ownerId, { create: false });
  if (!mind) return;
  // Each key leaves a tombstone: a bare reset is undone by the other process's
  // next flush (mind/mindStore.js — DELETIONS THAT HOLD ACROSS PROCESSES).
  for (const key of Object.keys(mind.facts)) deleteItem(mind, 'facts', key);
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
  deleteItem(mind, 'facts', key);
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
