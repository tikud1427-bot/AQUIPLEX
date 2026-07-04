/**
 * AQUA Memory Resolver v3
 * ─────────────────────────────────────────────────────────────────────────────
 * Takes normalized, deduped candidates and decides for each:
 *   • STORE_NEW       — no existing fact for this key
 *   • DUPLICATE       — same value as stored (update lastMentionedAt only)
 *   • MERGE           — append to collection (deduped)
 *   • OVERWRITE       — replace scalar value (with history)
 *   • CORRECTION      — explicit overwrite (with history)
 *   • REJECT_LOW_CONF — confidence below existing
 *
 * This is the ONLY place that compares candidates against stored facts.
 */
import { getFact } from './longTermMemory.js';
import { getSchema } from './memorySchema.js';

export const RESOLUTION_ACTIONS = Object.freeze({
  STORE_NEW:       'store_new',
  DUPLICATE:       'duplicate',
  MERGE:           'merge',
  OVERWRITE:       'overwrite',
  CORRECTION:      'correction',
  REJECT_LOW_CONF: 'reject_low_conf',
});

/**
 * Resolve a batch of candidates against existing stored facts.
 *
 * @param {string} conversationId
 * @param {Candidate[]} candidates
 * @returns {ResolvedCandidate[]}
 */
export function resolveCandidates(conversationId, candidates) {
  const resolved = [];
  for (const c of candidates) {
    resolved.push(resolveOne(conversationId, c));
  }
  return resolved;
}

function resolveOne(conversationId, candidate) {
  const existing = getFact(conversationId, candidate.key);
  const schema = getSchema(candidate.key);

  // ── No existing fact → store new ────────────────────────────────────────
  if (!existing) {
    return {
      ...candidate,
      action: RESOLUTION_ACTIONS.STORE_NEW,
      reason: 'no_existing',
    };
  }

  // ── Explicit correction → unconditional overwrite ───────────────────────
  if (candidate.isCorrection) {
    return {
      ...candidate,
      action: RESOLUTION_ACTIONS.CORRECTION,
      reason: 'explicit_correction',
      previousValue: existing.value,
    };
  }

  // ── Collection merge ────────────────────────────────────────────────────
  if (candidate.multiValue || schema?.multiValue) {
    return resolveCollection(candidate, existing);
  }

  // ── Scalar: compare normalized values ───────────────────────────────────
  const existingNorm = normalizeForCompare(existing.value);
  const incomingNorm = normalizeForCompare(candidate.normalizedValue);

  if (existingNorm === incomingNorm) {
    return {
      ...candidate,
      action: RESOLUTION_ACTIONS.DUPLICATE,
      reason: 'identical_value',
    };
  }

  // ── Recency wins ────────────────────────────────────────────────────────
  if ((candidate.ts || 0) > (existing.ts || existing.updatedAt || 0)) {
    return {
      ...candidate,
      action: RESOLUTION_ACTIONS.OVERWRITE,
      reason: 'newer_timestamp',
      previousValue: existing.value,
    };
  }

  // ── Confidence tiebreaker ───────────────────────────────────────────────
  if ((candidate.confidence || 0) > (existing.confidence || 0)) {
    return {
      ...candidate,
      action: RESOLUTION_ACTIONS.OVERWRITE,
      reason: 'higher_confidence',
      previousValue: existing.value,
    };
  }

  // ── Keep existing ───────────────────────────────────────────────────────
  return {
    ...candidate,
    action: RESOLUTION_ACTIONS.REJECT_LOW_CONF,
    reason: 'existing_wins',
  };
}

function resolveCollection(candidate, existing) {
  const existingArr = Array.isArray(existing.value) ? existing.value : [existing.value];
  const incomingArr = Array.isArray(candidate.normalizedValue)
    ? candidate.normalizedValue
    : [candidate.normalizedValue];

  const existingKeys = new Set(existingArr.map(itemIdentityKey));
  const newItems = [];
  const dupItems = [];

  for (const item of incomingArr) {
    const k = itemIdentityKey(item);
    if (existingKeys.has(k)) {
      dupItems.push(item);
    } else {
      newItems.push(item);
    }
  }

  if (newItems.length === 0) {
    // All items already present → duplicate
    return {
      ...candidate,
      action: RESOLUTION_ACTIONS.DUPLICATE,
      reason: 'collection_identical',
      mergedValue: existingArr,
    };
  }

  // Merge: existing + new
  const merged = [...existingArr, ...newItems];
  return {
    ...candidate,
    action: RESOLUTION_ACTIONS.MERGE,
    reason: dupItems.length > 0 ? 'collection_partial_merge' : 'collection_new_items',
    mergedValue: merged,
    addedItems: newItems,
    skippedDuplicates: dupItems,
  };
}

function normalizeForCompare(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.toLowerCase().trim().replace(/\s+/g, ' ');
  if (Array.isArray(v)) return v.map(normalizeForCompare).sort().join('|');
  if (typeof v === 'object') return JSON.stringify(v, Object.keys(v).sort());
  return String(v).toLowerCase();
}

function itemIdentityKey(item) {
  if (item === null || item === undefined) return '';
  if (typeof item !== 'object') return String(item).toLowerCase().trim();
  if (item.type && item.name) return `${item.type}:${item.name}`.toLowerCase();
  const keys = Object.keys(item).sort();
  return keys.map((k) => `${k}=${item[k]}`).join('|').toLowerCase();
}