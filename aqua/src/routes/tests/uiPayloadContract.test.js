/**
 * Contract (2026-10-28): what the Memory and Understanding pages receive
 * carries no engine internals. Seeded with the exact leak sources seen in
 * production screenshots, written the way production stores them, then read
 * through the real routers the pages call:
 *   GET /memory, GET /memory/timeline, GET /mind, GET /understanding
 *
 * Every human-visible string (anything that is not an id) must have:
 *   no custom_ key · no intent id (simple_qa, personal_info, memory_recall…) ·
 *   no collection_merge · no label that is just "event" · no "Domain:" prefix ·
 * and no health/mood detail outside the Memory page's hidden section.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR             = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-uicontract-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI                 = '';
delete process.env.DATABASE_URL;

const LTM = await import('../../memory/longTermMemory.js');
const { getMind, touchMind } = await import('../../mind/mindStore.js');
const { default: memoryRoute } = await import('../memory.js');
const { default: mindRoute } = await import('../../mind/mindRoutes.js');
const { default: understandingRoute } = await import('../../understanding/understandingRoutes.js');

const USER = 'ui1';
const OWNER = `user:${USER}`;
const now = Date.now();

function seed() {
  const custom = { confidence: 0.7, importance: 4, category: 'custom', extractor: 'custom_fallback' };
  LTM.storeFact(OWNER, { ...custom, key: 'custom_student_with_almost_zero_networth', value: 'student with almost zero networth' });
  LTM.storeFact(OWNER, { ...custom, key: 'custom_networth', value: 'almost zero' });
  LTM.storeFact(OWNER, { ...custom, key: 'custom_very_bored', value: 'very bored' });
  LTM.storeFact(OWNER, { ...custom, key: 'custom_right_eye', value: 'moving automatically' });
  LTM.storeFact(OWNER, { key: 'least_favorite_language', value: ['loveit'], confidence: 0.9, importance: 6, category: 'preferences' });
  LTM.storeFact(OWNER, { key: 'profession', value: 'billionaire', confidence: 0.85, importance: 8, category: 'work' });
  // A goal collection merged three times, as the MERGE path stores it.
  const mind = getMind(OWNER);
  mind.facts.goal = {
    id: `${OWNER}:goal`, key: 'goal', category: 'goals', confidence: 0.9, importance: 7,
    value: ['becoming a billionaire', 'be topper in both courses', 'be a billionaire asap', 'become a billionaire one day'],
    createdAt: now - 1000, updatedAt: now, ts: now, revision: 3, status: 'active',
    history: [
      { value: ['becoming a billionaire'], supersededAt: now - 900, reason: 'collection_merge', revision: 1 },
      { value: ['becoming a billionaire', 'be topper in both courses'], supersededAt: now - 800, reason: 'collection_merge', revision: 2 },
    ],
  };
  // Mind state exactly as the old producers wrote it.
  mind.timeline.push(
    { id: 't1', ts: now - 700, kind: 'episode_opened', subject: 'Working on simple qa + memory recall', importance: 5 },
    { id: 't2', ts: now - 600, kind: 'episode_closed', subject: 'Working on simple qa', importance: 6 },
    { id: 't3', ts: now - 500, kind: 'goal_created', subject: 'ship the beta', importance: 6 },
    { id: 't4', ts: now - 400, kind: 'something_internal', importance: 5 },
  );
  mind.working.focus = [
    { topic: 'simple_qa', weight: 5, lastSeenAt: now }, { topic: 'personal_info', weight: 4, lastSeenAt: now },
    { topic: 'react', weight: 2, lastSeenAt: now },
  ];
  mind.predictions = [
    { label: 'Next questions likely about: simple_qa', probability: 0.6, basis: 'dominant working-memory focus' },
    { label: 'Likely working toward: ship the beta', probability: 0.5, basis: 'active goal (2 mentions)' },
  ];
  mind.episodes.e1 = { id: 'e1', title: 'Working on simple qa + memory recall', status: 'active', startedAt: now - 700, lastActivityAt: now, conversationIds: [], objectives: [] };
  const belief = (dimension, key, value, signal, extra = {}) => {
    mind.beliefs[`${dimension}:${key}`] = {
      dimension, key, value, confidence: 0.9, evidenceCount: 1, contradictions: 0, status: 'active',
      evidence: [{ ts: now, conversationId: null, signal, delta: 0.9, support: true, ...extra }], privacy: {}, updatedAt: now, createdAt: now,
    };
  };
  for (const t of ['alpha', 'frac', 'beta', 'gamma', 'tan', 'bar']) belief('knowledge', `domain:${t}`, 'familiar', 'a main topic of calc.pdf');
  belief('knowledge', 'domain:machine_learning', 'familiar', 'a main topic of notes.pdf');
  belief('identity', 'profession', 'billionaire', 'fact:profession', { explicit: true });
  belief('identity', 'founder', true, 'founder-context language');
  belief('identity', 'project', 'Tidepool', 'extracted fact: project');
  belief('identity', 'custom_very_bored', 'very bored', 'fact:custom_very_bored');
  // The "why" drawer's raw material: an intent note, an extractor slot, and a
  // superseded value that was an object.
  belief('identity', 'developer', true, 'task:simple_qa');
  mind.beliefs['identity:developer'].evidence.push({ ts: now, conversationId: 'c2', signal: 'extracted fact: custom_networth', delta: 0.1, support: true });
  mind.beliefs['identity:developer'].history = [{ value: { name: 'custom_x' }, supersededAt: now - 100 }];
  touchMind(mind);
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = USER; next(); });
app.use('/memory', memoryRoute);
app.use('/mind', mindRoute);
app.use('/understanding', understandingRoute);
let server, base;
before(() => { seed(); server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const get = async p => { const r = await fetch(base + p); assert.equal(r.status, 200, p); return r.json(); };

/** Ids the page uses to ACT (delete, pin) — not text a person reads. */
const ID_FIELDS = new Set(['key', 'id', 'factKey', 'ownerId', 'claimId', 'dimension', 'kind', 'status', 'source', 'category', 'conversationIds', 'activeGoals']);
function visibleStrings(node, at = '$', out = []) {
  if (typeof node === 'string') out.push([at, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => visibleStrings(v, `${at}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (ID_FIELDS.has(k) || k === 'hiddenSensitive') continue;
      visibleStrings(v, `${at}.${k}`, out);
    }
  }
  return out;
}
const LEAKS = [
  [/\bcustom_/i, 'custom_ key'],
  [/\b(?:simple[_\s]qa|personal[_\s]info|memory[_\s]recall|memory[_\s]update)\b/i, 'internal intent id'],
  [/collection_merge/i, 'internal operation name'],
  [/^\s*event\s*$/i, 'label "event"'],
  [/^Domain:/i, '"Domain:" prefix'],
  [/very bored|moving automatically/i, 'health/mood detail'],
  [/\bloveit\b/i, 'invalid language value'],
];
function assertClean(payload, name) {
  const bad = [];
  for (const [at, s] of visibleStrings(payload)) for (const [re, why] of LEAKS) if (re.test(s)) bad.push(`${name}${at.slice(1)} = ${JSON.stringify(s)} (${why})`);
  assert.deepEqual(bad, [], bad.join('\n'));
}

test('GET /memory: no leaks; sensitive facts listed apart; collections are distinct items', async () => {
  const body = await get('/memory');
  assertClean(body, 'memory');
  assert.deepEqual(body.hiddenSensitive.map(f => [f.key, f.sensitivity]).sort(), [['custom_right_eye', 'health'], ['custom_very_bored', 'mood']]);
  const goal = body.facts.find(f => f.key === 'goal');
  assert.deepEqual(goal.items, ['Becoming a billionaire', 'Be topper in both courses'], 'near-duplicates collapse; never one joined string');
  assert.equal(body.facts.find(f => f.key === 'custom_networth').label, null, 'a custom_ fact has no heading');
  assert.ok(!body.facts.some(f => f.key === 'profession'), 'a goal stored as profession is not shown');
  assert.ok(body.facts.some(f => f.key === 'custom_student_with_almost_zero_networth'), 'positive control: ordinary facts are listed');
});

test('GET /memory/timeline: every row is a readable sentence', async () => {
  const body = await get('/memory/timeline?days=30&limit=50');
  assertClean(body, 'timeline');
  const labels = body.changes.map(c => c.label);
  assert.ok(labels.some(l => /^Goals: added “Be topper in both courses”$/.test(l)), JSON.stringify(labels));
  assert.ok(labels.some(l => /Started working toward ship the beta/.test(l)), 'positive control: a real event is kept');
});

test('GET /mind: no intent ids, no markup domains, no goal as profession, real evidence lines', async () => {
  const body = await get('/mind');
  assertClean(body, 'mind');
  assert.deepEqual(body.knowledge.map(b => b.label), ['Machine learning']);
  assert.ok(!body.identity.some(b => b.key === 'profession'));
  const founder = body.identity.find(b => b.key === 'founder');
  assert.equal(founder.evidenceText, 'From 1 observation — latest: founder-context language.');
  assert.equal(body.identity.find(b => b.key === 'project').evidenceText, 'From something you told Aqua.', 'no extractor slot names in the evidence line');
  assert.deepEqual(body.working.focusRanked.map(f => f.topic), ['react']);
  assert.deepEqual(body.predictions.map(p => p.label), ['Likely working toward: ship the beta']);
  assert.deepEqual(body.episodes, []);
});

test('GET /mind/beliefs/:dim/:key: "Why Aqua believes this" is sentences, not observer notes or JSON', async () => {
  const { explanation } = await get('/mind/beliefs/identity/developer');
  assertClean(explanation, 'explanation');
  assert.doesNotMatch(explanation.explanation, /task:|extracted fact|Strongest signals|Previously believed|[{}]/);
  assert.deepEqual(explanation.recentEvidence.map(e => e.signal), ['Seen in a conversation', 'Something you told Aqua']);
  const founder = (await get('/mind/beliefs/identity/founder')).explanation;
  assert.match(founder.explanation, /founder-context language/, 'positive control: a human note is kept');
});

test('GET /understanding: no leaks', async () => {
  assertClean(await get('/understanding'), 'understanding');
});
