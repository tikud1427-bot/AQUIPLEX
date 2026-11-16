#!/usr/bin/env node
/**
 * Phase 3 — graceful shutdown on LINUX, with real signals.
 *
 * Windows cannot test this: a child "kill" there is TerminateProcess and no
 * handler runs. This script refuses to run anywhere but Linux. Run it in a
 * Linux container (see AQUIPLEX_LINUX_SHUTDOWN_TEST_REPORT.md for the exact
 * docker command) against the disposable Postgres and Mongo:
 *
 *   DATABASE_URL=postgresql://aqua:aqua@host.docker.internal:55432/aqua_test \
 *   MONGO_URI=mongodb://host.docker.internal:57017/aqua_phase3_linux \
 *   node aqua/scripts/phase3-linux-shutdown.mjs [--out report.json]
 *
 * Scenarios (each a real process receiving a real SIGTERM / SIGKILL):
 *   T1 worker, idle                     T5 worker replacement after shutdown
 *   T2 worker, job in hand              T6 SIGKILL mid-job → recovery elsewhere
 *   T3 worker, while renewing its lease T7 API with requests in progress
 *   T4 worker, inside a database call past its deadline
 * Job rows are the canary kind (ops.canary.v1: pg_sleep, writes nothing).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') { console.error(`✗ refusing: this test needs real POSIX signals (platform=${process.platform})`); process.exit(2); }
const DB = process.env.DATABASE_URL;
const MONGO = process.env.MONGO_URI;
if (!DB || !MONGO) { console.error('✗ DATABASE_URL and MONGO_URI (disposable services) are required'); process.exit(2); }
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : null; })();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN = Date.now().toString(36);
const OWNER = n => `user:linux-${RUN}-${n}`;
const LEASE = 'worker-schedulers';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const check = (t, name, ok, detail = '') => { checks.push({ t, name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'} [${t}] ${name}${detail ? ` — ${detail}` : ''}`); };

const { default: pg } = await import(path.join(ROOT, 'aqua', 'node_modules', 'pg', 'lib', 'index.js'));
const db = new pg.Pool({ connectionString: DB, max: 4 });
const q = async (sql, p = []) => (await db.query(sql, p)).rows;

const env = {
  ...process.env, START_WORKER_SKIP_DOTENV: '1', AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_STORE_PG: 'off',
  AQUA_PROACTIVE: 'off', AQUA_CONSOLIDATION_INTERVAL_MS: '0', NODE_ENV: 'development', MAIL_TRANSPORT: 'log',
  AQUA_SCHEDULER_LEASE_MS: '1500', AQUA_JOB_HEARTBEAT_STALE_MS: '2000', AQUA_WORKER_SHUTDOWN_MS: '3000',
};
const procs = new Set();
function startProc(name, args, extra = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...env, AQUA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `aq-lx-${name}-`)), HOSTNAME: name, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const p = { name, child, out: '', exit: null, exitedAt: null };
  child.stdout.on('data', d => { p.out += d; });
  child.stderr.on('data', d => { p.out += d; });
  p.exited = new Promise(r => child.on('exit', (code, signal) => { p.exit = { code, signal }; p.exitedAt = Date.now(); procs.delete(p); r(p.exit); }));
  procs.add(p);
  return p;
}
const startWorker = (name, extra) => startProc(name, ['scripts/start-worker.mjs', '--poll', '100', '--reap', '1000', '--kinds', 'ops.canary.v1'], extra);
const waitFor = async (pred, ms = 15_000, every = 50) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(every); } return false; };
const leaseHolder = async () => (await q(`SELECT holder, expires_at > now() AS live FROM aqua_scheduler_leases WHERE name = $1`, [LEASE]))[0] ?? null;
const jobState = async id => (await q(`SELECT state, attempts, claimed_by, last_error FROM aqua_jobs WHERE job_id = $1`, [id]))[0];
async function canary(owner, ms, key = `c-${Date.now()}-${Math.random()}`) {
  const [r] = await q(`INSERT INTO aqua_jobs (owner_id, kind, payload, idempotency_key) VALUES ($1, 'ops.canary.v1', $2::jsonb, $3) RETURNING job_id`, [owner, JSON.stringify({ ms }), key]);
  return Number(r.job_id);
}
async function sigterm(p) { const t0 = Date.now(); p.child.kill('SIGTERM'); await p.exited; return p.exitedAt - t0; }

try {
  const { migrate } = await import(path.join(ROOT, 'aqua', 'src', 'core', 'db', 'migrate.js'));
  await migrate();
  // Earlier canaries (other runs) must not be picked up here.
  await q(`UPDATE aqua_jobs SET state = 'dead', last_error = 'stale linux test canary' WHERE kind = 'ops.canary.v1' AND state IN ('queued', 'running')`);
  await q(`DELETE FROM aqua_scheduler_leases WHERE name = $1`, [LEASE]);

  // ── T1 idle ──
  console.log('\n=== T1 SIGTERM while idle ===');
  const w1 = startWorker('lx-w1');
  check('T1', 'worker took the scheduler lease', await waitFor(async () => (await leaseHolder())?.holder?.includes('lx-w1')));
  await sleep(500);
  const t1 = await sigterm(w1);
  check('T1', 'exited 0 promptly on SIGTERM', w1.exit.code === 0 && t1 < 3000, `code=${w1.exit.code} signal=${w1.exit.signal} ${t1}ms`);
  check('T1', 'lease released (not left to expire)', !(await leaseHolder())?.live, JSON.stringify(await leaseHolder()));
  check('T1', 'logged a clean shutdown', /shutdown clean/.test(w1.out));

  // ── T2 job in hand (shorter than the deadline) ──
  console.log('\n=== T2 SIGTERM while processing a job ===');
  const w2 = startWorker('lx-w2');
  const j2 = await canary(OWNER(2), 1500);
  check('T2', 'job running', await waitFor(async () => (await jobState(j2)).state === 'running'));
  const t2 = await sigterm(w2);
  const s2 = await jobState(j2);
  check('T2', 'the job in hand finished before exit', s2.state === 'done' && s2.attempts === 1, JSON.stringify(s2));
  check('T2', 'exit 0, after the job, inside the deadline', w2.exit.code === 0 && t2 < 3000, `${t2}ms`);

  // ── T3 while renewing the lease ──
  console.log('\n=== T3 SIGTERM while renewing the lease ===');
  const w3 = startWorker('lx-w3');
  await waitFor(async () => (await leaseHolder())?.holder?.includes('lx-w3'));
  // Hold the lease row locked: the worker's next renewal blocks INSIDE its UPDATE.
  const locker = await db.connect();
  await locker.query('BEGIN');
  await locker.query(`SELECT 1 FROM aqua_scheduler_leases WHERE name = $1 FOR UPDATE`, [LEASE]);
  const blocked = await waitFor(async () => (await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%aqua_scheduler_leases%'`))[0].n > 0, 5000);
  check('T3', 'a lease renewal is in progress (blocked on the row lock)', blocked);
  w3.child.kill('SIGTERM');
  await sleep(1000);
  await locker.query('COMMIT'); locker.release();
  await w3.exited;
  check('T3', 'exited 0 after the interrupted renewal', w3.exit.code === 0, JSON.stringify(w3.exit));
  check('T3', 'lease released afterwards', !(await leaseHolder())?.live, JSON.stringify(await leaseHolder()));

  // ── T4 inside a database call, past the deadline ──
  console.log('\n=== T4 SIGTERM during a database operation (past the deadline) ===');
  const w4 = startWorker('lx-w4');
  const j4 = await canary(OWNER(4), 20_000);
  await waitFor(async () => (await jobState(j4)).state === 'running');
  await sleep(500);
  const t4 = await sigterm(w4);
  const s4 = await jobState(j4);
  check('T4', 'exited within the deadline (+1 s), not after the 20 s query', t4 < 4000 && w4.exit.code === 0, `${t4}ms code=${w4.exit.code}`);
  check('T4', 'the job was released for another worker, attempt not counted', s4.state === 'queued' && s4.attempts === 0 && /shutdown deadline/.test(s4.last_error ?? ''), JSON.stringify(s4));
  const backends = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE query ILIKE '%pg_sleep%' AND state = 'active' AND pid <> pg_backend_pid()`);
  console.log(`  server-side pg_sleep backends still active after exit: ${backends[0].n} (cancelled when the server notices the closed socket)`);

  // ── T5 replacement ──
  console.log('\n=== T5 worker replacement after shutdown ===');
  await q(`UPDATE aqua_jobs SET payload = '{"ms": 500}' WHERE job_id = $1`, [j4]);
  const t5 = Date.now();
  const w5 = startWorker('lx-w5');
  check('T5', 'the replacement took the lease at once (it was released, not expired)', await waitFor(async () => (await leaseHolder())?.holder?.includes('lx-w5'), 5000), `${Date.now() - t5}ms`);
  check('T5', 'and completed the job the old worker released', await waitFor(async () => (await jobState(j4)).state === 'done', 15_000), JSON.stringify(await jobState(j4)));

  // ── T6 SIGKILL mid-job → recovery ──
  console.log('\n=== T6 restart + recovery of unfinished work ===');
  const j6 = await canary(OWNER(6), 8000);
  await waitFor(async () => (await jobState(j6)).state === 'running');
  w5.child.kill('SIGKILL');
  await w5.exited;
  check('T6', 'worker died without any handler (SIGKILL)', w5.exit.signal === 'SIGKILL');
  check('T6', 'its job is stranded as running', (await jobState(j6)).state === 'running');
  const t6 = Date.now();
  const w6 = startWorker('lx-w6', { AQUA_SCHEDULER_LEASE_MS: '1500' });
  const recovered = await waitFor(async () => (await jobState(j6)).state === 'done', 45_000, 200);
  check('T6', 'a new worker reclaimed it once the heartbeat went stale, and completed it', recovered && /reclaimed \d+ job/.test(w6.out), `${Date.now() - t6}ms ${JSON.stringify(await jobState(j6))}`);
  await sigterm(w6);

  // ── T7 API with requests in progress ──
  console.log('\n=== T7 API shutdown while requests are active ===');
  const PORT = 5091;
  const a = startProc('lx-api', ['scripts/start-api.mjs'], { PORT: String(PORT), AQUA_API_SHUTDOWN_MS: '8000',
    // Placeholders so passport can be constructed; no OAuth flow is exercised.
    GOOGLE_CLIENT_ID: 'linux-test-placeholder', GOOGLE_CLIENT_SECRET: 'linux-test-placeholder', SESSION_SECRET: 'linux-test-session-secret',
    RAZORPAY_KEY_ID: 'linux-test-placeholder', RAZORPAY_KEY_SECRET: 'linux-test-placeholder', RAZORPAY_WEBHOOK_SECRET: 'linux-test-placeholder' });
  const ready = await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/ready`)).status === 200; } catch { return false; } }, 90_000, 500);
  check('T7', 'API ready', ready, ready ? '' : a.out.slice(-800));
  // A request in progress: headers sent, body still arriving over ~3 s.
  const body = JSON.stringify({ message: 'x'.repeat(2000) });
  const reply = new Promise(resolve => {
    const s = net.connect(PORT, '127.0.0.1');
    let data = '';
    s.on('data', d => { data += d; });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
    s.write(`POST /api/aqua/chat HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n`);
    let i = 0;
    const iv = setInterval(() => { s.write(body.slice(i, i + 200)); i += 200; if (i >= body.length) clearInterval(iv); }, 300);
  });
  await sleep(600);
  const tTerm = Date.now();
  a.child.kill('SIGTERM');
  await sleep(300);
  let refused = false;
  try { await fetch(`http://127.0.0.1:${PORT}/ready`, { signal: AbortSignal.timeout(1000) }); } catch { refused = true; }
  check('T7', 'no new connections accepted while draining', refused);
  const raw = await reply;
  const status = Number(raw.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
  await a.exited;
  check('T7', 'the request in progress got a complete HTTP response (not a reset)', status >= 200, `HTTP ${status}`);
  check('T7', 'the API exited only after it, within its drain bound', a.exitedAt - tTerm >= 2000 && a.exitedAt - tTerm < 12_000, `${a.exitedAt - tTerm}ms code=${a.exit.code} signal=${a.exit.signal}`);
  check('T7', 'the drain was logged', /in-flight requests finished/.test(a.out));
} catch (err) {
  check('run', 'completed without an exception', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  for (const p of procs) p.child.kill('SIGKILL');
  const result = { at: new Date().toISOString(), platform: process.platform, kernel: os.release(), node: process.version,
    passed: checks.filter(c => c.ok).length, total: checks.length, checks };
  console.log(`\nRESULT ${result.passed}/${result.total} (linux ${os.release()}, node ${process.version})`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  await db.end().catch(() => {});
  process.exit(0);
}
