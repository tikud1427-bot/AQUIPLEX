/**
 * Bounded-memory hydration (2026-11-24 — audit/render-heap-oom).
 *
 * Production crash-looped with "Reached heap limit" ~20 s after boot: the old
 * hydration loaded the ENTIRE aqua_kv collection (live stores, every chunk part
 * of every generation, every preserved conflict copy) with find({}).toArray().
 * These tests drive the real module with a Mongo-shaped fake that honours
 * filters and the { json: 0 } projection and RECORDS every body it hands out,
 * so "bounded" is asserted structurally: no listing ever carries a body, at
 * most one body is fetched per call, and bodies of conflict copies / superseded
 * generations are never fetched at all. Every existing guarantee (generation
 * tracking, lineage, incomplete-chunk blocking, newer-wins, atomic rename) is
 * re-checked on the new path.
 */
process.env.AQUA_MIRROR_CHUNK_BYTES = '40';   // CHUNK_CHARS = 10 → small stores take the chunked path

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../mongoMirror.js');

function mongoLike() {
  const docs = new Map();
  const bodyCalls = [];            // { op, ids: [...] } for every call that returned json bodies
  const matches = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$exists' in v) return (d[k] !== undefined) === v.$exists;
    if (v && typeof v === 'object' && '$lt' in v) return d[k] < v.$lt;
    return d[k] === v;
  });
  const project = (d, opts) => {
    const out = { ...d };
    if (opts?.projection?.json === 0) delete out.json;
    return out;
  };
  const note = (op, list) => {
    const withBody = list.filter(d => typeof d?.json === 'string' && d.json.length > 0);
    if (withBody.length) bodyCalls.push({ op, ids: withBody.map(d => String(d._id)) });
  };
  const col = {
    down: false, failOnFindOne: null, bodyCalls,
    find(q = {}, opts) {
      return { toArray: async () => {
        if (col.down) throw new Error('connection timed out');
        const out = [...docs.values()].filter(d => matches(d, q)).map(d => project(d, opts));
        note('find', out);
        return out;
      } };
    },
    async findOne(q = {}, opts) {
      if (col.down) throw new Error('connection timed out');
      if (col.failOnFindOne && col.failOnFindOne(q)) throw new Error('connection reset mid-hydration');
      const d = [...docs.values()].find(x => matches(x, q));
      const out = d ? project(d, opts) : null;
      if (out) note('findOne', [out]);
      return out;
    },
    async updateOne(filter, update, opts = {}) {
      const d = docs.get(filter._id);
      if (d && matches(d, filter)) { docs.set(filter._id, { ...d, ...update.$set }); return { matchedCount: 1 }; }
      if (!opts.upsert) return { matchedCount: 0 };
      if (d) { const e = new Error('E11000 duplicate key error'); e.code = 11000; throw e; }
      docs.set(filter._id, { _id: filter._id, ...update.$set });
      return { upsertedCount: 1 };
    },
    async deleteMany(q = {}) { for (const [id, d] of docs) if (matches(d, q)) docs.delete(id); },
    put(doc) { docs.set(doc._id, doc); },
    get: id => docs.get(id),
    all: () => [...docs.values()],
  };
  return col;
}

const CHARS = 10;
const OLD = Date.now() - 3_600_000;
let genSeq = 1_700_000_000_000_000;
const gen = () => ++genSeq;

/** Seed a store exactly as mongoMirror writes it (chunked when longer than CHARS). */
function seedStore(col, filename, json, { updatedAt = OLD, reverse = false, asConflict = false } = {}) {
  const g = gen();
  if (json.length <= CHARS) {
    const body = { json, updatedAt, chunked: false, parts: 0, gen: g, writer: 'render:1:good' };
    col.put(asConflict ? { _id: `conflict/${filename}/${g}`, conflict: true, of: filename, ...body, preservedAt: updatedAt } : { _id: filename, ...body });
    return g;
  }
  const parts = [];
  for (let i = 0; i * CHARS < json.length; i++) parts.push({ _id: `${filename}::part${g}:${i}`, part: true, of: filename, i, gen: g, json: json.slice(i * CHARS, (i + 1) * CHARS) });
  for (const p of reverse ? parts.reverse() : parts) col.put(p);
  const man = { chunked: true, parts: parts.length, gen: g, updatedAt, bytes: Buffer.byteLength(json), json: null, writer: 'render:1:good' };
  col.put(asConflict ? { _id: `conflict/${filename}/${g}`, conflict: true, of: filename, ...man, preservedAt: updatedAt } : { _id: filename, ...man });
  return g;
}

