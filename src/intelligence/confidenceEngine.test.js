/**
AQUA Confidence Engine + Verification Convergence Loop — Regression Tests

Two halves of the same Phase 12 / Phase 4 increment:

  confidenceEngine.js  — per-response confidence: bands, monotonicity,
                         factor completeness, graceful defaults
  verificationAgent.js — bounded convergence loop: default single-pass
                         behavior is byte-identical, multi-pass converges /
                         caps / fails open mid-loop without losing an
                         accepted revision

Same injection pattern as verificationAgent.test.js: never touches
providers/router.js.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessConfidence, isGroundingExpected, CONFIDENCE_BANDS } from './confidenceEngine.js';
import { runVerification } from './verificationAgent.js';
import { shouldVerify, LOW_CONFIDENCE_THRESHOLD } from '../orchestrator/verificationStrategy.js';

const PASS_SENTINEL =
  'VERIFICATION_PASSED — the draft was checked against the listed risks and no material issues were found; returning it unchanged.';

/** Sequenced fake: each call consumes the next scripted response (string or Error). */
function fakeGenerateSeq(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (userMessage, systemPrompt, messages, ctx, preTaskType, executionPlan, responseBudget) => {
    calls.push({ userMessage, systemPrompt, messages, preTaskType, responseBudget });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { text: next, provider: 'mock-provider' };
  };
  fn.calls = calls;
  return fn;
}

// ═══ Confidence Engine ═══════════════════════════════════════════════════════

test('clean turn scores high: first-try provider, grounded, verified clean', () => {
  const r = assessConfidence({
    classifierConfidence: 0.9,
    factsInjected: 3,
    attemptCount: 1,
    verification: { ran: true, passed: true, revised: false },
  });
  assert.equal(r.band, 'high');
  assert.ok(r.score >= CONFIDENCE_BANDS.high);
});

test('degraded turn scores low: shaky classification, ungrounded on grounding-hungry task, deep fallback, verifier failed open', () => {
  const r = assessConfidence({
    classifierConfidence: 0.3,
    factsInjected: 0,
    projectFilesUsed: 0,
    groundingExpected: true,
    attemptCount: 4,
    truncated: true,
    verification: { ran: false, error: 'all providers exhausted' },
  });
  assert.equal(r.band, 'low');
});

test('monotonic: every worsened signal can only lower the score', () => {
  const base = {
    classifierConfidence: 0.8,
    factsInjected: 2,
    attemptCount: 1,
    verification: { ran: true, passed: true, revised: false },
  };
  const baseline = assessConfidence(base).score;
  assert.ok(assessConfidence({ ...base, classifierConfidence: 0.2 }).score < baseline);
  assert.ok(assessConfidence({ ...base, attemptCount: 3 }).score < baseline);
  assert.ok(assessConfidence({ ...base, truncated: true }).score < baseline);
  assert.ok(assessConfidence({ ...base, verification: { ran: false, error: 'x' } }).score < baseline);
});

test('verification evidence ordering: clean-pass > revised-then-passed > revised-unchecked > failed-open', () => {
  const at = (verification) => assessConfidence({ classifierConfidence: 0.8, factsInjected: 1, verification }).score;
  const clean     = at({ ran: true, passed: true,  revised: false });
  const fixed     = at({ ran: true, passed: true,  revised: true  });
  const unchecked = at({ ran: true, passed: false, revised: true  });
  const failed    = at({ ran: false, error: 'boom' });
  assert.ok(clean > fixed && fixed > unchecked && unchecked > failed,
    `expected ${clean} > ${fixed} > ${unchecked} > ${failed}`);
});

test('graceful defaults: no signals at all still returns a well-formed medium assessment', () => {
  const r = assessConfidence();
  assert.ok(r.score > 0 && r.score < 1);
  assert.equal(r.band, 'medium');
  assert.deepEqual(r.factors.map(f => f.id), ['classification', 'grounding', 'generation', 'verification']);
  for (const f of r.factors) assert.ok(f.value >= 0 && f.value <= 1 && f.weight > 0);
});

