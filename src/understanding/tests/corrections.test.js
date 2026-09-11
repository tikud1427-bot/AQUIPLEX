/**
 * UUS U6 — "Correct my understanding" (node:test).
 *
 * ONE endpoint, every kind of thing AQUA believes. It invents no storage: it
 * parses the `ref` each item already carries and dispatches to whichever
 * existing API owns that thing — `correctBelief`, the goal record,
 * `memoryEditor`, all of which were already routed before this sprint.
 *
 * What did not exist was a way for the USER not to care. Asking someone to
 * know that "founder" is a belief while "launch the beta" is a goal is asking
 * them to learn our schema in order to tell us we are wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-u6-'));

const { parseRef, applyCorrection, dismissedEntityIds, isDismissalKey } = await import('../corrections.js');
const understandingRoute = (await import('../understandingRoutes.js')).default;
const { getMind } = await import('../../mind/mindStore.js');
const { observeSignal, getBeliefs } = await import('../../mind/beliefEngine.js');
const { trackGoals } = await import('../../mind/goalTracker.js');
const { DIMENSIONS, GOAL_STATUS, beliefKey } = await import('../../mind/mindSchema.js');

// ── 1. The ref is the contract ───────────────────────────────────────────────

test('U6: refs parse, including keys that contain colons', () => {
  assert.deepEqual(parseRef('belief:identity:profession'), { kind: 'belief', dimension: 'identity', key: 'profession' });
  // The trap: "tech:go" is a KEY containing a colon. Splitting on every colon
  // would turn knowledge:tech:go into dimension "knowledge", key "tech" — a
  // correction silently applied to the wrong belief.
  assert.deepEqual(parseRef('belief:knowledge:tech:go'), { kind: 'belief', dimension: 'knowledge', key: 'tech:go' });
  assert.deepEqual(parseRef('goal:goal_1a2b'), { kind: 'goal', id: 'goal_1a2b' });
  assert.deepEqual(parseRef('entity:ent:proj:aqua'), { kind: 'entity', id: 'ent:proj:aqua' });
});

test('U6: an unrecognised ref is rejected, never guessed at', () => {
  for (const bad of ['', null, undefined, 'nonsense', 'belief:', 'belief:identity:']) {
    assert.equal(parseRef(bad), null, `should not parse: ${JSON.stringify(bad)}`);
  }
  const r = applyCorrection({ ownerId: 'o', ref: 'nonsense', value: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('U6: correcting with no value is an error, not a silent delete', () => {
  const r = applyCorrection({ ownerId: 'o', ref: 'belief:identity:profession', value: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /needs a value/i);
  assert.match(r.error, /remove/i, 'the error must say what to do instead');
});

// ── 2. Beliefs ───────────────────────────────────────────────────────────────

const owner = 'user:u6';
function freshMind() {
  const mind = getMind(owner);
  mind.beliefs = {};
  mind.goals = {};
  return mind;
}

test('U6: a corrected belief takes the user\'s value at explicit standing', () => {
  const mind = freshMind();
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'engineer', strength: 0.5 });

  const r = applyCorrection({ ownerId: owner, ref: 'belief:identity:profession', value: 'founder' });
  assert.equal(r.ok, true);
  const b = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'profession')];
  assert.equal(b.value, 'founder');
  assert.ok(b.confidence >= 0.9, `the user saying so outranks inference; got ${b.confidence}`);
  assert.equal(b.privacy.source, 'correction');
  assert.equal(b.history.length, 1, 'the prior value is versioned, not overwritten');
});

test('U6: removing a belief removes it — no "used to think" tombstone', () => {
  // The brief's premise is that the user does not manage a database. A hidden
  // tombstone they cannot see is worse than a clean removal.
  const mind = freshMind();
  observeSignal(mind, { dimension: DIMENSIONS.KNOWLEDGE, key: 'tech:go', value: 'working_knowledge', strength: 0.4 });

  const r = applyCorrection({ ownerId: owner, ref: 'belief:knowledge:tech:go', action: 'remove' });
  assert.equal(r.ok, true);
  assert.equal(mind.beliefs[beliefKey(DIMENSIONS.KNOWLEDGE, 'tech:go')], undefined);
});

test('U6: "keep" pins a belief so inference stops revising it', () => {
  const mind = freshMind();
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', strength: 0.6 });

  assert.equal(applyCorrection({ ownerId: owner, ref: 'belief:identity:profession', action: 'keep' }).ok, true);
  const b = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'profession')];
  assert.equal(b.privacy.locked, true);

  // And the lock actually holds against further observation.
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'student', strength: 0.9 });
  assert.equal(b.value, 'founder');
});

test('U6: correcting an unknown belief STORES it — deliberate, not a gap', () => {
  // correctBelief creates when the belief is absent, and that is right here.
  // The UI only ever echoes a ref it was handed, so a miss means the belief was
  // archived between render and click. Discarding what the user just told us
  // because of a race would be the worse outcome: they said it, so we keep it.
  //
  // Removal is different, and is a 404 — you cannot delete what does not exist,
  // and silently succeeding would tell the user something happened when it did
  // not.
  const mind = freshMind();
  const r = applyCorrection({ ownerId: owner, ref: 'belief:identity:city', value: 'Guwahati' });
  assert.equal(r.ok, true);
  const b = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'city')];
  assert.equal(b.value, 'Guwahati');
  assert.equal(b.privacy.source, 'correction');

  const gone = applyCorrection({ ownerId: owner, ref: 'belief:identity:nothing_here', action: 'remove' });
  assert.equal(gone.ok, false);
  assert.equal(gone.status, 404);
});

// ── 3. Goals ─────────────────────────────────────────────────────────────────

test('U6: a rejected goal is ABANDONED, not deleted', () => {
  // Unlike a belief, a goal has a history that stays meaningful — "we stopped
  // doing this in March" — and the timeline reads it. Deleting would silently
  // rewrite the past.
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'I want to launch the beta this quarter.' });
  const id = Object.keys(mind.goals)[0];

  const r = applyCorrection({ ownerId: owner, ref: `goal:${id}`, action: 'remove' });
  assert.equal(r.ok, true);
  assert.equal(mind.goals[id].status, GOAL_STATUS.ABANDONED);
  assert.ok(mind.goals[id].history.length >= 1, 'the transition is recorded');
});

test('U6: a goal can be reworded', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'I want to launch the beta this quarter.' });
  const id = Object.keys(mind.goals)[0];

  applyCorrection({ ownerId: owner, ref: `goal:${id}`, value: 'ship the public beta' });
  assert.equal(mind.goals[id].title, 'ship the public beta');
  assert.equal(mind.goals[id].privacy.source, 'correction');
});

// ── 4. Entities — the honest limitation ──────────────────────────────────────

test('U6: an entity cannot be renamed, and the error says why', () => {
  const mind = freshMind();
  const r = applyCorrection({ ownerId: owner, ref: 'entity:ent:proj:x', value: 'Other name' });
  assert.equal(r.ok, false);
  assert.match(r.error, /can't rename/i);
  assert.match(r.error, /what I read/i, 'the reason is stated, not hidden behind a generic failure');
  assert.equal(Object.keys(mind.beliefs).length, 0, 'a rejected action writes nothing');
});

test('U6: dismissing an entity records a fact about the USER, not a lie about the document', () => {
  // The graph has NO per-node removal — upsertNode, addEdge, removeFile,
  // purgeOwner and nothing in between. Deleting a node would orphan its edges.
  // So a dismissal says "this isn't mine", which is true, rather than "the
  // README never mentioned it", which is not.
  const mind = freshMind();
  const r = applyCorrection({ ownerId: owner, ref: 'entity:ent:proj:x', action: 'remove' });
  assert.equal(r.ok, true);
  assert.ok(dismissedEntityIds(mind).has('ent:proj:x'));
});

test('U6: dismissal records are bookkeeping and never shown', () => {
  // A dashboard row reading "dismissed:ent:proj:x = true" would be showing the
  // user our filing system instead of their world — and it would lift the
  // coverage score for knowing nothing.
  assert.equal(isDismissalKey('dismissed:ent:proj:x'), true);
  assert.equal(isDismissalKey('message_style'), false);
});

// ── 5. The endpoint ──────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = req.get('x-test-user') || null; next(); });
app.use('/understanding', understandingRoute);

let server, base;
test.before(async () => { await new Promise(r => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server?.close());

const patch = async (user, body) => {
  const res = await fetch(`${base}/understanding/item`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const get = async (p, user) => {
  const res = await fetch(`${base}${p}`, { headers: user ? { 'x-test-user': user } : {} });
  return { status: res.status, body: await res.json() };
};

test('U6: the UI makes ONE call regardless of which store owns the thing', async () => {
  const mind = getMind('user:u6-http');
  mind.beliefs = {}; mind.goals = {};
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'engineer', strength: 0.5 });
  trackGoals(mind, { userMessage: 'I want to launch the beta this quarter.' });
  const goalId = Object.keys(mind.goals)[0];

  const a = await patch('u6-http', { ref: 'belief:identity:profession', value: 'founder' });
  const b = await patch('u6-http', { ref: `goal:${goalId}`, action: 'remove' });

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.kind, 'belief');
  assert.equal(b.body.kind, 'goal');
});

test('U6: the dashboard reports knowledge sources by provenance', async () => {
  const mind = getMind('user:u6-src');
  mind.beliefs = {}; mind.goals = {};
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });
  observeSignal(mind, { dimension: DIMENSIONS.KNOWLEDGE, key: 'tech:redis', value: 'working_knowledge', strength: 0.45, source: 'fact_bridge' });

  const { body } = await get('/understanding', 'u6-src');
  const kinds = body.sources.map(s => s.kind);
  assert.ok(kinds.includes('explicit'), 'what the user told us is counted');
  assert.ok(kinds.includes('fact_bridge'), 'what we read in their files is counted');
  // Strongest provenance first — what the user said outranks what we guessed.
  assert.ok(kinds.indexOf('explicit') < kinds.indexOf('fact_bridge'));
  for (const s of body.sources) assert.ok(typeof s.label === 'string' && s.label.length > 0);
});

test('U6: a dismissed project disappears from the dashboard', async () => {
  const mind = getMind('user:u6-dismiss');
  mind.beliefs = {}; mind.goals = {};
  await patch('u6-dismiss', { ref: 'entity:ent:proj:ghost', action: 'remove' });

  const { body } = await get('/understanding', 'u6-dismiss');
  assert.ok(!body.projects.some(p => p.id === 'ent:proj:ghost'));
  // …and the bookkeeping belief is not rendered as understanding.
  const shown = body.sections.flatMap(s => s.items.map(i => i.key ?? ''));
  assert.ok(!shown.some(k => String(k).startsWith('dismissed:')));
});

test('U6: bookkeeping never inflates the understanding score', async () => {
  const clean = getMind('user:u6-score-a');
  clean.beliefs = {}; clean.goals = {};
  observeSignal(clean, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });

  const dirty = getMind('user:u6-score-b');
  dirty.beliefs = {}; dirty.goals = {};
  observeSignal(dirty, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });

  const a = await get('/understanding', 'u6-score-a');
  await patch('u6-score-b', { ref: 'entity:ent:proj:z', action: 'remove' });
  const b = await get('/understanding', 'u6-score-b');

  assert.equal(a.body.score, b.body.score, 'dismissing something must not look like learning something');
});

test('U6: every dashboard item still carries a ref the endpoint accepts', async () => {
  const mind = getMind('user:u6-refs');
  mind.beliefs = {}; mind.goals = {};
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });
  trackGoals(mind, { userMessage: 'I want to launch the beta this quarter.' });

  const { body } = await get('/understanding', 'u6-refs');
  const refs = [
    ...body.sections.flatMap(s => s.items.map(i => i.ref)),
    ...body.goals.map(g => g.ref),
    ...body.projects.map(p => p.ref),
  ];
  assert.ok(refs.length > 0);
  for (const ref of refs) assert.ok(parseRef(ref), `the endpoint must accept every ref it emits: ${ref}`);
});
