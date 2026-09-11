/**
 * Brain V1 / B2 — Unified World Model.
 *
 * The guarantees under test:
 *   FEDERATION   one entity assembled from the file-derived graph AND the
 *                conversation-derived Mind, joined on the normalized name.
 *   ENRICHMENT   the join yields something neither source has alone (a
 *                resolved entity that is also semantically typed and weighted).
 *   DERIVED      confidence and importance are computed from observable
 *                signals, never stored, never invented.
 *   SIDECAR      delete every annotation and no knowledge is lost.
 *   READ-ONLY    projecting never mutates the underlying graphs.
 *   FAIL-OPEN    a broken dependency returns empty, never throws.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-brain-'));
process.env.AQUA_DATA_DIR = TMP;

const G = await import('../../reasoning/reasoningGraph.js');
const A = await import('../worldModel/annotationStore.js');
const P = await import('../worldModel/projection.js');
const S = await import('../worldModel/schema.js');
const Brain = await import('../index.js');
const R = await import('../../reasoning/typeRegistry.js');

const O = 'owner-brain';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal evidenceStore stand-in — facts by id, nothing else needed. */
function mockEvidence(facts = []) {
  return { getFact: (_o, id) => facts.find(f => f.id === id) ?? null };
}

/** A Mind with a graph + timeline, shaped exactly like mindStore holds it. */
function mockMind({ nodes = {}, edges = {}, timeline = [] } = {}) {
  return () => ({ graph: { nodes, edges }, timeline });
}

function deps({ facts = [], mind = mockMind() } = {}) {
  return { graph: G, peekMind: mind, evidenceStore: mockEvidence(facts), annotations: A };
}

/** File side: a resolved entity with aliases + provenance, as graphBuilder writes it. */
function fileEntity(id, label, { aliases = [], files = ['f1'], resolutionConfidence = 1, entityType = 'name' } = {}) {
  return G.upsertNode(O, {
    id, type: 'entity', label, kind: 'derived',
    data: { entityType, aliases, resolutionConfidence, fileCount: files.length },
    sourceFiles: files,
  });
}

beforeEach(() => {
  G._resetGraphForTests();
  A._resetAnnotationsForTests();
  R._resetRegistryForTests();
});

// ── FEDERATION ───────────────────────────────────────────────────────────────

test('FEDERATION: one entity assembled from both graphs, joined on normalized name', () => {
  fileEntity('ent:name:aquiplex', 'Aquiplex Inc.', { aliases: ['Aquiplex'], files: ['f1', 'f2'] });
  const mind = mockMind({
    nodes: { 'organization:aquiplex': { type: 'organization', label: 'Aquiplex', weight: 6, createdAt: 1 } },
  });

  const e = P.projectEntity(deps({ mind }), O, 'ent:name:aquiplex');

  assert.equal(e.ids.reasoning, 'ent:name:aquiplex');
  assert.equal(e.ids.mind, 'organization:aquiplex', '"Aquiplex Inc." and "Aquiplex" joined — legal suffix normalized away');
  assert.equal(e.sourceRefs.mindKey, 'organization:aquiplex');
  assert.equal(P.worldStats(deps({ mind }), O).federated, 1);
});

test('ENRICHMENT: the join produces a type neither source could give alone', () => {
  // File side deliberately types every proper noun as 'name' to protect
  // entity identity; the Mind knows it is an organization.
  fileEntity('ent:name:aquiplex', 'Aquiplex', { entityType: 'name' });
  const mind = mockMind({ nodes: { 'organization:aquiplex': { type: 'organization', label: 'Aquiplex', weight: 3 } } });

  assert.equal(P.projectEntity(deps(), O, 'ent:name:aquiplex').type, 'name', 'file side alone: coarse');
  assert.equal(P.projectEntity(deps({ mind }), O, 'ent:name:aquiplex').type, 'organization', 'federated: semantic');
});

