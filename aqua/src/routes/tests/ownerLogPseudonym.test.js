/**
 * PWI Phase 1, fix 3 (2026-11-15) — [RECALL] / [PIC] / [SENSITIVE] log lines
 * name the owner by a stable, non-reversible pseudonym, never the raw id.
 *
 *   ownerLogId: format, determinism, owner/key separation, domain separation
 *   from shortHash, the per-process fallback (p_) and its one-time warning
 *   STABLE ACROSS PROCESSES with the same key (what makes correlation across
 *   instances, restarts and the API/worker split possible) — child processes
 *   the support script computes exactly what the services log
 *   source guard: no tagged line in src prints `owner=${…}` without ownerLogId
 *   a real /chat/stream turn: the three tags carry o_…, the raw id appears nowhere
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-owner-pseudonym-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';
delete process.env.DATABASE_URL;
delete process.env.AQUA_LOG_CONTENT;
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|_KEY_\d+|_KEYS)$|^OPENROUTER|^GROQ|^GEMINI|^NVIDIA|^OPENAI|^TAVILY|^SERPER|^BRAVE|^EXA/i.test(k)) delete process.env[k];
}
process.env.GROQ_API_KEY_1 = 'gsk_test_fake_key_for_owner_pseudonym_01';
const KEY = 'test-pseudonym-key-0123456789abcdef-0123456789';   // ≥ 32 chars
process.env.AQUA_LOG_PSEUDONYM_KEY = KEY;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.resolve(HERE, '..', '..', '..');
const LOG_SAFETY_URL = pathToFileURL(path.join(AQUA, 'src', 'core', 'logSafety.js')).href;

const { ownerLogId, _resetOwnerLogIdForTests } = await import('../../core/logSafety.js');

/** ownerLogId computed in a FRESH node process (another instance / a restart). */
function inChild(ownerId, env) {
  const code = `import(${JSON.stringify(LOG_SAFETY_URL)}).then(m => process.stdout.write(m.ownerLogId(${JSON.stringify(ownerId)})))`;
  return execFileSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: 'utf8' }).trim();
}

// ── the pseudonym ────────────────────────────────────────────────────────────

test('format: o_ + 16 hex with a stable key; never contains the id or the account id', () => {
  const id = ownerLogId('user:65f0c0ffee1234567890abcd');
  assert.match(id, /^o_[0-9a-f]{16}$/);
  assert.ok(!id.includes('65f0c0ffee'), 'leaks the account id');
  assert.ok(!id.includes('user'), 'leaks the owner prefix');
});

test('deterministic and owner-separated; null/empty owner → "none"', () => {
  assert.equal(ownerLogId('user:a'), ownerLogId('user:a'));
  assert.notEqual(ownerLogId('user:a'), ownerLogId('user:b'));
  assert.notEqual(ownerLogId('user:a'), ownerLogId('conv:a'));
  assert.equal(ownerLogId(null), 'none');
  assert.equal(ownerLogId(''), 'none');
});

test('key-separated: another key gives another pseudonym (rotation / environments do not collide)', () => {
  const env2 = { AQUA_LOG_PSEUDONYM_KEY: `${KEY}-other` };
  assert.notEqual(ownerLogId('user:a'), ownerLogId('user:a', env2));
  assert.match(ownerLogId('user:a', env2), /^o_[0-9a-f]{16}$/);
});

test('domain-separated: not the plain HMAC (or SHA-256) of the id under the same key', async () => {
  const crypto = await import('node:crypto');
  const id = 'user:a';
  const plain = crypto.createHmac('sha256', KEY).update(id).digest('hex').slice(0, 16);
  const sha = crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
  assert.notEqual(ownerLogId(id), `o_${plain}`);
  assert.notEqual(ownerLogId(id), `o_${sha}`);
});

test('STABLE ACROSS PROCESSES with the same key — the property that makes correlation possible', () => {
  const here = ownerLogId('user:cross-instance');
  assert.equal(inChild('user:cross-instance', { AQUA_LOG_PSEUDONYM_KEY: KEY }), here);
  assert.equal(inChild('user:cross-instance', { AQUA_LOG_PSEUDONYM_KEY: KEY }), here);
});

