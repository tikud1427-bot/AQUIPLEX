/**
 * AQUA Project Index
 *
 * Per-workspace index built from parsed files.
 * Supports retrieval by: filename/path, symbol, import, dependency, keyword.
 * Fast O(1) lookups after an O(n) build phase.
 *
 * ── Persistence (Phase 1 — Persistent Workspace Brain) ────────────────────────
 * The derived index (symbol/import/keyword maps) is REBUILDABLE, so only the
 * MINIMAL source needed to rebuild it is persisted: the ingested files
 * themselves (path + content + lang + size). That raw content lives durably
 * NOWHERE ELSE — projectMemory persists workspace *metadata* only (path/lang/
 * size/summary, no content). Before this, a restart wiped the index and there
 * was nothing to rebuild from: getIndex() returned null, so isEditIntent()
 * silently disabled editing until the user re-uploaded.
 *
 * Now: buildIndex() derives the maps in memory AND persists the source
 * snapshot (.aqua-index.json, debounced whole-file write — same tier as
 * mindStore/projectMemory). getIndex() lazily rebuilds the derived maps from
 * that snapshot on a miss (e.g. first access after a restart), so the
 * workspace brain — and the edit path that depends on entry.content — survives
 * restarts. All access is through getIndex/buildIndex, so a later move to
 * Mongo/SQLite (Phase 2) touches ONLY this file.
 *
 * NOTE: the snapshot holds full file content; it can be large for big repos.
 * That is inherent to surviving a restart with a working edit path, and is
 * bounded per-workspace. Phase 2 moves this off whole-file JSON.
 */
import fs   from 'fs';
import path from 'path';
import { parseFile } from './fileParser.js';
import { createDebouncedWriter } from '../core/atomicStore.js';

const INDEX_FILE = path.join(process.cwd(), '.aqua-index.json');

// workspaceId → derived Index (in-memory, rebuildable)
const indexes = new Map();
// workspaceId → source ingested files (persisted, minimal rebuildable unit)
//   [{ path, content, lang, size, truncated, summary }]
const sources = new Map();

// ── Persistence ───────────────────────────────────────────────────────────────
// Mirrors the proven mindStore/projectMemory pattern: in-memory Map + debounced
// JSON file write, loaded once on boot.

let loaded = false;
function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(INDEX_FILE)) return;
    const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    for (const [id, files] of Object.entries(data)) {
      if (Array.isArray(files)) sources.set(id, files);
    }
    console.log(`[Index] Loaded source snapshots for ${sources.size} workspace(s) from disk`);
  } catch (err) {
    console.warn('[Index] Could not load index sources from disk:', err.message);
  }
}

// Phase 3b — atomic + async persistence via the shared primitive. This is the
// largest store (~MBs of source content), so moving the whole-file rewrite off
// the synchronous path is the biggest event-loop win; temp+rename also removes
// the "corrupt index on crash mid-write" failure mode.
const _writer = createDebouncedWriter(INDEX_FILE);
function scheduleSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [id, files] of sources.entries()) data[id] = files;
    return JSON.stringify(data);
  });
}

loadFromDisk();

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build (or rebuild) the index for a workspace from ingested file objects.
 *
 * @param {string} workspaceId
 * @param {Array<{path, content, lang, size, truncated, summary?}>} ingestedFiles
 * @param {{ persist?: boolean }} [opts]  persist=false when rebuilding from an
 *        already-persisted source (identical bytes → no redundant write).
 * @returns {Index}
 */
export function buildIndex(workspaceId, ingestedFiles, { persist = true } = {}) {
  const index = _deriveIndex(ingestedFiles);
  indexes.set(workspaceId, index);

  if (persist) {
    sources.set(workspaceId, ingestedFiles.map(f => ({
      path:      f.path,
      content:   f.content,
      lang:      f.lang,
      size:      f.size,
      truncated: f.truncated ?? false,
      summary:   f.summary ?? null,
    })));
    scheduleSave();
  }

  console.log(`[Index] ${ingestedFiles.length} files indexed for workspace=${workspaceId}`);
  return index;
}

/** Pure derivation — no side effects, no persistence. Shared by build + rebuild. */
function _deriveIndex(ingestedFiles) {
  const index = {
    byPath:    new Map(),   // filePath → full parsed+enriched entry
    bySymbol:  new Map(),   // symbol   → [{ path, type }]
    byImport:  new Map(),   // module   → [paths that import it]
    byKeyword: new Map(),   // keyword  → Set<path>
    builtAt:   Date.now(),
    fileCount: ingestedFiles.length,
  };

  for (const file of ingestedFiles) {
    const parsed = parseFile(file.path, file.content, file.lang);

    const entry = {
      ...parsed,
      content:   file.content,
      lang:      file.lang,
      size:      file.size,
      truncated: file.truncated ?? false,
      summary:   file.summary ?? null,
    };

    index.byPath.set(file.path, entry);
    _indexSymbols(index, parsed, file.path);
    _indexImports(index, parsed, file.path);
    _indexPathKeywords(index, file.path);
  }

  return index;
}

