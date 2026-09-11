/**
 * Brain V1 / B1 — extensible graph type vocabulary.
 *
 * Four guarantees under test:
 *   1. EXTENSIBLE   — an unregistered relationship type is accepted, not
 *                     thrown on. The brief's hard requirement.
 *   2. BACK-COMPAT  — consumers written against the flattened `related_to`
 *                     vocabulary keep returning the same edges now that the
 *                     graph stores true types (class expansion).
 *   3. MIGRATING    — pre-B1 stores, where the true type was demoted into
 *                     the reason string, self-heal on load and on re-insert.
 *   4. STILL GUARDED — malformed type names, node-type typos, and structural
 *                     reclassification are all still rejected.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-typereg-'));
process.env.AQUA_DATA_DIR = TMP;

// ── Seed a PRE-B1 (schema v1) store on disk so the load-time migration runs
// ── against realistic legacy data: type flattened, true type in the reason.
const LEGACY = {
  __aqua: { schema: 1, savedAt: new Date().toISOString() },
  data: {
    legacyowner: {
      nodes: {
        'e:a': { id: 'e:a', type: 'entity', label: 'Ananya', kind: 'derived', data: {}, sourceFiles: ['f1'], createdAt: 1 },
        'e:b': { id: 'e:b', type: 'entity', label: 'AQUA', kind: 'derived', data: {}, sourceFiles: ['f1'], createdAt: 1 },
        'e:c': { id: 'e:c', type: 'entity', label: 'Aquiplex', kind: 'derived', data: {}, sourceFiles: ['f1'], createdAt: 1 },
        'f:1': { id: 'f:1', type: 'file', label: 'spec.pdf', kind: 'derived', data: {}, sourceFiles: ['f1'], createdAt: 1 },
      },
      edges: {
        // Recoverable: prefix is a registered semantic type.
        'rel:e:a|e:b': { id: 'rel:e:a|e:b', from: 'e:a', to: 'e:b', type: 'related_to', kind: 'derived', confidence: 0.8, evidence: ['ev1'], sourceFiles: ['f1'], reason: 'works_on: co-mentioned in 3 fact(s) across 2 file(s)', createdAt: 1 },
        // Not recoverable: prefix is not a registered type — must be left alone.
        'rel:e:a|e:c': { id: 'rel:e:a|e:c', from: 'e:a', to: 'e:c', type: 'related_to', kind: 'derived', confidence: 0.6, evidence: ['ev2'], sourceFiles: ['f1'], reason: 'vibes: they seem connected', createdAt: 1 },
        // Structural: never touched by the migration.
        'f:1|mentions|e:a': { id: 'f:1|mentions|e:a', from: 'f:1', to: 'e:a', type: 'mentions', kind: 'observed', confidence: 1, evidence: [], sourceFiles: ['f1'], reason: 'appears in spec.pdf', createdAt: 1 },
      },
      byFile: { f1: { nodes: ['e:a', 'e:b', 'e:c', 'f:1'], edges: ['rel:e:a|e:b', 'rel:e:a|e:c', 'f:1|mentions|e:a'] } },
    },
  },
};
fs.writeFileSync(path.join(TMP, '.aqua-reasoning-graph.json'), JSON.stringify(LEGACY));

const G = await import('../reasoningGraph.js');
const R = await import('../typeRegistry.js');

// Migration happens at import. Snapshot before any test resets the store.
const MIGRATED = {
  works: G.getNode('legacyowner', 'e:a') ? G.edgesOf('legacyowner', 'e:a', { type: 'works_on', exact: true }) : [],
  unrecovered: G.edgesOf('legacyowner', 'e:c', { type: 'related_to', exact: true }),
  structural: G.edgesOf('legacyowner', 'f:1', { type: 'mentions', exact: true }),
  stats: G.graphStats('legacyowner'),
};

beforeEach(() => { G._resetGraphForTests(); R._resetRegistryForTests(); });

// ── 1. EXTENSIBLE ────────────────────────────────────────────────────────────

test('B1: addEdge accepts a relationship type nobody registered (no hardcoded vocabulary)', () => {
  G.upsertNode('o', { id: 'a', type: 'entity', label: 'A' });
  G.upsertNode('o', { id: 'b', type: 'entity', label: 'B' });

  const e = G.addEdge('o', { from: 'a', to: 'b', type: 'mentored_by', confidence: 0.7, sourceFiles: ['f1'] });

  assert.equal(e.type, 'mentored_by', 'stored as its own type, not flattened');
  assert.ok(R.isKnownEdgeType('mentored_by'), 'auto-registered on first use');
  assert.equal(R.edgeClassOf('mentored_by'), R.EDGE_CLASS.RELATED, 'auto-registered types are semantic');
  assert.ok(R.registryStats().autoRegistered.includes('mentored_by'), 'auto-registration is auditable');
});

test('B1: every relationship type named in the brief is available out of the box', () => {
  const required = ['created_by', 'belongs_to', 'works_on', 'depends_on', 'mentions', 'related_to',
    'implements', 'uses', 'member_of', 'friend_of', 'parent_of', 'child_of', 'inspired_by', 'supports', 'blocks'];
  for (const t of required) assert.ok(R.isKnownEdgeType(t), `${t} seeded`);
});

test('registerEdgeType: explicit registration carries metadata and is idempotent', () => {
  R.registerEdgeType('reviews', { description: 'person reviews artifact', inverse: 'reviewed_by' });
  R.registerEdgeType('reviews', { symmetric: false });
  const meta = R.edgeTypeMeta('reviews');
  assert.equal(meta.class, R.EDGE_CLASS.RELATED);
  assert.equal(meta.inverse, 'reviewed_by', 'metadata survives re-registration');
  assert.equal(R.listEdgeTypes().filter(t => t.type === 'reviews').length, 1, 'no duplicate entry');
});

// ── 2. BACK-COMPAT ───────────────────────────────────────────────────────────

test('BACK-COMPAT: a query for related_to still returns the now-typed edges', () => {
  for (const id of ['p', 'proj', 'org']) G.upsertNode('o', { id, type: 'entity', label: id });
  G.addEdge('o', { from: 'p', to: 'proj', type: 'works_on', confidence: 0.8, sourceFiles: ['f1'] });
  G.addEdge('o', { from: 'org', to: 'proj', type: 'owns', confidence: 0.7, sourceFiles: ['f1'] });

  // This is exactly the call queryEngine.explainEntity makes — unchanged.
  const rels = G.edgesOf('o', 'proj', { type: 'related_to' });
  assert.equal(rels.length, 2, 'class expansion keeps the pre-B1 consumer whole');
  assert.deepEqual(rels.map(e => e.type).sort(), ['owns', 'works_on'], 'and it now sees the real types');
});

test('exact:true opts out of class expansion', () => {
  for (const id of ['p', 'proj']) G.upsertNode('o', { id, type: 'entity', label: id });
  G.addEdge('o', { from: 'p', to: 'proj', type: 'works_on', confidence: 0.8, sourceFiles: ['f1'] });
  G.addEdge('o', { from: 'p', to: 'proj', type: 'related_to', confidence: 0.5, sourceFiles: ['f1'] });

  assert.equal(G.edgesOf('o', 'p', { type: 'related_to', exact: true }).length, 1, 'literal type only');
  assert.equal(G.edgesOf('o', 'p', { type: 'related_to' }).length, 2, 'class match');
});

test('structural class does not leak into the semantic class', () => {
  G.upsertNode('o', { id: 'f:1', type: 'file', label: 'a.pdf' });
  G.upsertNode('o', { id: 'e:1', type: 'entity', label: 'X' });
  G.addEdge('o', { from: 'f:1', to: 'e:1', type: 'mentions', confidence: 1, sourceFiles: ['1'] });
  G.addEdge('o', { from: 'e:1', to: 'f:1', type: 'uses', confidence: 1, sourceFiles: ['1'] });

  assert.deepEqual(G.edgesOf('o', 'e:1', { type: 'related_to' }).map(e => e.type), ['uses']);
  assert.deepEqual(G.edgesOf('o', 'e:1', { type: 'structural' }).map(e => e.type), ['mentions']);
});

test('traverse expands edgeTypes by class too', () => {
  for (const id of ['a', 'b', 'c']) G.upsertNode('o', { id, type: 'entity', label: id });
  G.upsertNode('o', { id: 'f:1', type: 'file', label: 'f' });
  G.addEdge('o', { from: 'a', to: 'b', type: 'works_on', confidence: 1, sourceFiles: ['f'] });
  G.addEdge('o', { from: 'b', to: 'c', type: 'depends_on', confidence: 1, sourceFiles: ['f'] });
  G.addEdge('o', { from: 'a', to: 'f:1', type: 'mentions', confidence: 1, sourceFiles: ['f'] });

  const walk = G.traverse('o', 'a', { maxHops: 3, edgeTypes: ['related_to'] });
  assert.deepEqual(walk.nodes.map(n => n.id).sort(), ['a', 'b', 'c'], 'semantic layer walked, file edge excluded');
});

test('expandEdgeTypes: null filter means no filter', () => {
  assert.equal(R.expandEdgeTypes(null), null);
  assert.ok(R.expandEdgeTypes('works_on').has('works_on'));
  assert.ok(!R.expandEdgeTypes('works_on').has('owns'), 'a concrete type does not pull in siblings');
});

// ── 3. MIGRATION ─────────────────────────────────────────────────────────────

test('MIGRATION: legacy related_to edges recover their true type on load', () => {
  assert.equal(MIGRATED.works.length, 1, 'the works_on edge was recovered');
  const e = MIGRATED.works[0];
  assert.equal(e.type, 'works_on');
  assert.equal(e.reason, 'co-mentioned in 3 fact(s) across 2 file(s)', 'type prefix stripped from reason');
  assert.equal(e.migratedFrom, 'related_to', 'migration is recorded, not silent');
  assert.equal(e.id, 'rel:e:a|e:b', 'edge id unchanged — no duplicate edge on next rebuild');
  assert.deepEqual(e.sourceFiles, ['f1'], 'provenance preserved');
});

test('MIGRATION is conservative: unknown prefixes and structural edges are untouched', () => {
  assert.equal(MIGRATED.unrecovered.length, 1);
  assert.equal(MIGRATED.unrecovered[0].type, 'related_to', '"vibes:" is not a registered type — left alone');
  assert.equal(MIGRATED.unrecovered[0].reason, 'vibes: they seem connected', 'reason untouched');
  assert.equal(MIGRATED.structural[0].type, 'mentions', 'structural edge unchanged');
  assert.equal(MIGRATED.stats.byEdgeType.works_on, 1, 'stats surface the recovered type');
});

test('MIGRATION: a stored generic edge upgrades in place when the specific type arrives', () => {
  // Type upgrade is independent of the confidence formula; pin the default so
  // AQUA_REL_EVOLVE cannot change what this test is actually about.
  delete process.env.AQUA_REL_EVOLVE;
  G.upsertNode('o', { id: 'a', type: 'entity', label: 'A' });
  G.upsertNode('o', { id: 'b', type: 'entity', label: 'B' });
  // Pinned id, as graphBuilder uses — so the two inserts are the SAME edge.
  G.addEdge('o', { id: 'rel:a|b', from: 'a', to: 'b', type: 'related_to', confidence: 0.5, sourceFiles: ['f1'], reason: 'co-mentioned' });
  const up = G.addEdge('o', { id: 'rel:a|b', from: 'a', to: 'b', type: 'works_on', confidence: 0.8, sourceFiles: ['f2'], reason: 'co-mentioned in 4 facts' });

  assert.equal(up.type, 'works_on', 'upgraded');
  assert.equal(up.reason, 'co-mentioned in 4 facts', 'reason follows the upgrade');
  assert.equal(up.confidence, 0.8, 'merge semantics still apply');
  assert.deepEqual(up.sourceFiles.sort(), ['f1', 'f2'], 'provenance still unions');
  assert.equal(G.graphStats('o').edges, 1, 'no duplicate edge created');
});

test('a specific type is never downgraded, and structural types are never reclassified', () => {
  G.upsertNode('o', { id: 'a', type: 'entity', label: 'A' });
  G.upsertNode('o', { id: 'b', type: 'entity', label: 'B' });
  G.addEdge('o', { id: 'r', from: 'a', to: 'b', type: 'works_on', confidence: 0.8, sourceFiles: ['f1'] });
  assert.equal(G.addEdge('o', { id: 'r', from: 'a', to: 'b', type: 'related_to', confidence: 0.9, sourceFiles: ['f2'] }).type, 'works_on');

  G.addEdge('o', { id: 's', from: 'a', to: 'b', type: 'mentions', confidence: 1, sourceFiles: ['f1'] });
  assert.equal(G.addEdge('o', { id: 's', from: 'a', to: 'b', type: 'works_on', confidence: 1, sourceFiles: ['f1'] }).type, 'mentions', 'structural edge holds its type');
});

// ── 4. STILL GUARDED ─────────────────────────────────────────────────────────

test('malformed type NAMES are still rejected (edge ids stay parseable)', () => {
  G.upsertNode('o', { id: 'a', type: 'entity', label: 'A' });
  G.upsertNode('o', { id: 'b', type: 'entity', label: 'B' });
  for (const bad of ['Works On', 'works|on', '', '9lives', 'ok-dash', null, 'x'.repeat(70)]) {
    assert.throws(() => G.addEdge('o', { from: 'a', to: 'b', type: bad, confidence: 1, sourceFiles: ['f'] }), /malformed/);
  }
});

test('the reasoning contract still has teeth: no provenance, no edge — whatever the type', () => {
  G.upsertNode('o', { id: 'a', type: 'entity', label: 'A' });
  G.upsertNode('o', { id: 'b', type: 'entity', label: 'B' });
  assert.throws(() => G.addEdge('o', { from: 'a', to: 'b', type: 'brand_new_type', confidence: 0.9 }), /no provenance/);
});

test('node types stay closed unless deliberately registered', () => {
  assert.throws(() => G.upsertNode('o', { id: 'x', type: 'martian', label: 'X' }), /bad type/);
  R.registerNodeType('conversation', { description: 'a chat thread' });
  const n = G.upsertNode('o', { id: 'c:1', type: 'conversation', label: 'thread' });
  assert.equal(n.type, 'conversation');
});

test('strict mode pins the vocabulary for CI runs', () => {
  process.env.AQUA_GRAPH_STRICT_TYPES = '1';
  try {
    G.upsertNode('o', { id: 'a', type: 'entity', label: 'A' });
    G.upsertNode('o', { id: 'b', type: 'entity', label: 'B' });
    assert.throws(() => G.addEdge('o', { from: 'a', to: 'b', type: 'never_seen', confidence: 1, sourceFiles: ['f'] }), /unregistered edge type/);
    assert.ok(G.addEdge('o', { from: 'a', to: 'b', type: 'works_on', confidence: 1, sourceFiles: ['f'] }), 'registered types unaffected');
  } finally {
    delete process.env.AQUA_GRAPH_STRICT_TYPES;
  }
});

test('registerEdgeType cannot reclassify a structural edge out from under the graph', () => {
  R.registerEdgeType('mentions', { class: R.EDGE_CLASS.RELATED, description: 'hostile takeover attempt' });
  assert.equal(R.edgeClassOf('mentions'), R.EDGE_CLASS.STRUCTURAL, 'class is immutable once seeded');
});

test('graphStats reports byEdgeType — the collapse is observably gone', () => {
  for (const id of ['a', 'b', 'c']) G.upsertNode('o', { id, type: 'entity', label: id });
  G.addEdge('o', { from: 'a', to: 'b', type: 'works_on', confidence: 1, sourceFiles: ['f'] });
  G.addEdge('o', { from: 'a', to: 'c', type: 'owns', confidence: 1, sourceFiles: ['f'] });
  assert.deepEqual(G.graphStats('o').byEdgeType, { works_on: 1, owns: 1 });
});