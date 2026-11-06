/**
 * Mind goal state — safety properties (2026-11-06).
 *
 * laterWords.test.js pins how the user's later words move a goal (resolution,
 * ending, change, a new date). This file pins what must NOT happen:
 *   · a speculative, hedged or conditional statement completes nothing;
 *   · a completion stores the user's words intact (a broken whitespace regex
 *     stripped every "s": "I fini hed the ceramic  cour e!");
 *   · a completed or abandoned goal is history, not an active goal, and keeps
 *     its title and history;
 *   · one owner's Mind never sees another's goals;
 *   · goals stored before achievedBy / changedBy / review existed still render.
 * Synthetic sentences only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-goal-safety-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
delete process.env.AQUA_MIND_RELEVANCE;

const { createEmptyMind, GOAL_STATUS } = await import('../mindSchema.js');
const { trackGoals, getActiveGoals } = await import('../goalTracker.js');
const { observeTurn } = await import('../observers.js');
const { updateWorkingMemory } = await import('../workingMemory.js');
const { retrieveCognitiveContext } = await import('../mindRetriever.js');

const say = (m, t) => { const { hints } = observeTurn({ userMessage: t, taskType: 'conversation', extractedFacts: [] }); trackGoals(m, { userMessage: t }); updateWorkingMemory(m, { userMessage: t, taskType: 'conversation', hints }); };
const only = m => Object.values(m.goals)[0];
const withGoal = (goal, owner = 'user:goal-safety') => { const m = createEmptyMind(owner); say(m, goal); return m; };

describe('speculation completes nothing', () => {
  const CASES = [
    ['My goal is to run a half marathon this year.', ['Maybe I will finally run the half marathon next spring.', 'I might have finished the half marathon if my knee holds.',
      'Hopefully I finish the half marathon in October.', 'I could run the half marathon in April.']],
    ['My goal is to pass the CFA Level 1 exam.', ['I think I probably passed the CFA exam, not sure yet.', 'I should pass the CFA exam next time.', 'If I pass the CFA exam I will celebrate.']],
    ['My goal is to renew my driving licence before March.', ['The new driving licence might arrive next week.']],
  ];
  for (const [goal, hedges] of CASES) for (const h of hedges) {
    test(`"${h}" leaves "${goal}" active`, () => {
      const m = withGoal(goal);
      say(m, h);
      assert.equal(only(m).status, GOAL_STATUS.ACTIVE);
      assert.equal(only(m).achievedBy, undefined);
    });
  }
  test('controls: stated achievements do complete', () => {
    for (const [goal, done] of [['My goal is to run a half marathon this year.', 'I finally ran the half marathon!'], ['My goal is to pass the CFA Level 1 exam.', 'I passed the CFA exam today.'],
      ['My goal is to renew my driving licence before March.', 'The new driving licence arrived.']]) {
      const m = withGoal(goal); say(m, done);
      assert.equal(only(m).status, GOAL_STATUS.COMPLETED, done);
    }
  });
});

describe('the user\'s words are stored intact', () => {
  for (const [goal, done] of [['My goal is to finish the ceramics course this year.', 'I finished the ceramics course!'], ['Our goal is to ship the mobile app by spring.', 'We shipped the mobile app yesterday.']]) {
    test(`achievedBy keeps "${done}" verbatim`, () => {
      const m = withGoal(goal); trackGoals(m, { userMessage: done });
      assert.equal(only(m).status, GOAL_STATUS.COMPLETED);
      assert.equal(only(m).achievedBy?.text, done);
    });
  }
});

describe('current versus historical goals', () => {
  test('a completed goal is history: not active, not in the cognitive block, title and history kept', () => {
    const m = withGoal('My goal is to pass the CFA Level 1 exam.');
    say(m, 'My goal is to learn Spanish this year.');
    say(m, 'I passed the CFA exam today.');
    const cfa = Object.values(m.goals).find(g => /CFA/.test(g.title));
    assert.equal(cfa.status, GOAL_STATUS.COMPLETED);
    assert.match(cfa.title, /pass the CFA Level 1 exam/);
    assert.ok(cfa.history.length >= 1);
    assert.deepEqual(getActiveGoals(m, 8).map(g => g.title).filter(t => /CFA/.test(t)), []);
    const block = retrieveCognitiveContext(m, { query: 'What should I focus on?' }).block;
    assert.doesNotMatch(block, /CFA/);
    assert.match(block, /learn Spanish/);
  });
  test('an abandoned goal is history too', () => {
    const m = withGoal('My goal is to run a marathon this year.');
    say(m, 'I gave up on the marathon this year.');
    assert.equal(only(m).status, GOAL_STATUS.ABANDONED);
    assert.doesNotMatch(retrieveCognitiveContext(m, { query: 'What should I focus on?' }).block, /marathon/);
  });
});

test('one owner\'s Mind never sees another\'s goals', () => {
  const a = withGoal('My goal is to learn Spanish this year.', 'user:a');
  const b = withGoal('My goal is to run a half marathon this year.', 'user:b');
  say(b, 'I finally ran the half marathon!');
  assert.equal(only(a).status, GOAL_STATUS.ACTIVE);
  assert.doesNotMatch(retrieveCognitiveContext(a, { query: 'What should I focus on?' }).block, /marathon/);
});

test('goals stored before achievedBy / changedBy / review existed still render', () => {
  const m = withGoal('My goal is to learn Spanish this year.');
  const g = only(m);
  for (const k of ['achievedBy', 'changedBy', 'review']) delete g[k];
  assert.match(retrieveCognitiveContext(m, { query: 'What should I focus on?' }).block, /learn Spanish/);
});
