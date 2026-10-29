/**
 * Legacy data review (2026-10-29) — candidates only, the user decides.
 *
 * Pure candidate rules, then the routes over a real Express app with a
 * temporary data dir: split keeps the original (abandoned, splitInto, history),
 * keep stops the asking, confirm brings a rejected fact back into use, and
 * nothing is changed by merely reading the review.
 * Run: node scripts/run-tests.mjs src/mind/tests/legacyReview.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-legacy-review-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

const USER = 'legacy-reviewer';
const OWNER = `user:${USER}`;
let server, base, review, schema, mindStore, ltm, retriever;

before(async () => {
  review    = await import('../legacyReview.js');
  schema    = await import('../mindSchema.js');
  mindStore = await import('../mindStore.js');
  ltm       = await import('../../memory/longTermMemory.js');
  retriever = await import('../../memory/memoryRetriever.js');
  const { default: express } = await import('express');
  const { default: mindRouter } = await import('../mindRoutes.js');
  const { default: memoryRouter } = await import('../../routes/memory.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.aquaUserId = USER; next(); });
  app.use('/mind', mindRouter);
  app.use('/memory', memoryRouter);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
};
/** A goal as the pre-fix tracker stored it. */
function legacyGoal(mind, title, over = {}) {
  const g = schema.createGoal({ title, source: 'inference', confidence: 0.65 });
  Object.assign(g, { mentions: 3, createdAt: Date.now() - 9e8, lastMentionedAt: Date.now() - 1e8 }, over);
  mind.goals[g.id] = g;
  return g;
}

test('candidates: merged goals, rejected facts, aspirational roles — and nothing else', () => {
  const mind = schema.createEmptyMind('pure');
  legacyGoal(mind, 'become a billionaire and build a company people love');
  legacyGoal(mind, 'build and ship the app');                    // one goal
  legacyGoal(mind, 'launch the beta and hire a designer', { status: 'completed' });
  legacyGoal(mind, 'learn Spanish and travel to Peru', { reviewedAt: 1 });
  mind.beliefs['identity:profession'] = { dimension: 'identity', key: 'profession', value: 'billionaire', privacy: { source: 'explicit' } };
  mind.beliefs['identity:role'] = { dimension: 'identity', key: 'role', value: 'founder', privacy: { source: 'explicit' } };
  const facts = [
    { key: 'profession', value: 'billionaire', sourceMessage: 'I want to be a billionaire' },
    { key: 'city', value: 'Pune' },
    { key: 'least_favorite_language', value: 'loveit', userConfirmedAt: 5 },
  ];
  const c = review.reviewCandidates({ mind, facts });
  assert.deepEqual(c.map(x => x.kind).sort(), ['fact_fails_schema', 'merged_goal', 'role_is_aspiration']);
  const merged = c.find(x => x.kind === 'merged_goal');
  assert.deepEqual(merged.parts, ['become a billionaire', 'build a company people love']);
  const fact = c.find(x => x.kind === 'fact_fails_schema');
  assert.equal(fact.label, 'Profession');
  assert.equal(fact.aspiration, true);
  assert.equal(fact.learnedFrom, 'I want to be a billionaire');
  assert.deepEqual(review.reviewCandidates({ mind: null, facts: [] }), []);
});

test('GET /mind/review reads and changes nothing', async () => {
  const mind = mindStore.getMind(OWNER);
  legacyGoal(mind, 'become a billionaire and build a company people love');
  ltm.storeFact(OWNER, { key: 'profession', value: 'billionaire', confidence: 0.9, importance: 7, ts: Date.now(), isCorrection: true });
  const snapshot = JSON.stringify(mind.goals);
  const r = await call('GET', '/mind/review');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.candidates.map(x => x.kind).sort(), ['fact_fails_schema', 'merged_goal']);
  assert.equal(JSON.stringify(mind.goals), snapshot);
});

