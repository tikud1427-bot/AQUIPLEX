#!/usr/bin/env node
/**
 * Phase 2c — application-level journey with EVERY store on owner partitions,
 * in the split runtime: TWO API instances + TWO workers, each with its own
 * empty data directory (separate "hosts"), sharing only the disposable
 * Postgres and the disposable Mongo. Real HTTP, real sessions, real providers
 * (keys from the platform .env), real extraction in the workers.
 *
 *   node aqua/scripts/phase2c-app-journey.mjs --db <local test url> [--mongo mongodb://127.0.0.1:57017/aqua_phase2c] [--out report.json]
 *
 * SAFETY: --db must be local; Mongo must be local; MAIL_TRANSPORT=log (the
 * verification link is read from the API's log — no email is sent);
 * NODE_ENV=development; the Mongo mirror is disabled; AQUA_STORE_PG (blob
 * shadow) forced off. Provider calls are real and spend free-tier quota.
 * Every check reads the PERSISTED rows (aqua_store_partitions, aqua_jobs).
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DB = arg('--db');
const MONGO = arg('--mongo', 'mongodb://127.0.0.1:57017/aqua_phase2c');
const OUT = arg('--out', null);
const local = u => ['localhost', '127.0.0.1', '::1'].includes(new URL(u).hostname);
if (!DB || !local(DB) || !local(MONGO.replace('mongodb://', 'http://'))) { console.error('✗ --db and --mongo must be local test services'); process.exit(2); }
const MONGO_DB = new URL(MONGO.replace('mongodb://', 'http://')).pathname.slice(1);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL_ON = 'reflection:on,mind:on,recall-redactions:on,history:on,reasoning-graph:on,ids:on,brain:on,evidence:on,fileindex:on,uko:on,attachments:on,pic:on,vectors:on,projects:on,index:on,artifacts:on,cognition:on,ledger:on';
const EMAIL = `p2c-${Date.now().toString(36)}@example.test`;
const PASSWORD = 'p2c-journey-password-123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const log = [];
const out = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
const check = (scenario, name, ok, detail = '') => { checks.push({ scenario, name, ok: !!ok, detail }); out(`  ${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name}${detail ? ` — ${detail}` : ''}`); };

const { default: pg } = await import('pg');
const db = new pg.Pool({ connectionString: DB, max: 3 });
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

// ── processes ────────────────────────────────────────────────────────────────
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-p2c-logs-'));
const baseEnv = {
  ...process.env,
  DATABASE_URL: DB, MONGO_URI: MONGO, AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_STORE_PG: 'off', AQUA_STORE_PARTITIONS: ALL_ON,
  NODE_ENV: 'development', MAIL_TRANSPORT: 'log', APP_URL: 'http://127.0.0.1', RENDER: '', AQUA_RATE_LIMIT_REDIS_URL: '',
  AQUA_SCHEDULER_LEASE_MS: '5000',
};
const procs = {};
function start(name, script, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `aq-p2c-${name}-`));
  const file = path.join(LOGDIR, `${name}.log`);
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...baseEnv, AQUA_DATA_DIR: dataDir, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const p = { name, child, dataDir, text: '' };
  const sink = fs.createWriteStream(file);
  for (const s of [child.stdout, child.stderr]) s.on('data', d => { p.text += d; sink.write(d); });
  procs[name] = p;
  return p;
}
// exitCode stays null for a process ended by a signal: signalCode says it exited too.
const exited = p => p.child.exitCode != null || p.child.signalCode != null;
const kill = name => new Promise(r => { const p = procs[name]; if (!p || exited(p)) return r(); p.child.on('exit', r); p.child.kill(); });
const api = (name, port) => start(name, path.join(ROOT, 'scripts', 'start-api.mjs'), { PORT: String(port) });
const worker = name => start(name, path.join(ROOT, 'scripts', 'start-worker.mjs'), { HOSTNAME: name });
async function waitReady(port, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/ready`); if (r.status === 200) return true; } catch { /* not up */ }
    await sleep(500);
  }
  return false;
}

