/**
 * Memory 5.0 Phase A — Importance Engine + Fact Lifecycle
 * Run: node --test src/memory/tests/importance.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-importance-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

const DAY = 24 * 3600 * 1000;
let ltm, importance, mindStore, retriever, reflection, graph;

before(async () => {
  ltm        = await import('../longTermMemory.js');
  importance = await import('../importanceEngine.js');
  mindStore  = await import('../../mind/mindStore.js');
  retriever  = await import('../memoryRetriever.js');
  reflection = await import('../../mind/reflectionEngine.js');
  graph      = await import('../../mind/relationshipGraph.js');
});

function freshOwner(name) {
  return `user:phaseA-${name}-${Math.random().toString(36).slice(2, 8)}`;
}

test('history cap enforced on write (HISTORY_PER_ITEM bug fix)', () => {
  const owner = freshOwner('history');
  for (let i = 0; i < 25; i++) {
    ltm.storeFact(owner, {
      key: 'favorite_color', value: `color-${i}`, confidence: 0.9,
      importance: 5, ts: Date.now() + i, isCorrection: true, // corrections bypass damping
    });
  }
  const fact = ltm.getFact(owner, 'favorite_color');
  assert.equal(fact.value, 'color-24');
  assert.ok(fact.history.length <= 10, `history ${fact.history.length} > cap 10`);
  // newest revisions kept
  assert.equal(fact.history[fact.history.length - 1].value, 'color-23');
});

test('correction pins the fact; pin survives later plain overwrite', () => {
  const owner = freshOwner('pin');
  ltm.storeFact(owner, { key: 'city', value: 'Guwahati', confidence: 0.9, importance: 6, ts: Date.now(), isCorrection: true });
  assert.equal(ltm.getFact(owner, 'city').pinned, true);
  ltm.storeFact(owner, { key: 'city', value: 'Bengaluru', confidence: 0.9, importance: 6, ts: Date.now() + 1 });
  const fact = ltm.getFact(owner, 'city');
  assert.equal(fact.value, 'Bengaluru');
  assert.equal(fact.pinned, true, 'pin must survive overwrite');
});

test('computeImportance: pinned floor, usage and staleness move the score', () => {
  const now = Date.now();
  const base = { key: 'hobby', value: 'bouldering', baseImportance: 5, supportCount: 1, retrievalCount: 0, lastMentionedAt: now };
  const fresh = importance.computeImportance({ ...base }, { now });
  const stale = importance.computeImportance({ ...base, lastMentionedAt: now - 200 * DAY }, { now });
  assert.ok(fresh > stale, `fresh ${fresh} should outrank stale ${stale}`);

  const used = importance.computeImportance({ ...base, retrievalCount: 8 }, { now });
  assert.ok(used > fresh, 'retrieval usage raises importance');

  const pinnedStale = importance.computeImportance({ ...base, lastMentionedAt: now - 200 * DAY, pinned: true }, { now });
  assert.ok(pinnedStale >= 8, `pinned floor: got ${pinnedStale}`);
});

test('graph degree boosts facts whose value is a connected node', () => {
  const owner = freshOwner('degree');
  const mind = mindStore.getMind(owner);
  const org = graph.upsertNode(mind, 'org', 'Aquiplex');
  for (const label of ['AQUA', 'Billing', 'Frontend']) {
    const n = graph.upsertNode(mind, 'project', label);
    graph.upsertEdge(mind, org.key, n.key, 'owns');
  }
  const degree = importance.graphDegreeMap(mind);
  assert.ok((degree.get('aquiplex') || 0) >= 3);
  const now = Date.now();
  const connected = importance.computeImportance({ key: 'workplace', value: 'Aquiplex', baseImportance: 5, lastMentionedAt: now }, { now, degree });
  const isolated  = importance.computeImportance({ key: 'workplace', value: 'Unknown Co', baseImportance: 5, lastMentionedAt: now }, { now, degree });
  assert.ok(connected > isolated);
});

test('lifecycle archives stale low-value facts; spares identity + pinned; re-mention reactivates', () => {
  const owner = freshOwner('lifecycle');
  const old = Date.now() - 120 * DAY;
  // stale trivia — should archive
  ltm.storeFact(owner, { key: 'favorite_color', value: 'teal', confidence: 0.7, importance: 3, ts: old });
  // stale identity — must survive
  ltm.storeFact(owner, { key: 'name', value: 'Ananya', confidence: 0.95, importance: 9, ts: old });
  // stale but pinned — must survive
  ltm.storeFact(owner, { key: 'hobby', value: 'chess', confidence: 0.8, importance: 3, ts: old, isCorrection: true });

  const mind = mindStore.getMind(owner);
  for (const f of Object.values(mind.facts)) { f.lastMentionedAt = old; f.updatedAt = old; f.ts = old; }

  const report = importance.applyFactLifecycle(mind);
  assert.ok(report.archived.includes('favorite_color'));
  assert.ok(!report.archived.includes('name'));
  assert.ok(!report.archived.includes('hobby'));

  // archived excluded from default getFacts, present with flag
  const activeKeys = ltm.getFacts(owner).map(f => f.key);
  assert.ok(!activeKeys.includes('favorite_color'));
  const allKeys = ltm.getFacts(owner, { includeArchived: true }).map(f => f.key);
  assert.ok(allKeys.includes('favorite_color'));

  // reactivation on demand: identical re-mention flips it back to active
  ltm.storeFact(owner, { key: 'favorite_color', value: 'teal', confidence: 0.7, importance: 3, ts: Date.now() });
  assert.equal(ltm.getFact(owner, 'favorite_color').status, 'active');
});

test('retrieval touches injected facts (usage feedback loop)', () => {
  const owner = freshOwner('touch');
  ltm.storeFact(owner, { key: 'favorite_language', value: 'typescript', confidence: 0.9, importance: 7, ts: Date.now() });
  const got = retriever.retrieveRelevantFacts(owner, 'what programming language do I prefer?', 5);
  assert.ok(got.some(f => f.key === 'favorite_language'));
  const fact = ltm.getFact(owner, 'favorite_language');
  assert.ok(fact.retrievalCount >= 1, 'retrievalCount incremented');
  assert.ok(fact.lastRetrievedAt > 0);
});

test('reflect() runs the lifecycle and reports it', () => {
  const owner = freshOwner('reflect');
  const old = Date.now() - 120 * DAY;
  ltm.storeFact(owner, { key: 'disliked_food', value: 'okra', confidence: 0.7, importance: 2, ts: old });
  const mind = mindStore.getMind(owner);
  for (const f of Object.values(mind.facts)) { f.lastMentionedAt = old; f.updatedAt = old; f.ts = old; }
  mind.turnCount = 8;
  const report = reflection.reflect(mind);
  assert.ok(report.factsRecomputed >= 1);
  assert.ok(report.factsArchived.includes('disliked_food'));
});