test('split: parts become goals; the original is kept, abandoned, hidden, with history', async () => {
  const mind = mindStore.getMind(OWNER);
  const orig = Object.values(mind.goals).find(g => /billionaire/.test(g.title) && !g.splitInto);
  const bad = await call('POST', `/mind/goals/${orig.id}/split`, { parts: ['only one'] });
  assert.equal(bad.status, 400);
  const r = await call('POST', `/mind/goals/${orig.id}/split`, { parts: ['become a billionaire', 'build a company people love'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.goals.length, 2);
  for (const g of r.json.goals) {
    assert.equal(g.mentions, orig.mentions, 'evidence count carried');
    assert.equal(g.createdAt, orig.createdAt, 'learned-at carried');
    assert.match(g.history[0].reason, new RegExp(orig.id));
  }
  assert.ok(mind.goals[orig.id], 'original still stored');
  assert.equal(mind.goals[orig.id].status, 'abandoned');
  assert.deepEqual(mind.goals[orig.id].splitInto, r.json.goals.map(g => g.id));
  const page = await call('GET', '/mind');
  const titles = page.json.goals.map(g => g.title);
  assert.ok(!titles.some(t => / and build/.test(t)), 'original not on the page');
  assert.ok(titles.includes('become a billionaire') && titles.includes('build a company people love'));
  const again = await call('GET', '/mind/review');
  assert.ok(!again.json.candidates.some(x => x.kind === 'merged_goal'), 'review stops asking');
  assert.equal((await call('POST', `/mind/goals/${orig.id}/split`, { parts: ['a b c', 'd e f'] })).status, 404, 'cannot split twice');
});

test('keep as one goal: unchanged, and no longer flagged', async () => {
  const mind = mindStore.getMind(OWNER);
  const g = legacyGoal(mind, 'learn Spanish and travel to Peru');
  assert.ok((await call('GET', '/mind/review')).json.candidates.some(x => x.goalId === g.id));
  const r = await call('POST', `/mind/goals/${g.id}/split`, { keep: true });
  assert.equal(r.status, 200);
  assert.equal(mind.goals[g.id].title, 'learn Spanish and travel to Peru');
  assert.equal(mind.goals[g.id].status, 'active');
  assert.ok(!(await call('GET', '/mind/review')).json.candidates.some(x => x.goalId === g.id));
});

test('confirm a rejected fact: shown and used again; remove: gone everywhere', async () => {
  assert.equal(retriever.retrieveRelevantFacts(OWNER, 'what is my profession?', 10).some(f => f.key === 'profession'), false, 'precondition: not used');
  const r = await call('POST', '/memory/fact/profession/confirm');
  assert.equal(r.status, 200);
  assert.ok(retriever.retrieveRelevantFacts(OWNER, 'what is my profession?', 10).some(f => f.key === 'profession'), 'used again');
  const mem = await call('GET', '/memory');
  assert.ok(mem.json.facts.some(f => f.key === 'profession'), 'shown again');
  assert.ok(!(await call('GET', '/mind/review')).json.candidates.some(x => x.key === 'profession'), 'no longer flagged');
  assert.equal((await call('POST', '/memory/fact/city/confirm')).status, 404, 'only a flagged fact can be confirmed');
});

test('aspirational role belief: hidden until the user says it is right', async () => {
  const mind = mindStore.getMind(OWNER);
  mind.beliefs['identity:role'] = { ...schema.createBelief({ dimension: 'identity', key: 'role', value: 'future billionaire', confidence: 0.9, source: 'explicit' }) };
  let page = await call('GET', '/mind');
  assert.ok(!page.json.identity.some(b => b.key === 'role'));
  assert.ok((await call('GET', '/mind/review')).json.candidates.some(x => x.kind === 'role_is_aspiration'));
  assert.equal((await call('POST', '/mind/beliefs/identity/role/review')).status, 200);
  page = await call('GET', '/mind');
  assert.ok(page.json.identity.some(b => b.key === 'role'), 'shown once confirmed');
});

test('fact extractor: goals in one sentence are separate collection items (live run 2026-10-29)', async () => {
  const { extractCandidatesFromSentence } = await import('../../memory/candidateExtractor.js');
  const goals = extractCandidatesFromSentence('My goal is to become a billionaire and build a company people love.', {})
    .filter(c => c.key === 'goal').map(c => c.value);
  assert.deepEqual(goals, ['become a billionaire', 'build a company people love']);
  const one = extractCandidatesFromSentence('I want to build and ship the app.', {}).filter(c => c.key === 'goal').map(c => c.value);
  assert.equal(one.length, 1, JSON.stringify(one));
});

test('a merged item in a stored goal collection: flagged, split with history, or kept', async () => {
  ltm.storeFact(OWNER, { key: 'goal', value: ['become a billionaire and build a company people love', 'learn Spanish this year'], category: 'goals', confidence: 0.9, importance: 6, ts: Date.now(), isCorrection: true });
  const c = (await call('GET', '/mind/review')).json.candidates.find(x => x.kind === 'merged_goal_item');
  assert.ok(c, 'flagged');
  assert.deepEqual(c.parts, ['become a billionaire', 'build a company people love']);
  assert.equal((await call('POST', '/memory/fact/goal/split-item', { item: 'not there', parts: ['a b', 'c d'] })).status, 404);
  const r = await call('POST', '/memory/fact/goal/split-item', { item: c.item, parts: c.parts });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const goal = ltm.getFact(OWNER, 'goal');
  assert.deepEqual([...goal.value].sort(), ['become a billionaire', 'build a company people love', 'learn Spanish this year']);
  assert.ok(JSON.stringify(goal.history ?? []).includes('become a billionaire and build'), 'old value kept in history');
  assert.ok(!(await call('GET', '/mind/review')).json.candidates.some(x => x.kind === 'merged_goal_item'));
});
