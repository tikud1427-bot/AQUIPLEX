import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddingJobKey, toEmbeddingJob } from '../../brain/reflectionV3/reflectionOutbox.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test('canonical claim commit emits a durable embedding request', () => {
  const src = fs.readFileSync(path.join(ROOT, 'worldModelRepository.js'), 'utf8');
  assert.match(src, /claim\.embedding\.requested/);
  assert.match(src, /statementText: statement/);
});

test('embedding outbox maps to an idempotent E7 job', () => {
  const row = { outboxId: 77, ownerId: 'owner:1', eventType: 'claim.embedding.requested', aggregateId: 'claim-1', payload: { claimId: 'claim-1', statementText: 'Project Alpha', contentHash: 'h' } };
  const job = toEmbeddingJob(row);
  assert.equal(job.kind, 'claim.embedding.v1');
  assert.equal(job.payload.claimId, 'claim-1');
  assert.equal(job.idempotencyKey, embeddingJobKey(row));
});

test('dense retrieval excludes superseded claims structurally', () => {
  const src = fs.readFileSync(path.join(ROOT, 'embeddingRepository.js'), 'utf8');
  assert.match(src, /JOIN aqua_claims c/);
  assert.match(src, /c\.state IN \('active','trusted'\)/);
});
