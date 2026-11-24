/**
 * 2026-11-24 production data recovery — Phase E regression tests (audit/recovery).
 *
 * What happened in production, and what each block below proves cannot recur:
 *   · 2026-11-16: an instance whose hydration failed served EMPTY stores and its
 *     first chat turn replaced six live stores (history, Mind, ledger, ids,
 *     reasoning graph, cognition). → "THE 2026-11-16 SEQUENCE" (Sprint 1 guard,
 *     re-proved end to end for the six-store write set).
 *   · 2026-11-18..23: unverified processes served users from empty stores. →
 *     store gate.
 *   · Remaining paths found by the audit: a restored store that fails to parse
 *     starts empty and silently replaces its backup (R-A3); nothing stops an
 *     empty payload replacing a large backup (R-A4); count pruning could delete
 *     the only pre-loss copy (R-A2); a READER wrote into the shared mirror (R-A1).
 * Real module, real temp data dirs, an in-memory Mongo-shaped fake with CAS and
 * duplicate-key semantics (same fake as mongoMirrorStartup.test.js).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../mongoMirror.js');
const { loadJsonFile } = await import('../atomicStore.js');
const { storeGateReason, storeGateMiddleware } = await import('../storeGate.js');

function mongoLike({ down = false } = {}) {
  const docs = new Map();
  const matches = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$exists' in v) return (d[k] !== undefined) === v.$exists;
    if (v && typeof v === 'object' && '$lt' in v) return d[k] < v.$lt;
    return d[k] === v;
  });
  const col = {
    down, writes: [], failFindOneAfter: Infinity, findOnes: 0,
    find(q = {}) { return { toArray: async () => { if (col.down) throw new Error('timed out'); return [...docs.values()].filter(d => matches(d, q)).map(d => ({ ...d })); } }; },
    async findOne(q = {}) {
      if (col.down || ++col.findOnes > col.failFindOneAfter) throw Object.assign(new Error('connection reset'), { name: 'MongoNetworkError' });
      const d = [...docs.values()].find(x => matches(x, q)); return d ? { ...d } : null;
    },
    async updateOne(filter, update, opts = {}) {
      if (col.down) throw new Error('timed out');
      const d = docs.get(filter._id);
      if (d && matches(d, filter)) { docs.set(filter._id, { ...d, ...update.$set }); col.writes.push(filter._id); return { matchedCount: 1 }; }
      if (!opts.upsert) return { matchedCount: 0 };
      if (d) { const e = new Error('E11000 duplicate key error'); e.code = 11000; throw e; }
      docs.set(filter._id, { _id: filter._id, ...update.$set }); col.writes.push(filter._id); return { upsertedCount: 1 };
    },
    async deleteMany(q = {}) { for (const [id, d] of docs) if (matches(d, q)) { docs.delete(id); col.writes.push(`delete:${id}`); } },
    seed(id, json, gen) { docs.set(id, { _id: id, json, gen, updatedAt: Date.now() - 60_000, chunked: false, parts: 0, writer: 'render:1:good' }); },
    put(doc) { docs.set(doc._id, { ...doc }); },
    get: id => docs.get(id),
    all: () => [...docs.values()],
  };
  return col;
}

const settle = async (rounds = 15) => { for (let i = 0; i < rounds; i++) { await mod.__settleForTests(); await new Promise(r => setTimeout(r, 5)); } };
const tmpDir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `mirror-recovery-${tag}-`));
const GEN = 1_700_000_000_000_001;
/** A store worth losing: ~120 KB of distinct owners. */
const BIG = JSON.stringify({ __aqua: { schema: 1 }, data: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`user:${i}`, { facts: { note: 'x'.repeat(260) + i } }])) });
const EMPTY = JSON.stringify({ __aqua: { schema: 1 }, data: {} });

const savedEnv = { ...process.env };
beforeEach(() => { mod.__resetForTests(); mod.__setRetryDelayForTests(1); });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

async function verifiedBoot(col, dir) {
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.verified, true);
  return r;
}

