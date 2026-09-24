import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleContext } from './assembler.js';

test('current canonical state outranks historical state for present-tense questions', () => {
  const out = assembleContext([
    { kind: 'fact', id: 'old', text: 'Project Alpha launches in November.', confidence: 0.95, sourceType: 'conversation', timestamp: Date.now(), state: 'active', validTo: '2026-09-01', semanticId: 'old' },
    { kind: 'fact', id: 'current', text: 'Project Alpha launches in December.', confidence: 0.95, sourceType: 'conversation', timestamp: Date.now(), state: 'active', validTo: null, semanticId: 'current' },
  ], {
    queryTokens: new Set(['when', 'does', 'project', 'alpha', 'launch', 'now']),
    semanticScores: new Map([['old', 0.8], ['current', 0.8]]),
    activeProjectTokens: new Set(), activeGoalTokens: new Set(), focusEntityIds: new Set(), priorEntityIds: new Set(), maxHops: 3,
  }, { limit: 1, charBudget: 1000, minScore: 0 });

  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].factId ?? out.items[0].id, 'current');
  assert.match(out.block, /lifecycle current/);
});

test('disputed canonical state is explicitly marked contested', () => {
  const out = assembleContext([
    { kind: 'fact', id: 'disputed', text: 'The launch date is uncertain.', confidence: 0.9, sourceType: 'conversation', timestamp: Date.now(), state: 'disputed', semanticId: 'disputed' },
  ], {
    queryTokens: new Set(['what', 'is', 'the', 'launch', 'date']),
    semanticScores: new Map([['disputed', 0.9]]),
    activeProjectTokens: new Set(), activeGoalTokens: new Set(), focusEntityIds: new Set(), priorEntityIds: new Set(), maxHops: 3,
  }, { limit: 1, charBudget: 1000, minScore: 0 });

  assert.match(out.block, /contested/);
});
