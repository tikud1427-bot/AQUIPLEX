import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectProfile } from '../executionProfiles.js';

// Issue 3's suggested minimums:
//   Conversation: 512–1024   Simple QA: 1024–2048
//   Coding / Architecture / Debugging / Research / Project Analysis: 4096+
describe('executionProfiles.js — Issue 3: adaptive response budgets', () => {
  test('conversation stays within the 512-1024 band', () => {
    const b = selectProfile('conversation').budget.maxResponseTokens;
    assert.ok(b >= 512 && b <= 1024, `conversation budget ${b} should be within 512-1024`);
  });

  test('simple_qa stays within the 1024-2048 band', () => {
    const b = selectProfile('simple_qa').budget.maxResponseTokens;
    assert.ok(b >= 1024 && b <= 2048, `simple_qa budget ${b} should be within 1024-2048`);
  });

  for (const taskType of ['coding', 'architecture', 'debugging', 'research', 'project_query']) {
    test(`${taskType} meets the 4096+ floor`, () => {
      const b = selectProfile(taskType).budget.maxResponseTokens;
      assert.ok(b >= 4096, `${taskType} budget ${b} should be >= 4096`);
    });
  }

  test('Simple Question keeps a smaller response budget than Architecture (pre-existing ordering invariant)', () => {
    const simple = selectProfile('conversation').budget.maxResponseTokens;
    const arch   = selectProfile('architecture').budget.maxResponseTokens;
    assert.ok(simple < arch);
  });

  test('an unrecognized taskType falls back to general_reasoning without throwing', () => {
    assert.doesNotThrow(() => selectProfile('not_a_real_task_type'));
    const b = selectProfile('not_a_real_task_type').budget.maxResponseTokens;
    assert.ok(Number.isFinite(b) && b > 0);
  });

  test('every profile budget has positive, finite prompt/response/context ceilings', () => {
    for (const taskType of [
      'conversation', 'simple_qa', 'coding', 'debugging', 'architecture',
      'research', 'project_query', 'planning', 'creative_writing', 'opinion',
      'memory_recall', 'memory_update', 'personal_info',
    ]) {
      const budget = selectProfile(taskType).budget;
      for (const field of ['maxPromptTokens', 'maxResponseTokens', 'maxContextTokens']) {
        assert.ok(Number.isFinite(budget[field]) && budget[field] > 0, `${taskType}.${field} should be a positive number`);
      }
    }
  });
});
