/**
 * A goal whose exact target the user now holds (memory/propagation.js, 2026-11-05).
 *
 * "My goal is to get promoted to senior analyst" … "I now work at Northbeam as a
 * senior analyst." The goal names the NEW value, so the old-name dependency rule
 * never saw it, and it stayed the top active goal and prediction (Cloudflare
 * Mistral run, q05). Now it is flagged for review — "may already be achieved" —
 * and never completed: only the user's own words close a goal.
 *
 * Real observation pipeline, private data directory, no provider, no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-goal-target-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
// Change propagation is OFF by default (2026-11-06: only AQUA_PROPAGATION=on enables it).
// These tests exercise behaviour that needs it, so they enable it explicitly.
process.env.AQUA_PROPAGATION = 'on';

const engine = await import('../engine.js');
const P = await import('../propagation.js');
const { peekMind } = await import('../../mind/mindStore.js');
const { sensitivePolicy } = await import('../sensitivity.js');

let clock = Date.UTC(2026, 8, 1);
const realNow = Date.now;
Date.now = () => clock;
process.on('exit', () => { Date.now = realNow; });

let turn = 0;
async function say(owner, text) {
  clock += 60_000; turn++;
  engine.memoryObserve(owner, { userMessage: text, conversationId: `${owner}-c`, userId: owner, requestId: `r${turn}`, extractMessage: text });
  engine.memoryAfterTurn(owner, {});
  await new Promise(r => setTimeout(r, 20));
}
let n = 0;
async function lived(lines) {
  const owner = `user:goal-target-${++n}`;
  for (const t of lines) await say(owner, t);
  clock += 7 * 86_400_000;
  return owner;
}
const goal = (owner, re) => Object.values(peekMind(owner).goals).find(g => re.test(g.title));
const block = (owner, query = 'What should I focus on at work this month?') => engine.memoryRetrieve(owner, {
  query, requestId: `q${++turn}`, legacyUserMemory: true, sensitive: sensitivePolicy({ rememberSensitive: false, message: 'x' }),
}).block;

const JOB = ["I'm a data analyst at Fintrail.", 'My goal is to get promoted to senior analyst.', 'My goal is to run a half marathon in October.', 'My goal is to become a manager.'];
const MOVE = 'I now work at Northbeam as a senior analyst.';

// ── The pure rule ───────────────────────────────────────────────────────────
test('reachedTarget: an attain-phrase whose object is exactly the value', () => {
  const R = P.reachedTarget;
  assert.equal(R('get promoted to senior analyst', 'senior analyst'), true);
  assert.equal(R('become a Senior Analyst', 'senior analyst'), true, 'case and article do not matter');
  assert.equal(R('get promoted to senior analyst this year', 'senior analyst'), true, 'a time qualifier is not part of the target');
  assert.equal(R('get a job at Northbeam', 'Northbeam'), true);
  assert.equal(R('move to Lisbon', 'Lisbon'), true);
  assert.equal(R('become a manager', 'senior analyst'), false, 'a different target');
  assert.equal(R('mentor a senior analyst', 'senior analyst'), false, 'names the value without attaining it');
  assert.equal(R('get promoted to senior analyst at Fintrail', 'senior analyst'), false, 'exact matching only: "at Fintrail" is part of the target');
  assert.equal(R('get promoted to lead analyst', 'senior analyst'), false);
  assert.equal(R('get promoted to senior analyst', 'senior analyst ii'), false, 'no fuzzy title matching');
  assert.equal(R('', 'senior analyst'), false);
});

// ── Through the pipeline ────────────────────────────────────────────────────
test('the reached goal is flagged for review — same words, same status, never completed', async () => {
  const owner = await lived(JOB);
  const before = structuredClone(goal(owner, /promoted/));
  await say(owner, MOVE);
  const g = goal(owner, /promoted/);
  assert.equal(g.review?.kind, 'target_reached');
  assert.equal(g.review.text, MOVE, 'the evidence is the user\'s own words');
  assert.equal(g.review.value, 'senior analyst');
  assert.equal(g.status, 'active', 'not completed');
  assert.equal(g.title, before.title, 'wording kept');
  assert.equal(g.achievedBy, undefined, 'no achievement recorded');
  assert.deepEqual(g.history, before.history, 'no status transition recorded');
  assert.equal(g.progress, before.progress);
});

test('unrelated goals are untouched', async () => {
  const owner = await lived([...JOB, 'My goal is to learn Spanish this year.']);
  await say(owner, MOVE);
  for (const re of [/half marathon/, /manager/, /Spanish/]) assert.equal(goal(owner, re).review, undefined, String(re));
});

test('the prompt says "may already be achieved", and no longer predicts the goal', async () => {
  const owner = await lived(JOB);
  await say(owner, MOVE);
  const b = block(owner);
  assert.match(b, /"get promoted to senior analyst" \(may already be achieved — they said: "I now work at Northbeam as a senior analyst\."; not confirmed\)/);
  assert.doesNotMatch(b, /Likely working toward: get promoted to senior analyst/);
  assert.doesNotMatch(b, /promoted to senior analyst"? \(?(?:completed|achieved)\)?/i, 'not presented as confirmed');
  assert.ok(!(peekMind(owner).predictions ?? []).some(p => /promoted/.test(p.label)));
});

test('the legacy goal list mirrors the decision, item by item', async () => {
  const owner = await lived([...JOB, 'My goal is to mentor a senior analyst.']);
  await say(owner, MOVE);
  const reviews = peekMind(owner).facts.goal?.reviews ?? [];
  const items = reviews.filter(r => r.kind === 'target_reached').map(r => r.item);
  assert.deepEqual(items, ['get promoted to senior analyst']);
});

test('a workplace target is flagged the same way', async () => {
  const owner = await lived(["I work at Fintrail.", 'My goal is to get a job at Northbeam.']);
  await say(owner, 'I now work at Northbeam.');
  assert.equal(goal(owner, /Northbeam/).review?.kind, 'target_reached');
});

test('a goal set after the change is not flagged', async () => {
  const owner = await lived(["I'm a data analyst at Fintrail.", MOVE]);
  await say(owner, 'My goal is to get promoted to senior analyst.');
  assert.equal(goal(owner, /promoted/)?.review, undefined);
});

test('released when the user restates the goal (clarifies it is still theirs)', async () => {
  const owner = await lived(JOB);
  await say(owner, MOVE);
  assert.equal(goal(owner, /promoted/).review?.kind, 'target_reached');
  await say(owner, 'My goal is to get promoted to senior analyst.');
  assert.equal(goal(owner, /promoted/).review, undefined);
  assert.ok(!(peekMind(owner).facts.goal?.reviews ?? []).some(r => r.kind === 'target_reached'), 'legacy mirror released too');
});

test('released when the user reverts, or the value moves past the target', async () => {
  const a = await lived(JOB);
  await say(a, MOVE);
  assert.equal(goal(a, /promoted/).review?.kind, 'target_reached', 'precondition: flagged');
  await say(a, "I'm a data analyst.");
  assert.equal(peekMind(a).facts.profession.value, 'data analyst', 'precondition: the role went back');
  assert.equal(goal(a, /promoted/).review, undefined, 'revert releases');

  const b = await lived(JOB);
  await say(b, MOVE);
  assert.equal(goal(b, /promoted/).review?.kind, 'target_reached', 'precondition: flagged');
  await say(b, "I'm a lead analyst now.");
  assert.notEqual(peekMind(b).facts.profession.value, 'senior analyst', 'precondition: the role changed again');
  assert.notEqual(goal(b, /promoted/).review?.kind, 'target_reached', 'no longer holds the target');
});

test('an existing old-name review keeps precedence', async () => {
  const owner = await lived(["I'm a data analyst at Fintrail.", 'My goal is to get promoted to senior analyst at Fintrail.']);
  await say(owner, MOVE);
  const g = goal(owner, /promoted/);
  assert.ok(g.review, 'flagged');
  assert.notEqual(g.review.kind, 'target_reached', 'the old-name relation (uncertain) is what applies');
  assert.match(block(owner), /promoted to senior analyst at Fintrail" \(uncertain whether still current — they said: "I now work at Northbeam/);
});

test('idempotent: reconciling again changes nothing', async () => {
  const owner = await lived(JOB);
  await say(owner, MOVE);
  const again = P.reconcileMind(owner);
  assert.equal(again.flagged, 0);
  assert.equal(again.cleared, 0);
});

test('AQUA_PROPAGATION=off: nothing is flagged (kill switch kept)', async () => {
  process.env.AQUA_PROPAGATION = 'off';
  try {
    const owner = await lived(JOB);
    await say(owner, MOVE);
    assert.equal(goal(owner, /promoted/).review, undefined);
  } finally { process.env.AQUA_PROPAGATION = 'on'; }   // back to this file's enabled setting
});
