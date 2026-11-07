/**
 * C9 files never touch a real user store (2026-11-07).
 *
 * core/dataDir.js fixes DATA_DIR when it is first imported — AQUA_DATA_DIR, or
 * ~/.aquiplex by default — and stores (pic/picStore.js, files/evidenceStore.js,
 * the Mind) read their files the moment they are imported. A script or test that
 * imports app code before pointing AQUA_DATA_DIR at a temporary directory reads
 * the developer's real store (this happened once during C9, from an ad-hoc
 * command; nothing was written).
 *
 * Static check: every C9 file that imports app code sets AQUA_DATA_DIR to a
 * fresh temporary directory BEFORE its first app import. Runtime check: the
 * measurement script refuses a data dir outside the temp directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = [
  'scripts/c9-mind-relevance-measure.mjs',
  'src/mind/tests/cognitiveRelevanceMeaning.test.js',
  'src/memory/tests/collectionSupersession.test.js',
  'src/mind/tests/blockerClosureSpecificity.test.js',
];
// Files that must not import app code at all (no store can be reached from them).
const NO_APP_IMPORTS = ['scripts/build-c9-semantic-dataset.mjs', 'eval/fixtures/c9EmbeddingFixture.mjs', 'eval/tests/c9SemanticDataset.test.js', 'eval/tests/c9SemanticFixture.test.js'];
const APP_IMPORT = /(?:import\s*\(|from\s+)\s*['"`][^'"`]*(?:\.\.\/|src\/)[^'"`]*['"`]|imp\(\s*['"]src\//;

test('every C9 file that imports app code points AQUA_DATA_DIR at a temp directory first', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(AQUA, f), 'utf8');
    const set = src.search(/process\.env\.AQUA_DATA_DIR\s*=\s*fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\)/);
    const firstApp = src.search(APP_IMPORT);
    assert.ok(set >= 0, `${f}: never sets AQUA_DATA_DIR to a temp directory`);
    assert.ok(firstApp > set, `${f}: imports app code before setting AQUA_DATA_DIR`);
    assert.doesNotMatch(src.slice(0, firstApp), /^import .*['"](?:\.\.\/)+(?:src|files|mind|memory|brain|pic|core)\//m, `${f}: a static app import is hoisted above the assignment`);
  }
});

test('the dataset, the loader and the replay tests import no app code at all', () => {
  for (const f of NO_APP_IMPORTS) {
    const src = fs.readFileSync(path.join(AQUA, f), 'utf8');
    assert.doesNotMatch(src, /(?:import\s*\(|from\s+)\s*['"`][^'"`]*\/src\//, f);
    assert.doesNotMatch(src, /from\s+['"](?:\.\.\/)+(?:src|files|mind|memory|brain|pic|core)\//, f);
  }
});

test('a temporary AQUA_DATA_DIR really isolates, and the measurement script checks it before any store loads', () => {
  // Control: core/dataDir.js honours AQUA_DATA_DIR. Run in a child with a fake home, so even
  // a fallback could never reach the developer's ~/.aquiplex.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-c9-fakehome-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-c9-isolated-'));
  const r = spawnSync(process.execPath, ['-e', `
    process.env.AQUA_DATA_DIR = ${JSON.stringify(dir)};
    const { pathToFileURL } = require('node:url');
    import(pathToFileURL(${JSON.stringify(path.join(AQUA, 'src/core/dataDir.js'))}).href).then(m => process.stdout.write(m.DATA_DIR));
  `], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(fs.realpathSync(r.stdout.trim()), fs.realpathSync(dir), r.stderr);
  const src = fs.readFileSync(path.join(AQUA, 'scripts/c9-mind-relevance-measure.mjs'), 'utf8');
  const guard = src.indexOf("await imp('src/core/dataDir.js')");
  assert.ok(guard > 0 && guard < src.indexOf("await imp('src/memory/engine.js')"), 'the guard runs before any store module is imported');
  assert.match(src, /REFUSED: data dir/);
});