function _indexSymbols(index, parsed, filePath) {
  for (const fn of parsed.functions  ?? []) _addSymbol(index, fn,   filePath, 'function');
  for (const cl of parsed.classes    ?? []) {
    const name = typeof cl === 'string' ? cl : cl.name;
    if (name) _addSymbol(index, name, filePath, 'class');
  }
  for (const iface of parsed.interfaces ?? []) _addSymbol(index, iface, filePath, 'interface');
  for (const exp  of parsed.exports   ?? []) _addSymbol(index, exp,  filePath, 'export');
}

function _addSymbol(index, name, filePath, type) {
  if (!name || name.length < 2) return;
  if (!index.bySymbol.has(name)) index.bySymbol.set(name, []);
  index.bySymbol.get(name).push({ path: filePath, type });
}

function _indexImports(index, parsed, filePath) {
  for (const imp of parsed.imports ?? []) {
    if (!index.byImport.has(imp)) index.byImport.set(imp, []);
    index.byImport.get(imp).push(filePath);
  }
}

function _indexPathKeywords(index, filePath) {
  const parts = filePath.replace(/\\/g, '/').split(/[\/._\-]/g);
  for (const part of parts) {
    const kw = part.toLowerCase();
    if (kw.length < 2) continue;
    if (!index.byKeyword.has(kw)) index.byKeyword.set(kw, new Set());
    index.byKeyword.get(kw).add(filePath);
  }
}

/**
 * Persist enriched summaries back into the source snapshot so a rebuilt index
 * (after restart) carries them too. Called by the ingestion / edit pipelines
 * right after they patch summaries into the live index. Cheap: updates the
 * snapshot in place + reschedules the debounced save. Never derives anything.
 *
 * @param {string} workspaceId
 * @param {Array<{path, summary}>} enriched
 */
export function syncSummaries(workspaceId, enriched = []) {
  const src = sources.get(workspaceId);
  if (!src) return;
  const summaryByPath = new Map(enriched.map(e => [e.path, e.summary]));
  let changed = false;
  for (const f of src) {
    if (summaryByPath.has(f.path) && f.summary !== summaryByPath.get(f.path)) {
      f.summary = summaryByPath.get(f.path);
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// ── Query ─────────────────────────────────────────────────────────────────────

/**
 * Get the derived index for a workspace. If it is not resident in memory but a
 * persisted source snapshot exists (e.g. the first access after a restart),
 * the derived index is rebuilt lazily from that snapshot. This is the single
 * hook that warms the whole system (chat edit-detection, edit engine, project
 * retriever) after a restart — they all read through getIndex().
 */
export function getIndex(workspaceId) {
  const live = indexes.get(workspaceId);
  if (live) return live;

  const src = sources.get(workspaceId);
  if (src) {
    const rebuilt = buildIndex(workspaceId, src, { persist: false });
    console.log(`[Index] Rebuilt index from persisted source workspace=${workspaceId} files=${src.length}`);
    return rebuilt;
  }

  return null;
}

export function clearIndex(workspaceId) {
  const had = indexes.delete(workspaceId);
  if (sources.delete(workspaceId)) scheduleSave();
  return had;
}

/**
 * Query the index.
 *
 * @param {string} workspaceId
 * @param {{ symbol?, keyword?, importModule?, filePath? }} query
 * @returns {{ files: object[], symbols: object[], imports: string[] }}
 */
export function queryIndex(workspaceId, { symbol, keyword, importModule, filePath } = {}) {
  const index = getIndex(workspaceId);
  if (!index) return { files: [], symbols: [], imports: [] };

  const pathSet  = new Set();
  let   symbols  = [];
  let   imports  = [];

  if (symbol) {
    const hits = index.bySymbol.get(symbol) ?? [];
    hits.forEach(h => pathSet.add(h.path));
    symbols = hits;
  }

  if (keyword) {
    const hits = index.byKeyword.get(keyword.toLowerCase()) ?? new Set();
    hits.forEach(p => pathSet.add(p));
  }

  if (importModule) {
    const hits = index.byImport.get(importModule) ?? [];
    hits.forEach(p => pathSet.add(p));
    imports = hits;
  }

  if (filePath) {
    for (const [p] of index.byPath.entries()) {
      if (p.includes(filePath) || filePath.includes(p)) pathSet.add(p);
    }
  }

  const files = [...pathSet]
    .map(p => index.byPath.get(p))
    .filter(Boolean);

  return { files, symbols, imports };
}

export function getIndexStats(workspaceId) {
  const index = getIndex(workspaceId);
  if (!index) return null;
  return {
    files:     index.byPath.size,
    symbols:   index.bySymbol.size,
    imports:   index.byImport.size,
    keywords:  index.byKeyword.size,
    builtAt:   index.builtAt,
    fileCount: index.fileCount,
  };
}