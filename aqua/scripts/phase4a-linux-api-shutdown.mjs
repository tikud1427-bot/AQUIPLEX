#!/usr/bin/env node
/**
 * Phase 4A — API shutdown on LINUX with real chat turns in flight.
 *
 * The real API (scripts/start-api.mjs: Express, sessions, credits, the chat
 * pipeline, the durable turn commit) receives a real SIGTERM while:
 *   A1 a chat request (JSON) is waiting on the model
 *   A2 a streaming chat response is mid-stream
 *   A3 the turn's commit TRANSACTION is in progress (blocked on a row lock the
 *      test holds) and finishes inside the drain deadline
 *   A4 the same, but the transaction cannot finish before the deadline: the
 *      process exits mid-transaction — nothing of the turn may remain
 *   A5 a failing request is refunding its credit
 * then a worker drains the queue: every job of every ACKNOWLEDGED turn runs.
 *
 * The model is a local fake OpenAI-compatible server (NVIDIA_BASE_URL) in this
 * process: no provider key, no cost, and the test decides when a call returns.
 * Refuses to run anywhere but Linux. Disposable Postgres + Mongo only.
 *
 *   DATABASE_URL=postgresql://aqua:aqua@host.docker.internal:55432/aqua_test \
 *   MONGO_URI=mongodb://host.docker.internal:57017/aqua_phase4a_linux \
 *   node aqua/scripts/phase4a-linux-api-shutdown.mjs --out /out/api-shutdown.json
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') { console.error(`✗ refusing: real POSIX signals are required (platform=${process.platform})`); process.exit(2); }
const DB = process.env.DATABASE_URL;
const MONGO = process.env.MONGO_URI;
if (!DB || !MONGO) { console.error('✗ DATABASE_URL and MONGO_URI (disposable services) are required'); process.exit(2); }
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : null; })();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const pg = require(path.join(ROOT, 'aqua', 'node_modules', 'pg'));
const mongoose = require('mongoose');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const check = (t, name, ok, detail = '') => { checks.push({ t, name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'} [${t}] ${name}${detail ? ` — ${detail}` : ''}`); };
const RUN = Date.now().toString(36);

// ── fake model (OpenAI-compatible) ───────────────────────────────────────────
const fake = { holdNext: 0, streamTokenMs: 0, failAll: false, calls: 0, held: null };
let onHeld = () => {};
const model = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    fake.calls++;
    let j = {}; try { j = JSON.parse(body); } catch { /* */ }
    const hold = fake.holdNext; fake.holdNext = 0;
    if (hold) { onHeld(); await sleep(hold); }
    if (fake.failAll) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fake upstream failure' } })); return; }
    const text = 'Noted — I will remember that.';
    if (j.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const words = text.split(' ');
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: { content: `${w} ` }, finish_reason: null }] })}\n\n`);
        if (fake.streamTokenMs) await sleep(fake.streamTokenMs);
      }
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: j.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }));
  });
});
await new Promise(r => model.listen(0, '127.0.0.1', r));
const MODEL_URL = `http://127.0.0.1:${model.address().port}/v1`;

