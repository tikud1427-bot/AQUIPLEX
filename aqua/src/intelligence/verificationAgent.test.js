/**
AQUA Verification Agent — Regression Tests

Covers: self-registration into agentRegistry.js, the pass/revise decision
based on the model's response, fail-open behavior on a verifier error, and
that the critique call is built from the real per-taskType risk rubric
(critic.js's getFocusRisks — single source of truth, not a second copy).

The real generateText() makes network calls to live providers, so every
test here injects a fake `generate` function via runVerification()'s
`generate` param instead of touching providers/router.js.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVerification } from './verificationAgent.js';
import { getAgent } from './agentRegistry.js';
import { getFocusRisks } from './critic.js';

function fakeGenerate(response) {
  const calls = [];
  const fn = async (userMessage, systemPrompt, messages, ctx, preTaskType, executionPlan, responseBudget) => {
    calls.push({ userMessage, systemPrompt, messages, preTaskType, executionPlan, responseBudget });
    if (response instanceof Error) throw response;
    return { text: response, provider: 'mock-provider' };
  };
  fn.calls = calls;
  return fn;
}

// ── Self-registration ───────────────────────────────────────────────────────

test('importing the module registers a verification agent with a run() function', () => {
  const agent = getAgent('verification');
  assert.equal(agent.name, 'verification');
  assert.equal(typeof agent.run, 'function');
});

// ── Pass path ────────────────────────────────────────────────────────────────

test('draft passes through unchanged when the verifier reports no issues', async () => {
  const generate = fakeGenerate(
    'VERIFICATION_PASSED — the draft was checked against the listed risks and no material issues were found; returning it unchanged.'
  );

  const result = await runVerification({
    userMessage: 'Design an auth system',
    draftAnswer: 'Here is the original draft answer.',
    taskType:    'architecture',
    requestId:   'req-1',
    conversationId: 'conv-1',
    generate,
  });

  assert.equal(result.ran, true);
  assert.equal(result.passed, true);
  assert.equal(result.revised, false);
  assert.equal(result.finalAnswer, 'Here is the original draft answer.');
});

// ── Revision path ────────────────────────────────────────────────────────────

test('draft is replaced when the verifier finds a genuine issue', async () => {
  const corrected = 'Corrected answer: the original draft missed a required validation step.';
  const generate = fakeGenerate(corrected);

  const result = await runVerification({
    userMessage: 'Write a login endpoint',
    draftAnswer: 'Original draft with a missing check.',
    taskType:    'coding',
    generate,
  });

  assert.equal(result.ran, true);
  assert.equal(result.passed, false);
  assert.equal(result.revised, true);
  assert.equal(result.finalAnswer, corrected);
});

// ── Fail-open behavior ────────────────────────────────────────────────────────

test('a verifier error fails open: original draft is returned unchanged, not thrown', async () => {
  const generate = fakeGenerate(new Error('All providers exhausted'));

  const result = await runVerification({
    userMessage: 'Design a payment flow',
    draftAnswer: 'Original draft answer.',
    taskType:    'architecture',
    generate,
  });

  assert.equal(result.ran, false);
  assert.equal(result.revised, false);
  assert.equal(result.finalAnswer, 'Original draft answer.');
  assert.match(result.error, /All providers exhausted/);
});

// ── Rubric sourcing (no duplicate risk list) ──────────────────────────────────

test('focusRisks comes from critic.js getFocusRisks — same rubric, not a second copy', async () => {
  const generate = fakeGenerate('VERIFICATION_PASSED — the draft was checked against the listed risks and no material issues were found; returning it unchanged.');

  const result = await runVerification({
    userMessage: 'Fix this bug',
    draftAnswer: 'Draft.',
    taskType:    'coding',
    generate,
  });

  assert.deepEqual(result.focusRisks, getFocusRisks('coding'));
});

test('critique prompt includes the full risk list and both the question and draft', async () => {
  const generate = fakeGenerate('VERIFICATION_PASSED — the draft was checked against the listed risks and no material issues were found; returning it unchanged.');

  await runVerification({
    userMessage: 'UNIQUE_QUESTION_MARKER',
    draftAnswer: 'UNIQUE_DRAFT_MARKER',
    taskType:    'coding',
    generate,
  });

  const [call] = generate.calls;
  for (const risk of getFocusRisks('coding')) {
    assert.ok(call.systemPrompt.includes(risk), `expected system prompt to mention risk: ${risk}`);
  }
  assert.ok(call.messages[0].content.includes('UNIQUE_QUESTION_MARKER'));
  assert.ok(call.messages[0].content.includes('UNIQUE_DRAFT_MARKER'));
  assert.equal(call.preTaskType, 'coding');
});
