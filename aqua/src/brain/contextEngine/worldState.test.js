import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorldState, renderWorldState } from './worldState.js';

describe('derived World State', () => {
  test('synthesizes current projects, goals and priorities from active claims', () => {
    const state = buildWorldState([
      { id: 'a', predicate: 'works_on', object: { entity: 'Project Alpha' }, state: 'active', confidence: .9, assertedAt: '2026-09-20' },
      { id: 'b', predicate: 'has_goal', object: { literal: 'Close the funding round' }, state: 'active', confidence: .8, assertedAt: '2026-09-21' },
      { id: 'c', predicate: 'prioritizes', object: { literal: 'Production loop' }, state: 'active', confidence: .9, assertedAt: '2026-09-22' },
      { id: 'old', predicate: 'works_on', object: { entity: 'Project Old' }, state: 'superseded', confidence: .99, assertedAt: '2026-09-10' },
    ]);
    assert.deepEqual(state.currentProjects, ['Project Alpha']);
    assert.deepEqual(state.currentGoals, ['Close the funding round']);
    assert.deepEqual(state.priorities, ['Production loop']);
    assert.equal(state.claimsUsed, 3);
    assert.match(renderWorldState(state), /Current projects: Project Alpha/);
    assert.doesNotMatch(renderWorldState(state), /Project Old/);
  });

  test('does not invent state from incomplete claims', () => {
    const state = buildWorldState([
      { id: 'x', predicate: 'works_on', object: null, state: 'active', confidence: 1 },
      { id: 'y', predicate: 'works_on', object: { entity: 'Alpha' }, state: 'superseded', confidence: 1 },
    ]);
    assert.equal(state.claimsUsed, 0);
    assert.equal(renderWorldState(state), '');
  });
});
