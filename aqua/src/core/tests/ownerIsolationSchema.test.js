import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const migration = readFileSync(
  join(HERE, '../db/migrations/0011_owner_structural_fks.sql'), 'utf8'
);

const requiredConstraints = [
  'aqua_claims_subject_owner_fk',
  'aqua_claims_object_owner_fk',
  'aqua_claims_superseded_owner_fk',
  'aqua_evidence_source_owner_fk',
  'aqua_claim_evidence_claim_owner_fk',
  'aqua_claim_evidence_evidence_owner_fk',
  'aqua_entity_aliases_entity_owner_fk',
  'aqua_understanding_ledger_source_owner_fk',
];

for (const name of requiredConstraints) {
  assert.match(migration, new RegExp(name));
}

assert.match(migration, /REFERENCES aqua_entities \(entity_id, owner_id\)/);
assert.match(migration, /REFERENCES aqua_claims \(claim_id, owner_id\)/);
assert.match(migration, /REFERENCES aqua_evidence \(evidence_id, owner_id\)/);
assert.match(migration, /REFERENCES aqua_sources \(source_id, owner_id\)/);
assert.match(migration, /UNIQUE \(source_id, owner_id\)/);
assert.match(migration, /UNIQUE \(evidence_id, owner_id\)/);

console.log('ownerIsolationSchema: 15/15 assertions passed');
