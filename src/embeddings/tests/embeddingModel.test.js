/**
 * Embedding model identity, and what the store does when it changes.
 *
 * Production logs showed `models/text-embedding-004 is not found for API
 * version v1beta` on every single turn — Google retired that model on
 * 14 January 2026 and the default had never moved, so semantic retrieval was
 * silently keyword-only for however long that had been true.
 *
 * Fixing the default is the easy half. The dangerous half is the stored
 * vectors: cosine similarity is only meaningful between vectors from the SAME
 * model, and two models can share a dimension count while occupying unrelated
 * spaces. A dimension change fails loudly (cosineSim returns 0 on unequal
 * lengths). A same-dimension model change fails SILENTLY — every stored vector
 * keeps scoring and every score is noise.
 *
 * So these tests care much more about invalidation than about the model name.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-embedmodel-'));
process.env.AQUA_DATA_DIR = TMP;

const { EMBED_MODEL, EMBED_DIM, modelSignature } = await import('../embeddingModel.js');
// DATA_DIR is resolved ONCE when core/dataDir.js first loads, so every
// cache-busted vectorStore import below still reads from this one directory.
// An earlier draft gave each case its own temp dir and every discard test
// passed for the wrong reason — the seed file was simply never found.
const { DATA_DIR } = await import('../../core/dataDir.js');
const STORE_PATH = path.join(DATA_DIR, '.aqua-vectors.json');

afterEach(() => {
  delete process.env.AQUA_EMBED_MODEL;
  delete process.env.AQUA_EMBED_DIM;
});

// ── Identity ────────────────────────────────────────────────────────────────

test('the default model is one that still exists', () => {
  assert.notEqual(EMBED_MODEL, 'text-embedding-004',
    'the retired model must not be the default — it 404s on every call');
  assert.ok(EMBED_MODEL.length > 0);
});

test('the signature pins model AND dimension together', () => {
  process.env.AQUA_EMBED_MODEL = 'some-model';
  process.env.AQUA_EMBED_DIM = '1536';
  assert.equal(modelSignature(), 'some-model@1536');
});

test('a bad dimension falls back rather than poisoning the signature', () => {
  process.env.AQUA_EMBED_DIM = 'not-a-number';
  assert.match(modelSignature(), /@768$/);

  process.env.AQUA_EMBED_DIM = '-5';
  assert.match(modelSignature(), /@768$/);
});

test('EMBED_DIM is a positive integer', () => {
  assert.ok(Number.isInteger(EMBED_DIM) && EMBED_DIM > 0);
});

// ── Invalidation — the part that matters ────────────────────────────────────

async function freshStore(seedRecords) {
  // Seed the real store path, then force a fresh module instance so
  // loadFromDisk actually runs against what we just wrote.
  fs.writeFileSync(STORE_PATH, JSON.stringify(seedRecords));
  return import(`../vectorStore.js?case=${Math.random()}`);
}

test('vectors from a DIFFERENT model at the SAME dimension are discarded', async () => {
  process.env.AQUA_EMBED_MODEL = 'model-b';
  process.env.AQUA_EMBED_DIM = '4';

  // The silent-failure case: same length, unrelated space.
  const VS = await freshStore({
    facts: { f1: { vec: [1, 0, 0, 0], hash: 'h', ts: 1, dim: 4, model: 'model-a@4' } },
  });

  assert.equal(VS.idsIn('facts').length, 0,
    'a same-dimension foreign vector must not survive — it would score as if valid');
});

test('vectors written before the stamp existed are discarded', async () => {
  process.env.AQUA_EMBED_MODEL = 'model-b';
  process.env.AQUA_EMBED_DIM = '4';

  // No `model` field at all ⇒ written by the retired text-embedding-004 build.
  const VS = await freshStore({
    facts: { f1: { vec: [1, 0, 0, 0], hash: 'h', ts: 1, dim: 4 } },
  });

  assert.equal(VS.idsIn('facts').length, 0, 'unstamped means unknown means unusable');
});

test('vectors from the CURRENT model survive the load', async () => {
  process.env.AQUA_EMBED_MODEL = 'model-b';
  process.env.AQUA_EMBED_DIM = '4';

  const VS = await freshStore({
    facts: { f1: { vec: [1, 0, 0, 0], hash: 'h', ts: 1, dim: 4, model: 'model-b@4' } },
  });

  assert.deepEqual(VS.idsIn('facts'), ['f1'], 'matching provenance is kept — no needless re-embed');
});

test('a dimension change alone also invalidates', async () => {
  process.env.AQUA_EMBED_MODEL = 'model-b';
  process.env.AQUA_EMBED_DIM = '768';

  const VS = await freshStore({
    facts: { f1: { vec: [1, 0, 0, 0], hash: 'h', ts: 1, dim: 4, model: 'model-b@4' } },
  });

  assert.equal(VS.idsIn('facts').length, 0);
});

test('newly written vectors carry the current stamp', async () => {
  process.env.AQUA_EMBED_MODEL = 'model-c';
  process.env.AQUA_EMBED_DIM = '3';

  const VS = await freshStore({});
  VS.upsert('facts', 'f1', [1, 2, 3], 'hash');

  // Round-trip through a second load: what we wrote must be readable back.
  assert.deepEqual(VS.idsIn('facts'), ['f1']);
});

test('cosine still fails safe on mismatched lengths', async () => {
  const VS = await freshStore({});
  assert.equal(VS.cosineSim([1, 2, 3], [1, 2]), 0);
  assert.equal(VS.cosineSim([0, 0], [0, 0]), 0);
  assert.ok(VS.cosineSim([1, 0], [1, 0]) > 0.99);
});
