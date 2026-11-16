/**
 * Phase 3 preparation — independent API and worker processes, against the
 * disposable Postgres (real processes: scripts/start-worker.mjs). Skipped
 * loudly without a database.
 *
 *   · a worker never opens an HTTP port
 *   · several workers drain one queue: every job exactly once, per-owner order kept
 *   · exactly one worker owns the periodic schedulers; a dead owner is replaced
 *   · a job left 'running' by a killed worker is recovered and completed
 *   · an unknown job kind dead-letters with its reason
 *
 * Not tested here (stated in AQUIPLEX_PHASE_3_READINESS_REPORT.md): graceful
 * SIGTERM — on Windows a child kill is TerminateProcess, so no handler runs;
 * the existing SIGTERM tests skip on Windows for the same reason.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = Boolean(process.env.DATABASE_URL);
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const START_WORKER = path.join(ROOT, 'scripts', 'start-worker.mjs');
const RUN = Date.now().toString(36);
const OWNER = n => `user:role-${RUN}-${n}`;
const NOOP = 'proactive.evaluate.v1';     // with AQUA_PROACTIVE=off its handler returns at once
let pool;
const procs = new Set();

/** A preload that makes ANY attempt to listen on a port fatal and visible. */
const NO_LISTEN = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-nl-')), 'no-listen.cjs');
fs.writeFileSync(NO_LISTEN, `
const net = require('net');
const orig = net.Server.prototype.listen;
net.Server.prototype.listen = function () {
  console.log('[TEST] HTTP-LISTEN-ATTEMPT');
  throw new Error('a worker must not listen on a port');
};
`);

function startWorker(name, extraEnv = {}) {
  const child = spawn(process.execPath, ['--require', NO_LISTEN, START_WORKER, '--poll', '100', '--kinds', `${NOOP},no.such.kind.v1`], {
    cwd: ROOT,
    env: {
      ...process.env, DATABASE_URL: process.env.DATABASE_URL, START_WORKER_SKIP_DOTENV: '1',
      MONGO_URI: '', AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `aq-w-${name}-`)),
      AQUA_PROACTIVE: 'off', AQUA_SCHEDULER_LEASE_MS: '2000', AQUA_CONSOLIDATION_INTERVAL_MS: '0', HOSTNAME: name, ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const w = { name, child, out: '' };
  child.stdout.on('data', d => { w.out += d; });
  child.stderr.on('data', d => { w.out += d; });
  procs.add(w);
  child.on('exit', () => procs.delete(w));
  return w;
}
const stop = w => new Promise(r => { if (w.child.exitCode != null) return r(); w.child.on('exit', r); w.child.kill(); });
const waitFor = async (fn, ms = 30_000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 150)); }
};
const enqueue = (owner, kind, key, extra = '') => pool.query(
  `INSERT INTO aqua_jobs (owner_id, kind, payload, idempotency_key, priority, max_attempts ${extra ? ', state, claimed_at, attempts, claimed_by' : ''})
   VALUES ($1, $2, '{}'::jsonb, $3, 100, ${extra ? 1 : 3} ${extra})`, [owner, kind, key]);

before(async () => {
  if (!LIVE) return;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  await (await import('../db/migrate.js')).migrate();
});
beforeEach(async () => {
  if (!LIVE) return;
  // These workers claim only the two kinds this suite uses (--kinds). Park any
  // such job another suite left behind, so it is not run here.
  await pool.query(`UPDATE aqua_jobs SET run_after = now() + interval '1 day' WHERE state = 'queued' AND kind = ANY($2) AND owner_id NOT LIKE $1`, [`user:role-${RUN}-%`, [NOOP, 'no.such.kind.v1']]);
  await pool.query(`DELETE FROM aqua_scheduler_leases WHERE name = 'worker-schedulers'`);
});
after(async () => {
  for (const w of [...procs]) await stop(w);
  if (!LIVE) return;
  await pool.query(`DELETE FROM aqua_jobs WHERE owner_id LIKE $1`, [`user:role-${RUN}-%`]);
  await pool.query(`DELETE FROM aqua_scheduler_leases WHERE name = 'worker-schedulers'`);
  await pool.end();
  await (await import('../db/pool.js')).closePool();
});

