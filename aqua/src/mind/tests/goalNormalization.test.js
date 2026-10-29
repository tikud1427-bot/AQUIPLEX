/**
 * Goals as separate, correctly-scoped objects (2026-10-28).
 *
 * Two defects behind the Understanding page showing one long merged goal and
 * goals completing on their own:
 *
 *   1. detectGoalTitles used `text.match` (first match per pattern) and
 *      captured through "and", so "I want to launch the beta and hire a
 *      designer" was ONE goal and a second "I want to …" sentence was dropped.
 *   2. A status cue with no matching goal fell back to "the most recently
 *      mentioned active goal": "I finished lunch" completed it, and so did
 *      "I haven't shipped it yet".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectGoalTitles, trackGoals } from '../goalTracker.js';
import { createEmptyMind } from '../mindSchema.js';

const freshMind = () => createEmptyMind('goal-norm-test');
const titlesOf = mind => Object.values(mind.goals).map(g => g.title);
const goalNamed = (mind, re) => Object.values(mind.goals).find(g => re.test(g.title));

test('separate goals in one sentence become separate goals', () => {
  assert.deepEqual(detectGoalTitles('I want to launch the beta and hire a designer'), ['launch the beta', 'hire a designer']);
  assert.deepEqual(detectGoalTitles('My goal is to become a billionaire and build a company people love.'),
    ['become a billionaire', 'build a company people love']);
});

test('a comma list of goals yields each item', () => {
  assert.deepEqual(
    detectGoalTitles('I want to launch the beta, hire a designer, and raise a seed round.'),
    ['launch the beta', 'hire a designer', 'raise a seed round'],
  );
});

test('goals in separate sentences are all detected', () => {
  assert.deepEqual(
    detectGoalTitles('I want to launch the beta. I also want to learn Spanish this year.'),
    ['launch the beta', 'learn Spanish this year'],
  );
});

test('ONE goal with coordinated verbs or objects is not split', () => {
  // A wrong split invents two half-goals — worse than a merged one.
  assert.deepEqual(detectGoalTitles('I want to build and ship the app'), ['build and ship the app']);
  assert.deepEqual(detectGoalTitles('I want to hire a designer and an engineer'), ['hire a designer and an engineer']);
  assert.deepEqual(detectGoalTitles('I need to ship the pricing page and the docs this week'), ['ship the pricing page and the docs this week']);
  // A clause after a comma that is not another goal stays out.
  assert.deepEqual(detectGoalTitles('I want to ship it, but the tests are failing'), ['ship it']);
  assert.deepEqual(detectGoalTitles('I want to launch the beta, the deadline is Friday'), ['launch the beta']);
});

test('goal objects carry the split titles, deduplicated across restatement', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'I want to launch the beta and hire a designer.' });
  trackGoals(mind, { userMessage: 'Still planning to launch the beta.' });
  assert.deepEqual(titlesOf(mind).sort(), ['hire a designer', 'launch the beta']);
  assert.equal(goalNamed(mind, /beta/).mentions, 2);
  assert.equal(goalNamed(mind, /designer/).mentions, 1);
});

test('schema-extracted goal facts are split the same way', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: '', extractedFacts: [{ key: 'goal', value: 'launch the beta and raise a seed round' }] });
  assert.deepEqual(titlesOf(mind).sort(), ['launch the beta', 'raise a seed round']);
});

test('a completion cue about something else never completes a goal', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'My goal is to become a billionaire.' });
  trackGoals(mind, { userMessage: 'I finished lunch, now back to work.' });
  trackGoals(mind, { userMessage: 'We shipped a hotfix for the login page.' });
  assert.equal(goalNamed(mind, /billionaire/).status, 'active');
});

test('negated, hedged or conditional cues are not status changes', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'We plan to launch the billing migration this month.' });
  for (const msg of [
    "We haven't launched the billing migration yet.",
    'The billing migration is not finished.',
    'Once we have launched the billing migration we can raise prices.',
    'The billing migration is almost done.',
  ]) {
    trackGoals(mind, { userMessage: msg });
    assert.equal(goalNamed(mind, /billing/).status, 'active', msg);
  }
  trackGoals(mind, { userMessage: 'Finally launched the billing migration!' });
  assert.equal(goalNamed(mind, /billing/).status, 'completed');
  assert.equal(goalNamed(mind, /billing/).history.at(-1).reason, 'completion cue');
});

test('a completion cue reaches the goal it names, not the most recent one', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'I want to launch the beta.' });
  trackGoals(mind, { userMessage: 'I also want to hire a designer.' });
  trackGoals(mind, { userMessage: 'We launched the beta yesterday!' });
  assert.equal(goalNamed(mind, /beta/).status, 'completed');
  assert.equal(goalNamed(mind, /designer/).status, 'active');
});

test('a blocked cue names its goal too', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'I want to launch the beta.' });
  trackGoals(mind, { userMessage: 'I want to hire a designer.' });
  trackGoals(mind, { userMessage: "I'm stuck on the visa paperwork." });
  assert.ok(Object.values(mind.goals).every(g => g.status === 'active'));
  trackGoals(mind, { userMessage: 'Hiring the designer is blocked on budget approval.' });
  assert.equal(goalNamed(mind, /designer/).status, 'blocked');
  assert.equal(goalNamed(mind, /beta/).status, 'active');
});
