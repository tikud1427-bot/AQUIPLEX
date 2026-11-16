/**
 * Sprint 1 Task C — a failed startup can never overwrite a good backup
 * (2026-11-10; audit F-20).
 *
 * The failure being prevented: Mongo unreachable while a fresh Render instance
 * boots → hydration fails → stores load EMPTY → Mongo returns → the first flush
 * met a CAS conflict, preserved the live backup under conflict/… (pruned to 3)
 * and landed the empty store as live. These tests drive the real module with
 * an in-memory Mongo-shaped fake (CAS + duplicate-key semantics) and a real
 * temp data dir; the first one uses a REAL connection failure (a closed
 * localhost port, no external network).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../mongoMirror.js');

function mongoLike({ down = false } = {}) {
  const docs = new Map();
  const matches = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$exists' in v) return (d[k] !== undefined) === v.$exists;
    if (v && typeof v === 'object' && '$lt' in v) return d[k] < v.$lt;
    return d[k] === v;
  });
  const guard = () => { if (col.down) { const e = new Error('connection <monitor> to 10.0.0.1:27017 timed out'); e.name = 'MongoNetworkTimeoutError'; throw e; } };
  const col = {
    down, writes: [],
    find(q = {}) { return { toArray: async () => { guard(); return [...docs.values()].filter(d => matches(d, q)).map(d => ({ ...d })); } }; },
    async findOne(q = {}) { guard(); const d = [...docs.values()].find(x => matches(x, q)); return d ? { ...d } : null; },
    async updateOne(filter, update, opts = {}) {
      guard();
      const d = docs.get(filter._id);
      if (d && matches(d, filter)) { docs.set(filter._id, { ...d, ...update.$set }); col.writes.push(filter._id); return { matchedCount: 1 }; }
      if (!opts.upsert) return { matchedCount: 0 };
      if (d) { const e = new Error('E11000 duplicate key error'); e.code = 11000; throw e; }
      docs.set(filter._id, { _id: filter._id, ...update.$set }); col.writes.push(filter._id); return { upsertedCount: 1 };
    },
    async deleteMany(q = {}) { guard(); for (const [id, d] of docs) if (matches(d, q)) docs.delete(id); },
    seed(id, json, gen) { docs.set(id, { _id: id, json, gen, updatedAt: Date.now() - 60_000, chunked: false, parts: 0, writer: 'render:1:good' }); },
    get: id => docs.get(id),
    all: () => [...docs.values()],
  };
  return col;
}

const settle = async (rounds = 15) => {
  for (let i = 0; i < rounds; i++) { await mod.__settleForTests(); await new Promise(r => setTimeout(r, 5)); }
};
const tmpDir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `mirror-startup-${tag}-`));
const marker = dir => JSON.parse(fs.readFileSync(path.join(dir, '.mirror-sync.json'), 'utf8'));

// What every user's memory looks like in the backup — a large, valuable store.
const GOOD = JSON.stringify({ __aqua: { schema: 2 }, data: { 'user:a': { facts: { name: 'Ana' } }, 'user:b': { facts: { name: 'Ben' } } } });
const EMPTY = JSON.stringify({ __aqua: { schema: 2 }, data: {} });
const GEN = 1_700_000_000_000_001;

beforeEach(() => { mod.__resetForTests(); mod.__setRetryDelayForTests(1); });

test('Mongo unreachable at boot (real connection failure): unverified, marker written, nothing mirrored', async () => {
  const dir = tmpDir('down');
  const savedUri = process.env.MONGO_URI, savedDis = process.env.AQUA_DISABLE_MONGO_MIRROR;
  process.env.MONGO_URI = 'mongodb://127.0.0.1:9/aqua_unreachable_test';   // closed local port
  delete process.env.AQUA_DISABLE_MONGO_MIRROR;
  try {
    const r = await mod.hydrateFromMongo(dir);
    assert.equal(r.verified, false);
    assert.equal(r.status, 'unverified');
    const m = marker(dir);
    assert.ok(m.unverifiedSince > 0, 'the data dir remembers it started unverified');
    assert.equal(m.unverifiedReason, 'mongo-unreachable-at-boot');
    const s = mod.getMirrorStatus();
    assert.equal(s.durable, false);
    assert.match(s.verdict, /UNVERIFIED START/);
    assert.equal(s.sync.status, 'unverified');
  } finally {
    if (savedUri === undefined) delete process.env.MONGO_URI; else process.env.MONGO_URI = savedUri;
    if (savedDis !== undefined) process.env.AQUA_DISABLE_MONGO_MIRROR = savedDis;
  }
});

test('hydration that errors after connecting (cluster timing out) is unverified too', async () => {
  const dir = tmpDir('timeout');
  const col = mongoLike({ down: true });
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.status, 'unverified');
  assert.equal(marker(dir).unverifiedReason, 'hydration-failed');
});

test('THE INCIDENT: empty stores after an unverified start never replace the backup; the outage writes are preserved', async () => {
  const dir = tmpDir('incident');
  mod.__enterUnverifiedForTests(dir, 'mongo-unreachable-at-boot');   // fresh disk, Mongo was down
  const col = mongoLike();
  col.seed('.aqua-mind.json', GOOD, GEN);                            // the backup holds everyone's memory
  mod.__setCollectionForTests(col, { sync: 'unverified' });          // Mongo is reachable again

  mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), EMPTY);         // the empty in-memory store flushes
  mod.mirrorWrite(path.join(dir, '.aqua-brand-new.json'), '{"n":1}'); // a store the backup never had
  await settle();

  const live = col.get('.aqua-mind.json');
  assert.equal(live.json, GOOD, 'the live backup is untouched');
  assert.equal(live.gen, GEN, 'its generation did not move');
  const preserved = col.all().find(d => d.localRecovery && d.of === '.aqua-mind.json');
  assert.ok(preserved, 'the local copy is preserved beside it');
  assert.equal(preserved.json, EMPTY);
  assert.ok(String(preserved._id).startsWith('conflict/.aqua-mind.json/local-'));
  assert.equal(col.get('.aqua-brand-new.json')?.json, '{"n":1}', 'a store the backup does not have is valid data and mirrors normally');

  const s = mod.getMirrorStatus();
  assert.equal(s.sync.recoveryRequired, true);
  assert.match(s.verdict, /RECOVERY REQUIRED/);
  assert.deepEqual(s.sync.blocked.map(b => b.file), ['.aqua-mind.json']);

  // Later flushes keep refreshing the SAME preserved doc, never the live one.
  mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), '{"data":{"user:new":{}}}');
  await settle();
  assert.equal(col.get('.aqua-mind.json').json, GOOD);
  assert.equal(col.all().filter(d => d.localRecovery && d.of === '.aqua-mind.json').length, 1);
  assert.equal(col.get(preserved._id).json, '{"data":{"user:new":{}}}', 'newest outage-period state kept');
});

test('control: the same sequence WITHOUT the guard is what overwrote the backup', async () => {
  // The pre-Sprint-1 path, kept reachable for exactly this demonstration: a
  // "verified" start with no known generation reaches the CAS conflict branch.
  const col = mongoLike();
  col.seed('.aqua-mind.json', GOOD, GEN);
  mod.__setCollectionForTests(col, { sync: 'verified' });   // what the old code effectively assumed
  mod.mirrorWrite('/d/.aqua-mind.json', EMPTY);
  await settle();
  assert.equal(col.get('.aqua-mind.json').json, EMPTY, 'old behaviour: the empty store became live');
});

test('recovery with KNOWN lineage resumes normally (no false alarm)', async () => {
  const dir = tmpDir('lineage');
  const col = mongoLike();
  col.seed('.aqua-mind.json', GOOD, GEN);
  mod.__setCollectionForTests(col, { sync: 'pending' });
  await mod.hydrateFromMongo(dir);                                    // verified boot: lineage recorded
  assert.equal(marker(dir).files['.aqua-mind.json'].gen, GEN);
  // Restart on the SAME disk with Mongo down, then Mongo returns unchanged.
  mod.__resetForTests(); mod.__setRetryDelayForTests(1);
  mod.__enterUnverifiedForTests(dir);
  mod.__setCollectionForTests(col, { sync: 'unverified' });
  mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), '{"edited":"during outage, descends from GEN"}');
  await settle();
  assert.equal(col.get('.aqua-mind.json').json, '{"edited":"during outage, descends from GEN"}');
  const s = mod.getMirrorStatus();
  assert.equal(s.sync.recoveryRequired, false);
  assert.equal(s.sync.status, 'verified');
  assert.equal(marker(dir).unverifiedSince, null, 'unverified state cleared');
});

test('next boot after recovery-required: the backup is restored and the local copy preserved first', async () => {
  const dir = tmpDir('nextboot');
  mod.__enterUnverifiedForTests(dir);
  fs.writeFileSync(path.join(dir, '.aqua-mind.json'), EMPTY);          // what the outage boot left on disk
  const later = Date.now() + 5_000;
  fs.utimesSync(path.join(dir, '.aqua-mind.json'), later / 1000, later / 1000);   // NEWER than the backup
  mod.__resetForTests();
  const col = mongoLike();
  col.seed('.aqua-mind.json', GOOD, GEN);
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.verified, true);
  assert.equal(r.preserved, 1);
  assert.equal(fs.readFileSync(path.join(dir, '.aqua-mind.json'), 'utf8'), GOOD, 'the backup wins despite the newer mtime');
  assert.ok(col.all().some(d => d.localRecovery && d.json === EMPTY), 'the local copy was preserved before being replaced');
  assert.equal(marker(dir).unverifiedSince, null);
  assert.equal(marker(dir).files['.aqua-mind.json'].gen, GEN);
});

test('valid empty vs missing: a successful hydration of an empty backup verifies, and new stores mirror', async () => {
  const dir = tmpDir('empty-ok');
  const col = mongoLike();
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.verified, true);
  mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), EMPTY);
  await settle();
  assert.equal(col.get('.aqua-mind.json')?.json, EMPTY, 'first deploy: an empty store is the truth and is backed up');
  assert.equal(marker(dir).files['.aqua-mind.json'].gen, col.get('.aqua-mind.json').gen);
});

test('interrupted initialization: a store that failed to restore is never mirrored; the next boot completes it', async () => {
  const dir = tmpDir('interrupted');
  const col = mongoLike();
  col.seed('.aqua-a.json', '{"a":1}', GEN);
  col.seed('.aqua-b.json', '{"b":1}', GEN + 1);
  // Restore of b fails mid-hydration: a directory occupies its temp-file path, so the write throws.
  const obstacle = path.join(dir, `..aqua-b.json.hydrate.${process.pid}`);
  fs.mkdirSync(obstacle);
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.restored, 1);
  assert.equal(r.blocked, 1);
  assert.equal(marker(dir).files['.aqua-a.json'].gen, GEN, 'progress recorded per file');
  assert.equal(marker(dir).files['.aqua-b.json'], undefined);
  mod.mirrorWrite(path.join(dir, '.aqua-b.json'), '{}');
  await settle();
  assert.equal(col.get('.aqua-b.json').json, '{"b":1}', 'the store this boot could not load is not overwritten');
  // Next boot, obstacle gone.
  fs.rmdirSync(obstacle);
  mod.__resetForTests(); mod.__setCollectionForTests(col, { sync: 'pending' });
  const r2 = await mod.hydrateFromMongo(dir);
  assert.equal(r2.blocked, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.aqua-b.json'), 'utf8'), '{"b":1}');
  assert.equal(fs.readFileSync(path.join(dir, '.aqua-a.json'), 'utf8'), '{"a":1}');
});

test('a torn remote chunk set blocks the file: the local copy is kept and never mirrored over it', async () => {
  const dir = tmpDir('torn');
  const col = mongoLike();
  await col.updateOne({ _id: '.aqua-big.json' }, { $set: { chunked: true, parts: 3, gen: GEN, updatedAt: Date.now() } }, { upsert: true });
  await col.updateOne({ _id: '.aqua-big.json::part' + GEN + ':0' }, { $set: { part: true, of: '.aqua-big.json', i: 0, gen: GEN, json: '{"x":' } }, { upsert: true });
  mod.__setCollectionForTests(col, { sync: 'pending' });
  await mod.hydrateFromMongo(dir);
  mod.mirrorWrite(path.join(dir, '.aqua-big.json'), '{}');
  await settle();
  assert.equal(col.get('.aqua-big.json').gen, GEN, 'manifest untouched');
  assert.equal(mod.getMirrorStatus().sync.blocked[0].reason, 'remote-chunk-set-incomplete');
});

test('preserved local-recovery copies are exempt from conflict pruning', async () => {
  const col = mongoLike();
  await col.updateOne({ _id: 'conflict/.aqua-mind.json/local-x' }, { $set: { conflict: true, localRecovery: true, of: '.aqua-mind.json', json: EMPTY, preservedAt: 1 } }, { upsert: true });
  mod.__setCollectionForTests(col);
  // Four foreign-writer conflicts would prune everything beyond the newest 3.
  for (let i = 0; i < 4; i++) {
    col.seed('.aqua-mind.json', `{"foreign":${i}}`, GEN + 10 + i);
    mod.mirrorWrite('/d/.aqua-mind.json', `{"ours":${i}}`);
    await settle();
  }
  assert.ok(col.get('conflict/.aqua-mind.json/local-x'), 'the outage copy survived pruning');
  assert.ok(col.all().filter(d => d.conflict && !d.localRecovery && d.of === '.aqua-mind.json').length <= 3);
});

test('recovery logging names stores, never their contents', async () => {
  const dir = tmpDir('logs');
  const lines = [];
  const ow = console.warn, ol = console.log;
  console.warn = (...a) => lines.push(a.join(' ')); console.log = (...a) => lines.push(a.join(' '));
  try {
    mod.__enterUnverifiedForTests(dir);
    const col = mongoLike();
    col.seed('.aqua-mind.json', GOOD, GEN);
    mod.__setCollectionForTests(col, { sync: 'unverified' });
    mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), '{"data":{"user:z":{"facts":{"name":"Zorblaxian"}}}}');
    await settle();
  } finally { console.warn = ow; console.log = ol; }
  assert.ok(lines.some(l => /RECOVERY REQUIRED/.test(l)), lines.join('\n'));
  assert.ok(!lines.some(l => /Zorblaxian|Ana|Ben/.test(l)), 'no store content in mirror logs');
});
