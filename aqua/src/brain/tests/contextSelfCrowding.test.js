/**
 * E8 — DIVERSITY IS A RE-RANKING, NOT A GATE. (world-model-lift root cause)
 *
 * MEASURED: `world-model-lift` reported the Context Engine WORSE than the
 * retrieval floor it wraps (recall@8 0.679 vs 0.756, superseded 0.30 vs 0.60).
 * Tracing q001 ("Where do I work?"): 12 candidates in, 3 out, every drop
 * reason 'diversity', 194 of 1600 chars of budget used.
 *
 * CAUSE: `assembler.js` multiplied a candidate by `diversityPenalty` when its
 * primary entity was already covered `perEntitySoftCap` times, THEN compared
 * the product to `minScore`. In a self-scoped world nearly every fact has the
 * user as its primary entity, so after two picks every remaining fact took
 * the same 0.6x, fell under the floor together, and was dropped. The code's
 * own comment says diversity "is a RE-RANKING, not a per-item gate"; the
 * implementation made it exactly a gate.
 *
 * FIX: `minScore` judges what an item is worth BEFORE crowding. Diversity
 * only reorders.
 *
 * NOT FIXED HERE (declared): the Context Engine still orders slightly behind
 * the floor (mrr -0.017, top1_kind -0.042 after this change) because floor
 * rank is not a scoring signal. Separate defect, separate PR.
 *
 * Run: node --test src/brain/tests/contextSelfCrowding.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { assembleContext } = await import('../contextEngine/assembler.js');

function bag(over = {}) {
  return {
    queryTokens: new Set(['where', 'work']),
    semanticScores: null,
    activeProjectTokens: new Set(),
    activeGoalTokens: new Set(),
    focusEntityIds: new Set(),
    priorEntityIds: new Set(),
    maxHops: 3,
    ...over,
  };
}

// A graph-neighbour of the self entity, scored the way production scores them
// (~0.17): above minScore (0.12) on its own, below it once x0.6 is applied.
function selfFact(id, over = {}) {
  return {
    kind: 'fact', id, text: `fact about the user number ${id}`,
    confidence: 0.6, sourceType: 'conversation',
    entityIds: ['entity:you'], hops: 1, timestamp: 0, semanticId: id,
    selectionScore: 0.173,
    ...over,
  };
}

test('SELF-CROWDING: facts that cleared minScore are not dropped for sharing the user entity', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => selfFact(`s${i}`));
  const out = assembleContext(candidates, bag(), { limit: 8 });
  const ce = out.stats.contextEngine;

  assert.equal(out.items.length, 8,
    `limit binds, not diversity (selected ${out.items.length}, reasons ${JSON.stringify(ce.dropReasons)})`);
  assert.equal(ce.dropReasons.diversity ?? 0, 0, 'no drop is attributed to diversity any more');
  assert.equal(ce.dropReasons.limit, 2, 'the two that lost were dropped for the limit — an honest reason');
});

test('SELF-CROWDING: the char budget, not the diversity penalty, is what stops a self-scoped answer', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => selfFact(`s${i}`));
  const loose = assembleContext(candidates, bag(), { limit: 10, charBudget: 4000 });
  assert.equal(loose.items.length, 10, 'every eligible item fits an ample budget');
  const tight = assembleContext(candidates, bag(), { limit: 10, charBudget: 120 });
  assert.ok(tight.items.length < loose.items.length, 'a tight budget still binds');
  assert.ok((tight.stats.contextEngine.dropReasons.budget ?? 0) > 0, 'reported as budget');
});

test('DIVERSITY STILL RE-RANKS: a fresh entity outranks a crowded one', () => {
  // Same shape as contextEngine.test.js's diversity test, asserted on ORDER —
  // the property diversity is supposed to have.
  const candidates = [
    selfFact('a1', { entityIds: ['ent:a'], selectionScore: 0.5 }),
    selfFact('a2', { entityIds: ['ent:a'], selectionScore: 0.49 }),
    selfFact('a3', { entityIds: ['ent:a'], selectionScore: 0.48 }),
    selfFact('b1', { entityIds: ['ent:b'], selectionScore: 0.40 }),
  ];
  const out = assembleContext(candidates, bag(), { limit: 4, perEntitySoftCap: 2, diversityPenalty: 0.4 });
  const order = out.items.map(i => i.id);
  assert.ok(order.indexOf('b1') < order.indexOf('a3'), `b1 must precede a3, got ${order.join(',')}`);
  assert.equal(order.length, 4, 'and nothing is removed for having been crowded');
});

test('THE FLOOR STILL HOLDS: an item worth less than minScore on its own is still dropped', () => {
  const candidates = [
    selfFact('good'),
    selfFact('weak', { selectionScore: 0.05, confidence: 0, sourceType: 'unknown', hops: null }),
  ];
  const out = assembleContext(candidates, bag(), { limit: 8, minScore: 0.12 });
  const ids = out.items.map(i => i.id);
  assert.ok(ids.includes('good'));
  assert.ok(!ids.includes('weak'), 'the gate is preserved — only its input changed');
});
