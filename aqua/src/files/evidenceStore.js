/**
 * AQUA Evidence Store — Phase 2
 *
 * Persistence + SHARING for Evidence and Facts. The performance rule the
 * brief demands ("share evidence between facts, avoid duplication") is
 * enforced here structurally: Evidence is stored once per checksum;
 * saveEvidence() of an identical locator returns the existing object.
 * Facts reference evidence by ID, so N facts citing one table row cost one
 * Evidence record and N short id references — never N copies.
 *
 * Layout, per owner:
 *   evidence: Map<evidenceId, Evidence>
 *   byChecksum: Map<checksum, evidenceId>          (dedup index)
 *   facts:    Map<factId, Fact>
 *   byFile:   Map<ukoId, { facts:Set, evidence:Set }>   (retrieval + cascade delete)
 *   evidenceRefs: Map<evidenceId, Set<factId>>     (orphan detection; shared-evidence GC)
 *
 * These maps ARE the Evidence Graph's edge tables — the interfaces
 * (evidenceForFact, factsForEvidence, evidenceForFile, factsForFile) are
 * the graph traversal surface later phases build reasoning on. This phase
 * ships the edges + lookups; it does NOT traverse them for inference.
 *
 * Persisted through the standard atomicStore + dataDir primitives
 * (schema-versioned, Mongo mirror for free), bounded per owner.
 */
import {
  createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore,
} from '../core/atomicStore.js';
import { dataPath } from '../core/dataDir.js';
import { evidenceChecksum } from './evidence.js';

const STORE_FILE = dataPath('.aqua-evidence.json');
const SCHEMA     = 1;

const MAX_FACTS_PER_OWNER    = 5000;
const MAX_EVIDENCE_PER_OWNER = 8000;

/** ownerKey → owner bucket */
const store = new Map();

function bucket(ownerId) {
  const key = ownerId ?? 'anon';
  let b = store.get(key);
  if (!b) {
    b = { evidence: new Map(), byChecksum: new Map(), facts: new Map(), byFile: new Map(), evidenceRefs: new Map() };
    store.set(key, b);
  }
  return b;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'evidence' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'evidence' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, b] of Object.entries(data)) {
    const bk = bucket(owner);
    for (const ev of Object.values(b.evidence ?? {})) { bk.evidence.set(ev.id, ev); bk.byChecksum.set(ev.checksum, ev.id); }
    for (const f of Object.values(b.facts ?? {}))     { bk.facts.set(f.id, f); }
    for (const [file, links] of Object.entries(b.byFile ?? {})) {
      bk.byFile.set(file, { facts: new Set(links.facts ?? []), evidence: new Set(links.evidence ?? []) });
    }
    for (const [evId, factIds] of Object.entries(b.evidenceRefs ?? {})) bk.evidenceRefs.set(evId, new Set(factIds));
  }
  const totals = [...store.values()].reduce((a, b) => ({ e: a.e + b.evidence.size, f: a.f + b.facts.size }), { e: 0, f: 0 });
  if (totals.e || totals.f) console.log(`[EVIDENCE] Loaded ${totals.f} fact(s), ${totals.e} evidence object(s) across ${store.size} owner(s) from ${STORE_FILE}`);
}

const _writer = createDebouncedWriter(STORE_FILE);
function scheduleSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [owner, b] of store.entries()) {
      data[owner] = {
        evidence: Object.fromEntries(b.evidence),
        facts:    Object.fromEntries(b.facts),
        byFile:   Object.fromEntries([...b.byFile].map(([k, v]) => [k, { facts: [...v.facts], evidence: [...v.evidence] }])),
        evidenceRefs: Object.fromEntries([...b.evidenceRefs].map(([k, v]) => [k, [...v]])),
      };
    }
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

loadFromDisk();

// ── Write (with dedup/sharing) ───────────────────────────────────────────────

/**
 * Store an Evidence object, or return the existing one with the same
 * checksum. This is where sharing happens — callers always use the
 * returned object's id.
 */
export function saveEvidence(ownerId, evidence) {
  const b = bucket(ownerId);
  const existingId = b.byChecksum.get(evidence.checksum);
  if (existingId) return b.evidence.get(existingId);

  if (b.evidence.size >= MAX_EVIDENCE_PER_OWNER) evictOldestEvidence(b);
  b.evidence.set(evidence.id, evidence);
  b.byChecksum.set(evidence.checksum, evidence.id);
  if (!b.evidenceRefs.has(evidence.id)) b.evidenceRefs.set(evidence.id, new Set());
  linkFile(b, evidence.sourceFileId).evidence.add(evidence.id);
  scheduleSave();
  return evidence;
}

/**
 * Store a Fact and wire its evidence edges. Evidence ids in the fact that
 * don't exist in the store are dropped from the ref graph but kept on the
 * fact (validator flags them as broken references — we never silently
 * rewrite a fact's claim).
 */
export function saveFact(ownerId, fact, { sourceFileId = null } = {}) {
  const b = bucket(ownerId);
  if (b.facts.size >= MAX_FACTS_PER_OWNER && !b.facts.has(fact.id)) evictOldestFact(b);

  b.facts.set(fact.id, fact);
  const fileId = sourceFileId ?? sourceFileOf(b, fact);
  if (fileId) linkFile(b, fileId).facts.add(fact.id);

  for (const evId of fact.evidence) {
    const refs = b.evidenceRefs.get(evId);
    if (refs) refs.add(fact.id);   // only real evidence gets an edge
  }
  scheduleSave();
  return fact;
}

