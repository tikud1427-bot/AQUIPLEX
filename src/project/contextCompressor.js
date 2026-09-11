/**
 * AQUA Context Compressor — token-bounded repository digest
 *
 * The retriever returns the top-k files at full content (≤5 files, ≤2 000 chars
 * each). That is right for a focused question, but gives the model no whole-repo
 * awareness on a large codebase, and it truncates big files crudely. This module
 * produces the complementary artifact: a single, hierarchical, TOKEN-BOUNDED
 * digest of the *entire* repository that always fits a caller-supplied budget.
 *
 * It compresses by choosing a detail level per file, most-important first, until
 * the budget is spent:
 *
 *   1. SKELETON   — signatures only: local imports + function/class/export names
 *                   + the file's one-line summary (no bodies).            [richest]
 *   2. SIGNATURE  — a single line: symbol counts + short summary.
 *   3. ROLLUP     — files that don't fit are collapsed into per-directory
 *                   one-liners (file count + a few names).               [cheapest]
 *
 * Importance = API surface (symbol count) + dependency in-degree (how many files
 * import it) + entry-point / core-module bonuses − test/config penalties + an
 * optional `focus` boost. Pure & deterministic: reads the index, dependency
 * graph and cached overview; stores nothing; identical inputs → identical output.
 *
 * Zero external dependencies. Token estimate is the usual chars/4 heuristic —
 * approximate, but the digest is bounded by construction so the estimate never
 * materially exceeds the requested budget.
 */
import { getIndex }     from './projectIndex.js';
import { getWorkspace } from './workspaceManager.js';
import { whoImports }   from './dependencyGraph.js';

const HEADER_OVERHEAD_CHARS = 480;   // reserved for section headers/sub-headers/footer
const MAX_SK_FUNCS = 12;
const MAX_SK_CLASSES = 8;
const MAX_SK_EXPORTS = 10;
const MAX_SK_IMPORTS = 6;
const MAX_ROLLUP_NAMES = 8;

// ── Public API ────────────────────────────────────────────────────────────────

/** Rough token count (chars/4). Exported for callers that budget prompts. */
export function estimateTokens(str) {
  return Math.ceil((str?.length ?? 0) / 4);
}

/**
 * Build a token-bounded, hierarchical digest of the whole repository.
 *
 * @param {string} workspaceId
 * @param {{ tokenBudget?: number, focus?: string }} [opts]
 * @returns {{ digest: string, stats: object } | null}
 */
export function buildRepoDigest(workspaceId, { tokenBudget = 4000, focus = '' } = {}) {
  const index = getIndex(workspaceId);
  if (!index || !index.byPath.size) return null;

  const overview = getWorkspace(workspaceId)?.overview ?? null;
  const ranked   = _rankFiles(index, workspaceId, overview, focus);

  const budgetChars = Math.max(600, tokenBudget * 4);
  // Reserve headroom for section headers, dir sub-headers and the rollup tier so
  // the finished string stays within budget.
  const detailCeiling = budgetChars - HEADER_OVERHEAD_CHARS;

  const skeleton  = [];
  const signature = [];
  const leftover  = [];
  let used = 0;

  // Tier 1 — skeletons for the most important files, reserving ~25% for the
  // lighter tiers so a large repo still lists/rolls up everything else.
  const skelCeiling = detailCeiling * 0.75;
  let i = 0;
  for (; i < ranked.length; i++) {
    const text = _fileSkeleton(ranked[i].path, ranked[i].e);
    if (used + text.length + 1 <= skelCeiling) { skeleton.push({ ...ranked[i], text }); used += text.length + 1; }
    else break;
  }

  // Tier 2 — one-line signatures for the remainder while budget remains.
  for (; i < ranked.length; i++) {
    const text = _fileSignature(ranked[i].path, ranked[i].e);
    if (used + text.length + 1 <= detailCeiling) { signature.push({ ...ranked[i], text }); used += text.length + 1; }
    else leftover.push(ranked[i]);
  }

  // Tier 3 — everything left, collapsed into per-directory rollups, bounded to
  // whatever budget remains so the finished digest stays within the ceiling.
  const allRollups = _rollups(leftover);
  const rollups = [];
  let rUsed = 0;
  const rRemaining = Math.max(0, budgetChars - used - HEADER_OVERHEAD_CHARS);
  for (const line of allRollups) {
    if (rUsed + line.length + 1 <= rRemaining) { rollups.push(line); rUsed += line.length + 1; }
  }
  if (rollups.length < allRollups.length) rollups.push(`- (+${allRollups.length - rollups.length} more director${allRollups.length - rollups.length > 1 ? 'ies' : 'y'} not shown)`);

  const digest = _assemble({ skeleton, signature, rollups, tokenBudget, focus, totalFiles: index.byPath.size, leftoverCount: leftover.length });

  const stats = {
    budgetTokens:  tokenBudget,
    estTokens:     estimateTokens(digest),
    totalFiles:    index.byPath.size,
    detailed:      skeleton.length,
    listed:        signature.length,
    summarized:    leftover.length,
    dirs:          new Set([...skeleton, ...signature].map(f => _topDir(f.path))).size,
    focus:         focus || null,
  };
  console.log(`[DIGEST] workspace=${workspaceId} budget=${tokenBudget} est=${stats.estTokens} detailed=${stats.detailed} listed=${stats.listed} summarized=${stats.summarized}`);
  return { digest, stats };
}

