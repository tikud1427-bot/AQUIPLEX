import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('E7 canonical claim retrieval bridge', () => {
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
