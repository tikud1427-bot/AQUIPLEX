/**
 * Bounded hydration against a REAL MongoDB (2026-11-24 — audit/render-heap-oom).
 *
 * The fake in mongoMirrorBoundedHydration.test.js proves the access pattern;
 * this proves it on the real driver: the { json: 0 } projection and the
 * { part: { $exists: false } } listing behave as assumed, chunked stores with
 * multi-byte text and an emoji on a part boundary round-trip byte-exact through
 * BSON, preserved conflicts and superseded generations are neither restored
 * nor deleted, and concurrent/repeated hydration opens ONE connection (so one
 * heartbeat timer).
 *
 * SKIPPED unless MIRROR_DISPOSABLE_MONGO_URI is set. Safety rails:
 *   · only mongodb:// on 127.0.0.1 / localhost (no +srv, no remote cluster)
 *   · database name must match aqua_disposable_*
 *   · refuses to run if the database already holds collections
 *   · only synthetic content is written; the database is dropped afterwards
 *
 *   MIRROR_DISPOSABLE_MONGO_URI="mongodb://127.0.0.1:57017/aqua_disposable_mirror" \
 *     node scripts/run-tests.mjs src/core/tests/mongoMirrorHydration.mongo.live.test.js
 */
process.env.AQUA_MIRROR_CHUNK_BYTES = '4096';    // CHUNK_CHARS = 1024 → many parts from small stores

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URI = process.env.MIRROR_DISPOSABLE_MONGO_URI || '';
function refusal(uri) {
  if (!uri) return 'MIRROR_DISPOSABLE_MONGO_URI not set (no disposable local MongoDB)';
  let u;
  try { u = new URL(uri); } catch { return 'MIRROR_DISPOSABLE_MONGO_URI is not a URL'; }
  if (u.protocol !== 'mongodb:') return 'only mongodb:// (no +srv / remote clusters)';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return `refusing non-local host ${u.hostname}`;
  if (!/^aqua_disposable_[a-z0-9_]+$/.test(u.pathname.replace(/^\//, ''))) return 'database name must match aqua_disposable_*';
  return null;
}
const SKIP = refusal(URI);

describe('mirror hydration against a disposable local MongoDB', { skip: SKIP ?? false }, () => {
  let mongoose, conn, col, mod;
  const tmp = tag => fs.mkdtempSync(path.join(os.tmpdir(), `mirror-live-${tag}-`));

  before(async () => {
    mongoose = (await import('mongoose')).default;
    conn = await mongoose.createConnection(URI, { serverSelectionTimeoutMS: 3000 }).asPromise();
    const existing = await conn.db.listCollections().toArray();
    if (existing.length) throw new Error(`refusing: disposable database is not empty (${existing.length} collections)`);
    col = conn.db.collection('aqua_kv');
    process.env.MONGO_URI = URI;              // the module's own connect() targets the disposable database
    delete process.env.AQUA_DISABLE_MONGO_MIRROR;
    delete process.env.RENDER;
    process.env.AQUA_MIRROR_ROLE = 'writer';  // seeding goes through the real write path
    mod = await import('../mongoMirror.js');
  });
  after(async () => {
    try { await conn?.db.dropDatabase(); } finally {
      mod?.__resetForTests();
      for (const c of mongoose?.connections ?? []) await c.close().catch(() => {});
    }
  });

  // Multi-byte text, with an emoji placed exactly across the 1024-char part boundary.
  const head = '{"t":"';
  const bigA = head + 'x'.repeat(1024 - head.length - 1) + '😀' + '—नमस्ते✓ '.repeat(900) + '"}';
  const bigB = JSON.stringify({ v: Array.from({ length: 400 }, (_, i) => `entry ${i} — ünïcödé`) });
  const small = JSON.stringify({ mind: { name: 'fixture' } });

  test('writes through the real write path, then a fresh boot restores every store byte-exact', async () => {
    assert.equal(bigA.charCodeAt(1023), 0xD83D, 'fixture: the emoji straddles the first part boundary');
    // Write each store several times: superseded generations + the live one.
    mod.__resetForTests();
    const seedDir = tmp('seed');
    await mod.hydrateFromMongo(seedDir);                 // connects (writer), verifies an empty backup
    for (const round of [1, 2, 3]) {
      mod.mirrorWrite(path.join(seedDir, '.aqua-a.json'), round === 3 ? bigA : bigA.replace('x', String(round)));
      mod.mirrorWrite(path.join(seedDir, '.aqua-b.json'), bigB);
      mod.mirrorWrite(path.join(seedDir, '.aqua-mind.json'), small);
      for (let i = 0; i < 20 && (await mod.__settleForTests()).length; i++) await new Promise(r => setTimeout(r, 20));
      await new Promise(r => setTimeout(r, 50));
      await mod.__settleForTests();
    }
    const parts = await col.countDocuments({ part: true, of: '.aqua-a.json' });
    assert.ok(parts >= 5, `chunked on the real path (${parts} parts; superseded generations GC'd)`);

    // Fresh instance, fresh disk.
    mod.__resetForTests();
    const dir = tmp('boot');
    const r = await mod.hydrateFromMongo(dir);
    assert.equal(r.verified, true);
    assert.equal(r.restored, 3);
    assert.ok(fs.readFileSync(path.join(dir, '.aqua-a.json')).equals(Buffer.from(bigA, 'utf8')), '.aqua-a.json byte-exact (emoji intact)');
    assert.ok(fs.readFileSync(path.join(dir, '.aqua-b.json')).equals(Buffer.from(bigB, 'utf8')), '.aqua-b.json byte-exact');
    assert.equal(fs.readFileSync(path.join(dir, '.aqua-mind.json'), 'utf8'), small);
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('.hydrate.')), []);
  });

  test('preserved conflicts and orphaned generations: excluded from the listing, not restored, not deleted', async () => {
    // A preserved conflict copy and a superseded generation whose manifest is gone.
    await col.insertOne({ _id: 'conflict/.aqua-a.json/1', conflict: true, of: '.aqua-a.json', gen: 1, chunked: false, parts: 0, json: '{"OLD":"CONFLICT"}', preservedAt: 1 });
    await col.insertMany([0, 1, 2].map(i => ({ _id: `.aqua-a.json::part7:${i}`, part: true, of: '.aqua-a.json', i, gen: 7, json: 'ORPHAN' })));
    const listed = await col.find({ part: { $exists: false } }, { projection: { json: 0 } }).toArray();
    assert.ok(listed.every(d => !d.part && d.json === undefined), 'the real driver honours the listing filter and projection');

    const before = await col.countDocuments({});
    mod.__resetForTests();
    const dir = tmp('conflict');
    const r = await mod.hydrateFromMongo(dir);
    assert.equal(r.total, 3);
    assert.ok(fs.readFileSync(path.join(dir, '.aqua-a.json')).equals(Buffer.from(bigA, 'utf8')));
    assert.equal(await col.countDocuments({}), before + 0, 'hydration deletes nothing');
    assert.equal(await col.countDocuments({ _id: 'conflict/.aqua-a.json/1' }), 1);
    assert.equal(await col.countDocuments({ gen: 7, part: true }), 3);
  });

  test('concurrent and repeated hydration share ONE connection (one heartbeat)', async () => {
    mod.__resetForTests();
    const n0 = mongoose.connections.length;
    const dir = tmp('repeat');
    const [r1, r2] = await Promise.all([mod.hydrateFromMongo(dir), mod.hydrateFromMongo(tmp('repeat2'))]);
    const r3 = await mod.hydrateFromMongo(dir);
    assert.ok(r1.verified && r2.verified && r3.verified);
    assert.equal(mongoose.connections.length - n0, 1, 'connect() is single-flight; the heartbeat starts with it, once');
    assert.equal(r3.restored, 0, 'the same disk on a repeat boot: nothing re-restored');
    assert.equal(r3.kept, 3);
  });
});
