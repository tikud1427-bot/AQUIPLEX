/**
 * E9 on a REAL Postgres: canonical claims built by E6 reach the Belief Engine.
 *
 *   understandTurn → aqua_claims + claim.created in the outbox
 *   → dispatchPendingClaimReflections → claim.reflection.v1 jobs
 *   → the PRODUCTION handler table (workerRuntime.HANDLERS)
 *   → belief created / revised + aqua_belief_claims provenance link
 *
 * Before 2026-10-04 an E6-only owner ran every reflection job and got zero
 * belief links. Only this test's owners' jobs are run (other live suites may
 * share the queue). The extraction model is scripted, as in the loop test.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.AQUA_E6 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const Brain = await import('../index.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const { getMind } = await import('../../mind/mindStore.js');
const { runClaimContradictionJob } = await import('../reflectionV3/contradictionWorker.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const USER = `belief-a-${run}`;
const OWNER = `user:${USER}`;
const OTHER = `user:belief-b-${run}`;

const claim = (subject, predicate, object, statementText) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9,
});
const SCRIPT = new Map([
  ['I work at Intercom', [claim('I', 'works_at', { entity: 'Intercom' }, 'I work at Intercom')]],
  ['I work at Nummo now', [claim('I', 'works_at', { entity: 'Nummo' }, 'I work at Nummo now')]],
  ['I am a product designer', [claim('I', 'role_is', { literal: 'product designer' }, 'I am a product designer')]],
  ['Priya works at Stripe', [claim('Priya', 'works_at', { entity: 'Stripe' }, 'Priya works at Stripe')]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/belief-loop' };
};
let turn = 0;
const say = (ownerId, s) => Brain.understandTurn({ ownerId, conversationId: `c-${run}`, turn: ++turn, userMessage: `${s}.`, callModel });

/** Dispatch the outbox, then run THIS owner's queued reflection/contradiction jobs through the production handlers. */
async function drainOwner(ownerId) {
  const p = await getPool();
  // Other live suites share the outbox: another process may be mid-dispatch on
  // THIS owner's rows. Settle until nothing of this owner's is pending or
  // processing and no job is queued — bounded (G6).
  for (let i = 0; i < 60; i++) {
    await dispatchReflections({ limit: 100 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='belief-loop-test', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND kind IN ('claim.reflection.v1','claim.contradiction.v1')
        RETURNING job_id, kind, owner_id, payload, attempts`, [ownerId]);
    if (!rows.length) {
      const { rows: [o] } = await p.query(
        `SELECT count(*)::int AS n FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing')
            AND event_type IN ('claim.created','claim.embedding.requested','claim.reflection.requested')`, [ownerId]);
      const { rows: [q] } = await p.query(
        `SELECT count(*)::int AS n FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running')
            AND kind IN ('claim.reflection.v1','claim.contradiction.v1')`, [ownerId]);
      if (!o.n && !q.n) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    for (const r of rows) {
      await HANDLERS[r.kind]({ jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts });
      await complete(r.job_id);
    }
  }
}
async function settleContradictions(ownerId) {
  const p = await getPool();
  const { rows } = await p.query(`SELECT payload FROM aqua_outbox WHERE owner_id=$1 AND event_type='claim.contradiction.detected'`, [ownerId]);
  for (const r of rows) await runClaimContradictionJob({ ownerId, payload: r.payload });
}
const links = async ownerId => (await (await getPool()).query(
  `SELECT bc.belief_key, bc.relation, c.statement_text FROM aqua_belief_claims bc
     JOIN aqua_claims c ON c.owner_id=bc.owner_id AND c.claim_id=bc.claim_id
    WHERE bc.owner_id=$1 ORDER BY bc.created_at, c.statement_text`, [ownerId])).rows;

after(async () => { if (LIVE) await closePool(); });

test('belief loop: live Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('E6 claims reach beliefs on live Postgres', { skip }, () => {
  test('a first-person claim creates the belief AND its provenance link', async () => {
    await say(OWNER, 'I work at Intercom');
    await say(OWNER, 'I am a product designer');
    await drainOwner(OWNER);
    const mind = getMind(OWNER);
    assert.equal(mind.beliefs['identity:organization']?.value, 'Intercom');
    assert.equal(mind.beliefs['identity:profession']?.value, 'product designer');
    const l = await links(OWNER);
    assert.deepEqual(l.map(x => [x.belief_key, x.statement_text]).sort(),
      [['organization', 'I work at Intercom'], ['profession', 'I am a product designer']]);
  });

  test('a claim about someone else never becomes a belief about the user', async () => {
    await say(OWNER, 'Priya works at Stripe');
    await drainOwner(OWNER);
    assert.equal(getMind(OWNER).beliefs['identity:organization'].value, 'Intercom');
    assert.ok(!(await links(OWNER)).some(x => /Priya/.test(x.statement_text)));
  });

  test('replaying reflection writes no duplicate links (idempotent)', async () => {
    const before = await links(OWNER);
    const p = await getPool();
    await p.query(`UPDATE aqua_jobs SET state='queued' WHERE owner_id=$1 AND kind='claim.reflection.v1'`, [OWNER]);
    await drainOwner(OWNER);
    assert.deepEqual(await links(OWNER), before);
  });

  test('a changed employer: claim superseded (lifecycle) and the belief follows the new value', async () => {
    await say(OWNER, 'I work at Nummo now');
    await settleContradictions(OWNER);
    await drainOwner(OWNER);
    const rows = (await (await getPool()).query(
      `SELECT statement_text, state FROM aqua_claims WHERE owner_id=$1 AND predicate='works_at' AND statement_text LIKE 'I work%' ORDER BY asserted_at`, [OWNER])).rows;
    assert.deepEqual(rows.map(r => r.state), ['superseded', 'active']);
    const org = getMind(OWNER).beliefs['identity:organization'];
    assert.equal(org.value, 'Nummo', `belief did not follow the change: ${JSON.stringify(org)}`);
    assert.ok(org.history?.some(h => JSON.stringify(h).includes('Intercom')), 'the old value must be versioned, not erased');
    assert.ok((await links(OWNER)).some(x => x.statement_text === 'I work at Nummo now'));
  });

  test('owner isolation: another owner\'s turns create nothing for this owner', async () => {
    const before = await links(OWNER);
    await say(OTHER, 'I work at Intercom');
    await drainOwner(OTHER);
    assert.deepEqual(await links(OWNER), before);
    assert.equal((await links(OTHER)).length, 1);
  });

  test('purge removes every belief link for the owner', async () => {
    await purgeOwnerData({ userId: USER });
    assert.deepEqual(await links(OWNER), []);
  });
});
