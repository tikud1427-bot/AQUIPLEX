/**
 * Sentence splitting must not depend on capitalisation.
 *
 * `splitSentences` used to end its split regex with `(?=[A-Z"'])`, requiring
 * the next sentence to begin with a capital. In production that meant a
 * five-sentence lowercase message parsed as ONE sentence: every per-sentence
 * extraction pattern was then matched against the whole run-on string and the
 * message silently produced nothing. The user saw `sentences=1` and
 * `NO_MATCH`, with no error anywhere.
 *
 * The lookahead was never what protected decimals — "3.14" has no whitespace
 * after the period, so `\s+` already excluded it. Abbreviations are handled by
 * the protection pass, which this fix extended to cover dotted forms like
 * "e.g." that the lookahead had been incidentally shielding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, parseMessage } from '../sentenceParser.js';

// ── The regression ──────────────────────────────────────────────────────────

test('lowercase multi-sentence input splits — the production bug', () => {
  const msg = "my brother's name is ananya prabal das. he is the co-founder of aquiplex. " +
              'he is studying in class 11';
  assert.equal(splitSentences(msg).length, 3);
});

test('case does not change the sentence count', () => {
  const lower = 'my name is alice. i live in berlin. i love rust.';
  const upper = 'My name is Alice. I live in Berlin. I love Rust.';
  assert.equal(splitSentences(lower).length, splitSentences(upper).length);
  assert.equal(splitSentences(lower).length, 3);
});

test('mixed case within one message splits consistently', () => {
  const msg = 'My name is Alice. i live in berlin. I love Rust.';
  assert.equal(splitSentences(msg).length, 3);
});

// ── What the lookahead was wrongly credited with protecting ─────────────────

test('decimals are not sentence boundaries', () => {
  assert.equal(splitSentences('the value is 3.14 and it matters').length, 1);
  assert.equal(splitSentences('we shipped v2.1.4 last week').length, 1);
});

test('dotted abbreviations are not sentence boundaries', () => {
  // These are the cases the removed lookahead had been shielding by accident,
  // which is why the protection list grew alongside the fix.
  assert.equal(splitSentences('use e.g. the billing service for this').length, 1);
  assert.equal(splitSentences('i.e. the one we discussed').length, 1);
  assert.equal(splitSentences('the meeting is at 4 p.m. tomorrow').length, 1);
});

test('titles are not sentence boundaries', () => {
  assert.equal(splitSentences('Dr. Smith called. he left a message').length, 2);
  assert.equal(splitSentences('mr. patel runs the team').length, 1);
});

test('company suffixes stay protected, at a known cost', () => {
  // "inc." is genuinely ambiguous — company suffix or end of sentence. The
  // protection pass resolves it as a suffix, so this under-splits. Recorded
  // deliberately: a run-on sentence is still scanned whole, whereas a wrong
  // split produces two fragments that match nothing.
  assert.equal(splitSentences('i work at acme inc. we ship weekly').length, 1);
});

// ── Ordinary punctuation ────────────────────────────────────────────────────

test('question and exclamation marks split, in any case', () => {
  assert.equal(splitSentences('what? yes! ok.').length, 3);
  assert.equal(splitSentences('What? Yes! Ok.').length, 3);
});

test('empty and junk input is handled', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences('...'), ['...']);
});

test('parseMessage carries the split through unchanged', () => {
  const parsed = parseMessage('my name is alice. i live in berlin.');
  assert.equal(parsed.sentences.length, 2);
  assert.equal(parsed.isCorrection, false);
});
