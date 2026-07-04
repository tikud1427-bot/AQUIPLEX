/**
 * AQUA Project Retriever
 *
 * Scores every file in a workspace index against the current query.
 * Returns only the most relevant files — never dumps entire project.
 * Formats the result for injection into the system prompt.
 */
import { getIndex }     from './projectIndex.js';
import { getWorkspace } from './workspaceManager.js';
import { formatOverviewForPrompt } from './workspaceAnalyzer.js';

const MAX_FILES          = 5;
const MAX_CONTENT_CHARS  = 2_000;   // per file content snippet

// Whole-repo questions ("explain this repository", "summarize the
// architecture") often share no tokens with any single file path, so
// keyword scoring returns nothing. Detect them and fall back to
// structurally important files (entry points + core modules) instead
// of returning an empty context.
const BROAD_QUERY_RE = /\b(repo(sitory)?|codebase|project|architecture|structure|overview|summar(y|ize|ise)|explain (this|the)|how (does|is) (this|it|everything)|folder|responsibilit)\b/i;

// ── Retrieval ─────────────────────────────────────────────────────────────────

/**
 * Retrieve relevant project context for a query.
 *
 * @param {string} workspaceId
 * @param {string} query
 * @param {number} [limit]
 * @returns {{ files, projectSummary, projectType, relevantSymbols, totalFiles } | null}
 */
