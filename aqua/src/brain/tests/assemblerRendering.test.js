/**
 * What the model actually reads, for canonical claims (live Postgres,
 * 2026-10-04 World-Model Lift run):
 *   · raw evidence rows reached the prompt as "[[object Object]]";
 *   · one sentence that yielded two claims was rendered twice, costing a
 *     different fact its seat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, tokensOf } from '../contextEngine/assembler.js';

const ctx = q => ({
  queryTokens: tokensOf(q), semanticScores: null, activeProjectTokens: new Set(), activeGoalTokens: new Set(),
  focusEntityIds: new Set(), priorEntityIds: new Set(), maxHops: 3,
});
const cand = (id, text, extra = {}) => ({
  id, kind: 'fact', text, confidence: 0.66, entityIds: [`e-${id}`], via: 'structured:', source: 'canonical', ...extra,
});

test('a raw evidence row renders as provenance, never "[object Object]"', () => {
  const evidence = { evidence_id: 'ev1', quote: 'I run product at Ledgerly', role: 'primary',
    extracted_at: '2026-10-04T09:00:00Z', locator: { turn: 3 } };
  const out = assembleContext([cand('a', 'I run product at Ledgerly', { citations: [evidence] })], ctx('Where do I work?'));
  assert.doesNotMatch(out.block, /object Object/);
  assert.match(out.block, /I run product at Ledgerly \[said 2026-10-04, turn 3\]/);
});

test('an unrenderable citation is omitted, a formatted one is kept verbatim', () => {
  const out = assembleContext([
    cand('a', 'Fact one', { citations: [{ evidence_id: 'x' }] }),
    cand('b', 'Fact two', { citations: ['cite:doc#p2'] }),
  ], ctx('fact one two'));
  assert.match(out.block, /• Fact one \(confidence/);
  assert.match(out.block, /• Fact two \[cite:doc#p2\]/);
});

test('one sentence, one line — and the freed seat goes to another fact', () => {
  const cands = [
    cand('a', 'I run product at Ledgerly', { slotIds: ['goal'] }),
    cand('b', 'I run product at Ledgerly.', { slotIds: ['blockers'] }),
    cand('c', 'Ledgerly is a budgeting app for freelancers'),
  ];
  const out = assembleContext(cands, ctx('What does Ledgerly do?'), { limit: 2 });
  const lines = out.block.split('\n').filter(l => l.startsWith('• '));
  assert.equal(lines.filter(l => /I run product at Ledgerly/.test(l)).length, 1);
  assert.ok(lines.some(l => /budgeting app/.test(l)), `the second fact lost its seat to a repeat:\n${out.block}`);
});

test('a disputed and an undisputed copy of the same words are NOT merged', () => {
  const out = assembleContext([
    cand('a', 'Reliability is blocking the launch'),
    cand('b', 'Reliability is blocking the launch', { disputed: true }),
  ], ctx('What is blocking the launch?'));
  assert.equal(out.block.split('\n').filter(l => /Reliability is blocking/.test(l)).length, 2);
});
