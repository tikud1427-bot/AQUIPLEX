/**
 * Reasoning scaffold kept out of the reply (2026-11-05).
 *
 * Two prompt lines combined into a template the model copied into its answers
 * (Cloudflare Mistral run: q04, q05, q11 on HEAD answered under "**Understand** /
 * **Approach** / **Check** / **Final**" headings):
 *   reasoningStrategy stepwise  "…step-by-step… Show the key reasoning…"
 *   synthesizer                 "Work through these stages internally before
 *                               answering: Understand → Approach → Check → Final."
 * Both keep their wording (reasoning is still asked for) and gain one sentence:
 * the stages are for thinking, not the reply's structure. Structure the content
 * itself needs stays allowed. AQUA_ANSWER_SCAFFOLD_GUARD=off restores the
 * previous text byte for byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getReasoningStrategy, scaffoldGuardEnabled } from '../../core/reasoningStrategy.js';
import { synthesize } from '../synthesizer.js';

const OLD_STEPWISE = 'Work through this step-by-step before giving your final answer. Show the key reasoning, not just the conclusion.';
const OLD_REFLECTIVE = 'Draft your initial approach, briefly check it for gaps or errors, then give a refined final answer. Keep the check concise.';
const plan = { active: true, pipeline: [{ name: 'Understand' }, { name: 'Approach' }, { name: 'Check' }, { name: 'Final' }] };
const reasoning = { active: true, directive: 'Reason analytically.', checklist: ['Identify what is being evaluated'] };
const withFlag = (v, fn) => { const was = process.env.AQUA_ANSWER_SCAFFOLD_GUARD; if (v == null) delete process.env.AQUA_ANSWER_SCAFFOLD_GUARD; else process.env.AQUA_ANSWER_SCAFFOLD_GUARD = v; try { return fn(); } finally { if (was == null) delete process.env.AQUA_ANSWER_SCAFFOLD_GUARD; else process.env.AQUA_ANSWER_SCAFFOLD_GUARD = was; } };

test('on by default', () => withFlag(null, () => assert.equal(scaffoldGuardEnabled(), true)));

test('stepwise still asks for the key reasoning, and not as labelled stages', () => withFlag(null, () => {
  const d = getReasoningStrategy('analysis', 'medium').directive;
  assert.ok(d.startsWith(OLD_STEPWISE.replace(/\.$/, '')), 'the reasoning request is kept');
  assert.match(d, /not as a template of labelled stages/);
  assert.match(d, /structure the content itself needs/, 'genuinely useful structure stays allowed');
}));

test('reflective and direct are unchanged', () => withFlag(null, () => {
  assert.equal(getReasoningStrategy('analysis', 'high').directive, OLD_REFLECTIVE);
  assert.equal(getReasoningStrategy('casual', 'low').directive, '');
}));

test('the stage line keeps its sentence and says the stages are not the reply', () => withFlag(null, () => {
  const s = synthesize({ plan, reasoning, critic: null, taskType: 'simple_qa' }).text;
  assert.ok(s.includes('Work through these stages internally before answering: Understand → Approach → Check → Final.'));
  assert.match(s, /These stages are for your own thinking — do not use their names as headings, numbered steps or sections in the reply\./);
}));

test('a real analysis replaces the stage line as before (no guard needed there)', () => withFlag(null, () => {
  const s = synthesize({ plan, reasoning, critic: null, taskType: 'simple_qa', analysis: 'The user moved jobs.' }).text;
  assert.ok(!s.includes('Work through these stages internally'));
  assert.ok(!s.includes('These stages are for your own thinking'));
}));

test('AQUA_ANSWER_SCAFFOLD_GUARD=off restores the previous text byte for byte', () => withFlag('off', () => {
  assert.equal(scaffoldGuardEnabled(), false);
  assert.equal(getReasoningStrategy('analysis', 'medium').directive, OLD_STEPWISE);
  const s = synthesize({ plan, reasoning, critic: null, taskType: 'simple_qa' }).text;
  assert.equal(s, ['[Internal Reasoning Brief]', 'Task: simple_qa. Reason analytically.',
    'Work through these stages internally before answering: Understand → Approach → Check → Final.',
    'Keep in mind: Identify what is being evaluated.'].join('\n'));
}));
