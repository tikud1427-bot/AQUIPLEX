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
      // Round-two hits carry the predicate that defines the slot. Untyped
      // text hits no longer fill a predicate-defined slot (2026-10-07) — the
      // test below pins that.
      if (opts.slotId === 'deadline') {
        return { items: [
          fact('deadline-1', 'Deadline: 2026-10-01', { predicate: 'deadline_for' }),
        ], block: 'deadline', stats: {} };
      }
      if (opts.slotId === 'blockers') {
        return { items: [
          fact('blocker-1', 'CI is blocking the launch', { predicate: 'blocks' }),
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

test('E8 slot honesty: a TEXT hit for "<question> deadline" does not make the deadline known', () => {
  // Before 2026-10-07 round two stamped the slot id onto whatever a text search
  // returned, so a sentence merely containing "deadline" or "blocker" turned a
  // required slot "filled" and the answer was declared SUFFICIENT on nothing.
  const out = runBoundedRetrievalRounds({
    query: 'Should we choose the launch plan?',
    taskType: 'decision',
    retrieve: (query, opts) => {
      if (opts.round === 1) return { items: [fact('goal-1', 'Launch the product', { predicate: 'plans_to' })], block: '', stats: {} };
      return { items: [fact(`t-${opts.slotId}`, `we talked about the ${opts.slotId} once`)], block: '', stats: {} };
    },
  });
  assert.equal(out.sufficiency.outcome, 'unknown');
  assert.deepEqual(out.sufficiency.missing, ['deadline', 'blockers']);
  const kept = out.result.items.map(i => i.id);
  assert.ok(kept.includes('t-deadline'), 'the text hit should still be available as context');
  assert.ok(!(out.result.items.find(i => i.id === 't-deadline').slotIds ?? []).includes('deadline'));
});

test('E8 form: decision-shaped questions get the decision scaffold even when the classifier says simple_qa', () => {
  for (const q of ['Should I launch this week?', 'What should I focus on next?', 'Where should we start?', "What's my next step?"]) {
    assert.deepEqual(buildQueryPlan(q, { taskType: 'simple_qa' }).requiredSlotIds, ['goal', 'deadline', 'blockers'], q);
  }
  // A specific label is never overridden, and a plain question stays plain.
  assert.equal(buildQueryPlan('Should I refactor this function?', { taskType: 'coding' }).taskType, 'coding');
  assert.equal(buildQueryPlan('Who owns onboarding?', { taskType: 'simple_qa' }).taskType, 'conversation');
});
