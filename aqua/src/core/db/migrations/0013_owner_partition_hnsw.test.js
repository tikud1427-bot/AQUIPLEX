import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const migration = readFileSync(path.join(here, '0013_owner_partition_hnsw.sql'), 'utf8');

test('E7 owner partition migration uses owner hash partitioning', () => {
  assert.match(migration, /PARTITION BY HASH \(owner_id\)/i);
  assert.match(migration, /MODULUS 64/i);
  assert.match(migration, /REFERENCES aqua_claims \(claim_id, owner_id\)/i);
});

test('E7 owner partition migration creates HNSW per partition', () => {
  assert.match(migration, /USING hnsw \(vector vector_cosine_ops\)/i);
  assert.match(migration, /aqua_embeddings_p%02s/i);
  assert.match(migration, /ef_construction = 64/i);
});

test('E7 partition key is included in canonical uniqueness constraints', () => {
  assert.match(migration, /PRIMARY KEY \(embedding_id, owner_id\)/i);
  assert.match(migration, /UNIQUE \(owner_id, target_kind, target_id, model_signature\)/i);
});

test('E7 migration does not create a global HNSW index', () => {
  assert.doesNotMatch(migration, /CREATE INDEX IF NOT EXISTS [^;]*USING hnsw/i);
  assert.match(migration, /EXECUTE format\([\s\S]*USING hnsw/i);
});