const tmpDir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `mirror-bounded-${tag}-`));
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const leftovers = dir => fs.readdirSync(dir).filter(f => f.includes('.hydrate.'));
const settle = async () => { for (let i = 0; i < 10; i++) { await mod.__settleForTests(); await new Promise(r => setTimeout(r, 5)); } };

/** The structural memory bound. */
function assertBounded(col) {
  for (const c of col.bodyCalls) {
    assert.equal(c.op, 'findOne', `bodies may only arrive one document at a time; a ${c.op} listing returned ${c.ids.length}`);
    assert.equal(c.ids.length, 1);
  }
}

beforeEach(() => { mod.__resetForTests(); mod.__setRetryDelayForTests(1); });

test('1 · empty mirror: verified, nothing restored, nothing fetched', async () => {
  const col = mongoLike();
  col.put({ _id: '.aqua-mirror-canary', json: 'nonce', updatedAt: OLD });
  col.put({ _id: '.aqua-mirror-writer', instanceId: 'x:1:a', ts: 0 });
  mod.__setCollectionForTests(col, { role: 'reader', sync: 'pending' });
  const dir = tmpDir('empty');
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.verified, true);
  assert.equal(r.restored, 0);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('.aqua-')), []);
  assert.deepEqual(col.bodyCalls, [], 'not even the canary body is read');
});

test('2 · normal unchunked stores restore byte-exact; their generation becomes the CAS base', async () => {
  const col = mongoLike();
  const g = seedStore(col, '.aqua-mind.json', '{"a":1}');
  seedStore(col, '.aqua-ids.json', '{"b":"—"}');
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const dir = tmpDir('plain');
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.restored, 2);
  assert.equal(read(dir, '.aqua-mind.json'), '{"a":1}');
  assert.equal(read(dir, '.aqua-ids.json'), '{"b":"—"}');
  assertBounded(col);
  // The next write lands on the hydrated generation without a conflict.
  mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), '{"a":2}');
  await settle();
  assert.equal(col.get('.aqua-mind.json').json, '{"a":2}');
  assert.ok(col.get('.aqua-mind.json').gen !== g);
  assert.equal(col.all().filter(d => d.conflict).length, 0, 'no false write conflict');
});

test('3 · a large chunked store streams to disk byte-exact, one part per fetch', async () => {
  const col = mongoLike();
  const json = JSON.stringify({ text: 'x'.repeat(200) + '—नमस्ते✓'.repeat(20) });
  seedStore(col, '.aqua-index.json', json);
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const dir = tmpDir('chunked');
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.restored, 1);
  assert.equal(read(dir, '.aqua-index.json'), json);
  assertBounded(col);
  assert.ok(col.bodyCalls.length >= Math.ceil(json.length / CHARS), 'every part fetched individually');
  assert.deepEqual(leftovers(dir), []);
});

test('3b · an emoji cut by a chunk boundary is written whole and restored byte-exact', async () => {
  // Writer side: the part boundary must not split a surrogate pair (BSON would store U+FFFD).
  const col = mongoLike();
  mod.__setCollectionForTests(col);
  const json = '{"t":"abc😀xyz' + '—'.repeat(30) + '"}';   // 😀 occupies chars 9-10: across the 10-char boundary
  assert.equal(json.charCodeAt(9), 0xD83D);
  mod.mirrorWrite('/x/.aqua-emoji.json', json);
  await settle();
  for (const p of col.all().filter(d => d.part)) {
    const last = p.json.charCodeAt(p.json.length - 1);
    assert.ok(!(last >= 0xD800 && last <= 0xDBFF), `part ${p.i} ends on half a surrogate pair`);
    assert.ok(p.json.length <= CHARS);
  }
  // Reader side: a fresh boot restores it exactly.
  mod.__resetForTests();
  mod.__setCollectionForTests(col, { role: 'reader', sync: 'pending' });
  const dir = tmpDir('emoji');
  await mod.hydrateFromMongo(dir);
  assert.equal(read(dir, '.aqua-emoji.json'), json);
});

