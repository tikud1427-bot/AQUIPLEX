/**
 * P6.1 — the reasoning pass must be SKIPPED when a specialist engine will
 * replace generation (artifact turns). Pre-fix, "Create a 15-slide deck"
 * classified as planning/high → a full reasoning model call ran and was then
 * discarded by the artifact branch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerAgent, getAgent } from '../../intelligence/agentRegistry.js';
import { runIntelligencePipeline } from '../../intelligence/internalIntelligenceEngine.js';

/**
 * Count reasoning-agent invocations. The real agent registers itself on
 * import elsewhere, so patch `run` on whatever is registered (registering a
 * fresh one would throw on a duplicate name).
 */
function stubReasoningAgent() {
  let ran = 0;
  const stub = async () => { ran += 1; return { ran: true, analysis: 'deep thoughts' }; };
  const existing = getAgent('reasoning');
  if (existing) existing.run = stub;
  else registerAgent('reasoning', { name: 'reasoning', run: stub });
  return () => ran;
}

test('artifact turns skip the reasoning pass (no discarded model call)', async () => {
  const calls = stubReasoningAgent();
  const res = await runIntelligencePipeline({
    taskType: 'planning', complexity: 'high', confidence: 0.9,
    userMessage: 'Create a 15-slide Series A pitch deck. Export as PPTX.',
    requestId: 'r1', conversationId: 'c1',
    skipReasoningPass: true,
  });
  assert.equal(res.reasoningPass.ran, false);
  assert.equal(res.reasoningPass.skipped, true);
  assert.equal(calls(), 0, 'the reasoning agent must not be called at all');
  // The deterministic stages still produce their brief — they are free.
  assert.ok(res.plan);
  assert.ok(res.synthesis);
});

test('normal turns are unaffected — the pass still runs when warranted', async () => {
  const calls = stubReasoningAgent();
  const res = await runIntelligencePipeline({
    taskType: 'planning', complexity: 'high', confidence: 0.9,
    userMessage: 'Help me plan a migration strategy',
    requestId: 'r2', conversationId: 'c1',
  });
  if (res.plan.active) {
    assert.equal(res.reasoningPass.ran, true, 'non-artifact turns keep their reasoning pass');
    assert.equal(calls(), 1);
  }
});