test('weights sum to 1 so score stays in [0,1] by construction', () => {
  const r = assessConfidence();
  const total = r.factors.reduce((s, f) => s + f.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('grounding expectation lookup covers retrieval-hungry task types only', () => {
  assert.equal(isGroundingExpected('project_query'), true);
  assert.equal(isGroundingExpected('research'), true);
  assert.equal(isGroundingExpected('casual_chat'), false);
});

// ═══ Verification Strategy — low-confidence trigger ══════════════════════════

test('low classifier confidence alone now warrants verification', () => {
  const d = shouldVerify({ taskType: 'analysis', complexity: 'medium', tags: [], userMessage: 'short', confidence: 0.3 });
  assert.equal(d.enabled, true);
  assert.ok(d.reasons.includes('low classification confidence'));
});

test('confidence at/above threshold adds no reason; omitting it entirely preserves the original decision surface', () => {
  const withHigh = shouldVerify({ taskType: 'analysis', complexity: 'medium', tags: [], userMessage: 'short', confidence: LOW_CONFIDENCE_THRESHOLD });
  const without  = shouldVerify({ taskType: 'analysis', complexity: 'medium', tags: [], userMessage: 'short' });
  assert.equal(withHigh.enabled, false);
  assert.equal(without.enabled, false);
  assert.deepEqual(withHigh.reasons, without.reasons);
});

// ═══ Verification Convergence Loop ═══════════════════════════════════════════

test('default maxPasses=1: revision returned without re-critique — original single-pass behavior', async () => {
  const generate = fakeGenerateSeq(['Corrected answer.']);
  const r = await runVerification({
    userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', generate,
  });
  assert.equal(r.passes, 1);
  assert.equal(generate.calls.length, 1);
  assert.equal(r.revised, true);
  assert.equal(r.passed, false);
  assert.equal(r.converged, false);
  assert.equal(r.finalAnswer, 'Corrected answer.');
});

test('maxPasses=2: revision is re-critiqued; clean second pass converges on the revision', async () => {
  const generate = fakeGenerateSeq(['Corrected answer.', PASS_SENTINEL]);
  const r = await runVerification({
    userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 2, generate,
  });
  assert.equal(r.passes, 2);
  assert.equal(r.revised, true);
  assert.equal(r.passed, true);
  assert.equal(r.converged, true);
  assert.equal(r.finalAnswer, 'Corrected answer.');
  // Second critique must review the REVISION, not the original draft.
  assert.match(generate.calls[1].messages[0].content, /Corrected answer\./);
  assert.doesNotMatch(generate.calls[1].messages[0].content, /\bdraft\b/);
});

test('maxPasses=2: immediate clean pass stops the loop after one call', async () => {
  const generate = fakeGenerateSeq([PASS_SENTINEL, new Error('must never be called')]);
  const r = await runVerification({
    userMessage: 'q', draftAnswer: 'draft', taskType: 'architecture', maxPasses: 2, generate,
  });
  assert.equal(r.passes, 1);
  assert.equal(generate.calls.length, 1);
  assert.equal(r.converged, true);
  assert.equal(r.finalAnswer, 'draft');
});

test('iteration cap: still revising at maxPasses ships the latest revision, converged=false', async () => {
  const generate = fakeGenerateSeq(['rev one.', 'rev two.']);
  const r = await runVerification({
    userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 2, generate,
  });
  assert.equal(r.passes, 2);
  assert.equal(r.revised, true);
  assert.equal(r.converged, false);
  assert.equal(r.finalAnswer, 'rev two.');
});

test('fail-open mid-loop: error on pass 2 ships the pass-1 revision, never the stale draft, ran=true', async () => {
  const generate = fakeGenerateSeq(['rev one.', new Error('provider exhausted')]);
  const r = await runVerification({
    userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 2, generate,
  });
  assert.equal(r.ran, true);          // one full pass DID complete
  assert.equal(r.passes, 1);
  assert.equal(r.revised, true);
  assert.equal(r.converged, false);
  assert.equal(r.finalAnswer, 'rev one.');
  assert.match(r.error, /provider exhausted/);
});

test('fail-open on the very first pass keeps the legacy shape: ran=false, draft untouched', async () => {
  const generate = fakeGenerateSeq([new Error('boom')]);
  const r = await runVerification({
    userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 2, generate,
  });
  assert.equal(r.ran, false);
  assert.equal(r.passed, null);
  assert.equal(r.revised, false);
  assert.equal(r.finalAnswer, 'draft');
});
