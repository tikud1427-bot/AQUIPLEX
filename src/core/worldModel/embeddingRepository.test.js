import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vectorLiteral } from './embeddingRepository.js';
import { EMBED_DIM } from '../../embeddings/embeddingModel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, '../db/migrations/0012_dense_retrieval.sql'), 'utf8');

describe('E7 Postgres dense retrieval substrate', () => {
  test('vector literal is exact-dimension and rejects malformed vectors', () => {
    const v = Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM);
    const literal = vectorLiteral(v);
    assert.equal(literal.startsWith('['), true);
    assert.equal(literal.endsWith(']'), true);
    assert.equal(literal.slice(1, -1).split(',').length, EMBED_DIM);
    assert.throws(() => vectorLiteral(v.slice(1)), /exactly/);
    assert.throws(() => vectorLiteral([...v.slice(0, -1), NaN]), /non-finite/);
  });

  test('migration provides pgvector, owner-scoped embedding index and HNSW', () => {
    assert.match(MIGRATION, /CREATE EXTENSION IF NOT EXISTS vector/);
    assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS aqua_embeddings/);
    assert.match(MIGRATION, /model_signature\s+text\s+NOT NULL/);
    assert.match(MIGRATION, /UNIQUE \(owner_id, target_kind, target_id, model_signature\)/);
    assert.match(MIGRATION, /pgvector HNSW accepts/);
    assert.match(MIGRATION, /global HNSW index here would violate structural owner isolation/);
    assert.match(MIGRATION, /FOREIGN KEY \(target_id, owner_id\)/);
  });

  test('lexical lane is indexed over canonical claim text and hot lifecycle only', () => {
    assert.match(MIGRATION, /aqua_claims_lexical_idx/);
    assert.match(MIGRATION, /to_tsvector\('simple', coalesce\(statement_text, ''\)\)/);
    assert.match(MIGRATION, /WHERE state IN \('active','trusted'\)/);
  });
});
