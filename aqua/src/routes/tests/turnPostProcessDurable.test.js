/**
 * E4/E6 — durable scheduling of understanding on the real turn path.
 * Blueprint §3.2: understanding leaves the request thread.
 *
 * BITE (measured): always run in-process → 2 fail; never fall back when enqueue
 * throws → 1 fail; run BOTH paths → 1 fail; count `scheduled` as a skip → 1 fail.
 * The Postgres behaviour of `enqueue` itself is covered (live-DB gated) in
 * core/tests/jobQueue.test.js; this file proves the ROUTING, not the queue.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runPostTurn } from '../turnPostProcess.js';
import { getMetrics, logE6Turn, _resetE6Metrics } from '../../core/observability.js';
import { e6CommitEnabled } from '../../brain/index.js';

const saved = { e6: process.env.AQUA_E6, commit: process.env.AQUA_E6_COMMIT };
afterEach(() => {
  for (const [k, v] of [['AQUA_E6', saved.e6], ['AQUA_E6_COMMIT', saved.commit]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  _resetE6Metrics();
});

const ARGS = { ownerId: 'user:a', conversationId: 'conv-1', userMessage: 'I moved to Pune last month.' };

async function drive(over = {}, args = ARGS) {
  const jobs = [];
  const calls = { enqueue: [], understand: 0, reports: [] };
  const deps = {
    memoryAfterTurn: () => {}, observeConversationTurn: () => {}, observeTwin: () => {},
    reflectTurn: () => {}, consolidate: () => {}, consolidateEnabled: () => false,
    getConversation: () => [1, 2, 3],
    e6Enabled: () => true,
    durableQueueAvailable: () => true,
    enqueueUnderstanding: async (j) => { calls.enqueue.push(j); return { jobId: 7, created: true }; },
    understandTurn: async () => { calls.understand++; return { stats: {} }; },
    reportE6: (r) => calls.reports.push(r),
    projectClaimsShadow: async () => null,
    defer: fn => jobs.push(fn),
    ...over,
  };
  runPostTurn(args, deps);
  for (const j of jobs) await j();
  await new Promise(r => setImmediate(r));
  return calls;
}

describe('understanding is scheduled durably when the queue is available', () => {
  test('enqueues one understanding.turn.v1 job and does NOT also run in-process', async () => {
    const c = await drive();
    assert.equal(c.enqueue.length, 1);
    assert.equal(c.enqueue[0].kind, 'understanding.turn.v1');
    assert.equal(c.enqueue[0].ownerId, 'user:a');
    assert.deepEqual(c.enqueue[0].payload, { conversationId: 'conv-1', turn: 3, userMessage: ARGS.userMessage });
    assert.equal(c.understand, 0, 'both paths ran — one turn would cost two provider calls');
    assert.equal(c.reports.length, 1);
    assert.ok(c.reports[0].scheduled, 'the scheduling was not reported');
  });

  test('the idempotency key is stable per (conversation, turn) and differs across turns', async () => {
    const a = await drive();
    const b = await drive();
    const next = await drive({ getConversation: () => [1, 2, 3, 4] });
    assert.equal(a.enqueue[0].idempotencyKey, b.enqueue[0].idempotencyKey);
    assert.notEqual(a.enqueue[0].idempotencyKey, next.enqueue[0].idempotencyKey);
  });

  test('a queue failure falls back to in-process — degraded, never silent', async () => {
    const c = await drive({ enqueueUnderstanding: async () => { throw new Error('pg down'); } });
    assert.equal(c.understand, 1);
    assert.equal(c.reports.length, 1);
    assert.equal(c.reports[0].scheduled, undefined);
  });

  test('no Postgres configured → the original in-process path, no enqueue attempted', async () => {
    const c = await drive({ durableQueueAvailable: () => false });
    assert.equal(c.enqueue.length, 0);
    assert.equal(c.understand, 1);
  });

  test('E6 off → neither path runs', async () => {
    const c = await drive({ e6Enabled: () => false });
    assert.equal(c.enqueue.length, 0);
    assert.equal(c.understand, 0);
  });

  test('a reporter that throws cannot break the turn', async () => {
    await assert.doesNotReject(() => drive({ reportE6: () => { throw new Error('boom'); } }));
  });
});

describe('a scheduled turn is not a skipped turn', () => {
  test('logE6Turn({scheduled}) counts scheduled and leaves turns/skipped alone', () => {
    _resetE6Metrics();
    const log = console.log; console.log = () => {};
    try { logE6Turn({ ownerId: 'u', conversationId: 'c', scheduled: { created: true }, ms: 1 }); }
    finally { console.log = log; }
    const e6 = getMetrics().e6;
    assert.equal(e6.scheduled, 1);
    assert.equal(e6.turns, 0);
    assert.equal(e6.skipped, 0);
  });
});

describe('canonical commit default follows E6', () => {
  test('E6 off (today) → commit off; nothing changes until E6 is deliberately promoted', () => {
    delete process.env.AQUA_E6; delete process.env.AQUA_E6_COMMIT;
    assert.equal(e6CommitEnabled(), false);
  });
  test('E6 on → commit on by default', () => {
    process.env.AQUA_E6 = 'on'; delete process.env.AQUA_E6_COMMIT;
    assert.equal(e6CommitEnabled(), true);
  });
  test('AQUA_E6_COMMIT=off is the explicit rollback', () => {
    process.env.AQUA_E6 = 'on'; process.env.AQUA_E6_COMMIT = 'off';
    assert.equal(e6CommitEnabled(), false);
  });
});
