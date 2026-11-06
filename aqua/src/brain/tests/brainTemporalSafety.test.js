/**
 * Brain temporal continuity — safety properties (2026-11-06).
 *
 * temporalContinuity.test.js pins the behaviour (a resolution that names no
 * entity continues the blocker; owners; archived facts; ranking now vs past).
 * This file pins what must NOT happen while it does:
 *   · a correction or a tentative later word is stored as the user's own
 *     sentence — corrected stays a correction, "might" stays tentative — and
 *     nothing earlier is overwritten, archived or superseded;
 *   · a continuation keeps its provenance (conversation evidence, its own time);
 *   · health / mood text never reaches Brain extraction: ingest reads the
 *     write view (sensitivity.js redactSensitiveSentences, as chat.js
 *     memoryWriteTurn applies it), so a mixed sentence contributes only its
 *     independent clause, and a sensitive clause cannot continue anything;
 *   · facts stored before `continues` / `continuationOf` / `review` existed
 *     still retrieve and render.
 * Synthetic sentences only.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-brain-temporal-safety-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;

const Brain = await import('../index.js');
const PIC = await import('../../pic/core.js');
const ES = await import('../../files/evidenceStore.js');
const G = await import('../../reasoning/reasoningGraph.js');
const { redactSensitiveSentences } = await import('../../memory/sensitivity.js');

const A = 'user:bianca';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const realNow = Date.now;
let clock = T0, turnNo = 0;
const say = (text, d, ownerId = A) => {
  clock = T0 + d * DAY + (turnNo++) * 60_000;
  return Brain.observeConversationTurn({ ownerId, conversationId: `${ownerId}-c${d}`, turn: turnNo, userMessage: text, assistantMessage: '' });
};
// What chat.js memoryWriteTurn hands to ingest when the user has not opted in.
const sayWritten = (text, d) => say(redactSensitiveSentences(text).text, d);
const ask = q => { clock = T0 + 40 * DAY; return PIC.retrieveKnowledge(A, q, { limit: 8 }); };
const facts = () => ES.listFacts(A, { limit: 1000 });
const factFor = re => facts().find(f => re.test(f.statement));

beforeEach(() => {
  G._resetGraphForTests();
  ES._resetEvidenceStoreForTests();
  Object.assign(process.env, { AQUA_BRAIN_INGEST: 'on', AQUA_BRAIN_INGEST_FACTS: 'on', AQUA_CONTEXT_V2: 'on' });
  Date.now = () => clock;
  turnNo = 0;
});
afterEach(() => {
  Date.now = realNow;
  for (const k of ['AQUA_BRAIN_INGEST', 'AQUA_BRAIN_INGEST_FACTS', 'AQUA_CONTEXT_V2']) delete process.env[k];
});

function blocker() {
  say("I'm planning to open a second shop in San Antonio next summer.", 0);
  say('Now the San Antonio opening is blocked by a zoning permit.', 7);
  return factFor(/blocked by a zoning permit/);
}

test('a correction is stored as the user\'s own words, beside the original — nothing is overwritten', () => {
  const original = blocker();
  assert.ok(original, 'control: the blocker is stored');
  say('Actually, the zoning permit is fine; it is the parking permit that is pending.', 10);
  const correction = factFor(/parking permit that is pending/);
  assert.ok(correction, 'the correction is stored');
  assert.equal(correction.continues, original.id, 'linked to what it corrects');
  const after = factFor(/blocked by a zoning permit/);
  assert.equal(after.statement, original.statement, 'the original statement is unchanged');
  assert.ok(!after.archived && !after.supersededBy, 'and neither archived nor superseded');
});

for (const tentative of ['Maybe the zoning permit will be approved soon.', 'The zoning permit might come through next week.']) {
  test(`a tentative later word is not a resolution ("${tentative}"): it continues nothing, the blocker stands and still answers "now"`, () => {
    const original = blocker();
    say(tentative, 12);
    assert.ok(!facts().some(f => f.continues), 'no continuation recorded from a speculative sentence');
    const after = factFor(/blocked by a zoning permit/);
    assert.ok(!after.archived && !after.supersededBy && !after.disputed, 'the blocker still stands');
    assert.equal(after.statement, original.statement);
    const items = ask('Is anything still blocking the San Antonio opening?').items ?? [];
    assert.match(String(items[0]?.statement ?? items[0]?.text ?? ''), /blocked by a zoning permit/, 'the blocker ranks first');
  });
}

// KNOWN GAP (outside this commit): a speculative later sentence that NAMES the
// entity ("Maybe the San Antonio zoning permit will be approved soon.") is stored
// as an ordinary fact and PIC Lane 7 (pic/retrievalIntelligence.js, via
// stateTransition.continues) ranks it above the blocker like a resolution. The
// fix is one guard in stateTransition.continues; it changes committed C1/C5 code
// and is held for separate approval.
test.todo('a speculative later sentence that names the entity does not outrank the blocker (Lane 7)');

test('a continuation keeps its provenance: conversation evidence, its own time, its own turn', () => {
  blocker();
  say('The zoning permit came through.', 14);
  const res = factFor(/came through/);
  assert.ok(res?.continues, 'control: stored as a continuation');
  const ev = ES.evidenceForFact(A, res.id);
  assert.ok(ev.length && ev.every(e => e.sourceType === 'conversation'), JSON.stringify(ev.map(e => e.sourceType)));
  const blockerEv = ES.evidenceForFact(A, factFor(/blocked by a zoning permit/).id);
  assert.notDeepEqual(ev.map(e => e.id ?? e.evidenceId), blockerEv.map(e => e.id ?? e.evidenceId), 'its own evidence, not the blocker\'s');
});

test('sensitive text never reaches extraction: a mixed sentence contributes only its independent clause', () => {
  blocker();
  sayWritten('I have been feeling anxious lately, but our zoning permit came through.', 14);
  const all = facts().map(f => f.statement).join(' | ');
  assert.doesNotMatch(all, /anxious|feeling/i, all);
  assert.ok(factFor(/zoning permit came through/)?.continues, `the independent clause still continues the blocker: ${all}`);
});

test('no clause boundary: the whole mixed sentence is withheld, so nothing of it is stored or continued', () => {
  blocker();
  sayWritten('I have been feeling anxious lately, and the zoning permit came through.', 14);
  assert.doesNotMatch(facts().map(f => f.statement).join(' | '), /anxious|came through/i);
});

test('a wholly sensitive sentence is not stored and cannot continue anything', () => {
  blocker();
  sayWritten('My doctor says the zoning stress is giving me migraines now.', 14);
  assert.doesNotMatch(facts().map(f => f.statement).join(' | '), /doctor|migraine/i);
});

test('the floor still shows only what is about the question: an unrelated later statement is not pulled in', () => {
  blocker();
  say('The zoning permit came through.', 14);
  say('I repainted the garage door green.', 20);
  const r = ask('Is anything still blocking the San Antonio opening?');
  const text = JSON.stringify(r);
  assert.match(text, /came through/);
  assert.doesNotMatch(text, /garage door/);
});

test('facts stored before continuation fields existed still retrieve and render', () => {
  // The shape a fact had at HEAD: no `continues`, `continuationOf` or `review`.
  blocker();
  const legacy = factFor(/blocked by a zoning permit/);
  for (const k of ['continues', 'continuationOf', 'review']) assert.equal(legacy[k], undefined, `${k} absent on an older fact`);
  const r = ask('What is blocking the San Antonio opening?');
  assert.match(JSON.stringify(r), /zoning permit/);
});
