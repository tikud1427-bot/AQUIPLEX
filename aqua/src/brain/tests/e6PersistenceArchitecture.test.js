import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupAndDetect } from '../understanding/claimDedup.js';
import { resolveRelationships } from '../understanding/relationshipResolver.js';
import { buildCommitPlan } from '../understanding/commitPlan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const brain = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const repo = readFileSync(path.join(ROOT, '../core/worldModel/worldModelRepository.js'), 'utf8');

const claim = (over = {}) => ({
  subject: 'self', predicate: 'uses', objectKind: 'literal', object: { literal: 'Postgres' },
  polarity: 'asserted', modality: 'fact', validFrom: null, validTo: null,
  sourceTier: 'chat', statementText: 'I use Postgres.', claimId: crypto.randomUUID(), ...over,
});

test('production E6 path explicitly invokes S7 → S8 → S9', () => {
  assert.match(brain, /resolveRelationships\(s7Claims\)/);
  assert.match(brain, /dedupAndDetect\(segment\.claims, existing\)/);
  assert.match(brain, /buildCommitPlan\(/);
  assert.match(brain, /commitCanonicalUnderstanding\(/);
});

test('duplicate claims collapse and expose an evidence attachment for the incumbent', () => {
  const existing = { ...claim({ claimId: crypto.randomUUID(), _persisted: true }) };
  const incoming = claim();
  const r = dedupAndDetect([incoming], [existing]);
  assert.equal(r.claims.length, 1);
  assert.equal(r.claims[0].claimId, existing.claimId);
  assert.equal(r.evidenceAttachments.length, 1);
  assert.equal(r.evidenceAttachments[0].targetClaimId, existing.claimId);
});

test('polarity contradiction preserves both claims and S9 emits an event', () => {
  const a = claim();
  const b = claim({ polarity: 'negated', statementText: "I don't use Postgres." });
  const r = dedupAndDetect([a, b]);
  assert.equal(r.claims.length, 2);
  assert.equal(r.contradictions.length, 1);
  const plan = buildCommitPlan({ sourceId: 's', segmentRange: [0, 10], extractorVersion: 'v1', claims: r.claims, contradictions: r.contradictions });
  const outbox = plan.operations.find(o => o.target === 'outbox');
  assert.ok(outbox.rows.some(e => e.type === 'ContradictionDetected'));
});

test('multi-valued predicates do not become false contradictions', () => {
  const a = claim({ claimId: crypto.randomUUID() });
  const b = claim({ claimId: crypto.randomUUID(), object: { literal: 'Redis' }, statementText: 'I use Redis.' });
  const r = dedupAndDetect([a, b]);
  assert.equal(r.claims.length, 2);
  assert.equal(r.contradictions.length, 0);
});

test('S7 entity relationship becomes a canonical edge and S9 plan includes it', () => {
  const a = { ...claim({ predicate: 'works_at', objectKind: 'entity', object: { entity: 'Nummo' } }) };
  const s7 = resolveRelationships([a]);
  assert.equal(s7.edges.length, 1);
  const plan = buildCommitPlan({ sourceId: 's', segmentRange: [0, 10], extractorVersion: 'v1', claims: [a], edges: s7.edges });
  assert.equal(plan.operations.find(o => o.target === 'edges').count, 1);
});

test('repository is one transactional writer and enforces owner scope on dedup reads', () => {
  assert.match(repo, /await client\.query\('BEGIN'\)/);
  assert.match(repo, /await client\.query\('COMMIT'\)/);
  assert.match(repo, /await client\.query\('ROLLBACK'/);
  assert.match(repo, /WHERE c\.owner_id = \$1/);
  assert.match(repo, /aqua_claim_evidence/);
  assert.match(repo, /ContradictionDetected/);
  assert.match(repo, /input\.s7Edges/);
  assert.match(repo, /recordUnderstandingCommit/);
});
