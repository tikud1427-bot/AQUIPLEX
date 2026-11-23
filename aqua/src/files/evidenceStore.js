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
 *
 * E10 NOTE — why this is not an accidental second store, and why it should
 * NOT be mechanically merged into canonical `aqua_claims`:
 *
 *   1. FAIL-SAFE FLOOR. This store is what `routes/chat.js`'s `floorRetrieve`
 *      actually reads, via `cognitiveKnowledgeRetrieve()` →
 *      `pic/core.js:retrieveKnowledge()`. It is the always-available floor
 *      E7/E8's retrieval pipeline falls back to on any failure — proved by
 *      `contextEngine.test.js`'s "FAIL-SAFE FLOOR" tests. Collapsing it into
 *      the same Postgres substrate the sophisticated path depends on would
 *      remove the one fallback that survives when that substrate is the
 *      thing that failed.
 *   2. A SECOND, DELIBERATE RETRIEVAL LANE. `indexCanonicalClaim(s)` below
 *      embeds these facts for E7 Retrieval V3's dense lane under the
 *      contract in `canonicalSemantic.js` (evidenceStore fact.id === vector
 *      id === candidate.semanticId) — fused with canonical `aqua_claims` via
 *      reciprocal-rank fusion, not a duplicate of it.
 *
 *   Any real E10 unification here is a deliberate redesign of both contracts
 *   above, not a data migration — audited 2026-09-22, see project notes
 *   before changing this file's relationship to `aqua_claims`.
 */
import {
  createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore,
} from '../core/atomicStore.js';
import { dataPath } from '../core/dataDir.js';
import { bindKeyedStore } from '../core/storage/keyedBinding.js';
import { evidenceChecksum } from './evidence.js';
import { indexCanonicalClaim, indexCanonicalClaims, canonicalClaimNamespace } from '../brain/contextEngine/canonicalSemantic.js';
import { isExternalFileId } from './externalIdentity.js';
import { clearNamespace } from '../embeddings/vectorStore.js';
import { setExternalFactResolver } from '../pic/picStore.js';

const STORE_FILE = dataPath('.aqua-evidence.json');
const SCHEMA     = 1;

const MAX_FACTS_PER_OWNER    = 5000;   // uploads + conversation (unchanged; counted over that class only)
const MAX_EVIDENCE_PER_OWNER = 8000;
// Phase 1a.2 — EXTERNAL knowledge (evidence whose sourceFileId is an external
// UKO id, files/externalIdentity.js) has its own budget and evicts only within
// it, so an import can never evict a fact the user's uploads or conversations
// produced. With no external facts present the original policy is unchanged.
export const MAX_EXTERNAL_FACTS_PER_OWNER    = 3000;
export const MAX_EXTERNAL_EVIDENCE_PER_OWNER = 5000;
const isExternalEvidence = ev => isExternalFileId(ev?.sourceFileId);

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
/** Write pending changes to disk now (synchronous, atomic) — memory/propagation.js stamps a change done only after this. */
export function flushEvidence() {
  if (binding.writesWholeJson()) { _writer.flush(); return; }
  binding.flush().catch(() => {});   // partitions authoritative: started now, cannot be awaited synchronously
}
function encodeBucket(b) {
  return {
    evidence: Object.fromEntries(b.evidence),
    facts:    Object.fromEntries(b.facts),
    byFile:   Object.fromEntries([...b.byFile].map(([k, v]) => [k, { facts: [...v.facts], evidence: [...v.evidence] }])),
    evidenceRefs: Object.fromEntries([...b.evidenceRefs].map(([k, v]) => [k, [...v]])),
  };
}

function decodeBucket(obj) {
  const bk = { evidence: new Map(), byChecksum: new Map(), facts: new Map(), byFile: new Map(), evidenceRefs: new Map() };
  for (const ev of Object.values(obj?.evidence ?? {})) { bk.evidence.set(ev.id, ev); bk.byChecksum.set(ev.checksum, ev.id); }
  for (const f of Object.values(obj?.facts ?? {})) bk.facts.set(f.id, f);
  for (const [file, links] of Object.entries(obj?.byFile ?? {})) {
    bk.byFile.set(file, { facts: new Set(links.facts ?? []), evidence: new Set(links.evidence ?? []) });
  }
  for (const [evId, factIds] of Object.entries(obj?.evidenceRefs ?? {})) bk.evidenceRefs.set(evId, new Set(factIds));
  return bk;
}