// ── 1/2/4. Failed or partial hydration never authorizes writes ───────────────

test('THE 2026-11-16 SEQUENCE: hydration fails, all six chat-turn stores flush empty, none replaces its backup', async () => {
  const dir = tmpDir('six');
  const SIX = ['.aqua-history.json', '.aqua-mind.json', '.aqua-ledger.json', '.aqua-ids.json', '.aqua-reasoning-graph.json', '.aqua-cognition.json'];
  const col = mongoLike({ down: true });
  SIX.forEach((f, i) => col.seed(f, BIG, GEN + i));
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);                       // cluster times out mid-boot
  assert.equal(r.status, 'unverified');
  col.down = false;                                                 // …and answers again
  for (const f of SIX) mod.mirrorWrite(path.join(dir, f), EMPTY);   // one chat turn on empty stores
  await settle();
  for (const [i, f] of SIX.entries()) {
    assert.equal(col.get(f).json, BIG, `${f}: backup untouched`);
    assert.equal(col.get(f).gen, GEN + i, `${f}: generation did not move`);
  }
  assert.equal(mod.getMirrorStatus().sync.recoveryRequired, true);
});

test('a read failure part-way through hydration (listing ok, a body read fails) is unverified, never "empty"', async () => {
  const dir = tmpDir('partial');
  const col = mongoLike();
  col.seed('.aqua-a.json', BIG, GEN);
  col.seed('.aqua-mind.json', BIG, GEN + 1);
  col.failFindOneAfter = 1;                                         // first body read ok, the second throws
  mod.__setCollectionForTests(col, { sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.verified, false);
  assert.equal(r.status, 'unverified');
  col.failFindOneAfter = Infinity;
  mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), EMPTY);
  await settle();
  assert.equal(col.get('.aqua-mind.json').json, BIG);
});

// ── 3. Empty local state cannot replace non-empty remote state (shrink guard) ─

test('shrink guard: a near-empty payload over a large verified backup is REFUSED and preserved, the file blocked', async () => {
  const dir = tmpDir('refuse');
  const col = mongoLike();
  col.seed('.aqua-history.json', BIG, GEN);
  await verifiedBoot(col, dir);
  mod.mirrorWrite(path.join(dir, '.aqua-history.json'), EMPTY);
  await settle();
  assert.equal(col.get('.aqua-history.json').json, BIG, 'backup untouched');
  assert.equal(col.get('.aqua-history.json').gen, GEN);
  const kept = col.all().find(d => d.localRecovery && d.of === '.aqua-history.json');
  assert.equal(kept?.json, EMPTY, 'the refused payload is kept, not dropped');
  const s = mod.getMirrorStatus();
  assert.equal(s.shrinkGuard.refused, 1);
  assert.deepEqual(s.sync.blocked.map(b => [b.file, b.reason]), [['.aqua-history.json', 'shrink-refused']]);
  assert.match(s.verdict, /RECOVERY REQUIRED/);
});

test('shrink guard: a large but plausible shrink preserves the previous generation (protected) before landing', async () => {
  const dir = tmpDir('preserve');
  const col = mongoLike();
  col.seed('.aqua-mind.json', BIG, GEN);
  await verifiedBoot(col, dir);
  const smaller = BIG.slice(0, Math.floor(BIG.length * 0.3)) ;     // 30 %: not refused, but preserved first
  mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), smaller);
  await settle();
  assert.equal(col.get('.aqua-mind.json').json, smaller, 'the write lands');
  const prev = col.all().find(d => d.conflict && d.protected && d.of === '.aqua-mind.json');
  assert.equal(prev?.json, BIG, 'the previous generation is preserved');
  assert.equal(prev.reason, 'shrink');
  assert.equal(mod.getMirrorStatus().shrinkGuard.preserved, 1);
});

