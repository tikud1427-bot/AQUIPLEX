/** Regression tests for Groq's normalized usage contract (E12). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage } from '../groq.js';

describe('groq normalizeUsage', () => {
  test('maps OpenAI-compatible prompt/completion token fields', () => {
    assert.deepEqual(
      normalizeUsage({ prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 }),
      { inputTokens: 123, outputTokens: 45 },
    );
  });

  test('accepts camelCase compatibility fields', () => {
    assert.deepEqual(
      normalizeUsage({ promptTokens: 12, completionTokens: 7 }),
      { inputTokens: 12, outputTokens: 7 },
    );
  });

  test('returns null when usage metadata is absent', () => {
    assert.equal(normalizeUsage(undefined), null);
    assert.equal(normalizeUsage({}), null);
  });
});