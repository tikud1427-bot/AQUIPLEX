/**
 * AQUA Storage — dual write / shadow mode
 * Blueprint E3/PR-5
 *
 * The load-bearing assertions are all about ASYMMETRY:
 *
 *   · every read comes from the primary, never once from the shadow
 *   · a primary failure propagates
 *   · a shadow failure NEVER propagates
 *
 * If a shadow failure propagated, switching shadow mode on would make the
 * engine LESS reliable than leaving it off — a migration step that raises risk
 * before delivering any benefit is one nobody will turn on, and the substrate
 * never moves.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDualWriteAdapter } from '../storage/dualWriteAdapter.js';
import { createJsonFileAdapter } from '../storage/jsonFileAdapter.js';
import {
  assertAdapter, getAdapter, resetAdapter,
  configureStorageFromEnv, storeModeFromEnv, storeMode, storageBootLine, flushStorage,
} from '../storage/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const tmpKey = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-dual-')), 'store.json');

/** A shadow that records what it was asked to do and can be made to fail. */
function spyShadow({ fail = false } = {}) {
  const calls = [];
  const boom = () => { throw new Error('shadow is down'); };
  return {
    id: 'spy', syncDurable: false, calls,
    existsSync(k) { calls.push(['existsSync', k]); return true; },
    readSync(k) { calls.push(['readSync', k]); return '{"from":"shadow"}'; },
    async write(k, d) { calls.push(['write', k]); if (fail) boom(); },
    writeSync(k, d) { calls.push(['writeSync', k]); if (fail) boom(); },
    copySync(a, b) { calls.push(['copySync', a, b]); if (fail) boom(); },
    async flush() { calls.push(['flush']); if (fail) boom(); return 1; },
  };
}

afterEach(() => { resetAdapter(); delete process.env.AQUA_STORE_PG; });

// ── The asymmetry ────────────────────────────────────────────────────────────

describe('dual write — reads come from the primary, always', () => {
  test('readSync never touches the shadow', () => {
    const shadow = spyShadow();
    const dual = createDualWriteAdapter(createJsonFileAdapter(), shadow);
    const key = tmpKey();
    dual.writeSync(key, '{"from":"primary"}');
    assert.equal(dual.readSync(key), '{"from":"primary"}');
    assert.ok(!shadow.calls.some(c => c[0] === 'readSync'),
      'a read reached the shadow — that is what makes shadow mode unsafe to enable');
  });

  test('existsSync never touches the shadow either', () => {
    const shadow = spyShadow();
    const dual = createDualWriteAdapter(createJsonFileAdapter(), shadow);
    assert.equal(dual.existsSync(tmpKey()), false, 'the shadow answered, and it always says true');
    assert.ok(!shadow.calls.some(c => c[0] === 'existsSync'));
  });
});

describe('dual write — writes reach both', () => {
  test('writeSync writes primary and shadow', () => {
    const shadow = spyShadow();
    const dual = createDualWriteAdapter(createJsonFileAdapter(), shadow);
    const key = tmpKey();
    dual.writeSync(key, '{"a":1}');
    assert.equal(fs.readFileSync(key, 'utf8'), '{"a":1}');
    assert.deepEqual(shadow.calls, [['writeSync', key]]);
  });

  test('async write writes both and counts the shadow', async () => {
    const shadow = spyShadow();
    const dual = createDualWriteAdapter(createJsonFileAdapter(), shadow);
    const key = tmpKey();
    await dual.write(key, '{"a":2}');
    assert.equal(fs.readFileSync(key, 'utf8'), '{"a":2}');
    assert.equal(dual.stats().shadowWrites, 1);
  });

  test('copySync copies in both', () => {
    const shadow = spyShadow();
    const dual = createDualWriteAdapter(createJsonFileAdapter(), shadow);
    const key = tmpKey();
    dual.writeSync(key, '{"a":3}');
    dual.copySync(key, `${key}.bak`);
    assert.equal(fs.readFileSync(`${key}.bak`, 'utf8'), '{"a":3}');
    assert.ok(shadow.calls.some(c => c[0] === 'copySync'));
  });
});

