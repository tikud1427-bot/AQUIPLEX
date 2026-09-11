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
import {
  getCallGraph, getDefinitions, whoCalls, whatCalls, impactOf, traceFrom,
} from './callGraph.js';
import {
  getSymbolGraph, getRoutes, getModels, findRoutes, findModels,
} from './symbolGraph.js';
import { buildRepoDigest } from './contextCompressor.js';

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
 * @param {object} [opts]
 * @param {Map<string,number>|null} [opts.semanticScores] - Phase 2c: filePath →
 *   cosine, precomputed by the async caller via semanticProject. Blended into
 *   the file score so a paraphrase query with no keyword overlap still surfaces
 *   the right file. null/absent → pure keyword, identical to pre-Phase-2c.
 * @returns {{ files, projectSummary, projectType, relevantSymbols, totalFiles } | null}
 */
export function retrieveProjectContext(workspaceId, query, limit = MAX_FILES, { semanticScores = null } = {}) {
  const index     = getIndex(workspaceId);
  const workspace = getWorkspace(workspaceId);
  if (!index || !workspace) return null;

  const scored = [];
  for (const [filePath, meta] of index.byPath.entries()) {
    const score = _score(filePath, meta, query, index, semanticScores);
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
    callGraph:       _buildCallGraphAnswer(workspaceId, query),  // precise who-calls/impact/trace, or null
    symbols:         _buildSymbolGraphAnswer(workspaceId, query), // precise routes/models inventory, or null
    repoDigest:      _buildRepoDigestAnswer(workspaceId, query, index), // whole-repo digest for overview queries, or null
  };
}

// ── Call-graph intent (function-level: who-calls / impact / trace) ─────────────
//
// The keyword index answers "where is X" (file-level). These three flagship
// questions need the function→function call graph instead:
//   "who calls X?"              → direct callers               (whoCalls)
//   "what breaks if I change X?"→ transitive callers           (impactOf)
//   "trace X" / call chain      → forward callee chain          (traceFrom)
// Detected here so the prompt carries exact, source-derived caller/callee
// facts rather than leaving the model to infer relationships from snippets.
// Returns null unless the query has call-graph intent AND names a symbol the
// graph actually knows — so ordinary retrieval is never disturbed.

const CG_MAX_CALLERS = 15;
const CG_MAX_NODES   = 25;   // cap rendered impact / trace fan-out

const CG_IMPACT_RE  = /\bimpact of\b|\bblast radius\b|\bbreaks?\b|\bwould break\b|\b(what|which|anything)\b[^?]*\b(break|affect|depend)\w*|\b(change|changing|modify|modifying|edit|editing|touch|touching|remove|removing|delete|deleting|rename|renaming)\b[^?]*\b(break|affect|safe|risk)\w*/i;
const CG_TRACE_RE   = /\btrace\b|\bcall chain\b|\bcall graph\b|\bdownstream\b|\b(flow|path)\b[^?]*\b(through|of|from)\b|\bwhat does\b[^?]*\bcall\b|\bwhat (it|this|that) calls\b|\breaches?\b/i;
const CG_CALLERS_RE = /\bwho calls\b|\bwho uses\b|\bwho invokes\b|\bcallers?\b|\bcall(s|ers) of\b|\bwhat calls\b|\bused by\b|\breferenced by\b|\binvocations?\b/i;

/**
 * Pick the query token the call graph actually knows (defined, called, or a
 * caller). Longest match wins so "hashPassword" beats "hash"; sub-3-char noise
 * and non-identifiers are ignored.
 */
function _resolveSymbol(g, query) {
  const known = n => g.defs.has(n) || g.callers.has(n) || g.callees.has(n);
  const cands = query.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const ranked = [...new Set(cands)]
    .filter(t => t.length >= 3 && known(t))
    .sort((a, b) => b.length - a.length);
  return ranked[0] ?? null;
}

