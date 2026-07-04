/**
 * AQUA Project Index
 *
 * Per-workspace in-memory index built from parsed files.
 * Supports retrieval by: filename/path, symbol, import, dependency, keyword.
 *
 * Fast O(1) lookups after O(n) build phase.
 */
import { parseFile } from './fileParser.js';

// workspaceId → IndexState
const indexes = new Map();

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build (or rebuild) the index for a workspace from ingested file objects.
 *
 * @param {string} workspaceId
 * @param {Array<{path, content, lang, size, truncated, summary?}>} ingestedFiles
 * @returns {Index}
 */
export function buildIndex(workspaceId, ingestedFiles) {
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

  indexes.set(workspaceId, index);
  console.log(`[Index] ${ingestedFiles.length} files indexed for workspace=${workspaceId}`);
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

// ── Query ─────────────────────────────────────────────────────────────────────

export function getIndex(workspaceId) {
  return indexes.get(workspaceId) ?? null;
}

export function clearIndex(workspaceId) {
  indexes.delete(workspaceId);
}

/**
 * Query the index.
 *
 * @param {string} workspaceId
 * @param {{ symbol?, keyword?, importModule?, filePath? }} query
 * @returns {{ files: object[], symbols: object[], imports: string[] }}
 */
export function queryIndex(workspaceId, { symbol, keyword, importModule, filePath } = {}) {
  const index = indexes.get(workspaceId);
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
  const index = indexes.get(workspaceId);
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
