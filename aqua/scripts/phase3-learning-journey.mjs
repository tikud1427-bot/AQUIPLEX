#!/usr/bin/env node
/**
 * Phase 3 — durable post-turn learning, application journey.
 *
 * TWO API instances + TWO workers (scripts/start-api.mjs / start-worker.mjs),
 * each with its own EMPTY data directory, sharing only the disposable Postgres
 * and the disposable Mongo. Real HTTP, real signup/login, real chat through
 * real providers (keys from the platform .env), learning in the workers.
 *
 *   node aqua/scripts/phase3-learning-journey.mjs --db <local test url> [--durable on|off] [--out report.json]
 *        [--skip-db-restart]
 *
 * --durable off runs the same turns with learning in the API (baseline for the
 * latency comparison); durable-only checks are then skipped.
 *
 * SAFETY: --db and Mongo must be local; MAIL_TRANSPORT=log; NODE_ENV=development;
 * Mongo mirror disabled. The DB-interruption scenario RESTARTS the docker
 * container aqua-test-db (disposable) — skip it with --skip-db-restart.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DB = arg('--db');
const MONGO = arg('--mongo', 'mongodb://127.0.0.1:57017/aqua_phase3');
const OUT = arg('--out', null);
const DURABLE = arg('--durable', 'on') === 'on';
const SKIP_DB_RESTART = process.argv.includes('--skip-db-restart');
const local = u => ['localhost', '127.0.0.1', '::1'].includes(new URL(u).hostname);
if (!DB || !local(DB) || !local(MONGO.replace('mongodb://', 'http://'))) { console.error('✗ --db and --mongo must be local test services'); process.exit(2); }
const MONGO_DB = new URL(MONGO.replace('mongodb://', 'http://')).pathname.slice(1);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL_ON = 'reflection:on,mind:on,recall-redactions:on,history:on,reasoning-graph:on,ids:on,brain:on,evidence:on,fileindex:on,uko:on,attachments:on,pic:on,vectors:on,projects:on,index:on,artifacts:on,cognition:on,ledger:on';
const EMAIL = `p3-${Date.now().toString(36)}@example.test`;
const PASSWORD = 'p3-journey-password-123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const metrics = { chatMs: [], streamMs: [], workerRssMb: {}, db: {} };
const out = (...a) => console.log(a.join(' '));
const check = (scenario, name, ok, detail = '') => { checks.push({ scenario, name, ok: !!ok, detail }); out(`  ${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name}${detail ? ` — ${detail}` : ''}`); };
const durableOnly = (scenario, name, ok, detail) => { if (DURABLE) check(scenario, name, ok, detail); };

const { default: pg } = await import('pg');
let db = new pg.Pool({ connectionString: DB, max: 3 });
db.on('error', () => {});
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

// ── processes ────────────────────────────────────────────────────────────────
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-p3-logs-'));
const baseEnv = {
  ...process.env,
  DATABASE_URL: DB, MONGO_URI: MONGO, AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_STORE_PG: 'off', AQUA_STORE_PARTITIONS: ALL_ON,
  NODE_ENV: 'development', MAIL_TRANSPORT: 'log', APP_URL: 'http://127.0.0.1', RENDER: '', AQUA_RATE_LIMIT_REDIS_URL: '',
  AQUA_SCHEDULER_LEASE_MS: '5000', AQUA_POST_TURN_DURABLE: DURABLE ? 'on' : 'off',
  AQUA_JOB_HEARTBEAT_STALE_MS: '6000',
};
const procs = {};
function start(name, script, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `aq-p3-${name}-`));
  const file = path.join(LOGDIR, `${name}.log`);
  const child = spawn(process.execPath, [script, ...(extra.__args ?? [])], { cwd: ROOT, env: { ...baseEnv, AQUA_DATA_DIR: dataDir, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const p = { name, child, dataDir, text: '' };
  const sink = fs.createWriteStream(file);
  for (const s of [child.stdout, child.stderr]) s.on('data', d => { p.text += d; sink.write(d); });
  procs[name] = p;
  return p;
}
const exited = p => p.child.exitCode != null || p.child.signalCode != null;
const kill = name => new Promise(r => { const p = procs[name]; if (!p || exited(p)) return r(); p.child.on('exit', r); p.child.kill(); });
const api = (name, port) => start(name, path.join(ROOT, 'scripts', 'start-api.mjs'), { PORT: String(port) });
const worker = (name, extra = {}) => start(name, path.join(ROOT, 'scripts', 'start-worker.mjs'), { HOSTNAME: name, __args: ['--poll', '300'], ...extra });
async function waitReady(port, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/ready`); if (r.status === 200) return true; } catch { /* not up */ }
    await sleep(500);
  }
  return false;
}
function rssMb(pid) {
  try {
    if (process.platform === 'win32') {
      const o = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`]).toString().trim();
      return Math.round(Number(o) / 1048576);
    }
    return Math.round(Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024);
  } catch { return null; }
}
function sampleRss(label) {
  for (const [n, p] of Object.entries(procs)) if (!exited(p)) (metrics.workerRssMb[n] ??= []).push({ label, mb: rssMb(p.child.pid) });
}

// ── HTTP client (one cookie jar: the SAME session on both instances) ─────────
const jar = new Map();
async function req(port, method, p, { body = null, form = null, signal } = {}) {
  const h = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  let payload;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal });
  for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, json, location: res.headers.get('location') };
}
const csrfOf = html => html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"\s+name="_csrf"/)?.[1] ?? '';
async function chatOnce(port, message, conversationId = null) {
  const t0 = Date.now();
  const r = await req(port, 'POST', '/api/aqua/chat', { body: { message, ...(conversationId ? { conversationId } : {}) } });
  const ms = Date.now() - t0;
  const d = r.json?.data ?? r.json ?? {};
  return { status: r.status, ms, answer: String(d.reply ?? d.answer ?? ''), conversationId: d.conversationId ?? conversationId, text: r.text };
}
async function chat(port, message, conversationId = null) {
  for (let i = 0; i < 4; i++) {
    const r = await chatOnce(port, message, conversationId);
    if (r.status === 200) { metrics.chatMs.push(r.ms); return r; }
    out(`  chat on :${port} HTTP ${r.status}: ${r.text.slice(0, 160)}`);
    await sleep(4000);
  }
  throw new Error('chat failed');
}
async function stream(port, message, conversationId) {
  const t0 = Date.now();
  const r = await req(port, 'POST', '/api/aqua/chat/stream', { body: { message, conversationId } });
  const events = [...r.text.matchAll(/event: (\w+)/g)].map(m => m[1]);
  return { status: r.status, ms: Date.now() - t0, events, text: r.text };
}
async function workersIdle(owner, label, ms = 300_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM aqua_jobs WHERE owner_id = $1 AND state IN ('queued','running') AND run_after <= now()`, [owner]);
    if (!n) { out(`  [workers idle after ${label}: ${Math.round((Date.now() - t0) / 1000)}s]`); return true; }
    await sleep(1000);
  }
  out(`  [workers still busy after ${label}]`);
  return false;
}
const rows = (owner, store) => q(`SELECT partition_key, data, version, deleted_at FROM aqua_store_partitions WHERE owner_id = $1 AND store_key = $2 ORDER BY partition_key`, [owner, store]);
const live = rs => rs.filter(r => r.data !== null);
const mongosh = js => execFileSync('docker', ['exec', 'aqua-test-mongo', 'mongosh', '--quiet', MONGO_DB, '--eval', js]).toString().trim();
const turnCount = async owner => { const m = live(await rows(owner, '.aqua-mind.json'))[0]; return m ? JSON.parse(m.data).turnCount ?? 0 : 0; };
const jobLines = name => [...(procs[name]?.text ?? '').matchAll(/\[JOB\] (\{.*\})/g)].map(m => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
/** Every user message row of the owner has its learning.mind job (the durable invariant). */
async function orphanTurns(owner) {
  const users = live(await rows(owner, '.aqua-history.json')).filter(r => r.partition_key.startsWith('m:') && JSON.parse(r.data).role === 'user');
  const jobs = await q(`SELECT source_ref->>'userMessageKey' AS k FROM aqua_jobs WHERE owner_id = $1 AND kind = 'learning.mind.v1'`, [owner]);
  const have = new Set(jobs.map(j => j.k));
  return users.filter(u => !have.has(u.partition_key.split(':').pop())).map(u => u.partition_key);
}

const A = 5081, B = 5082;
let OWNER = null;
const WALLET_START = 5000;   // paid credits only, so the daily free reset cannot blur the arithmetic
let pgStart = null;
try {
  await (async () => { const { migrate } = await import('../src/core/db/migrate.js'); process.env.DATABASE_URL = DB; await migrate(); })();
  [pgStart] = await q(`SELECT xact_commit::bigint AS c, tup_inserted::bigint AS i, tup_updated::bigint AS u FROM pg_stat_database WHERE datname = current_database()`);
  out(`logs: ${LOGDIR} · durable=${DURABLE ? 'on' : 'off'}`);
  api('apiA', A); api('apiB', B); worker('w1'); worker('w2');
  const up = await Promise.all([waitReady(A), waitReady(B)]);
  check('boot', 'both API instances report ready (/ready 200)', up.every(Boolean));
  durableOnly('boot', 'both APIs state durable learning ACTIVE', ['apiA', 'apiB'].every(n => /durable post-turn learning: ACTIVE/.test(procs[n].text)));
  check('boot', 'no API process started a worker', !/\[WORKER\]/.test(procs.apiA.text + procs.apiB.text));

  // ── L1 signup + login ──
  out('\n=== L1 signup + login ===');
  const page = await req(A, 'GET', '/signup');
  const su = await req(A, 'POST', '/signup', { form: { email: EMAIL, password: PASSWORD, _csrf: csrfOf(page.text) } });
  await sleep(1500);
  const token = procs.apiA.text.match(/verify-email\?token=([A-Za-z0-9_\-.%]+)/)?.[1];
  const vf = await req(A, 'GET', `/verify-email?token=${token}`);
  const vs = await req(A, 'POST', '/verify-email', { form: { token: decodeURIComponent(token ?? ''), password: PASSWORD, _csrf: csrfOf(vf.text) } });
  const uid = mongosh(`const u = db.users.findOne({email:'${EMAIL}'}); print(u ? u._id.toString() : '')`);
  OWNER = `user:${uid}`;
  check('L1', 'account created and signed in', su.status === 200 && !!uid && [200, 302, 303].includes(vs.status));
  mongosh(`db.users.updateOne({email:'${EMAIL}'},{'$set':{'wallet.freeCredits':0,'wallet.paidCredits':5000}})`);

  // ── L2 a turn is durable with its jobs ──
  out('\n=== L2 durable turn ===');
  const c1 = await chat(A, "Hi, I'm Mara. I live in Lisbon and I work at Acme Robotics as a product designer.");
  const conv = c1.conversationId;
  const j1 = await q(`SELECT kind, payload, source_ref FROM aqua_jobs WHERE owner_id = $1`, [OWNER]);
  durableOnly('L2', 'when the API answered, the turn\'s learning jobs were already in the database', j1.some(j => j.kind === 'learning.mind.v1') && j1.some(j => j.kind === 'learning.observe.v1'), j1.map(j => j.kind).join(','));
  durableOnly('L2', 'no job row carries what the user said', !j1.some(j => /Lisbon|Acme/i.test(JSON.stringify(j))));
  const s1 = await stream(B, 'My favourite tool is Figma.', conv);
  metrics.streamMs.push(s1.ms);
  check('L2', 'streaming turn on the other instance ends with done', s1.status === 200 && s1.events.includes('done'), s1.events.join(','));

  // ── L3 learning happens in workers, across instances ──
  out('\n=== L3 learning in workers ===');
  await workersIdle(OWNER, 'first turns');
  durableOnly('L3', 'the Mind counted exactly 2 turns', (await turnCount(OWNER)) === 2, `turnCount=${await turnCount(OWNER)}`);
  const doneBy = n => jobLines(n).filter(e => e.phase === 'done' && /^learning\./.test(e.kind)).length;
  durableOnly('L3', 'learning jobs were run by the workers', doneBy('w1') + doneBy('w2') >= 4, `w1=${doneBy('w1')} w2=${doneBy('w2')}`);
  durableOnly('L3', 'no API ran a learning job', !/learning\.(mind|observe)\.v1/.test(procs.apiA.text + procs.apiB.text));
  const recall = await chat(B, 'Where do I live, and where do I work?', conv);
  check('L3', 'recall on B uses what was said on A', /lisbon/i.test(recall.answer) && /acme/i.test(recall.answer), recall.answer.slice(0, 120).replace(/\n/g, ' '));

  // ── L4 concurrent messages across both APIs ──
  out('\n=== L4 concurrent messages ===');
  const tc0 = await turnCount(OWNER);
  await workersIdle(OWNER, 'before concurrency');
  const tcBefore = await turnCount(OWNER);
  const conc = await Promise.all([
    chat(A, 'My manager is Joana Silva.', conv), chat(B, 'I mentor two junior designers.', conv),
    chat(A, 'Our launch is in March.', conv), chat(B, 'I prefer concise answers.', conv),
  ]);
  await workersIdle(OWNER, 'concurrent turns');
  durableOnly('L4', '4 concurrent turns → turn count +4 exactly', (await turnCount(OWNER)) === tcBefore + 4, `${tcBefore}→${await turnCount(OWNER)} (start ${tc0})`);
  durableOnly('L4', 'every persisted user message has its learning job', (await orphanTurns(OWNER)).length === 0, JSON.stringify(await orphanTurns(OWNER)));
  check('L4', 'all 4 answered', conc.every(c => c.answer.length > 0));

  // ── L5 duplicate delivery ──
  out('\n=== L5 duplicate delivery ===');
  const tc5 = await turnCount(OWNER);
  const requeued = await q(`UPDATE aqua_jobs SET state = 'queued', run_after = now() WHERE owner_id = $1 AND kind LIKE 'learning.%' AND state = 'done' RETURNING job_id`, [OWNER]);
  await workersIdle(OWNER, 'redelivery');
  durableOnly('L5', `${requeued.length} learning jobs delivered again → turn count unchanged`, (await turnCount(OWNER)) === tc5, `${tc5}→${await turnCount(OWNER)}`);
  const skippedApplied = ['w1', 'w2'].flatMap(jobLines).filter(e => e.outcome === 'skipped:already-applied').length;
  durableOnly('L5', 'the re-run Mind stages recognised their applied markers', skippedApplied >= 1, `skipped=${skippedApplied}`);

  // ── L6 worker crash mid-job; turns while no worker runs ──
  out('\n=== L6 worker crash + recovery ===');
  await q(`INSERT INTO aqua_jobs (owner_id, kind, payload, idempotency_key) VALUES ($1, 'ops.canary.v1', '{"ms": 15000}', $2)`, [OWNER, `canary-${Date.now()}`]);
  const tRun = Date.now();
  while (Date.now() - tRun < 20_000) {
    const [{ r }] = await q(`SELECT count(*)::int AS r FROM aqua_jobs WHERE owner_id = $1 AND state = 'running' AND kind = 'ops.canary.v1'`, [OWNER]);
    if (r) break;
    await sleep(100);
  }
  sampleRss('before crash');
  await Promise.all([kill('w1'), kill('w2')]);   // Windows: TerminateProcess = a crash, no handler runs
  const [{ stranded }] = await q(`SELECT count(*)::int AS stranded FROM aqua_jobs WHERE owner_id = $1 AND state = 'running'`, [OWNER]);
  check('L6', 'a job was running when both workers died', stranded > 0, `running=${stranded}`);
  const tc6 = await turnCount(OWNER);
  await chat(A, 'Rui and Inês are the designers I mentor.', conv);
  const [{ queuedWhileDown }] = await q(`SELECT count(*)::int AS "queuedWhileDown" FROM aqua_jobs WHERE owner_id = $1 AND kind LIKE 'learning.%' AND state = 'queued'`, [OWNER]);
  durableOnly('L6', 'a turn taken while no worker runs is queued, not lost', queuedWhileDown >= 2, `queued=${queuedWhileDown}`);
  worker('w3');
  const idle6 = await workersIdle(OWNER, 'restart (heartbeat stale after 6 s)', 120_000);
  const [{ dead6 }] = await q(`SELECT count(*)::int AS dead6 FROM aqua_jobs WHERE owner_id = $1 AND state = 'dead'`, [OWNER]);
  check('L6', 'a fresh worker recovered the abandoned job and drained the backlog', idle6 && dead6 === 0 && /reclaimed \d+ job/.test(procs.w3.text), `dead=${dead6}`);
  durableOnly('L6', 'the turn taken while workers were down was learned once', (await turnCount(OWNER)) === tc6 + 1, `${tc6}→${await turnCount(OWNER)}`);
  worker('w4');

  // ── L7 API crash with a request in flight ──
  out('\n=== L7 API crash mid-request ===');
  const inflight = chatOnce(A, 'Please write a detailed two-paragraph summary of everything you know about my work.', conv).catch(e => ({ status: 0, error: String(e) }));
  await sleep(1500);
  await kill('apiA');
  const r7 = await inflight;
  out(`  in-flight request ended: HTTP ${r7.status}`);
  await sleep(1000);
  durableOnly('L7', 'no persisted user message is without its learning job after the crash', (await orphanTurns(OWNER)).length === 0, JSON.stringify(await orphanTurns(OWNER)));
  api('apiA2', A);
  check('L7', 'replacement API (empty disk) ready', await waitReady(A));

  // ── L8 database interruption ──
  if (!SKIP_DB_RESTART) {
    out('\n=== L8 database interruption ===');
    await workersIdle(OWNER, 'before db restart');
    const tc8 = await turnCount(OWNER);
    await db.end();
    execFileSync('docker', ['restart', '-t', '2', 'aqua-test-db']);
    const during = await chatOnce(B, 'I just moved my standup to 10am.', conv).catch(e => ({ status: 0, error: String(e) }));
    out(`  chat during the restart: HTTP ${during.status}`);
    db = new pg.Pool({ connectionString: DB, max: 3 }); db.on('error', () => {});
    for (let i = 0; i < 60; i++) { try { await q('SELECT 1'); break; } catch { await sleep(1000); } }
    check('L8', 'a turn during the outage is refused or fully committed — never acknowledged without its jobs',
      during.status !== 200 || (await orphanTurns(OWNER)).length === 0, `HTTP ${during.status}`);
    const back = await Promise.all([waitReady(A, 60_000), waitReady(B, 60_000)]);
    check('L8', 'both APIs ready again after the database came back', back.every(Boolean));
    await chat(B, 'My standup is at 10am now.', conv);
    const idle8 = await workersIdle(OWNER, 'after db restart', 180_000);
    const expected = tc8 + (during.status === 200 ? 2 : 1);
    durableOnly('L8', 'workers recovered without a restart and learned every committed turn once', idle8 && (await turnCount(OWNER)) === expected, `${tc8}→${await turnCount(OWNER)} expected ${expected}`);
    check('L8', 'workers are still running', !exited(procs.w3) && !exited(procs.w4));
  }

  // ── L9 redaction ──
  out('\n=== L9 sensitive content ===');
  await chat(A, 'I was diagnosed with severe depression last spring. Anyway, I use Notion for planning.', conv);
  await workersIdle(OWNER, 'sensitive turn');
  const jobsText = JSON.stringify(await q(`SELECT payload, source_ref FROM aqua_jobs WHERE owner_id = $1`, [OWNER]));
  check('L9', 'no job row contains the sensitive sentence', !/depression/i.test(jobsText));
  const learned = await q(`SELECT store_key FROM aqua_store_partitions WHERE owner_id = $1 AND data IS NOT NULL AND store_key NOT IN ('.aqua-history.json', '.aqua-history-trash.json') AND data ILIKE '%depression%'`, [OWNER]);
  check('L9', 'nothing learned outside the conversation holds the sensitive sentence', learned.length === 0, JSON.stringify(learned));
  const claimsSens = await q(`SELECT count(*)::int AS n FROM aqua_claims WHERE owner_id = $1 AND statement_text ILIKE '%depression%'`, [OWNER]).catch(() => [{ n: 0 }]);
  check('L9', 'no canonical claim holds it', claimsSens[0].n === 0);

  // ── L10 scheduler ownership ──
  out('\n=== L10 scheduler ownership ===');
  const owns = n => (procs[n]?.text.match(/now OWNS the periodic schedulers/g) ?? []).length;
  const lost = n => (procs[n]?.text.match(/no longer owns/g) ?? []).length;
  check('L10', 'w1/w2: exactly one owned the schedulers, never flapped', owns('w1') + owns('w2') === 1 && lost('w1') + lost('w2') === 0, `w1=${owns('w1')} w2=${owns('w2')}`);
  // During the deliberate database restart (L8) the holder cannot renew: it fails
  // CLOSED (stops running schedulers) and re-acquires afterwards. One owner
  // throughout means: only ONE of the replacements ever owned the lease, and it
  // lost it only as often as the database went away.
  const outages = SKIP_DB_RESTART ? 0 : 1;
  const holders = ['w3', 'w4'].filter(n => owns(n) > 0);
  check('L10', 'after both died, exactly one replacement ever owned them (losses only during the DB outage)',
    holders.length === 1 && lost('w3') + lost('w4') <= outages, `w3=${owns('w3')}/${lost('w3')} w4=${owns('w4')}/${lost('w4')} outages=${outages}`);

  // ── L12 pending charges (Phase 4B; only with AQUA_PENDING_CHARGES=on) ──
  if (process.env.AQUA_PENDING_CHARGES === 'on') {
    out('\n=== L12 pending charges ===');
    const uidNow = OWNER.slice(5);
    const before = await q(`SELECT state, count(*)::int AS n FROM aqua_charges WHERE user_id = $1 GROUP BY state ORDER BY state`, [uidNow]);
    out(`  charges before reconcile: ${JSON.stringify(before)}`);
    let rec = {};
    try {
      rec = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'aqua', 'scripts', 'charges-reconcile.mjs'), '--db', DB, '--mongo', MONGO,
        '--abandon-ms', '1000', '--ledger', '--stats', '--user', uidNow], { cwd: ROOT, env: { ...process.env, MONGO_URI: '' } }).toString());
    } catch (e) { try { rec = JSON.parse(String(e.stdout)); } catch { rec = { error: String(e.stderr ?? e).slice(0, 300) }; } }
    out(`  reconcile: ${JSON.stringify(rec.reconcile)} anomalies: ${rec.ledger?.anomalies?.length ?? 'n/a'}`);
    const after = await q(`SELECT state, count(*)::int AS n FROM aqua_charges WHERE user_id = $1 GROUP BY state ORDER BY state`, [uidNow]);
    const n = st => after.find(r => r.state === st)?.n ?? 0;
    check('L12', 'every charge of the session is resolved after one reconcile pass', !n('PENDING') && !n('REFUND_PENDING'), JSON.stringify(after));
    check('L12', 'the credit ledger agrees with every charge', (rec.ledger?.anomalies ?? ['?']).length === 0, JSON.stringify(rec.ledger?.anomalies?.slice(0, 3) ?? rec.error));
    const walletNow = Number(mongosh(`const u = db.users.findOne({email:'${EMAIL}'}); print((u.wallet.freeCredits||0)+(u.wallet.paidCredits||0))`));
    // Each COMMITTED charge cost one chat (5 credits); everything else was refunded. (Unlimited or free-reset effects aside.)
    check('L12', 'wallet = start − 5 × committed charges (refunded turns cost nothing)', walletNow === WALLET_START - 5 * n('COMMITTED'), `${WALLET_START} − 5×${n('COMMITTED')} vs ${walletNow}`);
  }

  // ── measurements ──
  sampleRss('end');
  const { jobTimings } = await import('../src/core/jobs/jobQueue.js');
  metrics.jobs = await jobTimings({ windowMinutes: 120 }).catch(e => String(e));
  metrics.turnCommitMs = ['apiA', 'apiB', 'apiA2'].flatMap(n => [...(procs[n]?.text ?? '').matchAll(/\[TURN\] (\{.*"phase":"committed".*\})/g)].map(m => JSON.parse(m[1]).ms));
  const [pgEnd] = await q(`SELECT xact_commit::bigint AS c, tup_inserted::bigint AS i, tup_updated::bigint AS u FROM pg_stat_database WHERE datname = current_database()`);
  if (pgStart && SKIP_DB_RESTART) metrics.db = { commits: Number(pgEnd.c) - Number(pgStart.c), inserted: Number(pgEnd.i) - Number(pgStart.i), updated: Number(pgEnd.u) - Number(pgStart.u) };
  metrics.retriesDead = await q(`SELECT kind, count(*) FILTER (WHERE attempts > 1)::int AS retried, count(*) FILTER (WHERE state = 'dead')::int AS dead, count(*)::int AS jobs FROM aqua_jobs WHERE owner_id = $1 GROUP BY kind ORDER BY kind`, [OWNER]);

  // ── L11 account deletion with jobs pending ──
  out('\n=== L11 account deletion with jobs pending ===');
  await Promise.all([kill('w3'), kill('w4')]);
  await chat(B, 'One more thing: I am learning Portuguese.', conv);
  const [{ pending }] = await q(`SELECT count(*)::int AS pending FROM aqua_jobs WHERE owner_id = $1 AND state = 'queued'`, [OWNER]);
  const settings = await req(B, 'GET', '/account');
  const ad = await req(B, 'POST', '/api/account/delete', { body: { password: PASSWORD, _csrf: csrfOf(settings.text) } });
  worker('w5');
  await sleep(8000);
  const left = await q(`SELECT store_key, count(*)::int AS n FROM aqua_store_partitions WHERE owner_id = $1 AND data IS NOT NULL GROUP BY store_key`, [OWNER]);
  const marker = await q(`SELECT 1 FROM aqua_deleted_owners WHERE owner_id = $1`, [OWNER]);
  check('L11', 'account deletion accepted with learning jobs pending', ad.status < 300 && pending > 0, `HTTP ${ad.status} pending=${pending}`);
  check('L11', 'deletion recorded before the purge (aqua_deleted_owners)', marker.length === 1);
  check('L11', 'no live row of the user in any store after a worker ran', left.length === 0, JSON.stringify(left));
} catch (err) {
  check('run', 'journey completed without an exception', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  for (const name of Object.keys(procs)) await kill(name);
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
  metrics.summary = {
    chat: { n: metrics.chatMs.length, p50: pct(metrics.chatMs, 0.5), p95: pct(metrics.chatMs, 0.95) },
    turnCommit: { n: (metrics.turnCommitMs ?? []).length, p50: pct(metrics.turnCommitMs ?? [], 0.5), p95: pct(metrics.turnCommitMs ?? [], 0.95), max: Math.max(0, ...(metrics.turnCommitMs ?? [])) },
  };
  const result = { at: new Date().toISOString(), durable: DURABLE, platform: process.platform, owner: OWNER,
    passed: checks.filter(c => c.ok).length, total: checks.length, checks, metrics, logs: LOGDIR };
  out(`\nmetrics: ${JSON.stringify(metrics.summary)}`);
  out(`\nRESULT ${result.passed}/${result.total} checks passed · logs ${LOGDIR}`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  await db.end().catch(() => {});
  process.exit(0);
}