describe('independent workers — real processes, real Postgres', { skip }, () => {
  test('three workers drain one queue: every job exactly once, per-owner order kept, no HTTP port', async () => {
    const N = 60;
    for (let i = 0; i < N; i++) await enqueue(OWNER(i % 6), NOOP, `j-${i}`);
    const ws = ['wa', 'wb', 'wc'].map(n => startWorker(n));
    const done = await waitFor(async () => Number((await pool.query(
      `SELECT count(*) FROM aqua_jobs WHERE owner_id LIKE $1 AND state = 'done'`, [`user:role-${RUN}-%`])).rows[0].count) === N, 60_000);
    await Promise.all(ws.map(stop));
    assert.ok(done, 'all jobs done');
    const rows = (await pool.query(`SELECT owner_id, attempts, claimed_at, updated_at FROM aqua_jobs WHERE owner_id LIKE $1`, [`user:role-${RUN}-%`])).rows;
    assert.ok(rows.every(r => r.attempts === 1), 'each job ran exactly once (no duplicate claim)');
    // Per-owner ordering: one owner's jobs never overlapped in time.
    const byOwner = new Map();
    for (const r of rows) { if (!byOwner.has(r.owner_id)) byOwner.set(r.owner_id, []); byOwner.get(r.owner_id).push([+r.claimed_at, +r.updated_at]); }
    for (const [o, iv] of byOwner) {
      iv.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < iv.length; i++) assert.ok(iv[i][0] >= iv[i - 1][1], `${o}: two jobs ran at once`);
    }
    const ran = ws.map(w => (w.out.match(/kind=proactive\.evaluate\.v1 owner=[^ ]+ done/g) ?? []).length);
    assert.equal(ran.reduce((a, b) => a + b, 0), N);
    assert.ok(ran.filter(n => n > 0).length >= 2, `work was shared: ${ran}`);
    for (const w of ws) {
      assert.doesNotMatch(w.out, /HTTP-LISTEN-ATTEMPT/, `${w.name} tried to open a port`);
      assert.match(w.out, /\[ROLE\] worker/);
    }
  });

  test('exactly one worker owns the periodic schedulers; when it dies another takes over', async () => {
    const a = startWorker('lead-a');
    await waitFor(() => /now OWNS/.test(a.out), 15_000);
    const b = startWorker('lead-b');
    await new Promise(r => setTimeout(r, 3000));
    const holders = (await pool.query(`SELECT holder FROM aqua_scheduler_leases WHERE name = 'worker-schedulers'`)).rows;
    assert.equal(holders.length, 1);
    assert.match(a.out, /now OWNS/);
    assert.doesNotMatch(b.out, /now OWNS/, 'a second owner while the first is alive');
    await stop(a);                                   // killed: no release, the TTL (2 s) must expire
    const took = await waitFor(() => /now OWNS/.test(b.out), 15_000);
    await stop(b);
    assert.ok(took, 'the surviving worker took the schedulers over');
  });

  test('a job left running by a killed worker is recovered and completed; an unknown kind dead-letters', async () => {
    // Left 'running' an hour ago by a worker that no longer exists.
    await enqueue(OWNER('stale'), NOOP, 'stale-1', `, 'running', now() - interval '1 hour', 1, 'ghost'`);
    await pool.query(`UPDATE aqua_jobs SET max_attempts = 3 WHERE owner_id = $1`, [OWNER('stale')]);
    await enqueue(OWNER('dlq'), 'no.such.kind.v1', 'dlq-1');
    await pool.query(`UPDATE aqua_jobs SET max_attempts = 1 WHERE owner_id = $1`, [OWNER('dlq')]);
    const w = startWorker('reaper');
    const ok = await waitFor(async () => {
      const r = (await pool.query(`SELECT owner_id, state, last_error FROM aqua_jobs WHERE owner_id = ANY($1)`, [[OWNER('stale'), OWNER('dlq')]])).rows;
      return r.length === 2 && r.find(x => x.owner_id === OWNER('stale'))?.state === 'done' && r.find(x => x.owner_id === OWNER('dlq'))?.state === 'dead' ? r : false;
    }, 30_000);
    await stop(w);
    assert.ok(ok, `stale job recovered and unknown kind dead-lettered:\n${w.out.slice(-800)}`);
    assert.match(ok.find(x => x.state === 'dead').last_error, /no handler registered/);
    assert.match(w.out, /reclaimed 1 job/);
  });
});
