/**
 * Memory 5.0 Phase E — Reflection 2.0: duplicate merge + insights
 * Run: node --test src/mind/tests/reflection2.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-reflection2-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

let ltm, importance, mindStore, reflection, schema;

before(async () => {
  ltm        = await import('../../memory/longTermMemory.js');
  importance = await import('../../memory/importanceEngine.js');
  mindStore  = await import('../mindStore.js');
  reflection = await import('../reflectionEngine.js');
  schema     = await import('../mindSchema.js');
});

function freshOwner(name) {
  return `user:phaseE-${name}-${Math.random().toString(36).slice(2, 8)}`;
}

test('duplicate values: custom key merges into schema key, support absorbed', () => {
  const owner = freshOwner('merge');
  ltm.storeFact(owner, { key: 'workplace', value: 'Aquiplex', confidence: 0.8, importance: 7, ts: Date.now() - 5000 });
  ltm.storeFact(owner, { key: 'employer_name', value: 'aquiplex', confidence: 0.9, importance: 5, ts: Date.now() });
  const mind = mindStore.getMind(owner);
  // give the loser some usage to prove absorption
  mind.facts['employer_name'].supportCount = 3;
  mind.facts['employer_name'].retrievalCount = 4;

  const report = importance.mergeDuplicateFacts(mind);
  assert.equal(report.merged.length, 1);
  assert.equal(report.merged[0].winner, 'workplace');
  assert.equal(report.merged[0].loser, 'employer_name');
  assert.equal(mind.facts['employer_name'], undefined, 'loser deleted');
  const w = mind.facts['workplace'];
  assert.ok(w.supportCount >= 4, 'support summed');
  assert.ok(w.retrievalCount >= 4, 'usage summed');
  assert.equal(w.confidence, 0.9, 'max confidence kept');
  assert.ok(w.history.some(h => /duplicate_merged:employer_name/.test(h.reason)));
});

test('identity-key facts are never deleted as merge losers', () => {
  const owner = freshOwner('idsafe');
  // organization + workplace share a value — BOTH identity keys, both must survive
  ltm.storeFact(owner, { key: 'workplace', value: 'Aquiplex', confidence: 0.9, importance: 7, ts: Date.now() - 1000 });
  ltm.storeFact(owner, { key: 'organization', value: 'Aquiplex', confidence: 0.8, importance: 6, ts: Date.now() });
  const mind = mindStore.getMind(owner);
  const report = importance.mergeDuplicateFacts(mind);
  assert.equal(report.merged.length, 0);
  assert.ok(mind.facts['workplace'] && mind.facts['organization'], 'both identity fields intact');
});

test('non-scalar and archived facts are ignored by merge', () => {
  const owner = freshOwner('scalar');
  ltm.storeFact(owner, { key: 'hobbies', value: ['chess', 'running'], confidence: 0.9, importance: 6, ts: Date.now() });
  ltm.storeFact(owner, { key: 'interests_list', value: ['chess', 'running'], confidence: 0.9, importance: 6, ts: Date.now() });
  const mind = mindStore.getMind(owner);
  const report = importance.mergeDuplicateFacts(mind);
  assert.equal(report.merged.length, 0, 'arrays never merge');
});

test('insight: recurring blocker (count>=3) becomes a BEHAVIOR belief', () => {
  const owner = freshOwner('blocker');
  const mind = mindStore.getMind(owner);
  mind.working.blockers.push({ text: 'render deploy pipeline', addedAt: Date.now(), lastSeenAt: Date.now(), count: 4 });
  const insights = reflection.deriveInsights(mind);
  assert.ok(insights.some(i => /recurring blocker/.test(i)));
  const bk = Object.keys(mind.beliefs).find(k => /recurring_blocker:render_deploy_pipeline/.test(k));
  assert.ok(bk, 'belief created through the one belief writer');
  assert.equal(mind.beliefs[bk].value, 'render deploy pipeline');
});

test('insight: persistent goal (mentions>=5) becomes a BEHAVIOR belief; idempotent reinforce', () => {
  const owner = freshOwner('goal');
  const mind = mindStore.getMind(owner);
  const g = schema.createGoal ? schema.createGoal({ title: 'ship artifact engine', priority: 8, confidence: 0.7, source: 'test' })
                              : { id: 'g1', title: 'ship artifact engine', status: 'active', mentions: 6, history: [] };
  g.mentions = 6; g.status = 'active';
  mind.goals[g.id || 'g1'] = g;

  const first = reflection.deriveInsights(mind);
  assert.ok(first.some(i => /persistent goal/.test(i)));
  const bk = Object.keys(mind.beliefs).find(k => /persistent_goal:ship_artifact_engine/.test(k));
  assert.ok(bk);
  const confAfterFirst = mind.beliefs[bk].confidence;

  reflection.deriveInsights(mind); // same value again → reinforce, not duplicate
  const again = Object.keys(mind.beliefs).filter(k => /persistent_goal:ship_artifact_engine/.test(k));
  assert.equal(again.length, 1, 'no duplicate beliefs');
  assert.ok(mind.beliefs[bk].confidence >= confAfterFirst, 'reinforced');
});

test('reflect() carries factsMerged + insights in the report', () => {
  const owner = freshOwner('report');
  ltm.storeFact(owner, { key: 'workplace', value: 'Tata', confidence: 0.8, importance: 7, ts: Date.now() - 2000 });
  ltm.storeFact(owner, { key: 'my_company', value: 'tata', confidence: 0.85, importance: 5, ts: Date.now() });
  const mind = mindStore.getMind(owner);
  mind.working.blockers.push({ text: 'flaky ci runner', addedAt: Date.now(), lastSeenAt: Date.now(), count: 3 });
  mind.turnCount = 8;
  const report = reflection.reflect(mind);
  assert.ok(report.factsMerged.some(m => m.winner === 'workplace' && m.loser === 'my_company'));
  assert.ok(report.insights.some(i => /flaky ci runner/.test(i)));
});
