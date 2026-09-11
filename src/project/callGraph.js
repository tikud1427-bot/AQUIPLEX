/**
 * AQUA Call Graph
 *
 * Symbol-level call graph: which functions call which OTHER known functions.
 * Complements dependencyGraph.js (which is file→file, import level). This is
 * function→function, call level — the layer the three flagship code-intel
 * questions need:
 *
 *   whoCalls(ws, sym)   → "Who calls this?"            (direct callers)
 *   impactOf(ws, sym)   → "What breaks if I modify X?" (transitive callers)
 *   traceFrom(ws, sym)  → "Trace this request."        (forward call chain)
 *   whatCalls(ws, sym)  → callees invoked by a function
 *
 * ── Approach (no AST, zero new deps — matches fileParser.js doctrine) ─────────
 * 1. maskCode(): blank out strings + comments to spaces (length preserved), so
 *    brace matching and the call-site regex only ever see real code.
 * 2. extract*Functions(): find NAMED function bodies (decl / expr / method /
 *    arrow / Python def) with their character extents. Anonymous callbacks are
 *    intentionally NOT captured — calls inside them roll up to the nearest
 *    enclosing named function (or module scope), which is what a reader wants.
 * 3. For every `ident(` in a file, if `ident` is a KNOWN workspace symbol
 *    (a function/class/export defined somewhere in the repo) and is not a bare
 *    property access (`.ident(`), record an edge caller→ident.
 *
 * Precision is deliberately traded for zero-dependency robustness. Known,
 * documented limitations:
 *   - Name-based, not scope-resolved: two functions named `handler` collapse
 *     to one node (both call locations kept; callers of the name returned).
 *   - `name = function(){}` expression assigns and generic calls `foo<T>()`
 *     are not attributed to a caller name (roll up to enclosing scope).
 *   - Calls inside template-literal `${…}` interpolations are not scanned.
 * These never crash and never block — a missed edge degrades gracefully.
 *
 * Shape mirrors dependencyGraph.js exactly: one in-memory Map<workspaceId,…>,
 * a pure build, and side-effect-free queries. Built beside the dependency
 * graph at every ingest/edit seam.
 */

// workspaceId → CallGraphState
const graphs = new Map();

// Reserved words that look like `kw(` but are never function calls, and
// identifiers that would create noise as callers. Callee edges are ALSO gated
// by the known-symbol set, so this is mostly belt-and-suspenders.
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof',
  'await', 'super', 'new', 'delete', 'void', 'in', 'of', 'instanceof', 'yield',
  'else', 'do', 'try', 'finally', 'throw', 'case', 'default', 'with', 'const',
  'let', 'var', 'class', 'import', 'export', 'from', 'as', 'async',
  'def', 'elif', 'lambda', 'and', 'or', 'not', 'is', 'pass', 'raise', 'assert',
  'global', 'nonlocal',
]);

const MODULE = '(module)';

// Only these langs have a meaningful call graph. Everything else (json, md,
// pdf, images, …) is skipped — no functions to link.
const CODE_LANGS = new Set([
  'javascript', 'typescript', 'python', 'java', 'kotlin', 'go', 'rust',
  'csharp', 'php',
]);

// ── Public: build ─────────────────────────────────────────────────────────────

/**
 * Build (or rebuild) the call graph for a workspace from parsed+enriched files.
 * `files` is the same array dependencyGraph gets: each entry has `path`, `lang`,
 * `content`, and parse metadata (`functions`, `classes`, `exports`, …).
 *
 * @param {string} workspaceId
 * @param {Array<{path:string, lang:string, content?:string, functions?:string[], classes?:Array, exports?:string[]}>} files
 * @returns {CallGraphState}
 */
