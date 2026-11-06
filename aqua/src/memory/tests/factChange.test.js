/**
 * Changed free-text facts on the LEGACY read (2026-10-29).
 *
 * Production serves the legacy read, and its profile block tells the model to
 * "rely on this profile". A legacy replay of the development personas found
 * that profile stating replaced values as current, because a change only
 * replaced a free-text fact when it was restated with the same words:
 *
 *   "My thesis is due on May 30." … "The thesis deadline moved to June 13."   → still May 30
 *   "My supervisor is Dr. Moss." … "my supervisor is now Dr. Patel."           → two keys, "now Dr"
 *   "My accountant is Jonas." … "my new accountant is Aylin."                  → both current
 *
 * and storing "Dr" for "Dr. Helen Moss" (the value stopped at punctuation).
 * The sentences below are written for these tests, not taken from an eval set.
 *
 * Run: node scripts/run-tests.mjs src/memory/tests/factChange.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const mod = p => import(pathToFileURL(path.join(repoRoot, p)).href);
let engine, ltm, extractFacts;

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-fact-change-'));
  process.env.AQUA_DATA_DIR = tmp;
  process.chdir(tmp);
  engine = await mod('src/memory/engine.js');
  ltm = await mod('src/memory/longTermMemory.js');
  ({ extractFacts } = await mod('src/memory/memoryExtractor.js'));
});

let clock = Date.UTC(2026, 8, 1);
function say(owner, text, conversationId = 'c1') {
  clock += 60_000;
  const realNow = Date.now;
  Date.now = () => clock;
  try { return engine.memoryObserve(owner, { userMessage: text, conversationId }); }
  finally { Date.now = realNow; }
}
const valueOf = (owner, key) => ltm.getFact(owner, key)?.value;
const profile = (owner, query) => engine.memoryRetrieve(owner, { query }).block;
// What the profile states AS CURRENT. Since 2026-11-02 a CHANGED value keeps
// its predecessor beside it as history — "due on April 23 (previously: due on
// April 2)" — so "not stated as current" means outside that note. (A
// CORRECTION still drops the old value entirely: forgetEverywhere.test.js.)
const asCurrent = block => String(block).replace(/\(previously:[^)]*\)/g, '');

test('a date change said without "my X is" replaces the stored date and keeps the old one in history', () => {
  const o = 'change-deadline';
  say(o, 'My dissertation is due on April 2.');
  assert.equal(valueOf(o, 'custom_dissertation'), 'due on April 2');
  say(o, 'The dissertation deadline got pushed back to April 23.', 'c2');
  assert.equal(valueOf(o, 'custom_dissertation'), 'due on April 23');
  const history = ltm.getFactHistory(o, 'custom_dissertation');
  assert.deepEqual(history.map(h => h.value), ['due on April 2'], 'the replaced value is history, not deleted');
  assert.match(history[0].sourceMessage, /April 2\./);
  const block = profile(o, 'When is my dissertation due?');
  assert.match(block, /April 23/);
  assert.doesNotMatch(asCurrent(block), /April 2\b/, 'the profile no longer states the old date as current');
  assert.match(block, /\(previously: due on April 2\)/, 'and keeps it as what was true before');
});

test('a change touches only the fact it names: same head word, different thing, is left alone', () => {
  const o = 'change-scope';
  say(o, 'My dissertation is due on April 2.');
  say(o, 'My dissertation supervisor is Professor Ana Ruiz.');
  say(o, 'My conference talk is on March 9.');
  say(o, 'The dissertation deadline moved to May 1.');
  assert.equal(valueOf(o, 'custom_dissertation'), 'due on May 1');
  assert.equal(valueOf(o, 'custom_dissertation_supervisor'), 'Professor Ana Ruiz');
  assert.equal(valueOf(o, 'custom_conference_talk'), 'on March 9', 'an unrelated dated fact is not overwritten by recency');
  say(o, 'The workshop moved to June 4.');
  assert.equal(valueOf(o, 'custom_conference_talk'), 'on March 9', 'a change to something never stored lands nowhere');
});

test('"I raised my X to Y" replaces the amount and nothing else', () => {
  const o = 'change-amount';
  say(o, 'My hourly rate is 90 dollars.');
  say(o, 'My team size is 6 people.');
  say(o, 'I raised my hourly rate to 100 dollars for new clients.', 'c2');
  assert.equal(valueOf(o, 'custom_hourly_rate'), '90 dollars', 'a qualified change is partial: the old rate still holds for existing clients');
  say(o, 'I raised my hourly rate to 110 dollars.', 'c2');
  assert.equal(valueOf(o, 'custom_hourly_rate'), '110 dollars');
  assert.equal(valueOf(o, 'custom_team_size'), '6 people');
  say(o, 'I moved my hourly rate to March 3.', 'c3');
  assert.equal(valueOf(o, 'custom_hourly_rate'), '110 dollars', 'a date is not an amount: no span to replace, no write');
});

test('"my X is now Y" replaces the stored X it changes, under that key, with history', () => {
  const o = 'change-now';
  say(o, 'My dissertation supervisor is Dr. Lena Moss.');
  assert.equal(valueOf(o, 'custom_dissertation_supervisor'), 'Dr. Lena Moss', 'a title is not where the value ends');
  say(o, 'Dr. Moss went on leave, so my supervisor is now Dr. Raj Patel.', 'c2');
  assert.equal(valueOf(o, 'custom_dissertation_supervisor'), 'Dr. Raj Patel');
  assert.equal(ltm.getFact(o, 'custom_supervisor'), null, 'no second, competing key');
  assert.deepEqual(ltm.getFactHistory(o, 'custom_dissertation_supervisor').map(h => h.value), ['Dr. Lena Moss']);
});

test('"my new X is Y" replaces X instead of standing beside it', () => {
  const o = 'change-new';
  say(o, 'My accountant is Pedro Alves.');
  say(o, 'Pedro retired; my new accountant is Mira Chen.', 'c2');
  assert.equal(valueOf(o, 'custom_accountant'), 'Mira Chen');
  assert.equal(ltm.getFact(o, 'custom_new_accountant'), null);
  assert.doesNotMatch(asCurrent(profile(o, 'Who is my accountant?')), /Pedro Alves/);
});

test('an ambiguous change is not guessed: two stored supervisors, "my supervisor is now…" replaces neither', () => {
  const o = 'change-ambiguous';
  say(o, 'My thesis supervisor is Professor Kim.');
  say(o, 'My lab supervisor is Dr. Osei.');
  say(o, 'My supervisor is now Dr. Varga.');
  assert.equal(valueOf(o, 'custom_thesis_supervisor'), 'Professor Kim');
  assert.equal(valueOf(o, 'custom_lab_supervisor'), 'Dr. Osei');
  assert.equal(valueOf(o, 'custom_supervisor'), 'Dr. Varga', 'kept as what was said, under its own key');
});

test('free-text values keep their punctuation and end at the clause', () => {
  const v = text => extractFacts(text).find(f => f.key.startsWith('custom_'))?.value;
  assert.equal(v('My goal this quarter is to reach 20,000 paying users.'), 'to reach 20,000 paying users');
  assert.equal(v('My blocker is that the R&D team has not signed off.'), 'that the R&D team has not signed off');
  assert.equal(v('My main contact is Tomas Berg, the head of procurement.'), 'Tomas Berg');
  assert.equal(v('My visa interview is on December 15, 2026.'), 'on December 15, 2026');
});

test('recall on a legacy read gets "since changed" notes from the fact history', () => {
  const o = 'change-notes';
  say(o, 'My dissertation is due on April 2.');
  say(o, 'The dissertation deadline moved to April 30.', 'c2');
  const notes = engine.legacySupersessionNotes(o);
  assert.deepEqual(notes, [{ key: 'custom_dissertation', quotes: ['My dissertation is due on April 2.'], now: 'The dissertation deadline moved to April 30.' }]);
});

test('requests addressed to Aqua do not borrow the user\'s facts through the assistant\'s verb', async () => {
  const { analyseQuestion } = await mod('src/pic/questionShape.js');
  assert.deepEqual(analyseQuestion('Can you run your tests for me?').terms, ['tests']);
  assert.deepEqual(analyseQuestion('Will you write your own documentation?').terms.includes('write'), false);
  assert.deepEqual(analyseQuestion('Can you write me a python script?').terms, ['python', 'script'], 'the objects stay');
  const work = analyseQuestion('Do you know where I work?');
  assert.equal(work.terms.includes('know'), false);
  assert.equal(work.typed, true, 'a question about the user, asked through "do you know", still types');
  assert.ok(work.cues.includes('work'));
  assert.equal(analyseQuestion('Where do I run on weekends?').terms.includes('run'), true, 'the user\'s own verb still counts');
});