export function retrieveProjectContext(workspaceId, query, limit = MAX_FILES) {
  const index     = getIndex(workspaceId);
  const workspace = getWorkspace(workspaceId);
  if (!index || !workspace) return null;

  const scored = [];
  for (const [filePath, meta] of index.byPath.entries()) {
    const score = _score(filePath, meta, query, index);
    if (score > 0) scored.push({ filePath, meta, score });
  }
  scored.sort((a, b) => b.score - a.score);

  let topFiles = scored.slice(0, limit);

  // Broad-query fallback: no keyword hits (or a whole-repo question with
  // weak hits) → surface entry points + most-connected core modules from
  // the cached overview so the model always has real structure to cite.
  if ((!topFiles.length || (BROAD_QUERY_RE.test(query) && topFiles.length < 3)) && workspace.overview) {
    const structural = [
      ...(workspace.overview.entryPoints ?? []),
      ...((workspace.overview.coreModules ?? []).map(c => c.file)),
    ];
    const already = new Set(topFiles.map(t => t.filePath));
    for (const p of structural) {
      if (topFiles.length >= limit) break;
      if (already.has(p)) continue;
      const meta = index.byPath.get(p);
      if (meta) { topFiles.push({ filePath: p, meta, score: 1 }); already.add(p); }
    }
    console.log(`[RETRIEVAL] Broad-query fallback applied workspace=${workspaceId} added=${topFiles.length}`);
  }

  console.log(`[RETRIEVAL] Relevant files selected workspace=${workspaceId} query="${query.slice(0, 60)}" count=${topFiles.length}`);

  const files = topFiles.map(({ filePath, meta }) => ({
    path:          filePath,
    lang:          meta.lang,
    summary:       meta.summary   ?? '',
    functions:     (meta.functions ?? []).slice(0, 10),
    classes:       (meta.classes   ?? []).map(c => typeof c === 'string' ? c : c.name).filter(Boolean).slice(0, 5),
    exports:       (meta.exports   ?? []).slice(0, 8),
    localImports:  (meta.imports   ?? []).filter(i => i.startsWith('.')).slice(0, 5),
    contentSnippet: meta.content   ? meta.content.slice(0, MAX_CONTENT_CHARS) : '',
  }));

  return {
    files,
    projectSummary:  workspace.summary ?? '',
    projectType:     workspace.projectType ?? 'unknown',
    relevantSymbols: _findSymbols(query, index),
    totalFiles:      index.byPath.size,
    overview:        workspace.overview ?? null,   // cached workspace intelligence
  };
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function _score(filePath, meta, query, index) {
  let score  = 0;
  const qLow = query.toLowerCase();
  const tokens = (qLow.match(/\b[a-z][a-z0-9_]{2,}\b/g) ?? []);

  // 1. Path keyword match
  const pLow = filePath.toLowerCase();
  for (const t of tokens) {
    if (pLow.includes(t)) score += 30;
  }

  // 2. Function / symbol match
  for (const fn of meta.functions ?? []) {
    const fnL = fn.toLowerCase();
    for (const t of tokens) {
      if (fnL.includes(t) || t.includes(fnL)) score += 25;
    }
  }
  for (const cl of meta.classes ?? []) {
    const clN = (typeof cl === 'string' ? cl : cl.name ?? '').toLowerCase();
    for (const t of tokens) {
      if (clN.includes(t) || t.includes(clN)) score += 22;
    }
  }

  // 3. Export match
  for (const exp of meta.exports ?? []) {
    if (qLow.includes(exp.toLowerCase())) score += 20;
  }

  // 4. Summary keyword match
  if (meta.summary) {
    const sLow = meta.summary.toLowerCase();
    for (const t of tokens) {
      if (sLow.includes(t)) score += 10;
    }
  }

  // 5. Topic heuristics
  score += _topicBonus(qLow, filePath);

  return score;
}

function _topicBonus(qLow, filePath) {
  const p = filePath.toLowerCase();
  let b = 0;
  if (/auth(entication|orization)?/.test(qLow) && /auth|login|session|jwt|token|middleware/.test(p)) b += 40;
  if (/route|endpoint|api/.test(qLow)           && /route|controller|handler|api/.test(p))           b += 35;
  if (/database|db|model|schema|orm/.test(qLow) && /model|schema|db|database|migration/.test(p))     b += 35;
  if (/config(uration)?|setting|env/.test(qLow) && /config|setting|env|constant/.test(p))             b += 30;
  if (/test|spec/.test(qLow)                    && /test|spec|__test__/.test(p))                       b += 30;
  if (/error|exception/.test(qLow)              && /error|exception|handler|middleware/.test(p))       b += 28;
  if (/architecture|structure|overview/.test(qLow) && /readme|index|main|app|server/.test(p))         b += 25;
  if (/dead.?code|unused/.test(qLow)            && /util|helper|common/.test(p))                       b += 20;
  if (/depend(ency|encies)|import/.test(qLow)   && /package\.json|cargo|requirements|go\.mod/.test(p)) b += 30;
  return b;
}

// ── Symbol extraction from query ──────────────────────────────────────────────

function _findSymbols(query, index) {
  // Match CamelCase identifiers or known suffixes likely to be symbols
  const tokens = query.match(/\b[A-Z][a-zA-Z0-9]+|\b\w+(?:Handler|Manager|Service|Controller|Router|Model|Schema|Config|Store|Provider|Client|Server|Utils?|Helper|Factory)\b/g) ?? [];
  const found  = [];
  for (const t of tokens) {
    if (index.bySymbol.has(t)) {
      found.push({ symbol: t, locations: index.bySymbol.get(t) });
    }
  }
  return found.slice(0, 6);
}

// ── Prompt formatting ─────────────────────────────────────────────────────────

/**
 * Format retrieved context into a string for system prompt injection.
 *
 * @param {{ files, projectSummary, projectType, relevantSymbols, totalFiles }} context
 * @returns {string}
 */
export function formatProjectContext(context) {
  if (!context || !context.files?.length) return '';

  const lines = [
    '--- PROJECT CONTEXT ---',
    `Project type: ${context.projectType} | Total indexed files: ${context.totalFiles}`,
  ];

  // Condensed workspace intelligence (generated once at index time) —
  // gives the model whole-repo awareness even when only a few files are
  // retrieved: frameworks, DB, auth, entry points, endpoint inventory.
  const overviewBlock = formatOverviewForPrompt(context.overview);
  if (overviewBlock) {
    lines.push('', 'Workspace intelligence:', overviewBlock);
  }

  if (context.projectSummary) {
    lines.push('', 'Architecture overview:', context.projectSummary);
  }

  if (context.relevantSymbols?.length) {
    lines.push('', 'Relevant symbols:');
    for (const { symbol, locations } of context.relevantSymbols) {
      const locs = locations.map(l => l.path).join(', ');
      lines.push(`  ${symbol} → ${locs}`);
    }
  }

  lines.push('', 'Relevant files (ranked by query relevance):');

  for (const file of context.files) {
    lines.push('', `### ${file.path} (${file.lang})`);
    if (file.summary)     lines.push(file.summary);
    if (file.functions.length)   lines.push(`Functions: ${file.functions.join(', ')}`);
    if (file.classes.length)     lines.push(`Classes: ${file.classes.join(', ')}`);
    if (file.exports.length)     lines.push(`Exports: ${file.exports.join(', ')}`);
    if (file.localImports.length)lines.push(`Local imports: ${file.localImports.join(', ')}`);
    if (file.contentSnippet) {
      lines.push('```');
      lines.push(file.contentSnippet);
      if (file.contentSnippet.length >= MAX_CONTENT_CHARS) lines.push('// ... [truncated]');
      lines.push('```');
    }
  }

  lines.push(
    '',
    '--- END PROJECT CONTEXT ---',
    'Reference specific files, functions, and classes above when answering.',
    'If asked about files not shown, note they exist but were not retrieved for this query.',
  );

  return lines.join('\n');
}
