/**
 * Reasoning graph + identity map on owner partitions (scalability Phase 2b,
 * step 4). These are the two stores the server and the worker both write with
 * NO merge on the whole-file path (audit S6). Real child processes against the
 * disposable test Postgres; skipped loudly without one.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runProcess, tempDir, acquireStoreKeyLock } from '../../core/tests/helpers/multiProcess.mjs';
import { mergeGraphs } from '../reasoningGraph.js';
import { mergeIdEntries } from '../../brain/identity/idStore.js';

const LIVE = Boolean(process.env.DATABASE_URL);
let releaseLock = null;
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const G = '.aqua-reasoning-graph.json';
const I = '.aqua-ids.json';
const ON = 'reasoning-graph:on,ids:on';
const boot = { op: 'boot', stores: ['graph', 'ids'] };
let pool;

const row = async (key, owner) => (await pool.query(
  'SELECT data, version, deleted_at FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2', [key, `o:${owner}`])).rows[0];
const seed = key => pool.query(
  `INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version)
   VALUES ($1, '~rest', '', '{"envelope":true,"sections":["o"],"doc":{"__aqua":{"schema":1,"savedAt":0},"data":{}}}', 0, 'x', 1)
   ON CONFLICT DO NOTHING`, [key]);
const proc = ops => runProcess({ dataDir: tempDir('aq-g-'), partitions: ON }, ops);
const node = (owner, id, fileId = null) => ({ op: 'call', module: 'graph', fn: 'upsertNode', args: [owner, { id, type: 'entity', label: id }, { fileId }] });
const edge = (owner, from, to, fileId) => ({ op: 'call', module: 'graph', fn: 'addEdge', args: [owner, { from, to, type: 'related_to', confidence: 0.6, sourceFiles: [fileId], reason: 'test' }, { fileId }] });
const put = (owner, id, patch) => ({ op: 'call', module: 'ids', fn: 'putEntry', args: [owner, id, patch] });

before(async () => {
  if (!LIVE) return;
  releaseLock = await acquireStoreKeyLock();
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await (await import('../../core/db/migrate.js')).migrate();
});
beforeEach(async () => {
  if (!LIVE) return;
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [[G, I]]);
  await seed(G); await seed(I);
});
after(async () => {
  if (!LIVE) return;
  try {
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [[G, I]]);
  await pool.end();
  await (await import('../../core/db/pool.js')).closePool();
  } finally { await releaseLock?.(); }
});

describe('graph + ids merge — pure', () => {
  test('graph merge is a union that keeps the stronger edge', () => {
    const a = { nodes: { n1: { id: 'n1', data: { x: 1 }, sourceFiles: ['f1'] } }, edges: { e: { id: 'e', confidence: 0.4, evidence: ['a'], sourceFiles: ['f1'], observations: 2 } }, byFile: { f1: { nodes: ['n1'], edges: ['e'] } } };
    const b = { nodes: { n1: { id: 'n1', data: { y: 2 }, sourceFiles: ['f2'] }, n2: { id: 'n2' } }, edges: { e: { id: 'e', confidence: 0.9, evidence: ['b'], sourceFiles: ['f2'], observations: 3 } }, byFile: { f2: { nodes: ['n1', 'n2'], edges: ['e'] } } };
    const m = mergeGraphs(a, b);
    assert.deepEqual(Object.keys(m.nodes).sort(), ['n1', 'n2']);
    assert.deepEqual(m.nodes.n1.data, { y: 2, x: 1 });
    assert.equal(m.edges.e.confidence, 0.9);
    assert.deepEqual(m.edges.e.evidence.sort(), ['a', 'b']);
    assert.equal(m.edges.e.observations, 3);
  });
  test('a removed file\'s nodes and edges are not brought back by the other copy', () => {
    const ours = { nodes: { keep: { id: 'keep' } }, edges: {}, byFile: {}, removedFiles: { f9: 100 } };
    const theirs = { nodes: { keep: { id: 'keep' }, gone: { id: 'gone' } }, edges: { e9: { id: 'e9' } }, byFile: { f9: { nodes: ['gone'], edges: ['e9'] } } };
    const m = mergeGraphs(ours, theirs);
    assert.deepEqual(Object.keys(m.nodes), ['keep']);
    assert.deepEqual(m.edges, {});
    assert.equal(m.byFile.f9, undefined);
  });
  test('identity entries: norms and refs unioned, fuller canonical, newer kind', () => {
    const m = mergeIdEntries(
      { e: { kind: 'person', canonical: 'Ana', norms: ['ana'], refs: [{ space: 'r', ref: '1' }], createdAt: 5, updatedAt: 9 } },
      { e: { kind: 'name', canonical: 'Ana Silva', norms: ['ana silva'], refs: [{ space: 'r', ref: '2' }], createdAt: 3, updatedAt: 7 } });
    assert.equal(m.e.kind, 'person');
    assert.equal(m.e.canonical, 'Ana Silva');
    assert.deepEqual(m.e.norms.sort(), ['ana', 'ana silva']);
    assert.equal(m.e.refs.length, 2);
    assert.equal(m.e.createdAt, 3);
  });
});

describe('graph + ids on partitions — server and worker, real processes', { skip }, () => {
  test('S6: server and worker write one owner\'s graph and identity map at once — nothing is lost', async () => {
    const bar = tempDir('aq-bar-');
    const owner = 'user:s6';
    await Promise.all([
      // the worker: ensureSelfEntity-style writes
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'go', n: 2 },
        node(owner, 'self'), put(owner, 'ent:self', { kind: 'self', canonical: 'You', refs: [{ space: 'reasoning', ref: 'self' }] }), { op: 'flush' }]),
      // the server: file enrichment
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'go', n: 2 },
        node(owner, 'acme', 'f1'), node(owner, 'ana', 'f1'), edge(owner, 'ana', 'acme', 'f1'),
        put(owner, 'ent:acme', { kind: 'org', canonical: 'Acme', norms: ['acme'] }), { op: 'flush' }]),
    ]);
    const g = JSON.parse((await row(G, owner)).data);
    assert.deepEqual(Object.keys(g.nodes).sort(), ['acme', 'ana', 'self']);
    assert.equal(Object.keys(g.edges).length, 1);
    const ids = JSON.parse((await row(I, owner)).data);
    assert.deepEqual(Object.keys(ids).sort(), ['ent:acme', 'ent:self']);
  });

  test('a removed file stays removed although the other process still held it', async () => {
    const owner = 'user:rf';
    await proc([boot, { op: 'load', owner }, node(owner, 'a', 'f1'), node(owner, 'b', 'f1'), edge(owner, 'a', 'b', 'f1'), node(owner, 'c', 'f2'), { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    await Promise.all([
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'graph', fn: 'removeFile', args: [owner, 'f1'] }, { op: 'flush' }, { op: 'barrier', dir: bar, name: 'r', n: 2 }]),
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'r', n: 2 },
        node(owner, 'd', 'f3'), { op: 'flush' }]),   // still holds f1's nodes in memory
    ]);
    const g = JSON.parse((await row(G, owner)).data);
    assert.deepEqual(Object.keys(g.nodes).sort(), ['c', 'd']);
    assert.deepEqual(g.edges, {});
    assert.ok(g.removedFiles.f1);
  });

  test('account purge: a stale process cannot bring the graph or the identity map back', async () => {
    const owner = 'user:pg';
    await proc([boot, { op: 'load', owner }, node(owner, 'old'), put(owner, 'ent:old', { canonical: 'Old' }), { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    await Promise.all([
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'graph', fn: 'purgeOwner', args: [owner] }, { op: 'call', module: 'ids', fn: 'purgeOwner', args: [owner] },
        { op: 'flush' }, { op: 'barrier', dir: bar, name: 'p', n: 2 }]),
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'p', n: 2 },
        node(owner, 'new'), put(owner, 'ent:new', { canonical: 'New' }), { op: 'flush' }]),
    ]);
    const g = JSON.parse((await row(G, owner)).data);
    assert.deepEqual(Object.keys(g.nodes), ['new'], 'only what was learned after the purge');
    const ids = JSON.parse((await row(I, owner)).data);
    assert.deepEqual(Object.keys(ids), ['ent:new']);
  });
});
