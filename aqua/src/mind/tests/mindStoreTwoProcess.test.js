/**
 * P0 2026-10-12 — server and worker share .aqua-mind.json; a flush must never
 * overwrite what the other process wrote.
 *
 * Measured on the real launcher: the server stored a new user's 4 legacy facts,
 * then the worker — whose in-memory copy was loaded before that user existed —
 * flushed its whole map over the file. The live copy (disk + Mongo mirror) went
 * to facts=0 and, after a Render-style restart, Aqua had no legacy memory of the
 * user. The first two tests drive the pure merge step; the last spawns a real
 * second process against the same file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-mind2p-'));
process.env.AQUA_DATA_DIR = DIR;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
const MIND = await import('../mindStore.js');
const STORE_URL = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mindStore.js')).href;

const fact = (value, ts) => ({ key: 'k', value, ts, confidence: 0.9 });
const opts = (dirty = []) => ({ dirtyOwners: new Set(dirty), deletedOwners: new Set(), base: new Map([['user:a', 100], ['user:b', 100]]) });

test('the incident: a stale process does not overwrite an owner it never changed — it adopts the disk copy', () => {
  // Worker memory: user:a as loaded at boot (no facts). Disk: server added 4 facts later.
  const ours = { ownerId: 'user:a', updatedAt: 100, facts: {} };
  const memory = new Map([['user:a', ours]]);
  const disk = { 'user:a': { ownerId: 'user:a', updatedAt: 200, facts: { name: fact('Lena', 200), client: fact('Juniper', 200) } } };
  const r = MIND.mergeForFlush(memory, disk, opts());
  assert.equal(memory.get('user:a'), ours, 'same object — references held elsewhere stay valid');
  assert.deepEqual(Object.keys(ours.facts).sort(), ['client', 'name']);
  assert.equal(r.adopted, 1);
});

test('both processes changed one owner: fields merge (newer fact wins per key, both sides kept)', () => {
  const ours = { ownerId: 'user:b', updatedAt: 300, facts: { city: fact('Leeds', 300), client: fact('Fennel', 150) }, beliefs: { 'p:x': { ts: 300 } } };
  const memory = new Map([['user:b', ours]]);
  const disk = { 'user:b': { ownerId: 'user:b', updatedAt: 250, facts: { client: fact('Juniper', 250), assistant: fact('Tom', 250) }, beliefs: { 'p:y': { ts: 250 } } } };
  const r = MIND.mergeForFlush(memory, disk, opts(['user:b']));
  assert.equal(r.merged, 1);
  assert.equal(ours.facts.city.value, 'Leeds', 'our change kept');
  assert.equal(ours.facts.client.value, 'Juniper', 'their newer change kept');
  assert.equal(ours.facts.assistant.value, 'Tom', 'their new key kept');
  assert.deepEqual(Object.keys(ours.beliefs).sort(), ['p:x', 'p:y']);
});

test('owners only on disk are adopted; an owner deleted here is not resurrected', () => {
  const memory = new Map();
  const o = { dirtyOwners: new Set(), deletedOwners: new Set(['user:gone']), base: new Map() };
  MIND.mergeForFlush(memory, { 'user:new': { ownerId: 'user:new', updatedAt: 5, facts: {} }, 'user:gone': { ownerId: 'user:gone', updatedAt: 5, facts: {} } }, o);
  assert.ok(memory.has('user:new'));
  assert.ok(!memory.has('user:gone'));
});

test('REAL second process: its flush of a different owner leaves our owner\'s facts on disk intact', async () => {
  // This process (the "server") stores a user's facts and flushes.
  const m = MIND.getMind('user:lena');
  m.facts.name = fact('Lena', Date.now());
  m.facts.client = fact('Juniper Hotel', Date.now());
  MIND.touchMind(m);
  await new Promise(r => setTimeout(r, 900));   // debounce (500ms) + async write
  const file = path.join(DIR, '.aqua-mind.json');
  assert.match(fs.readFileSync(file, 'utf8'), /Juniper Hotel/, 'precondition: our flush landed');

  // A second process (the "worker") that loaded the file BEFORE... simulate the
  // stale boot by giving it the file, then making it touch an unrelated owner.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const M = await import(${JSON.stringify(STORE_URL)});
    const w = M.getMind('user:worker-only');
    w.beliefs = { 'x:y': { ts: Date.now() } };
    M.touchMind(w);
    await new Promise(r => setTimeout(r, 900));
  `], { env: { ...process.env, AQUA_DATA_DIR: DIR, AQUA_DISABLE_MONGO_MIRROR: '1' }, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);

  // Meanwhile we add another fact, and flush again AFTER the worker wrote.
  m.facts.assistant = fact('Tom Reyes', Date.now());
  MIND.touchMind(m);
  await new Promise(r => setTimeout(r, 900));

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).data;
  assert.deepEqual(Object.keys(onDisk['user:lena'].facts).sort(), ['assistant', 'client', 'name'], 'our facts survive the other process');
  assert.ok(onDisk['user:worker-only'], 'and the other process\'s owner survives OUR flush (was overwritten before)');
});