test('shrink guard: small stores and normal growth are untouched; AQUA_MIRROR_SHRINK_GUARD=off is the rollback', async () => {
  const dir = tmpDir('normal');
  const col = mongoLike();
  col.seed('.aqua-small.json', '{"a":"' + 'y'.repeat(2000) + '"}', GEN);   // below the 64 KB floor
  col.seed('.aqua-mind.json', BIG, GEN + 1);
  await verifiedBoot(col, dir);
  mod.mirrorWrite(path.join(dir, '.aqua-small.json'), '{}');
  mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), BIG + ' ');
  await settle();
  assert.equal(col.get('.aqua-small.json').json, '{}');
  assert.equal(col.get('.aqua-mind.json').json, BIG + ' ');
  process.env.AQUA_MIRROR_SHRINK_GUARD = 'off';
  mod.mirrorWrite(path.join(dir, '.aqua-mind.json'), EMPTY);
  await settle();
  assert.equal(col.get('.aqua-mind.json').json, EMPTY, 'guard off: unconditional (documented rollback)');
});

// ── R-A3. A restored store that fails to parse never overwrites its backup ────

test('a restored store that fails to parse is blocked; its fallback flushes never replace the backup', async () => {
  const dir = tmpDir('corrupt');
  const col = mongoLike();
  col.seed('.aqua-history.json', BIG, GEN);
  await verifiedBoot(col, dir);
  const file = path.join(dir, '.aqua-history.json');
  fs.writeFileSync(file, '{"data": {"torn');                       // disk corruption after restore
  const quiet = console.error; console.error = () => {};
  let parsed;
  try { parsed = loadJsonFile(file, { label: 'history' }); } finally { console.error = quiet; }
  assert.equal(parsed, null, 'no .bak on a fresh disk: the store would start empty');
  assert.equal(mod.getMirrorStatus().sync.blocked[0]?.reason, 'restored-store-unparseable');
  process.env.AQUA_MIRROR_SHRINK_GUARD = 'off';                    // prove the BLOCK, not the shrink guard, protects it
  mod.mirrorWrite(file, EMPTY);
  await settle();
  assert.equal(col.get('.aqua-history.json').json, BIG);
});

test('blockMirrorFile ignores files the mirror never restored (a corrupt local-only file does not stop the app)', () => {
  assert.equal(mod.blockMirrorFile('/x/.aqua-history-trash.json', 'restored-store-unparseable'), false);
  assert.equal(mod.getMirrorStatus().sync.recoveryRequired, false);
});

// ── 11. Pruning cannot remove the only recoverable copy ──────────────────────

test('prunableCopies: never the largest, never larger than live, never unknown size, never protected/local', () => {
  const d = (id, bytes, at, extra = {}) => ({ _id: id, bytes, preservedAt: at, ...extra });
  const docs = [d('a', 100, 9), d('b', 100, 8), d('c', 100, 7), d('d', 100, 6), d('pre-loss', 5_000, 1),
    d('nosize', undefined, 2), d('p', 10, 3, { protected: true }), d('l', 10, 4, { localRecovery: true }), d('e', 100, 5)];
  const ids = mod.prunableCopies(docs, 200).map(x => x._id).sort();
  assert.deepEqual(ids, ['d', 'e'], 'only ordinary copies beyond the newest 3 that hold no more than live');
  assert.ok(!mod.prunableCopies(docs, null).some(x => x._id === 'pre-loss'), 'the largest is kept even when live size is unknown');
});

test('the 2026-11-16 pre-loss copy survives any number of later deploy-overlap conflicts', async () => {
  const dir = tmpDir('prune');
  const col = mongoLike();
  col.put({ _id: 'conflict/.aqua-history.json/1794644118559006', conflict: true, of: '.aqua-history.json', gen: 1, json: BIG, preservedAt: 1 });
  col.seed('.aqua-history.json', '{"small":0}', GEN);
  await verifiedBoot(col, dir);
  for (let i = 1; i <= 6; i++) {
    col.seed('.aqua-history.json', `{"foreign":${i}}`, GEN + 10 + i);   // another writer moved it
    mod.mirrorWrite(path.join(dir, '.aqua-history.json'), `{"ours":${i}}`);
    await settle();
  }
  assert.equal(col.get('conflict/.aqua-history.json/1794644118559006')?.json, BIG, 'pre-loss copy kept');
  assert.ok(col.all().filter(x => x.conflict && x.of === '.aqua-history.json').length <= 5, 'ordinary copies still capped');
});

