/**
 * E10 migration machinery. The pure half runs everywhere; the live half needs
 * AQUA_TEST_DATABASE_URL and SKIPS visibly without it.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTurnSourceId } from './turnSourceIdentity.js';

const M = await import('./e10Migration.js');
const { isConfigured, getPool, closePool } = await import('../db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const fact = (id, statement, over = {}) => ({
  id, statement, entities: ['You'], confidence: 0.7, sourceType: 'conversation', evidence: [`ev-${id}`], createdAt: 1000, ...over,
});

describe('E10 — pure planning and parity', () => {
  test('a fact is covered when its turn has canonical claims, or when it was already backfilled', () => {
    const facts = [fact('conv:c1:1:fact:0', 'I work at Nummo'), fact('conv:c1:2:fact:0', 'I like tea'), fact('doc:x:fact:3', 'Spec says X')];
    const claimsBySource = new Map([[canonicalTurnSourceId('o', 'c1', 1), 2]]);
    const plan = M.planOwner('o', facts, claimsBySource, new Set(['doc:x:fact:3']));
    assert.deepEqual(plan.covered.map(c => c.by).sort(), ['backfill', 'e6-turn']);
    assert.deepEqual(plan.lacking.map(f => f.id), ['conv:c1:2:fact:0']);
  });

  test('parity accounts for EVERY lacking fact — backfilled, unprojectable, or it is not ok', () => {
    const plan = { covered: [{ id: 'a' }], lacking: [{ id: 'b' }, { id: 'c' }, { id: 'd' }] };
    assert.equal(M.parityOf(plan, { mappings: [{ factId: 'b' }], skipped: [{ id: 'c' }] }).ok, false, 'd is unaccounted');
    const ok = M.parityOf(plan, { mappings: [{ factId: 'b' }, { factId: 'd' }], skipped: [{ id: 'c' }] });
    assert.equal(ok.ok, true);
    assert.equal(ok.unprojectable, 1);
    assert.equal(M.parityOf(plan, { mappings: [{ factId: 'b' }, { factId: 'd' }], skipped: [{ id: 'c' }], failures: [{ id: 'x' }] }).ok, false,
      'a failed write is never ok');
  });

  test('legacy-write detection reports facts written after a cutover', () => {
    const r = M.legacyWritesSince([fact('a', 'x', { createdAt: 10 }), fact('b', 'y', { createdAt: 99 })], 50);
    assert.equal(r.count, 1);
    assert.deepEqual(r.sample, ['b']);
  });
});

after(async () => { if (LIVE) await closePool(); });

describe('E10 — live: dry-run, apply, resume, rollback, isolation, purge', { skip }, () => {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const OWNER = `user:e10-a-${run}`;
  const OTHER = `user:e10-b-${run}`;
  const facts = [fact('conv:c9:1:fact:0', 'I work at Nummo'), fact('conv:c9:2:fact:0', 'I prefer tea'),
    fact('conv:c9:3:fact:0', 'broken', { entities: [] })];
  const evidenceById = new Map(facts.map(f => [`ev-${f.id}`, { quote: f.statement }]));
  const count = async (sql, params) => (await (await getPool()).query(sql, params)).rows[0].n;
  const claimsOf = owner => count(`SELECT count(*)::int n FROM aqua_claims WHERE owner_id=$1 AND state <> 'archived'`, [owner]);
  const orphans = owner => count(
    `SELECT count(*)::int n FROM aqua_evidence e WHERE e.owner_id=$1
       AND NOT EXISTS (SELECT 1 FROM aqua_claim_evidence ce WHERE ce.owner_id=e.owner_id AND ce.evidence_id=e.evidence_id)`, [owner]);

  test('dry-run writes no claim, and records the plan', async () => {
    const r = await M.migrateOwner({ ownerId: OWNER, runId: `dry-${run}`, mode: 'dry-run', facts, evidenceById });
    assert.equal(r.wouldBackfill, 2);
    assert.equal(await claimsOf(OWNER), 0);
    const [row] = await M.runStatus(`dry-${run}`);
    assert.equal(row.status, 'done');
  });

  test('apply backfills only what canonical lacks, with parity, the run as actor, and no orphan evidence', async () => {
    const r = await M.migrateOwner({ ownerId: OWNER, runId: run, mode: 'apply', facts, evidenceById, operator: 'test' });
    assert.equal(r.backfilled, 2);
    assert.equal(r.parity.ok, true, JSON.stringify(r.parity));
    assert.equal(r.parity.unprojectable, 1);
    assert.equal(r.lackingAfter, 1, 'only the unprojectable fact remains, and it is reported');
    assert.equal(await count(`SELECT count(*)::int n FROM aqua_claims WHERE owner_id=$1 AND actor=$2`, [OWNER, `import:e10:${run}`]), 2);
    assert.equal(await orphans(OWNER), 0);
  });

  test('re-running the same run is a checkpointed no-op; a new run writes nothing twice', async () => {
    const again = await M.migrateOwner({ ownerId: OWNER, runId: run, mode: 'apply', facts, evidenceById });
    assert.match(again.skipped ?? '', /checkpoint/);
    const second = await M.migrateOwner({ ownerId: OWNER, runId: `${run}-2`, mode: 'apply', facts, evidenceById });
    assert.equal(second.backfilled, 0);
    assert.equal(await claimsOf(OWNER), 2);
    assert.equal(await orphans(OWNER), 0, 're-running left orphan evidence');
  });

  test('rollback archives exactly the run\'s claims (L5: nothing deleted) and records it', async () => {
    const r = await M.rollbackOwner({ ownerId: OWNER, runId: run, operator: 'test' });
    assert.equal(r.archived, 2);
    assert.equal(await claimsOf(OWNER), 0);
    assert.equal(await count(`SELECT count(*)::int n FROM aqua_claims WHERE owner_id=$1 AND state='archived'`, [OWNER]), 2);
    assert.equal((await M.runStatus(run)).find(x => x.owner_id === OWNER).status, 'rolled_back');
    assert.ok(await count(`SELECT count(*)::int n FROM aqua_lifecycle_transitions WHERE owner_id=$1 AND to_state='archived'`, [OWNER]) >= 2,
      'rollback must leave an audit trail');
  });

  test('owner isolation: another owner is untouched by this owner\'s run and rollback', async () => {
    await M.migrateOwner({ ownerId: OTHER, runId: `${run}-b`, mode: 'apply', facts, evidenceById });
    assert.equal(await claimsOf(OTHER), 2);
    await M.rollbackOwner({ ownerId: OWNER, runId: `${run}-b` });
    assert.equal(await claimsOf(OTHER), 2);
  });

  test('purge removes the owner\'s migration audit rows', async () => {
    await M.purgeOwner(OWNER);
    assert.equal(await count(`SELECT count(*)::int n FROM aqua_migration_runs WHERE owner_id=$1`, [OWNER]), 0);
    assert.ok(await count(`SELECT count(*)::int n FROM aqua_migration_runs WHERE owner_id=$1`, [OTHER]) > 0);
  });
});
