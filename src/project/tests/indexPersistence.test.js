/**
 * AQUA Project Index — Persistence / restart-survival tests (Phase 1)
 *
 * Run: node --test src/project/tests/indexPersistence.test.js
 *
 * Proves the Phase 1 guarantee: the queryable workspace index — and the raw
 * file content the edit engine depends on — survives a process restart.
 *
 * A "restart" is simulated faithfully by importing the module TWICE with
 * distinct query strings: each import is a fresh ESM instance with independent
 * top-level state, so the second instance re-runs loadFromDisk() and must
 * reconstruct the index from the on-disk snapshot alone (nothing shared in
 * memory).
 *
 * ISOLATION — why chdir() alone was not enough (P0 audit finding)
 * ---------------------------------------------------------------
 * This suite used to assume `INDEX_FILE = process.cwd()/.aqua-index.json` and
 * isolate itself with `process.chdir(tmpDir)`. That stopped being true when
 * the P0 persistence fix moved every store under `core/dataDir.js`:
 * projectIndex.js now resolves `migrateLegacyFile('.aqua-index.json')` into
 * AQUA_DATA_DIR / <home>/.aquiplex. So the chdir was inert, the assertion
 * failed, and — worse — the suite WROTE its fixture workspace into the REAL
 * data directory (verified: `ws-persist-test` present in a live
 * .aqua-index.json). A test that mutates production data is worse than a test
 * that does not run.
 *
 * dataDir.js resolves DATA_DIR ONCE at module load, and its first load here is
 * triggered by the first `import('../projectIndex.js…')` INSIDE a test — i.e.
 * after before() — so setting AQUA_DATA_DIR in before() is what actually binds
 * it. The chdir is kept as well: it covers the last-resort cwd fallback if a
 * future run has no writable home. Assertions now target the RESOLVED path
 * rather than a hard-coded cwd path, so this can never silently drift again.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

const WS = 'ws-persist-test';
const SAMPLE = [
  {
    path: 'src/auth.js',
    lang: 'javascript',
    size: 120,
    truncated: false,
    content: [
      'import express from "express";',
      'export function login(req, res) { return authenticate(req.body); }',
      'export class SessionManager { start() {} }',
    ].join('\n'),
  },
  {
    path: 'src/util/hash.js',
    lang: 'javascript',
    size: 40,
    truncated: false,
    content: 'export function hash(x) { return x; }',
  },
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let tmpDir;
let originalCwd;
let originalDataDir;
let indexFile;

describe('projectIndex persistence (restart survival)', () => {
  before(() => {
    originalCwd     = process.cwd();
    originalDataDir = process.env.AQUA_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-index-'));
    // THE binding that isolates this suite. dataDir.js reads this on its
    // first load, which happens on the first projectIndex import below.
    process.env.AQUA_DATA_DIR = tmpDir;
    process.chdir(tmpDir);        // also covers the cwd fallback branch
    indexFile = path.join(tmpDir, '.aqua-index.json');
  });

  after(() => {
    process.chdir(originalCwd);
    if (originalDataDir === undefined) delete process.env.AQUA_DATA_DIR;
    else process.env.AQUA_DATA_DIR = originalDataDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('build persists a source snapshot to disk', async () => {
    const mod = await import('../projectIndex.js?instance=build');
    mod.buildIndex(WS, SAMPLE);

    // Live index is correct immediately.
    const live = mod.getIndex(WS);
    assert.ok(live, 'index resident after build');
    assert.equal(live.byPath.size, 2);
    assert.ok(live.byPath.get('src/auth.js').content.includes('login'), 'entry carries raw content');
    assert.ok(live.bySymbol.has('login'), 'symbol indexed');

    // Snapshot flushes (debounced 500ms).
    await delay(700);
    // Resolved through dataDir, not cwd — see the ISOLATION note above.
    const { DATA_DIR } = await import('../../core/dataDir.js');
    assert.equal(DATA_DIR, tmpDir, 'suite is bound to its temp data dir, not the real one');
    assert.ok(fs.existsSync(indexFile), '.aqua-index.json written');
    const onDisk = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    assert.ok(Array.isArray(onDisk[WS]), 'workspace source persisted');
    assert.equal(onDisk[WS].length, 2);
    assert.ok(onDisk[WS][0].content, 'persisted source carries content (edit path depends on it)');
  });

  test('a fresh module instance rebuilds the index from disk (restart)', async () => {
    // Distinct query string → brand-new module instance → re-runs loadFromDisk.
    // NOTHING is shared with the first instance's in-memory Maps.
    const restarted = await import('../projectIndex.js?instance=restart');

    const idx = restarted.getIndex(WS);
    assert.ok(idx, 'index rebuilt from persisted source after restart');
    assert.equal(idx.byPath.size, 2, 'all files restored');
    assert.ok(
      idx.byPath.get('src/auth.js').content.includes('SessionManager'),
      'raw content restored — edit engine can hash + patch',
    );

    // Derived maps are genuinely rebuilt, not just paths.
    assert.ok(idx.bySymbol.has('login'), 'symbol map rebuilt');
    assert.ok(idx.bySymbol.has('SessionManager'), 'class symbol rebuilt');
    assert.ok(idx.byImport.has('express'), 'import map rebuilt');

    // queryIndex works end-to-end on the rebuilt index.
    const q = restarted.queryIndex(WS, { symbol: 'login' });
    assert.equal(q.files.length, 1);
    assert.equal(q.files[0].path, 'src/auth.js');
  });

  test('unknown workspace still returns null (no false positives)', async () => {
    const mod = await import('../projectIndex.js?instance=restart');
    assert.equal(mod.getIndex('does-not-exist'), null);
  });
});