/** File importance ranking (exported for tests / callers that want the order). */
export function rankFiles(workspaceId, focus = '') {
  const index = getIndex(workspaceId);
  if (!index) return [];
  const overview = getWorkspace(workspaceId)?.overview ?? null;
  return _rankFiles(index, workspaceId, overview, focus).map(({ path, score, symbols, inDeg }) => ({ path, score, symbols, inDeg }));
}

// ── Ranking ───────────────────────────────────────────────────────────────────

function _rankFiles(index, workspaceId, overview, focus) {
  const entrySet = new Set(overview?.entryPoints ?? []);
  const coreSet  = new Set((overview?.coreModules ?? []).map(c => c.file));
  const focusLow = (focus || '').toLowerCase().trim();

  const scored = [];
  for (const [path, e] of index.byPath.entries()) {
    const symbols = (e.functions?.length ?? 0) + (e.classes?.length ?? 0) + (e.exports?.length ?? 0);
    const inDeg   = whoImports(workspaceId, path).length;

    let score = symbols + inDeg * 3;
    if (entrySet.has(path)) score += 8;
    if (coreSet.has(path))  score += 5;
    if (_isTest(path))      score -= 4;
    if (_isConfigish(path)) score -= 3;

    if (focusLow) {
      const hay = `${path} ${e.summary ?? ''} ${(e.functions ?? []).join(' ')} ${_classNames(e).join(' ')}`.toLowerCase();
      if (hay.includes(focusLow)) score += 10;
    }
    scored.push({ path, e, score, symbols, inDeg });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored;
}

// ── Renderers ───────────────────────────────────────────────────────────────

function _fileSkeleton(path, e) {
  const L = [`### ${path} (${e.lang})${_sum(e) ? ` — ${_sum(e)}` : ''}`];
  const locals = (e.imports ?? []).filter(i => typeof i === 'string' && i.startsWith('.')).slice(0, MAX_SK_IMPORTS);
  if (locals.length) L.push(`  imports: ${locals.join(', ')}`);
  const fns = (e.functions ?? []);
  if (fns.length) L.push(`  functions: ${fns.slice(0, MAX_SK_FUNCS).map(f => `${f}()`).join(', ')}${fns.length > MAX_SK_FUNCS ? ` +${fns.length - MAX_SK_FUNCS} more` : ''}`);
  const cls = _classNames(e);
  if (cls.length) L.push(`  classes: ${cls.slice(0, MAX_SK_CLASSES).join(', ')}${cls.length > MAX_SK_CLASSES ? ` +${cls.length - MAX_SK_CLASSES} more` : ''}`);
  const exps = (e.exports ?? []);
  if (exps.length) L.push(`  exports: ${exps.slice(0, MAX_SK_EXPORTS).join(', ')}${exps.length > MAX_SK_EXPORTS ? ` +${exps.length - MAX_SK_EXPORTS} more` : ''}`);
  return L.join('\n');
}

function _fileSignature(path, e) {
  const nf = e.functions?.length ?? 0;
  const nc = _classNames(e).length;
  const parts = [];
  if (nf) parts.push(`${nf} fn`);
  if (nc) parts.push(`${nc} cls`);
  return `- ${path}${parts.length ? ` — ${parts.join(', ')}` : ''}${_sum(e) ? ` · ${_sum(e)}` : ''}`;
}

function _rollups(leftover) {
  const byDir = new Map();
  for (const f of leftover) {
    const d = _topDir(f.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }
  const out = [];
  for (const [dir, files] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const names = files.slice(0, MAX_ROLLUP_NAMES).map(f => _base(f.path));
    out.push(`- ${dir}/ (${files.length} file${files.length > 1 ? 's' : ''}) — ${names.join(', ')}${files.length > MAX_ROLLUP_NAMES ? ', …' : ''}`);
  }
  return out;
}

function _assemble({ skeleton, signature, rollups, tokenBudget, focus, totalFiles, leftoverCount }) {
  const lines = [
    `--- REPOSITORY DIGEST (token-bounded ≈ ${tokenBudget} tokens) ---`,
    `Total files: ${totalFiles} | detailed: ${skeleton.length} | listed: ${signature.length} | summarized: ${leftoverCount}${focus ? ` | focus: "${focus}"` : ''}`,
  ];

  if (skeleton.length) {
    lines.push('', '## Key modules (skeletons)');
    _emitGrouped(lines, skeleton, true);
  }
  if (signature.length) {
    lines.push('', '## Other modules');
    _emitGrouped(lines, signature, false);
  }
  if (rollups.length) {
    lines.push('', '## Summarized directories');
    lines.push(...rollups);
  }

  lines.push('', '--- END REPOSITORY DIGEST ---',
    'This is a compressed whole-repo map. Signatures/summaries are exact; file bodies are omitted — ask for a specific file to see its contents.');
  return lines.join('\n');
}

// Emit entries grouped by top-level directory, preserving importance order
// within each group. `withGap` inserts a blank line between multi-line skeletons.
function _emitGrouped(lines, entries, withGap) {
  const sorted = [...entries].sort((a, b) => _topDir(a.path).localeCompare(_topDir(b.path)) || (b.score - a.score) || a.path.localeCompare(b.path));
  let curDir = null;
  for (const item of sorted) {
    const d = _topDir(item.path);
    if (d !== curDir) { lines.push(`▸ ${d}/`); curDir = d; }
    if (withGap) lines.push('');
    lines.push(item.text);
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function _classNames(e) {
  return (e.classes ?? []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
}
function _sum(e) {
  return _firstSentence(e.summary);
}
function _firstSentence(summary) {
  if (!summary) return '';
  const first = String(summary).split('|')[0].split(/(?<=\.)\s/)[0].trim();
  return first.length > 120 ? first.slice(0, 117) + '…' : first;
}
function _topDir(path) {
  const p = String(path).replace(/\\/g, '/');
  const i = p.indexOf('/');
  return i === -1 ? '(root)' : p.slice(0, i);
}
function _base(path) {
  const p = String(path).replace(/\\/g, '/');
  return p.slice(p.lastIndexOf('/') + 1);
}
function _isTest(path) {
  return /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)/i.test(path) || /\.(test|spec)\.[jt]sx?$/i.test(path);
}
function _isConfigish(path) {
  return /\.(json|lock|md|txt|ya?ml|cfg|ini|env|toml)$/i.test(path) || /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|\.eslintrc[^/]*)$/i.test(path);
}
