/**
 * AQUA Symbol Graph — routes + data-models
 *
 * The keyword index (projectIndex.bySymbol) answers "where is function/class X".
 * The dependency + call graphs answer "who imports / who calls X". Neither can
 * answer the other half of code navigation for a web-app codebase:
 *
 *   "list every endpoint"                     → getRoutes()
 *   "where is POST /api/users handled?"        → findRoutes('/api/users')
 *   "what data models exist / where is User?"  → getModels() / findModels('User')
 *
 * workspaceAnalyzer already surfaces a *summary* route list in the cached
 * overview, but it is capped, carries no line numbers, no handler name, and is
 * not individually queryable. This module produces the precise, complete,
 * queryable version: each record has file + line, routes additionally carry the
 * resolved handler reference and the function they are registered inside.
 *
 * Zero external dependencies — regex extraction over source, exactly like
 * fileParser.js / callGraph.js. String/comment noise is filtered by validating
 * each match against callGraph's maskCode() (a route written inside a comment or
 * a string literal is ignored). Handler / enclosing-function resolution reuses
 * callGraph's extractBraceFunctions().
 *
 * Limitations (documented, not bugs):
 *   • Route detection covers Express/Koa/Fastify-style `x.method('path'…)`,
 *     Python `@app/@router` decorators, and Next.js `pages|app/api/**` files.
 *     Custom routers whose object name is not router/app/api/server/fastify are
 *     not matched.
 *   • Handler resolution is a heuristic: a trailing bare identifier chain is
 *     reported as the handler; an inline arrow/function is reported as 'inline'.
 *   • Model detection covers Mongoose (model()/new Schema), Sequelize
 *     (define()/extends Model), TypeORM (@Entity class), Prisma (.prisma model),
 *     and SQL `CREATE TABLE`. SQL embedded inside JS template strings is masked
 *     out and therefore not detected — only .sql / .prisma files and real-code
 *     SQL are seen.
 */
import { maskCode, extractBraceFunctions } from './callGraph.js';

const CODE_LANGS = new Set(['javascript', 'typescript']);

// Per-workspace state: { routes, models, builtAt, fileCount }
const graphs = new Map();