// ── HTTP client with one cookie jar (the SAME session is used on both instances) ──
const jar = new Map();
async function req(port, method, p, { body = null, form = null } = {}) {
  const h = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  let payload;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
  for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, json, location: res.headers.get('location') };
}
const csrfOf = html => html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"\s+name="_csrf"/)?.[1] ?? '';
async function chat(port, message, conversationId = null) {
  for (let i = 0; i < 4; i++) {
    const r = await req(port, 'POST', '/api/aqua/chat', { body: { message, ...(conversationId ? { conversationId } : {}) } });
    if (r.status === 200) { const d = r.json?.data ?? r.json ?? {}; return { answer: String(d.reply ?? d.answer ?? ''), conversationId: d.conversationId ?? conversationId }; }
    out(`  chat on :${port} HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    await sleep(4000);
  }
  throw new Error('chat failed');
}
async function workersIdle(owner, label, ms = 300_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM aqua_jobs WHERE owner_id = $1 AND state IN ('queued','running') AND run_after <= now()`, [owner]);
    if (!n) { out(`  [workers idle after ${label}: ${Math.round((Date.now() - t0) / 1000)}s]`); return true; }
    await sleep(3000);
  }
  out(`  [workers still busy after ${label}]`);
  return false;
}
const rows = (owner, store) => q(`SELECT partition_key, data, version, deleted_at FROM aqua_store_partitions WHERE owner_id = $1 AND store_key = $2 ORDER BY partition_key`, [owner, store]);
const live = rs => rs.filter(r => r.data !== null);
const mongosh = js => execFileSync('docker', ['exec', 'aqua-test-mongo', 'mongosh', '--quiet', MONGO_DB, '--eval', js]).toString().trim();