test('no key / short key: p_ per-process pseudonym (raw id still never logged), differs across processes, warned once', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  _resetOwnerLogIdForTests();
  try {
    const a = ownerLogId('user:a', {});
    assert.match(a, /^p_[0-9a-f]{16}$/);
    assert.equal(ownerLogId('user:a', {}), a, 'stable within the process');
    assert.match(ownerLogId('user:a', { AQUA_LOG_PSEUDONYM_KEY: 'short' }), /^p_/);
    assert.equal(warns.filter(w => w.includes('AQUA_LOG_PSEUDONYM_KEY')).length, 1, 'warned exactly once');
    assert.ok(!warns.join(' ').includes('user:a'));
  } finally { console.warn = orig; _resetOwnerLogIdForTests(); }
  const c1 = inChild('user:a', {});
  const c2 = inChild('user:a', {});
  assert.match(c1, /^p_/);
  assert.notEqual(c1, c2, 'per-process keys must differ — the p_ prefix tells the reader');
});

test('support script prints exactly what the services log, and refuses without a stable key', () => {
  const script = path.join(AQUA, 'scripts', 'owner-log-id.mjs');
  const out = execFileSync(process.execPath, [script, 'user:a', 'user:b'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AQUA_LOG_PSEUDONYM_KEY: KEY }, encoding: 'utf8' });
  assert.deepEqual(out.trim().split(/\r?\n/), [ownerLogId('user:a'), ownerLogId('user:b')]);
  assert.throws(() => execFileSync(process.execPath, [script, 'user:a'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdio: 'pipe' }),
    e => e.status === 2);
});

// ── source guard ─────────────────────────────────────────────────────────────

test('source guard: no [RECALL]/[PIC]/[SENSITIVE] line in src prints an owner without ownerLogId', () => {
  const offenders = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(m?js|cjs)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (!/console\.(log|warn|error|info)\(`\[(RECALL|PIC|SENSITIVE)\]/.test(line)) return;
        for (const m of line.matchAll(/owner=\$\{([^}]*)\}/g)) {
          if (!/^ownerLogId\(/.test(m[1].trim())) offenders.push(`${path.relative(AQUA, p)}:${i + 1} owner=\${${m[1]}}`);
        }
      });
    }
  };
  walk(path.join(AQUA, 'src'));
  assert.deepEqual(offenders, []);
});

// ── a real turn ──────────────────────────────────────────────────────────────

const Q = await import('../../providers/groq.js');
Q.__setClientFactoryForTests(() => ({ chat: { completions: { create: async body => {
  const text = 'Here is a helpful, general answer.';
  if (body.stream) return (async function* () { yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] }; })();
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 6 } };
} } } }));
const { default: chatRoute } = await import('../chat.js');

const ACCOUNT = 'acct7d3e9b21pseudo';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = ACCOUNT; next(); });
app.use('/chat', chatRoute);

async function captureDuring(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c, ...r) => { lines.push(String(c)); return true; };
  try { await fn(); await new Promise(r => setTimeout(r, 200)); }
  finally { Object.assign(console, orig); process.stderr.write = origErr; }
  return lines;
}

test('a real /chat/stream turn: [RECALL], [PIC] and [SENSITIVE] carry the pseudonym; the account id is in no tagged line', async t => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (message, conversationId) => {
    const r = await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, conversationId }) });
    await r.text();
    assert.equal(r.status, 200);
  };
  await send('I work at Northbeam as a product engineer.', 'c-pseudo-1');
  const lines = await captureDuring(() => send('My therapist says my anxiety is improving. Where do I work?', 'c-pseudo-2'));
  const tagged = lines.filter(l => /\[(RECALL|PIC|SENSITIVE)\]/.test(l));
  const expected = ownerLogId(`user:${ACCOUNT}`);
  for (const tag of ['RECALL', 'PIC', 'SENSITIVE']) {
    assert.ok(tagged.some(l => l.includes(`[${tag}]`) && l.includes(`owner=${expected}`)), `[${tag}] line with owner=${expected} — got:\n${tagged.join('\n')}`);
  }
  const leaks = tagged.filter(l => l.includes(ACCOUNT));
  assert.deepEqual(leaks, [], 'raw account id in a tagged line');
});