test('FEDERATION: entities present in only one graph still surface', () => {
  fileEntity('ent:name:contract', 'Contract Corp');
  const mind = mockMind({ nodes: { 'technology:react': { type: 'technology', label: 'React', weight: 9 } } });

  const all = P.projectEntities(deps({ mind }), O, {});
  const ids = all.map(e => e.id).sort();
  assert.deepEqual(ids, ['ent:name:contract', 'mind:technology:react']);

  const stats = P.worldStats(deps({ mind }), O);
  assert.deepEqual(stats, { entities: 2, fileOnly: 1, mindOnly: 1, federated: 0 });
});

test('the Mind\'s self node is not a world entity', () => {
  const mind = mockMind({ nodes: { 'person:__self__': { type: 'person', label: 'user', weight: 99 } } });
  assert.equal(P.projectEntities(deps({ mind }), O, {}).length, 0);
});

// ── SPEC SHAPE ───────────────────────────────────────────────────────────────

test('every field the brief specifies is present on an entity', () => {
  fileEntity('ent:name:aqua', 'AQUA', { aliases: ['Aqua Engine'], files: ['f1', 'f2'] });
  const e = P.projectEntity(deps(), O, 'ent:name:aqua');
  for (const field of ['id', 'type', 'title', 'aliases', 'description', 'metadata',
    'confidence', 'firstSeenAt', 'lastSeenAt', 'updatedAt', 'sourceRefs', 'importance']) {
    assert.ok(field in e, `missing ${field}`);
  }
  assert.ok(e.aliases.includes('Aqua Engine'));
  assert.deepEqual(e.sourceRefs.files, ['f1', 'f2'], 'source references preserved');
});

// ── DERIVED SCORING ──────────────────────────────────────────────────────────

test('DERIVED: importance rises with corroboration, connectedness and salience', () => {
  fileEntity('ent:name:thin', 'Thin', { files: ['f1'] });
  fileEntity('ent:name:thick', 'Thick', { files: ['f1', 'f2', 'f3', 'f4'] });
  fileEntity('ent:name:other', 'Other', { files: ['f1'] });
  G.addEdge(O, { from: 'ent:name:thick', to: 'ent:name:other', type: 'works_on', confidence: 0.8, sourceFiles: ['f1'] });
  const mind = mockMind({ nodes: { 'project:thick': { type: 'project', label: 'Thick', weight: 12 } } });

  const thin = P.projectEntity(deps({ mind }), O, 'ent:name:thin');
  const thick = P.projectEntity(deps({ mind }), O, 'ent:name:thick');
  assert.ok(thick.importance > thin.importance, `${thick.importance} > ${thin.importance}`);
  assert.ok(thick.importance <= 1 && thin.importance >= 0, 'bounded 0..1');
});

test('DERIVED: scores are reproducible, and the signals behind them are exposed', () => {
  fileEntity('ent:name:x', 'X', { files: ['f1', 'f2'] });
  const a = P.projectEntity(deps(), O, 'ent:name:x');
  const b = P.projectEntity(deps(), O, 'ent:name:x');
  assert.equal(a.importance, b.importance, 'derivation is deterministic — nothing is stored');
  assert.equal(a.signals.sourceCount, 2);
  assert.ok('importanceBreakdown' in a.metadata, 'the score is explainable, not a magic number');
});

test('DERIVED: confidence reflects resolution quality and corroboration', () => {
  fileEntity('ent:name:sure', 'Sure', { resolutionConfidence: 1, files: ['f1', 'f2', 'f3'] });
  fileEntity('ent:name:merged', 'Merged', { resolutionConfidence: 0.5, files: ['f1'] });
  assert.ok(P.projectEntity(deps(), O, 'ent:name:sure').confidence
    > P.projectEntity(deps(), O, 'ent:name:merged').confidence);
});

test('a mind-only entity starts low-confidence — chat mention is weaker than grounded extraction', () => {
  const mind = mockMind({ nodes: { 'person:zed': { type: 'person', label: 'Zed', weight: 1 } } });
  const e = P.projectEntity(deps({ mind }), O, 'mind:person:zed');
  assert.ok(e.confidence < 0.7, `${e.confidence} is appropriately unsure`);
  assert.ok(e.confidence > 0, 'but not zero — it was observed');
});

// ── RELATIONSHIPS ────────────────────────────────────────────────────────────

