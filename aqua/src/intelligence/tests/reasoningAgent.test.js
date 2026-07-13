/**
 * Phase 3 — reasoningAgent unit tests (offline; generate injected).
 * Run: node src/intelligence/tests/reasoningAgent.test.js
 */
import assert from 'node:assert';
import { runReasoningPass } from '../reasoningAgent.js';
import { getAgent } from '../agentRegistry.js';
import { createPlan } from '../planner.js';
import { runReasoning } from '../reasoningEngine.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

// A fake generate() with the router's return shape. Records what it was called
// with so we can assert the elicitation prompt + budget are correct.
function fakeGenerate(analysisText, capture = {}) {
  return async (userMessage, systemPrompt, messages, ctx, taskType, plan, budget) => {
    capture.systemPrompt = systemPrompt;
    capture.messages = messages;
    capture.taskType = taskType;
    capture.budget = budget;
    capture.ctxRequestId = ctx?.requestId;
    return { text: analysisText, provider: 'gemini', fallbackChain: [{ provider: 'gemini', outcome: 'success' }] };
  };
}

const plan = createPlan({ taskType: 'architecture', complexity: 'high', confidence: 0.9 });
const reasoning = runReasoning(plan, 'design a rate limiter');

console.log('reasoningAgent — registration');
await test("registers itself as the 'reasoning' agent on import", () => {
  const a = getAgent('reasoning');
  assert.ok(a, 'reasoning agent registered');
  assert.equal(typeof a.run, 'function');
});

console.log('reasoningAgent — happy path');
await test('returns ran:true with the analysis text', async () => {
  const cap = {};
  const out = await runReasoningPass({
    userMessage: 'design a distributed rate limiter',
    plan, reasoning, taskType: 'architecture', requestId: 'r1',
    generate: fakeGenerate('Assumptions: per-user limits. Crux: token bucket vs sliding window. Risks: clock skew.', cap),
  });
  assert.equal(out.ran, true);
  assert.ok(out.analysis.includes('token bucket'));
  assert.equal(out.provider, 'gemini');
  assert.ok(typeof out.latencyMs === 'number');
});
await test('elicitation prompt includes the real pipeline stages + forbids answering', async () => {
  const cap = {};
  await runReasoningPass({
    userMessage: 'x', plan, reasoning, taskType: 'architecture', generate: fakeGenerate('ok', cap),
  });
  assert.ok(/Requirements/.test(cap.systemPrompt), 'includes a real stage name from the architecture pipeline');
  assert.ok(/Do NOT answer it/i.test(cap.systemPrompt), 'instructs not to write the final answer');
  assert.ok(cap.messages[0].content.includes('User request'), 'user message passed as the request');
});
await test('uses the real taskType for provider ranking', async () => {
  const cap = {};
  await runReasoningPass({ userMessage: 'x', plan, reasoning, taskType: 'architecture', generate: fakeGenerate('ok', cap) });
  assert.equal(cap.taskType, 'architecture');
});
await test('passes a bounded thinking budget (not unbounded)', async () => {
  const cap = {};
  await runReasoningPass({ userMessage: 'x', plan, reasoning, taskType: 'coding', generate: fakeGenerate('ok', cap) });
  assert.ok(cap.budget?.maxResponseTokens && cap.budget.maxResponseTokens <= 1024);
});
await test('uses an isolated scratch context (-reason suffix)', async () => {
  const cap = {};
  await runReasoningPass({ userMessage: 'x', plan, reasoning, taskType: 'coding', requestId: 'abc', generate: fakeGenerate('ok', cap) });
  assert.equal(cap.ctxRequestId, 'abc-reason', 'main turn diagnostics stay isolated');
});

console.log('reasoningAgent — fail-open');
await test('empty analysis → ran:false (no crash)', async () => {
  const out = await runReasoningPass({
    userMessage: 'x', plan, reasoning, taskType: 'coding',
    generate: async () => ({ text: '   ', provider: 'gemini' }),
  });
  assert.equal(out.ran, false);
  assert.equal(out.error, 'empty_analysis');
});
await test('generate throws → ran:false, error captured, no throw', async () => {
  const out = await runReasoningPass({
    userMessage: 'x', plan, reasoning, taskType: 'coding',
    generate: async () => { throw new Error('all providers exhausted'); },
  });
  assert.equal(out.ran, false);
  assert.ok(out.error.includes('exhausted'));
});

console.log(`\nreasoningAgent: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
