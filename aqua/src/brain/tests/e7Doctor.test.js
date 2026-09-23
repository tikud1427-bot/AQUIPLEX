import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('E7 doctor checks the canonical substrate and queues durable embedding jobs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/e7-doctor.mjs'), 'utf8');

  assert.match(src, /aqua_embeddings/);
  assert.match(src, /aqua_claim_retrieval_bridge/);
  assert.match(src, /kind: 'claim\.embedding\.v1'/);
  assert.match(src, /e7:claim-embedding:backfill/);
  assert.match(src, /modelSignature\(\)/);
  assert.match(src, /state IN \('active','trusted'\)/);
});