test('relationships from both graphs unify, and stay distinguishable by origin', () => {
  fileEntity('ent:name:ananya', 'Ananya');
  fileEntity('ent:name:aqua', 'AQUA');
  G.addEdge(O, { from: 'ent:name:ananya', to: 'ent:name:aqua', type: 'works_on', confidence: 0.8, sourceFiles: ['f1'], evidence: ['ev1'], reason: 'stated via "leads"' });
  const mind = mockMind({
    nodes: {
      'person:ananya': { type: 'person', label: 'Ananya', weight: 5 },
      'technology:react': { type: 'technology', label: 'React', weight: 4 },
    },
    edges: { 'person:ananya|uses|technology:react': { key: 'person:ananya|uses|technology:react', from: 'person:ananya', to: 'technology:react', type: 'uses', weight: 3, lastSeenAt: Date.now() } },
  });

  const rels = P.projectRelationships(deps({ mind }), O, 'ent:name:ananya');
  const byOrigin = Object.fromEntries(rels.map(r => [r.origin, r]));
  assert.equal(byOrigin.reasoning.type, 'works_on');
  assert.deepEqual(byOrigin.reasoning.evidence, ['ev1'], 'file-side provenance retained');
  assert.equal(byOrigin.mind.type, 'uses');
  assert.deepEqual(byOrigin.mind.evidence, [], 'conversational edges carry no provenance and never fake it');
  assert.equal(byOrigin.mind.weight, 3);
});

test('B1 registry absorbs the Mind\'s private vocabulary — one language, not two dialects', () => {
  // Registry was just re-seeded by beforeEach; a projection must restore the
  // mind vocabulary itself rather than relying on import order.
  P.buildWorldIndex(deps(), O);
  for (const t of ['works_with', 'part_of', 'interested_in', 'targets']) {
    assert.ok(R.isKnownEdgeType(t), `${t} registered from mindSchema`);
    assert.equal(R.edgeClassOf(t), R.EDGE_CLASS.RELATED);
  }
});

test('mind relationship endpoints resolve to federated ids when both sides know the entity', () => {
  fileEntity('ent:name:ananya', 'Ananya');
  const mind = mockMind({
    nodes: {
      'person:ananya': { type: 'person', label: 'Ananya', weight: 5 },
      'project:aqua': { type: 'project', label: 'AQUA', weight: 4 },
    },
    edges: { e1: { key: 'e1', from: 'person:ananya', to: 'project:aqua', type: 'works_on', weight: 2 } },
  });
  const [rel] = P.projectRelationships(deps({ mind }), O, 'ent:name:ananya');
  assert.equal(rel.from, 'ent:name:ananya', 'mapped to the federated id');
  assert.equal(rel.to, 'mind:project:aqua', 'and to the mind-only id where there is no file match');
});

// ── OBSERVATIONS + EVENTS ────────────────────────────────────────────────────

test('observations hydrate through the graph — evidenceStore stays the owner', () => {
  fileEntity('ent:name:aqua', 'AQUA');
  G.upsertNode(O, { id: 'fact:f1', type: 'fact', label: 'AQUA shipped', kind: 'observed', sourceFiles: ['u1'] });
  G.addEdge(O, { from: 'fact:f1', to: 'ent:name:aqua', type: 'about', confidence: 0.9, sourceFiles: ['u1'] });

  const facts = [{ id: 'f1', statement: 'AQUA shipped in July', entities: ['AQUA'], confidence: 0.9, evidence: ['ev1'], createdAt: 5 }];
  const obs = P.projectObservations({ ...deps(), evidenceStore: mockEvidence(facts) }, O, 'ent:name:aqua');
  assert.equal(obs.length, 1);
  assert.equal(obs[0].statement, 'AQUA shipped in July');
  assert.deepEqual(obs[0].evidence, ['ev1'], 'grounding survives the projection');
});