// ── services ─────────────────────────────────────────────────────────────────
const db = new pg.Pool({ connectionString: DB, max: 4 });
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
await mongoose.connect(MONGO);
const users = mongoose.connection.db.collection('users');
const txns = mongoose.connection.db.collection('transactions');
const ALL_ON = 'reflection:on,mind:on,recall-redactions:on,history:on,reasoning-graph:on,ids:on,brain:on,evidence:on,fileindex:on,uko:on,attachments:on,pic:on,vectors:on,projects:on,index:on,artifacts:on,cognition:on,ledger:on';
const env = {
  ...process.env, NODE_ENV: 'development', MAIL_TRANSPORT: 'log', APP_URL: 'http://127.0.0.1', RENDER: '',
  AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_STORE_PG: 'off', AQUA_STORE_PARTITIONS: ALL_ON, AQUA_POST_TURN_DURABLE: 'on',
  AQUA_E6: 'off', AQUA_PROACTIVE: 'off', AQUA_API_SHUTDOWN_MS: '7000', START_WORKER_SKIP_DOTENV: '1',
  // Phase 4B: pending-charge recovery ON (set P4B_CHARGES=off for the Phase 4A behaviour).
  AQUA_PENDING_CHARGES: process.env.P4B_CHARGES === 'off' ? 'off' : 'on',
  NVIDIA_API_KEY_1: 'fake-key-linux-test', NVIDIA_BASE_URL: MODEL_URL, AQUA_PROVIDER_PREFER: 'nvidia',
  GOOGLE_CLIENT_ID: 'linux-test-placeholder', GOOGLE_CLIENT_SECRET: 'linux-test-placeholder', SESSION_SECRET: 'linux-test-session-secret',
  RAZORPAY_KEY_ID: 'linux-test-placeholder', RAZORPAY_KEY_SECRET: 'linux-test-placeholder', RAZORPAY_WEBHOOK_SECRET: 'linux-test-placeholder',
  AQUA_RATE_LIMIT_REDIS_URL: '',
};
const PORT = 5093;
const procs = new Set();
function start(name, script, extra = {}) {
  const child = spawn(process.execPath, [script, ...(extra.__args ?? [])], { cwd: ROOT,
    env: { ...env, AQUA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `aq-4a-${name}-`)), HOSTNAME: name, PORT: String(PORT), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const p = { name, child, out: '', exit: null, exitedAt: null };
  child.stdout.on('data', d => { p.out += d; });
  child.stderr.on('data', d => { p.out += d; });
  p.exited = new Promise(r => child.on('exit', (code, signal) => { p.exit = { code, signal }; p.exitedAt = Date.now(); procs.delete(p); r(p.exit); }));
  procs.add(p);
  return p;
}
const ready = async (ms = 90_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if ((await fetch(`http://127.0.0.1:${PORT}/ready`)).status === 200) return true; } catch { /* */ } await sleep(400); } return false; };
const apiProcs = [];
const api = async name => { const p = start(name, 'scripts/start-api.mjs'); apiProcs.push(p); const ok = await ready(); if (!ok) console.log(p.out.slice(-1500)); return p; };

// ── HTTP client: one cookie jar ──────────────────────────────────────────────
const jar = new Map();
async function req(method, p, { body = null, form = null } = {}) {
  const h = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  let payload;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
  for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, text, json };
}
const csrfOf = html => html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"\s+name="_csrf"/)?.[1] ?? '';
const chatP = (message, conversationId) => req('POST', '/api/aqua/chat', { body: { message, ...(conversationId ? { conversationId } : {}) } })
  .catch(err => ({ status: 0, error: String(err?.cause?.code ?? err?.message ?? err) }));
const wallet = async uid => { const u = await users.findOne({ _id: new mongoose.Types.ObjectId(uid) }); return (u?.wallet?.freeCredits ?? 0) + (u?.wallet?.paidCredits ?? 0); };
/** Was this exact user message committed, and does it have its learning job? */
async function turnState(owner, text) {
  const rows = await q(`SELECT partition_key FROM aqua_store_partitions WHERE store_key = '.aqua-history.json' AND owner_id = $1 AND data IS NOT NULL AND partition_key LIKE 'm:%'
       AND (CASE WHEN partition_key LIKE 'm:%' THEN data::jsonb->>'content' END) = $2
       AND (CASE WHEN partition_key LIKE 'm:%' THEN data::jsonb->>'role' END) = 'user'`, [owner, text]);
  const keys = rows.map(r => r.partition_key.split(':').pop());
  const jobs = keys.length ? await q(`SELECT kind, state FROM aqua_jobs WHERE owner_id = $1 AND source_ref->>'userMessageKey' = ANY($2)`, [owner, keys]) : [];
  return { messages: rows.length, jobs };
}
const sigterm = p => { const t = Date.now(); p.child.kill('SIGTERM'); return t; };

