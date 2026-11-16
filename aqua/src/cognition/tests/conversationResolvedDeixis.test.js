/**
 * 2026-11-16 (conversation recovery): pre-generation stages that see only the
 * question must not contradict a conversation that resolved its reference.
 *   - CIE question model: a resolved deictic opener is not "ambiguous" and
 *     earns no clarification directive.
 *   - IIE reasoning pass: analyses the question as the conversation resolved it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessQuestion } from '../questionModel.js';
import { cognitivePrepare } from '../index.js';
import { registerAgent } from '../../intelligence/agentRegistry.js';
import { runIntelligencePipeline } from '../../intelligence/internalIntelligenceEngine.js';
import { buildConversationContext, resolvedQuestionFor } from '../../core/conversationContext.js';

const history = [{ role: 'user', content: 'Tell me about pneumonia.' }, { role: 'assistant', content: 'An infection of the lungs.' }];

test('unresolved deictic opener keeps the existing clarification behaviour; a resolved one does not get it', () => {
  const q = 'That one — fix it?';
  const before = assessQuestion(q, { taskType: 'conversation', confidence: 0.3 });
  assert.ok(before.ambiguity.signals.includes('deictic_opener'));
  const after = assessQuestion(q, { taskType: 'conversation', confidence: 0.3, referenceResolved: true });
  assert.ok(!after.ambiguity.signals.includes('deictic_opener'));
  assert.ok(after.ambiguity.score < before.ambiguity.score);
});

test('cognitivePrepare: no "ask ONE clarifying question" directive when the reference resolved', () => {
  const msg = 'That one — is it curable?';
  const conv = buildConversationContext({ message: msg, history });
  assert.equal(conv.reference.status, 'resolved');
  const resolved = cognitivePrepare({ userMessage: msg, taskType: 'conversation', confidence: 0.3, complexity: 'low', referenceResolved: true });
  assert.doesNotMatch(resolved.directive ?? '', /clarifying question/i);
  assert.equal(resolved.plan.expectations.clarification.recommended, false);
});

test('resolvedQuestionFor: literal when nothing resolved; annotated when resolved', () => {
  assert.equal(resolvedQuestionFor(buildConversationContext({ message: 'Explain gravity.', history })), 'Explain gravity.');
  assert.equal(resolvedQuestionFor(buildConversationContext({ message: 'Is it curable?', history })), 'Is it curable? (in this conversation, the reference means: pneumonia)');
});

test('IIE: the reasoning pass receives the resolved question; gating still reads the literal message', async () => {
  const seen = [];
  registerAgent('reasoning', { name: 'reasoning', description: 'test stub', run: async (input) => { seen.push(input.userMessage); return { ran: true, analysis: 'stub analysis' }; } });
  const conv = buildConversationContext({ message: 'Is it curable?', history });
  const r = await runIntelligencePipeline({ taskType: 'analysis', complexity: 'high', confidence: 0.9, userMessage: 'Is it curable?', reasoningMessage: resolvedQuestionFor(conv) });
  assert.equal(r.reasoningPass.ran, true);
  assert.deepEqual(seen, ['Is it curable? (in this conversation, the reference means: pneumonia)']);
});
