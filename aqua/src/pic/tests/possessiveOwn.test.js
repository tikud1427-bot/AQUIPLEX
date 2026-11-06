/**
 * "your own" is an intensifier, not the verb OWN (pic/questionShape.js, 2026-11-06).
 *
 * After the assistant's verb left the terms of "Can you fix your own bug?"
 * (dev q143), the only term left beside `bug` was `own`, and it handed "I no
 * longer own the parser." to a request about the assistant. An `own` that every
 * time follows a possessive (my / your / our / his / her / its / their) is not
 * a term; a verb `own` / `owns` still is. Checked at the shape and at retrieval
 * over the retrieval-core dev dataset (the queries that pinned the regression
 * and the ownership questions it must not touch).
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-possessive-own-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;

const { analyseQuestion } = await import('../questionShape.js');
const { seedWorld, retrieveWithCurrentEngine } = await import('../../../eval/adapters/currentRetrieval.mjs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(fs.readFileSync(path.join(HERE, '../../../eval/datasets/retrieval-core.v1.json'), 'utf8'));
const Q = id => DS.queries.find(c => c.id === id);

describe('the question shape', () => {
  test('a possessive "own" is not a term; the object stays', () => {
    for (const q of ['Can you fix your own bug?', 'Will you write your own documentation?', 'Did I start my own business?']) {
      const t = analyseQuestion(q).terms;
      assert.ok(!t.includes('own'), `${q} → ${t}`);
    }
    assert.ok(analyseQuestion('Can you fix your own bug?').terms.includes('bug'));
  });
  test('the verb OWN stays a term', () => {
    for (const q of ['Who owns the parser?', 'Do I own the parser?', 'Do I still own the parser?', 'What do I no longer own?', 'What do I own personally?']) {
      const t = analyseQuestion(q).terms;
      assert.ok(t.some(x => /^owns?$/.test(x)), `${q} → ${t}`);
    }
  });
  test('a question using both keeps the verb ("Do I own my own car?")', () => {
    assert.ok(analyseQuestion('Do I own my own car?').terms.includes('own'));
  });
});

describe('retrieval over the retrieval-core dev world', () => {
  const OWNER = 'user:possessive-own';
  const top = async id => (await retrieveWithCurrentEngine(OWNER, Q(id).q, { limit: 8 })).ranked;
  before(async () => { await seedWorld(OWNER, DS.corpus); });

  test('q143 "Can you fix your own bug?" is silent (was "I no longer own the parser.")', async () => {
    assert.deepEqual(await top('q143'), []);
  });
  test('the silence gains are kept: q147, q149, q163, q166', async () => {
    for (const id of ['q147', 'q149', 'q163', 'q166']) assert.deepEqual(await top(id), [], `${id} "${Q(id).q}"`);
  });
  test('ownership questions still find their fact first', async () => {
    for (const id of ['q007', 'q022', 'q027', 'q098', 'q126']) {
      const r = await top(id);
      assert.ok(Q(id).relevant.includes(r[0]), `${id} "${Q(id).q}" → ${r.slice(0, 3)}`);
    }
  });
});
