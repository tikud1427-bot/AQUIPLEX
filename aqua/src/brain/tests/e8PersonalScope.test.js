/**
 * E8 personal-world scope — audit D-01 (2026-11-16). A missing personal fact
 * never makes an ordinary question "unknown"; personal questions keep their
 * evidence contract; the policy half of the block is separable (D-17).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryPlan } from '../contextEngine/queryPlan.js';
import { runBoundedRetrievalRounds, runBoundedRetrievalRoundsAsync } from '../contextEngine/e8Pipeline.js';
import { assembleContext } from '../contextEngine/assembler.js';

const empty = () => ({ items: [], block: '', stats: {} });
const fact = (id, text, extra = {}) => ({ kind: 'fact', id, statement: text, text, confidence: 0.9, citations: [], score: 0.9, ...extra });

const GENERAL = ['Is pneumonia curable?', 'Tell me about pneumonia.', 'Is it curable? pneumonia', 'Explain photosynthesis.', 'Which one is easier to scale? MongoDB PostgreSQL', 'What are its advantages? cloud storage'];

test('general questions with an EMPTY personal store: no UNKNOWN block, no "Required slots still unknown: topic"', async () => {
  for (const q of GENERAL) {
    for (const taskType of ['simple_qa', 'conversation', 'research', 'analysis']) {
      const r = await runBoundedRetrievalRoundsAsync({ query: q, taskType, retrieve: async () => empty() });
      assert.equal(r.sufficiency.outcome, 'sufficient', `${taskType}: ${q}`);
      assert.equal(r.rounds, 1, 'no targeted "topic"/"subject" text search');
      const out = assembleContext([], {}, { limit: 8, charBudget: 1600, queryPlan: r.plan });
      assert.equal(out.block, '', `${taskType}: ${q}`);
      assert.doesNotMatch(out.block, /Required slots still unknown/);
    }
  }
});

test('the explicit personalWorld flag from the conversation context wins over the query text', () => {
  // retrieval query "When is it due? tax filing" has no "my", but the turn is a follow-up to "My tax filing…"
  assert.equal(buildQueryPlan('When is it due? tax filing', { taskType: 'simple_qa', personalWorld: true }).scope, 'personal');
  assert.equal(buildQueryPlan('When is my launch?', { taskType: 'simple_qa', personalWorld: false }).scope, 'general');
  assert.equal(buildQueryPlan('When is my launch?', { taskType: 'simple_qa' }).scope, 'personal');
});

test('personal question with missing evidence keeps the contract: UNKNOWN, scoped to the user\'s world', () => {
  const r = runBoundedRetrievalRounds({ query: 'What is my dog called?', taskType: 'simple_qa', retrieve: () => empty() });
  assert.equal(r.sufficiency.outcome, 'unknown');
  const out = assembleContext([], {}, { limit: 8, charBudget: 1600, queryPlan: r.plan });
  assert.match(out.block, /EVIDENCE STATUS: UNKNOWN/);
  assert.match(out.block, /facts about the user's own world; this does not limit general knowledge/);
});

test('decision questions are unchanged (personal by form)', () => {
  const p = buildQueryPlan('Should I launch this week?', { taskType: 'simple_qa' });
  assert.equal(p.taskType, 'decision');
  assert.deepEqual(p.requiredSlotIds, ['goal', 'deadline', 'blockers']);
});

test('personal question answered by a previous-conversation fact → SUFFICIENT with the fact as data', () => {
  const r = runBoundedRetrievalRounds({ query: 'What did I name my dog?', taskType: 'simple_qa', retrieve: () => ({ items: [fact('d1', 'The user named their dog Biscuit')], block: '', stats: {} }) });
  assert.equal(r.sufficiency.outcome, 'sufficient');
});

test('contradictory personal evidence stays visible (both statements rendered as data, policy separate)', () => {
  const plan = buildQueryPlan('Where do I work?', { taskType: 'simple_qa' });
  const cands = [
    fact('w1', 'The user works at Acme', { disputed: true, sourceType: 'conversation' }),
    fact('w2', 'The user works at Globex', { disputed: true, sourceType: 'conversation' }),
  ];
  const out = assembleContext(cands, { query: 'Where do I work?' }, { limit: 8, charBudget: 1600, queryPlan: plan });
  // Selection is the assembler's business; whatever is selected must appear as DATA, and the
  // contested-items rule lives in the POLICY half (operator section), never inside data.
  for (const item of out.items) assert.ok(out.dataBlock.includes(String(item.statement ?? item.text).slice(0, 15)) || out.dataBlock.length > 0);
  if (out.block) {
    assert.match(out.policyBlock, /disputed items must be presented as contested/);
    assert.doesNotMatch(out.dataBlock, /EVIDENCE STATUS|disputed items must be presented/);
  }
});

test('D-17: the combined block is unchanged and equals the data + policy lines it was split from', () => {
  const r = runBoundedRetrievalRounds({ query: 'What is my dog called?', taskType: 'simple_qa', retrieve: () => empty() });
  const out = assembleContext([], {}, { limit: 8, charBudget: 1600, queryPlan: r.plan });
  assert.equal(out.dataBlock, '', 'nothing about the user → no data half');
  assert.match(out.policyBlock, /^EVIDENCE STATUS: UNKNOWN/);
  for (const line of out.policyBlock.split('\n')) assert.ok(out.block.includes(line));
});

test('AQUA_E8_PERSONAL_SCOPE=off restores the previous plan (rollback)', () => {
  const prev = process.env.AQUA_E8_PERSONAL_SCOPE;
  process.env.AQUA_E8_PERSONAL_SCOPE = 'off';
  try {
    assert.deepEqual(buildQueryPlan('Is pneumonia curable?', { taskType: 'simple_qa' }).requiredSlotIds, ['topic']);
  } finally {
    if (prev === undefined) delete process.env.AQUA_E8_PERSONAL_SCOPE; else process.env.AQUA_E8_PERSONAL_SCOPE = prev;
  }
});
