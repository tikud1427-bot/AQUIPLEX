import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const brain = readFileSync(path.join(ROOT, 'brain/index.js'), 'utf8');
const postTurn = readFileSync(path.join(ROOT, 'routes/turnPostProcess.js'), 'utf8');
const repo = readFileSync(path.join(ROOT, 'core/worldModel/worldModelRepository.js'), 'utf8');
const m0010 = readFileSync(path.join(ROOT, 'core/db/migrations/0010_understanding_commit_ledger.sql'), 'utf8');
const m0011 = readFileSync(path.join(ROOT, 'core/db/migrations/0011_owner_structural_fks.sql'), 'utf8');

// The real turn path must reach the canonical writer indirectly through the
// Brain facade. This catches the dangerous state where E6 is extracted and
// reported but its result is never persisted.
assert.match(postTurn, /understandTurn:\s*Brain\.understandTurn/);
assert.match(postTurn, /d\.understandTurn\(\{[^}]*ownerId[^}]*conversationId[^}]*turn[^}]*userMessage/s);
assert.match(brain, /commitUnderstanding\s+as\s+commitCanonicalUnderstanding/);
assert.match(brain, /if\s*\(\s*!e6CommitEnabled\(\)\s*\|\|\s*!result\?\.readyForS7\?\.length\s*\)\s*return result/);
assert.match(brain, /commitCanonicalUnderstanding\(\{[\s\S]*sourceId,[\s\S]*extractorVersion,[\s\S]*segmentRange:/);

// Canonical persistence must remain transactional and must reserve the durable
// segment tuple before any claim/evidence mutation.
assert.match(repo, /async function transact\(fn\)/);
const commit = repo.slice(repo.indexOf('export async function commitUnderstanding'));
const source = commit.indexOf('INSERT INTO aqua_sources');
const ledger = commit.indexOf('recordUnderstandingCommit');
const evidence = commit.indexOf('INSERT INTO aqua_evidence');
assert.ok(source >= 0 && ledger > source && evidence > ledger,
  'source -> ledger -> evidence ordering is required for an atomic commit');
assert.match(repo, /await client\.query\('BEGIN'\)/);
assert.match(repo, /await client\.query\('COMMIT'\)/);
assert.match(repo, /await client\.query\('ROLLBACK'\)/);

// Restart/concurrency-safe S9 idempotency and structural owner isolation are
// database properties, not process-local conventions.
assert.match(m0010, /UNIQUE \(owner_id, source_id, segment_start, segment_end, extractor_version\)/);
assert.match(m0011, /aqua_understanding_ledger_source_owner_fk/);
assert.match(m0011, /REFERENCES aqua_sources \(source_id, owner_id\)/);
assert.match(m0011, /aqua_claims_subject_owner_fk/);
assert.match(m0011, /aqua_claims_object_owner_fk/);
assert.match(m0011, /aqua_claim_evidence_claim_owner_fk/);
assert.match(m0011, /aqua_claim_evidence_evidence_owner_fk/);

console.log('e6WorldModelIntegrationContract: 12/12 passed');
