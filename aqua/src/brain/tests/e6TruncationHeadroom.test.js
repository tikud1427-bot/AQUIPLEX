/**
 * P0 2026-10-12 — a truncated extraction must not silently starve the World
 * Model. Driving the real product, the role-change turn "My biggest client is
 * now Juniper Hotel; Fennel stopped ordering." failed E6 on every retry with
 * "Groq returned empty truncated response" (gpt-oss-120b spent the 1024 budget
 * on hidden reasoning). No canonical claim was written, Fennel stayed current,
 * and after a restart Aqua answered "Fennel".
 *
 * The measured 1024 call shape is pinned elsewhere (e6TurnPath / e6ProviderSelection);
 * this pins that only a TRUNCATED call gets one retry with headroom.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTruncationHeadroom } from '../index.js';

const recorder = (...results) => {
  const budgets = [];
  let i = 0;
  const generate = async (_s, _m, _x, budget) => {
    budgets.push(budget);
    const r = results[Math.min(i++, results.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { generate, budgets };
};

test('a call that completes within budget is ONE call at the measured budget (unchanged shape)', async () => {
  const { generate, budgets } = recorder({ text: '{"claims":[]}', truncated: false });
  const res = await withTruncationHeadroom(generate, { maxTokens: 1024, headroomTokens: 4096 })('s', [], {});
  assert.equal(res.text, '{"claims":[]}');
  assert.deepEqual(budgets, [1024]);
});

test('empty truncated response (the production failure) → one retry with headroom, which lands', async () => {
  const { generate, budgets } = recorder(new Error('Groq returned empty truncated response'), { text: '{"claims":[{"predicate":"related_to"}]}' });
  const res = await withTruncationHeadroom(generate, { maxTokens: 1024, headroomTokens: 4096 })('s', [], {});
  assert.match(res.text, /related_to/);
  assert.deepEqual(budgets, [1024, 4096]);
});

test('partial truncated JSON → one retry with headroom', async () => {
  const { generate, budgets } = recorder({ text: '{"claims":[{"pred', truncated: true }, { text: '{"claims":[]}', truncated: false });
  const res = await withTruncationHeadroom(generate, { maxTokens: 1024, headroomTokens: 4096 })('s', [], {});
  assert.equal(res.text, '{"claims":[]}');
  assert.deepEqual(budgets, [1024, 4096]);
});

test('non-truncation errors are not retried here (the job queue owns retries)', async () => {
  const { generate, budgets } = recorder(new Error('429 rate limited'));
  await assert.rejects(withTruncationHeadroom(generate, { maxTokens: 1024, headroomTokens: 4096 })('s', [], {}), /429/);
  assert.deepEqual(budgets, [1024]);
});

test('no headroom configured above the budget (gemini/nvidia already large) → no retry', async () => {
  const { generate, budgets } = recorder(new Error('empty truncated response'));
  await assert.rejects(withTruncationHeadroom(generate, { maxTokens: 8192, headroomTokens: 8192 })('s', [], {}));
  assert.deepEqual(budgets, [8192]);
});
