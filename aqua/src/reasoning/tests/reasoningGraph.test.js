/**
 * Cross-File Reasoning — graph store + scalability tests (Phase 3).
 *
 * The graph's structural guarantees (provenance-enforced edges, epistemic
 * tagging, bounded traversal, incremental removal) and a stress pass proving
 * construction + query stay tractable at scale (the "thousands of files,
 * millions of facts" requirement, exercised at a CI-appropriate size).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-graph-'));
process.env.AQUA_DATA_DIR = TMP;

const G = await import('../reasoningGraph.js');

beforeEach(() => G._resetGraphForTests());

test('upsertNode validates type + merges by id (no duplicates, aliases accumulate)', () => {
  assert.throws(() => G.upsertNode('o', { id: 'x', type: 'martian', label: 'X' }), /bad type/);
  G.upsertNode('o', { id: 'e1', type: 'entity', label: 'OpenAI', sourceFiles: ['f1'] });
  G.upsertNode('o', { id: 'e1', type: 'entity', label: 'OpenAI', sourceFiles: ['f2'] });
  const node = G.getNode('o', 'e1');
  assert.deepEqual(node.sourceFiles.sort(), ['f1', 'f2'], 'sourceFiles merged across upserts');
  assert.equal(G.graphStats('o').nodes, 1, 'no duplicate node');
});

test('REASONING CONTRACT: addEdge rejects edges without provenance', () => {
  G.upsertNode('o', { id: 'a', type: 'entity', label: 'A' });
  G.upsertNode('o', { id: 'b', type: 'entity', label: 'B' });
  assert.throws(() => G.addEdge('o', { from: 'a', to: 'b', type: 'related_to', confidence: 0.9 }), /no provenance/);
  const e = G.addEdge('o', { from: 'a', to: 'b', type: 'related_to', confidence: 0.9, sourceFiles: ['f1'] });
  assert.ok(e.id);
  assert.equal(e.kind, 'derived', 'default epistemic tag');
});

test('edges merge (confidence max, evidence/sourceFiles union) on repeated insert', () => {
  G.upsertNode('o', { id: 'a', type: 'entity', label: 'A' });
  G.upsertNode('o', { id: 'b', type: 'entity', label: 'B' });
  G.addEdge('o', { from: 'a', to: 'b', type: 'related_to', confidence: 0.6, sourceFiles: ['f1'], evidence: ['ev1'] });
  const e = G.addEdge('o', { from: 'a', to: 'b', type: 'related_to', confidence: 0.8, sourceFiles: ['f2'], evidence: ['ev2'] });
  assert.equal(e.confidence, 0.8, 'max confidence');
  assert.deepEqual(e.sourceFiles.sort(), ['f1', 'f2']);
  assert.deepEqual(e.evidence.sort(), ['ev1', 'ev2']);
  assert.equal(G.graphStats('o').edges, 1, 'still one edge');
});

test('neighbors + edgesOf filter by node/edge type', () => {
  G.upsertNode('o', { id: 'f:1', type: 'file', label: 'a.pdf' });
  G.upsertNode('o', { id: 'e:1', type: 'entity', label: 'X' });
  G.upsertNode('o', { id: 'fact:1', type: 'fact', label: 'a fact' });
  G.addEdge('o', { from: 'f:1', to: 'e:1', type: 'mentions', confidence: 1, sourceFiles: ['1'] });
  G.addEdge('o', { from: 'f:1', to: 'fact:1', type: 'asserts', confidence: 1, sourceFiles: ['1'] });
  assert.equal(G.neighbors('o', 'f:1', { type: 'entity' }).length, 1);
  assert.equal(G.neighbors('o', 'f:1', { edgeType: 'asserts' })[0].node.id, 'fact:1');
});

test('traverse: bounded multi-hop BFS returns connected sub-graph + provenance paths', () => {
  // Chain: a → b → c → d
  for (const id of ['a', 'b', 'c', 'd']) G.upsertNode('o', { id, type: 'entity', label: id });
  G.addEdge('o', { from: 'a', to: 'b', type: 'related_to', confidence: 1, sourceFiles: ['f'] });
  G.addEdge('o', { from: 'b', to: 'c', type: 'related_to', confidence: 1, sourceFiles: ['f'] });
  G.addEdge('o', { from: 'c', to: 'd', type: 'related_to', confidence: 1, sourceFiles: ['f'] });

  const near = G.traverse('o', 'a', { maxHops: 2 });
  assert.deepEqual(near.nodes.map(n => n.id).sort(), ['a', 'b', 'c'], '2 hops reaches c, not d');
  const full = G.traverse('o', 'a', { maxHops: 5 });
  assert.ok(full.paths.get('d').length === 3, 'path to d is 3 hops, each edge retained');
  assert.ok(full.paths.get('d').every(e => e.sourceFiles.length > 0), 'path edges carry provenance');
});

test('incremental removeFile detaches one file; shared nodes survive', () => {
  G.upsertNode('o', { id: 'e:shared', type: 'entity', label: 'Shared', sourceFiles: ['f1', 'f2'] }, { fileId: 'f1' });
  G.upsertNode('o', { id: 'e:shared', type: 'entity', label: 'Shared', sourceFiles: ['f1', 'f2'] }, { fileId: 'f2' });
  G.upsertNode('o', { id: 'fact:only1', type: 'fact', label: 'only in f1' }, { fileId: 'f1' });
  G.addEdge('o', { from: 'fact:only1', to: 'e:shared', type: 'about', confidence: 1, sourceFiles: ['f1'] }, { fileId: 'f1' });

  G.removeFile('o', 'f1');
  assert.equal(G.getNode('o', 'fact:only1'), null, 'f1-only fact removed');
  assert.ok(G.getNode('o', 'e:shared'), 'shared entity survives (still in f2)');
});

test('STRESS: 500 files × ~5 facts build + query stays tractable and correct', () => {
  const t0 = Date.now();
  const FILES = 500;
  // Every 10th file mentions "GlobalCorp" — a cross-file entity we'll query.
  for (let i = 0; i < FILES; i++) {
    const fid = `file:${i}`;
    G.upsertNode('o', { id: fid, type: 'file', label: `f${i}.pdf`, sourceFiles: [String(i)] }, { fileId: String(i) });
    const ent = i % 10 === 0 ? 'e:globalcorp' : `e:local${i}`;
    G.upsertNode('o', { id: ent, type: 'entity', label: i % 10 === 0 ? 'GlobalCorp' : `Local${i}`, sourceFiles: [String(i)] }, { fileId: String(i) });
    G.addEdge('o', { from: fid, to: ent, type: 'mentions', confidence: 1, sourceFiles: [String(i)] }, { fileId: String(i) });
    for (let j = 0; j < 4; j++) {
      const factId = `fact:${i}:${j}`;
      G.upsertNode('o', { id: factId, type: 'fact', label: `fact ${i}.${j}`, sourceFiles: [String(i)] }, { fileId: String(i) });
      G.addEdge('o', { from: fid, to: factId, type: 'asserts', confidence: 0.9, sourceFiles: [String(i)] }, { fileId: String(i) });
    }
  }
  const buildMs = Date.now() - t0;

  const stats = G.graphStats('o');
  assert.equal(stats.files, FILES);
  assert.ok(stats.nodes > 2000, `${stats.nodes} nodes`);

  // Cross-file query: GlobalCorp mentioned by 50 files.
  const q0 = Date.now();
  const files = G.neighbors('o', 'e:globalcorp', { type: 'file', edgeType: 'mentions' });
  const queryMs = Date.now() - q0;
  assert.equal(files.length, 50, 'the cross-file entity resolves to exactly its 50 files');

  assert.ok(buildMs < 5000, `build ${buildMs}ms within budget`);
  assert.ok(queryMs < 200, `query ${queryMs}ms fast (adjacency-indexed, not a scan)`);
});
