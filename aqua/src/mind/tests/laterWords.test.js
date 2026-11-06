/**
 * The Mind's working state follows the user's later words (2026-11-02).
 *
 * The cognitive-model block rides EVERY legacy-read turn as the user's
 * "Current state", "Active goals" and "Anticipated need". Before: a blocker the
 * user resolved, a deadline they moved, a goal they completed or changed all
 * stayed there (8 of 36 dev users), and every "deadline" named no date (79 of
 * 79: "launch on November", "before 6", "before deciding"). Each positive has
 * a control that must NOT change.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-mind-later-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';

const { createEmptyMind, GOAL_STATUS } = await import('../mindSchema.js');
const { updateWorkingMemory } = await import('../workingMemory.js');
const { trackGoals } = await import('../goalTracker.js');
const { observeTurn } = await import('../observers.js');
const { rebuildPredictions } = await import('../predictionEngine.js');
const { retrieveCognitiveContext } = await import('../mindRetriever.js');
const { updateGraph } = await import('../relationshipGraph.js');
const { recallGraphPaths } = await import('../graphRecall.js');

/** One user turn through the per-turn Mind writers, in mindObserve's order. */
function say(mind, userMessage) {
  const { hints } = observeTurn({ userMessage, taskType: 'conversation', extractedFacts: [] });
  const goalsTouched = trackGoals(mind, { userMessage });
  updateWorkingMemory(mind, { userMessage, taskType: 'conversation', hints });
  updateGraph(mind, { extractedFacts: [], hints, goalsTouched });
  rebuildPredictions(mind);
}
const block = (mind, query = 'what should I focus on?') => retrieveCognitiveContext(mind, { query }).block;
const fresh = () => createEmptyMind('later-words');

