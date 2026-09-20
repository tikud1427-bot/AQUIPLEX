import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createMemoryPg } from '../tests/helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import {
  linkClaimRetrievalKey, claimIdsForRetrievalKeys, retrievalKeysForClaimIds,
} from './claimRetrievalBridge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('E7 canonical claim retrieval bridge — schema', () => {
  test('migration is an identity bridge, owner-scoped and FK-backed', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'src/core/db/migrations/0014_claim_retrieval_bridge.sql'), 'utf8');
    assert.match(sql, /PRIMARY KEY \(owner_id, claim_id\)/);
    assert.match(sql, /FOREIGN KEY \(claim_id, owner_id\)/);
    assert.match(sql, /UNIQUE \(owner_id, retrieval_key\)/);
    assert.match(sql, /owner_id, retrieval_key/);
  });

  test('bridge exposes only IDs; no statement or belief fields', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/worldModel/claimRetrievalBridge.js'), 'utf8');
    assert.doesNotMatch(src, /statement_text|object_literal|predicate/);
    assert.match(src, /linkClaimRetrievalKey/);
    assert.match(src, /claimIdsForRetrievalKeys/);
  });
});

// ── Against a real (simulated) database ─────────────────────────────────────
//
// The two tests above check that the right words appear in the file. They
// would have stayed green through every version of this module, including
// the one where all three exported functions called `const p = getPool();`
// without an `await` — `getPool` is `async`, so `p` was a Promise, `p.query`
// was `undefined`, and every real call threw `TypeError: p.query is not a
// function`. Nothing here ever invoked the functions, so nothing caught it.
//
// pg-mem needs no live server (see helpers/memoryPg.mjs's own caveats — none
// of them apply to this table: no partial unique index, no advisory lock),
// so this runs everywhere the suite runs, not only where DATABASE_URL points
// at a real Postgres.
//
// BITE, MEASURED (revert the named property → count failures):
//   the missing `await` on getPool()      → 3 fail (every call throws)
//   the (claim_id, owner_id) composite FK → 1 fail (cross-owner link accepted)

describe('E7 canonical claim retrieval bridge — behavior', () => {
  let mem, restorePool;
  const envBefore = process.env.DATABASE_URL;
  const OWNER = 'user:e7-bridge';
  const OTHER = 'user:e7-bridge-other';
  let CLAIM_OWNER, CLAIM_OTHER;

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
    _resetForTests();
    mem = createMemoryPg();
    restorePool = _setPoolForTests(mem.pool);
    const applied = (await (await import('../db/migrate.js')).migrate()).applied.map(a => a.name);
    assert.ok(applied.includes('claim_retrieval_bridge'), 'the 0014 migration did not apply');

    CLAIM_OWNER = await insertClaim(OWNER);
    CLAIM_OTHER = await insertClaim(OTHER);
  });

  after(async () => {
    restorePool?.();
    await mem?.close();
    if (envBefore === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = envBefore;
    _resetForTests();
  });

  async function insertClaim(owner) {
    const entityId = crypto.randomUUID();
    await mem.pool.query(
      `INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label)
       VALUES ($1,$2,'person','Test','test')`, [entityId, owner]);
    const claimId = crypto.randomUUID();
    await mem.pool.query(
      `INSERT INTO aqua_claims (
         claim_id, owner_id, subject_entity_id, predicate, object_literal,
         polarity, modality, asserted_at, state, extractor, extractor_version, actor,
         statement_text, statement_norm)
       VALUES ($1,$2,$3,'works_at','Aquiplex','asserted','fact',now(),'active','test','v1','test',$4,$4)`,
      [claimId, owner, entityId, `s-${Math.random()}`]);
    return claimId;
  }

  test('link then look up by retrieval key AND by claim id — the round trip that never ran', async () => {
    const linked = await linkClaimRetrievalKey({
      ownerId: OWNER, claimId: CLAIM_OWNER, retrievalKey: 'legacy-key-1',
    });
    assert.equal(linked.claim_id, CLAIM_OWNER);

    const byKey = await claimIdsForRetrievalKeys({ ownerId: OWNER, retrievalKeys: ['legacy-key-1'] });
    assert.equal(byKey.get('legacy-key-1'), CLAIM_OWNER);

    const byClaim = await retrievalKeysForClaimIds({ ownerId: OWNER, claimIds: [CLAIM_OWNER] });
    assert.equal(byClaim.get(CLAIM_OWNER), 'legacy-key-1');
  });

  test('a claim cannot be linked under an owner that does not own it (structural, not application-level)', async () => {
    await assert.rejects(() => linkClaimRetrievalKey({
      ownerId: OTHER, claimId: CLAIM_OWNER, retrievalKey: 'stolen-key',
    }));
  });

  test('lookups are owner-scoped — the same retrieval key text for two owners does not cross', async () => {
    await linkClaimRetrievalKey({ ownerId: OWNER, claimId: CLAIM_OWNER, retrievalKey: 'shared-text' });
    await linkClaimRetrievalKey({ ownerId: OTHER, claimId: CLAIM_OTHER, retrievalKey: 'shared-text' });

    const ownerLookup = await claimIdsForRetrievalKeys({ ownerId: OWNER, retrievalKeys: ['shared-text'] });
    const otherLookup = await claimIdsForRetrievalKeys({ ownerId: OTHER, retrievalKeys: ['shared-text'] });

    assert.equal(ownerLookup.get('shared-text'), CLAIM_OWNER);
    assert.equal(otherLookup.get('shared-text'), CLAIM_OTHER);
    assert.notEqual(ownerLookup.get('shared-text'), otherLookup.get('shared-text'));
  });
});