export function buildCallGraph(workspaceId, files = []) {
  const known = _knownSymbols(files);

  const state = {
    // callee → [{ caller, file, line }]   (who calls callee)
    callers: new Map(),
    // callerKey `${file}::${caller}` → Set<callee>   (what a caller calls)
    callees: new Map(),
    // symbol → [{ file, line }]   (definition sites)
    defs: new Map(),
    // name-level adjacency for O(1) BFS
    callersOfName: new Map(),   // name → Set<callerName>
    calleesOfName: new Map(),   // name → Set<calleeName>
    builtAt: Date.now(),
    fileCount: files.length,
    symbolCount: known.size,
    edgeCount: 0,
  };

  for (const file of files) {
    if (!CODE_LANGS.has(file.lang)) continue;
    const content = file.content;
    if (typeof content !== 'string' || !content) continue;

    try {
      _indexFile(state, file.path, content, file.lang, known);
    } catch {
      // A single malformed file must never break the whole graph.
    }
  }

  graphs.set(workspaceId, state);
  console.log(
    `[CALLS] Call graph built workspace=${workspaceId} files=${files.length} ` +
    `symbols=${state.symbolCount} edges=${state.edgeCount}`,
  );
  return state;
}

/** Union of all function/class/export names defined anywhere in the workspace. */
function _knownSymbols(files) {
  const set = new Set();
  for (const f of files) {
    for (const fn of f.functions ?? []) if (fn) set.add(fn);
    for (const cl of f.classes ?? []) {
      const name = typeof cl === 'string' ? cl : cl?.name;
      if (name) set.add(name);
    }
    for (const ex of f.exports ?? []) if (ex) set.add(ex);
  }
  set.delete('');
  return set;
}

function _indexFile(state, filePath, content, lang, known) {
  const masked = maskCode(content, lang);
  const lineStarts = _lineStarts(content);
  const lineAt = (off) => _lineAt(lineStarts, off);

  const funcs = lang === 'python'
    ? extractPythonFunctions(masked)
    : extractBraceFunctions(masked);

  // Record definition sites + their name offsets (to skip def headers as calls).
  const defOffsets = new Set();
  for (const fn of funcs) {
    defOffsets.add(fn.nameOffset);
    _push(state.defs, fn.name, { file: filePath, line: lineAt(fn.nameOffset) });
  }

  // Sort by span so innermost-enclosing lookup is a simple linear min.
  funcs.sort((a, b) => (a.end - a.start) - (b.end - b.start));

  const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callRe.exec(masked)) !== null) {
    const name = m[1];
    const off = m.index;
    if (defOffsets.has(off)) continue;              // it's a definition header
    if (KEYWORDS.has(name)) continue;               // if( / for( / return( …
    if (!known.has(name)) continue;                 // not a repo-defined symbol
    if (off > 0 && masked[off - 1] === '.') continue; // obj.method( — not a bare call

    const caller = _innermost(funcs, off);
    const line = lineAt(off);

    // callee → callers
    _push(state.callers, name, { caller, file: filePath, line });
    // caller → callees
    const key = `${filePath}::${caller}`;
    if (!state.callees.has(key)) state.callees.set(key, new Set());
    state.callees.get(key).add(name);
    // name-level adjacency
    _addName(state.callersOfName, name, caller);
    _addName(state.calleesOfName, caller, name);
    state.edgeCount++;
  }
}

/** Innermost enclosing named function for a call at `off`, else '(module)'. */
function _innermost(sortedFuncs, off) {
  for (const fn of sortedFuncs) {
    if (off >= fn.start && off < fn.end) return fn.name;
  }
  return MODULE;
}

// ── Code masking ──────────────────────────────────────────────────────────────

/**
 * Return a copy of `content` with every string literal and comment replaced by
 * spaces (newlines preserved, so offsets and line numbers stay identical).
 * After masking, no `{`, `}`, `(`, `)` or `ident(` inside a string/comment can
 * fool the brace matcher or the call-site regex.
 *
 * Handles JS/TS/Java/Go/Rust/C#/PHP (`//`, block, ' " `) and Python (`#`,
 * ''' """ ' "). Regex literals are intentionally not masked (documented).
 */
