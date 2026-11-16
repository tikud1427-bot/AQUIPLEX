/**
 * Cost-aware review depth (2026-11-12) — classifier → orchestrator → reviewDepth.
 *
 * Pins the model-call budget the review policy grants, using the REAL classifier
 * and orchestrator (both pure: no stores, no providers). "Extra calls" below are
 * the pre-answer reasoning pass plus the reviewer passes, at their worst case:
 * single critic = 1 call (1 pass), debate panel = up to 4 (2 panel + 2 revision).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-review-depth-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';

const { classifyTask } = await import('../../core/classifier.js');
const { orchestrate } = await import('../toolOrchestrator.js');
const { reviewDepth, costAwareReviewEnabled, SHORT_FALLBACK_CHARS } = await import('../verificationStrategy.js');
const { createExecutionPlan } = await import('../../core/executionPlanner.js');

/** Worst-case extra model calls for one turn, mirroring chat.js runVerification + the reasoning gate. */
function extraCalls(message, env = {}) {
  const c = classifyTask(message);
  const o = orchestrate({ userMessage: message, taskType: c.task, confidence: c.confidence, hasWorkspaceId: false });
  const plan = createExecutionPlan(c.task, c.confidence);
  const d = reviewDepth({ complexity: plan.complexity, confidence: c.confidence, tags: o.multiLabel?.tags ?? [], userMessage: message, env });
  const verifying = o.verification.enabled;
  const review = verifying ? (d.deepReview ? 4 : 1) : 0;
  const reasoning = plan.complexity !== 'low' && d.reasoningPass ? 1 : 0;
  return { task: c.task, confidence: c.confidence, verifying, deep: d.deepReview, extra: review + reasoning };
}

const SIMPLE = ['Who wrote Hamlet?', 'What time zone is Tokyo in?', 'What is 17 times 23?', 'Where does Ana work?', 'When is my launch deadline?', 'What am I working on right now?'];
const DECISIONS = ['Should I hire another developer?', 'Should I take the job offer from Northbeam or stay?'];

test('short decision questions keep ONE reasoning pass but no review panel (2 calls, was 6)', () => {
  for (const m of DECISIONS) {
    const r = extraCalls(m);
    assert.ok(r.confidence < 0.5, `precondition: "${m}" hits the fallback`);
    assert.equal(r.verifying, false, `"${m}" not verified`);
    assert.equal(r.deep, false, `"${m}" no debate`);
    assert.equal(r.extra, 1, `"${m}" keeps the reasoning pass`);
  }
});

test('the policy never adds a call the previous policy did not make', () => {
  const all = [...SIMPLE, ...DECISIONS, 'hi', 'Who is on my team?', 'Design the architecture for a multi-tenant SaaS billing system with audit logs',
    'Is it safe to take ibuprofen with my blood pressure medication?', 'What did we decide about the pricing page?', 'Should we launch this week?'];
  for (const m of all) {
    const after = extraCalls(m).extra;
    process.env.AQUA_COST_AWARE_REVIEW = 'off';
    let before;
    try { before = extraCalls(m, { AQUA_COST_AWARE_REVIEW: 'off' }).extra; } finally { delete process.env.AQUA_COST_AWARE_REVIEW; }
    assert.ok(after <= before, `"${m}": after ${after} > before ${before}`);
  }
});

test('the flag is ON unless "off" (any case)', () => {
  assert.equal(costAwareReviewEnabled({}), true);
  assert.equal(costAwareReviewEnabled({ AQUA_COST_AWARE_REVIEW: 'on' }), true);
  assert.equal(costAwareReviewEnabled({ AQUA_COST_AWARE_REVIEW: 'OFF' }), false);
  assert.equal(costAwareReviewEnabled({ AQUA_COST_AWARE_REVIEW: 'off' }), false);
});

test('short simple questions that match no pattern cost ONE model call (no reasoning pass, no review)', () => {
  for (const m of SIMPLE) {
    const r = extraCalls(m);
    assert.ok(r.confidence < 0.5, `precondition: "${m}" still hits the classifier fallback (${r.confidence})`);
    assert.equal(r.verifying, false, `"${m}" should not be verified`);
    assert.equal(r.extra, 0, `"${m}" extra calls`);
  }
});

test('the previous policy (=off) spent up to 5 extra calls on each of them — the measured waste', () => {
  for (const m of SIMPLE) {
    process.env.AQUA_COST_AWARE_REVIEW = 'off';
    try {
      const r = extraCalls(m, { AQUA_COST_AWARE_REVIEW: 'off' });
      assert.equal(r.verifying, true);
      assert.equal(r.deep, true);
      assert.equal(r.extra, 5, `"${m}"`);
    } finally { delete process.env.AQUA_COST_AWARE_REVIEW; }
  }
});

test('greetings stay minimal', () => {
  for (const m of ['hi', 'thanks!']) assert.equal(extraCalls(m).extra, 0);
});

test('high-risk and high-complexity turns keep their review exactly', () => {
  const medical = extraCalls('Is it safe to take ibuprofen with my blood pressure medication?');
  assert.equal(medical.verifying, true);
  assert.equal(medical.deep, true, 'sensitive + low confidence still seats the debate panel');

  const arch = extraCalls('Design the architecture for a multi-tenant SaaS billing system with audit logs');
  assert.equal(arch.verifying, true);
  assert.equal(arch.deep, true);
});

test('a long message that matches no pattern keeps its review (the research fallback)', () => {
  const long = 'I have been thinking a lot lately about the various options in front of me and honestly I cannot quite decide which way to go with all of it';
  assert.ok(long.length >= SHORT_FALLBACK_CHARS);
  const d = reviewDepth({ complexity: 'medium', confidence: 0.45, tags: [], userMessage: long });
  assert.equal(d.lowConfidence, true);
  assert.equal(d.deepReview, true);
});

test('confident turns are unaffected by the policy', () => {
  for (const env of [{}, { AQUA_COST_AWARE_REVIEW: 'off' }]) {
    const d = reviewDepth({ complexity: 'medium', confidence: 0.9, tags: [], userMessage: 'hello', env });
    assert.deepEqual([d.lowConfidence, d.deepReview, d.reasoningPass], [false, false, false]);
  }
});
