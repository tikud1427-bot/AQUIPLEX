/**
 * AQUA Mind Store
 * ─────────────────────────────────────────────────────────────────────────────
 * USER-scoped persistence for cognitive models. One Mind per owner.
 *
 * Deliberately mirrors the proven longTermMemory/conversationStore pattern:
 * in-memory Map + debounced JSON file write. Single file (.aqua-mind.json)
 * per engineering requirement "avoid duplicate storage" — subsystems are
 * modular in CODE, unified in PERSISTENCE.
 *
 * Owner resolution (see resolveMindOwner):
 *   platform session → `user:<aquaUserId>`  (cross-conversation, the real goal)
 *   engine run bare  → `conv:<conversationId>` fallback so the Mind still
 *                      works in dev/demo without the platform session layer.
 *
 * NOTE (scaling / migration path): the Map+file store is the same tier the
 * rest of AQUA persistence currently uses. All access goes through this
 * module's API, so swapping to SQLite/Postgres later touches ONE file.
 */
import fs   from 'fs';
import path from 'path';
import { createEmptyMind } from './mindSchema.js';
import { createDebouncedWriter } from '../core/atomicStore.js';

const STORE_FILE = path.join(process.cwd(), '.aqua-mind.json');

// ownerId → Mind
const store = new Map();
let loaded = false;

function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const [ownerId, mind] of Object.entries(data)) store.set(ownerId, upgradeMind(mind));
    console.log(`[MIND] Loaded ${store.size} cognitive models from disk`);
  } catch (err) {
    console.warn('[MIND] Could not load from disk:', err.message);
  }
}

// Phase 3b — atomic + async persistence via the shared primitive. Crash-safe
// (temp+rename) and non-blocking; serialize snapshots at flush time.
const _writer = createDebouncedWriter(STORE_FILE);
function scheduleSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [ownerId, mind] of store.entries()) data[ownerId] = mind;
    return JSON.stringify(data);
  });
}
loadFromDisk();

/** Schema v1 → v2: facts + files live INSIDE the mind (single store). */
function upgradeMind(mind) {
  if (!mind) return mind;
  if (!mind.facts) mind.facts = {};
  if (!mind.files) mind.files = {};
  if (!mind.version || mind.version < 2) mind.version = 2;
  return mind;
}

/**
 * Resolve which Mind a request belongs to.
 * DEPRECATED shim — the ONE owner model now lives in memory/ownerResolver.js
 * (which also performs conv→user adoption). Kept for mindRoutes/back-compat;
 * logic identical, no adoption side effects here.
 */
export function resolveMindOwner({ userId = null, conversationId = null } = {}) {
  if (userId) return `user:${userId}`;
  if (conversationId) return `conv:${conversationId}`;
  return null;
}

/**
 * One-time adoption: merge a pre-login `conv:` mind into the real `user:`
 * mind, then tombstone the source. Facts merge via longTermMemory's conflict
 * resolver (caller wires that — see ownerResolver) is NOT needed here:
 * fact-level merge uses simple newer/higher-confidence-wins to avoid a
 * circular import; the same priority order the resolver applies.
 */
export function adoptMind(fromOwner, toOwner) {
  const src = store.get(fromOwner);
  if (!src || src.adoptedInto) return false;
  const dst = getMind(toOwner);

  // Facts: keep whichever is newer, else higher confidence. History preserved.
  for (const [key, fact] of Object.entries(src.facts || {})) {
    const existing = dst.facts[key];
    if (!existing) { dst.facts[key] = fact; continue; }
    const factTs = fact.ts || fact.updatedAt || 0;
    const exTs   = existing.ts || existing.updatedAt || 0;
    const incomingWins = factTs > exTs ||
      (factTs === exTs && (fact.confidence || 0) > (existing.confidence || 0));
    if (incomingWins) {
      fact.history = [...(existing.history || []), ...(fact.history || [])];
      fact.revision = Math.max(fact.revision || 1, (existing.revision || 1) + 1);
      dst.facts[key] = fact;
    }
  }

  // Beliefs: higher confidence wins; evidence concatenated (capped later by reflection).
  for (const [key, belief] of Object.entries(src.beliefs || {})) {
    const existing = dst.beliefs[key];
    if (!existing || (belief.confidence || 0) > (existing.confidence || 0)) {
      if (existing) belief.evidence = [...(existing.evidence || []), ...(belief.evidence || [])];
      dst.beliefs[key] = belief;
    }
  }

  // Goals / episodes / files: union, existing wins on id collision.
  for (const bag of ['goals', 'episodes', 'files']) {
    for (const [id, item] of Object.entries(src[bag] || {})) {
      if (!dst[bag][id]) dst[bag][id] = item;
    }
  }

  // Graph: union nodes/edges, weights added.
  for (const [k, n] of Object.entries(src.graph?.nodes || {})) {
    if (dst.graph.nodes[k]) dst.graph.nodes[k].weight += n.weight || 1;
    else dst.graph.nodes[k] = n;
  }
  for (const [k, e] of Object.entries(src.graph?.edges || {})) {
    if (dst.graph.edges[k]) dst.graph.edges[k].weight += e.weight || 1;
    else dst.graph.edges[k] = e;
  }

  dst.turnCount += src.turnCount || 0;
  src.adoptedInto = toOwner;
  src.adoptedAt = Date.now();
  touchMind(dst);
  scheduleSave();
  console.log(`[MIND] ADOPTED ${fromOwner} → ${toOwner} facts=${Object.keys(src.facts || {}).length} beliefs=${Object.keys(src.beliefs || {}).length}`);
  return true;
}

export function getMind(ownerId) {
  if (!ownerId) return null;
  let mind = store.get(ownerId);
  if (!mind) {
    mind = createEmptyMind(ownerId);
    store.set(ownerId, mind);
    console.log(`[MIND] MIND_CREATED owner=${ownerId}`);
  }
  return mind;
}

export function peekMind(ownerId) {
  return ownerId ? (store.get(ownerId) ?? null) : null;
}

/** Mark mutated + persist. Every subsystem calls this after writing. */
export function touchMind(mind) {
  if (!mind) return;
  mind.updatedAt = Date.now();
  scheduleSave();
}

export function deleteMind(ownerId) {
  const existed = store.delete(ownerId);
  if (existed) scheduleSave();
  return existed;
}

/** Layer 19 — full export. The user owns the model. */
export function exportMind(ownerId) {
  const mind = peekMind(ownerId);
  return mind ? JSON.parse(JSON.stringify(mind)) : null;
}

export function mindStats() {
  let beliefs = 0, goals = 0, episodes = 0;
  for (const m of store.values()) {
    beliefs  += Object.keys(m.beliefs  || {}).length;
    goals    += Object.keys(m.goals    || {}).length;
    episodes += Object.keys(m.episodes || {}).length;
  }
  return { minds: store.size, beliefs, goals, episodes };
}

/** Internal: stats iteration for the unified fact layer (longTermMemory). */
export function _iterateMindsForStats() {
  return store.values();
}

/** Test-only: reset in-memory state (does not touch disk). */
export function _clearAllForTests() {
  store.clear();
}
