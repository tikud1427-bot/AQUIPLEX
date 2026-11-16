/**
 * Conversation-aware review — audit D-02 (2026-11-16). Reviewers see the
 * conversation; they may correct an answer but not withdraw one they cannot
 * fault; a failed / invalid reviewer never destroys a valid draft.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVerification } from '../verificationAgent.js';
import { runDebate } from '../debateAgent.js';
import { buildConversationContext } from '../../core/conversationContext.js';
import { verificationStatus } from '../../orchestrator/verificationStrategy.js';
import { parseRevisionReason, withdrawalReason, classifyRevision } from '../evidenceContext.js';

const history = [
  { role: 'user', content: 'Is pneumonia curable?' },
  { role: 'assistant', content: 'Yes, many cases can be treated successfully, depending on the cause and severity.' },
  { role: 'user', content: 'Tell me about pneumonia.' },
  { role: 'assistant', content: 'Pneumonia is an infection that inflames the air sacs in one or both lungs.' },
];
const conv = buildConversationContext({ message: 'Is it curable?', history, conversationId: 'c', ownerId: 'user:t' });
const DRAFT = 'Yes — pneumonia is usually curable. Bacterial pneumonia is treated with antibiotics, and most healthy people recover within weeks.';
const CLARIFY = "I'm not sure which condition you're asking about. Could you specify what \"it\" refers to?";
const ok = (text, extra = {}) => ({ text, provider: 'stub', truncated: false, ...extra });

test('the verifier receives the conversation and the resolved reference', async () => {
  const seen = [];
  const r = await runVerification({
    userMessage: 'Is it curable?', draftAnswer: DRAFT, taskType: 'simple_qa', conversationContext: conv,
    generate: async (_u, system, msgs) => { seen.push({ system, user: msgs[0].content }); return ok('VERIFICATION_PASSED — the draft was checked against the listed risks and no material issues were found; returning it unchanged.'); },
  });
  assert.equal(r.passed, true);
  assert.equal(r.outcome, 'ACCEPT');
  assert.equal(r.conversationAware, true);
  assert.match(seen[0].user, /Conversation so far in this chat/);
  assert.match(seen[0].user, /User: Tell me about pneumonia\./);
  assert.match(seen[0].user, /points to "pneumonia"/);
  assert.match(seen[0].user, /Latest user message:\nIs it curable\?/);
  assert.match(seen[0].system, /A reference in the latest message .* that the conversation resolves is grounded/);
});

test('a clarification replacing an answered draft is SUPPRESSED when the reference resolved (draft kept)', async () => {
  const r = await runVerification({ userMessage: 'Is it curable?', draftAnswer: DRAFT, taskType: 'simple_qa', conversationContext: conv, generate: async () => ok(CLARIFY) });
  assert.equal(r.finalAnswer, DRAFT);
  assert.equal(r.revised, false);
  assert.equal(r.suppressedWithdrawals, 1);
  assert.equal(r.outcome, 'CLARIFY');
  assert.equal(r.applied, false);
  assert.equal(verificationStatus(r, { warranted: true }), 'incomplete');
});

test('"no information in the provided context" replacing an answer is SUPPRESSED', async () => {
  const r = await runVerification({ userMessage: 'Is pneumonia curable?', draftAnswer: DRAFT, taskType: 'simple_qa', generate: async () => ok("I don't have any information about pneumonia or its curability in the provided context.") });
  assert.equal(r.finalAnswer, DRAFT);
  assert.equal(r.outcome, 'INSUFFICIENT_EVIDENCE');
});

test('a clarification IS allowed when the reference is genuinely ambiguous', () => {
  const amb = buildConversationContext({ message: 'Is it better?', history: [{ role: 'user', content: 'Compare MongoDB and PostgreSQL.' }] });
  assert.equal(amb.reference.status, 'ambiguous');
  assert.equal(withdrawalReason('MongoDB is better for…', 'Which one do you mean — MongoDB or PostgreSQL?', amb), null);
  assert.equal(withdrawalReason('MongoDB is better for…', 'Which one do you mean — MongoDB or PostgreSQL?', conv), 'unsupported_clarification');
});

test('a genuine correction still applies; its stated reason is recorded and never shipped to the user', async () => {
  const fixed = 'Yes — most pneumonia is curable; viral pneumonia is usually managed with supportive care rather than antibiotics.';
  const r = await runVerification({ userMessage: 'Is it curable?', draftAnswer: DRAFT, taskType: 'simple_qa', conversationContext: conv, generate: async () => ok(`REVISION_REASON: antibiotics do not treat viral pneumonia\n\n${fixed}`) });
  assert.equal(r.finalAnswer, fixed);
  assert.equal(r.revised, true);
  assert.equal(r.revisionReason, 'antibiotics do not treat viral pneumonia');
  assert.doesNotMatch(r.finalAnswer, /REVISION_REASON/);
  assert.equal(r.outcome, 'REVISE');
});

test('reviewer failure / timeout / malformed output never destroys the draft', async () => {
  const thrown = await runVerification({ userMessage: 'q', draftAnswer: DRAFT, taskType: 'simple_qa', conversationContext: conv, generate: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } });
  assert.equal(thrown.finalAnswer, DRAFT);
  assert.equal(verificationStatus(thrown, { warranted: true }), 'failed');
  const blank = await runVerification({ userMessage: 'q', draftAnswer: DRAFT, taskType: 'simple_qa', generate: async () => ok('   ') });
  assert.equal(blank.finalAnswer, DRAFT);
  const cut = await runVerification({ userMessage: 'q', draftAnswer: DRAFT, taskType: 'simple_qa', generate: async () => ok('Partial…', { truncated: true }) });
  assert.equal(cut.finalAnswer, DRAFT);
});

test('strict reason mode (AQUA_REVIEW_REQUIRE_REASON=on): a replacement without a reason is discarded', async () => {
  process.env.AQUA_REVIEW_REQUIRE_REASON = 'on';
  try {
    const r = await runVerification({ userMessage: 'q', draftAnswer: DRAFT, taskType: 'simple_qa', generate: async () => ok('A different answer entirely, with no reason given for the change at all.') });
    assert.equal(r.finalAnswer, DRAFT);
    assert.equal(r.revised, false);
  } finally { delete process.env.AQUA_REVIEW_REQUIRE_REASON; }
});

test('debate: panel and revision see the conversation; a clarification revision is suppressed', async () => {
  const calls = [];
  const r = await runDebate({
    userMessage: 'Is it curable?', draftAnswer: DRAFT, taskType: 'simple_qa', maxPasses: 1, conversationContext: conv,
    generate: async (_u, system, msgs) => {
      calls.push(msgs[0].content);
      if (/internal review panel/.test(system)) {
        return ok(JSON.stringify({ findings: [
          { persona: 'skeptic', verdict: 'issue', severity: 'high', issue: 'unclear referent', suggestion: 'ask' },
          { persona: 'analyst', verdict: 'issue', severity: 'high', issue: 'unclear referent', suggestion: 'ask' },
          { persona: 'architect', verdict: 'issue', severity: 'high', issue: 'unclear referent', suggestion: 'ask' },
        ] }));
      }
      return ok(CLARIFY);
    },
  });
  assert.ok(calls.length >= 1);
  assert.ok(calls.every(c => /Conversation so far in this chat/.test(c)), 'every reviewer call carries the conversation');
  assert.equal(r.finalAnswer, DRAFT);
  assert.equal(r.revised, false);
  assert.equal(r.suppressedWithdrawals, 1, 'suppressed by the withdrawal guard, not by a fail-open');
  assert.equal(r.outcome, 'CLARIFY');
  assert.equal(calls.length, 2, 'panel + revision both ran');
});

test('helpers: reason parsing tolerates markdown; classification vocabulary', () => {
  assert.deepEqual(parseRevisionReason('**REVISION_REASON:** wrong date\n\nThe answer.'), { reason: 'wrong date', text: 'The answer.' });
  assert.deepEqual(parseRevisionReason('Just an answer.'), { reason: null, text: 'Just an answer.' });
  assert.equal(classifyRevision(CLARIFY), 'CLARIFY');
  assert.equal(classifyRevision('A corrected answer.'), 'REVISE');
});
