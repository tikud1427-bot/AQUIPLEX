/**
 * Phase 3 — intelligence pipeline integration (offline; reasoning agent's
 * generate injected via the registry). Proves the GATE (who gets a real model
 * call), that a real analysis reaches the injected brief, and that the
 * deterministic fallback is preserved exactly.
 * Run: node src/intelligence/tests/intelligencePipeline.test.js
 */
import assert from 'node:assert';
import { runIntelligencePipeline } from '../internalIntelligenceEngine.js';
import { synthesize } from '../synthesizer.js';
import { registerAgent, getAgent } from '../agentRegistry.js';
import '../reasoningAgent.js'; // ensure the real agent is registered first

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}
// Swap the 'reasoning' agent for a counting fake so we can assert WHETHER the
// model call happened for a given complexity/confidence, without a network.
function installFakeAgent() {
  const state = { calls: 0, lastInput: null, analysis: 'FAKE ANALYSIS: use a bounded queue; watch for backpressure.' };
  registerAgent('reasoning', {
    name: 'reasoning', description: 'test fake',
    run: async (input) => { state.calls++; state.lastInput = input; return { ran: true, analysis: state.analysis, provider: 'gemini', latencyMs: 5 }; },
  });
  return state;
}
function installFailingAgent() {
  registerAgent('reasoning', {
    name: 'reasoning', description: 'test fake (fails open)',
    run: async () => ({ ran: false, error: 'boom' }),
  });
}

console.log('pipeline — gate: WHEN does the real reasoning pass run');

await test('high complexity → real pass runs, analysis in brief', async () => {
  const st = installFakeAgent();
  const out = await runIntelligencePipeline({ taskType: 'architecture', complexity: 'high', confidence: 0.9, userMessage: 'design a cache' });
  assert.equal(st.calls, 1, 'model call made once');
  assert.equal(out.reasoningPass.ran, true);
  assert.ok(out.synthesis.text.includes('FAKE ANALYSIS'), 'real analysis folded into the injected brief');
  assert.ok(!/Work through these stages internally/.test(out.synthesis.text), 'generic template line replaced');
});

await test('low classifier confidence → real pass runs even at medium complexity', async () => {
  const st = installFakeAgent();
  const out = await runIntelligencePipeline({ taskType: 'coding', complexity: 'medium', confidence: 0.3, userMessage: 'fix this' });
  assert.equal(st.calls, 1, 'low confidence triggers the pass');
  assert.equal(out.reasoningPass.ran, true);
});

await test('medium complexity + confident → NO model call (deterministic brief)', async () => {
  const st = installFakeAgent();
  const out = await runIntelligencePipeline({ taskType: 'coding', complexity: 'medium', confidence: 0.9, userMessage: 'write a helper' });
  assert.equal(st.calls, 0, 'medium/confident stays deterministic — no added latency');
  assert.equal(out.reasoningPass.ran, false);
  assert.ok(/Work through these stages internally/.test(out.synthesis.text), 'deterministic template brief used');
});

await test('low complexity → pipeline inactive, no model call', async () => {
  const st = installFakeAgent();
  const out = await runIntelligencePipeline({ taskType: 'conversation', complexity: 'low', confidence: 0.9, userMessage: 'hi' });
  assert.equal(st.calls, 0, 'casual chat never pays for reasoning');
  assert.equal(out.synthesis.active, false);
});

console.log('pipeline — fail-open');
await test('reasoning pass fails → deterministic brief, pipeline still succeeds', async () => {
  installFailingAgent();
  const out = await runIntelligencePipeline({ taskType: 'architecture', complexity: 'high', confidence: 0.9, userMessage: 'design a cache' });
  assert.equal(out.reasoningPass.ran, false);
  assert.equal(out.synthesis.active, true, 'brief still produced');
  assert.ok(/Work through these stages internally/.test(out.synthesis.text), 'fell back to deterministic template');
});

console.log('synthesizer — unit (analysis fold vs template)');
const activePlan = { active: true, pipeline: [{ name: 'A', focus: 'x' }, { name: 'B', focus: 'y' }], taskType: 'coding' };
const activeReasoning = { active: true, strategy: 'coding', directive: 'reason like a coder', checklist: ['c1', 'c2'] };

test('synthesize with analysis injects it + marks reasoningPassRan', () => {
  const s = synthesize({ plan: activePlan, reasoning: activeReasoning, critic: { active: false }, taskType: 'coding', analysis: 'REAL ANALYSIS' });
  assert.ok(s.text.includes('REAL ANALYSIS'));
  assert.equal(s.raw.reasoningPassRan, true);
  assert.ok(!s.text.includes('Work through these stages internally'));
});
await test('synthesize without analysis is byte-identical to pre-Phase-3 template', () => {
  const s = synthesize({ plan: activePlan, reasoning: activeReasoning, critic: { active: false }, taskType: 'coding' });
  assert.ok(s.text.includes('Work through these stages internally before answering: A → B.'));
  assert.ok(s.text.includes('Keep in mind: c1; c2.'));
  assert.equal(s.raw.reasoningPassRan, false);
});
await test('synthesize inactive when plan inactive', () => {
  const s = synthesize({ plan: { active: false, pipeline: [] }, reasoning: { active: false }, critic: {}, taskType: 'conversation' });
  assert.equal(s.active, false);
  assert.equal(s.text, '');
});

// Restore the REAL reasoning agent so later suites in a shared run aren't affected.
import('../reasoningAgent.js');

console.log(`\nintelligencePipeline: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
