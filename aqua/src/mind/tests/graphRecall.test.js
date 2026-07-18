/**
 * Memory 5.0 Phase B — Graph Recall (multi-hop retrieval)
 * Run: node --test src/mind/tests/graphRecall.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-graphrecall-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

let mindStore, graph, recall, engine;

before(async () => {
  mindStore = await import('../mindStore.js');
  graph     = await import('../relationshipGraph.js');
  recall    = await import('../graphRecall.js');
  engine    = await import('../../memory/engine.js');
});

function seededMind(name) {
  const owner = `user:graphB-${name}-${Math.random().toString(36).slice(2, 8)}`;
  const mind = mindStore.getMind(owner);
  const org  = graph.upsertNode(mind, 'org', 'Aquiplex');
  const proj = graph.upsertNode(mind, 'project', 'AQUA');
  const tech = graph.upsertNode(mind, 'technology', 'node.js');
  const person = graph.upsertNode(mind, 'person', 'Chhanda');
  graph.upsertEdge(mind, org.key, proj.key, 'owns');
  graph.upsertEdge(mind, proj.key, tech.key, 'uses');
  graph.upsertEdge(mind, person.key, org.key, 'works_at');
  return { owner, mind };
}

test('multi-hop: query naming a node returns connected 2-hop paths', () => {
  const { mind } = seededMind('hops');
  const paths = recall.recallGraphPaths(mind, 'tell me about Aquiplex');
  assert.ok(paths.length >= 1, 'expected at least one path');
  const all = paths.map(p => p.line).join(' | ');
  assert.match(all, /Aquiplex/);
  // 2-hop reach: Aquiplex → AQUA → node.js should be representable
  assert.ok(paths.some(p => p.nodes.length === 3), `expected a 2-hop path, got: ${all}`);
});

test('direction-aware rendering (in-edges use reverse arrow)', () => {
  const { mind } = seededMind('dir');
  const paths = recall.recallGraphPaths(mind, 'what do you know about AQUA?');
  const all = paths.map(p => p.line).join(' | ');
  assert.match(all, /AQUA/);
  assert.ok(/—uses→|←owns—/.test(all), `expected typed arrows, got: ${all}`);
});

test('no seed match / isolated node / empty graph → []', () => {
  const { mind } = seededMind('neg');
  assert.deepEqual(recall.recallGraphPaths(mind, 'completely unrelated zebra query'), []);

  graph.upsertNode(mind, 'technology', 'solitaire-lib'); // no edges
  assert.deepEqual(recall.recallGraphPaths(mind, 'solitaire-lib details'), []);

  const empty = mindStore.getMind(`user:graphB-empty-${Date.now()}`);
  assert.deepEqual(recall.recallGraphPaths(empty, 'Aquiplex'), []);
});

test('dedupe: prefix paths collapse into the longer path; maxPaths respected', () => {
  const { mind } = seededMind('dedupe');
  const paths = recall.recallGraphPaths(mind, 'Aquiplex', { maxPaths: 2 });
  assert.ok(paths.length <= 2);
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < paths.length; j++) {
      if (i !== j) assert.ok(!paths[i].line.includes(paths[j].line), 'no path may contain another');
    }
  }
});

test('engine wiring: memoryRetrieve injects RELATED KNOWLEDGE + traces paths', () => {
  const { owner } = seededMind('engine');
  const { block, trace } = engine.memoryRetrieve(owner, { query: 'how is AQUA connected to Aquiplex?' });
  assert.match(block, /RELATED KNOWLEDGE/);
  assert.ok(Array.isArray(trace.graphPaths) && trace.graphPaths.length >= 1);
});

test('engine wiring: no graph match → no lane, block unchanged shape', () => {
  const { owner } = seededMind('quiet');
  const { block } = engine.memoryRetrieve(owner, { query: 'random cooking question about dumplings' });
  assert.ok(!/RELATED KNOWLEDGE/.test(block));
});
