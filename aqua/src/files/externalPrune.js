/**
 * Safety Fix 2 — remove everything derived from one external source (or one
 * resource, or one version) from a store entry AS THE DATABASE HOLDS IT.
 *
 * PURE. Each function takes an encoded entry (the JSON a partition row holds,
 * or null), returns `{ entry, removed }` — a pruned COPY and how many matching
 * items it held — and never touches module state. externalSources.sweep uses
 * them twice, with the same definition of "matching":
 *   1. inside keyedBinding.commit / ownerBinding.commit — applied to the
 *      LATEST row and re-applied to the newer row after a conflict, so items
 *      another instance wrote or edited meanwhile are removed too;
 *   2. on a fresh read of every row afterwards — `removed` must be 0 for the
 *      disconnect to report complete (the database, not this process's memory).
 *
 * Matching is by id prefix only — the same prefixes the in-memory sweep uses:
 *   ukoPrefix  `ext_<source>_` / `ext_<source>_<item>_` / one version id
 *   keyPrefix  `ext:<source>:` / … (file-memory keys and chunk ids)
 * minus the kept version (keepUkoId / keepFileKey) of an update in place.
 */

const clone = x => (x == null ? null : structuredClone(x));
const under = (id, prefix, keep) => typeof id === 'string' && id.startsWith(prefix) && id !== keep;

/** ukoStore entry: { <ukoId>: uko }. */
export function pruneUkos(entry, { ukoPrefix, keepUkoId = null }) {
  const out = clone(entry);
  if (!out) return { entry: out, removed: 0 };
  let removed = 0;
  for (const id of Object.keys(out)) if (under(id, ukoPrefix, keepUkoId)) { delete out[id]; removed++; }
  return { entry: out, removed };
}

/**
 * evidenceStore entry: { evidence, facts, byFile, evidenceRefs }. Mirrors
 * evidenceStore.removeFile for every matching file, plus matching evidence and
 * facts that lost their byFile link (written by an older or crashed writer).
 * Returns the removed fact ids too (claim vectors and PIC subjects follow them).
 * `knownFactIds`: facts this deletion already removed elsewhere (in memory) —
 * removed too even if their file link and evidence are gone (a fact written back
 * without its links can still be attributed to the deleted source).
 */
export function pruneEvidence(entry, { ukoPrefix, keepUkoId = null }, knownFactIds = []) {
  const out = clone(entry);
  if (!out) return { entry: out, removed: 0, factIds: [], files: 0, facts: 0, evidence: 0 };
  out.evidence ??= {}; out.facts ??= {}; out.byFile ??= {}; out.evidenceRefs ??= {};
  const files = Object.keys(out.byFile).filter(f => under(f, ukoPrefix, keepUkoId));
  const factIds = new Set();
  const evIds = new Set();
  for (const f of files) {
    for (const id of out.byFile[f]?.facts ?? []) factIds.add(id);
    for (const id of out.byFile[f]?.evidence ?? []) evIds.add(id);
  }
  for (const [id, ev] of Object.entries(out.evidence)) if (under(ev?.sourceFileId, ukoPrefix, keepUkoId)) evIds.add(id);
  for (const id of knownFactIds) if (out.facts[String(id)]) factIds.add(String(id));
  // A fact with no byFile link left whose every evidence is being removed goes too.
  const linked = new Set(Object.entries(out.byFile).filter(([f]) => !files.includes(f)).flatMap(([, l]) => l?.facts ?? []));
  for (const [id, fact] of Object.entries(out.facts)) {
    const ev = fact?.evidence ?? [];
    if (!linked.has(id) && ev.length && ev.every(e => evIds.has(e))) factIds.add(id);
  }
  let facts = 0, evidence = 0;
  for (const id of factIds) if (out.facts[id]) { delete out.facts[id]; facts++; }
  for (const id of evIds) {
    if (out.evidence[id]) { delete out.evidence[id]; evidence++; }
    delete out.evidenceRefs[id];
  }
  for (const f of files) delete out.byFile[f];
  for (const l of Object.values(out.byFile)) {
    if (Array.isArray(l?.facts)) l.facts = l.facts.filter(id => !factIds.has(id));
    if (Array.isArray(l?.evidence)) l.evidence = l.evidence.filter(id => !evIds.has(id));
  }
  for (const [e, ids] of Object.entries(out.evidenceRefs)) out.evidenceRefs[e] = (ids ?? []).filter(id => !factIds.has(id));
  return { entry: out, removed: files.length + facts + evidence, factIds: [...factIds], files: files.length, facts, evidence };
}

/** fileSearchIndex entry: { files, entities, keywords }. */
export function pruneFileIndex(entry, { ukoPrefix, keepUkoId = null }) {
  const out = clone(entry);
  if (!out) return { entry: out, removed: 0 };
  out.files ??= {};
  const gone = Object.keys(out.files).filter(id => under(id, ukoPrefix, keepUkoId));
  for (const id of gone) delete out.files[id];
  for (const lane of ['entities', 'keywords']) {
    for (const [k, ids] of Object.entries(out[lane] ?? {})) {
      const live = (ids ?? []).filter(id => !gone.includes(id));
      if (live.length) out[lane][k] = live; else delete out[lane][k];
    }
  }
  return { entry: out, removed: gone.length };
}

