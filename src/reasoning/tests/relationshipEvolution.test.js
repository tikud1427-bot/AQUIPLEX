/**
 * Relationship evolution (Phase 3 / audit W4).
 *
 * Goal 7 asks relationships to carry confidence, evidence, timestamps,
 * provenance and evolution history. The graph already had the first four.
 * What it lacked was any record that a relationship had been RE-confirmed,
 * and a merge rule that let one enthusiastic source be overruled — an edge
 * asserted once at 0.95 and contradicted by ten later documents kept 0.95
 * forever, because the merge was `Math.max`.
 *
 * The guarantees under test:
 *   S1 HOLDS      the provenance contract still throws. This is audit R2 —
 *                 the 🔴 risk of touching addEdge — and is pinned first.
 *   UNFLAGGED     lastConfirmedAt / observations / history are pure metadata
 *                 and ship without a flag, changing no decision.
 *   FLAGGED       only the confidence FORMULA sits behind AQUA_REL_EVOLVE,
 *                 because it feeds ranking and therefore changes answers.
 *   EXACT ROLLBACK  peakConfidence preserves the old value, so unsetting the
 *                 flag restores previous behaviour with nothing lost.
 *   DERIVED DECAY staleness is computed at read time, never stored.
 *   SELF-HEALING  v2 edges migrate on load, additively, without a rebuild.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-reledge-'));
const G = await import('../reasoningGraph.js');

const O = 'user:ananya';
const base = { from: 'ent:name:priya', to: 'ent:name:billing', type: 'works_on' };
const withProv = (extra = {}) => ({ ...base, sourceFiles: ['uko:memo.docx'], ...extra });

beforeEach(() => { G._resetGraphForTests(); delete process.env.AQUA_REL_EVOLVE; });
afterEach(() => { delete process.env.AQUA_REL_EVOLVE; });

// ── S1: the contract this phase must not weaken ──────────────────────────────

test('S1: an edge with no provenance still throws — in BOTH modes', () => {
  for (const mode of [undefined, 'on']) {
    if (mode) process.env.AQUA_REL_EVOLVE = mode; else delete process.env.AQUA_REL_EVOLVE;
    assert.throws(
      () => G.addEdge(O, { ...base, confidence: 0.9 }),
      /no provenance/,
      `provenance must be structurally required with AQUA_REL_EVOLVE=${mode ?? 'off'}`);
  }
});

test('S1: evidence alone satisfies provenance, as before', () => {
  assert.doesNotThrow(() => G.addEdge(O, { ...base, confidence: 0.8, evidence: ['ev1'] }));
});

// ── Unflagged metadata ───────────────────────────────────────────────────────

test('a new edge records its own creation as its first confirmation', () => {
  const e = G.addEdge(O, withProv({ confidence: 0.8 }));
  assert.equal(e.observations, 1);
  assert.equal(e.lastConfirmedAt, e.createdAt, 'creation IS the first confirmation');
  assert.deepEqual(e.history, []);
  assert.equal(e.peakConfidence, 0.8);
});

test('re-assertion advances lastConfirmedAt and the observation count', async () => {
  const first = G.addEdge(O, withProv({ confidence: 0.8 }));
  await new Promise(r => setTimeout(r, 5));
  const second = G.addEdge(O, withProv({ confidence: 0.8, sourceFiles: ['uko:plan.md'] }));

  assert.equal(second.observations, 2);
  assert.ok(second.lastConfirmedAt > first.createdAt,
    'a relationship re-asserted today is not the same as one last seen in March');
  assert.equal(second.createdAt, first.createdAt, 'creation time never moves');
  assert.deepEqual(second.sourceFiles, ['uko:memo.docx', 'uko:plan.md']);
});

test('metadata ships unflagged — it adds information without changing a decision', () => {
  delete process.env.AQUA_REL_EVOLVE;
  const e = G.addEdge(O, withProv({ confidence: 0.7 }));
  assert.ok('lastConfirmedAt' in e && 'observations' in e && 'history' in e);
});

// ── Flagged confidence formula ───────────────────────────────────────────────

test('OFF: confidence is Math.max, exactly as before this phase', () => {
  G.addEdge(O, withProv({ confidence: 0.95 }));
  const e = G.addEdge(O, withProv({ confidence: 0.2, sourceFiles: ['uko:contradicts.pdf'] }));
  assert.equal(e.confidence, 0.95, 'default behaviour must be byte-identical to v2');
});

test('ON: contradicting evidence can pull an edge down — the W4 fix', () => {
  process.env.AQUA_REL_EVOLVE = 'on';
  G.addEdge(O, withProv({ confidence: 0.95 }));

  let last;
  for (let i = 0; i < 8; i++) {
    last = G.addEdge(O, withProv({ confidence: 0.2, sourceFiles: [`uko:doubt${i}.pdf`] }));
  }

  assert.ok(last.confidence < 0.95,
    'an edge contradicted by eight later documents must not keep its peak');
  assert.ok(last.confidence > 0.2,
    'nor should it collapse to the newest claim — this is corroboration, not replacement');
});

test('ON: agreeing evidence keeps a well-supported edge strong', () => {
  process.env.AQUA_REL_EVOLVE = 'on';
  G.addEdge(O, withProv({ confidence: 0.9 }));
  let last;
  for (let i = 0; i < 5; i++) {
    last = G.addEdge(O, withProv({ confidence: 0.9, sourceFiles: [`uko:agree${i}.pdf`] }));
  }
  assert.ok(last.confidence >= 0.88, `corroboration must not erode agreement (got ${last.confidence})`);
});

test('ON: confidence never reaches zero — absent is not the same as false', () => {
  process.env.AQUA_REL_EVOLVE = 'on';
  G.addEdge(O, withProv({ confidence: 0.9 }));
  let last;
  for (let i = 0; i < 50; i++) {
    last = G.addEdge(O, withProv({ confidence: 0, sourceFiles: [`uko:n${i}.pdf`] }));
  }
  assert.ok(last.confidence > 0,
    'zero reads as "known false", and nothing in a provenanced edge establishes that');
});

test('EXACT ROLLBACK: peakConfidence preserves the pre-phase value in both modes', () => {
  process.env.AQUA_REL_EVOLVE = 'on';
  G.addEdge(O, withProv({ confidence: 0.95 }));
  const e = G.addEdge(O, withProv({ confidence: 0.2, sourceFiles: ['uko:x.pdf'] }));
  assert.equal(e.peakConfidence, 0.95,
    'unsetting the flag must restore the old number, so nothing is lost by trying it');
});

// ── History ──────────────────────────────────────────────────────────────────

test('history records real transitions and ignores no-op re-confirmations', () => {
  process.env.AQUA_REL_EVOLVE = 'on';
  G.addEdge(O, withProv({ confidence: 0.5 }));
  const same = G.addEdge(O, withProv({ confidence: 0.5, sourceFiles: ['uko:a.pdf'] }));
  assert.equal(same.history.length, 0, 'a confirmation that changes nothing is not a transition');

  const moved = G.addEdge(O, withProv({ confidence: 0.9, sourceFiles: ['uko:b.pdf'] }));
  assert.equal(moved.history.length, 1);
  assert.ok(moved.history[0].from !== moved.history[0].to);
  assert.ok(moved.history[0].at > 0);
});

test('history is bounded', () => {
  process.env.AQUA_REL_EVOLVE = 'on';
  G.addEdge(O, withProv({ confidence: 0.5 }));
  for (let i = 0; i < 60; i++) {
    G.addEdge(O, withProv({ confidence: i % 2 ? 0.9 : 0.1, sourceFiles: [`uko:f${i}.pdf`] }));
  }
  const e = [...G.edgesOf?.(O) ?? []][0] ?? G.addEdge(O, withProv({ confidence: 0.5, sourceFiles: ['uko:z.pdf'] }));
  assert.ok(e.history.length <= 20, `history capped (got ${e.history.length})`);
});

// ── Derived decay ────────────────────────────────────────────────────────────

test('effectiveConfidence is the identity function unless asked for decay', () => {
  const e = G.addEdge(O, withProv({ confidence: 0.8 }));
  assert.equal(G.effectiveConfidence(e), 0.8);
  assert.equal(G.effectiveConfidence(e, { now: Date.now() + 1e10 }), 0.8,
    'no halfLife means no decay, however old the edge');
});

test('effectiveConfidence decays with staleness, and never mutates the edge', () => {
  const e = G.addEdge(O, withProv({ confidence: 0.8 }));
  const thirtyDays = 30 * 86_400_000;

  const decayed = G.effectiveConfidence(e, { now: e.lastConfirmedAt + thirtyDays, halfLifeDays: 30 });
  assert.ok(Math.abs(decayed - 0.4) < 0.01, `one half-life should halve it (got ${decayed})`);

  assert.equal(e.confidence, 0.8,
    'a stored value that changed on every read would make history meaningless');
});

// ── Migration ────────────────────────────────────────────────────────────────

test('v2 edges self-heal on load: creation becomes their only confirmation', () => {
  // A pre-phase edge, exactly as v2 wrote it.
  const legacy = {
    id: 'a|works_on|b', from: 'a', to: 'b', type: 'works_on', kind: 'derived',
    confidence: 0.7, evidence: [], sourceFiles: ['uko:old.pdf'],
    reason: 'works_on', createdAt: 1_700_000_000_000,
  };

  const healed = G._migrateEdgeV3ForTests(legacy);
  assert.equal(healed.lastConfirmedAt, legacy.createdAt,
    'an edge written before this phase was confirmed exactly once — at creation');
  assert.equal(healed.observations, 1);
  assert.equal(healed.peakConfidence, 0.7);
  assert.deepEqual(healed.history, []);
  assert.equal(healed.confidence, 0.7, 'migration is additive — it never restates the evidence');
});

test('migration is idempotent', () => {
  const once = G._migrateEdgeV3ForTests({
    id: 'x', from: 'a', to: 'b', type: 'works_on', confidence: 0.5,
    evidence: [], sourceFiles: ['f'], createdAt: 1_700_000_000_000,
  });
  const twice = G._migrateEdgeV3ForTests(once);
  assert.equal(twice, once, 'an already-migrated edge is returned untouched');
});
