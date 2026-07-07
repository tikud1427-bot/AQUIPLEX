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
 * memory). The test runs in a private temp cwd so INDEX_FILE
 * (process.cwd()/.aqua-index.json) is isolated from real data.
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

describe('projectIndex persistence (restart survival)', () => {
  before(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-index-'));
    process.chdir(tmpDir); // INDEX_FILE resolves under here at import time
  });

  after(() => {
    process.chdir(originalCwd);
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
    const file = path.join(tmpDir, '.aqua-index.json');
    assert.ok(fs.existsSync(file), '.aqua-index.json written');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
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