test('events merge the reasoning graph and the Mind timeline', () => {
  fileEntity('ent:name:aqua', 'AQUA');
  G.upsertNode(O, { id: 'evt:1', type: 'event', label: 'launch: AQUA went live', kind: 'derived', data: { eventType: 'launch', timestamp: 1000 }, sourceFiles: ['u1'] });
  G.addEdge(O, { from: 'evt:1', to: 'ent:name:aqua', type: 'involves', confidence: 0.8, sourceFiles: ['u1'] });
  const mind = mockMind({
    nodes: { 'project:aqua': { type: 'project', label: 'AQUA', weight: 2 } },
    timeline: [{ id: 'tl1', ts: 2000, kind: 'milestone', subject: 'AQUA benchmark run' }],
  });

  const events = P.projectEvents(deps({ mind }), O, 'ent:name:aqua');
  assert.deepEqual(events.map(e => e.origin), ['mind', 'reasoning'], 'newest first, both sources');
});

// ── SIDECAR CONTRACT ─────────────────────────────────────────────────────────

test('SIDECAR: annotations enrich, and removing every one loses no knowledge', () => {
  fileEntity('ent:name:aqua', 'AQUA', { files: ['f1', 'f2'] });
  const before = P.projectEntity(deps(), O, 'ent:name:aqua');

  A.annotate(O, 'ent:name:aqua', { description: 'The cognitive OS.', aliases: ['Aqua Engine'], tags: ['flagship'] });
  const annotated = P.projectEntity(deps(), O, 'ent:name:aqua');
  assert.equal(annotated.description, 'The cognitive OS.');
  assert.ok(annotated.aliases.includes('Aqua Engine'));
  assert.equal(annotated.annotated, true);

  A._resetAnnotationsForTests();
  const after = P.projectEntity(deps(), O, 'ent:name:aqua');
  assert.equal(after.title, before.title);
  assert.equal(after.importance, before.importance, 'derived values unaffected by the sidecar wipe');
  assert.deepEqual(after.sourceRefs.files, before.sourceRefs.files, 'provenance was never in the sidecar');
});

test('SIDECAR: overrides win but the derived value is kept alongside', () => {
  fileEntity('ent:name:side', 'Side', { files: ['f1'] });
  const derived = P.projectEntity(deps(), O, 'ent:name:side').importance;
  A.annotate(O, 'ent:name:side', { importanceOverride: 1 });
  const pinned = P.projectEntity(deps(), O, 'ent:name:side');
  assert.equal(pinned.importance, 1, 'override applied');
  assert.equal(pinned.signals.derivedImportance, derived, 'and the honest number is still there');
});

test('SIDECAR: annotate merges rather than replacing', () => {
  A.annotate(O, 'e1', { description: 'first', tags: ['a'] });
  A.annotate(O, 'e1', { tags: ['b'], pinned: true });
  const ann = A.getAnnotation(O, 'e1');
  assert.equal(ann.description, 'first', 'not clobbered by an unrelated patch');
  assert.deepEqual(ann.tags.sort(), ['a', 'b']);
  assert.equal(ann.pinned, true);
});

test('SIDECAR: overrides are clamped and clearable', () => {
  A.annotate(O, 'e1', { importanceOverride: 5 });
  assert.equal(A.getAnnotation(O, 'e1').importanceOverride, 1, 'clamped to 0..1');
  A.annotate(O, 'e1', { importanceOverride: null });
  assert.equal(A.getAnnotation(O, 'e1').importanceOverride, null, 'cleared — back to derived');
});

// ── READ-ONLY ────────────────────────────────────────────────────────────────

test('READ-ONLY: projecting never mutates the underlying graphs', () => {
  fileEntity('ent:name:a', 'A', { files: ['f1'] });
  fileEntity('ent:name:b', 'B', { files: ['f1'] });
  G.addEdge(O, { from: 'ent:name:a', to: 'ent:name:b', type: 'works_on', confidence: 0.8, sourceFiles: ['f1'] });
  const mind = mockMind({ nodes: { 'person:a': { type: 'person', label: 'A', weight: 3 } } });
  const before = JSON.stringify(G.graphStats(O));

  P.projectEntities(deps({ mind }), O, {});
  Brain.describeEntity(O, 'ent:name:a', { deps: deps({ mind }) });

  assert.equal(JSON.stringify(G.graphStats(O)), before, 'graph untouched');
});

// ── FACADE ───────────────────────────────────────────────────────────────────