/** picStore entry: subjects `uko:<id>` under the prefix and `fact:<id>` of removed facts. */
export function prunePic(entry, { ukoPrefix, keepUkoId = null }, factIds = []) {
  const out = clone(entry);
  if (!out) return { entry: out, removed: 0 };
  const facts = new Set(factIds.map(String));
  const subject = s => (typeof s === 'string' && s.startsWith('uko:') && under(s.slice(4), ukoPrefix, keepUkoId))
    || (typeof s === 'string' && s.startsWith('fact:') && facts.has(s.slice(5)));
  let removed = 0;
  for (const field of ['lifecycle', 'versions']) {
    for (const s of Object.keys(out[field] ?? {})) if (subject(s)) { delete out[field][s]; removed++; }
  }
  for (const id of Object.keys(out.signals ?? {})) if (facts.has(id)) { delete out.signals[id]; removed++; }
  for (const s of out.sessions ?? []) {
    if (Array.isArray(s?.usedFacts) && s.usedFacts.some(id => facts.has(String(id)))) s.usedFacts = s.usedFacts.filter(id => !facts.has(String(id)));
  }
  return { entry: out, removed };
}

/** Vector namespace `xfiles:<owner>`: chunk ids `<fileKey>#<n>` under the key prefix. */
export function pruneChunks(entry, { keyPrefix, keepFileKey = null }) {
  const out = clone(entry);
  if (!out) return { entry: out, removed: 0 };
  const kept = keepFileKey ? `${keepFileKey}#` : null;
  let removed = 0;
  for (const id of Object.keys(out)) {
    if (id.startsWith(keyPrefix) && !(kept && id.startsWith(kept))) { delete out[id]; removed++; }
  }
  return { entry: out, removed };
}

/** Canonical claim vector namespace: vectors of the removed facts (id = fact id). */
export function pruneClaimVectors(entry, factIds = []) {
  const out = clone(entry);
  if (!out) return { entry: out, removed: 0 };
  let removed = 0;
  for (const id of factIds.map(String)) if (Object.prototype.hasOwnProperty.call(out, id)) { delete out[id]; removed++; }
  return { entry: out, removed };
}

/** Mind entry: file-memory entries `files[<key>]` under the key prefix (recorded as item tombstones). */
export function pruneMindFiles(entry, { keyPrefix, keepFileKey = null }, at = Date.now()) {
  const out = clone(entry);
  if (!out) return { entry: out, removed: 0 };
  let removed = 0;
  for (const key of Object.keys(out.files ?? {})) {
    if (!under(key, keyPrefix, keepFileKey)) continue;
    delete out.files[key];
    out.tombstones ??= {};
    out.tombstones.files ??= {};
    out.tombstones.files[key] = Math.max(Number(out.tombstones.files[key]) || 0, at);
    removed++;
  }
  return { entry: out, removed };
}

/**
 * Reasoning-graph entry: { nodes, edges, byFile, removedFiles }. Removes the
 * matching files' links, the nodes/edges only they linked, the provenance
 * citing them, and records the files as removed (the union cannot bring them
 * back). `files` = matching file links, `refs` = nodes/edges citing a matching file.
 */
export function pruneGraph(entry, { ukoPrefix, keepUkoId = null }, at = Date.now()) {
  const out = clone(entry);
  if (!out) return { entry: out, removed: 0, files: 0, refs: 0 };
  out.nodes ??= {}; out.edges ??= {}; out.byFile ??= {};
  const isGone = id => under(id, ukoPrefix, keepUkoId);
  const files = Object.keys(out.byFile).filter(isGone);
  const cites = x => (x?.sourceFiles ?? []).some(isGone);
  const refs = Object.values(out.nodes).filter(cites).length + Object.values(out.edges).filter(cites).length;
  const keepNodes = new Set(); const keepEdges = new Set();
  for (const [f, l] of Object.entries(out.byFile)) {
    if (files.includes(f)) continue;
    for (const n of l?.nodes ?? []) keepNodes.add(n);
    for (const e of l?.edges ?? []) keepEdges.add(e);
  }
  const dropNodes = new Set();
  for (const f of files) for (const n of out.byFile[f]?.nodes ?? []) if (!keepNodes.has(n)) dropNodes.add(n);
  // Provenance only from the removed files (and not linked by another file) → the node goes.
  for (const [id, n] of Object.entries(out.nodes)) {
    const src = n?.sourceFiles ?? [];
    if (src.length && src.every(isGone) && !keepNodes.has(id)) dropNodes.add(id);
  }
  for (const id of dropNodes) delete out.nodes[id];
  for (const f of files) for (const e of out.byFile[f]?.edges ?? []) if (!keepEdges.has(e)) delete out.edges[e];
  for (const [id, e] of Object.entries(out.edges)) if (dropNodes.has(e?.from) || dropNodes.has(e?.to)) delete out.edges[id];
  const strip = x => (cites(x) ? { ...x, sourceFiles: x.sourceFiles.filter(id => !isGone(id)) } : x);
  for (const [id, n] of Object.entries(out.nodes)) out.nodes[id] = strip(n);
  for (const [id, e] of Object.entries(out.edges)) out.edges[id] = strip(e);
  for (const f of files) delete out.byFile[f];
  for (const l of Object.values(out.byFile)) {
    if (Array.isArray(l?.nodes)) l.nodes = l.nodes.filter(id => out.nodes[id]);
    if (Array.isArray(l?.edges)) l.edges = l.edges.filter(id => out.edges[id]);
  }
  if (files.length) {
    out.removedFiles ??= {};
    for (const f of files) out.removedFiles[f] = Math.max(Number(out.removedFiles[f]) || 0, at);
  }
  return { entry: out, removed: files.length + refs, files: files.length, refs };
}
