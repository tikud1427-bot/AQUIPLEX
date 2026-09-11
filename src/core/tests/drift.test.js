/**
 * AQUA Storage — drift comparison
 * Blueprint E3/PR-6
 *
 * `diffManifests()` is where all the judgement lives, and it needs neither a
 * database nor a filesystem — so the part that decides whether the substrate
 * is safe to switch to is fully tested here, without a server.
 *
 * The assertion with the most bite is that the job NEVER WRITES TO A STORE. A
 * drift job that repairs what it finds is a second write path with no review,
 * running unattended, against the exact data whose correctness is in question.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  diffManifests, primaryManifest, checksumOf, checkDrift, driftLine,
} from '../db/drift.js';
import { isConfigured } from '../db/pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LIVE = isConfigured();
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const M = obj => new Map(Object.entries(obj));

// ── The comparison ───────────────────────────────────────────────────────────

describe('drift — the four outcomes', () => {
  test('identical sides are clean', () => {
    const r = diffManifests(M({ a: '1', b: '2' }), M({ a: '1', b: '2' }));
    assert.equal(r.clean, true);
    assert.equal(r.matched, 2);
    assert.equal(r.stores, 2);
  });

  test('a differing checksum is a mismatch, and both values are reported', () => {
    // Reporting only "differs" would send someone to compare two files by hand.
    const r = diffManifests(M({ a: '1' }), M({ a: '9' }));
    assert.equal(r.clean, false);
    assert.deepEqual(r.mismatched, [{ key: 'a', primary: '1', shadow: '9' }]);
  });

  test('missing-in-shadow and missing-in-primary are DIFFERENT problems', () => {
    // One is a write that never landed. The other is a row that outlived its
    // store file. Collapsing them into "different" loses which side to inspect.
    const r = diffManifests(M({ a: '1', b: '2' }), M({ b: '2', c: '3' }));
    assert.deepEqual(r.missingShadow, ['a'], 'a JSON store never reached Postgres');
    assert.deepEqual(r.missingPrimary, ['c'], 'a Postgres row has no store file');
    assert.equal(r.clean, false);
  });

  test('an empty shadow is drift, not cleanliness', () => {
    // The state right after shadow mode is switched on: nothing has been
    // written yet. It must NOT read as "clean", or the week-of-zero criterion
    // would be satisfied by a database nobody ever wrote to.
    const r = diffManifests(M({ a: '1', b: '2' }), M({}));
    assert.equal(r.clean, false);
    assert.equal(r.missingShadow.length, 2);
  });

  test('two empty sides are clean but report zero stores', () => {
    const r = diffManifests(M({}), M({}));
    assert.equal(r.clean, true);
    assert.equal(r.stores, 0);
  });

  test('output is ordered, so two runs of the same state read identically', () => {
    const a = diffManifests(M({ z: '1', a: '2' }), M({}));
    const b = diffManifests(M({ a: '2', z: '1' }), M({}));
    assert.deepEqual(a.missingShadow, b.missingShadow);
  });
});

// ── The primary side ─────────────────────────────────────────────────────────

describe('drift — reading the primary', () => {
  const withStores = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-drift-'));
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
    return dir;
  };

  test('only .aqua-*.json files are compared', () => {
    // The data directory also holds backups, temp files and migration stubs.
    // Hashing those would report drift for files the shadow was never asked
    // to hold.
    const dir = withStores({
      '.aqua-mind.json': '{"a":1}',
      '.aqua-mind.json.bak': '{"old":1}',
      '.aqua-evidence.json': '{"b":2}',
      'notes.txt': 'hello',
      '.aqua-history.json.migrated-to-datadir': 'x',
    });
    assert.deepEqual([...primaryManifest({ dir }).keys()].sort(),
      ['.aqua-evidence.json', '.aqua-mind.json']);
  });

  test('the checksum matches what the adapter would have written', () => {
    const dir = withStores({ '.aqua-x.json': '{"v":1}' });
    assert.equal(primaryManifest({ dir }).get('.aqua-x.json'), checksumOf('{"v":1}'));
  });

  test('a missing data directory is empty, not an error', () => {
    assert.equal(primaryManifest({ dir: path.join(os.tmpdir(), `nope-${Date.now()}`) }).size, 0);
  });
});

// ── Reporting ────────────────────────────────────────────────────────────────

describe('drift — the boot line', () => {
  test('clean says how many matched', () => {
    assert.match(driftLine({ configured: true, clean: true, matched: 12, stores: 12, durationMs: 4 }),
      /clean — 12\/12/);
  });

  test('drift names each category and says not to flip', () => {
    const line = driftLine({
      configured: true, clean: false, stores: 12, durationMs: 9,
      mismatched: [{ key: 'a' }], missingShadow: ['b', 'c'], missingPrimary: ['d'],
    });
    assert.match(line, /1 mismatched/);
    assert.match(line, /2 missing in postgres/);
    assert.match(line, /1 stale rows/);
    assert.match(line, /read paths must NOT flip/);
  });

  test('unconfigured says so rather than pretending to be clean', () => {
    assert.match(driftLine({ configured: false }), /not-configured/);
    assert.match(driftLine(null), /not-configured/);
  });
});

describe('drift — without a database', () => {
  test('checkDrift reports not-configured instead of throwing', async () => {
    if (LIVE) return;
    assert.deepEqual(await checkDrift(), { configured: false, status: 'not-configured' });
  });
});

// ── The properties, asserted against the source ─────────────────────────────

describe('drift — the properties that matter', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/core/db/drift.js'), 'utf8'));

  test('THE LOAD-BEARING ONE: it never writes to a store', () => {
    // Its only write is its own history row. A job that repaired drift would
    // be an unattended second write path against data whose correctness is
    // exactly what is in question.
    for (const banned of ['writeSync', 'atomicWrite', 'setAdapter', 'getAdapter']) {
      assert.ok(!src.includes(banned), `drift.js touches ${banned} — it must be read-only`);
    }
    assert.ok(!/INSERT INTO (?!aqua_drift_runs)/.test(src), 'it inserts somewhere other than its own history');
    assert.ok(!/\bUPDATE\b|\bDELETE\b/.test(src), 'drift.js issues a mutating statement');
  });

  test('it compares checksums rather than pulling every blob', () => {
    // aqua_store_blobs.checksum exists for this. Selecting `data` would drag
    // every store across the wire on a timer.
    assert.match(src, /SELECT store_key, checksum FROM/);
    assert.ok(!/SELECT .*\bdata\b/.test(src), 'the drift job is pulling store contents');
  });

  test('a failed history write does not lose the result', () => {
    assert.match(src, /could not record run/);
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe('drift — wiring', () => {
  test('the boot hook runs only in shadow mode and is not awaited', () => {
    // A comparison that delayed startup would be the first thing switched off.
    const src = fs.readFileSync(path.join(ROOT, 'router.js'), 'utf8');
    assert.match(src, /storeResult\.mode === 'shadow'/);
    assert.match(src, /import\('\.\/src\/core\/db\/drift\.js'\)\s*\n?\s*\.then/);
    assert.ok(!/await import\('\.\/src\/core\/db\/drift\.js'\)/.test(src),
      'the drift check is awaited — it would delay boot');
  });

  test('there is a CLI and an npm script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['db:drift']);
    assert.match(fs.readFileSync(path.join(ROOT, 'src/core/db/cli.mjs'), 'utf8'), /--drift/);
  });

  test('the history migration exists and is idempotent', () => {
    const sql = stripComments(fs.readFileSync(
      path.join(ROOT, 'src/core/db/migrations/0003_drift_runs.sql'), 'utf8'));
    assert.match(sql, /CREATE TABLE IF NOT EXISTS aqua_drift_runs/);
    assert.match(sql, /clean\s+boolean/);
  });
});

// ── Live ─────────────────────────────────────────────────────────────────────

describe('drift — against a real database', { skip }, () => {
  test('a comparison runs and records a row', async () => {
    const r = await checkDrift();
    assert.equal(r.configured, true);
    assert.equal(typeof r.stores, 'number');
    assert.ok(['clean', 'drift'].includes(r.status));
  });
});