function scheduleSave(ownerKey = null) {
  if (ownerKey) binding.markDirty(ownerKey);
  if (!binding.writesWholeJson()) return;
  _writer.schedule(() => {
    const data = {};
    for (const [owner, b] of store.entries()) data[owner] = encodeBucket(b);
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

// ── Per-owner persistence (scalability Phase 2c) ─────────────────────────────
// WRITERS: the server only (file pipeline, memory engine, propagation, PIC
// consolidation, reflection archive); concurrent with several API instances.
// MERGE (three-way against the last-synced base, core/storage/entryMerge.js):
//   evidence, facts   per item; changed on one side → that side; on both →
//                     newer (facts: updatedAt, stamped by updateFact while
//                     partitions are on; else createdAt); deleted (removeFile,
//                     eviction) on one side and untouched on the other → gone
//   byFile,
//   evidenceRefs      id sets merged three-way, then links to items that no
//                     longer exist are dropped; byChecksum is rebuilt, not merged
// DELETION: purgeOwner → row tombstone.
const factTime = f => Number(f?.updatedAt ?? f?.createdAt) || 0;
// Safety Fix 2 — EXTERNAL ORIGIN, judged on all three sides of a merge (ctx):
//   evidence      its sourceFileId is an external file (ext_…);
//   fact          linked under an external file in byFile, or citing external evidence;
//   byFile[f]     f is an external file; evidenceRefs[e]: e is external evidence.
// For those, a deletion wins over a concurrent edit and an addition needs a
// valid connect fence (core/storage/entryMerge.js).
const sides = ctx => [ctx?.ours, ctx?.theirs, ctx?.base].filter(Boolean);
const evidenceIsExternal = (evId, ctx) => sides(ctx).some(side => isExternalEvidence(side.evidence?.[evId]));
const factIsExternal = (factId, fact, ctx) =>
  sides(ctx).some(side => Object.entries(side.byFile ?? {}).some(([file, l]) => isExternalFileId(file) && (l?.facts ?? []).includes(factId)))
  || (fact?.evidence ?? []).some(evId => evidenceIsExternal(evId, ctx));
const binding = bindKeyedStore({
  storeKey: '.aqua-evidence.json', file: STORE_FILE, label: 'evidence', schema: SCHEMA,
  mergeSchema: {
    collections: {
      evidence: { time: e => Number(e?.createdAt) || 0, external: (id, ev) => isExternalEvidence(ev) },
      facts: { time: factTime, external: factIsExternal },
    },
    links: ['byFile', 'evidenceRefs'],
    linkExternal: { byFile: file => isExternalFileId(file), evidenceRefs: evidenceIsExternal },
    finalize: m => {
      for (const l of Object.values(m.byFile ?? {})) {
        l.facts = (l.facts ?? []).filter(id => m.facts[id]);
        l.evidence = (l.evidence ?? []).filter(id => m.evidence[id]);
      }
      for (const [evId, ids] of Object.entries(m.evidenceRefs ?? {})) {
        if (!m.evidence[evId]) delete m.evidenceRefs[evId];
        else m.evidenceRefs[evId] = ids.filter(id => m.facts[id]);
      }
      return m;
    },
  },
  encode: owner => (store.has(owner) ? encodeBucket(store.get(owner)) : undefined),
  decode: decodeBucket,
  install: (owner, b) => { if (b) store.set(owner, b); else store.delete(owner); },
  evict: owner => store.delete(owner),
  changedAt: obj => Math.max(0, ...Object.values(obj?.facts ?? {}).map(factTime), ...Object.values(obj?.evidence ?? {}).map(e => Number(e?.createdAt) || 0)),
  reloadJson: () => loadFromDisk(),
});
export function evidencePartitionBinding() { return binding; }

if (binding.loadsJsonAtBoot()) loadFromDisk();

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

  if (b.evidence.size >= Math.min(MAX_EVIDENCE_PER_OWNER, MAX_EXTERNAL_EVIDENCE_PER_OWNER)) {
    const external = isExternalEvidence(evidence);
    const inClass = [...b.evidence.values()].filter(ev => isExternalEvidence(ev) === external).length;
    if (inClass >= (external ? MAX_EXTERNAL_EVIDENCE_PER_OWNER : MAX_EVIDENCE_PER_OWNER)) evictOldestEvidence(b, external);
  }
  b.evidence.set(evidence.id, evidence);
  b.byChecksum.set(evidence.checksum, evidence.id);
  if (!b.evidenceRefs.has(evidence.id)) b.evidenceRefs.set(evidence.id, new Set());
  linkFile(b, evidence.sourceFileId).evidence.add(evidence.id);
  scheduleSave(ownerId ?? 'anon');
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
  if (b.facts.size >= Math.min(MAX_FACTS_PER_OWNER, MAX_EXTERNAL_FACTS_PER_OWNER) && !b.facts.has(fact.id)) {
    const external = isExternalFileId(sourceFileId) || isExternalFact(b, fact);
    const inClass = [...b.facts.values()].filter(f => isExternalFact(b, f) === external).length;
    if (inClass >= (external ? MAX_EXTERNAL_FACTS_PER_OWNER : MAX_FACTS_PER_OWNER)) evictOldestFact(b, external);
  }

  b.facts.set(fact.id, fact);
  const fileId = sourceFileId ?? sourceFileOf(b, fact);
  if (fileId) linkFile(b, fileId).facts.add(fact.id);

  for (const evId of fact.evidence) {
    const refs = b.evidenceRefs.get(evId);
    if (refs) refs.add(fact.id);   // only real evidence gets an edge
  }
  scheduleSave(ownerId ?? 'anon');
  void indexCanonicalClaim(ownerId, fact, { external: isExternalFileId(fileId) || isExternalFact(b, fact) }).catch(() => {});
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
  // Partitions on: a time for the three-way merge to settle a double edit by.
  if (binding.mode !== 'off') fact.updatedAt = Date.now();
  if (Array.isArray(patch.evidence)) {
    for (const evId of fact.evidence) b.evidenceRefs.get(evId)?.add(factId);
  }
  scheduleSave(ownerId ?? 'anon');
  if (Object.prototype.hasOwnProperty.call(patch, 'statement')) {
    void indexCanonicalClaim(ownerId, fact, { external: isExternalFact(b, fact) }).catch(() => {});
  }
  return fact;
}

// ── Cascade delete (keeps the graph consistent — no orphans on removal) ──────

/**
 * Phase 1a.2 — ids of the files this owner's evidence store links to whose id
 * starts with `prefix` (an external source/resource prefix). Reads the link
 * table itself, so it finds files whose UKO was never saved (a crashed sync).
 */
export function fileIdsByPrefix(ownerId, prefix) {
  if (!isExternalFileId(prefix)) return [];
  return [...bucket(ownerId).byFile.keys()].filter(id => typeof id === 'string' && id.startsWith(prefix));
}

/** Phase 1a.2 — facts linked to one file (ids), for PIC/vector cleanup before removeFile. */
export function factIdsForFile(ownerId, ukoId) {
  return [...(bucket(ownerId).byFile.get(ukoId)?.facts ?? [])];
}

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
  scheduleSave(ownerId ?? 'anon');
  void indexCanonicalClaims(ownerId, [...b.facts.values()], { isExternal: f => isExternalFact(b, f) }).catch(() => {});
  return true;
}

/**
 * Account deletion — drop an owner's entire evidence bucket (facts, evidence,
 * checksums, file links). Returns { facts, evidence } counts removed.
 */
export function purgeOwner(ownerId) {
  const key = ownerId ?? 'anon';
  binding.markDeleted(key);
  const b = store.get(key);
  if (!b) return { facts: 0, evidence: 0 };
  const removed = { facts: b.facts.size, evidence: b.evidence.size };
  store.delete(key);
  clearNamespace(canonicalClaimNamespace(key));
  scheduleSave();
  return removed;
}

/**
 * Is this fact's provenance a conversation rather than a document?
 *
 * Read off the EVIDENCE, not the fact: `sourceType` is the evidence's field,
 * and it is the honest semantic signal. Checking the id prefix (`conv:`)
 * instead would couple this store to the Brain's id convention.
 *
 * Unknown provenance counts as NOT conversational — a fact whose evidence has
 * been evicted must never become preferentially evictable itself.
 */
function isConversationFact(b, fact) {
  for (const evId of fact.evidence ?? []) {
    const ev = b.evidence.get(evId);
    if (ev) return ev.sourceType === 'conversation';
  }
  return false;
}

/**
 * Evict one fact to stay under MAX_FACTS_PER_OWNER.
 *
 * SOURCE-AWARE BY DESIGN
 * ----------------------
 * This used to take the globally oldest fact. That is the wrong victim once
 * conversations write here: documents are uploaded in bursts early and chat
 * arrives continuously forever, so "oldest" means "the document corpus" and a
 * talkative week would silently evict the highest-trust knowledge the owner
 * has.
 *
 * So: spend the conversational budget first. Chat claims are lower-confidence,
 * higher-volume, and recoverable — the conversation history still holds the
 * sentence, and re-ingest is idempotent. A document fact may be the only
 * surviving representation of a file the user deleted locally.
 *
 * Falls through to oldest-overall when no conversational fact exists, so with
 * an all-document store the behaviour is byte-identical to before.
 */
/** Safety Fix 2: is this fact (of this owner) derived from a connected external source? */
export function isExternalFactOf(ownerId, fact) { return isExternalFact(bucket(ownerId), fact); }
// Safety Fix 3: PIC fact subjects/signals are external-origin when their fact is
// (answered from this process's evidence — a stale consolidation still holds the fact).
setExternalFactResolver((ownerId, factId) => {
  const b = store.get(ownerId);
  const f = b?.facts.get(factId);
  return f ? isExternalFact(b, f) : false;
});

/** Phase 1a.2 — a fact is external when its evidence came from an external UKO. */
function isExternalFact(b, fact) {
  for (const evId of fact?.evidence ?? []) {
    const ev = b.evidence.get(evId);
    if (ev) return isExternalEvidence(ev);
  }
  return false;
}

function evictOldestFact(b, external = false) {
  // Phase 1a.2: choose only within the incoming fact's class (see the caps above).
  const facts = [...b.facts.values()].filter(f => isExternalFact(b, f) === external);
  const byAge = (a, c) => a.createdAt - c.createdAt;

  const conversational = facts.filter(f => isConversationFact(b, f)).sort(byAge)[0];
  const oldest = conversational ?? facts.sort(byAge)[0];
  if (!oldest) return;

  for (const evId of oldest.evidence) b.evidenceRefs.get(evId)?.delete(oldest.id);
  b.facts.delete(oldest.id);
  return oldest;
}

function evictOldestEvidence(b, external = false) {
  // Evict oldest evidence that no fact references (safe); else oldest overall.
  // Phase 1a.2: both choices are made within the incoming evidence's class.
  const pool = [...b.evidence.values()].filter(ev => isExternalEvidence(ev) === external);
  const unreferenced = pool.filter(ev => !(b.evidenceRefs.get(ev.id)?.size)).sort((a, c) => a.createdAt - c.createdAt)[0];
  const victim = unreferenced ?? pool.sort((a, c) => a.createdAt - c.createdAt)[0];
  if (!victim) return;
  b.evidence.delete(victim.id);
  b.byChecksum.delete(victim.checksum);
  b.evidenceRefs.delete(victim.id);
}

export function getEvidenceStats(ownerId) {
  const b = bucket(ownerId);
  // The document/conversation split is what makes the rollout measurable: it
  // answers "is chat ingest actually writing?" and "how much of this owner's
  // knowledge is now conversational?" without opening the store.
  let conversationFacts = 0;
  for (const f of b.facts.values()) if (isConversationFact(b, f)) conversationFacts += 1;
  return {
    facts: b.facts.size, evidence: b.evidence.size, files: b.byFile.size,
    sharedEvidence: [...b.evidenceRefs.values()].filter(s => s.size > 1).length,
    conversationFacts,
    documentFacts: b.facts.size - conversationFacts,
  };
}

export function _resetEvidenceStoreForTests() { store.clear(); binding._reset(); }