let OWNER = null; let UID = null; let conv = null;
try {
  const { migrate } = await import(path.join(ROOT, 'aqua', 'src', 'core', 'db', 'migrate.js'));
  await migrate();

  // ── account ──
  let a = await api('api-0');
  check('setup', 'API ready (real Express app, fake model)', !!a && !a.exit);
  const email = `p4a-linux-${RUN}@example.test`; const password = 'p4a-linux-password-123';
  const page = await req('GET', '/signup');
  await req('POST', '/signup', { form: { email, password, _csrf: csrfOf(page.text) } });
  await sleep(1500);
  const token = a.out.match(/verify-email\?token=([A-Za-z0-9_\-.%]+)/)?.[1];
  const vf = await req('GET', `/verify-email?token=${token}`);
  await req('POST', '/verify-email', { form: { token: decodeURIComponent(token ?? ''), password, _csrf: csrfOf(vf.text) } });
  UID = (await users.findOne({ email }))?._id?.toString();
  OWNER = `user:${UID}`;
  await users.updateOne({ email }, { $set: { 'wallet.freeCredits': 0, 'wallet.paidCredits': 500 } });
  const first = await chatP(`Hello, my name is Rhea ${RUN}.`);
  conv = first.json?.data?.conversationId ?? first.json?.conversationId;
  check('setup', 'signed in; a first chat turn works through the fake model', first.status === 200 && !!conv, `HTTP ${first.status} ${first.error ?? ''} ${String(first.text ?? '').slice(0, 160)}`);

  // ── A1 JSON chat in flight ──
  console.log('\n=== A1 SIGTERM while a chat request waits on the model ===');
  const m1 = `A1: I moved to Porto ${RUN}.`;
  fake.holdNext = 2500;
  let held = new Promise(r => { onHeld = r; });
  const w1 = await wallet(UID);
  const r1p = chatP(m1, conv);
  await held;
  const t1 = sigterm(a);
  await sleep(300);
  let refused = false; try { await fetch(`http://127.0.0.1:${PORT}/ready`, { signal: AbortSignal.timeout(800) }); } catch { refused = true; }
  const r1 = await r1p; await a.exited;
  const s1 = await turnState(OWNER, m1);
  check('A1', 'no new connection accepted after SIGTERM', refused);
  check('A1', 'the in-flight chat completed with an answer', r1.status === 200, `HTTP ${r1.status} ${r1.error ?? ''}`);
  check('A1', 'its turn is committed with its learning jobs', s1.messages === 1 && s1.jobs.some(j => j.kind === 'learning.mind.v1'), JSON.stringify(s1));
  check('A1', 'the API exited only after it, within the bound', a.exitedAt - t1 < 12_000, `${a.exitedAt - t1}ms code=${a.exit.code}`);
  check('A1', 'charged exactly once for the answered turn', (await wallet(UID)) === w1 - 1 || (await wallet(UID)) < w1, `${w1}→${await wallet(UID)}`);

  // ── A2 streaming ──
  console.log('\n=== A2 SIGTERM mid-stream ===');
  a = await api('api-1');
  const m2 = `A2: my sister is called Ines ${RUN}.`;
  fake.streamTokenMs = 400;
  const tokenSeen = new Promise(r => { onHeld = r; });
  fake.holdNext = 1;   // signal when the model is called
  const r2p = req('POST', '/api/aqua/chat/stream', { body: { message: m2, conversationId: conv } }).catch(e => ({ status: 0, text: '', error: String(e) }));
  await tokenSeen; await sleep(600);
  const t2 = sigterm(a);
  const r2 = await r2p; await a.exited; fake.streamTokenMs = 0;
  const ev2 = [...String(r2.text).matchAll(/event: (\w+)/g)].map(m => m[1]);
  const s2 = await turnState(OWNER, m2);
  check('A2', 'the stream finished with done (not cut)', ev2.includes('done'), ev2.filter(e => e !== 'token').join(','));
  check('A2', 'its turn is committed with its learning jobs', s2.messages === 1 && s2.jobs.length >= 2, JSON.stringify(s2));
  check('A2', 'exit after the stream, within the bound', a.exitedAt - t2 < 12_000, `${a.exitedAt - t2}ms`);

  // ── A3 commit transaction in progress, finishes inside the deadline ──
  console.log('\n=== A3 SIGTERM during the commit transaction (finishes in time) ===');
  a = await api('api-2');
  const lock = await db.connect();
  await lock.query('BEGIN');
  await lock.query(`SELECT 1 FROM aqua_store_partitions WHERE store_key = '.aqua-history.json' AND partition_key = $1 FOR UPDATE`, [`c:${conv}`]);
  const m3 = `A3: I started learning the cello ${RUN}.`;
  const r3p = chatP(m3, conv);
  const blocked = await (async () => { for (let i = 0; i < 100; i++) { const [{ n }] = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%aqua_store_partitions%' AND pid <> pg_backend_pid()`); if (n) return true; await sleep(100); } return false; })();
  const t3 = sigterm(a);
  await sleep(1500);
  await lock.query('COMMIT'); lock.release();
  const r3 = await r3p; await a.exited;
  const s3 = await turnState(OWNER, m3);
  check('A3', 'the turn\'s transaction was in progress (blocked on the conversation row) at SIGTERM', blocked);
  check('A3', 'it completed and was acknowledged', r3.status === 200, `HTTP ${r3.status} ${r3.error ?? ''}`);
  check('A3', 'messages and jobs committed together', s3.messages === 1 && s3.jobs.length >= 2, JSON.stringify(s3));
  check('A3', 'exit after it, within the bound', a.exitedAt - t3 < 12_000, `${a.exitedAt - t3}ms`);

  // ── A4 commit transaction cannot finish before the deadline ──
  console.log('\n=== A4 SIGTERM during the commit transaction (past the deadline) ===');
  a = await api('api-3');
  const lock2 = await db.connect();
  await lock2.query('BEGIN');
  await lock2.query(`SELECT 1 FROM aqua_store_partitions WHERE store_key = '.aqua-history.json' AND partition_key = $1 FOR UPDATE`, [`c:${conv}`]);
  const m4 = `A4: this turn must vanish entirely ${RUN}.`;
  const w4 = await wallet(UID);
  const r4p = chatP(m4, conv);
  for (let i = 0; i < 100; i++) { const [{ n }] = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%aqua_store_partitions%' AND pid <> pg_backend_pid()`); if (n) break; await sleep(100); }
  const t4 = sigterm(a);
  await a.exited;
  const r4 = await r4p;
  await lock2.query('COMMIT'); lock2.release();
  await sleep(500);
  const s4 = await turnState(OWNER, m4);
  check('A4', 'the API exited at its deadline, mid-transaction', a.exitedAt - t4 >= 6_500 && a.exitedAt - t4 < 10_000, `${a.exitedAt - t4}ms code=${a.exit.code}`);
  check('A4', 'the client was not told the turn succeeded', r4.status !== 200, `HTTP ${r4.status} ${r4.error ?? ''}`);
  check('A4', 'nothing of the turn remains: no message row, no job', s4.messages === 0 && s4.jobs.length === 0, JSON.stringify(s4));
  const w4after = await wallet(UID);
  if (env.AQUA_PENDING_CHARGES === 'on') {
    // Phase 4B: the dead turn's charge is PENDING; the reconciler (abandon window
    // shortened for the test) must refund it exactly once.
    const [ch] = await q(`SELECT charge_id, state FROM aqua_charges WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [UID]);
    check('A4', 'the dead turn left its charge PENDING (not lost, not committed)', ch?.state === 'PENDING', JSON.stringify(ch));
    const { execFileSync } = await import('node:child_process');
    let recOut;
    try {
      recOut = execFileSync(process.execPath, ['aqua/scripts/charges-reconcile.mjs', '--db', DB, '--mongo', MONGO, '--abandon-ms', '1000', '--ledger', '--stats', '--user', UID],
        { cwd: ROOT, env: { ...process.env, MONGO_URI: '' } }).toString();
    } catch (e) { recOut = String(e.stdout ?? '{}'); }   // exit 1 = anomalies found: the report is still on stdout
    const rec = JSON.parse(recOut || '{}');
    console.log(`  reconcile: ${JSON.stringify(rec.reconcile)} ledger anomalies: ${rec.ledger?.anomalies?.length}`);
    const [after] = await q(`SELECT state FROM aqua_charges WHERE charge_id = $1`, [ch?.charge_id]);
    check('A4', 'the reconciler refunded it', after?.state === 'REFUNDED', JSON.stringify(after));
    check('A4', 'the wallet is back where it was before the dead turn', (await wallet(UID)) === w4, `${w4}→${await wallet(UID)}`);
    check('A4', 'the credit ledger agrees with every charge', (rec.ledger?.anomalies ?? []).filter(a => a.chargeId && true).length === 0, JSON.stringify(rec.ledger?.anomalies?.slice(0, 3)));
  } else {
    check('A4', 'credit outcome recorded (deducted on entry; refund owed but the process was gone)', true, `${w4}→${w4after}`);
  }

  // ── A5 a failing request refunds while the API shuts down ──
  console.log('\n=== A5 SIGTERM while a failed request refunds its credit ===');
  a = await api('api-4');
  fake.failAll = true; fake.holdNext = 1500;
  const heldFail = new Promise(r => { onHeld = r; });
  const w5 = await wallet(UID);
  const r5p = chatP(`A5: this request will fail ${RUN}.`, conv);
  await heldFail;
  const t5 = sigterm(a);
  const r5 = await r5p; await a.exited; fake.failAll = false;
  const w5after = await wallet(UID);
  const refundRow = await txns.findOne({ user: new mongoose.Types.ObjectId(UID), type: 'REFUND', createdAt: { $gte: new Date(t5 - 10_000) } });
  check('A5', 'the failed request got an error response (not a reset)', r5.status >= 400 && r5.status < 600, `HTTP ${r5.status} ${r5.error ?? ''}`);
  check('A5', 'its credit was given back before the API exited', w5after === w5, `${w5}→${w5after}`);
  check('A5', 'the refund is in the ledger', !!refundRow);

  // ── A6 every acknowledged turn's jobs run ──
  console.log('\n=== A6 a worker drains every accepted job ===');
  // Phase 4B diagnostics: what else is claimable in the SHARED queue when the worker starts.
  const backlog = await q(`SELECT kind, priority, count(*)::int AS n, count(DISTINCT owner_id)::int AS owners
                             FROM aqua_jobs WHERE state = 'queued' AND run_after <= now() GROUP BY kind, priority ORDER BY priority`);
  console.log(`claimable backlog at worker start: ${JSON.stringify(backlog)}`);
  // Phase 4B: the disposable queue is SHARED by every test suite; other owners'
  // runnable jobs are parked for this check (restored below), so A6 measures
  // this owner's jobs, not whatever earlier suites left behind
  // (AQUIPLEX_WORKER_FAILURE_INVESTIGATION.md).
  const parked = await q(`UPDATE aqua_jobs SET run_after = run_after + interval '7 days'
                           WHERE state = 'queued' AND owner_id <> $1 AND run_after <= now() RETURNING job_id`, [OWNER]);
  console.log(`parked ${parked.length} other owners' runnable job(s) for A6`);
  const w = start('worker', 'scripts/start-worker.mjs', { __args: ['--poll', '200', '--diag', '5000'] });
  let left = -1;
  for (let i = 0; i < 120; i++) { [{ n: left }] = await q(`SELECT count(*)::int AS n FROM aqua_jobs WHERE owner_id = $1 AND state IN ('queued','running')`, [OWNER]); if (!left) break; await sleep(1000); }
  const states = await q(`SELECT kind, state, count(*)::int AS n FROM aqua_jobs WHERE owner_id = $1 GROUP BY kind, state ORDER BY kind`, [OWNER]);
  if (env.AQUA_PENDING_CHARGES === 'on') {
    const charges = await q(`SELECT state, count(*)::int AS n FROM aqua_charges WHERE user_id = $1 GROUP BY state ORDER BY state`, [UID]);
    const open = charges.filter(c => c.state === 'PENDING' || c.state === 'REFUND_PENDING');
    check('A6', 'every charge of the session is resolved (answered turns COMMITTED in their transaction, failed and dead ones REFUNDED)', !open.length, JSON.stringify(charges));
  }
  check('A6', 'no accepted job left queued or lost', left === 0 && !states.some(s => s.state === 'dead'), JSON.stringify(states));
  if (left !== 0) console.log(`--- worker output (tail) ---\n${w.out.slice(-3000)}`);
  const acked = [m1, m2, m3];
  const allDone = [];
  for (const m of acked) { const s = await turnState(OWNER, m); allDone.push(s.jobs.length > 0 && s.jobs.every(j => j.state === 'done')); }
  check('A6', 'every job of every acknowledged turn ran to done', allDone.every(Boolean), JSON.stringify(allDone));
  w.child.kill('SIGTERM'); await w.exited;
  if (parked.length) await q(`UPDATE aqua_jobs SET run_after = run_after - interval '7 days' WHERE job_id = ANY($1) AND state = 'queued'`, [parked.map(r => r.job_id)]);
  if (OUT) fs.writeFileSync(path.join(path.dirname(OUT), 'worker-a6.log'), w.out);
  const ran = {};
  for (const m of w.out.matchAll(/\[JOB\] (\{.*\})/g)) { try { const e = JSON.parse(m[1]); if (e.phase === 'done' || e.phase === 'retry' || e.phase === 'dead') ran[`${e.kind}:${e.phase}`] = (ran[`${e.kind}:${e.phase}`] ?? 0) + 1; } catch { /* */ } }
  console.log(`worker ran during A6: ${JSON.stringify(ran)}`);
  // Evidence for the write boundary: what each turn's pre/post-commit flush wrote.
  const turns = [...apiProcs.map(p => p.out).join('').matchAll(/\[TURN\] (\{.*"phase":"committed".*\})/g)].map(m => JSON.parse(m[1]));
  console.log(`turn commits: ${JSON.stringify(turns.map(t => ({ ms: t.ms, preKeys: t.preKeys, postKeys: t.postKeys, preFlushMs: t.preFlushMs, postFlushMs: t.postFlushMs })))}`);
  check('A6', "the request write boundary wrote the turns' own keys (pre or post commit)", turns.some(t => (t.preKeys ?? 0) + (t.postKeys ?? 0) > 0), JSON.stringify(turns.map(t => [t.preKeys, t.postKeys])));
} catch (err) {
  check('run', 'completed without an exception', false, String(err?.stack ?? err).slice(0, 800));
} finally {
  for (const p of procs) p.child.kill('SIGKILL');
  model.close();
  await mongoose.disconnect().catch(() => {});
  const result = { at: new Date().toISOString(), platform: process.platform, kernel: os.release(), node: process.version,
    passed: checks.filter(c => c.ok).length, total: checks.length, checks };
  console.log(`\nRESULT ${result.passed}/${result.total} (linux ${os.release()}, node ${process.version})`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  await db.end().catch(() => {});
  process.exit(0);
}
