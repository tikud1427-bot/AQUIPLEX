/**
 * Worker activity is visible to the server's /metrics (2026-10-04).
 * Live: a real job through the production runOneJob → the worker's snapshot
 * publish → the REAL GET /metrics route. Two process ids stand in for two
 * worker instances; a stale snapshot must age out. Skips visibly without a DB.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { isConfigured, getPool, closePool } = await import('../db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

test('the worker process starts the snapshot publisher and flushes on shutdown (wiring)', () => {
  const src = readFileSync(path.join(ROOT, 'scripts', 'worker.mjs'), 'utf8');
  assert.match(src, /startMetricsPublisher\(\{ role: 'worker' \}\)/);
  assert.match(src, /await stopMetrics\?\.\(\)/);
});

after(async () => { if (LIVE) await closePool(); });

describe('live: worker → Postgres snapshot → server /metrics', { skip }, () => {
  test('a job run by the worker shows up in /metrics, per worker instance; a dead worker ages out', async () => {
    const { enqueue } = await import('../jobs/jobQueue.js');
    const { runOneJob } = await import('../jobs/workerRuntime.js');
    const { publishProcessMetrics, processSnapshot } = await import('../processMetrics.js');
    const { default: health } = await import('../../routes/health.js');
    const p = await getPool();
    const run = Date.now().toString(36);

    // A reflection job for a claim that does not exist completes terminally
    // (claim-not-found) — no provider needed, the job.run span is real.
    const owner = `pm-${run}`;
    await enqueue({ ownerId: owner, kind: 'claim.reflection.v1', payload: { claimId: '00000000-0000-4000-8000-000000000000' }, idempotencyKey: `pm:${run}`, priority: 0 });  // ahead of any leftover queued jobs
    let r;
    for (let i = 0; i < 50; i++) { r = await runOneJob(`pm-test-${run}`, { kinds: ['claim.reflection.v1'] }); if (!r || r.ownerId === owner) break; }
    assert.equal(r?.ownerId, owner, 'the test job was not run');

    const snap = processSnapshot();
    assert.ok(snap.telemetry.stages['job.run']?.count >= 1, 'the job did not record a span');
    await publishProcessMetrics({ role: 'worker', processId: `w1-${run}` });
    await publishProcessMetrics({ role: 'worker', processId: `w2-${run}`, snapshot: { telemetry: { stages: { 'job.run': { count: 3, sumMs: 9, maxMs: 4, errors: 1 } }, errors: {} }, cost: { calls: 2, unpricedCalls: 2, byPurpose: { extraction: { inputTokens: 100, outputTokens: 20 } } }, e6: { turns: 2 } } });
    await publishProcessMetrics({ role: 'worker', processId: `w-dead-${run}`, snapshot: { e6: { turns: 9 } } });
    await p.query(`UPDATE aqua_process_metrics SET updated_at = now() - interval '1 hour' WHERE process_id = $1`, [`w-dead-${run}`]);

    const app = express(); app.use('/health', health);
    const server = app.listen(0);
    try {
      const text = await (await fetch(`http://127.0.0.1:${server.address().port}/health/metrics`)).text();
      assert.match(text, new RegExp(`aqua_worker_span_count\\{process="w1-${run}",stage="job\\.run"\\} \\d+`));
      assert.match(text, new RegExp(`aqua_worker_span_errors_total\\{process="w2-${run}",stage="job\\.run"\\} 1`));
      assert.match(text, new RegExp(`aqua_worker_cost_purpose_tokens_total\\{process="w2-${run}",purpose="extraction"\\} 120`));
      assert.doesNotMatch(text, new RegExp(`w-dead-${run}`), 'a worker that stopped publishing is still reported');
      assert.match(text, /aqua_workers_alive \d+/);
    } finally {
      server.close();
      await p.query(`DELETE FROM aqua_process_metrics WHERE process_id LIKE $1`, [`%-${run}`]);
    }
  });
});