function _buildCallGraphAnswer(workspaceId, query) {
  const g = getCallGraph(workspaceId);
  if (!g) return null;

  const wantImpact  = CG_IMPACT_RE.test(query);
  const wantTrace   = CG_TRACE_RE.test(query);
  const wantCallers = CG_CALLERS_RE.test(query);
  if (!wantImpact && !wantTrace && !wantCallers) return null;

  const symbol = _resolveSymbol(g, query);
  if (!symbol) return null;

  const answer = { symbol, kinds: [], definedAt: getDefinitions(workspaceId, symbol).slice(0, 5) };

  if (wantCallers || wantImpact) {
    answer.directCallers = whoCalls(workspaceId, symbol).slice(0, CG_MAX_CALLERS);
    answer.kinds.push('callers');
  }
  if (wantImpact) {
    const imp = impactOf(workspaceId, symbol);
    answer.impact = {
      direct:     imp.direct.slice(0, CG_MAX_NODES),
      transitive: imp.transitive.slice(0, CG_MAX_NODES),
      truncated:  imp.truncated || imp.transitive.length > CG_MAX_NODES,
    };
    answer.kinds.push('impact');
  }
  if (wantTrace) {
    const tr = traceFrom(workspaceId, symbol);
    answer.callees = whatCalls(workspaceId, symbol).slice(0, CG_MAX_NODES);
    answer.trace = {
      transitive: tr.transitive.slice(0, CG_MAX_NODES),
      truncated:  tr.truncated || tr.transitive.length > CG_MAX_NODES,
    };
    answer.kinds.push('trace');
  }

  console.log(`[CALLGRAPH] Answered workspace=${workspaceId} symbol=${symbol} kinds=${answer.kinds.join('+')}`);
  return answer.kinds.length ? answer : null;
}

// ── Symbol-graph intent (routes + data-models) ────────────────────────────────
//
// Turns the queryable symbol graph into chat answers:
//   "list all endpoints" / "what routes exist"   → every route (getRoutes)
//   "where is POST /api/users handled?"            → matching routes (findRoutes)
//   "what data models exist?"                      → every model  (getModels)
//   "where is the User model?"                     → matching models (findModels)
// Returns null unless there is a clear routes/models intent AND the graph has a
// matching result, so ordinary retrieval is never disturbed.

const SG_MAX_ROUTES = 40;
const SG_MAX_MODELS = 30;

const SG_ROUTE_KW = /(?<!\/)\b(routes?|endpoints?|api ?routes?|url ?patterns?)\b/i;
const SG_MODEL_KW = /(?<!\/)\b(models?|schemas?|entit(?:y|ies)|db tables?|collections?|data ?models?)\b/i;
const SG_LISTY    = /\b(list|show|all|every|each|what|which|how many|enumerate|inventory|display|give me|there)\b/i;
const SG_METHOD   = /\b(GET|POST|PUT|PATCH|DELETE|MOUNT)\b/;                 // uppercase in the query
const SG_PATH     = /(\/[A-Za-z][A-Za-z0-9_:*.\-{}]*(?:\/[A-Za-z0-9_:*.\-{}]+)*)/;  // /api/users, /users/:id

function _buildSymbolGraphAnswer(workspaceId, query) {
  const g = getSymbolGraph(workspaceId);
  if (!g) return null;

  const listy   = SG_LISTY.test(query);
  const methodM = query.match(SG_METHOD);
  const pathM   = query.match(SG_PATH);
  const answer  = { modes: [] };

  // ── Routes ────────────────────────────────────────────────────────────────
  if (SG_ROUTE_KW.test(query) || pathM || methodM) {
    let routes = [];
    if (pathM)                             routes = findRoutes(workspaceId, pathM[1]);
    else if (SG_ROUTE_KW.test(query) && listy) routes = getRoutes(workspaceId);
    if (methodM && routes.length) routes = routes.filter(r => r.method === methodM[1].toUpperCase());
    if (routes.length) {
      answer.routeTotal = routes.length;
      answer.routes     = routes.slice(0, SG_MAX_ROUTES);
      answer.modes.push('routes');
    }
  }

  // ── Models ────────────────────────────────────────────────────────────────
  if (SG_MODEL_KW.test(query)) {
    const nameTok = _modelNameCandidate(g, query);
    let models = nameTok ? findModels(workspaceId, nameTok)
               : (listy ? getModels(workspaceId) : []);
    if (models.length) {
      answer.modelTotal = models.length;
      answer.models     = models.slice(0, SG_MAX_MODELS);
      answer.modes.push('models');
    }
  }

  if (!answer.modes.length) return null;
  console.log(`[SYMBOLGRAPH] Answered workspace=${workspaceId} modes=${answer.modes.join('+')} routes=${answer.routes?.length ?? 0} models=${answer.models?.length ?? 0}`);
  return answer;
}

