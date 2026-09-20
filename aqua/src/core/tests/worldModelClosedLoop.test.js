/**
 * AQUIPLEX — closed World-Model loop contract.
 *
 * This test deliberately stops at the canonical substrate boundary. It does
 * not pretend pg-mem is pgvector or an LLM. It proves the invariant that the
 * rest of E7 depends on:
 *
 *   Turn 1 -> Alpha is current
 *   Turn 2 -> Alpha is retrievable
 *   Turn 3 -> Beta supersedes Alpha
 *   Turn 4 -> only Beta is current/retrievable, while Alpha remains history
 *
 * The real embedding/LLM integration is separately covered by live-environment
 * tests; this suite makes the state transition itself executable everywhere.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import { transition, readHistory } from '../worldModel/worldModelRepository.js';
import { historyOf } from '../claims/projection.js';

const OWNER = 'user:closed-loop';
let mem, restore;
let subject, alpha, beta, sourceAlpha, sourceBeta;

async function entity(label, type = 'project') {
  const id = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_entities (entity_id,owner_id,type,canonical_label,normalized_label)\n     VALUES ($1,$2,$3,$4,$5)`,
    [id, OWNER, type, label, label.toLowerCase()],
  );
  return id;
}

async function source(kind = 'conversation') {
  const id = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_sources (source_id,owner_id,kind,trust_tier)\n     VALUES ($1,$2,$3,0.6)`,
    [id, OWNER, kind],
  );
  return id;
}

async function claim({ objectEntityId, statement, sourceId, actor = 'user' }) {
  const id = crypto.randomUUID();
  const evidenceId = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_claims (\n       claim_id,owner_id,subject_entity_id,predicate,object_entity_id,\n       polarity,modality,asserted_at,state,extractor,extractor_version,actor,\n       statement_text,statement_norm)\n     VALUES ($1,$2,$3,'works_on',$4,'asserted','fact',now(),'active','e6','closed-loop',\n             $5,$6,$7)`,
    [id, OWNER, subject, objectEntityId, actor, statement, statement.toLowerCase()],
  );
  await mem.pool.query(
    `INSERT INTO aqua_evidence (evidence_id,owner_id,source_id,quote,checksum)\n     VALUES ($1,$2,$3,$4,'checksum')`,
    [evidenceId, OWNER, sourceId, statement],
  );
  await mem.pool.query(
    `INSERT INTO aqua_claim_evidence (owner_id,claim_id,evidence_id,role)\n     VALUES ($1,$2,$3,'primary')`,
    [OWNER, id, evidenceId],
  );
  return id;
}

async function currentRetrieval() {
  // This is intentionally the canonical CURRENT filter used by the E7 dense
  // repository. The vector score is omitted because pg-mem does not implement
  // pgvector; the lifecycle invariant is what this contract owns.
  const { rows } = await mem.pool.query(`
    SELECT c.claim_id, c.statement_text
      FROM aqua_claims c
     WHERE c.owner_id=$1 AND c.state IN ('active','trusted')
     ORDER BY c.asserted_at ASC, c.claim_id ASC`, [OWNER]);
  return rows;
}

before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  _resetForTests();
  mem = createMemoryPg();
  restore = _setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();

  subject = await entity('Me', 'self');
  alpha = await entity('Project Alpha');
  beta = await entity('Project Beta');
  sourceAlpha = await source();
  sourceBeta = await source('user_correction');
});

after(async () => {
  restore?.();
  await mem?.close();
  delete process.env.DATABASE_URL;
  _resetForTests();
});

describe('closed World-Model loop', () => {
  test('four-turn correction loop preserves current truth and history', async () => {
    // Turn 1 — E6-produced canonical claim.
    const alphaClaim = await claim({
      objectEntityId: alpha,
      sourceId: sourceAlpha,
      statement: 'I work on Project Alpha.',
    });

    // Turn 2 — E7 current retrieval must be able to see Alpha.
    let current = await currentRetrieval();
    assert.equal(current.length, 1);
    assert.equal(current[0].claim_id, alphaClaim);

    // Turn 3 — E6 produces the corrected claim; E9 supersedes Alpha.
    const betaClaim = await claim({
      objectEntityId: beta,
      sourceId: sourceBeta,
      statement: 'I work on Project Beta.',
    });

    await transition({
      ownerId: OWNER,
      actor: 'user',
      targetKind: 'claim',
      targetId: alphaClaim,
      toState: 'superseded',
      supersededBy: betaClaim,
      reason: 'explicit user correction',
      source: 'e9',
    });

    // Turn 4 — E7 current retrieval must exclude Alpha and retain Beta.
    current = await currentRetrieval();
    assert.deepEqual(current.map(r => r.claim_id), [betaClaim]);

    // Alpha is not deleted: historical projection must recover it.
    const history = await historyOf(OWNER, subject, 'works_on');
    assert.equal(history.length, 2);
    const old = history.find(h => h.claimId === alphaClaim);
    const fresh = history.find(h => h.claimId === betaClaim);
    assert.equal(old.current, false);
    assert.equal(old.supersededBy, betaClaim);
    assert.equal(fresh.current, true);

    const audit = await readHistory({ ownerId: OWNER, targetKind: 'claim', targetId: alphaClaim });
    assert.ok(audit.transitions.some(t => t.to_state === 'superseded'));
    assert.ok(audit.revisions.some(r => r.change_kind === 'supersede'));
  });

  test('supersession records a temporal cutoff so historical queries remain meaningful', async () => {
    const alphaClaim = await claim({
      objectEntityId: alpha,
      sourceId: sourceAlpha,
      statement: 'I work on Project Alpha — historical cutoff test.',
    });
    const betaClaim = await claim({
      objectEntityId: beta,
      sourceId: sourceBeta,
      statement: 'I work on Project Beta — historical cutoff test.',
    });
    const cutoff = new Date('2026-09-18T07:00:00.000Z');

    await transition({
      ownerId: OWNER,
      actor: 'user',
      targetKind: 'claim',
      targetId: alphaClaim,
      toState: 'superseded',
      supersededBy: betaClaim,
      validTo: cutoff,
      reason: 'correction with known validity cutoff',
      source: 'e9',
    });

    const row = (await mem.pool.query(
      `SELECT state, superseded_by, valid_to FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2`,
      [OWNER, alphaClaim],
    )).rows[0];
    assert.equal(row.state, 'superseded');
    assert.equal(row.superseded_by, betaClaim);
    assert.equal(new Date(row.valid_to).toISOString(), cutoff.toISOString());
  });
});

console.log('worldModelClosedLoop: executable canonical four-turn contract');