test('3c · hydration of legacy parts already cut mid-pair writes the halves together', async () => {
  // A part ending on a high surrogate (written by the old writer into a store that keeps
  // UTF-16 strings) is carried into the next part before encoding, never encoded alone.
  const col = mongoLike();
  const json = '{"t":"abc😀xyz"}';
  seedStore(col, '.aqua-legacy.json', json);   // naive 10-char slicing → the pair is split
  assert.equal(col.get(`.aqua-legacy.json::part${genSeq}:0`).json.charCodeAt(9), 0xD83D);
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const dir = tmpDir('legacy-split');
  await mod.hydrateFromMongo(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.aqua-legacy.json')).equals(Buffer.from(json, 'utf8')), true);
});

test('4 · multiple chunked stores, each restored from its own generation', async () => {
  const col = mongoLike();
  const a = 'A'.repeat(55) + '"—"';
  const b = 'B'.repeat(73);
  seedStore(col, '.aqua-index.json', a);
  seedStore(col, '.aqua-vectors.json', b);
  seedStore(col, '.aqua-mind.json', '{}');
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const dir = tmpDir('multi');
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.restored, 3);
  assert.equal(read(dir, '.aqua-index.json'), a);
  assert.equal(read(dir, '.aqua-vectors.json'), b);
  assert.equal(read(dir, '.aqua-mind.json'), '{}');
  assertBounded(col);
});

test('5 · preserved conflict generations and superseded parts are never restored — and never even read', async () => {
  const col = mongoLike();
  // Two preserved conflict copies (one chunked, one not) and an orphaned superseded generation.
  seedStore(col, '.aqua-index.json', 'OLD-CONFLICT-CHUNKED-' + 'c'.repeat(40), { asConflict: true });
  seedStore(col, '.aqua-index.json', 'conflict!', { asConflict: true });
  const orphanGen = gen();
  for (let i = 0; i < 5; i++) col.put({ _id: `.aqua-index.json::part${orphanGen}:${i}`, part: true, of: '.aqua-index.json', i, gen: orphanGen, json: 'ORPHANxxxx' });
  col.put({ _id: 'conflict/.aqua-mind.json/local-x:1:a', conflict: true, localRecovery: true, of: '.aqua-mind.json', json: '{"outage":1}', chunked: false, parts: 0 });
  const live = 'LIVE-' + 'l'.repeat(37);
  seedStore(col, '.aqua-index.json', live);
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const dir = tmpDir('conflicts');
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.total, 1, 'only the live store is a mirrored file');
  assert.equal(read(dir, '.aqua-index.json'), live);
  assert.equal(fs.existsSync(path.join(dir, '.aqua-mind.json')), false, 'a preserved local-recovery copy is not a live store');
  assertBounded(col);
  const fetched = col.bodyCalls.flatMap(c => c.ids);
  assert.ok(fetched.every(id => !id.startsWith('conflict/')), 'no conflict body fetched');
  assert.ok(fetched.every(id => !id.includes(`part${orphanGen}:`)), 'no superseded part fetched');
  // Nothing was deleted: conflict copies and the orphaned generation are all still there.
  assert.equal(col.all().filter(d => d.conflict).length, 3);
  assert.equal(col.all().filter(d => d.gen === orphanGen).length, 5);
});

test('6 · a missing chunk blocks the file: local copy kept, no temp left, never mirrored over the backup', async () => {
  const col = mongoLike();
  const g = seedStore(col, '.aqua-index.json', 'R'.repeat(35));
  col.all().filter(d => d.part && d.i === 2).forEach(d => col.deleteMany({ _id: d._id }));
  const dir = tmpDir('missing');
  fs.writeFileSync(path.join(dir, '.aqua-index.json'), 'LOCAL');
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.blocked, 1);
  assert.equal(read(dir, '.aqua-index.json'), 'LOCAL');
  assert.deepEqual(leftovers(dir), []);
  assert.equal(mod.__syncForTests().blocked.get('.aqua-index.json').reason, 'remote-chunk-set-incomplete');
  mod.mirrorWrite(path.join(dir, '.aqua-index.json'), 'LOCAL-2');
  await settle();
  assert.equal(col.get('.aqua-index.json').gen, g, 'the backup manifest is untouched');
  assert.equal(col.get('.aqua-index.json').json, null);
});

