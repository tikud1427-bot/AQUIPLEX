/**
 * AQUA — external knowledge lifecycle (Phase 1a.2)
 *
 * The layer a future connector calls. It owns no knowledge of its own: every
 * resource goes through the EXISTING ingestFiles pipeline (parse → UKO →
 * enrichment → evidence/facts → search index → reasoning graph → PIC → file
 * memory + chunks), and every deletion goes through the existing per-store
 * removers. What it adds is the three things external sources need and uploads
 * never did:
 *
 *   IDENTITY   a resource is (sourceId, externalId), never its file name; its
 *              ids are derived from that (files/externalIdentity.js), so two
 *              sources' README.md coexist and a re-sync finds what it imported.
 *   LIFECYCLE  re-syncing identical content is a no-op; changed content becomes
 *              a new version that REPLACES the old one only after it ingested
 *              successfully; deleting a source or one resource removes exactly
 *              what came from it, from every store, and can be retried.
 *   BUDGET     external items have their own per-owner limits; they never evict
 *              a user's upload, and a limit is reported, not worked around.
 *
 * No new store, no new database: the source of every artefact is readable from
 * its id, in each store's own keys.
 *
 * CONCURRENCY: one in-process lock per owner serialises sync and delete (they
 * rebuild the same owner graph). AQUIPLEX runs one writer process today
 * (core/mongoMirror.js). A multi-instance deployment needs a shared lock
 * first; do not run syncs or deletions from more than one process.
 */
import crypto from 'node:crypto';
import { ingestFiles } from './fileEngine.js';
import * as ukoStore from './ukoStore.js';
import * as evidenceStore from './evidenceStore.js';
import { indexedFileIdsByPrefix, removeUKOFromIndex } from './fileSearchIndex.js';
import { graphFileIds, removeFile as removeGraphFile, detachFiles, nodesByType, NODE_TYPES, getNode, edgesOf } from '../reasoning/reasoningGraph.js';
import { pruneReflectionSnapshot } from '../brain/reflectionV2/reflectionStore.js';
import { rebuildOwnerGraph } from '../reasoning/graphBuilder.js';
import { forgetSubjects, picBucket } from '../pic/picStore.js';
import { forgetExternalFiles } from '../memory/engine.js';
import { remove as removeVector, idsIn } from '../embeddings/vectorStore.js';
import { externalFileNamespace } from '../embeddings/fileMemory.js';
import { canonicalClaimNamespace } from '../brain/contextEngine/canonicalSemantic.js';
import { classifyUpload } from '../upload/uploadClassifier.js';
import { getMind } from '../mind/mindStore.js';
import {
  externalIdentity, sourcePrefixes, itemPrefixes, assertSourceRef, isExternalFileId,
} from './externalIdentity.js';
import { ownerLogId } from '../core/logSafety.js';

