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

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 0 (audit F1/F2/F5) — grounding contract + capability-deletion guard.
// THE regression suite for the video-overwrite bug: a grounded multimodal
// draft must survive verification even when the verifier model malfunctions
// and proposes "I cannot watch videos" as the replacement.
// ═══════════════════════════════════════════════════════════════════════════════

const VIDEO_EVIDENCE = [
  '── UPLOADED FILE ANALYSES ──',
  'UPLOADED ATTACHMENTS (available in this conversation — answer questions about them directly):',
  '── Video (transcription + analysis below): demo.mp4 ──',
  'SUMMARY: A person in a red jacket enters the conference room and places a backpack on the table.',
  'SCENES: 0:00 door opens; 0:05 person enters; 0:12 backpack placed.',
].join('\n');

const GROUNDED_DRAFT =
  'In the video, a person wearing a red jacket enters the conference room and places a backpack on the table at 0:12.';

test('GROUNDING CONTRACT: evidence context reaches both the system prompt and the critique input', async () => {
  const generate = fakeGenerate('VERIFICATION_PASSED — the draft was checked against the listed risks and no material issues were found; returning it unchanged.');

  await runVerification({
    userMessage: 'What happens in this video?',
    draftAnswer: GROUNDED_DRAFT,
    taskType:    'analysis',
    evidenceContext: VIDEO_EVIDENCE,
    generate,
  });

  const call = generate.calls[0];
  // Reviewer instructions acknowledge grounding + forbid capability deletion.
  assert.match(call.systemPrompt, /evidence context/i);
  assert.match(call.systemPrompt, /NOT hallucinations/);
  assert.match(call.systemPrompt, /NEVER replace the draft/i);
  // The reviewer sees the drafter's actual evidence.
  assert.match(call.messages[0].content, /red jacket enters the conference room/);
  assert.match(call.messages[0].content, /Evidence context available to the drafter/);
  // And still sees question + draft.
  assert.match(call.messages[0].content, /What happens in this video\?/);
  assert.match(call.messages[0].content, /places a backpack on the table at 0:12/);
});

test('ungrounded turns are byte-compatible: no evidence clause, no evidence block', async () => {
  const generate = fakeGenerate('VERIFICATION_PASSED — the draft was checked against the listed risks and no material issues were found; returning it unchanged.');

  const result = await runVerification({
    userMessage: 'Design an auth system',
    draftAnswer: 'Draft.',
    taskType:    'architecture',
    generate,                          // no evidenceContext
  });

  const call = generate.calls[0];
  assert.doesNotMatch(call.systemPrompt, /evidence context/i);
  assert.doesNotMatch(call.messages[0].content, /Evidence context available/);
  assert.equal(result.grounded, false);
  assert.equal(result.suppressedRefusals, 0);
});

test('REGRESSION (the overwrite bug): capability-refusal revision on a grounded turn is SUPPRESSED — grounded draft survives verbatim', async () => {
  const generate = fakeGenerate(
    "I cannot watch videos. As an AI language model, I don't have the ability to view video content. Please describe the video instead."
  );

  const result = await runVerification({
    userMessage: 'What happens in this video?',
    draftAnswer: GROUNDED_DRAFT,
    taskType:    'analysis',
    evidenceContext: VIDEO_EVIDENCE,
    maxPasses: 2,
    generate,
  });

  assert.equal(result.finalAnswer, GROUNDED_DRAFT, 'the correct grounded answer must survive');
  assert.equal(result.revised, false, 'a suppressed malfunction is NOT a revision (ledger stays clean)');
  assert.equal(result.suppressedRefusals, 1);
  assert.equal(result.grounded, true);
  assert.equal(generate.calls.length, 1, 'reviser forfeits remaining passes after a guard hit');
});

test('guard is grounded-only: on an UNGROUNDED turn a refusal-shaped revision is still adopted (verifier may know better)', async () => {
  const refusal = "I don't have access to the uploaded files, so I cannot answer this.";
  const generate = fakeGenerate(refusal);

  const result = await runVerification({
    userMessage: 'What does the attachment say?',
    draftAnswer: 'The attachment says X.',   // draft hallucinated an attachment that was never uploaded
    taskType:    'analysis',
    generate,                                 // no evidence → guard must NOT fire
  });

  assert.equal(result.revised, true);
  assert.equal(result.finalAnswer, refusal);
  assert.equal(result.suppressedRefusals, 0);
});

test('legitimate factual revision on a grounded turn still goes through (guard is surgical, not a revision blocker)', async () => {
  const corrected = 'In the video, the person wearing a red jacket places the backpack on the table at 0:12, not 0:20 as the draft claimed.';
  const generate = fakeGenerate(corrected);

  const result = await runVerification({
    userMessage: 'When is the backpack placed?',
    draftAnswer: 'The backpack is placed at 0:20.',
    taskType:    'analysis',
    evidenceContext: VIDEO_EVIDENCE,
    generate,
  });

  assert.equal(result.revised, true);
  assert.equal(result.finalAnswer, corrected);
  assert.equal(result.suppressedRefusals, 0);
});