// ── R-A1. A reader never writes the shared mirror, even during hydration ─────

test('a READER with an unknown-lineage local file keeps it on its own disk and writes NOTHING to the mirror', async () => {
  const dir = tmpDir('reader');
  fs.writeFileSync(path.join(dir, '.mirror-sync.json'), JSON.stringify({ version: 1, files: {} }));   // a marker with no lineage for the file
  fs.writeFileSync(path.join(dir, '.aqua-mind.json'), '{"laptop":"local"}');
  const later = Date.now() + 5_000;
  fs.utimesSync(path.join(dir, '.aqua-mind.json'), later / 1000, later / 1000);
  const col = mongoLike();
  col.seed('.aqua-mind.json', BIG, GEN);
  mod.__setCollectionForTests(col, { role: 'reader', sync: 'pending' });
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.verified, true);
  assert.deepEqual(col.writes, [], 'no document written by a reader');
  assert.equal(fs.readFileSync(path.join(dir, '.aqua-mind.json'), 'utf8'), BIG, 'the backup is restored');
  const aside = fs.readdirSync(dir).find(f => f.startsWith('.aqua-mind.json.local-'));
  assert.ok(aside, 'the local copy is kept beside it on the reader\'s disk');
  assert.equal(fs.readFileSync(path.join(dir, aside), 'utf8'), '{"laptop":"local"}');
});

// ── 10. Synchronization is idempotent ───────────────────────────────────────

test('hydrating the same data dir twice restores once and then keeps; no mirror writes', async () => {
  const dir = tmpDir('idem');
  const col = mongoLike();
  col.seed('.aqua-history.json', BIG, GEN);
  col.seed('.aqua-mind.json', BIG, GEN + 1);
  mod.__setCollectionForTests(col, { role: 'reader', sync: 'pending' });
  const a = await mod.hydrateFromMongo(dir);
  mod.__resetForTests(); mod.__setCollectionForTests(col, { role: 'reader', sync: 'pending' });
  const b = await mod.hydrateFromMongo(dir);
  assert.equal(a.restored, 2);
  assert.equal(b.restored + b.kept, 2);
  assert.equal(b.preserved, 0);
  assert.deepEqual(col.writes, []);
});

// ── 9. Startup cannot expose an unverified / recovery-required store ─────────

test('store gate: unverified or recovery-required → 503 STORE_NOT_VERIFIED; provider-health stays open; off = rollback', () => {
  const st = (status, recoveryRequired = false, enabled = true) => ({ enabled, sync: { status, recoveryRequired } });
  assert.equal(storeGateReason(st('unverified')), 'unverified');
  assert.equal(storeGateReason(st('verified', true)), 'recovery-required');
  assert.equal(storeGateReason(st('verified')), null);
  assert.equal(storeGateReason(st('unverified', false, false)), null, 'no mirror configured: nothing to verify');

  const run = (p, status) => {
    let code = 200, body = null, nexted = false;
    const res = { set() {}, status(c) { code = c; return this; }, json(b) { body = b; return this; } };
    storeGateMiddleware({ statusFn: () => status })({ path: p }, res, () => { nexted = true; });
    return { code, body, nexted };
  };
  const bad = st('unverified');
  assert.equal(run('/chat', bad).code, 503);
  assert.equal(run('/chat', bad).body.code, 'STORE_NOT_VERIFIED');
  assert.equal(run('/understanding/intro/state', bad).code, 503, 'the onboarding gate is never answered from empty stores');
  assert.equal(run('/provider-health', bad).nexted, true);
  assert.equal(run('/v1/provider-health/metrics', bad).nexted, true);
  assert.equal(run('/chat', st('verified')).nexted, true);
  process.env.AQUA_STORE_GATE = 'off';
  assert.equal(run('/chat', bad).nexted, true);
});
