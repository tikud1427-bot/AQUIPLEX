/**
 * 2026-11-10 — concurrent embeds of the same text share one API call.
 * A chat turn's three retrieval lanes embed the same user message at once.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  embed, embedOne, __setEmbedderForTests, __clearEmbedderForTests, __inflightEmbeddingsForTests,
} from '../embeddingProvider.js';
import { EMBED_DIM } from '../embeddingModel.js';

const vec = (seed) => Array.from({ length: EMBED_DIM }, (_, i) => (seed + i) % 7 / 7);
afterEach(() => __clearEmbedderForTests());

test('three concurrent embedOne(same text) → one provider call, same vector', async () => {
  const calls = [];
  __setEmbedderForTests(async (texts) => { calls.push([...texts]); await new Promise(r => setTimeout(r, 20)); return texts.map((t) => vec(t.length)); });
  const [a, b, c] = await Promise.all([embedOne('what is my plan?'), embedOne('what is my plan?'), embedOne('what is my plan?')]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['what is my plan?']);
  assert.deepEqual(a, b); assert.deepEqual(b, c);
  assert.equal(__inflightEmbeddingsForTests(), 0);
});

test('different texts are not merged; duplicates inside one batch are sent once, order kept', async () => {
  const calls = [];
  __setEmbedderForTests(async (texts) => { calls.push([...texts]); return texts.map((t) => vec(t.length)); });
  const out = await embed(['alpha', 'beta', 'alpha']);
  assert.deepEqual(calls, [['alpha', 'beta']]);
  assert.deepEqual(out[0], vec(5)); assert.deepEqual(out[1], vec(4)); assert.deepEqual(out[2], vec(5));
});

test('a failing call releases its waiters with null (keyword fallback) and is not cached', async () => {
  let n = 0;
  __setEmbedderForTests(async () => { n++; throw new Error('boom'); });
  const [a, b] = await Promise.all([embedOne('x y'), embedOne('x y')]);
  assert.equal(a, null); assert.equal(b, null);
  assert.equal(n, 1);
  assert.equal(__inflightEmbeddingsForTests(), 0);
  await embedOne('x y');
  assert.equal(n, 2, 'a failure is retried on the next request, not served from cache');
});
