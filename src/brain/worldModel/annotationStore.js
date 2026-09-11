/**
 * AQUA Brain — Annotation Sidecar (Brain V1 / B2)
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * Delete `.aqua-brain.json` and AQUA loses ZERO knowledge.
 *
 * The PIC established this contract ("PIC state is meta only… no knowledge
 * lives here") and the Brain inherits it. Facts live in evidenceStore.
 * Entities and typed relationships live in reasoningGraph. Beliefs, goals
 * and conversational salience live in the Mind. The world model is a
 * PROJECTION over those owners — a third copy of the same knowledge would
 * mean three things to keep in sync and three things to purge on account
 * deletion, which is exactly the "no parallel stores" failure the PIC
 * architecture was written to avoid.
 *
 * So this store holds only what genuinely cannot be recomputed:
 *
 *   description        curated prose about an entity — nobody derives this
 *   aliases            names a human supplied that no source spelled out
 *   importanceOverride a pin: "this project matters regardless of signals"
 *   confidenceOverride a correction: "yes, that resolution is right"
 *   tags / metadata    caller-supplied labels
 *   pinned             exempt from decay and pruning
 *
 * Everything else — confidence, importance, degree, source counts,
 * timestamps, aliases discovered from the graphs — is derived at read time
 * by projection.js and deliberately NOT persisted here.
 *
 * Per-owner, bounded, schema-versioned, atomic writes. Same primitives as
 * every other AQUA store.
 */
import {
  createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore,
} from '../../core/atomicStore.js';
import { dataPath } from '../../core/dataDir.js';

const STORE_FILE = dataPath('.aqua-brain.json');
const SCHEMA     = 1;

/** Annotations are cheap and human-scale; this cap is a runaway guard. */
const MAX_ANNOTATIONS_PER_OWNER = 5_000;
const MAX_DESCRIPTION_CHARS     = 2_000;
const MAX_ALIASES               = 32;
const MAX_TAGS                  = 24;

/** ownerKey → Map<entityId, annotation> */
const store = new Map();

function bucket(ownerId) {
  const key = ownerId ?? 'anon';
  let b = store.get(key);
  if (!b) { b = new Map(); store.set(key, b); }
  return b;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'brain' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'brain' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, entries] of Object.entries(data)) {
    const b = bucket(owner);
    for (const [id, ann] of Object.entries(entries ?? {})) b.set(id, ann);
  }
  const total = [...store.values()].reduce((a, b) => a + b.size, 0);
  if (total) console.log(`[BRAIN] Annotations loaded: ${total} across ${store.size} owner(s) from ${STORE_FILE}`);
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

/** @returns {object|null} the annotation for an entity, or null. */
export function getAnnotation(ownerId, entityId) {
  return bucket(ownerId).get(entityId) ?? null;
}

/** @returns {Map<string,object>} all annotations for an owner (live map — do not mutate). */
export function allAnnotations(ownerId) {
  return bucket(ownerId);
}

// ── Write ────────────────────────────────────────────────────────────────────

function trimList(list, max) {
  return [...new Set((Array.isArray(list) ? list : []).filter(Boolean).map(v => String(v).trim()).filter(Boolean))].slice(0, max);
}

/**
 * Create or merge an annotation. Merge semantics, not replace: aliases and
 * tags union, scalars overwrite only when the patch actually supplies them,
 * so a caller setting `pinned` never silently drops someone's description.
 *
 * Overrides are stored as-is and applied by projection.js. Passing null for
 * an override clears it and hands the field back to the derived value.
 *
 * @param {string} ownerId
 * @param {string} entityId
 * @param {object} patch - { description?, aliases?, tags?, metadata?,
 *                           importanceOverride?, confidenceOverride?, pinned? }
 * @returns {object|null} the stored annotation, or null when rejected
 */
export function annotate(ownerId, entityId, patch = {}) {
  if (!entityId) return null;
  const b = bucket(ownerId);
  const existing = b.get(entityId);
  if (!existing && b.size >= MAX_ANNOTATIONS_PER_OWNER) return null;

  const now = Date.now();
  const next = {
    entityId,
    description: 'description' in patch
      ? String(patch.description ?? '').slice(0, MAX_DESCRIPTION_CHARS)
      : (existing?.description ?? ''),
    aliases: trimList([...(existing?.aliases ?? []), ...(patch.aliases ?? [])], MAX_ALIASES),
    tags: trimList([...(existing?.tags ?? []), ...(patch.tags ?? [])], MAX_TAGS),
    metadata: { ...(existing?.metadata ?? {}), ...(patch.metadata ?? {}) },
    importanceOverride: 'importanceOverride' in patch ? normOverride(patch.importanceOverride) : (existing?.importanceOverride ?? null),
    confidenceOverride: 'confidenceOverride' in patch ? normOverride(patch.confidenceOverride) : (existing?.confidenceOverride ?? null),
    pinned: 'pinned' in patch ? !!patch.pinned : (existing?.pinned ?? false),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  b.set(entityId, next);
  scheduleSave();
  return next;
}

function normOverride(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Remove one annotation. The entity itself is untouched — it lives elsewhere. */
export function removeAnnotation(ownerId, entityId) {
  const b = bucket(ownerId);
  const had = b.delete(entityId);
  if (had) scheduleSave();
  return had;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Account deletion. Registered by B3 into the account purge sequence; until
 * then the sidecar holds no knowledge, so nothing is orphaned by its absence.
 */
export function purgeOwner(ownerId) {
  const key = ownerId ?? 'anon';
  const b = store.get(key);
  if (!b) return { annotations: 0 };
  const removed = { annotations: b.size };
  store.delete(key);
  scheduleSave();
  return removed;
}

export function annotationStats() {
  let total = 0, pinned = 0;
  for (const b of store.values()) for (const a of b.values()) { total++; if (a.pinned) pinned++; }
  return { owners: store.size, annotations: total, pinned };
}

export function _resetAnnotationsForTests() { store.clear(); }