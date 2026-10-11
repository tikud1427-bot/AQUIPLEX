/**
 * 0022 — two facts from ONE sentence must both commit (live Postgres).
 *
 * Found 2026-10-05 validating `start:production` with real Groq extraction:
 * "Tidepool's backend is written in Go on Postgres, the launch date is March
 * 15, and the total budget is $20,000" → uses→Go and uses→Postgres share
 * subject, predicate and the segment's sentence. Under 0017's key the second
 * INSERT violated aqua_claims_dedup_current_idx, the transaction rolled back,
 * the job dead-lettered after 5 attempts and the whole turn was lost.
 *
 * pg-mem does not enforce partial unique indexes (memoryPg.mjs skips them), so
 * this can only be proven against a real migrated Postgres.
 * Skips visibly without AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { isConfigured, getPool, closePool } = await import('../db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const { commitUnderstanding } = await import('../worldModel/worldModelRepository.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const USER = `dedup-obj-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `user:${USER}`;
const SENTENCE = "Tidepool's backend is written in Go on Postgres";

const ent = (id, name) => ({ entityId: id, canonical: name, name, type: 'concept' });
const uses = (tech, over = {}) => ({
  claimId: crypto.randomUUID(),
  predicate: 'uses', objectKind: 'entity',
  subject: 'Tidepool', object: { entity: tech },
  polarity: 'asserted', modality: 'fact', timePrecision: 'none',
  statementText: SENTENCE,
  _canonicalSubject: ent('aq:name:tidepool', 'Tidepool'),
  _canonicalObject: ent(`aq:name:${tech.toLowerCase()}`, tech),
  resolution: { ready: true },
  ...over,
});
const input = claims => ({
  ownerId: OWNER, sourceId: crypto.randomUUID(), actor: 'e6:test', extractorVersion: 'e6-test',
  segmentRange: { start: 0, end: SENTENCE.length }, sourceKind: 'conversation',
  title: 't', contentHash: crypto.randomUUID(), assertedAt: new Date(), claims,
});
const current = async () => (await (await getPool()).query(
  `SELECT c.state, e.canonical_label AS object
     FROM aqua_claims c LEFT JOIN aqua_entities e ON e.entity_id = c.object_entity_id
    WHERE c.owner_id=$1 AND c.state NOT IN ('superseded','archived') ORDER BY object`, [OWNER])).rows;

describe('current-claim guard keys on the object (0022)', { skip }, () => {
  after(async () => {
    if (!LIVE) return;
    await purgeOwnerData({ userId: USER });
    await closePool();
  });

  test('uses→Go and uses→Postgres from one sentence BOTH commit', async () => {
    const res = await commitUnderstanding(input([uses('Go'), uses('Postgres')]));
    assert.equal(res.claims?.length, 2, 'the commit did not return both claims');
    const rows = await current();
    assert.deepEqual(rows.map(r => r.object), ['Go', 'Postgres']);
    assert.ok(rows.every(r => r.state === 'active'));
  });

  test('an IDENTICAL current claim is still refused — the guard was narrowed, not removed', async () => {
    await assert.rejects(commitUnderstanding(input([uses('Go')])), /aqua_claims_dedup_current_idx/);
    assert.equal((await current()).length, 2, 'the refused commit left a row behind');
  });
});
