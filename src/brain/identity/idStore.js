/**
 * AQUA Brain — Canonical Identity Sidecar (Phase 1)
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * Delete `.aqua-ids.json` and AQUA loses ZERO knowledge.
 *
 * Same contract as the annotation sidecar, for the same reason. The audit
 * rejected canonical STORAGE — a world model that owns Person/Project/Goal
 * records would be a third copy of knowledge that already lives in the
 * reasoning graph, the Mind, the UKO store and memory facts, and it would
 * mean three things to keep in sync and three things to purge on account
 * deletion. What the architecture actually needed was canonical IDENTITY:
 * one agreed id per real thing, so five stores can keep their own records
 * and still know they are talking about the same subject.
 *
 * So this file holds a MAP, never a record:
 *
 *   aq:person:priya_sharma
 *     kind       person          the best type anyone has supplied so far
 *     canonical  "Priya Sharma"  the fullest surface form seen
 *     norms      [...]           every normalized spelling that resolves here
 *     refs       [{ space, ref }]  where the actual records live
 *
 * `refs` is the whole point. `{ space: 'reasoning', ref: 'ent:name:priya' }`
 * and `{ space: 'mind', ref: 'person:priya' }` on one entry is what lets the
 * projection join by id instead of by string match.
 *
 * Nothing here is knowledge. Delete the file and the id map is rebuilt by
 * the backfill from the source stores; every fact, entity, belief and edge
 * is untouched because none of them ever lived here.
 *
 * Per-owner, bounded, schema-versioned, atomic writes. Same primitives as
 * every other AQUA store.
 */
import {
  createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore,
} from '../../core/atomicStore.js';
import { dataPath } from '../../core/dataDir.js';

const STORE_FILE = dataPath('.aqua-ids.json');
const SCHEMA     = 1;

/**
 * Runaway guards. An identity map is one entry per real thing, so it should
 * stay far below the graph's own 50k node cap — if it approaches it, the
 * resolver is minting ids it should be merging.
 */
const MAX_ENTRIES_PER_OWNER = 20_000;
const MAX_NORMS_PER_ENTRY   = 64;
const MAX_REFS_PER_ENTRY    = 64;

/** ownerKey → Map<aqId, entry> */
const store = new Map();
/**
 * ownerKey → Map<`${kind}|${norm}`, aqId> — derived on load, never persisted.
 *
 * Keyed by kind AND norm, not norm alone. A kind-agnostic index would make
 * the company Mercury and the planet Mercury one subject; a kind-scoped one
 * would stop a document's under-typed `name:priya` from ever meeting chat's
 * `person:priya`. Both cases are handled by keying on the pair and letting
 * the resolver decide which lookups to attempt, in which order.
 */
const normIndex = new Map();

const indexKey = (kind, norm) => `${kind ?? 'name'}|${norm}`;

function bucket(ownerId) {
  const key = ownerId ?? 'anon';
  let b = store.get(key);
  if (!b) { b = new Map(); store.set(key, b); }
  return b;
}

function norms(ownerId) {
  const key = ownerId ?? 'anon';
  let n = normIndex.get(key);
  if (!n) { n = new Map(); normIndex.set(key, n); }
  return n;
}

/** Rebuild the norm→id index for one owner from its entries. */
function reindex(ownerId) {
  const n = norms(ownerId);
  n.clear();
  for (const [id, entry] of bucket(ownerId)) {
    for (const norm of entry.norms ?? []) {
      const k = indexKey(entry.kind, norm);
      if (!n.has(k)) n.set(k, id);
    }
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'ids' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'ids' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, entries] of Object.entries(data)) {
    const b = bucket(owner);
    for (const [id, entry] of Object.entries(entries ?? {})) b.set(id, entry);
    reindex(owner);
  }
  const total = [...store.values()].reduce((a, b) => a + b.size, 0);
  if (total) console.log(`[IDS] Canonical ids loaded: ${total} across ${store.size} owner(s) from ${STORE_FILE}`);
}

const _writer = createDebouncedWriter(STORE_FILE);
function scheduleSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [owner, b] of store.entries()) data[owner] = Object.fromEntries(b);
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

loadFromDisk();

// ── Read ─────────────────────────────────────────────────────────────────────

/** @returns {object|null} the entry for a canonical id, or null. */
export function getEntry(ownerId, id) {
  return bucket(ownerId).get(id) ?? null;
}

/** @returns {Map<string,object>} live map of all entries for an owner — do not mutate. */
export function allEntries(ownerId) {
  return bucket(ownerId);
}

