import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repo = readFileSync(path.join(HERE, '../worldModel/worldModelRepository.js'), 'utf8');
const embeddings = readFileSync(path.join(HERE, '../worldModel/embeddingRepository.js'), 'utf8');
const migration = readFileSync(path.join(HERE, '../db/migrations/0012_dense_retrieval.sql'), 'utf8');

const commit = repo.slice(repo.indexOf('export async function commitUnderstanding'));
const insert = commit.indexOf('INSERT INTO aqua_claims');
const extracted = commit.indexOf("fromState:null,toState:'extracted'");
const promote = commit.indexOf("SET state='active'");
const activeTransition = commit.indexOf("fromState:'extracted',toState:'active'");
const embeddingEvent = commit.indexOf("eventType: 'claim.embedding.requested'");
assert.ok(insert >= 0, 'canonical claim insert must exist');
assert.ok(extracted > insert, 'claim must record extracted lifecycle first');
assert.ok(promote > extracted, 'claim must be promoted to active in the same transaction');
assert.ok(activeTransition > promote, 'active lifecycle transition must be recorded');
assert.ok(embeddingEvent > activeTransition, 'embedding request must be emitted only after active promotion');

// Current E7 retrieval is structurally restricted to live canonical claims.
assert.match(embeddings, /JOIN aqua_claims c/);
assert.match(embeddings, /c\.state IN \('active','trusted'\)/);
assert.match(migration, /WHERE state IN \('active','trusted'\)/);

console.log('canonicalCurrentRetrievalContract: 7/7 passed');
