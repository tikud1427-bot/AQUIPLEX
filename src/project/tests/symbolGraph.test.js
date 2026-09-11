/**
 * Symbol Graph tests — routes + data-models.
 * Direct unit tests on buildSymbolGraph (no ingestion needed): every assertion
 * checks exact, measurable output (method, path, line, handler, orm, name).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSymbolGraph, clearSymbolGraph, getSymbolGraph,
  getRoutes, getModels, findRoutes, findModels,
  serializeSymbolGraph, getSymbolGraphStats,
} from '../symbolGraph.js';

const js = (path, content) => ({ path, content, lang: 'javascript' });
const ts = (path, content) => ({ path, content, lang: 'typescript' });
const py = (path, content) => ({ path, content, lang: 'python' });

function build(ws, files) {
  clearSymbolGraph(ws);
  return buildSymbolGraph(ws, files);
}

// ── Routes: Express ────────────────────────────────────────────────────────────
test('express routes: method, path, line, named handler', () => {
  const ws = 'r1';
  build(ws, [js('src/routes/user.js', [
    "import { list, create } from './ctrl.js';",   // line 1
    "const router = express.Router();",             // line 2
    "router.get('/users', list);",                  // line 3
    "router.post('/users', auth, ctrl.create);",    // line 4
  ].join('\n'))]);

  const routes = getRoutes(ws);
  assert.equal(routes.length, 2);

  const get = routes.find(r => r.method === 'GET');
  assert.equal(get.httpPath, '/users');
  assert.equal(get.line, 3);
  assert.equal(get.handler, 'list');

  const post = routes.find(r => r.method === 'POST');
  assert.equal(post.line, 4);
  assert.equal(post.handler, 'ctrl.create', 'last identifier after middleware is the handler');
});

test('inline arrow handler reported as inline', () => {
  const ws = 'r2';
  build(ws, [js('a.js', "app.get('/health', (req, res) => res.send('ok'));")]);
  assert.equal(getRoutes(ws)[0].handler, 'inline');
});

test('trailing comment is not mistaken for the handler', () => {
  const ws = 'r3';
  build(ws, [js('a.js', "app.get('/ok', handler); // registers health route")]);
  assert.equal(getRoutes(ws)[0].handler, 'handler');
});

test('routes inside comments or strings are ignored (mask-validated)', () => {
  const ws = 'r4';
  build(ws, [js('a.js', [
    "// app.get('/dead', ghost);",
    'const doc = "app.post(\'/fake\', ghost)";',
    "app.get('/real', real);",
  ].join('\n'))]);
  const routes = getRoutes(ws);
  assert.equal(routes.length, 1, 'only the real route survives');
  assert.equal(routes[0].httpPath, '/real');
});

test('app.use middleware excluded; app.use(path, router) is a MOUNT', () => {
  const ws = 'r5';
  build(ws, [js('a.js', [
    "app.use(bodyParser.json());",       // not a route
    "app.use('/api', apiRouter);",       // mount
  ].join('\n'))]);
  const routes = getRoutes(ws);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].method, 'MOUNT');
  assert.equal(routes[0].httpPath, '/api');
});

test('fastify + router object names recognized', () => {
  const ws = 'r6';
  build(ws, [js('a.js', [
    "fastify.get('/f', fh);",
    "server.delete('/s/:id', sh);",
  ].join('\n'))]);
  const methods = getRoutes(ws).map(r => r.method).sort();
  assert.deepEqual(methods, ['DELETE', 'GET']);
});

test('registeredIn = enclosing function when route set up inside one', () => {
  const ws = 'r7';
  build(ws, [js('setup.js', [
    "function setupRoutes(app) {",   // line 1
    "  app.get('/x', xh);",          // line 2 — inside setupRoutes
    "}",                              // line 3
    "app.get('/y', yh);",            // line 4 — module scope
  ].join('\n'))]);
  const x = findRoutes(ws, '/x')[0];
  const y = findRoutes(ws, '/y')[0];
  assert.equal(x.registeredIn, 'setupRoutes');
  assert.equal(y.registeredIn, '(module)');
});

// ── Routes: Python ──────────────────────────────────────────────────────────────
test('flask decorators: @app.route with methods, and @router.get', () => {
  const ws = 'rpy';
  build(ws, [py('app.py', [
    "@app.route('/items', methods=['GET','POST'])",  // line 1
    "def items(): ...",                               // line 2
    "@router.get('/ping')",                           // line 3
    "def ping(): ...",                                // line 4
  ].join('\n'))]);
  const routes = getRoutes(ws);
  const items = routes.find(r => r.httpPath === '/items');
  assert.ok(items, 'route path extracted');
  assert.equal(items.line, 1);
  const ping = routes.find(r => r.httpPath === '/ping');
  assert.equal(ping.method, 'GET');
});

// ── Routes: Next.js FS ──────────────────────────────────────────────────────────
test('next.js file-system api route path derived from file path', () => {
  const ws = 'rnext';
  build(ws, [ts('pages/api/users/[id].ts', "export default function handler(){}")]);
  const routes = getRoutes(ws);
  assert.equal(routes[0].method, 'FS');
  assert.equal(routes[0].httpPath, '/api/users/[id]');
});

// ── Models ──────────────────────────────────────────────────────────────────────
test('mongoose: model() and new Schema captured', () => {
  const ws = 'm1';
  build(ws, [js('models/User.js', [
    "const UserSchema = new mongoose.Schema({ name: String });",  // line 1
    "module.exports = mongoose.model('User', UserSchema);",        // line 2
  ].join('\n'))]);
  const models = getModels(ws, 'mongoose');
  const names = models.map(m => m.name).sort();
  assert.deepEqual(names, ['User', 'UserSchema']);
  assert.equal(models.find(m => m.name === 'User').line, 2);
});

test('sequelize: define() and class extends Model', () => {
  const ws = 'm2';
  build(ws, [
    js('a.js', "const Post = sequelize.define('Post', {});"),
    js('b.js', "class Comment extends Model {}"),
  ]);
  const names = getModels(ws, 'sequelize').map(m => m.name).sort();
  assert.deepEqual(names, ['Comment', 'Post']);
});

test('typeorm @Entity class captured', () => {
  const ws = 'm3';
  build(ws, [ts('e.ts', "@Entity()\nexport class Product {\n  id: number;\n}")]);
  const models = getModels(ws, 'typeorm');
  assert.equal(models[0].name, 'Product');
});

test('prisma model in .prisma file', () => {
  const ws = 'm4';
  build(ws, [{ path: 'schema.prisma', lang: 'prisma', content: "model Account {\n  id Int @id\n}\nmodel Session {\n  id Int\n}" }]);
  const names = getModels(ws, 'prisma').map(m => m.name).sort();
  assert.deepEqual(names, ['Account', 'Session']);
});

test('sql CREATE TABLE captured from .sql file', () => {
  const ws = 'm5';
  build(ws, [{ path: 'schema.sql', lang: 'sql', content: "CREATE TABLE users (id INT);\nCREATE TABLE IF NOT EXISTS orders (id INT);" }]);
  const names = getModels(ws, 'sql').map(m => m.name).sort();
  assert.deepEqual(names, ['orders', 'users']);
});

test('model definition inside a comment is ignored', () => {
  const ws = 'm6';
  build(ws, [js('a.js', [
    "// const Ghost = sequelize.define('Ghost', {});",
    "const Real = sequelize.define('Real', {});",
  ].join('\n'))]);
  const names = getModels(ws).map(m => m.name);
  assert.deepEqual(names, ['Real']);
});

// ── Query surface + housekeeping ────────────────────────────────────────────────
test('findRoutes / getRoutes(method) / findModels filters', () => {
  const ws = 'q1';
  build(ws, [js('a.js', [
    "app.get('/api/users', getUsers);",
    "app.post('/api/users', addUser);",
    "app.get('/api/orders', getOrders);",
    "const User = sequelize.define('User', {});",
  ].join('\n'))]);

  assert.equal(findRoutes(ws, '/api/users').length, 2);
  assert.equal(getRoutes(ws, 'GET').length, 2);
  assert.equal(getRoutes(ws, 'POST').length, 1);
  assert.equal(findModels(ws, 'user').length, 1);
});

test('stats: byMethod + byOrm counts', () => {
  const ws = 'q2';
  build(ws, [js('a.js', [
    "app.get('/a', h1);",
    "app.get('/b', h2);",
    "app.post('/c', h3);",
    "const M = sequelize.define('M', {});",
  ].join('\n'))]);
  const s = getSymbolGraphStats(ws);
  assert.equal(s.byMethod.GET, 2);
  assert.equal(s.byMethod.POST, 1);
  assert.equal(s.byOrm.sequelize, 1);
});

test('dedupe: identical route at same location counted once', () => {
  const ws = 'q3';
  // Same line duplicated would be different lines; craft a genuine dup via
  // two matches the regex would emit identically is not possible on one line,
  // so assert dedupe key stability across a rebuild instead.
  const files = [js('a.js', "app.get('/x', h);")];
  build(ws, files);
  const first = getRoutes(ws).length;
  buildSymbolGraph(ws, files);  // rebuild overwrites, not appends
  assert.equal(getRoutes(ws).length, first, 'rebuild replaces state, no accumulation');
});

test('serialize + clear', () => {
  const ws = 'q4';
  build(ws, [js('a.js', "app.get('/x', h);")]);
  const ser = serializeSymbolGraph(ws);
  assert.equal(ser.routes.length, 1);
  assert.ok(ser.builtAt > 0);
  clearSymbolGraph(ws);
  assert.equal(getSymbolGraph(ws), null);
  assert.deepEqual(getRoutes(ws), []);
});

test('junk / empty input resilience', () => {
  const ws = 'q5';
  assert.doesNotThrow(() => buildSymbolGraph(ws, []));
  assert.doesNotThrow(() => buildSymbolGraph(ws, [js('a.js', ''), { path: 'b', content: null, lang: 'javascript' }]));
  assert.doesNotThrow(() => buildSymbolGraph(ws, [js('a.js', 'const x = ;;; ({[')]));
  assert.deepEqual(getRoutes(ws), []);
});