// A capitalized identifier in the query that matches a known model name.
function _modelNameCandidate(g, query) {
  const names = new Set(g.models.map(m => m.name.toLowerCase()));
  for (const tok of query.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    if (tok.length >= 3 && names.has(tok.toLowerCase())) return tok;
  }
  return null;
}

// ── Whole-repo digest intent ──────────────────────────────────────────────────
//
// For "explain the whole codebase" / "give me an overview" / "how is this
// project structured" questions, the flat top-k file set is not enough — the
// model needs whole-repo awareness. Attach a token-bounded hierarchical digest
// (contextCompressor) so it sees every file's skeleton within a budget. Only
// fires for overview intent AND a repo big enough to be worth compressing
// (small repos are already fully covered by the top-k files).

const DIGEST_MIN_FILES = 8;
const DIGEST_BUDGET    = 1500;   // modest — a map, not a dump

const DIGEST_RE = /\b(whole|entire|overall|complete)\b[^.?!]*\b(repo|repository|codebase|code ?base|project|app|application|system|thing)\b|\b(overview|structure|architecture|tour|walk[- ]?through|high[- ]?level|big[- ]?picture|lay ?of the land)\b[^.?!]*\b(repo|repository|codebase|code ?base|project|app|application|system|everything|code|it)\b|\bexplain (the |this )?(repo|repository|codebase|code ?base|project|app|whole thing|everything|it all)\b|\bwhat does (this|the) (repo|repository|codebase|project|app|code)\b[^.?!]*\b(do|contain|look like)\b|\bproject structure\b|\bhow (is|does) (the |this )?(project|repo|repository|codebase|code|app) (structured|organi[sz]ed|laid out|work|fit together)\b|\b(summari[sz]e|describe) (the |this )?(whole |entire |overall )?(repo|repository|codebase|code ?base|project)\b/i;

