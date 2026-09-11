/**
 * AQUA Artifact Engine — Exporter Shared Helpers (P2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tiny utilities every binary exporter needs. Anything bigger than a few
 * lines gets its own module (documentModel.js).
 */

/**
 * Force a path's extension to the exporter's canonical one. The planner is
 * TOLD the canonical extensions, but a plan that says "deck.txt" for a pptx
 * must still download as a file PowerPoint will open — the exporter, not the
 * planner, owns the binary contract.
 *
 * @param {string} p    relative path (already sanitized by specSchema)
 * @param {string} ext  canonical extension including the dot (".pptx")
 */
export function ensureExtension(p, ext) {
  if (p.toLowerCase().endsWith(ext.toLowerCase())) return p;
  return p.replace(/\.[a-z0-9]{1,8}$/i, '') + ext;
}

/** Clamp a string list: strings only, trimmed, non-empty, max N entries. */
export function cleanStringList(items, max = 50, maxLen = 2_000) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(s => typeof s === 'string' && s.trim())
    .map(s => s.trim().slice(0, maxLen))
    .slice(0, max);
}
