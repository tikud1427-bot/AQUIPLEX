import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument, enqueueDocumentUnderstanding, DOCUMENT_JOB_KIND, MAX_CHUNKS, CHUNK_CHARS } from '../documentUnderstanding.js';

const LEASE = 'Lease terms\nMonthly rent: $6,400, fixed for 3 years.\nLandlord contact: Owen Hart\n\nBuild-out allowance: $25,000.';

describe('uploaded documents → understanding jobs', () => {
  test('chunks follow paragraphs; a line without terminal punctuation becomes its own sentence', () => {
    const chunks = chunkDocument(LEASE);
    assert.deepEqual(chunks.map(c => c.text), [
      'Lease terms.\nMonthly rent: $6,400, fixed for 3 years.\nLandlord contact: Owen Hart.',
      'Build-out allowance: $25,000.',
    ]);
    assert.deepEqual(chunks.map(c => c.index), [0, 1]);
  });

  test('bounded: chunk size and chunk count are capped; an over-long line is cut at a sentence end', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Fact number ${i} is stated here.`).join(' ');
    const chunks = chunkDocument(long);
    assert.ok(chunks.every(c => c.text.length <= CHUNK_CHARS + 1), 'every chunk within CHUNK_CHARS');
    assert.ok(chunks.length <= MAX_CHUNKS);
    assert.ok(chunks[0].text.endsWith('.'), 'cut at a sentence end');
    assert.deepEqual(chunkDocument(''), []);
  });

  test('enqueues one durable job per chunk, keyed by content hash + chunk (re-upload is idempotent)', async () => {
    const jobs = [];
    const deps = { enabled: async () => true, enqueue: async j => { jobs.push(j); } };
    const r = await enqueueDocumentUnderstanding({ ownerId: 'user:a', deps,
      documents: [{ ukoId: 'u1', name: 'lease.txt', kind: 'document', text: LEASE, hash: 'h'.repeat(64) }] });
    assert.equal(r.enqueued, 2);
    assert.deepEqual(jobs.map(j => [j.kind, j.ownerId, j.idempotencyKey]), [
      [DOCUMENT_JOB_KIND, 'user:a', `${DOCUMENT_JOB_KIND}:${'h'.repeat(32)}:0`],
      [DOCUMENT_JOB_KIND, 'user:a', `${DOCUMENT_JOB_KIND}:${'h'.repeat(32)}:1`],
    ]);
    assert.equal(jobs[0].payload.name, 'lease.txt');
    assert.match(jobs[0].payload.text, /Monthly rent/);
  });

  test('nothing is enqueued when understanding is off, for repositories, without an owner — and it never throws', async () => {
    const jobs = [];
    const enqueue = async j => { jobs.push(j); };
    assert.equal((await enqueueDocumentUnderstanding({ ownerId: 'user:a', documents: [{ name: 'x', text: LEASE }],
      deps: { enabled: async () => false, enqueue } })).skipped, 'understanding-off');
    assert.equal((await enqueueDocumentUnderstanding({ ownerId: 'user:a', documents: [{ name: 'repo', kind: 'repository', text: LEASE }],
      deps: { enabled: async () => true, enqueue } })).enqueued, 0);
    assert.equal((await enqueueDocumentUnderstanding({ documents: [{ name: 'x', text: LEASE }] })).skipped, 'no-owner');
    const boom = await enqueueDocumentUnderstanding({ ownerId: 'user:a', documents: [{ name: 'x', text: LEASE }],
      deps: { enabled: async () => true, enqueue: async () => { throw new Error('db down'); } } });
    assert.equal(boom.skipped, 'error');
    assert.equal(jobs.length, 0);
  });
});