test('describeEntity assembles the whole picture in one call', () => {
  fileEntity('ent:name:ananya', 'Ananya', { files: ['f1'] });
  fileEntity('ent:name:aqua', 'AQUA', { files: ['f1'] });
  G.addEdge(O, { from: 'ent:name:ananya', to: 'ent:name:aqua', type: 'works_on', confidence: 0.8, sourceFiles: ['f1'] });

  const out = Brain.describeEntity(O, 'ent:name:ananya', { deps: deps() });
  assert.equal(out.entity.title, 'Ananya');
  assert.equal(out.relationships[0].type, 'works_on');
  assert.ok(Array.isArray(out.observations) && Array.isArray(out.events));
});

test('findEntities matches aliases through the same normalization entity resolution uses', () => {
  fileEntity('ent:name:openai', 'OpenAI', { aliases: ['Open AI'] });
  assert.equal(Brain.findEntities(O, 'OpenAI Inc.', { deps: deps() })[0]?.id, 'ent:name:openai', 'legal suffix normalized');
  assert.equal(Brain.findEntities(O, 'Open AI', { deps: deps() })[0]?.id, 'ent:name:openai', 'alias match');
  assert.deepEqual(Brain.findEntities(O, 'nonexistent-xyz', { deps: deps() }), []);
});

test('FAIL-OPEN: a broken dependency returns empty instead of throwing', () => {
  const broken = { graph: { nodesByType: () => { throw new Error('boom'); } }, peekMind: () => null, evidenceStore: null, annotations: A };
  assert.deepEqual(Brain.listEntities(O, { deps: broken }), []);
  assert.equal(Brain.getEntity(O, 'x', { deps: broken }), null);
  assert.equal(Brain.describeEntity(O, 'x', { deps: broken }), null);
  assert.ok(Brain.brainMetrics().errors > 0, 'failures are counted, not silent');
});

test('KILL SWITCH: AQUA_BRAIN=off takes the whole layer out', () => {
  fileEntity('ent:name:aqua', 'AQUA');
  process.env.AQUA_BRAIN = 'off';
  try {
    assert.equal(S.brainEnabled(), false);
    assert.deepEqual(Brain.listEntities(O, { deps: deps() }), []);
    assert.equal(Brain.getEntity(O, 'ent:name:aqua', { deps: deps() }), null);
  } finally {
    delete process.env.AQUA_BRAIN;
  }
  assert.ok(Brain.getEntity(O, 'ent:name:aqua', { deps: deps() }), 'restored');
});

test('purgeOwner clears annotations only — the knowledge is not ours to delete', () => {
  fileEntity('ent:name:aqua', 'AQUA');
  A.annotate(O, 'ent:name:aqua', { description: 'x' });
  assert.equal(Brain.purgeOwner(O).annotations, 1);
  assert.equal(A.getAnnotation(O, 'ent:name:aqua'), null);
  assert.ok(G.getNode(O, 'ent:name:aqua'), 'the entity itself survives — owned by reasoningGraph');
});

// ── SCHEMA MATH ──────────────────────────────────────────────────────────────

test('schema: saturate and recency are bounded and monotonic', () => {
  assert.equal(S.saturate(0, 3), 0);
  assert.ok(S.saturate(1, 3) < S.saturate(5, 3) && S.saturate(5, 3) < 1);
  assert.equal(S.recencyScore(null), 0);
  assert.ok(S.recencyScore(Date.now()) > 0.99);
  assert.ok(S.recencyScore(Date.now() - 45 * 86400000) < 0.55, 'one half-life');
  assert.equal(S.clamp01(2), 1);
  assert.equal(S.clamp01(-2), 0);
});

test('relationships carry the far end, so callers never re-derive "which end is not me"', () => {
  fileEntity('ent:name:ananya', 'Ananya');
  fileEntity('ent:name:aqua', 'AQUA');
  G.addEdge(O, { from: 'ent:name:ananya', to: 'ent:name:aqua', type: 'works_on', confidence: 0.8, sourceFiles: ['f1'] });
  assert.equal(P.projectRelationships(deps(), O, 'ent:name:aqua')[0].otherId, 'ent:name:ananya');
  assert.equal(P.projectRelationships(deps(), O, 'ent:name:ananya')[0].otherId, 'ent:name:aqua');
});
