import assert from 'node:assert/strict';
import test from 'node:test';
import { BeliefClaimError, linkBeliefClaim } from '../mind/beliefClaimRepository.js';

test('linkBeliefClaim validates owner and relationship metadata before database access', async () => {
  await assert.rejects(
    () => linkBeliefClaim({ beliefId: 'bel-1', dimension: 'knowledge', beliefKey: 'x', claimId: 'c-1' }),
    BeliefClaimError
  );
  await assert.rejects(
    () => linkBeliefClaim({
      ownerId: 'u-1', beliefId: 'bel-1', dimension: 'knowledge',
      beliefKey: 'x', claimId: 'c-1', relation: 'invented'
    }),
    BeliefClaimError
  );
  await assert.rejects(
    () => linkBeliefClaim({
      ownerId: 'u-1', beliefId: 'bel-1', dimension: 'knowledge',
      beliefKey: 'x', claimId: 'c-1', weight: 1.1
    }),
    BeliefClaimError
  );
});

test('relationship SQL is owner-scoped and cannot cross owners structurally', async () => {
  const source = await import('node:fs/promises');
  const sql = await source.readFile(
    new URL('../db/migrations/0015_belief_claims.sql', import.meta.url), 'utf8'
  );
  // The schema-level owner scoping (FK, PK) lives in the migration above; the
  // query-level owner scoping is a property of the repository's own SQL, not
  // the table DDL — checked separately against the module that issues it.
  const repoSource = await source.readFile(
    new URL('../mind/beliefClaimRepository.js', import.meta.url), 'utf8'
  );
  assert.match(sql, /FOREIGN KEY \(owner_id, claim_id\)\s+REFERENCES aqua_claims\(owner_id, claim_id\)/);
  assert.match(sql, /PRIMARY KEY \(owner_id, belief_id, claim_id\)/);
  assert.match(repoSource, /WHERE owner_id = \$1 AND claim_id = \$2/);
});
