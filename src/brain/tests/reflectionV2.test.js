/**
 * Brain V1 / B5 — Reflection Engine V2.
 *
 * The guarantees under test:
 *   STRUCTURED     reflection emits a WorldDelta object — typed arrays of
 *                  what changed — not a text summary. The brief's core rule.
 *   ENTITY/REL DIFF entities added/corroborated/typed and relationships
 *                  added/strengthened/retyped are detected by diffing cheap
 *                  before/after graph fingerprints.
 *   OBSOLESCENCE   a newer claim that contradicts an older fact marks the
 *                  older one obsolete — using the graph's OWN contradiction
 *                  detector, not a divergent notion.
 *   REVERSIBLE     application archives (never deletes) via lifecycle
 *                  transitions; the fact itself is untouched.
 *   COMPOSITION    the Mind's reflection report (goals/beliefs) is folded in,
 *                  not recomputed.
 *   FAIL-OPEN      a broken store returns an empty delta, never throws.
 *   OFF BY DEFAULT AQUA_REFLECT_V2=on applies; off = dry-run (computed, not written).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { snapshotGraph, diffSnapshots, detectObsolescence, computeWorldDelta } = await import('../reflectionV2/deltaReflector.js');
const { applyWorldDelta } = await import('../reflectionV2/deltaApplier.js');
const RV2 = await import('../reflectionV2/index.js');

// ── Graph stub: entities + semantic edges, shaped like reasoningGraph reads ──

function makeGraph(entities = [], edges = []) {
  return {
    nodesByType: (_o, type) => (type === 'entity' ? entities : []),
    edgesOf: (_o, nodeId, { type } = {}) => {
      if (type !== 'related_to') return [];
      return edges.filter(e => e.from === nodeId || e.to === nodeId);
    },
  };
}
const ent = (id, label, sourceFiles = ['f1'], entityType = null) => ({ id, label, sourceFiles, data: { entityType } });
const edge = (id, from, to, type, confidence = 0.6) => ({ id, from, to, type, confidence });

beforeEach(() => { RV2._resetReflectionV2ForTests(); delete process.env.AQUA_REFLECT_V2; delete process.env.AQUA_BRAIN; });
afterEach(() => { delete process.env.AQUA_REFLECT_V2; delete process.env.AQUA_BRAIN; });

// ── STRUCTURED, NOT TEXT ─────────────────────────────────────────────────────

test('STRUCTURED: the reflection artifact is a WorldDelta object, not a summary string', () => {
  const before = { nodes: new Map(), edges: new Map(), takenAt: 0 };
  const after = snapshotGraph({ graph: makeGraph([ent('e1', 'AQUA', ['f1', 'f2'])]) }, 'o');
  const diff = diffSnapshots(before, after);
  const delta = computeWorldDelta({ diff, obsolescence: { obsoleted: [], assumptionsRevised: [] } });

  for (const k of ['entitiesChanged', 'relationshipsChanged', 'goalsChanged', 'beliefsChanged',
    'assumptionsRevised', 'obsoleted', 'worldModelUpdated']) {
    assert.ok(k in delta, `WorldDelta missing ${k}`);
  }
  assert.ok(Array.isArray(delta.entitiesChanged), 'entitiesChanged is structured, not prose');
  assert.equal(typeof delta.worldModelUpdated, 'boolean');
  // The summary is metadata DERIVED from the delta, never the artifact itself.
  assert.equal(typeof delta.summary, 'string');
});

// ── ENTITY / RELATIONSHIP DIFF ───────────────────────────────────────────────

test('entities: added, corroborated, and typed are each detected', () => {
  const before = snapshotGraph({ graph: makeGraph([
    ent('e1', 'AQUA', ['f1']),          // will gain a source
    ent('e2', 'OldThing', ['f1']),      // unchanged
    ent('e3', 'Untyped', ['f1'], null), // will gain a type
  ]) }, 'o');
  const after = snapshotGraph({ graph: makeGraph([
    ent('e1', 'AQUA', ['f1', 'f2']),
    ent('e2', 'OldThing', ['f1']),
    ent('e3', 'Untyped', ['f1'], 'organization'),
    ent('e4', 'BrandNew', ['f3']),      // added
  ]) }, 'o');

  const { entitiesChanged } = diffSnapshots(before, after);
  const byChange = Object.fromEntries(entitiesChanged.map(e => [e.change, e]));
  assert.ok(byChange.added && byChange.added.id === 'e4');
  assert.ok(byChange.corroborated && byChange.corroborated.to === 2);
  assert.ok(byChange.typed && byChange.typed.to === 'organization');
  assert.ok(!entitiesChanged.some(e => e.id === 'e2'), 'unchanged entity not reported');
});

test('relationships: added, strengthened, and retyped are each detected', () => {
  const before = snapshotGraph({ graph: makeGraph(
    [ent('a', 'A'), ent('b', 'B'), ent('c', 'C')],
    [edge('r1', 'a', 'b', 'related_to', 0.5), edge('r2', 'a', 'c', 'works_on', 0.6)],
  ) }, 'o');
  const after = snapshotGraph({ graph: makeGraph(
    [ent('a', 'A'), ent('b', 'B'), ent('c', 'C')],
    [edge('r1', 'a', 'b', 'works_on', 0.5),   // retyped generic→specific
     edge('r2', 'a', 'c', 'works_on', 0.9),   // strengthened
     edge('r3', 'b', 'c', 'depends_on', 0.7)], // added
  ) }, 'o');

  const { relationshipsChanged } = diffSnapshots(before, after);
  const byChange = Object.fromEntries(relationshipsChanged.map(r => [r.change, r]));
  assert.ok(byChange.added && byChange.added.id === 'r3');
  assert.ok(byChange.retyped && byChange.retyped.fromType === 'related_to' && byChange.retyped.type === 'works_on');
  assert.ok(byChange.strengthened && byChange.strengthened.to > byChange.strengthened.from);
});

test('worldModelUpdated is false on a no-op reflection', () => {
  const g = makeGraph([ent('e1', 'AQUA', ['f1'])]);
  const snap = snapshotGraph({ graph: g }, 'o');
  const delta = computeWorldDelta({ diff: diffSnapshots(snap, snap), obsolescence: { obsoleted: [], assumptionsRevised: [] } });
  assert.equal(delta.worldModelUpdated, false);
  assert.equal(delta.summary, 'no structural change');
});

// ── OBSOLESCENCE ─────────────────────────────────────────────────────────────

test('OBSOLESCENCE: a newer contradicting fact obsoletes the older one', () => {
  const facts = [
    { id: 'old', statement: 'Revenue was 100', entities: ['Acme'], createdAt: 1000 },
    { id: 'new', statement: 'Revenue was 200', entities: ['Acme'], createdAt: 5000 },
  ];
  const ES = {
    listFacts: () => facts,
    getFact: (_o, id) => facts.find(f => f.id === id) ?? null,
    evidenceForFact: () => [{ id: 'ev', sourceFileId: 'f1' }],
  };
  const deps = {
    evidenceStore: ES,
    buildEntitiesForOwner: () => [{ id: 'ent:name:acme', canonical: 'Acme', type: 'name', aliases: [], files: new Set(['f1']) }],
    detectContradictions: () => [{ entity: 'Acme', type: 'numeric', factIds: ['old', 'new'], reason: 'numeric disagreement' }],
  };

  const { obsoleted, assumptionsRevised } = detectObsolescence(deps, 'o', { since: 2000 });
  assert.equal(obsoleted.length, 1);
  assert.equal(obsoleted[0].factId, 'old', 'the OLDER fact is obsoleted');
  assert.equal(obsoleted[0].supersededBy, 'new', 'by the newer one');
  assert.equal(assumptionsRevised[0].subject, 'Acme');
});

test('OBSOLESCENCE window: a contradiction older than the last reflection is NOT re-obsoleted', () => {
  const facts = [
    { id: 'old', statement: 'X is 1', entities: ['X'], createdAt: 100 },
    { id: 'newish', statement: 'X is 2', entities: ['X'], createdAt: 500 },
  ];
  const ES = { listFacts: () => facts, getFact: (_o, id) => facts.find(f => f.id === id), evidenceForFact: () => [{ id: 'ev', sourceFileId: 'f1' }] };
  const deps = {
    evidenceStore: ES,
    buildEntitiesForOwner: () => [{ id: 'ent:name:x', canonical: 'X', type: 'name', aliases: [], files: new Set(['f1']) }],
    detectContradictions: () => [{ entity: 'X', type: 'numeric', factIds: ['old', 'newish'], reason: 'n' }],
  };
  // Both facts predate the reflection cutoff → standing contradiction, not new.
  assert.equal(detectObsolescence(deps, 'o', { since: 1000 }).obsoleted.length, 0);
});

// ── REVERSIBLE APPLICATION ───────────────────────────────────────────────────

test('REVERSIBLE: application archives via a lifecycle transition, never deletes', () => {
  const transitions = [];
  const annotations = [];
  const deps = {
    transition: (o, subject, to, opts) => { transitions.push({ subject, to, reason: opts.reason }); return { ok: true }; },
    annotate: (o, eid, patch) => { annotations.push({ eid, patch }); return {}; },
  };
  const delta = {
    obsoleted: [{ factId: 'old', supersededBy: 'new', entity: 'Acme', reason: 'numeric conflict' }],
    assumptionsRevised: [{ subject: 'Acme', from: 'Revenue was 100', to: 'Revenue was 200', reason: 'numeric conflict' }],
  };

  const report = applyWorldDelta(deps, 'o', delta);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].subject, 'fact:old');
  assert.equal(transitions[0].to, 'archived', 'archived — reversible — not deleted');
  assert.match(transitions[0].reason, /superseded by fact:new/);
  assert.equal(report.archived.length, 1);
  assert.equal(report.annotated.length, 1, 'the revision is noted on the entity');
});

test('a refused transition is recorded as skipped, not crashed', () => {
  const deps = { transition: () => ({ ok: false, reason: 'illegal transition' }), annotate: () => ({}) };
  const report = applyWorldDelta(deps, 'o', { obsoleted: [{ factId: 'x', supersededBy: 'y', reason: 'r' }], assumptionsRevised: [] });
  assert.equal(report.archived.length, 0);
  assert.equal(report.skipped.length, 1);
});

test('assumption revisions are grouped per entity into one note', () => {
  const annotations = [];
  const deps = { transition: () => ({ ok: true }), annotate: (o, eid, patch) => annotations.push({ eid, patch }) };
  const delta = {
    obsoleted: [],
    assumptionsRevised: [
      { subject: 'Acme', from: 'a', to: 'b', reason: 'r1' },
      { subject: 'Acme', from: 'c', to: 'd', reason: 'r2' },
    ],
  };
  applyWorldDelta(deps, 'o', delta);
  assert.equal(annotations.length, 1, 'one consolidated note for the entity, not two');
  assert.match(annotations[0].patch.metadata.lastRevisionNote, /revised/);
});

// ── COMPOSITION ──────────────────────────────────────────────────────────────

test('COMPOSITION: the Mind reflection report is folded in, not recomputed', () => {
  const before = { nodes: new Map(), edges: new Map(), takenAt: 0 };
  const after = { nodes: new Map(), edges: new Map(), takenAt: 1 };
  const mindReport = {
    goalsStaled: ['ship v2'],
    learned: [{ key: 'prefers_typescript', value: true, confidence: 0.8 }],
    weakened: [{ key: 'uses_python', from: 0.6, to: 0.4 }],
    archived: ['old_belief'],
  };
  const delta = computeWorldDelta({ diff: diffSnapshots(before, after), obsolescence: { obsoleted: [], assumptionsRevised: [] }, mindReport });
  assert.deepEqual(delta.goalsChanged, [{ title: 'ship v2', change: 'staled' }]);
  const beliefChanges = Object.fromEntries(delta.beliefsChanged.map(b => [b.change, b]));
  assert.ok(beliefChanges.established && beliefChanges.weakened && beliefChanges.archived);
});

// ── ORCHESTRATOR ─────────────────────────────────────────────────────────────

test('orchestrator: diffs against the previous snapshot per owner', () => {
  process.env.AQUA_REFLECT_V2 = 'on';
  // First reflection: one entity. Establishes the baseline snapshot.
  let entities = [ent('e1', 'AQUA', ['f1'])];
  const deps = {
    graph: { nodesByType: (_o, t) => (t === 'entity' ? entities : []), edgesOf: () => [] },
    evidenceStore: { listFacts: () => [] },
    detectContradictions: () => [],
    buildEntitiesForOwner: () => [],
    transition: () => ({ ok: true }),
    annotate: () => ({}),
  };
  const first = RV2.reflectWorldModel(deps, 'o');
  assert.equal(first.delta.entitiesChanged.length, 1, 'first pass: entity is new vs empty baseline');

  // Second reflection after a new entity appears: only the NEW one is a delta.
  entities = [ent('e1', 'AQUA', ['f1']), ent('e2', 'New', ['f2'])];
  const second = RV2.reflectWorldModel(deps, 'o');
  assert.equal(second.delta.entitiesChanged.length, 1);
  assert.equal(second.delta.entitiesChanged[0].id, 'e2', 'only the new entity, not e1 again');
});

test('OFF BY DEFAULT: without the switch the delta is a dry-run — computed, not applied', () => {
  const transitions = [];
  const entities = [ent('e1', 'AQUA', ['f1'])];
  const deps = {
    graph: { nodesByType: (_o, t) => (t === 'entity' ? entities : []), edgesOf: () => [] },
    evidenceStore: { listFacts: () => [] },
    detectContradictions: () => [], buildEntitiesForOwner: () => [],
    transition: (...a) => { transitions.push(a); return { ok: true }; },
    annotate: () => ({}),
  };
  assert.equal(RV2.reflectV2Enabled(), false);
  const out = RV2.reflectWorldModel(deps, 'o');
  assert.ok(out.delta, 'delta still computed for observability');
  assert.equal(out.applied, false, 'but not applied');
  assert.equal(transitions.length, 0, 'no writes when disabled');
});

test('the read-side kill switch disables application', () => {
  process.env.AQUA_REFLECT_V2 = 'on';
  process.env.AQUA_BRAIN = 'off';
  assert.equal(RV2.reflectV2Enabled(), false);
});

test('FAIL-OPEN: a broken graph returns an empty delta, never throws', () => {
  const deps = { graph: { nodesByType: () => { throw new Error('boom'); } } };
  const out = RV2.reflectWorldModel(deps, 'o');
  assert.equal(out.delta, null);
  assert.equal(out.applied, false);
  assert.ok(out.error, 'error captured');
});

test('forgetOwner drops snapshot state (account deletion)', () => {
  process.env.AQUA_REFLECT_V2 = 'on';
  const deps = { graph: { nodesByType: (_o, t) => (t === 'entity' ? [ent('e1', 'X')] : []), edgesOf: () => [] }, evidenceStore: { listFacts: () => [] }, detectContradictions: () => [], buildEntitiesForOwner: () => [], transition: () => ({ ok: true }), annotate: () => ({}) };
  RV2.reflectWorldModel(deps, 'o');
  assert.ok(RV2.reflectionV2Metrics().trackedOwners >= 1);
  RV2.forgetOwner('o');
  // After forget, the next reflection re-treats the entity as new.
  const out = RV2.reflectWorldModel(deps, 'o');
  assert.equal(out.delta.entitiesChanged.length, 1, 'baseline was forgotten');
});