test('7 · out-of-order chunks (inserted in reverse) restore in index order', async () => {
  const col = mongoLike();
  const json = '0123456789abcdefghijABCDEFGHIJ—';
  seedStore(col, '.aqua-index.json', json, { reverse: true });
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const dir = tmpDir('order');
  await mod.hydrateFromMongo(dir);
  assert.equal(read(dir, '.aqua-index.json'), json);
});

test('8 · corrupted manifests block (or skip) the file — never restore a torn store', async () => {
  const col = mongoLike();
  // (a) manifest claims more parts than exist
  const ga = seedStore(col, '.aqua-a.json', 'a'.repeat(25));
  col.put({ ...col.get('.aqua-a.json'), parts: 9 });
  // (b) a part whose body is not a string
  seedStore(col, '.aqua-b.json', 'b'.repeat(25));
  const pb = col.all().find(d => d.part && d.of === '.aqua-b.json' && d.i === 1);
  col.put({ ...pb, json: null });
  // (c) manifest generation with no parts at all
  col.put({ _id: '.aqua-c.json', chunked: true, parts: 2, gen: 42, updatedAt: OLD, json: null });
  // (d) an extra index (gap): parts 0,1,3 for a 3-part manifest
  seedStore(col, '.aqua-d.json', 'd'.repeat(25));
  const pd = col.all().find(d => d.part && d.of === '.aqua-d.json' && d.i === 2);
  col.deleteMany({ _id: pd._id });
  col.put({ ...pd, _id: pd._id.replace(/:2$/, ':3'), i: 3 });
  // (e) unchunked doc whose body is not a string → skipped, as before
  col.put({ _id: '.aqua-e.json', chunked: false, parts: 0, gen: gen(), updatedAt: OLD, json: 12 });
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const dir = tmpDir('corrupt');
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.restored, 0);
  const blocked = mod.__syncForTests().blocked;
  for (const f of ['.aqua-a.json', '.aqua-b.json', '.aqua-c.json', '.aqua-d.json']) {
    assert.equal(blocked.get(f)?.reason, 'remote-chunk-set-incomplete', f);
    assert.equal(fs.existsSync(path.join(dir, f)), false, `${f} not restored`);
  }
  assert.equal(blocked.has('.aqua-e.json'), false);
  assert.equal(fs.existsSync(path.join(dir, '.aqua-e.json')), false);
  assert.deepEqual(leftovers(dir), []);
  assert.equal(mod.__syncForTests().status, 'verified', 'the backup state is known; torn files stay blocked');
  void ga;
});

test('9 · local newer than remote (pre-marker data dir): local kept, not overwritten', async () => {
  const col = mongoLike();
  seedStore(col, '.aqua-index.json', 'REMOTE-' + 'r'.repeat(30), { updatedAt: OLD });
  const dir = tmpDir('local-newer');
  fs.writeFileSync(path.join(dir, '.aqua-index.json'), 'LOCAL-NEWER');
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.kept, 1);
  assert.equal(read(dir, '.aqua-index.json'), 'LOCAL-NEWER');
  assert.deepEqual(leftovers(dir), [], 'the staged remote copy is discarded');
});

test('10 · remote newer than local: the backup is restored', async () => {
  const col = mongoLike();
  const dir = tmpDir('remote-newer');
  fs.writeFileSync(path.join(dir, '.aqua-index.json'), 'LOCAL-OLD');
  const past = new Date(Date.now() - 7_200_000);
  fs.utimesSync(path.join(dir, '.aqua-index.json'), past, past);
  const remote = 'REMOTE-' + 'r'.repeat(30);
  seedStore(col, '.aqua-index.json', remote, { updatedAt: Date.now() - 60_000 });
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.restored, 1);
  assert.equal(read(dir, '.aqua-index.json'), remote);
});

