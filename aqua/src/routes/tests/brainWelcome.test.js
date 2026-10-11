/**
 * GET /brain/welcome — the home screen's line, through the real router.
 *
 * Same harness as brainRoutes.test.js: the production router in-process,
 * header-driven req.aquaUserId, stores isolated to a temp dir. No Postgres in
 * this suite, so the read mode is 'legacy' and the line comes from the REAL
 * Mind store — the path every deployment without the canonical World Model
 * takes. The canonical path end to end is brain/welcome/welcome.live.test.js.
 *
 *   AUTH       no session → 401; ?conversationId is not an identity
 *   ISOLATION  each user's line comes from their own world only (G)
 *   LIFECYCLE  a goal the Mind marks completed stops appearing (C)
 *   FAILURE    a throwing data source → 200 + neutral line (F)
 *   STABLE     repeated requests over an unchanged world agree (H)
 *   NO-STORE   the response is never cached by an intermediary
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-brain-welcome-'));
process.env.AQUA_DATA_DIR = TMP;
delete process.env.AQUA_BRAIN;

const mindStore = await import('../../mind/mindStore.js');
const { createGoal } = await import('../../mind/mindSchema.js');
const Welcome = await import('../../brain/welcome/index.js');
const { INVITE_NEW, INVITE_RETURNING, UNAVAILABLE } = await import('../../brain/welcome/selector.js');
const { default: brainRoute } = await import('../brain.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers['x-test-user'];
  if (u) req.aquaUserId = String(u);
  next();
});
app.use('/brain', brainRoute);

let server, base;
const get = async (p, { user } = {}) => {
  const res = await fetch(base + p, { headers: user ? { 'x-test-user': user } : {} });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

/** A goal as the Mind's goal tracker leaves it after `mentions` statements. */
function seedGoal(userId, title, { mentions = 3, status = 'active', priority = 5 } = {}) {
  const mind = mindStore.getMind(`user:${userId}`);
  const g = createGoal({ title, confidence: 0.55 + 0.1 * (mentions - 1) });
  Object.assign(g, { mentions, status, priority });
  mind.goals[g.id] = g;
  mindStore.touchMind(mind);
  return g;
}

before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); });
beforeEach(() => {
  mindStore._clearAllForTests();
  Welcome.__resetWelcomeDepsForTests();
});

test('AUTH: no session → 401, and a conversation id does not stand in for one', async () => {
  for (const p of ['/brain/welcome', '/brain/welcome?conversationId=c-1']) {
    const { status, body } = await get(p);
    assert.equal(status, 401, p);
    assert.equal(body.success, false);
  }
});

test('NEW USER: honest invitation, not-established, no evidence', async () => {
  const { status, headers, body } = await get('/brain/welcome', { user: 'newbie' });
  assert.equal(status, 200);
  assert.match(headers.get('cache-control') ?? '', /no-store/);
  assert.equal(body.welcome.text, INVITE_NEW);
  assert.equal(body.welcome.established, false);
  assert.deepEqual(body.welcome.evidence, []);
  // 'legacy' without Postgres; 'authoritative' when the runner provides one — legacy fills the gap in both.
  assert.ok(['legacy', 'authoritative'].includes(body.welcome.readMode), body.welcome.readMode);
  const returning = await get('/brain/welcome?history=1', { user: 'newbie' });
  assert.equal(returning.body.welcome.text, INVITE_RETURNING);
});

test('ISOLATION: two users, two worlds, two lines — neither leaks into the other', async () => {
  seedGoal('alice', 'launch the beta');
  seedGoal('bob', 'finish my thesis');
  const a = (await get('/brain/welcome', { user: 'alice' })).body.welcome;
  const b = (await get('/brain/welcome', { user: 'bob' })).body.welcome;
  const c = (await get('/brain/welcome', { user: 'carol' })).body.welcome;
  assert.equal(a.text, "Let's keep working toward launching the beta.");
  assert.equal(b.text, "Let's keep working toward finishing your thesis.");
  assert.equal(c.established, false);
  assert.doesNotMatch(c.text, /beta|thesis/);
  assert.equal(a.basis, 'legacy_goals');
});

test('LIFECYCLE: the goal the old line was built from stops appearing once completed', async () => {
  const g = seedGoal('dana', 'ship the pricing page', { priority: 9 });
  seedGoal('dana', 'hire a designer', { priority: 4 });
  assert.match((await get('/brain/welcome', { user: 'dana' })).body.welcome.text, /pricing page/);

  const mind = mindStore.getMind('user:dana');
  mind.goals[g.id].status = 'completed';
  mindStore.touchMind(mind);
  const after = (await get('/brain/welcome', { user: 'dana' })).body.welcome;
  assert.equal(after.text, "Let's keep working toward hiring a designer.");
  assert.doesNotMatch(after.text, /pricing/);
});

test('NO BILLIONAIRE: the goal behind the old line is not announced on the home screen', async () => {
  seedGoal('erin', 'become a billionaire within a year', { mentions: 6, priority: 10 });
  const w = (await get('/brain/welcome?history=1', { user: 'erin' })).body.welcome;
  assert.doesNotMatch(w.text, /billion|middle of/i);
  assert.equal(w.text, INVITE_RETURNING);
});

test('STABLE: repeated requests over an unchanged world return the same line and ids', async () => {
  seedGoal('fay', 'launch the beta');
  seedGoal('fay', 'hire a designer', { mentions: 2 });
  const first = (await get('/brain/welcome', { user: 'fay' })).body.welcome;
  for (let i = 0; i < 10; i++) {
    const w = (await get('/brain/welcome', { user: 'fay' })).body.welcome;
    assert.equal(w.text, first.text);
    assert.equal(w.messageId, first.messageId);
    assert.equal(w.worldVersion, first.worldVersion);
  }
});

test('FAILURE: a throwing data source still answers 200 with the neutral line', async () => {
  seedGoal('gus', 'launch the beta');
  Welcome.__setWelcomeDepsForTests({
    readMode: () => 'authoritative',
    loadClaims: async () => { throw new Error('ECONNREFUSED'); },
  });
  const { status, body } = await get('/brain/welcome?history=1', { user: 'gus' });
  assert.equal(status, 200);
  assert.equal(body.welcome.text, UNAVAILABLE);
  assert.equal(body.welcome.established, false);
  assert.doesNotMatch(body.welcome.text, /beta/);
});

test('FAILURE: even a selector/service crash is a 200, never a broken home screen', async () => {
  Welcome.__setWelcomeDepsForTests({ readMode: () => { throw new Error('boom'); } });
  const { status, body } = await get('/brain/welcome', { user: 'hal' });
  assert.equal(status, 200);
  assert.equal(body.welcome.kind, 'unavailable');
});
