/**
 * Memory 5.1 — Memory Reasoner
 * Run: node --test src/memory/tests/memoryReasoner.test.js
 *
 * Contract under test: deterministic, evidence-backed reasoning over the
 * memory layer — every finding cites fact keys / episode ids / timestamps;
 * empty memory yields honest neutral results, never confident guesses.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-memreason-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

const OWNER = 'user:reason-tester';
const DAY = 24 * 3600 * 1000;
const now = Date.now();

let ltm, reasoner, mindStore, graph, timeline;

before(async () => {
  ltm       = await import('../longTermMemory.js');
  reasoner  = await import('../memoryReasoner.js');
  mindStore = await import('../../mind/mindStore.js');
  graph     = await import('../../mind/relationshipGraph.js');
  timeline  = await import('../../mind/timeline.js');
});

// ── contradictions ───────────────────────────────────────────────────────────

test('findContradictions surfaces value flips with their prior values', () => {
  ltm.storeFact(OWNER, { key: 'deploy_target', value: 'render', confidence: 0.9, importance: 6, ts: now - 3 * DAY });
  ltm.storeFact(OWNER, { key: 'deploy_target', value: 'railway', confidence: 0.85, importance: 6, ts: now });
  ltm.storeFact(OWNER, { key: 'steady_fact', value: 'unchanged', confidence: 0.9, importance: 5, ts: now });

  const out = reasoner.findContradictions(OWNER);
  const hit = out.find(c => c.key === 'deploy_target');
  assert.ok(hit, 'flipped fact reported');
  assert.equal(hit.current, 'railway');
  assert.equal(hit.priorValues.some(p => p.value === 'render'), true);   // the receipts
  assert.equal(hit.evidence.factKey, 'deploy_target');
  assert.equal(out.some(c => c.key === 'steady_fact'), false);           // clean fact absent
});

// ── trends ───────────────────────────────────────────────────────────────────

test('detectTrends: momentum from graph weight + working focus; churn from revisions', () => {
  const mind = mindStore.getMind(OWNER);
  for (let i = 0; i < 4; i++) graph.upsertNode(mind, 'project', 'AQUA');   // weight 4
  graph.upsertNode(mind, 'tech', 'obscure-lib');                           // weight 1 → below bar
  mind.working.focus = [{ topic: 'memory-sprint', weight: 3.2, lastSeenAt: now }];
  mindStore.touchMind(mind);

  // Distinct ts per revision — the conflict resolver keeps the existing value
  // when the candidate isn't newer (existing_wins), which is correct behavior.
  ['v1', 'v2', 'v3'].forEach((v, i) => {
    ltm.storeFact(OWNER, { key: 'churny_pref', value: v, confidence: 0.9, importance: 5, ts: now + i });
  });

  const t = reasoner.detectTrends(OWNER);
  assert.equal(t.momentum.some(m => m.topic === 'AQUA' && m.source === 'graph'), true);
  assert.equal(t.momentum.some(m => m.topic === 'memory-sprint' && m.source === 'working'), true);
  assert.equal(t.momentum.some(m => m.topic === 'obscure-lib'), false);
  const churn = t.churn.find(c => c.key === 'churny_pref');
  assert.ok(churn, 'thrice-revised fact is churn');
  assert.equal(churn.revisions >= 3, true);
});

test('detectTrends: recurring episode themes within 30 days', () => {
  const mind = mindStore.getMind(OWNER);
  mind.episodes['ep-a'] = { id: 'ep-a', title: 'Working on auth', theme: 'auth', status: 'closed', startedAt: now - 5 * DAY };
  mind.episodes['ep-b'] = { id: 'ep-b', title: 'Working on auth', theme: 'auth', status: 'closed', startedAt: now - 2 * DAY };
  mind.episodes['ep-old'] = { id: 'ep-old', title: 'Working on auth', theme: 'auth', status: 'closed', startedAt: now - 60 * DAY };
  mindStore.touchMind(mind);

  const t = reasoner.detectTrends(OWNER);
  const rec = t.recurringWork.find(r => String(r.theme).toLowerCase() === 'auth');
  assert.ok(rec, 'recurring theme found');
  assert.equal(rec.count, 2);                                // 60-day episode outside window
  assert.deepEqual([...rec.episodeIds].sort(), ['ep-a', 'ep-b']);
});

// ── gaps ─────────────────────────────────────────────────────────────────────

test('findGaps: core identity, open questions, stale goals, unverified facts', () => {
  const mind = mindStore.getMind(OWNER);
  mind.working.openQuestions = [{ text: 'which vector DB for scale?', addedAt: now }];
  mind.goals['g-stale'] = { id: 'g-stale', text: 'ship mobile app', status: 'active', createdAt: now - 30 * DAY, updatedAt: now - 20 * DAY };
  mind.goals['g-fresh'] = { id: 'g-fresh', text: 'fix flaky test', status: 'active', createdAt: now - DAY, updatedAt: now - DAY };
  mindStore.touchMind(mind);
  ltm.storeFact(OWNER, { key: 'maybe_timezone', value: 'IST?', confidence: 0.55, importance: 4, ts: now });

  const g = reasoner.findGaps(OWNER);
  assert.equal(g.identityMissing.includes('name'), true);    // never told the system a name
  assert.equal(g.openQuestions.includes('which vector DB for scale?'), true);
  assert.equal(g.staleGoals.some(x => x.id === 'g-stale'), true);
  assert.equal(g.staleGoals.some(x => x.id === 'g-fresh'), false);
  assert.equal(g.unverifiedFacts.some(f => f.key === 'maybe_timezone'), true);
});

test('findGaps: identity gap closes once the fact exists', () => {
  ltm.storeFact(OWNER, { key: 'name', value: 'Ananya', confidence: 0.95, importance: 9, ts: now });
  const g = reasoner.findGaps(OWNER);
  assert.equal(g.identityMissing.includes('name'), false);
});

// ── decisions ────────────────────────────────────────────────────────────────

test('compareDecisions: chronological outcomes + contrast when course changed', () => {
  const mind = mindStore.getMind(OWNER);
  mind.episodes['ep-d1'] = {
    id: 'ep-d1', title: 'Working on billing', theme: 'billing', status: 'closed',
    outcome: 'chose Cashfree', lessons: ['webhooks flaky'], startedAt: now - 20 * DAY, endedAt: now - 19 * DAY,
  };
  mind.episodes['ep-d2'] = {
    id: 'ep-d2', title: 'Working on billing', theme: 'billing', status: 'closed',
    outcome: 'migrated to Razorpay', lessons: ['prepaid credits simpler'], startedAt: now - 6 * DAY, endedAt: now - 5 * DAY,
  };
  mindStore.touchMind(mind);

  const d = reasoner.compareDecisions(OWNER, 'what did we decide about billing?');
  assert.equal(d.decisions.length, 2);
  assert.equal(d.decisions[0].id, 'ep-d1');                  // chronological
  assert.equal(d.decisions[1].outcome, 'migrated to Razorpay');
  assert.ok(d.contrast);
  assert.equal(d.contrast.changed, true);                    // course changed, with ids
  assert.equal(d.contrast.earliest.id, 'ep-d1');
});

// ── change feed ──────────────────────────────────────────────────────────────

test('whatChanged merges timeline events, fact revisions and new facts in-window', () => {
  const mind = mindStore.getMind(OWNER);
  timeline.pushTimeline(mind, { type: 'goal', label: 'goal completed: fix flaky test', at: now - DAY, importance: 5 });
  timeline.pushTimeline(mind, { type: 'goal', label: 'ancient event', at: now - 40 * DAY, importance: 5 });

  ltm.storeFact(OWNER, { key: 'brand_new', value: 'fresh', confidence: 0.9, importance: 5, ts: now });

  const changes = reasoner.whatChanged(OWNER, { sinceMs: 7 * DAY });
  assert.equal(changes.some(c => c.kind === 'goal' && /flaky/.test(c.label)), true);
  assert.equal(changes.some(c => /ancient event/.test(c.label)), false);   // outside window
  assert.equal(changes.some(c => c.kind === 'fact_change' && c.evidence?.factKey === 'deploy_target'), true);
  assert.equal(changes.some(c => c.kind === 'fact_new' && c.evidence?.factKey === 'brand_new'), true);
  for (let i = 1; i < changes.length; i++) {
    assert.equal(changes[i - 1].at >= changes[i].at, true);  // newest first
  }
});

// ── entry point ──────────────────────────────────────────────────────────────

test('reasonOverMemory routes by question and stays within confidence bounds', () => {
  const c = reasoner.reasonOverMemory(OWNER, 'are there any contradictions in what I told you?');
  assert.equal(c.mode, 'contradictions');
  assert.equal(Array.isArray(c.findings), true);

  const ch = reasoner.reasonOverMemory(OWNER, 'what changed since last week?');
  assert.equal(ch.mode, 'changes');

  const d = reasoner.reasonOverMemory(OWNER, 'why did we decide to migrate billing?');
  assert.equal(d.mode, 'decisions');

  const o = reasoner.reasonOverMemory(OWNER, '');
  assert.equal(o.mode, 'overview');
  assert.ok(o.findings.trends && o.findings.gaps);

  for (const r of [c, ch, d, o]) {
    assert.equal(r.confidence >= 0.3 && r.confidence <= 0.9, true);
    assert.equal(typeof r.evidence.items, 'number');
  }
});

test('empty owner: every function returns neutral, never throws', () => {
  const ghost = 'user:ghost-owner';
  assert.deepEqual(reasoner.findContradictions(ghost), []);
  assert.deepEqual(reasoner.whatChanged(ghost), []);
  assert.deepEqual(reasoner.compareDecisions(ghost, 'anything').decisions, []);
  const t = reasoner.detectTrends(ghost);
  assert.deepEqual(t.momentum, []);
  const r = reasoner.reasonOverMemory(ghost, 'what changed?');
  assert.equal(r.confidence, 0.3);                           // honest emptiness
});
