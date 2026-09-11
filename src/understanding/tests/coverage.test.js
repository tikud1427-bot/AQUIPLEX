/**
 * UUS U4 — server-side coverage (node:test).
 * Run: node --test src/understanding/tests/coverage.test.js
 *
 * THE MOVE, NOT AN IMPROVEMENT
 * ----------------------------
 * `understandingScore` lived in the frontend store, so the server could not
 * read the number that is supposed to steer follow-up questions, and the card
 * and the dashboard were one edit away from disagreeing about how well AQUA
 * knows someone.
 *
 * The formula is preserved EXACTLY, constants included. The parity test below
 * is the point of this suite: it re-implements the client version verbatim and
 * asserts the two agree on shared fixtures. If someone later improves the
 * formula, that test tells them they are changing the number — which is the
 * information you want at that moment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  understandingScore, dimensionCoverage, unknownAreas, buildCoverage,
  confidenceLabel, COVERAGE_DIMENSIONS,
} from '../coverage.js';

const belief = (confidence, evidenceCount = 1, status = 'active') => ({ confidence, evidenceCount, status });

/** The client implementation, transcribed verbatim from stores/mindStore.ts. */
function clientScore(m) {
  const DIMS = COVERAGE_DIMENSIONS;
  const all = DIMS.flatMap(d => m[d] ?? []);
  const beliefs = all.filter(b => b.status !== 'archived');
  if (!beliefs.length && !m.goals.length) return 0;
  const avgConf = beliefs.length ? beliefs.reduce((s, b) => s + b.confidence, 0) / beliefs.length : 0;
  const coverage = DIMS.filter(d => (m[d] ?? []).some(b => b.status !== 'archived')).length / DIMS.length;
  const goalSignal = Math.min(1, m.goals.filter(g => g.status === 'active' || g.status === 'blocked').length / 3);
  const depth = Math.min(1, beliefs.reduce((s, b) => s + b.evidenceCount, 0) / 60);
  return Math.round(100 * (0.45 * avgConf + 0.25 * coverage + 0.15 * depth + 0.15 * goalSignal));
}

const FIXTURES = [
  { name: 'empty', identity: [], goals: [] },
  {
    name: 'one stated fact',
    identity: [belief(0.9, 1)],
    goals: [],
  },
  {
    name: 'a real early account',
    identity: [belief(0.9, 3), belief(0.35, 1)],
    communication: [belief(0.53, 4)],
    knowledge: [belief(0.3, 2)],
    goals: [{ status: 'active' }],
  },
  {
    name: 'well understood',
    identity: [belief(0.9, 12), belief(0.8, 9)],
    personality: [belief(0.7, 6)],
    communication: [belief(0.85, 11)],
    preferences: [belief(0.6, 5)],
    knowledge: [belief(0.75, 14)],
    behavior: [belief(0.5, 4)],
    decision: [belief(0.65, 7)],
    goals: [{ status: 'active' }, { status: 'active' }, { status: 'blocked' }],
  },
  {
    name: 'archived beliefs are excluded',
    identity: [belief(0.9, 5), belief(0.1, 40, 'archived')],
    goals: [{ status: 'completed' }],
  },
];

const asArgs = (f) => ({
  beliefsByDimension: Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, f[d] ?? []])),
  goals: f.goals,
});

// ── 1. Parity — the whole reason this suite exists ───────────────────────────

test('U4: the server score matches the client formula exactly', () => {
  for (const f of FIXTURES) {
    const model = Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, f[d] ?? []]));
    model.goals = f.goals;
    assert.equal(
      understandingScore(asArgs(f)), clientScore(model),
      `score drifted on fixture: ${f.name}`,
    );
  }
});

test('U4: an empty model scores zero, not NaN', () => {
  assert.equal(understandingScore({}), 0);
  assert.equal(understandingScore({ beliefsByDimension: {}, goals: [] }), 0);
});

test('U4: goals accept both an array and the Mind\'s keyed object', () => {
  // mind.goals is an object keyed by id; the client saw an array. Both must
  // work or the number changes depending on which caller asked.
  const beliefsByDimension = { identity: [belief(0.9, 2)] };
  const arr = [{ status: 'active' }, { status: 'active' }];
  const obj = { g1: { status: 'active' }, g2: { status: 'active' } };
  assert.equal(
    understandingScore({ beliefsByDimension, goals: arr }),
    understandingScore({ beliefsByDimension, goals: obj }),
  );
});

