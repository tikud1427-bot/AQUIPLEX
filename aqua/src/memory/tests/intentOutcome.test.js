/**
 * Intent, outcomes and relationships (2026-11-04).
 *
 * The real observation pipeline, private data directory, no provider, no DB.
 * A reported outcome completes the goal it achieves — in both goal stores,
 * with the user's words — and nothing else does; "my company is X" is the
 * workplace; one sentence can state several facts; a question states none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-intent-'));
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
const { peekMind } = await import('../../mind/mindStore.js');
const { achieves, closeKind } = await import('../../understanding/stateTransition.js');
const { splitClauses } = await import('../sentenceParser.js');
const { redactSensitiveSentences } = await import('../sensitivity.js');
const { sensitivePolicy } = await import('../sensitivity.js');

let clock = Date.UTC(2026, 8, 1);
const realNow = Date.now;
Date.now = () => clock;
process.on('exit', () => { Date.now = realNow; });
let n = 0;
function life(...lines) {
  const o = `user:intent-${++n}`;
  for (const l of lines) {
    clock += 3_600_000;
    engine.memoryObserve(o, { userMessage: l, conversationId: `${o}-c`, userId: o, extractMessage: l });
    engine.memoryAfterTurn(o, {});
  }
  return o;
}
const items = v => [].concat(v ?? []);
const goal = (o, re) => Object.values(peekMind(o).goals).find(g => re.test(g.title));
const legacyGoal = (o, re) => {
  const f = peekMind(o).facts.goal;
  if (!f) return 'absent';
  if ((f.retiredItems ?? []).some(r => re.test(r.item) && r.kind === 'resolved') || (f.ended?.kind === 'resolved' && items(f.value).some(v => re.test(v)))) return 'completed';
  return !f.ended && items(f.value).some(v => re.test(v)) ? 'open' : 'other';
};
const facts = o => Object.fromEntries(Object.values(peekMind(o).facts).filter(f => !f.ended && f.status !== 'archived').map(f => [f.key, f.value]));
const block = o => engine.memoryRetrieve(o, { query: 'What are my goals?', legacyUserMemory: true, sensitive: sensitivePolicy({ rememberSensitive: false, message: 'x' }) }).block;

// ── achievements ─────────────────────────────────────────────────────────────
for (const [goalLine, said, re] of [
  ['My goal is to run a half marathon in October.', 'I finally ran the half marathon.', /half marathon/],
  ['My goal is to get promoted to senior analyst.', 'I got the promotion!', /promoted/],
  ['My goal is to raise a seed round for Nummo.', 'We closed our seed round yesterday.', /seed round/],
  ['My goal is to get my driver\'s license.', 'Got my driver\'s license today!', /license/],
]) {
  test(`an achievement completes its goal in both stores: "${said}"`, () => {
    const o = life(goalLine, said);
    const g = goal(o, re);
    assert.equal(g.status, 'completed');
    assert.equal(legacyGoal(o, re), 'completed', 'the profile goal list agrees (goal sync)');
    assert.match(g.history.at(-1).reason, /^(?:achieved by the user|completion cue)/);
    assert.ok(g.achievedBy?.text, 'the achievement statement is kept');
    assert.equal(g.title, goalLine.replace(/^My goal is to /, '').replace(/\.$/, ''), 'the goal itself is unchanged');
    assert.ok((peekMind(o).facts.goal.transitions ?? []).some(t => t.id && t.kind === 'resolved'), 'through the transition lifecycle');
  });
}

test('when the user says it happened is recorded as said', () => {
  const o = life('My goal is to buy a house this year.', 'We bought a house last week.');
  assert.equal(goal(o, /house/).achievedBy.when, 'last week');
});

for (const [goalLine, said, why] of [
  ['My goal is to pass the CFA Level 1 exam.', "I didn't pass my CFA exam.", 'negation'],
  ['My goal is to run a half marathon in October.', "I'm going to run the half marathon next month.", 'plan'],
  ['My goal is to pass the CFA Level 1 exam.', "If I pass the CFA exam, I'll celebrate.", 'hypothetical'],
  ['My goal is to run a half marathon in October.', 'My sister ran the half marathon.', 'third party'],
  ['Our goal is to launch the product by June.', 'Our competitor launched their product.', 'third party, keyword cue'],
  ['My goal is to finish writing my book this year.', 'I finished the first draft of my book.', 'partial'],
  ['My goal is to pass the CFA Level 1 exam.', 'Yeah right, as if I passed the CFA exam.', 'sarcasm'],
  ['My goal is to pass the CFA Level 1 exam.', 'Did I pass the CFA exam?', 'question'],
  ['My goal is to run a half marathon in October.', 'I ran the half marathon route with a friend for training.', 'activity around it'],
  ['My goal is to learn to swim.', 'I finished my third swimming lesson.', 'the object is the lesson, not the goal'],
  ['My goal is to save 10,000 dollars for a car.', 'I saved 2,000 dollars for the car so far.', 'partial amount'],
  ['My goal is to get promoted to senior analyst.', 'I almost got the promotion.', 'almost'],
]) {
  test(`not an achievement (${why}): "${said}"`, () => {
    const re = new RegExp(goalLine.replace(/^(?:My|Our) goal is to /, '').split(' ')[1] ?? 'x', 'i');
    const o = life(goalLine, said);
    const g = Object.values(peekMind(o).goals)[0];
    assert.equal(g.status, 'active');
    assert.equal(legacyGoal(o, new RegExp(g.title.split(' ').slice(0, 2).join(' '))), 'open');
    void re;
  });
}

test('several goals: the one achieved closes, the other stays; an object-less "I passed!" touches none', () => {
  const o = life('My goal is to run a half marathon in October.', 'My goal is to learn Spanish this year.', 'I ran the half marathon on Sunday.');
  assert.equal(goal(o, /half marathon/).status, 'completed');
  assert.equal(goal(o, /Spanish/).status, 'active');
  const p = life('My goal is to pass the CFA Level 1 exam.', 'My goal is to pass my driving test.', 'I passed!');
  assert.equal(goal(p, /CFA/).status, 'active');
  assert.equal(goal(p, /driving/).status, 'active');
});

test('a related fact changing completes nothing', () => {
  const o = life('My goal is to get promoted to senior analyst at Fintrail.', "I'm a data analyst at Fintrail.", 'I now work at Northbeam as a senior analyst.');
  assert.equal(goal(o, /promoted/).status, 'active');
});

test('the shared reader: a part done does not resolve; the goal\'s own verb in the past does', () => {
  assert.equal(closeKind('I finished the first draft of my book.'), null);
  assert.equal(closeKind('I finished my book.'), 'resolved');
  assert.ok(achieves('I became a certified nurse last month.', 'become a certified nurse'));
  assert.ok(achieves('I read my twentieth book last night!', 'read twenty books this year'));
  assert.equal(achieves('I read a great article about books today.', 'read twenty books this year'), null);
  assert.equal(achieves('I passed the CFA exam, yeah right.', 'pass the CFA Level 1 exam'), null, 'sarcastic frame');
  assert.equal(achieves('I totally passed the CFA exam — as if.', 'pass the CFA Level 1 exam'), null, 'sarcastic frame after the object');
});

test('an achieved goal reads as achieved in the profile, and the other goals are not shown as "previously"', () => {
  const o = life('My goal is to pass the CFA Level 1 exam.', 'My goal is to learn Spanish this year.', 'I passed my CFA exam!');
  const b = block(o);
  assert.match(b, /pass the CFA Level 1 exam \(achieved\) — they said: "I passed my CFA exam!"/);
  assert.doesNotMatch(b, /previously: pass the CFA/);
});

test('both goal stores create an explicitly stated goal, whatever its verb or numbers', () => {
  const o = life('My goal is to read twenty books this year.', 'My goal is to save 10,000 dollars for a car.');
  assert.ok(goal(o, /twenty books/), 'the Mind keeps a stated "read" goal');
  assert.ok(items(peekMind(o).facts.goal.value).some(v => v === 'save 10,000 dollars for a car'), 'not cut at the comma in 10,000');
});

// ── entities ─────────────────────────────────────────────────────────────────
test('"my company is X" is the workplace, and a correction of it goes through the lifecycle', () => {
  const o = life("I'm a data analyst at Fintrail.", 'Actually, my company is Northbeam.');
  const m = peekMind(o);
  assert.equal(m.facts.workplace.value, 'Northbeam');
  assert.equal(m.facts.project, undefined);
  assert.equal(m.facts.workplace.transitions.find(t => t.id).kind, 'corrected');
  assert.equal(Object.values(m.beliefs).find(b => b.key === 'organization').value, 'Northbeam');
});

test('a slot holds a name: "my company is growing fast" stores no company', () => {
  const o = life('My company is growing fast.');
  assert.equal(facts(o).workplace, undefined);
  assert.equal(facts(o).custom_company, undefined);
});

test('the same name in different relationships', () => {
  assert.equal(facts(life('Northbeam is my client.')).custom_client, 'Northbeam');
  assert.equal(facts(life('My company, Northbeam, is based in Denver.')).workplace, 'Northbeam');
  assert.equal(facts(life('My company, Northbeam, is based in Denver.')).city, undefined, "the company's city is not the user's");
  assert.deepEqual(items(facts(life('Jordan is my co-founder.')).cofounder), ['Jordan']);
  assert.deepEqual(items(facts(life("I'm building an app called Tidepool.")).project), ['Tidepool']);
});

// ── several facts in one sentence ───────────────────────────────────────────
test('one sentence, two relationships: each its own fact, provenance the whole sentence', () => {
  const said = 'My manager is Priya Rao and my accountant is Lena Ortiz.';
  const o = life(said);
  const m = peekMind(o);
  assert.equal(m.facts.custom_manager.value, 'Priya Rao');
  assert.equal(m.facts.custom_accountant.value, 'Lena Ortiz');
  assert.equal(m.facts.custom_manager.sourceText, said);
});

test('clauses split at a new subject, never inside a name', () => {
  assert.deepEqual(splitClauses('I live in Austin and I work at Northbeam.'), ['I live in Austin', 'I work at Northbeam.']);
  assert.deepEqual(splitClauses('Our lawyer is Johnson and Johnson LLP.'), ['Our lawyer is Johnson and Johnson LLP.']);
  assert.deepEqual(splitClauses('When I write emails, I prefer a warm tone.'), ['When I write emails, I prefer a warm tone.']);
  const o = life('I work at Northbeam and my manager there is Tom Ellis.');
  assert.equal(facts(o).workplace, 'Northbeam');
  assert.equal(facts(o).custom_manager, 'Tom Ellis');
  const neg = life('My manager is Priya Rao and my accountant isn\'t decided yet.');
  assert.equal(facts(neg).custom_manager, 'Priya Rao');
  assert.equal(facts(neg).custom_accountant, undefined);
});

test('a sensitive clause goes; the rest of its sentence stays', () => {
  assert.equal(redactSensitiveSentences('My mentor is Grace Liu and my therapist is private. I like tea.').text, 'My mentor is Grace Liu. I like tea.');
  const o = life('My mentor is Grace Liu and my therapist is private.');
  assert.equal(facts(o).custom_mentor, 'Grace Liu');
});

test('a question states no fact', () => {
  const o = life('My goal is to run a half marathon in October.', 'How is my half marathon goal going?');
  assert.ok(!Object.keys(facts(o)).some(k => /going/.test(k)));
});

// Each guard alone (the cases above are also caught by a second guard).
test('a sarcastic frame after the user as subject is not an achievement', () => {
  const o = life('My goal is to pass the CFA Level 1 exam.', 'I passed the CFA exam, yeah right.');
  assert.equal(goal(o, /CFA/).status, 'active');
});
test('a different amount is not the goal amount', () => {
  const o = life('My goal is to save 10,000 dollars for a car.', 'I saved 2,000 dollars for the car.');
  assert.equal(goal(o, /car/).status, 'active');
});
test('a completion cue in the message that names the goal still needs the user as the one who did it', () => {
  const o = life('Our goal is to launch the product by June, but our competitor launched their product first.');
  assert.equal(goal(o, /launch the product/)?.status, 'active');
});
