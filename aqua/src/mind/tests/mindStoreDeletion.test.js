/**
 * Deletions must hold across the two processes that share .aqua-mind.json
 * (audit 2026-10-12).
 *
 * The flush merge (mindStoreTwoProcess.test.js) unions both processes'
 * versions of an owner, and a union cannot tell "deleted here" from "never
 * seen here". So a fact the user deleted came back:
 *   · server side — its next flush re-added the key from the worker's older
 *     disk copy (`!mine` → take disk);
 *   · worker side — the worker's next flush wrote its stale in-memory copy back.
 * A whole deleted owner came back the same way: its `deleted` mark lived only
 * in the deleting process. And facts were compared by `ts` (first stored), not
 * `updatedAt`, so a correction could lose to the uncorrected copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-mind-del-'));
process.env.AQUA_DATA_DIR = DIR;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
const MIND = await import('../mindStore.js');
const LTM  = await import('../../memory/longTermMemory.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_URL = pathToFileURL(path.resolve(HERE, '../mindStore.js')).href;
const FILE = path.join(DIR, '.aqua-mind.json');

const fact = (value, ts, updatedAt = ts) => ({ key: 'k', value, ts, updatedAt, confidence: 0.9 });
const both = (owner) => ({ dirtyOwners: new Set([owner]), deletedOwners: new Map(), base: new Map([[owner, 100]]) });
const flushed = () => new Promise(r => setTimeout(r, 1000));   // debounce (500ms) + async write
const onDisk = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

// ── the pure merge ───────────────────────────────────────────────────────────

test('server side: a fact deleted here is NOT re-added from the other process\'s older copy', () => {
  const ours = { ownerId: 'user:a', updatedAt: 300, facts: {}, tombstones: { facts: { city: 250 } } };
  const disk = { ownerId: 'user:a', updatedAt: 260, facts: { city: fact('Lisbon', 100) }, beliefs: { 'p:x': { updatedAt: 260 } } };
  MIND.mergeForFlush(new Map([['user:a', ours]]), { 'user:a': disk }, both('user:a'));
  assert.equal(ours.facts.city, undefined, 'deleted fact resurrected');
  assert.ok(ours.beliefs['p:x'], 'the rest of the other process\'s change still merges');
});

test('worker side: a deletion made by the other process removes our stale copy', () => {
  const ours = { ownerId: 'user:a', updatedAt: 300, facts: { city: fact('Lisbon', 100), name: fact('Maya', 100) }, beliefs: { 'p:y': { updatedAt: 300 } } };
  const disk = { ownerId: 'user:a', updatedAt: 260, facts: { name: fact('Maya', 100) }, tombstones: { facts: { city: 250 } } };
  MIND.mergeForFlush(new Map([['user:a', ours]]), { 'user:a': disk }, both('user:a'));
  assert.equal(ours.facts.city, undefined, 'stale copy would be written back');
  assert.equal(ours.facts.name.value, 'Maya');
  assert.equal(ours.tombstones.facts.city, 250, 'the tombstone travels on');
});

test('saying it again after the deletion brings it back (only older copies are suppressed)', () => {
  const ours = { ownerId: 'user:a', updatedAt: 300, facts: {}, tombstones: { facts: { city: 250 } } };
  const disk = { ownerId: 'user:a', updatedAt: 280, facts: { city: fact('Porto', 280) } };
  MIND.mergeForFlush(new Map([['user:a', ours]]), { 'user:a': disk }, both('user:a'));
  assert.equal(ours.facts.city?.value, 'Porto');
});

test('a correction (same ts, newer updatedAt) beats the uncorrected copy, in either direction', () => {
  const corrected = fact('Porto', 100, 300);
  const stale = fact('Lisbon', 100, 100);
  const a = { ownerId: 'user:a', updatedAt: 300, facts: { city: { ...corrected } } };
  MIND.mergeForFlush(new Map([['user:a', a]]), { 'user:a': { ownerId: 'user:a', updatedAt: 260, facts: { city: { ...stale } } } }, both('user:a'));
  assert.equal(a.facts.city.value, 'Porto', 'stale copy overwrote the correction');
  const b = { ownerId: 'user:a', updatedAt: 300, facts: { city: { ...stale } } };
  MIND.mergeForFlush(new Map([['user:a', b]]), { 'user:a': { ownerId: 'user:a', updatedAt: 260, facts: { city: { ...corrected } } } }, both('user:a'));
  assert.equal(b.facts.city.value, 'Porto', 'the other process\'s correction was dropped (ts tie kept ours)');
});

test('owner deletion: older copies on either side are dropped; a recreated (newer) owner survives', () => {
  const stale = { ownerId: 'user:gone', updatedAt: 100, facts: { city: fact('Lisbon', 100) } };
  const memory = new Map([['user:gone', stale]]);
  MIND.mergeForFlush(memory, { 'user:gone': { ...stale } }, { dirtyOwners: new Set(), deletedOwners: new Map([['user:gone', 200]]), base: new Map() });
  assert.equal(memory.has('user:gone'), false);
  const reborn = new Map([['user:gone', { ownerId: 'user:gone', updatedAt: 300, facts: {} }]]);
  MIND.mergeForFlush(reborn, {}, { dirtyOwners: new Set(), deletedOwners: new Map([['user:gone', 200]]), base: new Map() });
  assert.equal(reborn.has('user:gone'), true);
});

// ── real second process ──────────────────────────────────────────────────────

/** Child = the worker: loads the file, says LOADED, waits for GO, then runs `body` and flushes. */
function startWorker(body) {
  const go = path.join(DIR, `go-${Math.random().toString(36).slice(2)}`);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const M = await import(${JSON.stringify(STORE_URL)});
    M.listOwners();   // loaded at boot, like the worker
    console.log('LOADED');
    const fs = await import('node:fs');
    while (!fs.existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 50));
    ${body}
    await new Promise(r => setTimeout(r, 1000));
    console.log('DONE');
  `], { env: { ...process.env, AQUA_DATA_DIR: DIR, AQUA_DISABLE_MONGO_MIRROR: '1' } });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const until = (word) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => out.includes(word) ? resolve() : (Date.now() - t0 > 20_000 ? reject(new Error(`worker never said ${word}: ${err}`)) : setTimeout(tick, 50));
    tick();
  });
  const exited = new Promise(r => child.on('exit', r));
  return { until, go: () => fs.writeFileSync(go, '1'), exited };
}

test('REAL two processes: a fact deleted by the server stays deleted after the worker (which still held it) flushes', async () => {
  const owner = 'user:lena';
  const m = MIND.getMind(owner);
  m.facts.city = { key: 'city', value: 'Leeds', ts: Date.now(), updatedAt: Date.now(), confidence: 0.9 };
  m.facts.client = { key: 'client', value: 'Juniper Hotel', ts: Date.now(), updatedAt: Date.now(), confidence: 0.9 };
  MIND.touchMind(m);
  await flushed();

  // The worker loads the file while the fact is still there…
  const w = startWorker(`
    const mind = M.getMind('user:lena');
    mind.beliefs = { ...(mind.beliefs ?? {}), 'pref:short': { updatedAt: Date.now(), createdAt: Date.now() } };
    M.touchMind(mind);   // a reflection job's write: the worker's copy still has city=Leeds
  `);
  await w.until('LOADED');

  // …the user deletes it on the server…
  assert.equal(LTM.deleteFact(owner, 'city'), true);
  await flushed();
  assert.equal(onDisk().data[owner].facts.city, undefined, 'precondition: the deletion landed');

  // …then the worker flushes its stale copy, and the server flushes again.
  w.go(); await w.until('DONE'); await w.exited;
  MIND.touchMind(m);
  await flushed();

  const d = onDisk().data[owner];
  assert.equal(d.facts.city, undefined, 'deleted fact came back after the two processes merged');
  assert.equal(m.facts.city, undefined, 'and not in the server\'s memory either');
  assert.equal(d.facts.client.value, 'Juniper Hotel', 'untouched facts kept');
  assert.ok(d.beliefs['pref:short'], 'the worker\'s legitimate change kept');
});

test('REAL two processes: a deleted owner is not written back by a worker that loaded it earlier', async () => {
  const owner = 'user:erase-me';
  const m = MIND.getMind(owner);
  m.facts.secret = { key: 'secret', value: 'x', ts: Date.now(), updatedAt: Date.now(), confidence: 0.9 };
  MIND.touchMind(m);
  await flushed();

  const w = startWorker(`
    const other = M.getMind('user:someone-else');
    other.beliefs = { 'b:1': { updatedAt: Date.now() } };
    M.touchMind(other);   // the worker flushes its WHOLE map, which still holds user:erase-me
  `);
  await w.until('LOADED');
  MIND.deleteMind(owner);
  await flushed();
  w.go(); await w.until('DONE'); await w.exited;

  const disk = onDisk();
  assert.equal(disk.data[owner], undefined, 'deleted owner resurrected by the other process');
  assert.ok(disk.data['user:someone-else'], 'the worker\'s own change landed');
  assert.ok(disk.__aqua.deletedOwners?.[owner], 'the deletion is recorded in the file, not only in one process');
});