function linkFile(b, fileId) {
  let links = b.byFile.get(fileId);
  if (!links) { links = { facts: new Set(), evidence: new Set() }; b.byFile.set(fileId, links); }
  return links;
}

function sourceFileOf(b, fact) {
  for (const evId of fact.evidence) {
    const ev = b.evidence.get(evId);
    if (ev) return ev.sourceFileId;
  }
  return null;
}

// ── Evidence Graph interfaces (edges only; no traversal-reasoning this phase) ─

export function getEvidence(ownerId, evidenceId) { return bucket(ownerId).evidence.get(evidenceId) ?? null; }
export function getFact(ownerId, factId)         { return bucket(ownerId).facts.get(factId) ?? null; }

/** Fact → its hydrated Evidence objects (shared instances). */
export function evidenceForFact(ownerId, factId) {
  const b = bucket(ownerId);
  const fact = b.facts.get(factId);
  if (!fact) return [];
  return fact.evidence.map(id => b.evidence.get(id)).filter(Boolean);
}

/** Evidence → every Fact that cites it (the sharing fan-out). */
export function factsForEvidence(ownerId, evidenceId) {
  const b = bucket(ownerId);
  return [...(b.evidenceRefs.get(evidenceId) ?? [])].map(id => b.facts.get(id)).filter(Boolean);
}

export function evidenceForFile(ownerId, ukoId) {
  const b = bucket(ownerId);
  return [...(b.byFile.get(ukoId)?.evidence ?? [])].map(id => b.evidence.get(id)).filter(Boolean);
}

export function factsForFile(ownerId, ukoId) {
  const b = bucket(ownerId);
  return [...(b.byFile.get(ukoId)?.facts ?? [])].map(id => b.facts.get(id)).filter(Boolean);
}

export function listFacts(ownerId, { limit = 200 } = {}) {
  return [...bucket(ownerId).facts.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/**
 * PIC (Phase 4) additive seam — patch an existing fact IN PLACE. Used by the
 * consolidation engine to merge evidence onto a survivor, adjust confidence,
 * and set lifecycle flags (archived / supersededBy / disputed / trusted /
 * stale). The fact's STATEMENT is deliberately not special-cased here — the
 * Phase-2 rule stands: we never silently rewrite a claim; consolidation only
 * merges provenance and annotates. New evidence ids gain ref-graph edges so
 * sharing stays consistent.
 */
export function updateFact(ownerId, factId, patch = {}) {
  const b = bucket(ownerId);
  const fact = b.facts.get(factId);
  if (!fact) return null;
  if (Array.isArray(patch.evidence)) {
    patch = { ...patch, evidence: [...new Set(patch.evidence)] };
  }
  Object.assign(fact, patch);
  if (Array.isArray(patch.evidence)) {
    for (const evId of fact.evidence) b.evidenceRefs.get(evId)?.add(factId);
  }
  scheduleSave();
  return fact;
}

// ── Cascade delete (keeps the graph consistent — no orphans on removal) ──────

export function removeFile(ownerId, ukoId) {
  const b = bucket(ownerId);
  const links = b.byFile.get(ukoId);
  if (!links) return false;
  for (const factId of links.facts) {
    const fact = b.facts.get(factId);
    if (fact) for (const evId of fact.evidence) b.evidenceRefs.get(evId)?.delete(factId);
    b.facts.delete(factId);
  }
  for (const evId of links.evidence) {
    const ev = b.evidence.get(evId);
    if (ev) b.byChecksum.delete(ev.checksum);
    b.evidence.delete(evId);
    b.evidenceRefs.delete(evId);
  }
  b.byFile.delete(ukoId);
  scheduleSave();
  return true;
}

function evictOldestFact(b) {
  const oldest = [...b.facts.values()].sort((a, c) => a.createdAt - c.createdAt)[0];
  if (!oldest) return;
  for (const evId of oldest.evidence) b.evidenceRefs.get(evId)?.delete(oldest.id);
  b.facts.delete(oldest.id);
}

function evictOldestEvidence(b) {
  // Evict oldest evidence that no fact references (safe); else oldest overall.
  const unreferenced = [...b.evidence.values()].filter(ev => !(b.evidenceRefs.get(ev.id)?.size)).sort((a, c) => a.createdAt - c.createdAt)[0];
  const victim = unreferenced ?? [...b.evidence.values()].sort((a, c) => a.createdAt - c.createdAt)[0];
  if (!victim) return;
  b.evidence.delete(victim.id);
  b.byChecksum.delete(victim.checksum);
  b.evidenceRefs.delete(victim.id);
}

export function getEvidenceStats(ownerId) {
  const b = bucket(ownerId);
  return {
    facts: b.facts.size, evidence: b.evidence.size, files: b.byFile.size,
    sharedEvidence: [...b.evidenceRefs.values()].filter(s => s.size > 1).length,
  };
}

export function _resetEvidenceStoreForTests() { store.clear(); }