/** @returns {string|null} the id this (kind, spelling) pair resolves to. */
export function findByNorm(ownerId, norm, kind) {
  return norms(ownerId).get(indexKey(kind, norm)) ?? null;
}

/**
 * Any entry carrying this spelling, whatever its kind.
 *
 * Only ever called when the INCOMING mention is itself wildcard-kinded — a
 * document saying "Mercury" with no type has no basis to prefer the company
 * over the planet, so the first registered subject is the honest answer and
 * a genuine collision surfaces as an ambiguity rather than a silent pick.
 */
export function findByNormAnyKind(ownerId, norm) {
  const suffix = `|${norm}`;
  for (const [k, id] of norms(ownerId)) if (k.endsWith(suffix)) return id;
  return null;
}

/** Entries of a given kind, plus wildcard-kinded ones when asked. */
export function entriesOfKind(ownerId, kind, { includeWildcard = null } = {}) {
  const out = [];
  for (const [id, entry] of bucket(ownerId)) {
    if (entry.kind === kind || (includeWildcard && entry.kind === includeWildcard)) {
      out.push({ id, entry });
    }
  }
  return out;
}

/** @returns {Array<{space,ref}>} where this subject's records actually live. */
export function refsOf(ownerId, id) {
  return [...(getEntry(ownerId, id)?.refs ?? [])];
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Create or update an entry.
 *
 * Merge semantics are additive and monotonic in coverage: norms and refs are
 * unioned, `canonical` upgrades to the fuller surface form, and `kind`
 * upgrades away from a wildcard but never sideways — a stored `person` is
 * not overwritten by an incoming `org`, because a genuine type conflict is a
 * resolution error, not something to silently paper over.
 */
export function putEntry(ownerId, id, patch = {}) {
  const b = bucket(ownerId);
  const existing = b.get(id) ?? null;

  if (!existing && b.size >= MAX_ENTRIES_PER_OWNER) {
    console.warn(`[IDS] entry cap reached for ${ownerId} (${MAX_ENTRIES_PER_OWNER}) — not minting ${id}`);
    return null;
  }

  const now = Date.now();
  const mergedNorms = [...new Set([...(existing?.norms ?? []), ...(patch.norms ?? [])])]
    .slice(0, MAX_NORMS_PER_ENTRY);

  const seenRefs = new Set();
  const mergedRefs = [...(existing?.refs ?? []), ...(patch.refs ?? [])]
    .filter(r => {
      if (!r?.space || !r?.ref) return false;
      const k = `${r.space}:${r.ref}`;
      if (seenRefs.has(k)) return false;
      seenRefs.add(k);
      return true;
    })
    .slice(0, MAX_REFS_PER_ENTRY);

  // Prefer the fuller surface form as the display name — same rule the
  // resolver's pickCanonical uses, so the two never disagree.
  const canonical = pickFuller(existing?.canonical, patch.canonical);

  const entry = {
    kind: patch.kind ?? existing?.kind ?? 'name',
    canonical,
    norms: mergedNorms,
    refs: mergedRefs,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  b.set(id, entry);

  // A kind upgrade (name → person) invalidates this entry's old index keys.
  // Drop them before registering the new ones, or the wildcard spelling stays
  // reachable under a kind the entry no longer has.
  const n = norms(ownerId);
  if (existing && existing.kind !== entry.kind) {
    for (const norm of existing.norms ?? []) {
      const stale = indexKey(existing.kind, norm);
      if (n.get(stale) === id) n.delete(stale);
    }
  }
  for (const norm of mergedNorms) {
    const k = indexKey(entry.kind, norm);
    if (!n.has(k)) n.set(k, id);
  }
  scheduleSave();
  return entry;
}

function pickFuller(a, b) {
  if (!a) return b ?? '';
  if (!b) return a;
  return b.length > a.length ? b : a;
}

/** Attach a store reference to a canonical id. Idempotent. */
export function addRef(ownerId, id, { space, ref } = {}) {
  if (!space || !ref) return null;
  const existing = getEntry(ownerId, id);
  if (!existing) return null;
  return putEntry(ownerId, id, { refs: [{ space, ref }] });
}

/** Erasure hook — accountPurge calls this alongside every other store. */
export function purgeOwner(ownerId) {
  const b = store.get(ownerId ?? 'anon');
  const removed = b?.size ?? 0;
  store.delete(ownerId ?? 'anon');
  normIndex.delete(ownerId ?? 'anon');
  if (removed) scheduleSave();
  return removed;
}

export function idStats() {
  let entries = 0;
  for (const b of store.values()) entries += b.size;
  return { owners: store.size, entries, file: STORE_FILE };
}

export function _resetIdsForTests() { store.clear(); normIndex.clear(); }