test('11 · Mongo failing during the listing: unverified, nothing written, nothing mirrored', async () => {
  const col = mongoLike();
  seedStore(col, '.aqua-mind.json', '{"a":1}');
  col.down = true;
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const dir = tmpDir('down');
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.verified, false);
  assert.equal(mod.__syncForTests().status, 'unverified');
  assert.equal(fs.existsSync(path.join(dir, '.aqua-mind.json')), false);
});

test('12 · interrupted hydration: a connection lost mid-stream leaves no torn file; the next boot cleans up and completes', async () => {
  const col = mongoLike();
  const json = 'S'.repeat(45) + '—';
  seedStore(col, '.aqua-index.json', json);
  seedStore(col, '.aqua-mind.json', '{"m":1}');
  const dir = tmpDir('interrupted');
  // A temp file a previous killed process left behind.
  fs.writeFileSync(path.join(dir, '..aqua-index.json.hydrate.99999'), 'half a store');
  col.failOnFindOne = q => String(q._id ?? '').includes('::part') && String(q._id).endsWith(':3');
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r1 = await mod.hydrateFromMongo(dir);
  assert.equal(r1.verified, false, 'a failure mid-hydration is an unverified start');
  assert.equal(fs.existsSync(path.join(dir, '.aqua-index.json')), false, 'no torn store renamed into place');
  // Next boot.
  col.failOnFindOne = null;
  mod.__resetForTests();
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r2 = await mod.hydrateFromMongo(dir);
  assert.equal(r2.verified, true);
  assert.equal(read(dir, '.aqua-index.json'), json);
  assert.equal(read(dir, '.aqua-mind.json'), '{"m":1}');
  assert.deepEqual(leftovers(dir), [], 'stale temp files from killed hydrations are removed');
});

test('13 · repeated startup on the same disk is idempotent', async () => {
  const col = mongoLike();
  const json = 'T'.repeat(33);
  seedStore(col, '.aqua-index.json', json);
  seedStore(col, '.aqua-mind.json', '{"m":1}');
  const dir = tmpDir('repeat');
  for (let boot = 0; boot < 3; boot++) {
    mod.__resetForTests();
    mod.__setCollectionForTests(col, { sync: 'pending' });
    const r = await mod.hydrateFromMongo(dir);
    assert.equal(r.verified, true);
    assert.equal(r.restored + r.kept, 2, `boot ${boot}`);
    assert.equal(r.preserved, 0, 'lineage is known after the first boot: nothing is "preserved"');
    assert.equal(read(dir, '.aqua-index.json'), json);
  }
  assert.equal(col.all().filter(d => d.conflict).length, 0);
});

test('14 · a generation superseded during hydration is followed (deploy overlap), not reported torn', async () => {
  const col = mongoLike();
  seedStore(col, '.aqua-index.json', 'G1-' + 'x'.repeat(30));
  const newer = 'G2-' + 'y'.repeat(40);
  let swapped = false;
  col.failOnFindOne = q => {
    // The first part fetch races a writer: it lands G2 and GCs G1's parts.
    if (!swapped && String(q._id ?? '').includes('::part')) {
      swapped = true;
      const old = col.get('.aqua-index.json').gen;
      seedStore(col, '.aqua-index.json', newer, { updatedAt: Date.now() - 1000 });
      col.all().filter(d => d.part && d.gen === old).forEach(d => col.deleteMany({ _id: d._id }));
    }
    return false;
  };
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const dir = tmpDir('race');
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.blocked, 0);
  assert.equal(read(dir, '.aqua-index.json'), newer);
});

test('15 · post-boot housekeeping reads conflict metadata only, never conflict bodies', async () => {
  const col = mongoLike();
  // Single-doc conflict copies carry their whole body (up to CHUNK_BYTES each in production).
  seedStore(col, '.aqua-index.json', 'cbody-1', { asConflict: true });
  seedStore(col, '.aqua-index.json', 'cbody-2', { asConflict: true });
  seedStore(col, '.aqua-index.json', 'chunked-conflict-' + 'z'.repeat(20), { asConflict: true });
  mod.__setCollectionForTests(col);
  col.bodyCalls.length = 0;
  mod.mirrorWrite('/x/.aqua-index.json', 'W'.repeat(60));   // > CHUNK_BYTES: chunked write → GC check + (no) prune
  await settle();
  assert.deepEqual(col.bodyCalls, [], 'a chunked write does not load preserved bodies');
});
