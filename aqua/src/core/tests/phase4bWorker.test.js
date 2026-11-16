/**
 * Phase 4B — the Linux "worker processed nothing" investigation
 * (AQUIPLEX_WORKER_FAILURE_INVESTIGATION.md), as regression tests.
 *
 * ROOT CAUSE (from the database's own history of the failing run): not a hang.
 * The worker was busy for the whole window on a backlog of HIGHER-priority
 * work — 1,228 claim reflections, then 989 claim-embedding jobs failing fast
 * and coming back every few seconds — and strict priority never let it reach
 * a new turn's learning jobs (priority 50).
 *
 *   aging      a job that has waited outranks a freshly retried better-priority job
 *   starvation a continuous stream of re-queued higher-priority jobs does not
 *              starve a lower-priority job (it is claimed within a bound)
 *   startup    the worker states boot → db → partitions → ready → lease → summary
 *              (with queue lag), so a silent no-progress worker cannot recur unseen
 *   fail-closed a worker whose database is unreachable exits, it does not idle
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = Boolean(process.env.DATABASE_URL);
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const RUN = Date.now().toString(36);
const HI = `test.p4b.hi.${RUN}`;
const LO = `test.p4b.lo.${RUN}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
// One aging point per 50 ms, so the test runs in seconds (production default: 5 s).
process.env.AQUA_JOB_AGING_SECONDS = '0.05';

let Q; let pool;
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

describe('Phase 4B — worker starvation and startup (real Postgres)', { skip, concurrency: false }, () => {
  before(async () => {
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    Q = await import('../jobs/jobQueue.js');
    pool = await (await import('../db/pool.js')).getPool();
  });
  after(async () => {
    await q(`UPDATE aqua_jobs SET state = 'dead', last_error = 'phase4bWorker test cleanup' WHERE kind IN ($1, $2) AND state IN ('queued','running')`, [HI, LO]);
    await (await import('../db/pool.js')).closePool();
  });

  test('aging: a job that has waited outranks a freshly runnable job with a better priority', async () => {
    const owner = n => `user:p4b-age-${RUN}-${n}`;
    await Q.enqueue({ ownerId: owner('lo'), kind: LO, idempotencyKey: 'lo', priority: 50 });
    // The low-priority job has been runnable for 2 s (= 40 aging points at 50 ms each).
    await q(`UPDATE aqua_jobs SET run_after = now() - interval '2 seconds' WHERE owner_id = $1`, [owner('lo')]);
    for (let i = 0; i < 10; i++) await Q.enqueue({ ownerId: owner(`hi${i}`), kind: HI, idempotencyKey: `hi${i}`, priority: 40 });
    const first = await Q.claim(`p4b-${RUN}`, { kinds: [HI, LO] });
    assert.equal(first.kind, LO, 'strict priority would have taken a priority-40 job first');
    await Q.complete(first.jobId, first.fence);
    // Freshly runnable jobs keep strict priority among themselves.
    const next = await Q.claim(`p4b-${RUN}`, { kinds: [HI, LO] });
    assert.equal(next.kind, HI);
    await Q.complete(next.jobId, next.fence);
    await q(`UPDATE aqua_jobs SET state = 'done' WHERE kind = $1 AND state = 'queued'`, [HI]);
  });

  test('starvation: a stream of re-queued higher-priority jobs does not starve a lower-priority one', async () => {
    const lo = `user:p4b-stream-lo-${RUN}`;
    await Q.enqueue({ ownerId: lo, kind: LO, idempotencyKey: 'stream-lo', priority: 50 });
    // 8 "failing" higher-priority jobs: each claim fails it straight back to runnable
    // (what a claim-embedding job without a key did, every few seconds, 989 times).
    for (let i = 0; i < 8; i++) await Q.enqueue({ ownerId: `user:p4b-stream-hi-${RUN}-${i}`, kind: HI, idempotencyKey: `s${i}`, priority: 40, maxAttempts: 1_000_000 });
    const t0 = Date.now();
    let gotLow = null; let claims = 0;
    while (Date.now() - t0 < 10_000) {
      const j = await Q.claim(`p4b-stream-${RUN}`, { kinds: [HI, LO] });
      if (!j) { await new Promise(r => setTimeout(r, 10)); continue; }
      claims++;
      if (j.kind === LO) { gotLow = Date.now() - t0; await Q.complete(j.jobId, j.fence); break; }
      await q(`UPDATE aqua_jobs SET state = 'queued', claimed_by = NULL, run_after = now() WHERE job_id = $1`, [j.jobId]);   // retried at once
    }
    assert.ok(gotLow != null, `the priority-50 job was never claimed in 10 s (${claims} higher-priority claims)`);
    assert.ok(gotLow < 3_000, `claimed only after ${gotLow} ms`);
  });

  test('startup: the worker reports boot → database → partitions → ready → lease → summary with queue lag', async () => {
    const out = await runWorker({ DATABASE_URL: process.env.DATABASE_URL }, 4_000);
    const phases = [...out.matchAll(/\[WORKER\] (\{.*\})/g)].map(m => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
    const names = phases.map(p => p.phase);
    for (const want of ['boot', 'db-connected', 'partitions-configured', 'ready', 'first-lease-done', 'summary']) {
      assert.ok(names.includes(want), `missing ${want} in ${names.join(',')}`);
    }
    assert.ok(names.indexOf('boot') < names.indexOf('db-connected') && names.indexOf('db-connected') < names.indexOf('ready'));
    const summary = phases.find(p => p.phase === 'summary');
    assert.ok(Array.isArray(summary.lag), 'the summary carries queue lag');
    assert.ok(Number.isInteger(summary.polls) && summary.polls > 0, 'the worker was polling');
  });

  test('fail-closed: a worker whose database is unreachable reports it and exits', async () => {
    const out = await runWorker({ DATABASE_URL: 'postgresql://aqua:aqua@127.0.0.1:1/none' }, 15_000, true);
    assert.match(out.text, /"phase":"db-error"/);
    assert.notEqual(out.code, null, 'the worker kept running against an unreachable database');
    assert.notEqual(out.code, 0);
  });
});

function runWorker(env, ms, expectExit = false) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/start-worker.mjs', '--poll', '100', '--diag', '500', '--kinds', `test.p4b.none.${RUN}`], {
      cwd: ROOT,
      env: { ...process.env, ...env, START_WORKER_SKIP_DOTENV: '1', MONGO_URI: '', AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_PROACTIVE: 'off',
        AQUA_CONSOLIDATION_INTERVAL_MS: '0', AQUA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'aq-p4bw-')), HOSTNAME: `p4b-${RUN}`, AQUA_PG_CONNECT_TIMEOUT_MS: '2000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', d => { text += d; });
    child.stderr.on('data', d => { text += d; });
    const timer = setTimeout(() => child.kill(), ms);
    child.on('exit', code => { clearTimeout(timer); resolve(expectExit ? { text, code } : text); });
  });
}
