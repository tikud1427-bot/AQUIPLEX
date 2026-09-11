/**
 * Goal detection — the "Aiming at" section, and the heaviest term in the score.
 *
 * The old table detected 1 of these 10 statements. Three causes: a closed verb
 * allowlist (ship|launch|build|…), a `my goal is` pattern that required that
 * exact possessive, and an `i'm trying to` pattern that required an explicit
 * I'm/I am. All three are the same shape — a coding-era heuristic meeting
 * ordinary speech.
 *
 * The NEGATIVE block is the load-bearing half. Opening the verb up is exactly
 * what turns "I want to know how OAuth works" into a goal, and a wrong goal is
 * materially worse than a missing one: `goals:none` is the single heaviest gap
 * in the coverage model (weight 1.2) and goals render on the trust card.
 *
 * Proven to bite: against the previous GOAL_PATTERNS two cases fail — the
 * language block (9 of its 10 statements) and the number-splitting guard. The
 * negatives pass in BOTH directions on purpose: they are the constraint that
 * stops the next widening, not evidence for this one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectGoalTitles } from '../goalTracker.js';

test('goals stated in ordinary language are detected', () => {
  const cases = [
    ['I want to hit 10,000 active merchants by December.', 'hit 10,000 active merchants by December'],
    ['My top priority this quarter is launching the beta.', 'launching the beta'],
    ["we're aiming to close the seed round by March", 'close the seed round by March'],
    ['the goal is to cut churn in half', 'cut churn in half'],
    ['I need to ship the pricing page this week', 'ship the pricing page this week'],
    ['planning to hire two engineers', 'hire two engineers'],
    ["I'd like to get to profitability next year", 'get to profitability next year'],
    ['trying to reduce onboarding time', 'reduce onboarding time'],
    ['our objective is 10k merchants', '10k merchants'],
  ];
  for (const [msg, expected] of cases) {
    assert.deepEqual(detectGoalTitles(msg), [expected], `"${msg}"`);
  }
});

test('a number is never split by the capture terminator', () => {
  // "10,000" and "2.5x" are one token. The terminator used to break on the
  // comma, so the goal on the card read "hit 10" — worse than no goal, because
  // it looks like AQUA misunderstood rather than missed.
  assert.deepEqual(detectGoalTitles('I want to hit 10,000 merchants'), ['hit 10,000 merchants']);
  assert.deepEqual(detectGoalTitles('I want to grow revenue 2.5x this year'), ['grow revenue 2.5x this year']);
});

test('requests are NOT goals', () => {
  // The whole reason the verb allowlist existed. Replacing it with a cue-led
  // match means the exclusion has to carry the weight instead.
  for (const msg of [
    'I want to know how OAuth works',
    'I need to check the logs',
    "I'd like to see the diff",
    'we need to talk about pricing',
    'I want to understand the tradeoffs',
    "I'm trying to figure out what's wrong",
    'I want to compare the two approaches',
    'I need to review this PR',
  ]) {
    assert.deepEqual(detectGoalTitles(msg), [], `"${msg}"`);
  }
});

test('a question is never a goal, even with a goal-shaped cue', () => {
  assert.deepEqual(detectGoalTitles('can you explain how I want to do this?'), []);
});

test('an empty or contentless capture is refused', () => {
  assert.deepEqual(detectGoalTitles('I want to'), []);
  assert.deepEqual(detectGoalTitles('I want to do it'), []);
  assert.deepEqual(detectGoalTitles(''), []);
});

test('the same goal stated twice in one message yields one title', () => {
  const out = detectGoalTitles('my goal is to ship the beta. I want to ship the beta.');
  assert.equal(new Set(out).size, out.length);
});

test('detection never throws on hostile input', () => {
  for (const junk of ['', '.'.repeat(500), 'I want to ' + 'x'.repeat(400), '???']) {
    assert.ok(Array.isArray(detectGoalTitles(junk)));
  }
});