describe('blockers', () => {
  test('a resolution in the user\'s words retires the blocker, and keeps it in history', () => {
    const m = fresh();
    say(m, "The launch is blocked waiting on Apple's review.");
    assert.match(block(m), /blocked on: Apple's review/, 'control');
    say(m, 'Apple approved the app this morning.');
    assert.doesNotMatch(block(m), /blocked on|needs unblocking/);
    assert.equal(m.working.resolvedBlockers.length, 1);
    assert.match(m.working.resolvedBlockers[0].resolvedBy, /Apple approved/);
  });

  test('a negated or hedged resolution changes nothing', () => {
    const m = fresh();
    say(m, "The launch is blocked waiting on Apple's review.");
    say(m, "Apple hasn't approved it yet.");
    say(m, 'Once Apple approves it we can launch.');
    assert.match(block(m), /blocked on: Apple's review/);
  });

  test('"still no word" keeps an open blocker open', () => {
    const m = fresh();
    say(m, 'I am waiting on a business license renewal from the city.');
    const before = m.working.blockers[0].lastSeenAt;
    const realNow = Date.now; Date.now = () => realNow() + 60_000;
    try { say(m, 'Still no word from the city on the license renewal.'); } finally { Date.now = realNow; }
    assert.equal(m.working.blockers.length, 1);
    assert.ok(m.working.blockers[0].lastSeenAt > before);
  });

  test('an unrelated resolution does not retire a blocker', () => {
    const m = fresh();
    say(m, 'We are stuck on the zoning permit.');
    say(m, 'The flour delivery arrived.');
    assert.match(block(m), /blocked on: the zoning permit/);
  });
});

describe('deadlines', () => {
  test('the whole date, in the user\'s clause; clock times and look-alike words are not deadlines', () => {
    const labels = t => observeTurn({ userMessage: t, taskType: 'conversation', extractedFacts: [] }).hints.deadlines.map(d => d.label);
    assert.deepEqual(labels('Splitpay is supposed to launch on November 18.'), ['Splitpay is supposed to launch on November 18']);
    assert.deepEqual(labels('My dissertation proposal is due on February 14.'), ['My dissertation proposal is due on February 14']);
    assert.deepEqual(labels("I don't want any study plan that involves early mornings before 6 am."), []);
    assert.deepEqual(labels("I'm waiting to hear from EPFL before deciding."), []);
    assert.deepEqual(labels('I want to finish before marathon season.'), []);
  });

  test('a moved and then corrected deadline: the newest word is current, the old ones are history', () => {
    const m = fresh();
    say(m, 'Splitpay is supposed to launch on November 18.');
    say(m, "Because of that, Splitpay's launch moved to December 9.");
    say(m, 'Actually, correction: the launch is December 16, not December 9.');
    assert.match(block(m), /deadline: the launch is December 16, not December 9/);
    assert.doesNotMatch(block(m), /November 18/);
    assert.equal(m.working.pastDeadlines.length, 2);
  });

  test('a change about something else leaves the deadline alone', () => {
    const m = fresh();
    say(m, 'Splitpay is supposed to launch on November 18.');
    say(m, 'Our team dinner moved to December 2.');
    assert.match(block(m), /launch on November 18/);
  });
});

describe('goals', () => {
  test('a resolution completes the goal it is about', () => {
    const m = fresh();
    say(m, 'I need to renew my driving licence before it expires in March.');
    assert.match(block(m), /renew my driving licence/, 'control');
    say(m, 'The new driving licence arrived in the post.');
    assert.doesNotMatch(block(m), /renew my driving licence/);
    assert.equal(Object.values(m.goals)[0].status, GOAL_STATUS.COMPLETED);
  });

  test('"hasn\'t arrived yet" completes nothing; an ending abandons rather than completes', () => {
    const m = fresh();
    say(m, 'I need to renew my driving licence before it expires in March.');
    say(m, "The new driving licence hasn't arrived yet.");
    assert.equal(Object.values(m.goals)[0].status, GOAL_STATUS.ACTIVE);
    say(m, 'I gave up on the driving licence renewal for now.');
    assert.equal(Object.values(m.goals)[0].status, GOAL_STATUS.ABANDONED);
  });

  test('a changed goal keeps its title and carries the user\'s words; restating it clears them', () => {
    const m = fresh();
    say(m, 'My goal this year is to run a marathon.');
    say(m, 'My knee is bad, so I changed my goal: a half marathon instead of a full one.');
    assert.match(block(m), /"run a marathon" \(since changed — they said: "My knee is bad/);
    assert.doesNotMatch(block(m), /Likely working toward: run a marathon/, 'no forecast from an outdated plan');
    say(m, 'My goal this year is to run a marathon.');
    assert.doesNotMatch(block(m), /since changed/);
  });

  test('several changes in one message: each is read on its own clause', () => {
    const m = fresh();
    say(m, 'We plan to ship the first batch on March 3.');
    say(m, "Shipping slips to April 20, and Boxwell is out — we're using Freightly now.");
    const g = Object.values(m.goals)[0];
    assert.equal(g.status, GOAL_STATUS.ACTIVE, '"Boxwell is out" ends Boxwell, not the shipping');
    assert.match(g.changedBy.text, /April 20/);
  });

  test('a message sharing one short word with a goal touches nothing', () => {
    const m = fresh();
    say(m, 'We plan to launch the Lumen app on May 6.');
    say(m, 'Apple approved the app this morning.');
    const g = Object.values(m.goals)[0];
    assert.equal(g.status, GOAL_STATUS.ACTIVE);
    assert.equal(g.changedBy, undefined);
  });

  test('a completed goal is not walked in the relationship graph; its edge is kept', () => {
    const m = fresh();
    say(m, 'I need to renew my driving licence before it expires in March.');
    assert.ok(recallGraphPaths(m, 'driving licence').length, 'control');
    say(m, 'The new driving licence arrived in the post.');
    assert.equal(recallGraphPaths(m, 'driving licence').length, 0);
    assert.ok(Object.values(m.graph.edges).some(e => e.type === 'targets'), 'history kept');
  });
});

describe('open questions', () => {
  test('recorded as the user\'s clause, not a cut fragment', () => {
    const m = fresh();
    say(m, 'Now the blocker is that Acacia wants a board seat and I\'m not sure about that.');
    assert.match(block(m), /open question: Now the blocker is that Acacia wants a board seat/);
    assert.doesNotMatch(block(m), /open question: hat/);
  });
});