// ── Limits (per owner, all sources together) ─────────────────────────────────
// Deterministic behaviour at a limit: resources are considered in the order the
// caller gives them; one that would exceed a limit is REJECTED with a reason and
// nothing is written for it; nothing already stored is evicted to make room.
// Updates replace in place (no extra item), so they only need the byte budget.
export const EXTERNAL_LIMITS = Object.freeze({
  itemsPerOwner:    ukoStore.MAX_EXTERNAL_UKOS_PER_OWNER,   // 200 resources
  bytesPerOwner:    50 * 1024 * 1024,                       // 50 MB of source bytes
  bytesPerResource: 10 * 1024 * 1024,                       // 10 MB per resource
  resourcesPerSync: 100,                                    // per call
});

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ── Per-owner serialisation ──────────────────────────────────────────────────
const locks = new Map();
function withOwnerLock(ownerId, fn) {
  const prev = locks.get(ownerId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  locks.set(ownerId, tail);
  tail.then(() => { if (locks.get(ownerId) === tail) locks.delete(ownerId); });
  return run;
}

function assertOwner(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('ownerId is required');
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** All external UKOs of one owner (every source). */
function externalUKOs(ownerId) {
  return ukoStore.listUKOs(ownerId, { limit: 100_000 }).filter(u => isExternalFileId(u.id));
}

/** Items and source bytes currently stored for this owner, with the limits. */
export function externalUsage(ownerId) {
  assertOwner(ownerId);
  const ukos = externalUKOs(ownerId);
  return {
    // Resources, not versions (a version id is <item prefix>_<versionTag>).
    items: new Set(ukos.map(u => u.id.slice(0, u.id.lastIndexOf('_')))).size,
    bytes: ukos.reduce((n, u) => n + (u.sourceFile?.bytes ?? 0), 0),
    limits: EXTERNAL_LIMITS,
  };
}

/** Sources this owner has knowledge from: [{ sourceId, items, bytes, lastSyncedAt }]. */
export function listExternalSources(ownerId) {
  assertOwner(ownerId);
  const by = new Map();
  for (const u of externalUKOs(ownerId)) {
    const sid = u.provenance?.external?.sourceId;
    if (!sid) continue;
    const s = by.get(sid) ?? { sourceId: sid, items: 0, bytes: 0, lastSyncedAt: 0 };
    s.items += 1;
    s.bytes += u.sourceFile?.bytes ?? 0;
    s.lastSyncedAt = Math.max(s.lastSyncedAt, u.provenance.external.syncedAt ?? 0);
    by.set(sid, s);
  }
  return [...by.values()];
}

/** Resources currently stored from one source: [{ externalId, ukoId, name, bytes, version, sourceUpdatedAt, syncedAt }]. */
export function listExternalResources(ownerId, sourceId) {
  assertOwner(ownerId);
  const { ukoPrefix } = sourcePrefixes(sourceId);
  return ukoStore.listUKOsByPrefix(ownerId, ukoPrefix).map(u => ({
    externalId: u.provenance.external?.externalId ?? null,
    ukoId: u.id, name: u.sourceFile.name, bytes: u.sourceFile.bytes,
    version: u.provenance.external?.version ?? null,
    sourceUpdatedAt: u.provenance.external?.sourceUpdatedAt ?? null,
    syncedAt: u.provenance.external?.syncedAt ?? null,
  }));
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/**
 * Import or refresh resources from one source.
 *
 * @param {object} args
 * @param {string} args.ownerId
 * @param {string} args.sourceId            "<connector>:<scope>", e.g. "github:inst-123"
 * @param {Array<{ externalId: string, name: string, buffer?: Buffer, content?: string,
 *                 version?: string, sourceUpdatedAt?: string|number, url?: string, title?: string }>} args.resources
 * @param {object} [args.deps]              passed to ingestFiles (tests)
 * @returns {Promise<{ sourceId, results: Array<{ externalId, status, ukoId?, reason? }>, usage }>}
 *   status: 'created' | 'updated' | 'unchanged' | 'rejected' | 'failed'
 */
export function syncExternalResources({ ownerId, sourceId, resources = [], deps = {} } = {}) {
  assertOwner(ownerId);
  assertSourceRef(sourceId);
  if (!Array.isArray(resources)) throw new TypeError('resources must be an array');
  return withOwnerLock(ownerId, () => syncLocked({ ownerId, sourceId, resources, deps }));
}

async function syncLocked({ ownerId, sourceId, resources, deps }) {
  // One outcome per input resource, reported in the caller's order (deterministic),
  // whatever order the ingest completes in.
  const slots = new Array(resources.length);
  const seen = new Set();
  const queue = [];   // accepted for ingest: { externalId, name, buffer, ident, meta, previous }

  // Budget as it stands, then as this call claims it, in order.
  const usage = externalUsage(ownerId);
  let items = usage.items;
  let bytes = usage.bytes;

  for (const [i, r] of resources.entries()) {
    const reject = (reason, externalId = r?.externalId ?? null) => { slots[i] = { externalId, status: 'rejected', reason }; };
    if (i >= EXTERNAL_LIMITS.resourcesPerSync) { reject('limit:resources-per-sync'); continue; }
    try { assertSourceRef(sourceId, r?.externalId); } catch (err) { reject(`invalid:${err.message}`); continue; }
    if (seen.has(r.externalId)) { reject('duplicate:externalId-in-batch'); continue; }
    seen.add(r.externalId);
    if (typeof r.name !== 'string' || !r.name.trim()) { reject('invalid:name'); continue; }

    const buffer = Buffer.isBuffer(r.buffer) ? r.buffer : typeof r.content === 'string' ? Buffer.from(r.content, 'utf8') : null;
    if (!buffer || !buffer.length) { reject('invalid:empty-content'); continue; }
    if (buffer.length > EXTERNAL_LIMITS.bytesPerResource) { reject('limit:resource-bytes'); continue; }
    if (classifyUpload(r.name, buffer)?.kind === 'repository') { reject('unsupported:archive'); continue; }

    const ident = externalIdentity(sourceId, r.externalId, sha256(buffer));
    const { ukoPrefix } = itemPrefixes(sourceId, r.externalId);
    const versions = ukoStore.listUKOsByPrefix(ownerId, ukoPrefix);
    const current = versions.find(u => u.id === ident.ukoId);
    const previous = versions.filter(u => u.id !== ident.ukoId);

    if (current) {
      // Identical content: nothing to ingest. Tidy any stale version or a
      // crashed sync's leftovers for this resource, keeping the live one.
      const cleaned = await removeItemArtifacts(ownerId, sourceId, r.externalId, { keepUkoId: ident.ukoId, keepFileKey: ident.fileKey });
      slots[i] = { externalId: r.externalId, status: 'unchanged', ukoId: ident.ukoId, ...(cleaned.removedUkoIds.length ? { cleaned: cleaned.removedUkoIds.length } : {}) };
      continue;
    }

    const oldBytes = previous.reduce((n, u) => n + (u.sourceFile?.bytes ?? 0), 0);
    const nextItems = previous.length ? items : items + 1;
    const nextBytes = bytes - oldBytes + buffer.length;
    if (nextItems > EXTERNAL_LIMITS.itemsPerOwner) { reject('limit:items'); continue; }
    if (nextBytes > EXTERNAL_LIMITS.bytesPerOwner) { reject('limit:bytes'); continue; }
    items = nextItems;
    bytes = nextBytes;

    queue.push({
      slot: i, externalId: r.externalId, name: r.name, buffer, ident, previous,
      meta: { version: r.version ?? null, sourceUpdatedAt: r.sourceUpdatedAt ?? null, url: r.url ?? null, title: r.title ?? null },
    });
  }

  if (queue.length) {
    let ingest = null;
    let ingestError = null;
    try {
      ingest = await ingestFiles({
        files: queue.map(q => ({
          name: q.name, buffer: q.buffer,
          external: { sourceId, externalId: q.externalId, ...q.meta },
        })),
        ownerId, conversationId: null, workspaceName: 'External source',
        // No canonical (Postgres) claims for external resources until source-scoped
        // deletion reaches that store too.
        deps: { ...deps, skipUnderstanding: true },
      });
    } catch (err) {
      ingestError = err;
    }

    let replaced = false;
    for (const q of queue) {
      const stored = ukoStore.getUKO(ownerId, q.ident.ukoId);
      if (stored) {
        // The new version is in. Only now remove the old version(s) and any
        // leftovers of this resource — a failed update never loses the old one.
        const cleaned = await removeItemArtifacts(ownerId, sourceId, q.externalId, { keepUkoId: q.ident.ukoId, keepFileKey: q.ident.fileKey, rebuild: false });
        if (cleaned.removedUkoIds.length) replaced = true;
        slots[q.slot] = { externalId: q.externalId, status: q.previous.length ? 'updated' : 'created', ukoId: q.ident.ukoId };
      } else {
        // Failed: remove whatever this attempt wrote (only THIS version's ids).
        await removeVersionArtifacts(ownerId, q.ident);
        const failure = ingest?.results?.find(x => x.status === 'failed' && x.name === q.name);
        slots[q.slot] = { externalId: q.externalId, status: 'failed', reason: failure?.error ?? ingestError?.message ?? 'ingest failed' };
        replaced = true;   // partial artefacts may have reached the graph
      }
    }
    if (replaced) rebuildGraphSafely(ownerId);
  }

  const results = slots.filter(Boolean);
  const summary = results.reduce((m, r) => (m[r.status] = (m[r.status] ?? 0) + 1, m), {});
  console.log(`[EXTERNAL] sync source=#${sourcePrefixes(sourceId).ukoPrefix.slice(4, 10)} owner=${ownerLogId(ownerId)} ${JSON.stringify(summary)}`);
  return { sourceId, results, usage: externalUsage(ownerId) };
}

// ── Deletion ─────────────────────────────────────────────────────────────────

/**
 * Delete everything that came from one source, from every store. Idempotent:
 * safe to call again after a partial failure, and a no-op for an unknown
 * source. Uploads, other sources and conversation memory are never touched
 * (their ids cannot carry this source's prefix).
 *
 * @returns {Promise<{ sourceId, removed: object, remaining: object, complete: boolean, errors: string[] }>}
 */
export function deleteExternalSource(ownerId, sourceId) {
  assertOwner(ownerId);
  assertSourceRef(sourceId);
  return withOwnerLock(ownerId, async () => {
    const { ukoPrefix, keyPrefix } = sourcePrefixes(sourceId);
    const report = await sweep(ownerId, { ukoPrefix, keyPrefix });
    console.log(`[EXTERNAL] delete-source source=#${ukoPrefix.slice(4, 10)} owner=${ownerLogId(ownerId)} ukos=${report.removed.ukos} facts=${report.removed.facts} complete=${report.complete}`);
    return { sourceId, ...report };
  });
}

/** Delete one resource (every version) of one source. Same guarantees as deleteExternalSource. */
export function deleteExternalResource(ownerId, sourceId, externalId) {
  assertOwner(ownerId);
  assertSourceRef(sourceId, externalId);
  return withOwnerLock(ownerId, async () => {
    const { ukoPrefix, keyPrefix } = itemPrefixes(sourceId, externalId);
    return { sourceId, externalId, ...(await sweep(ownerId, { ukoPrefix, keyPrefix })) };
  });
}

/**
 * Remove every artefact under (ukoPrefix, keyPrefix) — except `keep` — from
 * every store, then verify nothing under the prefix is left. Each step is
 * independent and fail-safe; a step that throws is reported and the rest
 * still run, so a retry only has the remainder to do.
 */
async function sweep(ownerId, { ukoPrefix, keyPrefix, keepUkoId = null, keepFileKey = null, rebuild = true }) {
  const errors = [];
  const step = (name, fn) => { try { return fn(); } catch (err) { errors.push(`${name}: ${err?.message ?? err}`); return null; } };
  const removed = { ukos: 0, facts: 0, fileLinks: 0, indexed: 0, graphFiles: 0, graphNodes: 0, graphEdges: 0, picRecords: 0, fileEntries: 0, cacheEntries: 0, claimVectors: 0, reflectionNodes: 0, reflectionEdges: 0 };

  // 1. Every file id under the prefix that ANY store knows — including files a
  //    crashed sync wrote derived data for without saving the UKO.
  const ids = new Set();
  const collect = (name, list) => { for (const id of step(name, list) ?? []) if (id.startsWith(ukoPrefix) && id !== keepUkoId) ids.add(id); };
  collect('list:ukos', () => ukoStore.listUKOsByPrefix(ownerId, ukoPrefix).map(u => u.id));
  collect('list:evidence', () => evidenceStore.fileIdsByPrefix(ownerId, ukoPrefix));
  collect('list:index', () => indexedFileIdsByPrefix(ownerId, ukoPrefix));
  collect('list:graph', () => graphFileIds(ownerId));
  collect('list:pic', () => [...picBucket(ownerId).lifecycle.keys()].filter(s => s.startsWith('uko:')).map(s => s.slice(4)));

  // 2. Retrieval-facing derived data first: facts/evidence (knowledge lane),
  //    their claim vectors, lifecycle records, the search index, the graph.
  const hashes = new Set();
  for (const id of ids) {
    const uko = ukoStore.getUKO(ownerId, id);
    if (uko?.sourceFile?.hash) hashes.add(uko.sourceFile.hash);
    const factIds = step(`facts:${id}`, () => evidenceStore.factIdsForFile(ownerId, id)) ?? [];
    step(`claimVectors:${id}`, () => {
      const ns = canonicalClaimNamespace(ownerId);
      const present = new Set(idsIn(ns));
      for (const f of factIds) if (present.has(String(f))) { removeVector(ns, String(f)); removed.claimVectors++; }
    });
    removed.picRecords += step(`pic:${id}`, () => forgetSubjects(ownerId, { ukoIds: [id], factIds })) ?? 0;
    if (step(`evidence:${id}`, () => evidenceStore.removeFile(ownerId, id))) { removed.fileLinks++; removed.facts += factIds.length; }
    if (step(`index:${id}`, () => removeUKOFromIndex(ownerId, id))) removed.indexed++;
    if (step(`graph:${id}`, () => removeGraphFile(ownerId, id))) removed.graphFiles++;
  }

  // 2b. Graph by provenance: entity nodes span files and carry no per-file link,
  //     so removeFile alone leaves an entity only the deleted source mentioned.
  if (ids.size) {
    const g = step('graph:detach', () => detachFiles(ownerId, [...ids]));
    if (g) { removed.graphNodes += g.nodes; removed.graphEdges += g.edges; }
  }

  // 3. File memory entries + content chunks (FILE RECALL / KNOWN FILES lanes).
  removed.fileEntries = step('fileMemory', () => forgetExternalFiles(ownerId, keyPrefix, { keep: keepFileKey ? [keepFileKey] : [] }).entries) ?? 0;

  // 4. The UKOs themselves, last — and the parse cache for content no live UKO still has.
  for (const id of ids) {
    if (step(`uko:${id}`, () => ukoStore.removeUKO(ownerId, id))) removed.ukos++;
  }
  for (const hash of hashes) {
    if (step('cache', () => ukoStore.dropCachedKnowledgeIfUnused(ownerId, hash))) removed.cacheEntries++;
  }

  // 5. Re-derive the owner graph from what remains (cross-file entities and
  //    contradictions that involved the removed facts disappear with them).
  if (rebuild && ids.size) step('graph:rebuild', () => rebuildGraphSafely(ownerId, { throwOnError: true }));

  // 5b. G0 (SD-9): the Reflection V2 snapshot holds entity labels; drop the
  //     entries the rebuilt graph no longer has (a deletion, not a world change).
  if (rebuild && ids.size) {
    const pr = step('reflection:prune', () => {
      const r = pruneReflectionSnapshot(ownerId, {
        isLiveNode: nid => getNode(ownerId, nid) != null,
        isLiveEdge: e => edgesOf(ownerId, e.from).some(x => x.id === e.id),
      });
      // Partitioned mode with this owner's reflection state not loaded: reported, not fatal —
      // failing here would make the disconnect itself un-completable.
      return r ?? { nodes: 0, edges: 0, deferred: true };
    });
    if (pr) { removed.reflectionNodes = pr.nodes; removed.reflectionEdges = pr.edges; if (pr.deferred) removed.reflectionDeferred = true; }
  }

  // 6. Verify: nothing under the prefix may remain anywhere we can look.
  const remaining = step('verify', () => remainingUnder(ownerId, { ukoPrefix, keyPrefix, keepUkoId, keepFileKey })) ?? null;
  const complete = !errors.length && remaining != null && Object.values(remaining).every(n => n === 0);
  return { removed, remaining, complete, errors, removedUkoIds: [...ids] };
}

/** Counts of artefacts still stored under a prefix (all must be 0 after a complete deletion). */
export function remainingUnder(ownerId, { ukoPrefix, keyPrefix, keepUkoId = null, keepFileKey = null }) {
  const notKept = id => id !== keepUkoId;
  const mind = getMind(ownerId);
  const chunkPrefixKept = keepFileKey ? `${keepFileKey}#` : null;
  return {
    ukos:       ukoStore.listUKOsByPrefix(ownerId, ukoPrefix).filter(u => notKept(u.id)).length,
    fileLinks:  evidenceStore.fileIdsByPrefix(ownerId, ukoPrefix).filter(notKept).length,
    indexed:    indexedFileIdsByPrefix(ownerId, ukoPrefix).filter(notKept).length,
    graphFiles: graphFileIds(ownerId).filter(id => id.startsWith(ukoPrefix) && notKept(id)).length,
    // Any node still citing a removed file as its provenance (entity, file, fact, …).
    graphRefs: NODE_TYPES.flatMap(type => nodesByType(ownerId, type))
      .filter(n => (n.sourceFiles ?? []).some(id => typeof id === 'string' && id.startsWith(ukoPrefix) && notKept(id))).length,
    picSubjects: [...picBucket(ownerId).lifecycle.keys()].filter(s => s.startsWith(`uko:${ukoPrefix}`) && s !== `uko:${keepUkoId}`).length,
    fileEntries: Object.keys(mind?.files ?? {}).filter(k => k.startsWith(keyPrefix) && k !== keepFileKey).length,
    chunks:     idsIn(externalFileNamespace(ownerId)).filter(id => id.startsWith(keyPrefix) && !(chunkPrefixKept && id.startsWith(chunkPrefixKept))).length,
  };
}

/** Remove every version of one resource except the kept one (no lock: callers hold it). */
function removeItemArtifacts(ownerId, sourceId, externalId, { keepUkoId, keepFileKey, rebuild = true }) {
  const { ukoPrefix, keyPrefix } = itemPrefixes(sourceId, externalId);
  return sweep(ownerId, { ukoPrefix, keyPrefix, keepUkoId, keepFileKey, rebuild });
}

/** Remove exactly one version's artefacts (a failed ingest attempt). */
function removeVersionArtifacts(ownerId, ident) {
  return sweep(ownerId, { ukoPrefix: ident.ukoId, keyPrefix: ident.fileKey, rebuild: false });
}

function rebuildGraphSafely(ownerId, { throwOnError = false } = {}) {
  try {
    rebuildOwnerGraph({ evidenceStore, ukoStore }, ownerId);
  } catch (err) {
    console.warn(`[EXTERNAL] graph rebuild failed owner=${ownerLogId(ownerId)}: ${err?.message ?? err}`);
    if (throwOnError) throw err;
  }
}

/** Test-only: whether a lock is held for an owner. */
export function _lockHeldForTests(ownerId) { return locks.has(ownerId); }
