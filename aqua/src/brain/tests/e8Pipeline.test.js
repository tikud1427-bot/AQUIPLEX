import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryPlan } from '../contextEngine/queryPlan.js';
import { runBoundedRetrievalRounds } from '../contextEngine/e8Pipeline.js';

const fact = (id, text, extra = {}) => ({
  kind: 'fact', id, statement: text, confidence: 0.9, citations: [], ...extra,
});

test('E8 integration policy: sufficient first round performs exactly one retrieval', () => {
  const calls = [];
  const out = runBoundedRetrievalRounds({
    query: 'what is the topic',
    taskType: 'conversation',
    retrieve: (query, opts) => {
      calls.push({ query, ...opts });
      return { items: [fact('topic-1', 'AQUA is the topic')], block: 'topic', stats: {} };
    },
  });

  assert.equal(out.rounds, 1);
  assert.equal(out.sufficiency.outcome, 'sufficient');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].round, 1);
});

test('E8 integration policy: missing required slots trigger bounded targeted retrieval', () => {
  const calls = [];
  const out = runBoundedRetrievalRounds({
    query: 'Should we choose the launch plan?',
    taskType: 'decision',
    retrieve: (query, opts) => {
      calls.push({ query, ...opts });
      if (opts.round === 1) {
        return { items: [
          fact('goal-1', 'Goal: launch the product', { slotIds: ['goal'] }),
        ], block: 'goal', stats: {} };
      }
      if (opts.slotId === 'deadline') {
        return { items: [
          fact('deadline-1', 'Deadline: 2026-10-01'),
        ], block: 'deadline', stats: {} };
      }
      if (opts.slotId === 'blockers') {
        return { items: [
          fact('blocker-1', 'No known blockers'),
        ], block: 'blocker', stats: {} };
      }
      return { items: [], block: '', stats: {} };
    },
  });

  assert.equal(out.rounds, 2);
  assert.equal(out.sufficiency.outcome, 'sufficient');
  assert.deepEqual(out.sufficiency.missing, []);
  assert.equal(calls[0].round, 1);
  const targeted = calls.slice(1);
  assert.ok(targeted.length <= 6, 'at most two queries per missing required slot');
  assert.ok(targeted.every(c => c.round === 2 && c.slotId), 'round two is always slot-targeted');
  assert.ok(targeted.some(c => c.slotId === 'deadline'));
  assert.ok(targeted.some(c => c.slotId === 'blockers'));
});

test('E8 integration policy: round two cannot become round three', () => {
  let calls = 0;
  const plan = buildQueryPlan('Should we choose the launch plan?', { taskType: 'decision' });
  const out = runBoundedRetrievalRounds({
    query: 'Should we choose the launch plan?',
    queryPlan: plan,
    retrieve: () => {
      calls += 1;
      return { items: [], block: '', stats: {} };
    },
  });

  assert.equal(out.rounds, 2);
  assert.equal(out.sufficiency.outcome, 'unknown');
  assert.ok(calls <= 7, `bounded retrieval calls: ${calls}`);
  assert.equal(out.plan.round, 2);
});

test('E8 integration policy: slot provenance is explicit, never inferred from text', () => {
  const out = runBoundedRetrievalRounds({
    query: 'Should we choose the launch plan?',
    taskType: 'decision',
    retrieve: (_query, opts) => opts.round === 1
      ? { items: [fact('x', 'This text contains a deadline but is actually the goal', { slotIds: ['goal'] })], block: '', stats: {} }
      : { items: [], block: '', stats: {} },
  });

  const goal = out.plan.slots.find(s => s.id === 'goal');
  assert.equal(goal.status, 'filled');
  const deadline = out.plan.slots.find(s => s.id === 'deadline');
  assert.equal(deadline.status, 'unfilled');
});
