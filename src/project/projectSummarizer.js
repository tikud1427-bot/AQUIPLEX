/**
 * AQUA Project Summarizer
 *
 * Generates concise summaries from parsed file metadata.
 * Uses heuristic / structural analysis — no LLM calls.
 * This keeps the indexing pipeline synchronous and fast.
 *
 * LLM-quality summarization happens later, lazily, if needed,
 * by passing file content through the normal chat pipeline.
 */
import path from 'path';

// ── File summary ──────────────────────────────────────────────────────────────

/**
 * Generate a one-line summary for a file from its parsed metadata.
 *
 * @param {ParsedFile} parsedFile
 * @returns {string}
 */
export function summarizeFile(parsedFile) {
  const { path: filePath, lang, functions, classes, imports, exports, comments, dependencies } = parsedFile;
  const filename = path.basename(filePath);
  const parts    = [];

  // Leading doc comment gives the best purpose hint
  if (comments?.length > 0) {
    parts.push(comments[0].slice(0, 160));
  }

  const langLabel = lang && lang !== 'unknown' ? ` [${lang}]` : '';
  parts.push(`${filename}${langLabel}`);

  const classNames = (classes ?? [])
    .map(c => typeof c === 'string' ? c : c.name)
    .filter(Boolean);
  if (classNames.length) parts.push(`Classes: ${classNames.slice(0, 5).join(', ')}`);
  if (functions?.length) parts.push(`Functions: ${functions.slice(0, 8).join(', ')}`);
  if (exports?.length)   parts.push(`Exports: ${exports.slice(0, 6).join(', ')}`);
  if (dependencies?.length) parts.push(`Deps: ${dependencies.slice(0, 8).join(', ')}`);

  // Semantic role from path
  const role = _inferRole(filePath);
  if (role) parts.push(`Role: ${role}`);

  return parts.filter(Boolean).join(' | ');
}

// ── Directory summary ─────────────────────────────────────────────────────────

/**
 * Summarize a directory from file summaries within it.
 *
 * @param {string} dirPath
 * @param {Array<{path, summary}>} fileSummaries
 * @returns {string}
 */
export function summarizeDirectory(dirPath, fileSummaries) {
  const n = fileSummaries.length;
  if (n === 0) return `${dirPath}: empty`;

  const names = fileSummaries
    .slice(0, 4)
    .map(f => path.basename(f.path))
    .join(', ');

  return `${dirPath}: ${n} file${n > 1 ? 's' : ''} — ${names}${n > 4 ? ` + ${n - 4} more` : ''}`;
}

// ── Project summary ───────────────────────────────────────────────────────────

/**
 * Generate a project-level architecture summary.
 *
 * @param {{ projectType: string }} workspace
 * @param {ParsedFile[]} parsedFiles
 * @returns {string}
 */
export function summarizeProject(workspace, parsedFiles) {
  const { projectType } = workspace;
  const fileCount = parsedFiles.length;

  // Language breakdown
  const langs = {};
  for (const f of parsedFiles) langs[f.lang] = (langs[f.lang] ?? 0) + 1;
  const langStr = Object.entries(langs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([l, n]) => `${l}(${n})`)
    .join(', ');

  // Entry points
  const entries = parsedFiles
    .filter(f => _isEntryPoint(f.path))
    .map(f => f.path)
    .slice(0, 4);

  // Top-level directories
  const topDirs = _topLevelDirs(parsedFiles.map(f => f.path));

  // Most exported symbols (could be public API)
  const allExports = parsedFiles.flatMap(f => f.exports ?? []);
  const exportCounts = {};
  for (const e of allExports) exportCounts[e] = (exportCounts[e] ?? 0) + 1;

  const lines = [
    `Type: ${projectType ?? 'unknown'} | Files: ${fileCount} | Languages: ${langStr}`,
  ];
  if (topDirs.length)  lines.push(`Top-level dirs: ${topDirs.join(', ')}`);
  if (entries.length)  lines.push(`Entry points: ${entries.join(', ')}`);

  return lines.join('\n');
}

// ── Batch enrichment ──────────────────────────────────────────────────────────

/**
 * Attach a generated summary to each parsed file.
 * Returns new array (does not mutate).
 *
 * @param {ParsedFile[]} parsedFiles
 * @returns {Array<ParsedFile & { summary: string, summaryAt: number }>}
 */
export function enrichWithSummaries(parsedFiles) {
  return parsedFiles.map(f => ({
    ...f,
    summary:   summarizeFile(f),
    summaryAt: Date.now(),
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ENTRY_BASENAMES = new Set([
  'index.js', 'index.ts', 'index.jsx', 'index.tsx',
  'main.js',  'main.ts',  'main.jsx',  'main.tsx',
  'app.js',   'app.ts',   'app.jsx',   'app.tsx',
  'server.js','server.ts','server.jsx','server.tsx',
  'main.py',  'app.py',   '__main__.py',
  'main.go',  'main.rs',  'index.html',
]);

function _isEntryPoint(filePath) {
  return ENTRY_BASENAMES.has(path.basename(filePath).toLowerCase());
}

function _topLevelDirs(paths) {
  const dirs = new Set();
  for (const p of paths) {
    const parts = p.replace(/\\/g, '/').split('/');
    if (parts.length > 1) dirs.add(parts[0]);
  }
  return [...dirs].slice(0, 8);
}

const ROLE_PATTERNS = [
  [/auth|login|session|jwt|token/i,       'authentication'],
  [/route|controller|handler/i,           'routing/controller'],
  [/model|schema|entity|orm/i,            'data model'],
  [/service|business|logic/i,             'business logic'],
  [/repo|repository|dao/i,                'data access'],
  [/middleware|interceptor|filter/i,       'middleware'],
  [/config|setting|constant|env/i,        'configuration'],
  [/util|helper|common|shared/i,          'utilities'],
  [/test|spec|__test__|\.test\.|\.spec\./i,'tests'],
  [/migration|seed/i,                     'database migration'],
  [/component|widget/i,                   'UI component'],
  [/store|redux|context|state/i,          'state management'],
  [/hook|use[A-Z]/,                       'React hook'],
];

function _inferRole(filePath) {
  for (const [pattern, role] of ROLE_PATTERNS) {
    if (pattern.test(filePath)) return role;
  }
  return null;
}