function _buildRepoDigestAnswer(workspaceId, query, index) {
  if (!index || index.byPath.size < DIGEST_MIN_FILES) return null;
  if (!DIGEST_RE.test(query)) return null;
  const result = buildRepoDigest(workspaceId, { tokenBudget: DIGEST_BUDGET });
  if (!result) return null;
  console.log(`[DIGEST] Attached to chat context workspace=${workspaceId} est=${result.stats.estTokens} detailed=${result.stats.detailed}`);
  return result.digest;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

// Phase 2c semantic blend. Keyword signals here are small (path hit 30, fn 25,
// topic bonus up to ~40) — unlike memory's 60–500 — so the semantic weight is
// scaled DOWN to match: a strong match (cosine ~0.8 → +62) rivals a path hit
// without steamrolling a file that has several genuine keyword hits. Cosine
// below the floor contributes nothing (unrelated code still sits ~0.3–0.5).
const PROJECT_SEM_FLOOR  = 0.55;
const PROJECT_SEM_WEIGHT = 250;

function _score(filePath, meta, query, index, semanticScores = null) {
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

  // 6. Semantic similarity (Phase 2c) — inert when semanticScores is null.
  //    A file matched ONLY by semantics (no keyword) still clears score > 0 and
  //    is surfaced — exactly the paraphrase/synonym case keyword retrieval misses.
  if (semanticScores) {
    const sim = semanticScores.get(filePath);
    if (typeof sim === 'number' && sim > PROJECT_SEM_FLOOR) {
      score += (sim - PROJECT_SEM_FLOOR) * PROJECT_SEM_WEIGHT;
    }
  }

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
  if (!context || (!context.files?.length && !context.callGraph && !context.symbols && !context.repoDigest)) return '';

  const lines = [
    '--- PROJECT CONTEXT ---',
    `Project type: ${context.projectType} | Total indexed files: ${context.totalFiles}`,
  ];

  // Precise call-graph answer (who-calls / impact / trace) goes high — these
  // are exact source facts and should anchor the reply over inferred snippets.
  const callGraphBlock = _formatCallGraph(context.callGraph);
  if (callGraphBlock) lines.push('', callGraphBlock);

  const symbolsBlock = _formatSymbolAnswer(context.symbols);
  if (symbolsBlock) lines.push('', symbolsBlock);

  if (context.repoDigest) lines.push('', context.repoDigest);

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

  if (context.files?.length) lines.push('', 'Relevant files (ranked by query relevance):');

  for (const file of context.files ?? []) {
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

// Render the precise call-graph answer. Exact, source-derived — presented as
// authoritative so the model reports these relationships rather than guessing.
function _formatCallGraph(cg) {
  if (!cg?.kinds?.length) return '';
  const L = ['--- CALL GRAPH (exact, extracted from source) ---', `Symbol: ${cg.symbol}`];

  if (cg.definedAt?.length) {
    L.push(`Defined at: ${cg.definedAt.map(d => `${d.file}:${d.line}`).join(', ')}`);
  }

  if (cg.kinds.includes('callers')) {
    if (cg.directCallers?.length) {
      L.push('', `Direct callers of ${cg.symbol} (who calls it):`);
      for (const c of cg.directCallers) L.push(`  ${c.caller}() — ${c.file}:${c.line}`);
    } else {
      L.push('', `No direct callers of ${cg.symbol} found — it is an entry point, a leaf, or invoked dynamically (name-based graph cannot see reflective/dynamic calls).`);
    }
  }

  if (cg.impact) {
    const t = cg.impact.transitive;
    L.push('', `Impact if ${cg.symbol} changes — ${t.length} function(s) transitively depend on it${cg.impact.truncated ? ' (truncated)' : ''}:`);
    L.push(`  Directly affected: ${cg.impact.direct.length ? cg.impact.direct.join(', ') : '(none)'}`);
    if (t.length) L.push(`  Transitively affected: ${t.join(', ')}`);
  }

  if (cg.trace) {
    L.push('', `Call chain from ${cg.symbol} (what it triggers downstream)${cg.trace.truncated ? ' (truncated)' : ''}:`);
    L.push(`  Immediate callees: ${cg.callees?.length ? cg.callees.join(', ') : '(none)'}`);
    if (cg.trace.transitive.length) L.push(`  Reaches: ${cg.trace.transitive.join(', ')}`);
  }

  L.push('These caller/callee facts are exact — prefer them over inferring relationships from code snippets.');
  return L.join('\n');
}

// Render the routes/models answer. Exact, source-derived — presented as
// authoritative so the model reports the real endpoint/model inventory.
function _formatSymbolAnswer(sa) {
  if (!sa?.modes?.length) return '';
  const L = ['--- ROUTES & MODELS (exact, extracted from source) ---'];

  if (sa.routes?.length) {
    const shown = sa.routes.length;
    L.push('', `Endpoints (${sa.routeTotal} total${shown < sa.routeTotal ? `, showing ${shown}` : ''}):`);
    const w = Math.min(6, Math.max(...sa.routes.map(r => r.method.length)));
    for (const r of sa.routes) {
      const handler = r.handler && r.handler !== 'inline' ? ` → ${r.handler}` : '';
      L.push(`  ${r.method.padEnd(w)} ${r.httpPath}${handler}  (${r.file}:${r.line})`);
    }
  }

  if (sa.models?.length) {
    L.push('', `Data models (${sa.modelTotal} total${sa.models.length < sa.modelTotal ? `, showing ${sa.models.length}` : ''}):`);
    for (const m of sa.models) L.push(`  ${m.name} (${m.orm})  ${m.file}:${m.line}`);
  }

  L.push('These endpoints/models are exact — prefer them over inferring routes or models from code snippets.');
  return L.join('\n');
}
