import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryPlan, fillQueryPlan, withRound } from '../contextEngine/queryPlan.js';
import { runBoundedRetrievalRounds } from '../contextEngine/e8Pipeline.js';
import { assembleContext } from '../contextEngine/assembler.js';
import { tokensOf } from '../contextEngine/scorer.js';

const candidate = (id, text, slotIds, extra = {}) => ({
  kind: 'fact', id, text, slotIds, confidence: 0.95, sourceType: 'document',
  citations: [`cite:${id}`], via: 'lexical', entityIds: [], ...extra,
});

function ctx(query) {
  return {
    queryTokens: tokensOf(query), semanticScores: null,
    activeProjectTokens: new Set(), activeGoalTokens: new Set(),
    focusEntityIds: new Set(), priorEntityIds: new Set(), maxHops: 3,
  };
}

describe('E8 end-to-end policy gate (pure production seams)', () => {
  test('sufficient path: one round → rendered provenance → no abstention', () => {
    const query = 'Should we launch?';
    const plan = fillQueryPlan(
      withRound(buildQueryPlan(query, { taskType: 'decision' }), 1),
      [
        candidate('g', 'Launch product', ['goal']),
        candidate('d', 'Deadline is October 1', ['deadline']),
        candidate('b', 'No blockers', ['blockers']),
      ],
    );
    const assembled = assembleContext(plan.slots.flatMap(s => s.matches), ctx(query), {
      queryPlan: plan, limit: 8, charBudget: 1400,
    });
    assert.equal(assembled.stats.contextEngine.epistemicState, 'sufficient');
    assert.equal(assembled.stats.contextEngine.shouldAbstain, false);
    assert.equal(assembled.stats.contextEngine.provenancePreserved, true);
    assert.match(assembled.block, /EVIDENCE STATUS: SUFFICIENT/);
    assert.match(assembled.block, /cite:g/);
    assert.equal(assembled.items[0].provenance.slotIds.length > 0, true);
  });

  test('exhausted path: two rounds → explicit UNKNOWN, never silent', () => {
    const query = 'Should we launch?';
    const out = runBoundedRetrievalRounds({
      query, taskType: 'decision',
      retrieve: () => ({ items: [], block: '', stats: {} }),
    });
    assert.equal(out.rounds, 2);
    assert.equal(out.sufficiency.outcome, 'unknown');
    const assembled = assembleContext([], ctx(query), {
      queryPlan: out.plan, limit: 8, charBudget: 1400,
    });
    assert.equal(assembled.stats.contextEngine.epistemicState, 'unknown');
    assert.equal(assembled.stats.contextEngine.shouldAbstain, true);
    assert.deepEqual(assembled.stats.contextEngine.requiredSlotsMissing, ['goal','deadline','blockers']);
    assert.match(assembled.block, /EVIDENCE STATUS: UNKNOWN/);
    assert.match(assembled.block, /Do not infer or fabricate/);
  });

  test('second round is targeted and remains bounded', () => {
    const calls = [];
    const out = runBoundedRetrievalRounds({
      query: 'Should we launch?', taskType: 'decision',
      retrieve: (q, o) => {
        calls.push({ q, ...o });
        if (o.round === 1) return {
          items: [candidate('g', 'Launch product', ['goal'])], block: '', stats: {},
        };
        return {
          items: [candidate(`${o.slotId}-1`, `${o.slotId} evidence`, [o.slotId])],
          block: '', stats: {},
        };
      },
    });
    assert.equal(out.rounds, 2);
    assert.equal(out.sufficiency.outcome, 'sufficient');
    assert.equal(calls.filter(c => c.round === 2).length, 4); // 2 queries × 2 missing slots
    assert.ok(calls.filter(c => c.round === 2).every(c => c.slotId));
    assert.equal(Math.max(...calls.map(c => c.round)), 2);
  });

  test('provenance is not lost during rendering', () => {
    const query = 'What is the deadline?';
    const plan = fillQueryPlan(
      withRound(buildQueryPlan(query, { taskType: 'decision' }), 1),
      [candidate('d', 'Deadline is October 1', ['deadline'])],
    );
    const assembled = assembleContext(plan.slots.flatMap(s => s.matches), ctx(query), {
      queryPlan: plan, limit: 8, charBudget: 1400,
    });
    const item = assembled.items.find(x => x.id === 'd');
    assert.ok(item);
    assert.deepEqual(item.provenance.citations, ['cite:d']);
    assert.deepEqual(item.provenance.slotIds, ['deadline']);
    assert.equal(item.via, 'lexical');
  });
});
