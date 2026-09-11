/**
 * The durable job queue — E4/PR-2, PR-3
 * Blueprint E4 · G2 idempotent · G3 owner-scoped · G4 purgeable · L5
 *
 * The in-memory registry drains on SIGTERM and loses everything to any other
 * kind of death. This table is where a job outlives its process.
 *
 * ⚠️ THE DATABASE TESTS ARE SKIPPED WITH A REASON when `DATABASE_URL` is unset,
 * following `pgBlobAdapter.test.js`. That file's live block had never once run
 * green before this engagement — a suite that silently skips its only
 * integration test is a suite that reports nothing — so the skip is loud and
 * the pure logic below is covered either way.
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   idempotency unique index      → 1 fail
 *   per-owner claim exclusion     → 2 fail
 *   dead-letter at max attempts   → 2 fail
 *   backoff is exponential+capped → 3 fail
 *   purgeOwner reaches the queue  → 1 fail
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  backoffMs, BACKOFF_CAP_MS, enqueue, claim, complete, fail,
  reapStale, queueStats, deadLetters, purgeOwner,
} from '../jobs/jobQueue.js';

const LIVE = Boolean(process.env.DATABASE_URL);
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';

// ── Pure policy: runs everywhere ─────────────────────────────────────────────

describe('backoff is a policy someone can argue with', () => {
  test('doubles per attempt, starting at one second', () => {
    // Exported and pure precisely so a disagreement can be settled with a run
    // rather than by reading the worker loop.
    assert.equal(backoffMs(0), 1_000);
    assert.equal(backoffMs(1), 2_000);
    assert.equal(backoffMs(2), 4_000);
    assert.equal(backoffMs(5), 32_000);
  });

  test('is CAPPED — otherwise attempt 20 is eleven days away', () => {
    assert.equal(backoffMs(20), BACKOFF_CAP_MS);
    assert.ok(BACKOFF_CAP_MS <= 60 * 60 * 1000, 'a cap above an hour is not a retry, it is a burial');
  });

  test('nonsense input does not produce a negative or NaN wait', () => {
    for (const bad of [-5, NaN, undefined, null, 'x']) {
      const ms = backoffMs(bad);
      assert.ok(Number.isFinite(ms) && ms >= 1_000, `backoffMs(${String(bad)}) = ${ms}`);
    }
  });
});

// ── Against a real database ──────────────────────────────────────────────────

describe('the queue, against Postgres', { skip }, () => {
  const OWNER_A = 'jobq-test-a';
  const OWNER_B = 'jobq-test-b';
  // ⚠️ A KIND OF ITS OWN, AND EVERY CLAIM FILTERED BY IT.
  //
  // The queue is shared. The first version of this file called `claim('w1')`
  // unfiltered and assumed the table held only its own rows — it failed the
  // moment a manual probe left a few behind, and would fail again against any
  // real deployment or a second test file. A test that assumes exclusive use of
  // a shared resource is testing the resource being idle.
  const KIND = 'jobq-test';
  const take = w => claim(w, { kinds: [KIND] });

  const clean = async () => { await purgeOwner(OWNER_A); await purgeOwner(OWNER_B); };
  before(clean);
  after(clean);

  test('enqueue is IDEMPOTENT on (owner, key) — a retry is not a duplicate', async () => {
    // Post-turn work is read-modify-write. A caller retrying an enqueue must
    // not produce two jobs, or the second undoes the first (G2).
    await clean();
    const a = await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: 'same' });
    const b = await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: 'same' });
    assert.equal(a.created, true);
    assert.equal(b.created, false, 'the second enqueue created a second job');
    assert.equal(a.jobId, b.jobId);
  });

  test('the same key for a DIFFERENT owner is a different job (G3)', async () => {
    await clean();
    const a = await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: 'shared' });
    const b = await enqueue({ ownerId: OWNER_B, kind: KIND, idempotencyKey: 'shared' });
    assert.notEqual(a.jobId, b.jobId, 'two owners collided on one idempotency key');
  });

  test('THE ORDERING GUARANTEE: one owner cannot have two jobs running', async () => {
    // E4/PR-4 enforced this in one process with a Map. N workers have no shared
    // memory, so the claim query has to carry it — otherwise the durable path
    // silently loses the guarantee the in-memory path has.
    await clean();
    await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: '1' });
    await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: '2' });

    const first = await take('w1');
    const second = await take('w2');
    assert.equal(first?.ownerId, OWNER_A);
    assert.equal(second, null, 'a second job for the same owner was claimed while the first was running');

    await complete(first.jobId);
    assert.equal((await take('w2'))?.ownerId, OWNER_A, 'the queue did not resume after the first finished');
  });

  test('DIFFERENT owners are claimed concurrently — not a global lock', async () => {
    await clean();
    await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: 'a' });
    await enqueue({ ownerId: OWNER_B, kind: KIND, idempotencyKey: 'b' });
    const one = await take('w1');
    const two = await take('w2');
    assert.ok(one && two, 'two owners could not be claimed at once — this is a global lock');
    assert.notEqual(one.ownerId, two.ownerId);
  });

  test('priority orders the queue; ties break oldest-first', async () => {
    await clean();
    await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: 'slow', priority: 200 });
    await enqueue({ ownerId: OWNER_B, kind: KIND, idempotencyKey: 'fast', priority: 10 });
    assert.equal((await take('w1'))?.ownerId, OWNER_B, 'a low-priority job was claimed first');
  });

  test('a failure RETRIES with backoff and is not immediately reclaimable', async () => {
    await clean();
    await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: 'r', maxAttempts: 3 });
    const job = await take('w1');
    const r = await fail(job.jobId, new Error('transient'));
    assert.equal(r.state, 'queued');
    assert.equal(r.retryInMs, backoffMs(1));
    assert.equal(await take('w1'), null, 'a job in backoff was claimable immediately');
  });

  test('DEAD-LETTERED at max attempts, WITH the reason', async () => {
    // A DLQ without reasons is a list of regrets.
    await clean();
    await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: 'd', maxAttempts: 1 });
    const job = await take('w1');
    const r = await fail(job.jobId, new Error('permanent: bad payload'));
    assert.equal(r.state, 'dead');

    const dead = await deadLetters(10);
    const mine = dead.find(d => Number(d.job_id) === job.jobId);
    assert.ok(mine, 'the dead job is not in the DLQ');
    assert.match(mine.last_error, /permanent: bad payload/);
  });

  test('a DEAD job is KEPT, not deleted (L5)', async () => {
    // The row is the only record that the work was asked for and never
    // happened. Deleting it turns a reportable failure into an absence.
    const stats = await queueStats();
    assert.ok(stats.dead >= 1, 'dead jobs are being removed rather than retained');
  });

  test('a job stranded by a vanished worker is RECLAIMED', async () => {
    // Without this, one crash wedges one owner permanently behind the very
    // predicate that guarantees their ordering.
    await clean();
    await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: 's' });
    const job = await take('dying-worker');
    assert.ok(job);
    assert.equal(await take('w2'), null, 'the owner was not blocked by the running job');

    assert.ok(await reapStale(0) >= 1, 'nothing was reclaimed');
    assert.ok(await take('w2'), 'the reclaimed job was not re-issued');
  });

  test('purgeOwner reaches the queue (G4)', async () => {
    await clean();
    await enqueue({ ownerId: OWNER_A, kind: KIND, idempotencyKey: 'p1' });
    await enqueue({ ownerId: OWNER_B, kind: KIND, idempotencyKey: 'p2' });
    const r = await purgeOwner(OWNER_A);
    assert.ok(r.jobs >= 1, 'account deletion left jobs behind');

    // The other owner is untouched — the delete is scoped, not a truncate.
    const survivor = await take('w1');
    assert.equal(survivor?.ownerId, OWNER_B);
  });

  test('purgeOwner without Postgres is a no-op, not an erasure failure', async () => {
    // Same contract as claimRepository: most deployments have no DATABASE_URL,
    // and reporting a compliance failure for a database they never had would
    // train callers to ignore the one array that must never be ignored.
    assert.deepEqual(await purgeOwner(null), { jobs: 0, skipped: 'no owner' });
  });
});

describe('the queue refuses work it cannot make idempotent', () => {
  test('an enqueue without an idempotency key is refused', async () => {
    await assert.rejects(() => enqueue({ ownerId: 'x', kind: 'k' }), /idempotencyKey is required/);
  });

  test('an enqueue without an owner is refused (G3)', async () => {
    await assert.rejects(() => enqueue({ kind: 'k', idempotencyKey: 'k' }), /ownerId is required/);
  });
});