// ── Route patterns (JS_ROUTE_RE / PY_ROUTE_RE kept aligned with
//    workspaceAnalyzer.js so both detectors agree on what a route is) ──────────
const JS_ROUTE_RE = /(?:router|app|api|server|fastify)\s*\.\s*(get|post|put|patch|delete|all|use|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const PY_ROUTE_RE = /@(?:app|router|api|bp|blueprint)\.\s*(?:route\s*\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]+)\])?|(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"])/g;

// ── Model / schema patterns ───────────────────────────────────────────────────
const MONGOOSE_MODEL_RE  = /\b(?:mongoose\s*\.\s*)?model\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Za-z_$][\w$]*)['"]/g;
const MONGOOSE_SCHEMA_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:mongoose\s*\.\s*)?Schema\b/g;
const SEQUELIZE_DEFINE_RE = /\bsequelize\s*\.\s*define\s*\(\s*['"]([A-Za-z_$][\w$]*)['"]/g;
const CLASS_MODEL_RE      = /\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+(?:[\w$.]*\.)?Model\b/g;
const TYPEORM_ENTITY_RE   = /@Entity\s*\([^)]*\)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
const PRISMA_MODEL_RE     = /\bmodel\s+([A-Za-z_$][\w$]*)\s*\{/g;
const SQL_TABLE_RE        = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_$][\w$.]*)[`"']?/gi;

const JS_KEYWORDS = new Set([
  'req', 'res', 'next', 'err', 'error', 'async', 'await', 'function', 'return',
  'this', 'req', 'request', 'response', 'ctx', 'context',
]);

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build (or rebuild) the symbol graph for a workspace.
 *
 * @param {string} workspaceId
 * @param {Array<{path:string, content:string, lang:string}>} files enriched entries
 * @returns {{routes, models, builtAt, fileCount}}
 */
export function buildSymbolGraph(workspaceId, files = []) {
  const routes = [];
  const models = [];

  for (const file of files) {
    const { path: filePath, content, lang } = file;
    if (!content) continue;

    const isCode = CODE_LANGS.has(lang);
    const masked = isCode ? maskCode(content, lang) : null;
    const realAt = idx => !masked || masked[idx] !== ' ';   // false ⇒ inside string/comment
    const fns    = isCode ? extractBraceFunctions(masked) : [];

    // ── Routes ────────────────────────────────────────────────────────────────
    if (isCode) {
      for (const m of content.matchAll(JS_ROUTE_RE)) {
        if (!realAt(m.index)) continue;
        let method = m[1].toUpperCase();
        const httpPath = m[2];
        if (method === 'USE' && !httpPath.startsWith('/')) continue;   // app.use(mw) — not a route
        if (method === 'USE') method = 'MOUNT';
        routes.push(_route(method, httpPath, filePath, content, m.index, fns));
      }
      // Next.js file-system API routes
      if (/(?:^|\/)(?:pages|app)\/api\//.test(filePath)) {
        const httpPath = '/' + filePath
          .replace(/^.*?(?:pages|app)\//, '')
          .replace(/\.(js|ts)x?$/, '')
          .replace(/\/route$/, '');
        routes.push({ kind: 'route', method: 'FS', httpPath, handler: null, registeredIn: '(module)', file: filePath, line: 1 });
      }
    } else if (lang === 'python') {
      for (const m of content.matchAll(PY_ROUTE_RE)) {
        const httpPath = m[1] ?? m[4];
        if (!httpPath) continue;
        const method = m[3]
          ? m[3].toUpperCase()
          : (m[2] ? m[2].replace(/['"\s]/g, '').split(',')[0].toUpperCase() : 'GET');
        routes.push({ kind: 'route', method, httpPath, handler: null, registeredIn: null, file: filePath, line: _lineAt(content, m.index) });
      }
    }

    // ── Models ────────────────────────────────────────────────────────────────
    if (isCode) {
      _collect(models, content, MONGOOSE_MODEL_RE,   filePath, 'mongoose',  realAt);
      _collect(models, content, MONGOOSE_SCHEMA_RE,  filePath, 'mongoose',  realAt);
      _collect(models, content, SEQUELIZE_DEFINE_RE, filePath, 'sequelize', realAt);
      _collect(models, content, CLASS_MODEL_RE,      filePath, 'sequelize', realAt);
      _collect(models, content, TYPEORM_ENTITY_RE,   filePath, 'typeorm',   realAt);
    }
    // Prisma schema + SQL DDL live in their own file types — masking those langs
    // is not meaningful, so scan raw (comments there are rare and low-risk).
    if (/\.prisma$/.test(filePath)) {
      _collect(models, content, PRISMA_MODEL_RE, filePath, 'prisma', () => true);
    }
    if (/\.sql$/.test(filePath) || lang === 'sql') {
      _collect(models, content, SQL_TABLE_RE, filePath, 'sql', () => true);
    }
  }

  const state = {
    routes:    _dedupeRoutes(routes),
    models:    _dedupeModels(models),
    builtAt:   Date.now(),
    fileCount: files.length,
  };
  graphs.set(workspaceId, state);
  console.log(`[SYMBOLGRAPH] Built workspace=${workspaceId} routes=${state.routes.length} models=${state.models.length} files=${files.length}`);
  return state;
}

function _route(method, httpPath, filePath, content, idx, fns) {
  return {
    kind:         'route',
    method,
    httpPath,
    handler:      _resolveHandler(content, idx),
    registeredIn: _enclosingFn(fns, idx),
    file:         filePath,
    line:         _lineAt(content, idx),
  };
}

/**
 * Handler heuristic: read the route-registration line from just after the path
 * string. If it contains an inline arrow/function, report 'inline'; otherwise
 * report the last bare identifier chain on the line (the terminal handler arg).
 */
function _resolveHandler(content, idx) {
  const nl   = content.indexOf('\n', idx);
  const tail = content.slice(idx, nl === -1 ? content.length : nl);
  const afterPath = tail
    .replace(/^[^'"`]*['"`][^'"`]*['"`]/, '')   // drop `x.method('path'`
    .split('//')[0].split('/*')[0];             // drop trailing comment
  if (/=>|\bfunction\b/.test(afterPath)) return 'inline';
  const ids = afterPath.match(/[A-Za-z_$][\w$.]*/g) ?? [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const head = ids[i].split('.')[0];
    if (!JS_KEYWORDS.has(head)) return ids[i];
  }
  return null;
}

function _enclosingFn(fns, idx) {
  let best = null;
  for (const f of fns) {
    if (idx >= f.start && idx <= f.end && (!best || f.start > best.start)) best = f;
  }
  return best ? best.name : '(module)';
}

function _collect(out, content, re, filePath, orm, realAt) {
  for (const m of content.matchAll(re)) {
    if (!realAt(m.index)) continue;
    const name = m[1];
    if (!name) continue;
    out.push({ kind: 'model', name, orm, file: filePath, line: _lineAt(content, m.index) });
  }
}

function _lineAt(content, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}

function _dedupeRoutes(routes) {
  const seen = new Set();
  return routes.filter(r => {
    const k = `${r.method} ${r.httpPath} ${r.file}:${r.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function _dedupeModels(models) {
  const seen = new Set();
  return models.filter(m => {
    const k = `${m.name} ${m.orm} ${m.file}:${m.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function getSymbolGraph(workspaceId) {
  return graphs.get(workspaceId) ?? null;
}

export function clearSymbolGraph(workspaceId) {
  return graphs.delete(workspaceId);
}

/** Every route, optionally filtered by HTTP method. */
export function getRoutes(workspaceId, method = null) {
  const g = graphs.get(workspaceId);
  if (!g) return [];
  return method ? g.routes.filter(r => r.method === method.toUpperCase()) : g.routes;
}

/** Every data-model, optionally filtered by ORM. */
export function getModels(workspaceId, orm = null) {
  const g = graphs.get(workspaceId);
  if (!g) return [];
  return orm ? g.models.filter(m => m.orm === orm) : g.models;
}

/** Routes whose path (or "METHOD path") contains `query`, case-insensitive. */
export function findRoutes(workspaceId, query) {
  const g = graphs.get(workspaceId);
  if (!g || !query) return [];
  const q = String(query).toLowerCase();
  return g.routes.filter(r =>
    r.httpPath.toLowerCase().includes(q) ||
    `${r.method} ${r.httpPath}`.toLowerCase().includes(q),
  );
}

/** Models whose name contains `query`, case-insensitive. */
export function findModels(workspaceId, query) {
  const g = graphs.get(workspaceId);
  if (!g || !query) return [];
  const q = String(query).toLowerCase();
  return g.models.filter(m => m.name.toLowerCase().includes(q));
}

export function serializeSymbolGraph(workspaceId) {
  const g = graphs.get(workspaceId);
  if (!g) return null;
  return { builtAt: g.builtAt, fileCount: g.fileCount, routes: g.routes, models: g.models };
}

export function getSymbolGraphStats(workspaceId) {
  const g = graphs.get(workspaceId);
  if (!g) return null;
  const byMethod = {};
  for (const r of g.routes) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
  const byOrm = {};
  for (const m of g.models) byOrm[m.orm] = (byOrm[m.orm] ?? 0) + 1;
  return { routes: g.routes.length, models: g.models.length, byMethod, byOrm, builtAt: g.builtAt, fileCount: g.fileCount };
}