test('U4: malformed input degrades to a number, never throws', () => {
  // This feeds a user-facing screen. A 500 on the page whose job is to make
  // someone feel understood is the worst possible failure mode.
  const junk = [
    { beliefsByDimension: { identity: [{ confidence: null, evidenceCount: undefined }] }, goals: null },
    { beliefsByDimension: { identity: [null] }, goals: [null] },
    { beliefsByDimension: null, goals: undefined },
  ];
  for (const j of junk) {
    const v = understandingScore(j);
    assert.ok(Number.isFinite(v), `expected a finite score, got ${v}`);
    assert.ok(v >= 0 && v <= 100);
  }
});

// ── 2. Per-dimension coverage ────────────────────────────────────────────────

test('U4: every dimension is reported, including empty ones', () => {
  const cov = dimensionCoverage({ identity: [belief(0.9)] });
  assert.deepEqual(Object.keys(cov).sort(), [...COVERAGE_DIMENSIONS].sort());
  assert.equal(cov.identity.count, 1);
  assert.equal(cov.knowledge.count, 0);
  assert.equal(cov.knowledge.avg, 0);
});

test('U4: archived beliefs do not count toward a dimension', () => {
  const cov = dimensionCoverage({ identity: [belief(0.9), belief(0.1, 1, 'archived')] });
  assert.equal(cov.identity.count, 1);
  assert.equal(cov.identity.avg, 0.9);
});

// ── 3. Confidence as language ────────────────────────────────────────────────

test('U4: confidence reads as words, with the number secondary', () => {
  // A bare "22%" beside "Marketing" on a first-run screen reads as a scorecard
  // the user is failing.
  assert.equal(confidenceLabel(0.9), 'confident');
  assert.equal(confidenceLabel(0.7), 'fairly sure');
  assert.equal(confidenceLabel(0.5), 'still learning');
  assert.equal(confidenceLabel(0.22), 'just guessing');
  assert.equal(confidenceLabel(0), 'nothing yet');
});

// ── 4. Unknown areas ─────────────────────────────────────────────────────────

test('U4: an empty dimension outranks a weak one', () => {
  const u = unknownAreas({
    beliefsByDimension: { identity: [belief(0.2)] },   // weak
    goals: [{ status: 'active' }],
  });
  const identity = u.find(x => x.id === 'dim:identity');
  const knowledge = u.find(x => x.id === 'dim:knowledge');
  assert.ok(knowledge.weight > identity.weight, 'nothing known beats barely known');
});

test('U4: having no goal is the single biggest gap', () => {
  const u = unknownAreas({ beliefsByDimension: {}, goals: [] });
  assert.equal(u[0].id, 'goals:none');
});

test('U4: a well-understood dimension raises no gap', () => {
  const u = unknownAreas({
    beliefsByDimension: Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, [belief(0.9)]])),
    goals: [{ status: 'active' }],
  });
  assert.equal(u.length, 0);
});

test('U4: identity gaps from the memory reasoner are carried through', () => {
  const u = unknownAreas({
    beliefsByDimension: Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, [belief(0.9)]])),
    goals: [{ status: 'active' }],
    gaps: { identityMissing: ['role', 'company'] },
  });
  assert.deepEqual(u.map(x => x.id), ['identity:company', 'identity:role']);
});

// ── 5. The composed read model ───────────────────────────────────────────────

test('U4: buildCoverage returns one consistent object', () => {
  const c = buildCoverage(asArgs(FIXTURES[2]));
  assert.equal(typeof c.score, 'number');
  assert.equal(c.confidence, confidenceLabel(c.score / 100));
  assert.equal(Object.keys(c.dimensions).length, COVERAGE_DIMENSIONS.length);
  assert.ok(Array.isArray(c.unknowns));
});

test('U4: coverage.js is pure — it cannot reach a store', async () => {
  // Same discipline as conversationFacts: the interviewer, the card and the
  // dashboard all call this, and none of them should need store stubs to do it.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../coverage.js', import.meta.url), 'utf8');
  assert.equal(
    /^(?:import|export)\s[^;]*?from\s/m.test(src), false,
    'coverage.js must have zero imports',
  );
});
