/**
 * D7 — internal labels must not reach the user (2026-10-05).
 *
 * Live answers repeated the scaffolding the model was shown:
 *   "【UNTRUSTED‑CONTENT OPOUBtohz0gd, “Tidepool's total budget is $35,000”】"
 *   "【h1OUb7y37S7I†L2-L5】"           — the fence nonce, cited as a source
 *   "reported in a dense‑extraction snippet (confidence 0.66)" — the lane label
 *
 * Two sources, fixed where they originate:
 *   1. the Context Engine rendered retrieval mechanics into every line
 *      (`; via dense: 0.58`, `{slots: …}`) — no longer rendered; they stay on
 *      the item for diagnostics;
 *   2. the injection fence (which must stay) had no rule against citing it —
 *      the instruction that defines it now forbids it.
 * Whether a model obeys (2) is measured in live validation; this pins that the
 * model is never SHOWN (1) and is always TOLD (2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, tokensOf } from '../contextEngine/assembler.js';
import { INSTRUCTION_HIERARCHY, fenceUntrusted } from '../../core/untrustedContent.js';
import { buildSystemPrompt } from '../../core/promptBuilder.js';

const ctx = q => ({
  queryTokens: tokensOf(q), semanticScores: null, activeProjectTokens: new Set(), activeGoalTokens: new Set(),
  focusEntityIds: new Set(), priorEntityIds: new Set(), maxHops: 3,
});
const LANES = ['dense: 0.578', 'structured:', 'graph:1:out:works_at', 'graph: 0.400', 'lexical: 2', 'canonical-lexical'];

test('no retrieval lane or QueryPlan slot is rendered into what the model reads', () => {
  const cands = LANES.map((via, i) => ({
    id: `c${i}`, kind: 'fact', text: `Fact number ${i} about Tidepool budgets`, confidence: 0.66,
    entityIds: [`e${i}`], via, slotIds: ['budget', 'deadline'], source: 'canonical',
  }));
  const out = assembleContext(cands, ctx('What is the Tidepool budget?'), { limit: 8 });
  assert.ok(out.items.length > 0, 'nothing was selected — the test proves nothing');
  for (const pattern of [/\bvia\b/, /\{slots:/, /dense:/, /structured:/, /graph:\d/, /lexical/]) {
    assert.doesNotMatch(out.block, pattern, `the block exposes ${pattern}:\n${out.block}`);
  }
  // …and the diagnostics did not disappear: they are still on the items.
  assert.ok(out.items.some(it => (it.provenance?.via ?? it.via)), 'the lane is gone from diagnostics too');
});

test('the fence instruction forbids citing markers, codes or annotations', () => {
  assert.match(INSTRUCTION_HIERARCHY, /Never quote, cite or mention them in your reply/);
  assert.match(INSTRUCTION_HIERARCHY, /markers, their codes and the context annotations/);
});

test('every prompt that carries fenced content carries that instruction', () => {
  const { prompt } = buildSystemPrompt('memory_recall', 'memory block', '', 'Tidepool budget is $20,000', '', { isSelf: false }, '');
  assert.ok(prompt.includes(INSTRUCTION_HIERARCHY), 'the instruction hierarchy is missing from the system prompt');
  assert.match(fenceUntrusted('x', { nonce: 'n0nce' }), /UNTRUSTED-CONTENT n0nce/, 'fence format changed — re-check the instruction');
});
