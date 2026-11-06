/**
 * One change, every store (memory/propagation.js, 2026-11-02).
 *
 * The real observation pipeline (memoryObserve + the conversation evidence
 * lane), private data directory, no provider, no database. When the user says
 * "I now work at Northbeam", every store that held Fintrail as current stops
 * doing so, keeps it as history, and what NAMES Fintrail (a goal, a deadline)
 * is flagged as uncertain — never closed. Failures part-way, repeated
 * messages, stale copies, forgetting and going back are each pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-one-change-'));
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
// The conversation evidence lane holds sentences only with these on.
process.env.AQUA_BRAIN_INGEST = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS = 'on';

const engine = await import('../engine.js');
const Brain = await import('../../brain/index.js');
const ES = await import('../../files/evidenceStore.js');
const P = await import('../propagation.js');
const { peekMind } = await import('../../mind/mindStore.js');
const { forgetFact } = await import('../forget.js');
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
  await Brain.observeConversationTurn({ ownerId: owner, conversationId: `${owner}-c`, turn, userMessage: text, assistantMessage: '' });
  await new Promise(r => setTimeout(r, 30));
}

const LIFE = [
  "I'm a data analyst at Fintrail.",
  'My goal is to get promoted to senior analyst at Fintrail.',
  "I'm leading the Atlas migration at Fintrail; it's due on March 3.",
  'I learned SQL at Fintrail.',
  'My friend Sam works at Fintrail.',
  'My goal is to run a half marathon in October.',
];
const MOVE = 'I now work at Northbeam as a senior analyst.';
let n = 0;
async function lived() {
  const owner = `user:one-change-${++n}`;
  for (const t of LIFE) await say(owner, t);
  clock += 7 * 86_400_000;
  return owner;
}

const org = m => Object.values(m.beliefs).find(b => b.key === 'organization');
const edgeTo = (m, label) => Object.values(m.graph.edges).find(e => e.from === 'person:__self__' && m.graph.nodes[e.to]?.label?.toLowerCase() === label);
const goal = (m, re) => Object.values(m.goals).find(g => re.test(g.title));
const sentence = (owner, s) => ES.listFacts(owner, { limit: 1000 }).find(f => f.statement === s);
const block = owner => engine.memoryRetrieve(owner, { query: 'Where do I work and what am I working toward?', requestId: `q${turn}`,
  legacyUserMemory: true, sensitive: sensitivePolicy({ rememberSensitive: false, message: 'x' }) }).block;

test('a job change reaches the belief and the graph; the old value stays as history', async () => {
  const owner = await lived();
  await say(owner, MOVE);
  const m = peekMind(owner);
  assert.equal(m.facts.workplace.value, 'Northbeam');
  assert.equal(org(m).value, 'Northbeam', 'the Mind belief holds the new employer');
  assert.ok(org(m).history.some(h => h.value === 'Fintrail' && h.transitionId), 'the old employer is in the belief history');
  assert.ok(edgeTo(m, 'fintrail')?.endedAt, 'self → Fintrail has ended');
  assert.ok(edgeTo(m, 'northbeam') && !edgeTo(m, 'northbeam').endedAt, 'self → Northbeam exists');
  assert.equal(sentence(owner, "I'm a data analyst at Fintrail.")?.archived, true, 'the sentence that stated it is retired, not deleted');
  const t = m.facts.workplace.transitions.find(x => x.id);
  assert.deepEqual([t.from, t.to, t.kind, t.text], ['Fintrail', 'Northbeam', 'changed', MOVE]);
});

test('what names the old employer is flagged uncertain — never completed, closed or deleted', async () => {
  const owner = await lived();
  await say(owner, MOVE);
  const m = peekMind(owner);
  const promo = goal(m, /promoted/);
  assert.equal(promo.status, 'active');
  assert.equal(promo.review?.value, 'Fintrail');
  assert.ok(m.working.deadlines.find(d => /Atlas migration/.test(d.label))?.review, 'the deadline keeps its subject and is flagged');
  assert.ok((m.facts.goal.reviews ?? []).some(r => /promoted/.test(r.item)), 'the legacy goal item is flagged');
  assert.ok(sentence(owner, "I'm leading the Atlas migration at Fintrail; it's due on March 3.")?.review, 'the evidence sentence is flagged');
  assert.equal(sentence(owner, "I'm leading the Atlas migration at Fintrail; it's due on March 3.")?.archived ?? false, false);
  const b = block(owner);
  assert.match(b, /promoted to senior analyst at Fintrail" \(uncertain whether still current — they said: "I now work at Northbeam/);
});

test('not flagged: what already happened, someone else, an unrelated goal', async () => {
  const owner = await lived();
  await say(owner, MOVE);
  const m = peekMind(owner);
  assert.equal(sentence(owner, 'I learned SQL at Fintrail.')?.review ?? null, null);
  assert.equal(sentence(owner, 'My friend Sam works at Fintrail.')?.review ?? null, null);
  assert.equal(goal(m, /half marathon/).review, undefined);
  assert.ok(!(m.facts.goal.reviews ?? []).some(r => /marathon/.test(r.item)));
});

test('the same change processed again changes nothing', async () => {
  const owner = await lived();
  await say(owner, MOVE);
  const m = peekMind(owner);
  const snap = () => JSON.stringify([m.facts.workplace.history, m.facts.workplace.transitions, org(m).history, goal(m, /promoted/).review, Object.keys(m.graph.edges)]);
  const before = snap();
  await say(owner, MOVE);
  assert.equal(snap(), before, 'a repeated message');
  assert.deepEqual(P.reconcileMind(owner), { beliefs: 0, edges: 0, goals: 0, flagged: 0, cleared: 0 }, 'a repeated reconciliation');
  const prev = new Map([['workplace', { value: 'Fintrail', sourceText: "I'm a data analyst at Fintrail." }]]);
  assert.equal(P.recordTransitions(owner, prev, { text: MOVE }).length, 0, 'the same transition is recorded once');
});

test('a Mind stage that fails part-way is completed on the next turn', async () => {
  const owner = await lived();
  P._failOnceAt('graph');
  await say(owner, MOVE);
  let m = peekMind(owner);
  assert.equal(org(m).value, 'Northbeam', 'stages before the failure are done');
  assert.ok(!edgeTo(m, 'fintrail').endedAt, 'the failed stage is not');
  await say(owner, 'What is a good way to learn Rust?');
  m = peekMind(owner);
  assert.ok(edgeTo(m, 'fintrail').endedAt);
  assert.ok(goal(m, /promoted/).review);
});

test('the evidence lane is retried after a failure', async () => {
  const owner = await lived();
  P._failOnceAt('evidence');
  await say(owner, MOVE);
  // The move is two transitions (workplace, profession); the first one taken fails.
  const all = () => Object.values(peekMind(owner).facts).flatMap(f => f.transitions ?? []).filter(x => x.id);
  const failed = all().find(x => x.picAttempts === 1);
  assert.ok(failed && !failed.pic, 'the failed step is counted and not stamped');
  await say(owner, 'What is a good way to learn Rust?');
  assert.ok(all().every(x => x.pic), 'every transition stamped once done');
  assert.equal(failed.picAttempts, 1, 'retried once, succeeded');
  assert.equal(sentence(owner, "I'm a data analyst at Fintrail.")?.archived, true);
});

test('an older copy brought back by a merge is repaired', async () => {
  const owner = await lived();
  await say(owner, MOVE);
  const m = peekMind(owner);
  Object.assign(org(m), { value: 'Fintrail', status: 'active' });
  delete edgeTo(m, 'fintrail').endedAt;
  delete goal(m, /promoted/).review;
  await say(owner, 'What is a good way to learn Rust?');
  assert.equal(org(m).value, 'Northbeam');
  assert.ok(edgeTo(m, 'fintrail').endedAt);
  assert.ok(goal(m, /promoted/).review);
});

test('forgetting the fact removes what the change set, and the Mind copies of the value', async () => {
  const owner = await lived();
  await say(owner, MOVE);
  await forgetFact(owner, 'workplace');
  await new Promise(r => setTimeout(r, 30));
  const m = peekMind(owner);
  const quoting = [...Object.values(m.goals), ...m.working.deadlines, ...ES.listFacts(owner, { limit: 1000 })].filter(x => /Northbeam/.test(x.review?.text ?? ''));
  assert.equal(quoting.length, 0, 'no review keeps quoting the forgotten sentence');
  assert.ok(!(m.facts.goal?.reviews ?? []).length);
  assert.equal(org(m), undefined, 'the belief holding the forgotten value is gone');
  assert.equal(edgeTo(m, 'northbeam'), undefined);
});

test('going back to the old value releases everything the change set', async () => {
  const owner = await lived();
  await say(owner, MOVE);
  clock += 30 * 86_400_000;
  await say(owner, 'I now work at Fintrail again.');
  const m = peekMind(owner);
  assert.equal(m.facts.workplace.value, 'Fintrail');
  assert.equal(org(m).value, 'Fintrail');
  assert.ok(!edgeTo(m, 'fintrail').endedAt, 'the edge reopens');
  assert.equal(goal(m, /promoted/).review, undefined);
  assert.equal(sentence(owner, "I'm leading the Atlas migration at Fintrail; it's due on March 3.")?.review ?? null, null);
});

test('another account is untouched', async () => {
  const a = await lived();
  const b = await lived();
  await say(a, MOVE);
  const m = peekMind(b);
  assert.equal(m.facts.workplace.value, 'Fintrail');
  assert.equal(org(m).value, 'Fintrail');
  assert.equal(goal(m, /promoted/).review, undefined);
  assert.ok(!Object.values(m.graph.edges).some(e => e.endedAt));
});

test('AQUA_PROPAGATION=off records nothing (kill switch)', async () => {
  const owner = await lived();
  process.env.AQUA_PROPAGATION = 'off';
  try { await say(owner, MOVE); } finally { process.env.AQUA_PROPAGATION = 'on'; }   // back to this file's enabled setting
  const m = peekMind(owner);
  assert.ok(!(m.facts.workplace.transitions ?? []).some(t => t.id));
  assert.equal(goal(m, /promoted/).review, undefined);
});

test('matching: a leading name, whole words, a stable id', () => {
  assert.deepEqual(P.anchorsOf('Derek Shaw at Lone Star Bank'), ['Derek Shaw']);
  assert.deepEqual(P.anchorsOf('data analyst'), [], 'a description is not looked for elsewhere');
  const f = { value: 'Northbeam' };
  const t = { from: 'Fintrail', at: 10, text: MOVE };
  assert.equal(P.dependsOn('Ship the Fintrailer app', t, f, 1), false, 'whole words only');
  assert.equal(P.dependsOn('Move the Fintrail desk to Northbeam', t, f, 1), false, 'names the new value too');
  assert.equal(P.dependsOn('Finish the Fintrail audit', t, f, 11), false, 'said after the change');
  assert.equal(P.dependsOn('Finish the Fintrail audit', t, f, 1), true);
  assert.equal(P.transitionId('o', 'k', 'A', 'B', 'x'), P.transitionId('o', 'k', 'a ', 'b', 'X'));
  assert.notEqual(P.transitionId('o', 'k', 'A', 'B', 'x'), P.transitionId('p', 'k', 'A', 'B', 'x'), 'owner-scoped');
});
