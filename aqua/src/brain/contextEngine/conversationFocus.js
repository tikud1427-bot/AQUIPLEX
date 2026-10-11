/**
 * AQUA — conversation focus: what "this", "it", "they" refer to.
 *
 * "Who owns this?" names nothing. The Context Engine already accepts
 * `priorEntityIds` as graph anchors (index.js gatherCanonicalGraphCandidates),
 * but nothing remembered the previous turn's entities, so a deictic follow-up
 * anchored on nothing. This keeps, per (owner, conversation), the canonical
 * entity ids the LAST turn's context was about, and hands them back only when
 * the next question is deictic.
 *
 * Transient by design: process memory, bounded (G6) — at most MAX_CONVERSATIONS
 * entries, MAX_IDS ids each, TTL_MS old — and purgeable per owner (G4, called
 * from Brain.purgeOwner). Opaque entity ids only; no text, no labels (L8, D3).
 */
const MAX_CONVERSATIONS = 2000;
const MAX_IDS = 8;
const TTL_MS = 30 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEICTIC = /\b(this|that|these|those|it|its|they|them|their|he|she|him|her|the same)\b/i;

const focus = new Map();   // `${owner}\u0000${conversation}` → { ids, at }
const keyOf = (ownerId, conversationId) => `${ownerId}\u0000${conversationId}`;

export const isDeictic = question => DEICTIC.test(String(question ?? ''));

export function rememberFocus(ownerId, conversationId, entityIds = [], now = Date.now()) {
  if (!ownerId || !conversationId) return;
  const ids = [...new Set((entityIds ?? []).map(String).filter(id => UUID_RE.test(id)))].slice(0, MAX_IDS);
  if (!ids.length) return;
  const key = keyOf(ownerId, conversationId);
  focus.delete(key);                         // re-insert = most recent (Map keeps insertion order)
  focus.set(key, { ids, at: now });
  while (focus.size > MAX_CONVERSATIONS) focus.delete(focus.keys().next().value);
}

export function recallFocus(ownerId, conversationId, now = Date.now()) {
  if (!ownerId || !conversationId) return [];
  const hit = focus.get(keyOf(ownerId, conversationId));
  if (!hit) return [];
  if (now - hit.at > TTL_MS) { focus.delete(keyOf(ownerId, conversationId)); return []; }
  return [...hit.ids];
}

export function purgeOwner(ownerId) {
  let n = 0;
  for (const key of [...focus.keys()]) {
    if (key.startsWith(`${ownerId}\u0000`)) { focus.delete(key); n++; }
  }
  return n;
}

export const _sizeForTests = () => focus.size;