describe('dual write — failures are asymmetric', () => {
  test('THE LOAD-BEARING ONE: a broken shadow never breaks a write', () => {
    const dual = createDualWriteAdapter(createJsonFileAdapter(), spyShadow({ fail: true }),
      { onShadowError: () => {} });
    const key = tmpKey();
    assert.doesNotThrow(() => dual.writeSync(key, '{"ok":true}'));
    assert.equal(fs.readFileSync(key, 'utf8'), '{"ok":true}', 'the authoritative write was lost');
    assert.equal(dual.stats().shadowFailures, 1, 'the failure was silent — it must be counted');
  });

  test('a broken shadow never breaks an async write either', async () => {
    const dual = createDualWriteAdapter(createJsonFileAdapter(), spyShadow({ fail: true }),
      { onShadowError: () => {} });
    const key = tmpKey();
    await assert.doesNotReject(() => dual.write(key, '{"ok":true}'));
    assert.equal(dual.stats().shadowFailures, 1);
  });

  test('a PRIMARY failure DOES propagate — the authoritative store still rules', () => {
    const dual = createDualWriteAdapter(createJsonFileAdapter(), spyShadow(),
      { onShadowError: () => {} });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-dual-'));
    const target = path.join(dir, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'child'), 'x');
    assert.throws(() => dual.writeSync(target, '{}'), 'a lost authoritative write was swallowed');
  });

  test('a failing shadow flush is reported, not thrown', async () => {
    const dual = createDualWriteAdapter(createJsonFileAdapter(), spyShadow({ fail: true }),
      { onShadowError: () => {} });
    assert.equal(await dual.flush(), 0);
    assert.ok(dual.stats().shadowFailures >= 1);
  });

  test('durability is the PRIMARY\'s, not the shadow\'s', () => {
    // A dual write is exactly as durable on return as its authoritative half.
    // Reporting the shadow's `false` would tell the shutdown drain it still has
    // work when it does not; reporting `true` for a Postgres-only adapter would
    // be a lie. Taking it from the primary is the only correct answer.
    const dual = createDualWriteAdapter(createJsonFileAdapter(), spyShadow());
    assert.equal(dual.syncDurable, true);
    assert.equal(assertAdapter(dual), true);
  });
});

// ── The flag ─────────────────────────────────────────────────────────────────

describe('shadow mode — off by default, fails open', () => {
  test('the default is off', async () => {
    delete process.env.AQUA_STORE_PG;
    assert.equal(storeModeFromEnv(), 'off');
    const r = await configureStorageFromEnv();
    assert.equal(r.mode, 'off');
    assert.equal(getAdapter().id, 'json-file');
  });

  test('only the exact word "shadow" enables it', () => {
    for (const v of ['on', 'true', '1', 'yes', 'SHADOWY', '']) {
      process.env.AQUA_STORE_PG = v;
      assert.equal(storeModeFromEnv(), 'off', `"${v}" enabled shadow mode`);
    }
    process.env.AQUA_STORE_PG = 'SHADOW';
    assert.equal(storeModeFromEnv(), 'shadow', 'case should not matter for the real value');
  });

  test('shadow requested without a database falls back to JSON and says why', async () => {
    // A migration step that can break startup is a step nobody will enable.
    process.env.AQUA_STORE_PG = 'shadow';
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const r = await configureStorageFromEnv();
      assert.equal(r.mode, 'off');
      assert.equal(getAdapter().id, 'json-file');
      assert.match(r.reason, /DATABASE_URL is not set/);
      assert.equal(storeMode(), 'off');
    } finally { if (prev !== undefined) process.env.DATABASE_URL = prev; }
  });

  test('the boot line always states which backend is live', () => {
    assert.match(storageBootLine({ mode: 'off', adapter: 'json-file' }), /shadow=off/);
    const on = storageBootLine({ mode: 'shadow', adapter: 'dual(json-file→pg-blob)' });
    assert.match(on, /shadow=postgres/);
    assert.match(on, /JSON remains authoritative/);
  });

  test('flushStorage is a no-op when the adapter has no flush', async () => {
    resetAdapter();
    assert.equal(await flushStorage(50), 0);
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe('shadow mode — wiring', () => {
  test('the SIGTERM drain awaits deferred storage writes', () => {
    // PR-4's adapter reports syncDurable:false, so the synchronous shutdown
    // flush does NOT mean the bytes are safe. Without this the first deploy in
    // shadow mode would drop whatever was still write-behind.
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/core/atomicStore.js'), 'utf8'));
    assert.match(src, /flushStorage\(/);
    assert.match(src, /allSettled/, 'the mongo drain and the storage flush should run together, not in series');
  });

  test('router.js configures storage and reports it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'router.js'), 'utf8');
    assert.match(src, /configureStorageFromEnv/);
    assert.match(src, /storageBootLine/);
  });

  test('a store reads from the primary UNLESS it has been explicitly flipped', () => {
    // E3/PR-5 asserted that NOTHING reads from Postgres, syntactically. E3/PR-7
    // is the PR whose entire purpose is to change that, one store at a time —
    // so this assertion was superseded, deliberately, rather than deleted.
    //
    // What survives is the property that still matters: the default path is
    // the primary, and the shadow is reached only through an explicit opt-in
    // list. readFlip.test.js covers the flipped behaviour.
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/core/storage/dualWriteAdapter.js'), 'utf8'));
    assert.match(src, /if \(!readShadow\.has\(name\)\) return primary\.readSync\(key\);/);
    assert.match(src, /if \(!readShadow\.has\(storeName\(key\)\)\) return primary\.existsSync\(key\);/);

    const dual = createDualWriteAdapter(createJsonFileAdapter(), spyShadow());
    assert.deepEqual(dual.readsFromShadow(), [], 'a default dual adapter reads from the shadow');
  });
});
