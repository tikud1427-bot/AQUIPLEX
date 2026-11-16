/**
 * Phase 4A — conversation-history migration tooling, end to end.
 *
 * A production-SHAPED history (synthetic: production is never read) goes
 * through the operator CLI (scripts/history-migration.mjs) against a FRESH
 * disposable database created for this run (and dropped after):
 * inventory → plan (dry run) → apply → verify → export → rollback-check,
 * plus the file ⇄ mirror ⇄ local-recovery-copy comparison, deleted-account
 * exclusion, and an interrupted apply re-run.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = Boolean(process.env.DATABASE_URL);
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.resolve(HERE, '..', '..', '..');
const CLI = path.join(AQUA, 'scripts', 'history-migration.mjs');
const RUN = Date.now().toString(36);
const DBNAME = `aqua_p4a_mig_${RUN}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-histmig-'));
let DB = null;
let admin = null;

// ── a production-shaped history ──────────────────────────────────────────────
const users = ['64f0a1', '64f0a2', '64f0a3'].map(s => `${s}${RUN}`);
const msg = (role, content, ts, mid = null) => ({ role, content, ts, ...(mid ? { mid } : {}) });
function fixture() {
  const data = {};
  let ts = 1_700_000_000_000;
  users.forEach((u, ui) => {
    for (let c = 0; c < 3; c++) {
      const id = `conv-${ui}-${c}-${RUN}`;
      const messages = [];
      for (let i = 0; i < 4 + c; i++) messages.push(msg(i % 2 ? 'assistant' : 'user', `u${ui} c${c} m${i}`, ts += 1000, c === 2 ? `1-${(ts).toString(36)}-0000-ab${ui}${c}${i}` : null));
      data[id] = { messages, meta: { userId: u, createdAt: ts - 9000, updatedAt: ts, title: `t${c}` } };
    }
  });
  // pre-login (anonymous) conversation
  data[`anon-${RUN}`] = { messages: [msg('user', 'hello before login', ts += 1000)], meta: { createdAt: ts } };
  // legacy array-form conversation
  data[`legacy-${RUN}`] = [msg('user', 'very old format', ts += 1000), msg('assistant', 'reply', ts += 1000)];
  // duplicate stable keys + a repeated identical message (a client retry)
  const dupMid = `1-dupkey${RUN}-0000-aaaa`;
  data[`dups-${RUN}`] = { messages: [msg('user', 'same', ts += 1000, dupMid), msg('user', 'same', ts, dupMid), msg('assistant', 'ok', ts += 1000)], meta: { userId: users[0] } };
  // malformed message, unknown user, deleted account
  data[`bad-${RUN}`] = { messages: [msg('user', 'fine', ts += 1000), { role: 'user' }], meta: { userId: users[1] } };
  data[`ghost-${RUN}`] = { messages: [msg('user', 'account not in the user list', ts += 1000)], meta: { userId: `deadbeef${RUN}` } };
  data[`gone-${RUN}`] = { messages: [msg('user', 'deleted account', ts += 1000)], meta: { userId: `deleted${RUN}` } };
  return { __aqua: { schema: 1, savedAt: ts }, data };
}

function chunkedExport(id, text, gen, extra = {}) {
  const size = 700;
  const parts = [];
  for (let i = 0; i * size < text.length; i++) parts.push({ _id: `${id}::part${gen}:${i}`, part: true, of: id, i, gen, json: text.slice(i * size, (i + 1) * size) });
  return [{ _id: id, chunked: true, parts: parts.length, gen, json: null, ...extra }, ...parts];
}

const run = (...args) => {
  try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: AQUA, env: { ...process.env, DATABASE_URL: '' } }).toString()) }; }
  catch (e) { return { code: e.status, out: (() => { try { return JSON.parse(String(e.stdout)); } catch { return { raw: String(e.stdout) + String(e.stderr) }; } })() }; }
};

describe('Phase 4A — conversation-history migration (fresh disposable database)', { skip, concurrency: false }, () => {
  let historyFile; let mirrorFile; let trashFile; let usersFile; let src;
  before(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${DBNAME}`);
    const u = new URL(process.env.DATABASE_URL); u.pathname = `/${DBNAME}`;
    DB = u.toString();
    src = fixture();
    const text = JSON.stringify(src);
    historyFile = path.join(dir, '.aqua-history.json'); fs.writeFileSync(historyFile, text);
    // The mirror is AHEAD of the file by one conversation (written after the file's last save),
    // and holds a local-recovery copy with a conversation found nowhere else.
    const ahead = JSON.parse(text); ahead.data[`mirror-only-${RUN}`] = { messages: [msg('user', 'only in the mirror', 1)], meta: { userId: users[2] } };
    const recovery = { __aqua: { schema: 1 }, data: { [`recovered-${RUN}`]: { messages: [msg('user', 'written while the mirror was down', 2)], meta: { userId: users[1] } } } };
    const docs = [...chunkedExport('.aqua-history.json', JSON.stringify(ahead), 7),
      { _id: `conflict/.aqua-history.json/local-recovery-host1`, conflict: true, localRecovery: true, chunked: false, parts: 0, json: JSON.stringify(recovery) },
      { _id: 'some-other-store.json', chunked: false, json: '{}' }];
    mirrorFile = path.join(dir, 'aqua_kv.jsonl'); fs.writeFileSync(mirrorFile, docs.map(d => JSON.stringify(d)).join('\n'));
    trashFile = path.join(dir, '.aqua-history-trash.json');
    fs.writeFileSync(trashFile, JSON.stringify([{ id: `trashed-${RUN}`, deletedAt: 5, messages: [msg('user', 'deleted chat', 3)], meta: { userId: users[0] } },
      { id: `conv-0-0-${RUN}`, deletedAt: 6, ...src.data[`conv-0-0-${RUN}`] }]));
    usersFile = path.join(dir, 'users.txt'); fs.writeFileSync(usersFile, [...users, `deleted${RUN}`].join('\n'));
  });
  after(async () => {
    try { await admin?.query(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`); } finally { await admin?.end(); }
  });

  test('inventory: counts by owner and storage type, missing owners, duplicates, malformed records', () => {
    const { code, out } = run('inventory', '--history', historyFile, '--users', usersFile, '--trash', trashFile);
    assert.equal(code, 0, JSON.stringify(out).slice(0, 500));
    const inv = out.inventory;
    assert.equal(inv.conversations, 9 + 6);
    assert.equal(inv.storage.legacyArrayConversations, 1);
    assert.ok(inv.storage.messagesWithStableKey > 0 && inv.storage.messagesPositional > 0);
    assert.equal(inv.missingOwner.anonymousConversations, 2, 'pre-login + legacy array conversation have no user');
    assert.equal(inv.missingOwner.unknownUserIds, 1);
    assert.equal(inv.duplicates.duplicateMessageKeys, 1);
    assert.equal(inv.duplicates.repeatedIdenticalMessages, 1);
    assert.equal(inv.malformed.messages, 1);
    assert.equal(inv.owners.users, 5);
    assert.ok(inv.byOwner.every(o => /^[0-9a-f]{16}$/.test(o.owner)), 'owners are hashed in reports');
    assert.equal(out.trash.snapshots, 2);
    assert.equal(out.trash.alsoLive, 1, 'a conversation both live and in the trash');
    assert.ok(!JSON.stringify(out).includes('only in the mirror') && !JSON.stringify(out).includes('very old format'), 'no content in the report');
  });

  test('sources: file ⇄ mirror ⇄ local-recovery copy differences are found, and a union is offered, never applied silently', () => {
    const union = path.join(dir, 'union.json');
    const { code, out } = run('inventory', '--history', historyFile, '--mirror-export', mirrorFile, '--union', '--out', union);
    assert.equal(code, 0, JSON.stringify(out).slice(0, 500));
    assert.equal(out.mirror.live, true);
    assert.equal(out.mirror.localRecoveryCopies, 1);
    assert.equal(out.sourceComparison.onlyIn.mirror, 1, 'the conversation only the mirror has');
    assert.equal(out.sourceComparison.onlyIn['conflict-0-local-recovery'], 1, 'the conversation only the recovery copy has');
    const u = JSON.parse(fs.readFileSync(union, 'utf8')).data;
    assert.ok(u[`mirror-only-${RUN}`] && u[`recovered-${RUN}`] && u[`conv-1-1-${RUN}`]);
  });

  test('plan: a dry run writes nothing', async () => {
    const { code, out } = run('plan', '--db', DB, '--history', historyFile);
    assert.equal(code, 0, JSON.stringify(out).slice(0, 500));
    assert.ok(out.dryRun.wouldInsert > 0);
    assert.equal(out.dryRun.inserted, 0);
    const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: DB }); await c.connect();
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM aqua_store_partitions`); await c.end();
    assert.equal(rows[0].n, 0);
  });

  test('apply (deleted accounts excluded) → verify: every conversation preserved; an interrupted re-run inserts nothing twice', async () => {
    const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: DB }); await c.connect();
    await c.query(`INSERT INTO aqua_deleted_owners (owner_id) VALUES ($1) ON CONFLICT DO NOTHING`, [`user:deleted${RUN}`]);
    await c.end();
    const a = run('apply', '--db', DB, '--history', historyFile, '--trash', trashFile, '--exclude-deleted');
    assert.equal(a.code, 0, JSON.stringify(a.out).slice(0, 600));
    assert.ok(a.out.apply.inserted > 0 && a.out.apply.conflicting === 0);
    const again = run('apply', '--db', DB, '--history', historyFile, '--exclude-deleted');
    assert.equal(again.out.apply.inserted, 0, 'a re-run must insert nothing (idempotent)');
    assert.equal(again.out.apply.identical, a.out.apply.inserted);
    const v = run('verify', '--db', DB, '--history', historyFile, '--exclude-deleted');
    assert.equal(v.code, 0, JSON.stringify(v.out).slice(0, 600));
    assert.equal(v.out.verify.preserved, 14);
    assert.equal(v.out.verify.excluded, 1, 'the deleted account\'s conversation was not migrated');
    assert.equal(v.out.verify.messages.source, v.out.verify.messages.partitions);
    assert.equal(v.out.reconcile.clean, true, JSON.stringify(v.out.reconcile).slice(0, 400));
  });

  test('export + rollback-check: the store rebuilt from the partitions restores every conversation', () => {
    const out = path.join(dir, 'rollback.json');
    const e = run('export', '--db', DB, '--out', out);
    assert.equal(e.code, 0, JSON.stringify(e.out).slice(0, 400));
    assert.equal(e.out.export.conversations, 14);
    const r = run('rollback-check', '--db', DB, '--history', historyFile, '--exclude-deleted');
    assert.equal(r.code, 0);
    assert.deepEqual([r.out.rollback.conversationsRestorable, r.out.rollback.missing, r.out.rollback.changed], [14, 0, 0]);
  });

  test('verify detects a lost or altered message', async () => {
    const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: DB }); await c.connect();
    await c.query(`UPDATE aqua_store_partitions SET data = NULL, deleted_at = now() WHERE partition_key LIKE $1`, [`m:conv-2-1-${RUN}:0-000002`]);
    await c.end();
    const v = run('verify', '--db', DB, '--history', historyFile, '--exclude-deleted');
    assert.equal(v.code, 1);
    assert.equal(v.out.verify.changed, 1);
    assert.equal(v.out.verify.messageCountDiffers, 1);
  });

  test('a non-local database is refused', () => {
    const r = run('plan', '--db', 'postgresql://u:p@db.example.com:5432/x', '--history', historyFile);
    assert.equal(r.code, 2);
  });
});
