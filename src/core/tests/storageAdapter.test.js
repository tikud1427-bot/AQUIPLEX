/**
 * AQUA Storage — the adapter seam
 * Blueprint E3/PR-3
 *
 * TWO JOBS.
 *
 *   1. A CONTRACT any adapter must pass. E3/PR-4 adds a Postgres adapter and
 *      grades it against this same suite — so "it works" means the same thing
 *      for both, rather than each being judged by whatever its author
 *      remembered to check.
 *
 *   2. Proof that this PR changed NO behaviour. The real proof is the existing
 *      battery passing unchanged (2045 tests, none of them edited). What is
 *      added here is the part a passing battery cannot show: that the public
 *      API is identical, and that the details a refactor silently "improves"
 *      are still exact.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonFileAdapter } from '../storage/jsonFileAdapter.js';
import { getAdapter, setAdapter, resetAdapter, assertAdapter, ADAPTER_MEMBERS } from '../storage/index.js';
import * as store from '../atomicStore.js';
import { runAdapterContract } from './helpers/adapterContract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-storage-'));

/** Strip line and block comments before any source-content assertion. */
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

afterEach(() => resetAdapter());

// ── The contract ─────────────────────────────────────────────────────────────

runAdapterContract('json-file', createJsonFileAdapter, () => path.join(tmpDir(), 'store.json'));

// ── The seam ─────────────────────────────────────────────────────────────────

describe('storage seam', () => {
  test('the default adapter is the JSON one', () => {
    assert.equal(getAdapter().id, 'json-file');
  });

  test('a partial adapter is refused, member by member', () => {
    for (const missing of ADAPTER_MEMBERS.filter(m => m !== 'id')) {
      const a = createJsonFileAdapter();
      delete a[missing];
      assert.throws(() => assertAdapter(a), new RegExp(missing));
    }
  });

  test('an adapter without an id is refused — the id goes in the boot line', () => {
    const a = createJsonFileAdapter(); a.id = '';
    assert.throws(() => assertAdapter(a), /id/);
  });

  test('setAdapter returns the previous one so a test can restore it', () => {
    const fake = { ...createJsonFileAdapter(), id: 'fake' };
    const prev = setAdapter(fake);
    assert.equal(prev.id, 'json-file');
    assert.equal(getAdapter().id, 'fake');
    setAdapter(prev);
    assert.equal(getAdapter().id, 'json-file');
  });

  test('setAdapter validates before swapping — a bad adapter never takes effect', () => {
    assert.throws(() => setAdapter({ id: 'broken' }));
    assert.equal(getAdapter().id, 'json-file', 'a rejected adapter was installed anyway');
  });
});

// ── Zero behaviour change ────────────────────────────────────────────────────

describe('atomicStore — the refactor changed nothing', () => {
  test('the public API is exactly what it was', () => {
    // A refactor that quietly adds or removes an export is not a refactor.
    assert.deepEqual(Object.keys(store).sort(), [
      'atomicWriteFile', 'atomicWriteFileSync', 'backupOnce',
      'createDebouncedWriter', 'loadJsonFile', 'unwrapStore', 'wrapStore',
    ]);
  });

  test('the temp file lives in the SAME DIRECTORY as its target', async () => {
    // rename(2) is atomic only within one filesystem. A temp file placed
    // anywhere else turns the atomic write into a copy — the exact corruption
    // this module was built to prevent.
    const dir = tmpDir(); const key = path.join(dir, 'x.json');
    const seen = [];
    const spy = { ...createJsonFileAdapter(), id: 'spy' };
    const real = createJsonFileAdapter();
    spy.write = async (k, d) => { seen.push(path.dirname(k)); return real.write(k, d); };
    setAdapter(spy);
    await store.atomicWriteFile(key, '{}');
    assert.deepEqual(seen, [dir]);
  });

  test('temp paths use a COUNTER, not a timestamp', () => {
    // The first version of the adapter used Date.now(). Two writes to one file
    // inside the same millisecond would then share a temp path and race. The
    // original scheme used a monotonic counter and could not collide — this is
    // the detail a "harmless equivalent rewrite" nearly lost.
    // Comments stripped first. This is the FOURTH time in this project a
    // content detector has matched its own documentation — here, the comment
    // explaining why Date.now() is not used. Stripping is now the default for
    // any source-content assertion.
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/core/storage/jsonFileAdapter.js'), 'utf8'));
    assert.match(src, /tmpCounter\+\+/);
    assert.ok(!/Date\.now\(\)/.test(src), 'the temp path is timestamp-based and can collide');
  });

  test('a failed write leaves no temp file behind', async () => {
    // The failure has to happen AFTER the temp is written, or the cleanup this
    // test claims to guard is never reached. The first version wrote into a
    // non-existent directory, so the temp was never created and the assertion
    // passed while proving nothing — a vacuous test, caught by measuring bite
    // rather than by reading it.
    //
    // Here the target is an existing NON-EMPTY DIRECTORY: the temp write
    // succeeds, the rename onto it fails, and the unlink is what keeps the
    // directory clean.
    const dir = tmpDir();
    const target = path.join(dir, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'child'), 'x');

    const a = createJsonFileAdapter();
    await assert.rejects(() => a.write(target, '{}'));
    const leftovers = fs.readdirSync(dir).filter(n => n.includes('.tmp.'));
    assert.deepEqual(leftovers, [], 'a temp file survived a failed write');
  });

  test('the same holds for the synchronous path', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'child'), 'x');
    assert.throws(() => createJsonFileAdapter().writeSync(target, '{}'));
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp.')), []);
  });

  test('loadJsonFile still returns null for a missing file', () => {
    assert.equal(store.loadJsonFile(path.join(tmpDir(), 'absent.json')), null);
  });

  test('loadJsonFile round-trips a real store through the seam', () => {
    const key = path.join(tmpDir(), 's.json');
    store.atomicWriteFileSync(key, JSON.stringify(store.wrapStore(3, { a: 1 })));
    const parsed = store.loadJsonFile(key);
    assert.deepEqual(store.unwrapStore(parsed, { expected: 3, file: key }).data, { a: 1 });
  });

  test('atomicStore makes no direct filesystem write calls any more', () => {
    // The seam only holds if nothing bypasses it. Reads of `fs` remain for the
    // corrupt-file rescue path, which moves files aside rather than writing.
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/core/atomicStore.js'), 'utf8'));
    for (const banned of ['fs.writeFileSync', 'fs.promises.writeFile', 'fs.copyFileSync']) {
      assert.ok(!src.includes(banned), `${banned} still bypasses the adapter`);
    }
  });
});
