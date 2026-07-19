/**
 * File Intelligence V1 — file search index tests.
 *
 * The prepared search interfaces (entity / keyword / multi-term) with
 * owner isolation, re-index idempotence, eviction bounds, and restart
 * survival through the standard store primitives.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-fileindex-'));
process.env.AQUA_DATA_DIR = TMP;

const {
  indexUKO, removeUKOFromIndex, searchByEntity, searchByKeyword, searchFiles,
  getIndexStats, _resetFileIndexForTests,
} = await import('../fileSearchIndex.js');

const mkUKO = (id, name, { entities = [], keywords = [], conv = 'c1' } = {}) => ({
  id, conversation: conv, fileType: 'document',
  sourceFile: { name },
  entities: entities.map(v => ({ type: 'name', value: v, count: 1 })),
  keywords: keywords.map(t => ({ term: t, count: 2 })),
});

beforeEach(() => _resetFileIndexForTests());

test('entity + keyword lookups are exact, case-insensitive, owner-scoped', () => {
  indexUKO('alice', mkUKO('u1', 'deck.pptx', { entities: ['NVIDIA', 'Tata Group'], keywords: ['revenue'] }));
  indexUKO('alice', mkUKO('u2', 'notes.md',  { entities: ['NVIDIA'] }));
  indexUKO('bob',   mkUKO('u3', 'bob.pdf',   { entities: ['NVIDIA'] }));

  const hits = searchByEntity('alice', 'nvidia');
  assert.deepEqual(hits.map(h => h.ukoId).sort(), ['u1', 'u2']);
  assert.equal(hits.find(h => h.ukoId === 'u1').name, 'deck.pptx');
  assert.deepEqual(searchByEntity('bob', 'NVIDIA').map(h => h.ukoId), ['u3'], 'owners never see each other');
  assert.deepEqual(searchByKeyword('alice', 'REVENUE').map(h => h.ukoId), ['u1']);
  assert.deepEqual(searchByEntity('alice', 'absent'), []);
});

test('searchFiles: multi-term OR across both lanes, hit-scored, limited', () => {
  indexUKO('o', mkUKO('a', 'contract.pdf', { entities: ['Aquiplex'], keywords: ['payment', 'license'] }));
  indexUKO('o', mkUKO('b', 'memo.md',      { keywords: ['payment'] }));
  const out = searchFiles('o', 'Aquiplex payment terms');
  assert.equal(out[0].ukoId, 'a', 'two hits outrank one');
  assert.equal(out[0].hits, 2);
  assert.deepEqual(searchFiles('o', ''), []);
});

test('re-index is idempotent (replaces, never duplicates); removal cleans every lane', () => {
  indexUKO('o', mkUKO('a', 'v1.md', { entities: ['Old'] }));
  indexUKO('o', mkUKO('a', 'v1.md', { entities: ['New'] }));
  assert.deepEqual(searchByEntity('o', 'Old'), [], 'stale entity gone after re-index');
  assert.equal(searchByEntity('o', 'New').length, 1);
  assert.equal(getIndexStats('o').files, 1);

  removeUKOFromIndex('o', 'a');
  assert.deepEqual(searchByEntity('o', 'New'), []);
  assert.deepEqual(getIndexStats('o'), { files: 0, entities: 0, keywords: 0 });
});

test('restart survival: a fresh import from the same AQUA_DATA_DIR sees the index', async () => {
  indexUKO('o', mkUKO('a', 'persist.md', { entities: ['Durable'] }));
  // Force the debounced writer to flush by waiting past its debounce.
  await new Promise(r => setTimeout(r, 700));
  const fresh = await import(`../fileSearchIndex.js?fresh=${Date.now()}`);
  assert.equal(fresh.searchByEntity('o', 'durable').length, 1, 'survives module reload from disk');
});