const A = 5071, B = 5072;
let OWNER = null;
try {
  await (async () => { const { migrate } = await import('../src/core/db/migrate.js'); process.env.DATABASE_URL = DB; await migrate(); })();
  // "migrated" markers: every store has rows (the empty data dirs hold no JSON, so `on` is allowed either way).
  out(`logs: ${LOGDIR}`);
  api('apiA', A); api('apiB', B); worker('w1'); worker('w2');
  const up = await Promise.all([waitReady(A), waitReady(B)]);
  check('boot', 'both API instances report ready (/ready 200)', up.every(Boolean));
  check('boot', 'every store is on partitions in both APIs', ['apiA', 'apiB'].every(n => /partitions: .*history=on/.test(procs[n].text) && !/refused/.test(procs[n].text)));
  check('boot', 'no API process started a worker', !/\[WORKER\]/.test(procs.apiA.text + procs.apiB.text));

  // ── S1 signup (on A, link from A's log) and login used on B ──
  out('\n=== S1 signup + login across instances ===');
  const page = await req(A, 'GET', '/signup');
  const su = await req(A, 'POST', '/signup', { form: { email: EMAIL, password: PASSWORD, _csrf: csrfOf(page.text) } });
  await sleep(1500);
  const token = procs.apiA.text.match(/verify-email\?token=([A-Za-z0-9_\-.%]+)/)?.[1];
  check('S1', 'signup accepted; verification link logged, not sent', su.status === 200 && !!token);
  const vf = await req(A, 'GET', `/verify-email?token=${token}`);
  const vs = await req(A, 'POST', '/verify-email', { form: { token: decodeURIComponent(token ?? ''), password: PASSWORD, _csrf: csrfOf(vf.text) } });
  const uid = mongosh(`const u = db.users.findOne({email:'${EMAIL}'}); print(u ? u._id.toString() : '')`);
  OWNER = `user:${uid}`;
  check('S1', 'account created by verification', !!uid && [200, 302, 303].includes(vs.status), `HTTP ${vs.status}`);
  mongosh(`db.users.updateOne({email:'${EMAIL}'},{'$set':{'wallet.freeCredits':5000,'wallet.paidCredits':5000}})`);
  const listB = await req(B, 'GET', '/api/aqua/conversations');
  check('S1', 'the session made on A is valid on B (shared session store)', listB.status === 200);

  // ── S2 conversation creation ──
  out('\n=== S2 conversation creation ===');
  const c1 = await chat(A, "Hi, I'm Mara. I live in Lisbon and I work at Acme Robotics as a product designer.");
  const conv = c1.conversationId;
  await sleep(1200);
  const h1 = await rows(OWNER, '.aqua-history.json');
  check('S2', 'header + one row per message, owned by the user', live(h1).some(r => r.partition_key === `c:${conv}`) && live(h1).filter(r => r.partition_key.startsWith(`m:${conv}:`)).length === 2);

  // ── S3 concurrent message insertion (A and B, same conversation) ──
  out('\n=== S3 concurrent insertion ===');
  await Promise.all([chat(A, 'My favourite tool is Figma.', conv), chat(B, 'My manager is Joana Silva.', conv)]);
  await sleep(1500);
  const h2 = live(await rows(OWNER, '.aqua-history.json')).filter(r => r.partition_key.startsWith(`m:${conv}:`));
  const contents = h2.map(r => JSON.parse(r.data).content);
  check('S3', 'all 6 messages persisted, none duplicated', h2.length === 6 && new Set(h2.map(r => r.partition_key)).size === 6, `${h2.length} rows`);
  check('S3', 'both instances\' user messages present', contents.includes('My favourite tool is Figma.') && contents.includes('My manager is Joana Silva.'));
  check('S3', 'no message row was rewritten', h2.every(r => Number(r.version) === 1));
  const viewA = await req(A, 'GET', `/api/aqua/conversations/${conv}`);
  const viewB = await req(B, 'GET', `/api/aqua/conversations/${conv}`);
  const n = x => (x.json?.data?.messages ?? x.json?.messages ?? []).length;
  check('S3', 'both instances show the same 6 messages', n(viewA) === 6 && n(viewB) === 6, `A=${n(viewA)} B=${n(viewB)}`);

  // ── S4 memory extraction (workers) and recall on the OTHER instance ──
  out('\n=== S4 extraction + recall ===');
  await workersIdle(OWNER, 'extraction');
  const recall = await chat(B, 'Where do I live, and where do I work?');
  out(`  B answered: ${recall.answer.slice(0, 200).replace(/\n/g, ' ')}`);
  check('S4', 'recall on B uses what was learned through A', /lisbon/i.test(recall.answer) && /acme/i.test(recall.answer));
  const mind = live(await rows(OWNER, '.aqua-mind.json'))[0];
  const claims = await q(`SELECT count(*)::int AS n FROM aqua_claims WHERE owner_id = $1`, [OWNER]).catch(() => [{ n: -1 }]);
  check('S4', 'memory persisted (Mind partition and/or canonical claims)', !!mind || claims[0].n > 0, `mind=${!!mind} claims=${claims[0].n}`);
  const [{ dead }] = await q(`SELECT count(*)::int AS dead FROM aqua_jobs WHERE owner_id = $1 AND state = 'dead'`, [OWNER]);
  check('S4', 'no job dead-lettered', dead === 0, `dead=${dead}`);

  // ── S5 Mind update: forget a fact on A, absent on B ──
  out('\n=== S5 Mind update ===');
  const memB = await req(B, 'GET', '/api/aqua/memory');
  const facts = memB.json?.data?.facts ?? memB.json?.facts ?? [];
  const victim = (Array.isArray(facts) ? facts : Object.values(facts)).find(f => /figma/i.test(JSON.stringify(f)));
  if (victim?.key) {
    const del = await req(A, 'DELETE', `/api/aqua/memory/fact/${encodeURIComponent(victim.key)}`);
    await sleep(1500);
    const after = live(await rows(OWNER, '.aqua-mind.json'))[0];
    check('S5', 'fact forgotten through A is gone from the persisted Mind', del.status < 300 && !JSON.stringify(JSON.parse(after?.data ?? '{}').facts ?? {}).toLowerCase().includes('figma'));
    const memB2 = await req(B, 'GET', '/api/aqua/memory');
    check('S5', 'and B no longer lists it', !/figma/i.test(memB2.text));
  } else {
    check('S5', 'a Figma fact was available to forget (legacy extraction)', false, 'not found — scenario not exercised');
  }

  // ── S6/S7 reflection, file upload → reasoning graph / identity / evidence ──
  out('\n=== S6/S7 upload, graph, identity, reflection ===');
  const doc = 'Acme Robotics product brief\nProduct: Rover X2\nLaunch date: 12 March\nOwner: Mara (product design)';
  const upl = await req(A, 'POST', '/api/aqua/upload', { body: { conversationId: conv, files: [{ name: 'brief.txt', content: Buffer.from(doc).toString('base64') }] } });
  check('S7', 'upload accepted', upl.status < 300, `HTTP ${upl.status}`);
  for (const t of ['The Rover X2 launch is on 12 March.', 'Joana approved the Rover X2 budget.', 'I am preparing the launch deck.']) await chat(B, t, conv);
  await workersIdle(OWNER, 'upload + turns');
  for (const [store, label] of [['.aqua-uko.json', 'uko'], ['.aqua-attachments.json', 'attachments'], ['.aqua-evidence.json', 'evidence'],
    ['.aqua-reasoning-graph.json', 'reasoning graph'], ['.aqua-ids.json', 'identity map'], ['.aqua-reflection.json', 'reflection'], ['.aqua-pic.json', 'pic']]) {
    const r = live(await rows(OWNER, store));
    out(`  ${label}: ${r.length} live row(s)`);
    checks.push({ scenario: 'S6/S7', name: `${label} rows for the user`, ok: true, detail: `${r.length}`, informational: true });
  }
  const att = live(await rows(OWNER, '.aqua-attachments.json'));
  check('S7', 'the upload\'s attachment row belongs to the user', att.length === 1 && att[0].partition_key === `c:${conv}`);

  // ── S9/S11 worker restart + interrupted jobs ──
  out('\n=== S9/S11 worker restart, interrupted jobs ===');
  await chat(A, 'I also mentor two junior designers, Rui and Inês.', conv);
  // Kill the workers while an extraction job is genuinely RUNNING (provider call in flight).
  const tRun = Date.now();
  while (Date.now() - tRun < 60_000) {
    const [{ r }] = await q(`SELECT count(*)::int AS r FROM aqua_jobs WHERE owner_id = $1 AND state = 'running'`, [OWNER]);
    if (r) break;
    await sleep(50);
  }
  await Promise.all([kill('w1'), kill('w2')]);
  const [{ running }] = await q(`SELECT count(*)::int AS running FROM aqua_jobs WHERE owner_id = $1 AND state = 'running'`, [OWNER]);
  // A killed worker's 'running' job is reclaimed after 10 minutes; age it rather than wait.
  await q(`UPDATE aqua_jobs SET claimed_at = now() - interval '1 hour' WHERE owner_id = $1 AND state = 'running'`, [OWNER]);
  worker('w3');
  const idle = await workersIdle(OWNER, 'restart');
  const [{ dead2 }] = await q(`SELECT count(*)::int AS dead2 FROM aqua_jobs WHERE owner_id = $1 AND state = 'dead'`, [OWNER]);
  check('S9', 'a fresh worker drains everything the killed workers left', idle && dead2 === 0, `stranded running=${running}`);
  check('S11', 'a job was genuinely interrupted mid-run', running > 0, `running at kill=${running}`);
  if (running) check('S11', 'the interrupted job was reclaimed and completed', /reclaimed \d+ job/.test(procs.w3.text));

  // ── S10 server restart with an EMPTY data dir (a new container) ──
  out('\n=== S10 server restart ===');
  await kill('apiA');
  api('apiA2', A);
  check('S10', 'restarted API ready', await waitReady(A));
  const viewA2 = await req(A, 'GET', `/api/aqua/conversations/${conv}`);
  check('S10', 'conversation fully served by a new instance with an empty disk', n(viewA2) >= 10, `${n(viewA2)} messages`);
  const recall2 = await chat(A, 'Who is my manager?');
  check('S10', 'memory served by the new instance', /joana/i.test(recall2.answer));

  // ── S8 conversation deletion (on B), tombstones + trash ──
  out('\n=== S8 conversation deletion ===');
  const del = await req(B, 'DELETE', `/api/aqua/conversations/${conv}`);
  await sleep(2000);
  const h3 = (await rows(OWNER, '.aqua-history.json')).filter(r => r.partition_key === `c:${conv}` || r.partition_key.startsWith(`m:${conv}:`));
  check('S8', 'header and every message tombstoned', del.status < 300 && h3.length > 0 && h3.every(r => r.data === null));
  const trash = live(await rows(OWNER, '.aqua-history-trash.json'));
  check('S8', 'recovery snapshot kept as the user\'s trash row', trash.length === 1);
  const gone = await req(A, 'GET', `/api/aqua/conversations/${conv}`);
  check('S8', 'the other instance no longer serves it', gone.status === 404 || n(gone) === 0, `HTTP ${gone.status}`);

  // ── S13 account deletion ──
  out('\n=== S13 account deletion ===');
  const settings = await req(A, 'GET', '/account');
  const ad = await req(A, 'POST', '/api/account/delete', { body: { password: PASSWORD, _csrf: csrfOf(settings.text) } });
  await sleep(3000);
  const left = await q(`SELECT store_key, count(*)::int AS n FROM aqua_store_partitions WHERE owner_id = $1 AND data IS NOT NULL GROUP BY store_key`, [OWNER]);
  check('S13', 'account deletion accepted', ad.status < 300, `HTTP ${ad.status} ${ad.text.slice(0, 120)}`);
  check('S13', 'no live partition row of the user remains in any store', left.length === 0, JSON.stringify(left));
} catch (err) {
  check('run', 'journey completed without an exception', false, String(err?.stack ?? err).slice(0, 400));
} finally {
  for (const name of Object.keys(procs)) await kill(name);
  const result = { at: new Date().toISOString(), owner: OWNER, passed: checks.filter(c => c.ok && !c.informational).length, total: checks.filter(c => !c.informational).length, checks, logs: LOGDIR };
  out(`\nRESULT ${result.passed}/${result.total} checks passed · logs ${LOGDIR}`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  await db.end();
  process.exit(0);
}
