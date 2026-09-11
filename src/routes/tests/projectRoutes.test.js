/**
 * Project routes — object-level authorization (IDOR) on workspaces.
 *
 * Workspaces recorded an ownerId but never checked it: every read, the
 * file-upload write, and DELETE were guarded only by existence, so any
 * authenticated caller could reach any workspace by guessing its UUID.
 *
 * Same harness as authScoping.test.js / artifactRoutes.test.js: real router
 * in-process, header-driven req.aquaUserId, node:test runner. Store isolated
 * to a temp dir via AQUA_DATA_DIR, set before the module graph loads.
 *
 * Run: node --test src/routes/tests/projectRoutes.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-project-routes-'));
process.env.AQUA_DATA_DIR = TMP;

const { createWorkspace, getWorkspace } = await import('../../project/workspaceManager.js');
const { default: projectRoute }         = await import('../project.js');

// Simulate the platform mount: x-test-user header → req.aquaUserId.
// No header = dev/standalone (no session), exactly like the bare engine.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers['x-test-user'];
  if (u) req.aquaUserId = String(u);
  next();
});
app.use('/project', projectRoute);

let server, base;

const req = async (method, p, { user, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
};

const MISSING = '00000000-0000-4000-8000-000000000000';

let aliceWs, bobWs, legacyWs;

before(() => {
  server = app.listen(0);
  base   = `http://127.0.0.1:${server.address().port}`;

  aliceWs  = createWorkspace({ name: 'Alice API',  ownerId: 'user:alice' });
  bobWs    = createWorkspace({ name: 'Bob Secret', ownerId: 'user:bob' });
  // Predates ownerId being recorded — must not leak to authenticated callers.
  legacyWs = createWorkspace({ name: 'Legacy' });
});

after(async () => {
  server?.close();
  // Let the store's debounced writer flush before the temp dir disappears,
  // otherwise teardown races it and prints a spurious write failure.
  await new Promise(r => setTimeout(r, 1200));
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Authorized access ────────────────────────────────────────────────────────

test('owner reads their own workspace', async () => {
  const r = await req('GET', `/project/workspace/${aliceWs.id}`, { user: 'alice' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.workspace.id, aliceWs.id);
});

test('owner reads their own sub-resources', async () => {
  for (const suffix of ['/files', '/overview', '/graph', '/call-graph', '/edits', '/checkpoints']) {
    const r = await req('GET', `/project/workspace/${aliceWs.id}${suffix}`, { user: 'alice' });
    assert.equal(r.status, 200, `expected 200 for ${suffix}, got ${r.status}`);
  }
});

// ── Unauthorized access ──────────────────────────────────────────────────────

test('non-owner cannot read another user’s workspace', async () => {
  const r = await req('GET', `/project/workspace/${aliceWs.id}`, { user: 'bob' });
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
});

test('non-owner cannot read another user’s files, overview, or graphs', async () => {
  for (const suffix of ['/files', '/overview', '/graph', '/call-graph']) {
    const r = await req('GET', `/project/workspace/${aliceWs.id}${suffix}`, { user: 'bob' });
    assert.equal(r.status, 404, `expected 404 for ${suffix}, got ${r.status}`);
  }
});

test('non-owner cannot upload files INTO another user’s workspace', async () => {
  const before = getWorkspace(aliceWs.id).files.length;
  const r = await req('POST', `/project/workspace/${aliceWs.id}/files`, {
    user: 'bob',
    body: { files: [{ path: 'evil.js', content: 'stolen()' }] },
  });
  assert.equal(r.status, 404);
  assert.equal(getWorkspace(aliceWs.id).files.length, before, 'workspace was mutated');
});

test('non-owner cannot reach nested proposal/checkpoint routes', async () => {
  const r1 = await req('GET', `/project/workspace/${aliceWs.id}/edit/any-proposal`, { user: 'bob' });
  const r2 = await req('POST', `/project/workspace/${aliceWs.id}/checkpoint/any-cp/restore`, { user: 'bob' });
  assert.equal(r1.status, 404);
  assert.equal(r2.status, 404);
});

// ── No existence oracle (404-uniform) ────────────────────────────────────────

test('forbidden and missing are indistinguishable', async () => {
  const forbidden = await req('GET', `/project/workspace/${aliceWs.id}`, { user: 'bob' });
  const missing   = await req('GET', `/project/workspace/${MISSING}`,    { user: 'bob' });
  assert.equal(forbidden.status, missing.status);
  assert.deepEqual(forbidden.body, missing.body);
});

// ── Delete protection ────────────────────────────────────────────────────────

test('non-owner cannot delete another user’s workspace', async () => {
  const r = await req('DELETE', `/project/workspace/${aliceWs.id}`, { user: 'bob' });
  assert.equal(r.status, 404);
  assert.ok(getWorkspace(aliceWs.id), 'workspace was deleted by a non-owner');
});

test('owner can delete their own workspace', async () => {
  const doomed = createWorkspace({ name: 'Doomed', ownerId: 'user:alice' });
  const r = await req('DELETE', `/project/workspace/${doomed.id}`, { user: 'alice' });
  assert.equal(r.status, 200);
  assert.equal(getWorkspace(doomed.id), null);
});

// ── List scoping ─────────────────────────────────────────────────────────────

test('list returns only the caller’s workspaces', async () => {
  const alice = await req('GET', '/project/workspaces', { user: 'alice' });
  const bob   = await req('GET', '/project/workspaces', { user: 'bob' });

  const aliceIds = alice.body.workspaces.map(w => w.id);
  const bobIds   = bob.body.workspaces.map(w => w.id);

  assert.ok(aliceIds.includes(aliceWs.id));
  assert.ok(!aliceIds.includes(bobWs.id),    'alice can see bob’s workspace');
  assert.ok(!aliceIds.includes(legacyWs.id), 'legacy unowned workspace leaked');
  assert.ok(bobIds.includes(bobWs.id));
  assert.ok(!bobIds.includes(aliceWs.id),    'bob can see alice’s workspace');
});

test('list count matches the scoped array', async () => {
  const r = await req('GET', '/project/workspaces', { user: 'alice' });
  assert.equal(r.body.count, r.body.workspaces.length);
});

test('legacy workspaces with no ownerId are invisible to authenticated callers', async () => {
  const r = await req('GET', `/project/workspace/${legacyWs.id}`, { user: 'alice' });
  assert.equal(r.status, 404);
});

// ── Regression: dev/standalone and the create→use flow are unchanged ─────────

test('sessionless access is unchanged (dev/standalone)', async () => {
  const r = await req('GET', `/project/workspace/${aliceWs.id}`);
  assert.equal(r.status, 200, 'sessionless mode must not be gated');
});

test('sessionless list returns everything on the instance', async () => {
  const r = await req('GET', '/project/workspaces');
  const ids = r.body.workspaces.map(w => w.id);
  assert.ok(ids.includes(aliceWs.id) && ids.includes(bobWs.id) && ids.includes(legacyWs.id));
});

test('create → read round-trips for the creating session', async () => {
  const created = await req('POST', '/project/workspace', {
    user: 'carol',
    body: { name: 'Carol App', description: 'test' },
  });
  assert.equal(created.status, 200);
  const id = created.body.workspace.id;

  const read = await req('GET', `/project/workspace/${id}`, { user: 'carol' });
  assert.equal(read.status, 200, 'creator locked out of their own new workspace');

  const listed = await req('GET', '/project/workspaces', { user: 'carol' });
  assert.deepEqual(listed.body.workspaces.map(w => w.id), [id]);

  const stolen = await req('GET', `/project/workspace/${id}`, { user: 'dave' });
  assert.equal(stolen.status, 404);
});

test('owner CAN upload files into their own workspace', async () => {
  // The guard newly gates this write path — if it is wrong in the other
  // direction, every upload in the product breaks.
  const created = await req('POST', '/project/workspace', {
    user: 'erin', body: { name: 'Erin App' },
  });
  const id = created.body.workspace.id;

  const r = await req('POST', `/project/workspace/${id}/files`, {
    user: 'erin',
    body: { files: [{ path: 'index.js', content: 'export const x = 1;' }] },
  });
  assert.equal(r.status, 200, 'owner was blocked from their own upload');
  assert.ok(getWorkspace(id).files.length > 0, 'files were not ingested');
});

test('a missing workspace still 404s for its owner', async () => {
  const r = await req('GET', `/project/workspace/${MISSING}`, { user: 'alice' });
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
});

// ── Coverage: every :id route is guarded, including ones added later ─────────

test('every workspace route carrying :id rejects a non-owner', async () => {
  const routes = projectRoute.stack
    .filter(l => l.route?.path?.includes(':id'))
    .map(l => ({ path: l.route.path, method: Object.keys(l.route.methods)[0] }));

  assert.ok(routes.length >= 20, `expected the full :id surface, found ${routes.length}`);

  const unguarded = [];
  for (const { path: p, method } of routes) {
    const url = '/project' + p
      .replace(':id', aliceWs.id)
      .replace(':proposalId', 'p-probe')
      .replace(':checkpointId', 'c-probe');
    const m = method.toUpperCase();
    // fetch() forbids a body on GET/HEAD.
    const r = await req(m, url, { user: 'bob', ...(m === 'GET' ? {} : { body: {} }) });
    if (r.status !== 404) unguarded.push(`${method.toUpperCase()} ${p} → ${r.status}`);
  }

  assert.deepEqual(unguarded, [], `unguarded routes:\n  ${unguarded.join('\n  ')}`);
});
