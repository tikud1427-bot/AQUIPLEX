import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGroup, runClaimConsolidationJob, CONSOLIDATION_ACTOR } from './consolidationWorker.js';
import { getMetrics, _resetVoiceAndJ3Metrics } from '../../core/observability.js';
import { renderPrometheus } from '../../core/metricsExposition.js';

const c = (claimId, over = {}) => ({ claimId, actor: 'e6:e6-v1', trust: 0.6, evidenceCount: 1, ...over });

test('survivor = the planner\'s rule: explicit user source, then evidence, then id', async () => {
  assert.equal((await planGroup('o', [c('b'), c('a', { actor: 'user' })])).survivorId, 'a');
  assert.equal((await planGroup('o', [c('a'), c('b', { evidenceCount: 3 })])).survivorId, 'b');
  const p = await planGroup('o', [c('c'), c('a'), c('b')]);
  assert.equal(p.survivorId, 'a');
  assert.deepEqual(p.absorbed.sort(), ['b', 'c']);
});

test('every absorbed claim is merged into the FINAL survivor; a raced pair is counted, not thrown', async () => {
  _resetVoiceAndJ3Metrics();
  const calls = [];
  const r = await runClaimConsolidationJob({ ownerId: 'o', jobId: 7 }, {
    groupsFor: async () => [[c('c'), c('a', { actor: 'user' }), c('b')]],
    merge: async m => { calls.push(m); return m.absorbedId === 'c' ? { applied: false, reason: 'not-current' } : { applied: true, evidenceLinked: 1 }; },
  });
  assert.deepEqual(calls.map(m => [m.survivorId, m.absorbedId, m.actor, m.jobId]).sort(),
    [['a', 'b', CONSOLIDATION_ACTOR, 7], ['a', 'c', CONSOLIDATION_ACTOR, 7]]);
  assert.deepEqual([r.groups, r.merged, r.raced, r.evidenceLinked], [1, 1, 1, 1]);
  assert.deepEqual(getMetrics().j3, { scheduled: 0, runs: 1, groups: 1, merged: 1, raced: 1, failures: 0, evidenceLinked: 1 });
});

test('a failing step is counted and RETHROWN so the queue retries / dead-letters', async () => {
  _resetVoiceAndJ3Metrics();
  await assert.rejects(runClaimConsolidationJob({ ownerId: 'o' }, { groupsFor: async () => { throw new Error('db down'); } }), /db down/);
  assert.equal(getMetrics().j3.failures, 1);
  await assert.rejects(runClaimConsolidationJob({}), /ownerId/);
});

test('/metrics exposition: revision voice (local + every server) and J3 (local + workers)', () => {
  const rv = { considered: 5, emitted: 1, suppressed: { 'said-in-this-conversation': 2, 'newer-chosen': 2 }, skipped: { 'unsuitable-turn': 3 } };
  const text = renderPrometheus({
    metrics: { revisionVoice: rv, j3: { runs: 2, merged: 3 } },
    servers: [{ processId: 's1', ageSeconds: 1, snapshot: { revisionVoice: rv } }],
    workers: [{ processId: 'w1', ageSeconds: 1, snapshot: { j3: { merged: 4 } } }],
  });
  for (const line of [
    'aqua_revision_voice_considered_total 5', 'aqua_revision_voice_emitted_total 1',
    'aqua_revision_voice_suppressed_total{reason="said-in-this-conversation"} 2',
    'aqua_revision_voice_skipped_total{reason="unsuitable-turn"} 3',
    'aqua_servers_alive 1', 'aqua_server_revision_voice_emitted_total{process="s1"} 1',
    'aqua_j3_merged_total 3', 'aqua_worker_j3_merged_total{process="w1"} 4',
  ]) assert.ok(text.includes(line), `missing: ${line}\n${text}`);
});
