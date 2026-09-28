/**
 * E4/PR-7 — DLQ alert policy (pure) + requeueDead (live-DB gated).
 * BITE (measured): drop the per-kind rule → 1 fail; drop the age rule → 1 fail.
 * The `requeueDead` state-guard test is LIVE-DB ONLY and was NOT run here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDlq, DLQ_THRESHOLDS } from '../jobs/dlqPolicy.js';
import { requeueDead, enqueue, claim, fail, complete } from '../jobs/jobQueue.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const dead = (kind, hoursAgo = 0) => ({ kind, updated_at: new Date(NOW - hoursAgo * 3600000) });

describe('evaluateDlq', () => {
  test('an empty, healthy queue is ok with no reasons', () => {
    const v = evaluateDlq({ stats: { queued: 3, running: 1, done: 500, dead: 0 }, dead: [], now: NOW });
    assert.equal(v.level, 'ok');
    assert.deepEqual(v.reasons, []);
    assert.equal(v.oldestDeadAgeMs, null);
  });

  test('one fresh dead job is a warning, not an alert (L5: it is evidence, not an incident)', () => {
    const v = evaluateDlq({ stats: { dead: 1 }, dead: [dead('understanding.turn.v1', 0.1)], now: NOW });
    assert.equal(v.level, 'warn');
  });

  test('a pile at the threshold alerts', () => {
    const rows = Array.from({ length: DLQ_THRESHOLDS.alertDead }, (_, i) => dead(`k${i}`, 0.1));
    const v = evaluateDlq({ stats: { dead: rows.length }, dead: rows, now: NOW });
    assert.equal(v.level, 'alert');
  });

  test('an old unhandled dead job alerts even when there is only one', () => {
    const v = evaluateDlq({ stats: { dead: 1 }, dead: [dead('claim.reflection.v1', 7)], now: NOW });
    assert.equal(v.level, 'alert');
    assert.match(v.reasons.join(' '), /unhandled/);
  });

  test('one kind failing repeatedly is named — that is a bug, not noise', () => {
    const rows = Array.from({ length: DLQ_THRESHOLDS.alertDeadPerKind }, () => dead('embed.claim.v1', 0.1));
    const v = evaluateDlq({ stats: { dead: rows.length }, dead: rows, now: NOW });
    assert.equal(v.level, 'alert');
    assert.match(v.reasons.join(' '), /embed\.claim\.v1/);
    assert.equal(v.byKind['embed.claim.v1'], rows.length);
  });

  test('a large backlog with no dead jobs warns that the worker may be down', () => {
    const v = evaluateDlq({ stats: { queued: DLQ_THRESHOLDS.warnQueued, dead: 0 }, dead: [], now: NOW });
    assert.equal(v.level, 'warn');
    assert.match(v.reasons.join(' '), /worker/);
  });

  test('level is the max of all reasons, and malformed rows never throw', () => {
    const v = evaluateDlq({ stats: { dead: 2, queued: 5000 }, dead: [null, { kind: 42, updated_at: 'not a date' }], now: NOW });
    assert.equal(v.level, 'warn');
    assert.equal(v.byKind.unknown, 2);
    assert.doesNotThrow(() => evaluateDlq());
  });

  test('thresholds are overridable per call, not via env (L13)', () => {
    const v = evaluateDlq({ stats: { dead: 2 }, dead: [dead('a'), dead('b')], now: NOW, thresholds: { alertDead: 2 } });
    assert.equal(v.level, 'alert');
  });
});

const LIVE = Boolean(process.env.DATABASE_URL);
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';

describe('requeueDead', () => {
  test('rejects nonsense ids without touching the database', async () => {
    for (const bad of [null, undefined, 'x', -1, 0, 1.5]) {
      assert.deepEqual(await requeueDead(bad), { requeued: false });
    }
  });

  test('revives ONLY a dead job, keeps last_error, and cannot double-run a live one', { skip }, async () => {
    const key = `dlq-test-${Date.now()}-${Math.random()}`;
    const { jobId } = await enqueue({ ownerId: 'owner:dlq-test', kind: 'dlq.test', payload: {}, idempotencyKey: key, maxAttempts: 1 });
    const c = await claim('dlq-test-worker', { kinds: ['dlq.test'] });
    assert.equal(c?.job_id ?? c?.jobId, jobId);
    assert.equal((await requeueDead(jobId)).requeued, false, 'a running job must not be requeued');
    const f = await fail(jobId, 'boom');
    assert.equal(f.state, 'dead');
    assert.equal((await requeueDead(jobId)).requeued, true);
    assert.equal((await requeueDead(jobId)).requeued, false, 'second call finds it queued, not dead');
    const again = await claim('dlq-test-worker', { kinds: ['dlq.test'] });
    assert.equal(again?.job_id ?? again?.jobId, jobId);
    await complete(jobId);
  });
});
