import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import { linkBeliefClaim, unlinkBeliefClaim, claimsForBelief, beliefsForClaim, BeliefClaimError } from '../mind/beliefClaimRepository.js';

const OWNER = 'user:belief';
const OTHER = 'user:other';
let mem, restorePool, ownerEntity, otherEntity, ownerClaim, otherClaim;
const envBefore = process.env.DATABASE_URL;

before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  _resetForTests();
  mem = createMemoryPg();
  restorePool = _setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();
});

after(async () => {
  restorePool?.(); await mem?.close(); _resetForTests();
  if (envBefore === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = envBefore;
});

beforeEach(async () => {
  await mem.pool.query('DELETE FROM aqua_belief_claims');
  await mem.pool.query('UPDATE aqua_claims SET superseded_by=NULL, state=\'extracted\'');
  await mem.pool.query('DELETE FROM aqua_claims');
  await mem.pool.query('DELETE FROM aqua_entities');
  ownerEntity = crypto.randomUUID(); otherEntity = crypto.randomUUID();
  await mem.pool.query(`INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label) VALUES ($1,$2,'person','A','a')`, [ownerEntity, OWNER]);
  await mem.pool.query(`INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label) VALUES ($1,$2,'person','B','b')`, [otherEntity, OTHER]);
  ownerClaim = crypto.randomUUID(); otherClaim = crypto.randomUUID();
  const now = new Date();
  const insert = async (id, owner, entity) => mem.pool.query(`INSERT INTO aqua_claims (claim_id,owner_id,subject_entity_id,predicate,object_literal,asserted_at,extractor,extractor_version,actor,statement_text,statement_norm) VALUES ($1,$2,$3,'likes',$4,$5,'test','1','test','x','x')`, [id,owner,entity,'coffee',now]);
  await insert(ownerClaim, OWNER, ownerEntity); await insert(otherClaim, OTHER, otherEntity);
});

describe('belief ↔ claim bridge', () => {
  const base = claimId => ({ ownerId: OWNER, beliefId: crypto.randomUUID(), dimension: 'preferences', beliefKey: 'coffee', claimId });
  test('links and reads a supporting canonical claim', async () => {
    const input = base(ownerClaim); const row = await linkBeliefClaim(input);
    assert.equal(row.claim_id, ownerClaim); assert.equal(row.relation, 'supporting');
    assert.equal((await claimsForBelief(input)).length, 1);
    assert.equal((await beliefsForClaim(input)).length, 1);
  });
  test('upsert changes relationship without duplicating the bridge row', async () => {
    const input = base(ownerClaim); await linkBeliefClaim(input);
    await linkBeliefClaim({ ...input, relation: 'contradicting', weight: 0.4 });
    const rows = await claimsForBelief(input);
    assert.equal(rows.length, 1); assert.equal(rows[0].relation, 'contradicting'); assert.equal(rows[0].weight, 0.4);
  });
  test('cross-owner claim is structurally refused', async () => {
    const input = base(otherClaim);
    await assert.rejects(() => linkBeliefClaim(input), /foreign key|violates/i);
  });
  test('invalid relationship metadata is refused before DB write', async () => {
    await assert.rejects(() => linkBeliefClaim({ ...base(ownerClaim), relation: 'maybe' }), BeliefClaimError);
    await assert.rejects(() => linkBeliefClaim({ ...base(ownerClaim), weight: 2 }), BeliefClaimError);
  });
  test('unlink removes only the owner-scoped relationship', async () => {
    const input = base(ownerClaim); await linkBeliefClaim(input); assert.equal(await unlinkBeliefClaim(input), true); assert.equal(await unlinkBeliefClaim(input), false);
  });
});