export function maskCode(content, lang) {
  const py = lang === 'python';
  const n = content.length;
  let out = '';
  let i = 0;
  // state: code | line | block | sq | dq | bt | tsq | tdq   (t* = triple)
  let state = 'code';

  const blankNL = (c) => (c === '\n' ? '\n' : c === '\t' ? '\t' : ' ');

  while (i < n) {
    const c = content[i];
    const c2 = content[i + 1];
    const c3 = content[i + 2];

    if (state === 'code') {
      if (!py && c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (!py && c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (py && c === '#') { state = 'line'; out += ' '; i += 1; continue; }
      if (py && (c === "'" || c === '"') && c2 === c && c3 === c) {
        state = c === "'" ? 'tsq' : 'tdq'; out += '   '; i += 3; continue;
      }
      if (c === "'") { state = 'sq'; out += ' '; i += 1; continue; }
      if (c === '"') { state = 'dq'; out += ' '; i += 1; continue; }
      if (!py && c === '`') { state = 'bt'; out += ' '; i += 1; continue; }
      out += c; i += 1; continue;
    }

    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
      out += blankNL(c); i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += blankNL(c); i += 1; continue;
    }

    // single-line strings (may contain escapes)
    if (state === 'sq' || state === 'dq' || state === 'bt') {
      if (c === '\\') { out += ' ' + (c2 === '\n' ? '\n' : ' '); i += 2; continue; }
      const q = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
      if (c === q) { state = 'code'; out += ' '; i += 1; continue; }
      out += blankNL(c); i += 1; continue;
    }

    // python triple-quoted strings
    if (state === 'tsq' || state === 'tdq') {
      const q = state === 'tsq' ? "'" : '"';
      if (c === q && c2 === q && c3 === q) { state = 'code'; out += '   '; i += 3; continue; }
      out += blankNL(c); i += 1; continue;
    }
  }
  return out;
}

// ── Function extraction: brace languages ──────────────────────────────────────

/**
 * Extract NAMED function bodies from masked brace-language source.
 * Strategy: every `{` that is a function body opener is immediately preceded
 * (ignoring whitespace + an optional TS return type) by `)` (params close) or
 * `=>`. From there we resolve the function's name by scanning backwards.
 *
 * @returns {Array<{name:string, nameOffset:number, start:number, end:number}>}
 */
export function extractBraceFunctions(masked) {
  const funcs = [];
  const n = masked.length;

  for (let i = 0; i < n; i++) {
    if (masked[i] !== '{') continue;

    // Walk back over whitespace.
    let j = i - 1;
    while (j >= 0 && /\s/.test(masked[j])) j--;
    if (j < 0) continue;

    // Arrow body:  … => {
    if (j >= 1 && masked[j] === '>' && masked[j - 1] === '=') {
      const info = _resolveArrowName(masked, j - 2);
      if (info) _pushFunc(funcs, info, masked, i);
      continue;
    }

    // Skip an optional TS return type:  ): Promise<X> {   →   step j back to ')'
    if (masked[j] !== ')') {
      const back = _skipReturnType(masked, j);
      if (back < 0) continue;         // not a return-type tail → not a fn body
      j = back;
    }
    if (masked[j] !== ')') continue;

    // params close → find matching '(' → resolve name before it
    const open = _matchParenBack(masked, j);
    if (open < 0) continue;
    const info = _resolveNameBeforeParen(masked, open);
    if (!info) continue;              // anonymous / control block → skip

    _pushFunc(funcs, info, masked, i);
  }
  return funcs;
}

function _pushFunc(funcs, info, masked, braceIdx) {
  const end = _matchBrace(masked, braceIdx);
  if (end < 0) return;
  funcs.push({ name: info.name, nameOffset: info.offset, start: info.offset, end });
}

/** From the char index of a return-type tail char, step back to its ')'. */
function _skipReturnType(masked, j) {
  // pattern: ) \s* : \s* <type chars> \s* {   — j currently on last type char.
  let k = j;
  while (k >= 0 && /[\w<>[\].,\s|&?]/.test(masked[k])) k--;
  if (k < 0 || masked[k] !== ':') return -1;
  k--;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  return (k >= 0 && masked[k] === ')') ? k : -1;
}

/** Resolve `name = (..) =>` / `name = x =>` / `key: (..) =>` given index at end of params. */
function _resolveArrowName(masked, endOfParams) {
  let k = endOfParams;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  if (k < 0) return null;

  // param group: either ')' (multi/paren) or a single bare identifier
  if (masked[k] === ')') {
    const open = _matchParenBack(masked, k);
    if (open < 0) return null;
    k = open - 1;
  } else if (/[\w$]/.test(masked[k])) {
    while (k >= 0 && /[\w$]/.test(masked[k])) k--;   // skip single param ident
  } else {
    return null;
  }

  while (k >= 0 && /\s/.test(masked[k])) k--;
  if (k < 0) return null;

  // optional 'async' keyword before params
  if (masked[k] === 'c' && masked.slice(k - 4, k + 1) === 'async') {
    k -= 5;
    while (k >= 0 && /\s/.test(masked[k])) k--;
  }

  // connector: '=' (assignment) or ':' (object property)
  if (masked[k] !== '=' && masked[k] !== ':') return null;
  // don't treat '==', '=>', '<=', '>=' etc. as assignment
  if (masked[k] === '=' && (masked[k - 1] === '=' || masked[k - 1] === '!' ||
      masked[k - 1] === '<' || masked[k - 1] === '>' || masked[k + 1] === '=')) return null;
  k--;
  while (k >= 0 && /\s/.test(masked[k])) k--;

  return _readIdentBack(masked, k);
}

/** Resolve the function name immediately before a params '(' at `openIdx`. */
function _resolveNameBeforeParen(masked, openIdx) {
  let k = openIdx - 1;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  const info = _readIdentBack(masked, k);
  if (!info) return null;                         // anonymous: `function(` / `(`
  if (KEYWORDS.has(info.name)) return null;       // control block / anon fn expr
  return info;
}

/** Read an identifier ending at index k (inclusive). Returns {name, offset}. */
function _readIdentBack(masked, k) {
  if (k < 0 || !/[\w$]/.test(masked[k])) return null;
  let end = k;
  while (k >= 0 && /[\w$]/.test(masked[k])) k--;
  const start = k + 1;
  // guard: must be a bare identifier, not part of `a.b` member access as a def
  if (start > 0 && masked[start - 1] === '.') return null;
  return { name: masked.slice(start, end + 1), offset: start };
}

/** Index of '(' matching the ')' at closeIdx (masked → no fake parens). */
function _matchParenBack(masked, closeIdx) {
  let depth = 0;
  for (let k = closeIdx; k >= 0; k--) {
    const c = masked[k];
    if (c === ')') depth++;
    else if (c === '(') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/** Index of '}' matching the '{' at openIdx (masked → no fake braces). */
function _matchBrace(masked, openIdx) {
  let depth = 0;
  const n = masked.length;
  for (let k = openIdx; k < n; k++) {
    const c = masked[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

// ── Function extraction: Python (indentation) ─────────────────────────────────

/**
 * Extract `def name(...)` bodies from masked Python. A body runs from the def
 * line to the next line whose indentation is ≤ the def's indent and is neither
 * blank nor a comment. Offsets are character offsets into the masked source.
 */
export function extractPythonFunctions(masked) {
  const funcs = [];
  const defRe = /(^|\n)([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/g;
  let m;
  while ((m = defRe.exec(masked)) !== null) {
    const indent = m[2].length;
    const name = m[3];
    const nameOffset = m.index + m[0].indexOf(name);
    const start = m.index + (m[1] ? m[1].length : 0);

    // Find the end: first subsequent line with indent ≤ def indent (non-blank,
    // non-comment). maskCode blanked '#' comments to spaces, so a comment line
    // is all-whitespace here and correctly skipped.
    let end = masked.length;
    const bodyRe = /\n([ \t]*)(\S?)/g;
    bodyRe.lastIndex = m.index + m[0].length;
    let b;
    while ((b = bodyRe.exec(masked)) !== null) {
      if (b[2] === '') continue;                 // blank / comment line
      if (b[1].length <= indent) { end = b.index; break; }
    }
    funcs.push({ name, nameOffset, start, end });
  }
  return funcs;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function getCallGraph(workspaceId) {
  return graphs.get(workspaceId) ?? null;
}

export function clearCallGraph(workspaceId) {
  return graphs.delete(workspaceId);
}

/** Where a symbol is defined. */
export function getDefinitions(workspaceId, symbol) {
  const g = graphs.get(workspaceId);
  return g ? _dedupeDefs(g.defs.get(symbol) ?? []) : [];
}

/** Direct callers of `symbol`: [{ caller, file, line }] (deduped). */
export function whoCalls(workspaceId, symbol) {
  const g = graphs.get(workspaceId);
  if (!g) return [];
  const seen = new Set();
  const out = [];
  for (const c of g.callers.get(symbol) ?? []) {
    const k = `${c.file}::${c.caller}:${c.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** Callees invoked by `caller` (across every file that defines it). */
export function whatCalls(workspaceId, caller) {
  const g = graphs.get(workspaceId);
  if (!g) return [];
  return [...(g.calleesOfName.get(caller) ?? [])];
}

/**
 * Transitive callers — "what breaks if I change `symbol`?". Reverse reachability
 * over the name-level graph. Cycle-safe, depth- and node-bounded.
 *
 * @returns {{ symbol, direct:string[], transitive:string[], truncated:boolean }}
 */
export function impactOf(workspaceId, symbol, { maxDepth = 8, maxNodes = 500 } = {}) {
  return _bfsNames(graphs.get(workspaceId)?.callersOfName, symbol, maxDepth, maxNodes);
}

/**
 * Forward call chain — "trace this request". Reachability over callees.
 *
 * @returns {{ symbol, direct:string[], transitive:string[], truncated:boolean }}
 */
export function traceFrom(workspaceId, symbol, { maxDepth = 8, maxNodes = 500 } = {}) {
  return _bfsNames(graphs.get(workspaceId)?.calleesOfName, symbol, maxDepth, maxNodes);
}

function _bfsNames(adj, symbol, maxDepth, maxNodes) {
  const result = { symbol, direct: [], transitive: [], truncated: false };
  if (!adj) return result;

  const direct = [...(adj.get(symbol) ?? [])].filter(n => n !== MODULE);
  result.direct = direct;

  const visited = new Set([symbol]);
  let frontier = direct.filter(n => n !== symbol);
  frontier.forEach(n => visited.add(n));
  const all = new Set(frontier);

  let depth = 1;
  while (frontier.length && depth < maxDepth) {
    const next = [];
    for (const node of frontier) {
      for (const nb of adj.get(node) ?? []) {
        if (nb === MODULE || visited.has(nb)) continue;
        visited.add(nb);
        all.add(nb);
        next.push(nb);
        if (all.size >= maxNodes) { result.truncated = true; break; }
      }
      if (result.truncated) break;
    }
    if (result.truncated) break;
    frontier = next;
    depth++;
  }
  if (frontier.length) result.truncated = true;

  result.transitive = [...all];
  return result;
}

/** JSON-safe summary for the API + debugging. */
export function serializeCallGraph(workspaceId) {
  const g = graphs.get(workspaceId);
  if (!g) return null;
  const callers = {};
  for (const [callee, list] of g.callers.entries()) {
    callers[callee] = list.map(c => ({ caller: c.caller, file: c.file, line: c.line }));
  }
  return {
    builtAt: g.builtAt,
    fileCount: g.fileCount,
    symbolCount: g.symbolCount,
    edgeCount: g.edgeCount,
    callers,
  };
}

export function getCallGraphStats(workspaceId) {
  const g = graphs.get(workspaceId);
  if (!g) return null;
  return {
    functions: g.callees.size,
    calledSymbols: g.callers.size,
    edges: g.edgeCount,
    builtAt: g.builtAt,
    fileCount: g.fileCount,
  };
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function _push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function _addName(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function _dedupeDefs(defs) {
  const seen = new Set();
  const out = [];
  for (const d of defs) {
    const k = `${d.file}:${d.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

function _lineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function _lineAt(starts, offset) {
  // binary search: largest start ≤ offset
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans + 1; // 1-based line number
}
