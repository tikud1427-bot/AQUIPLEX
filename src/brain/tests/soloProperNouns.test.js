/**
 * Pass A2 — solo proper nouns in conversational text.
 *
 * `files/extractors.js` keeps a bare proper noun only when it is said twice or
 * is multi-word (`count >= 2 || v.includes(' ')`). Sound for a 40-page
 * document; fatal for a one-sentence chat message, where it silently discards
 * essentially every name a user types.
 *
 * The negative controls below are the load-bearing half. Sentence-initial
 * capitalisation carries no information — "Payments are our biggest cost" and
 * "Razorpay is our main competitor" are typographically identical — so a pass
 * that accepts the second must reject the first, or it will mint entity nodes
 * out of ordinary nouns and put them on the user's understanding card.
 *
 * Proven to bite: reverting `soloProperNouns` to a no-op fails exactly the two
 * capture cases. The eight negative and structural cases pass in both
 * directions by design — they exist to stop the next change, not to prove this
 * one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractConversationEntities } from '../knowledgeExtraction/conversationEntities.js';
import { extractEntities } from '../../files/extractors.js';

const names = (text, opts = {}) =>
  extractConversationEntities(text, opts).map(e => e.value);

// ── The gap being closed ─────────────────────────────────────────────────────

test('a single-word name said once mid-sentence is captured', () => {
  // A capital in the middle of a chat line is deliberate. Nobody capitalises
  // "office" by accident.
  assert.ok(names('I moved to the Bangalore office last month').includes('Bangalore'));
  assert.ok(names('I work at Nummo').includes('Nummo'));
  assert.ok(names('my co-founder is Dev, he handles engineering').includes('Dev'));
});

test('a single-word name said once at the start of a sentence is captured', () => {
  // The harder tier: capitalisation proves nothing, so a naming predicate is
  // required as well.
  assert.ok(names('Razorpay is our main competitor').includes('Razorpay'));
  assert.ok(names('Nummo is based in Bangalore').includes('Nummo'));
});

test('the shared extractor genuinely returns nothing for these', () => {
  // Pins WHY this module exists. If the document extractor ever starts finding
  // them, this pass is redundant and should be deleted rather than left to
  // double-emit.
  for (const t of ['Razorpay is our main competitor', 'I work at Nummo', 'Nummo is based in Bangalore']) {
    assert.equal(extractEntities(t).length, 0, `shared extractor now finds entities in "${t}"`);
  }
});

// ── Negative controls ────────────────────────────────────────────────────────

test('ordinary nouns opening a sentence do NOT become entities', () => {
  for (const t of [
    'Payments are our biggest cost',
    'Churn is the problem right now',
    'Pricing is still undecided',
    'Retention was better last quarter',
    'Everything is broken',
    'The deadline is Friday',
  ]) {
    assert.deepEqual(names(t), [], `"${t}" produced ${JSON.stringify(names(t))}`);
  }
});

test('REVERSED: a sentence-initial capital before a FINITE VERB is now captured', () => {
  // This test used to assert `names('Dev handles engineering') === []`, with
  // the note that it was "the stated cost of the conservative tier; recorded so
  // it is a decision rather than a surprise." The decision has been reversed
  // deliberately, and the surprise is what it was costing.
  //
  // Tier 2 required a copula (`is/was/are/were/has/have/had`), so every person
  // who DOES something was invisible: "Dev reports to me", "Rahul joined the
  // billing team", "Maya introduced me to an investor". Measured on
  // `extraction-core.v1`, subject recall split 58.9% for the speaker against
  // 18.1% for named third parties — and other people ARE most of a user's
  // world.
  //
  // A subject is followed by a finite verb, not specifically by a copula, and
  // that is now tested morphologically (3rd-person `-s`, regular `-ed`, or the
  // closed irregular class) rather than by a keyword list.
  assert.deepEqual(names('Dev handles engineering'), ['Dev']);
  assert.deepEqual(names('Rahul joined the billing team'), ['Rahul']);
});

test('the guard that replaced it: a common noun before a verb is still refused', () => {
  // The old copula rule was doing double duty as a false-positive guard. That
  // job now belongs entirely to COMMON_SUBJECT, which makes that list
  // load-bearing rather than a second opinion — so it is tested directly.
  //
  // "Work handles the rest" was the original counter-example and it still must
  // not mint an entity. A bad entity is worse than a missing one: it becomes a
  // node other turns attach facts to.
  assert.deepEqual(names('Work handles the rest'), []);
  assert.deepEqual(names('Latency increased last week'), []);
  assert.deepEqual(names('Onboarding slowed in March'), []);
});

test('interrogatives and SQL keywords never become entities', () => {
  // Broadening the verb test began minting these: they are capitalised,
  // sentence-initial, and followed by a finite verb.
  assert.deepEqual(names('Why did the deploy fail?'), []);
  assert.deepEqual(names('What are the trade-offs here?'), []);
  assert.ok(!names('SELECT * FROM users WHERE id = 1;').includes('FROM'));
});

test('calendar words and contractions never become entities', () => {
  assert.deepEqual(names('Friday is the launch'), []);
  assert.deepEqual(names('December is the deadline'), []);
  assert.deepEqual(names("I'm tired and we're busy"), []);
});

test('a multi-word name does not also emit a rival single-word node', () => {
  // "Nummo Technologies" plus a competing "Nummo" would be two nodes for one
  // company, and facts would split across them.
  const out = names('I work at Nummo Technologies');
  assert.ok(out.some(v => v === 'Nummo Technologies'));
  assert.ok(!out.includes('Nummo'), `forked a rival node: ${JSON.stringify(out)}`);
});

test('a name already found by the shared extractor is not duplicated', () => {
  const out = names('Razorpay is big. Razorpay is our competitor');
  assert.equal(out.filter(v => v === 'Razorpay').length, 1);
});

// ── The standing constraint ──────────────────────────────────────────────────

test('the document pipeline is NOT loosened to buy chat capture', () => {
  // The same pin the capitalisation fix left behind, restated for this change:
  // every uploaded file must not pay for a chat problem. If this fails, someone
  // has edited src/files/ to make the chat tests pass.
  assert.equal(extractEntities('razorpay is our main competitor').length, 0);
  assert.equal(extractEntities('i work at nummo').length, 0);
  assert.equal(extractEntities('Razorpay is our main competitor').length, 0);
});

test('known entities still resolve case-insensitively onto canonical casing', () => {
  // Pass B must keep working — the new pass runs before it and must not shadow
  // it, or a lowercase second mention would fork a new node.
  const out = names('we talked to razorpay again', {
    knownEntities: [{ value: 'Razorpay', type: 'name' }],
  });
  assert.ok(out.includes('Razorpay'), JSON.stringify(out));
  assert.ok(!out.includes('razorpay'));
});
