/**
 * AQUA Artifact Engine — Exporter Registry (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * The plugin seam every output format hangs off — the exact pattern
 * agentRegistry.js and capabilityRegistry.js established: modules call
 * registerExporter() once at import time; everything else discovers formats
 * through getExporter()/listExporters(). Adding a format (P2 pdf/docx/pptx,
 * P3 archives/projects) is one new file + one register call — no engine,
 * planner, route, or chat.js change.
 *
 * Uniform exporter contract (spec requirement — no duplicated logic):
 *   {
 *     id:           'md',
 *     label:        'Markdown document',
 *     extensions:   ['.md'],           first entry = canonical
 *     mimes:        ['text/markdown'], first entry = canonical
 *     contentModel: 'document' | 'slides' | 'sheet' | 'files' | 'raw',
 *     async build({ spec, ctx, helpers })  → contentModel object
 *     validate(model)                      → { valid, errors[] }
 *     export(model, { spec })              → { files: [{ path, buffer, mime }] }
 *                                            (sync or async — engine awaits)
 *     package?(files, spec)                → optional override (default: packager.js)
 *   }
 */

const exporters = new Map();

/**
 * @param {string} id
 * @param {object} def exporter definition (see contract above)
 */
export function registerExporter(id, def) {
  if (!id || typeof id !== 'string') throw new Error('Exporter id must be a non-empty string');
  if (exporters.has(id))             throw new Error(`Exporter "${id}" already registered`);
  for (const fn of ['build', 'export']) {
    if (typeof def?.[fn] !== 'function') throw new Error(`Exporter "${id}" must implement ${fn}()`);
  }
  if (!Array.isArray(def.extensions) || !def.extensions.length) {
    throw new Error(`Exporter "${id}" must declare extensions[]`);
  }
  if (!Array.isArray(def.mimes) || !def.mimes.length) {
    throw new Error(`Exporter "${id}" must declare mimes[]`);
  }
  exporters.set(id, { id, label: def.label ?? id, ...def });
}

/** @returns {object|undefined} */
export function getExporter(id) {
  return exporters.get(id);
}

/** @returns {string[]} registered format ids */
export function listExporters() {
  return [...exporters.keys()];
}

/** @returns {object[]} full definitions (for planner prompt construction) */
export function listExporterDefs() {
  return [...exporters.values()];
}

/** Resolve an exporter by file extension (".md" → md). */
export function resolveByExtension(ext) {
  const wanted = String(ext ?? '').toLowerCase();
  for (const def of exporters.values()) {
    if (def.extensions.some(e => e.toLowerCase() === wanted)) return def;
  }
  return undefined;
}

/** Test hook — mirrors the `_resetForTests` convention used store-wide. */
export function _resetExportersForTests() {
  exporters.clear();
}
