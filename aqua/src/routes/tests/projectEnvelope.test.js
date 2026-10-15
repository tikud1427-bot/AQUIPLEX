/**
 * E11 — project.js on the shared response envelope.
 *
 * Written BEFORE the migration and first run against the unmigrated route
 * with only the `code` assertions failing (they did: 14 of them) — so every
 * status, error text and success shape below pins the behaviour clients
 * already depend on. The migration may only ADD `code` to failures.
 *
 * Routes needing a model provider or a real index (ingestion with summaries,
 * edit proposals) are covered for their validation and ownership paths only;
 * their 500/422 handlers are pinned structurally at the bottom.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-project-env-'));

const { default: route } = await import('../project.js');
const { ErrorCodes } = await import('../envelope.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { const u = req.headers['x-test-user']; if (u) req.aquaUserId = String(u); next(); });
app.use('/project', route);

let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

const call = async (method, p, { user, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};
const failed = (r, status, error, code) => {
  assert.equal(r.status, status, JSON.stringify(r.json));
  assert.equal(r.json.success, false);
  if (error instanceof RegExp) assert.match(r.json.error, error); else assert.equal(r.json.error, error);
  assert.equal(r.json.code, code, `code on ${JSON.stringify(r.json)}`);
};

const U = `u-proj-${Math.random().toString(36).slice(2, 8)}`;
const OTHER = `u-proj-other-${Math.random().toString(36).slice(2, 8)}`;
let ws;

before(async () => {
  const r = await call('POST', '/project/workspace', { user: U, body: { name: 'w' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.deepEqual(Object.keys(r.json.workspace).sort(), ['createdAt', 'id', 'indexStatus']);
  ws = r.json.workspace.id;
});

describe('ownership: another user\'s workspace is a uniform 404', () => {
  for (const [m, suffix, body] of [
    ['GET', ''], ['GET', '/files'], ['GET', '/overview'], ['GET', '/graph'], ['GET', '/call-graph'],
    ['GET', '/callers?symbol=x'], ['POST', '/query', { q: 'x' }], ['DELETE', ''], ['GET', '/file-content?path=a'],
    ['POST', '/patch', { changes: [] }], ['POST', '/edit', { instruction: 'x' }], ['GET', '/edits'],
    ['POST', '/checkpoint', {}], ['GET', '/checkpoints'],
  ]) {
    test(`${m} /workspace/:id${suffix}`, async () => {
      failed(await call(m, `/project/workspace/${ws}${suffix}`, { user: OTHER, body }), 404, 'Workspace not found', ErrorCodes.NOT_FOUND);
    });
  }
  test('an unknown workspace id is the same 404', async () => {
    failed(await call('GET', '/project/workspace/nope', { user: U }), 404, 'Workspace not found', ErrorCodes.NOT_FOUND);
  });
});

describe('the owner\'s reads keep their shapes', () => {
  test('GET workspace', async () => {
    const r = await call('GET', `/project/workspace/${ws}`, { user: U });
    assert.equal(r.status, 200); assert.equal(r.json.success, true);
    assert.equal(r.json.workspace.id, ws); assert.ok('indexStats' in r.json.workspace);
  });
  test('GET files', async () => {
    const r = await call('GET', `/project/workspace/${ws}/files`, { user: U });
    assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json).sort(), ['files', 'success', 'workspaceId']);
  });
  test('GET overview before indexing: 200 with a note, overview null', async () => {
    const r = await call('GET', `/project/workspace/${ws}/overview`, { user: U });
    assert.equal(r.status, 200); assert.equal(r.json.success, true);
    assert.equal(r.json.overview, null); assert.match(r.json.note, /not yet indexed/);
  });
  test('GET graph / call-graph', async () => {
    const g = await call('GET', `/project/workspace/${ws}/graph`, { user: U });
    assert.equal(g.status, 200); assert.deepEqual(Object.keys(g.json).sort(), ['cycles', 'graph', 'success', 'workspaceId']);
    const c = await call('GET', `/project/workspace/${ws}/call-graph`, { user: U });
    assert.equal(c.status, 200); assert.deepEqual(Object.keys(c.json).sort(), ['built', 'graph', 'stats', 'success', 'workspaceId']);
  });
  test('GET workspaces lists it', async () => {
    const r = await call('GET', '/project/workspaces', { user: U });
    assert.equal(r.status, 200); assert.equal(r.json.success, true);
  });
  test('GET edits / checkpoints are empty lists', async () => {
    const e = await call('GET', `/project/workspace/${ws}/edits`, { user: U });
    assert.equal(e.status, 200); assert.deepEqual(e.json.proposals, []);
    const c = await call('GET', `/project/workspace/${ws}/checkpoints`, { user: U });
    assert.equal(c.status, 200); assert.ok(Array.isArray(c.json.checkpoints));
  });
});

describe('validation failures keep status and text, gain a code', () => {
  test('callers without ?symbol', async () => {
    failed(await call('GET', `/project/workspace/${ws}/callers`, { user: U }), 400, 'Query param ?symbol= required', ErrorCodes.BAD_REQUEST);
  });
  test('file-content without ?path', async () => {
    failed(await call('GET', `/project/workspace/${ws}/file-content`, { user: U }), 400, 'Query param ?path= required', ErrorCodes.BAD_REQUEST);
  });
  test('file-content of a file not in the index', async () => {
    failed(await call('GET', `/project/workspace/${ws}/file-content?path=zz.js`, { user: U }), 404, "File 'zz.js' not in index", ErrorCodes.NOT_FOUND);
  });
  test('patch without changes', async () => {
    failed(await call('POST', `/project/workspace/${ws}/patch`, { user: U, body: {} }), 400,
      'Body must include { description, reasoning, changes: [...] }', ErrorCodes.BAD_REQUEST);
  });
  test('patch with changes succeeds', async () => {
    const r = await call('POST', `/project/workspace/${ws}/patch`, { user: U,
      body: { description: 'd', reasoning: 'r', changes: [{ path: 'a.js', before: 'x', after: 'y' }] } });
    assert.equal(r.status, 200); assert.equal(r.json.success, true); assert.ok(r.json.patch);
  });
  test('edit without instruction', async () => {
    failed(await call('POST', `/project/workspace/${ws}/edit`, { user: U, body: {} }), 400,
      'Body must include a non-empty "instruction" string', ErrorCodes.BAD_REQUEST);
  });
  test('files with neither files nor zip', async () => {
    failed(await call('POST', `/project/workspace/${ws}/files`, { user: U, body: {} }), 400,
      'Provide "files": [{ path, content }] or "zip": "<base64>"', ErrorCodes.BAD_REQUEST);
  });
  test('unknown proposal is 404', async () => {
    failed(await call('GET', `/project/workspace/${ws}/edit/p-none`, { user: U }), 404, 'Proposal not found', ErrorCodes.NOT_FOUND);
  });
  test('apply / reject / revert an unknown proposal are 400', async () => {
    for (const verb of ['apply', 'reject', 'revert']) {
      const r = await call('POST', `/project/workspace/${ws}/edit/p-none/${verb}`, { user: U, body: {} });
      assert.equal(r.status, 400, `${verb}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.success, false);
      assert.equal(r.json.code, ErrorCodes.BAD_REQUEST, verb);
    }
  });
  test('restore / delete an unknown checkpoint are 404', async () => {
    const r = await call('POST', `/project/workspace/${ws}/checkpoint/cp-none/restore`, { user: U, body: {} });
    assert.equal(r.status, 404); assert.equal(r.json.code, ErrorCodes.NOT_FOUND);
    const d = await call('DELETE', `/project/workspace/${ws}/checkpoint/cp-none`, { user: U });
    assert.equal(d.status, 404); assert.equal(d.json.code, ErrorCodes.NOT_FOUND);
  });
});

describe('delete', () => {
  test('owner deletes; the workspace is then a 404', async () => {
    const r = await call('DELETE', `/project/workspace/${ws}`, { user: U });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { success: true, deleted: ws });
    failed(await call('GET', `/project/workspace/${ws}`, { user: U }), 404, 'Workspace not found', ErrorCodes.NOT_FOUND);
  });
});

describe('structural: handlers a black-box test cannot trigger', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'project.js'), 'utf8');
  test('no raw res.status/res.json responses remain', () => {
    assert.doesNotMatch(src, /res\.status\(/, 'a response bypasses the envelope');
    assert.doesNotMatch(src, /res\.json\(/, 'a response bypasses the envelope');
  });
  test('the ingestion 500 keeps its workspaceId and retry text', () => {
    assert.match(src, /fail\(res, ErrorCodes\.INTERNAL, `Indexing failed: \$\{err\.message\}[^`]*`, \{ workspaceId: id \}\)/);
  });
  test('edit failures keep their DOMAIN code (same decision as artifacts edit/regenerate)', () => {
    assert.match(src, /code: err\.code \?\? 'EDIT_FAILED'/);
  });
  test('repair 422 keeps its attempts', () => {
    assert.match(src, /fail\(res, ErrorCodes\.UNPROCESSABLE, 'No usable patch could be produced\.', \{ attempts: outcome\.attempts \}\)/);
  });
});
