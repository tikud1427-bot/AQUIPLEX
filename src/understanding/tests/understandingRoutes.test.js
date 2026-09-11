/**
 * UUS U4 — GET /understanding (node:test).
 *
 * The read model is what the first-run gate, the world-model card and the
 * dashboard all call. Three things must hold:
 *
 *   1. A brand-new account gets 200 with a zero score — NOT a 404. This is the
 *      normal case for this endpoint, and 404 would make the gate treat
 *      "nothing learned yet" as a failure and hide the screen that exists to
 *      fix it.
 *   2. Empty sections are DROPPED, never rendered as "unknown". Three true
 *      sentences beat nine padded ones.
 *   3. Owners cannot see each other. Same scoping discipline as brainRoutes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-u4-'));

const understandingRoute = (await import('../understandingRoutes.js')).default;
const { getMind } = await import('../../mind/mindStore.js');
const { observeSignal } = await import('../../mind/beliefEngine.js');
const { trackGoals } = await import('../../mind/goalTracker.js');
const { DIMENSIONS } = await import('../../mind/mindSchema.js');

// resolveMindOwner PREFIXES `user:` itself, so the header carries a bare id and
// the store is keyed by the prefixed form. Getting this wrong writes to one
// owner and reads another, which looks exactly like an isolation bug.
const ALICE_ID = 'u4-alice';
const BOB_ID = 'u4-bob';
const ALICE = `user:${ALICE_ID}`;
const BOB = `user:${BOB_ID}`;

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = req.get('x-test-user') || null; next(); });
app.use('/understanding', understandingRoute);

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

const get = async (user) => {
  const res = await fetch(`${base}/understanding`, { headers: user ? { 'x-test-user': user } : {} });
  return { status: res.status, body: await res.json() };
};

test('U4: a brand-new account gets 200 and an honest zero, not a 404', async () => {
  const { status, body } = await get('u4-nobody');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.score, 0);
  assert.equal(body.isNew, true);
  assert.equal(body.confidence, 'nothing yet');
  assert.deepEqual(body.sections, []);
});

test('U4: no owner is a 400, not a silent empty model', async () => {
  const { status, body } = await get(null);
  assert.equal(status, 400);
  assert.equal(body.success, false);
});

test('U4: a populated mind reports sections, goals and unknowns', async () => {
  const mind = getMind(ALICE);
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });
  observeSignal(mind, { dimension: DIMENSIONS.COMMUNICATION, key: 'message_style', value: 'terse', strength: 0.7 });
  trackGoals(mind, { userMessage: 'I want to launch the beta this quarter.' });

  const { status, body } = await get(ALICE_ID);
  assert.equal(status, 200);
  assert.ok(body.score > 0, `expected a non-zero score, got ${body.score}`);
  assert.equal(body.isNew, false);

  const ids = body.sections.map(s => s.id);
  assert.ok(ids.includes('identity'));
  assert.ok(ids.includes('communication'));
  // Empty dimensions are dropped, not rendered as "unknown".
  assert.ok(!ids.includes('decision'), 'empty sections must be dropped');

  const identity = body.sections.find(s => s.id === 'identity');
  assert.equal(identity.items[0].value, 'founder');
  assert.equal(identity.items[0].source, 'explicit', 'provenance is shown, not blurred');
  assert.ok(identity.items[0].ref.startsWith('belief:'), 'every item carries a correction ref');
  assert.equal(typeof identity.confidenceLabel, 'string');

  assert.ok(body.unknowns.length > 0, 'a partly-known account has unknowns');
});

test('U4: owners are isolated', async () => {
  const mind = getMind(BOB);
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'teacher', explicit: true });

  const alice = await get(ALICE_ID);
  const bob = await get(BOB_ID);
  const valuesOf = (b) => b.sections.flatMap(s => s.items.map(i => i.value));
  assert.ok(valuesOf(bob.body).includes('teacher'));
  assert.ok(!valuesOf(alice.body).includes('teacher'), "alice must not see bob's beliefs");
});

test('U4: the endpoint reads and never writes', async () => {
  // A read model that mutates is how a dashboard becomes a second world model
  // that disagrees with the first one.
  const before = JSON.stringify(getMind(ALICE));
  await get(ALICE_ID);
  assert.equal(JSON.stringify(getMind(ALICE)), before, 'GET must not mutate the Mind');
});
