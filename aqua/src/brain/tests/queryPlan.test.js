import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryPlan, fillQueryPlan, assessSufficiency, withRound, matchCandidateToSlot } from '../contextEngine/queryPlan.js';

describe('E8 Context Engine V3 query plan', () => {
  test('decision questions get the canonical answer scaffold', () => {
    const p = buildQueryPlan('Should I launch this week?', { taskType: 'decision' });
    assert.deepEqual(p.requiredSlotIds, ['goal', 'deadline', 'blockers']);
    assert.equal(p.slots.find(s => s.id === 'constraints').required, false);
  });

  test('candidate matching is typed and never invents a slot from prose', () => {
    const p = buildQueryPlan('Should I launch this week?', { taskType: 'decision' });
    const blockers = p.slots.find(s => s.id === 'blockers');
    assert.equal(matchCandidateToSlot({ kind: 'blocker', text: 'CI is red' }, blockers), true);
    assert.equal(matchCandidateToSlot({ kind: 'fact', text: 'CI is red' }, blockers), false);
  });

  test('missing required slots request one bounded second round, then become honest unknowns', () => {
    let p = buildQueryPlan('Should I launch this week?', { taskType: 'decision' });
    p = fillQueryPlan(p, [{ kind: 'goal', text: 'launch beta' }]);
    let s = assessSufficiency(p);
    assert.equal(s.outcome, 'needs_round_two');
    p = withRound(p, 2);
    s = assessSufficiency(p);
    assert.equal(s.outcome, 'unknown');
    assert.deepEqual(s.missing, ['deadline', 'blockers']);
  });

  test('filled required slots are sufficient without asking a needless question', () => {
    let p = buildQueryPlan('Should I launch this week?', { taskType: 'decision' });
    p = fillQueryPlan(p, [
      { kind: 'goal', text: 'launch beta' },
      { kind: 'time', text: 'Friday' },
      { kind: 'blocker', text: 'none known' },
    ]);
    assert.equal(assessSufficiency(p).outcome, 'sufficient');
  });
});
