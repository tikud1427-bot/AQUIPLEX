/**
 * Episodic recall's staleness guard on a long history (2026-11-02): the later
 * word on a quoted statement is quoted after it, in different words.
 *
 * Pure (selectRecall over collectUnits), ranked mode — the regime a user is in
 * once their history outgrows the whole-history budget. Each test caps the
 * follow-up slots so that the ORDER of candidates is what is being tested.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR             = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-recall-temporal-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI                 = '';
delete process.env.DATABASE_URL;

const R = await import('../episodicRecall.js');

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const RANKED = { allUnderChars: 0 };

// Ranked mode only runs on a history past the whole-history budget, so the
// fixtures carry one: a conversation of requests that state nothing about the
// user, before the statements under test. On three passages every shared word
// is "in most passages" and nothing is salient.
const FILLER = ['How do I convert a CSV file to JSON?', 'What is the capital of Australia?', 'Explain compound interest simply.',
  'Give me a recipe for banana bread.', 'What does HTTP 404 mean?', 'Write a haiku about autumn rain.', 'How do vaccines work?',
  'Explain how a heat pump works.', 'How do I center a div in CSS?', 'What is a Gantt chart?', 'Why is the sky blue?',
  'Recommend a history podcast.', 'How do I remove a coffee stain?', 'What is the Pythagorean theorem?', 'What causes jet lag?',
  'How many cups are in a litre?', 'Explain the offside rule.', 'What is a leap year?', 'How do I sharpen a knife?', 'Tell me a fun fact.'];

/** One conversation per day after the filler; every message is the user's. */
function units(statementDays) {
  const days = [FILLER, ...statementDays];
  const m = new Map();
  days.forEach((msgs, d) => {
    m.set(`c${d}`, { meta: { userId: 'u1', title: `c${d}` }, messages: msgs.map((content, i) => ({ role: 'user', content, ts: T0 + d * DAY + i })) });
  });
  return R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: m });
}
const texts = r => r.excerpts.map(e => e.text);

describe('follow-ups on a ranked history', () => {
  beforeEach(() => R.__clearCacheForTests());

  test('a resolution in different words takes the slot before a later line that merely says "now"', () => {
    const u = units([
      ["We can't open the second bay until the landlord fixes the roof leak."],
      // The "now" line is the LATER one: on recency alone it would take the slot.
      ['The roof is repaired, finally dry in there.', 'Tune-ups are 150 cedis now and flat tire fixes went from 30 to 40.'],
    ]);
    const r = R.selectRecall(u, "What's stopping us from opening the second bay?", { ...RANKED, followUps: 1 });
    assert.ok(texts(r).some(t => /roof leak/.test(t)), 'control: the blocker is quoted');
    assert.ok(texts(r).some(t => /roof is repaired/.test(t)), 'its resolution takes the one follow-up slot');
    assert.ok(!texts(r).some(t => /cedis/.test(t)));
  });

  test('a follow-up brings its own later word (plan → blocker → resolution)', () => {
    const u = units([
      ['The kitchen is supposed to be finished by March 1.'],
      ['The kitchen is delayed because the cabinets are back-ordered.'],
      ['The cabinets arrived, but now the electrician is the bottleneck.'],
    ]);
    const r = R.selectRecall(u, 'When is the kitchen finished?', { ...RANKED, k: 1, followUps: 2 });
    assert.deepEqual(texts(r), [
      'The kitchen is supposed to be finished by March 1.',
      'The kitchen is delayed because the cabinets are back-ordered.',
      'The cabinets arrived, but now the electrician is the bottleneck.',
    ]);
  });

  test('a later change that matched the question but lost its seat is followed up', () => {
    const u = units([
      ['We plan to ship the first batch on March 3.', 'How do I write a good press release?'],
      ['Shipping slips to April 20, and Boxwell is out.'],
    ]);
    // One match seat: the plan (three shared words) takes it; the change shares
    // only "ship" — a question word — with it.
    const r = R.selectRecall(u, 'When does the first batch ship?', { ...RANKED, k: 1 });
    assert.ok(texts(r).some(t => /March 3/.test(t)), 'control');
    assert.ok(texts(r).some(t => /April 20/.test(t)));
    assert.equal(r.excerpts.find(e => /April 20/.test(e.text)).why, 'follow-up');
  });

  test('without a transition a later mention is not a follow-up', () => {
    const u = units([
      ['Now the San Antonio opening is blocked by a zoning permit.'],
      ['The zoning permit office has terrible parking.', 'The zoning permit came through.'],
    ]);
    const r = R.selectRecall(u, 'Is anything blocking the San Antonio opening?', { ...RANKED, k: 1, followUps: 1 });
    assert.ok(texts(r).some(t => /came through/.test(t)), 'control: the transition is chosen');
    assert.ok(!texts(r).some(t => /parking/.test(t)));
  });

  test('a forgotten resolution is never quoted through a follow-up', () => {
    const u = units([
      ['Our Kickstarter campaign is stuck waiting on FCC certification.'],
      ['Good news, FCC signed off on the lamp last night.'],
    ]);
    const open = R.selectRecall(u, 'Is anything holding up the Kickstarter?', RANKED);
    assert.ok(texts(open).some(t => /signed off/.test(t)), 'control: followed up when not forgotten');
    const redaction = { isRedacted: s => /signed off/.test(s) };
    const r = R.selectRecall(u, 'Is anything holding up the Kickstarter?', { ...RANKED, redaction });
    assert.ok(!texts(r).some(t => /signed off/.test(t)));
  });
});
