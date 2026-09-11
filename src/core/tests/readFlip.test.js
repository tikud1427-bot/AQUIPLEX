/**
 * AQUA Storage — flipping a read path
 * Blueprint E3/PR-7
 *
 * The first PR in this epic where a user's read can actually come from
 * Postgres. Three properties carry the safety, and each has a test that bites:
 *
 *   1. HYDRATE FIRST. The Postgres adapter serves reads from a cache. An
 *      unhydrated cache answers null for everything.
 *   2. DRIFT GATES THE FLIP, per store. A store whose two sides disagree does
 *      not flip, however loudly the environment asked.
 *   3. A NULL FROM THE SHADOW IS NEVER TRUSTED. It falls back to JSON, counts
 *      it, and says so — because an empty store is indistinguishable from
 *      total data loss to the person reading it.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDualWriteAdapter } from '../storage/dualWriteAdapter.js';
import { createJsonFileAdapter } from '../storage/jsonFileAdapter.js';
import { readStoresFromEnv, storageBootLine, resetAdapter } from '../storage/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const tmpStore = (name, contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-flip-'));
  const p = path.join(dir, name);
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
};

/** A shadow whose contents the test controls. */
function fakeShadow(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    id: 'fake-shadow', syncDurable: false, map,
    existsSync(k) { return map.has(path.basename(k)); },
    readSync(k) { const v = map.get(path.basename(k)); return v === undefined ? null : v; },
    async write(k, d) { map.set(path.basename(k), d); },
    writeSync(k, d) { map.set(path.basename(k), d); },
    copySync(a, b) { map.set(path.basename(b), map.get(path.basename(a))); },
    async flush() { return 0; },
  };
}

afterEach(() => { resetAdapter(); delete process.env.AQUA_STORE_PG_READ; });

// ── The flag ─────────────────────────────────────────────────────────────────

describe('read flip — the flag', () => {
  test('nothing flips by default — PR-5 behaviour exactly', () => {
    delete process.env.AQUA_STORE_PG_READ;
    assert.deepEqual(readStoresFromEnv(), []);
    const d = createDualWriteAdapter(createJsonFileAdapter(), fakeShadow());
    assert.deepEqual(d.readsFromShadow(), []);
  });

  test('bare names normalise to store filenames', () => {
    process.env.AQUA_STORE_PG_READ = 'artifacts, .aqua-pic.json ,cognition';
    assert.deepEqual(readStoresFromEnv(),
      ['.aqua-artifacts.json', '.aqua-pic.json', '.aqua-cognition.json']);
  });

  test('it is a LIST, not a boolean', () => {
    // The epic flips one store per PR. One store being trustworthy says nothing
    // about another, and a single global switch would make that ordering
    // meaningless.
    process.env.AQUA_STORE_PG_READ = 'artifacts';
    assert.deepEqual(readStoresFromEnv(), ['.aqua-artifacts.json']);
  });

  test('empty and whitespace entries are dropped', () => {
    process.env.AQUA_STORE_PG_READ = ' , artifacts, ,';
    assert.deepEqual(readStoresFromEnv(), ['.aqua-artifacts.json']);
  });
});

// ── Only the listed store flips ──────────────────────────────────────────────

describe('read flip — scope', () => {
  test('a flipped store reads from the shadow', () => {
    const key = tmpStore('.aqua-artifacts.json', '{"from":"json"}');
    const d = createDualWriteAdapter(createJsonFileAdapter(),
      fakeShadow({ '.aqua-artifacts.json': '{"from":"postgres"}' }),
      { readFrom: ['.aqua-artifacts.json'] });
    assert.equal(d.readSync(key), '{"from":"postgres"}');
    assert.equal(d.stats().shadowReads, 1);
  });

  test('an UNFLIPPED store still reads from JSON, even though the shadow has it', () => {
    // The scoping assertion. If a flip leaked to other stores, one careful PR
    // would silently move eight.
    const key = tmpStore('.aqua-mind.json', '{"from":"json"}');
    const d = createDualWriteAdapter(createJsonFileAdapter(),
      fakeShadow({ '.aqua-mind.json': '{"from":"postgres"}' }),
      { readFrom: ['.aqua-artifacts.json'] });
    assert.equal(d.readSync(key), '{"from":"json"}');
    assert.equal(d.stats().shadowReads, 0);
  });

  test('writes still go to BOTH, flipped or not', () => {
    const key = tmpStore('.aqua-artifacts.json');
    const shadow = fakeShadow();
    const d = createDualWriteAdapter(createJsonFileAdapter(), shadow,
      { readFrom: ['.aqua-artifacts.json'] });
    d.writeSync(key, '{"v":1}');
    assert.equal(fs.readFileSync(key, 'utf8'), '{"v":1}', 'the authoritative write was skipped');
    assert.equal(shadow.map.get('.aqua-artifacts.json'), '{"v":1}');
  });
});

// ── The fallback ─────────────────────────────────────────────────────────────

describe('read flip — a null from the shadow is never trusted', () => {
  test('THE LOAD-BEARING ONE: an empty shadow falls back to JSON', () => {
    // An empty store is indistinguishable from total data loss to the person
    // reading it. Serving null here would be the worst outcome in the epic:
    // silent, total, and looking exactly like success.
    const key = tmpStore('.aqua-artifacts.json', '{"real":"data"}');
    const d = createDualWriteAdapter(createJsonFileAdapter(), fakeShadow(),
      { readFrom: ['.aqua-artifacts.json'] });
    assert.equal(d.readSync(key), '{"real":"data"}');
    assert.equal(d.stats().readFallbacks, 1, 'the fallback happened silently — it must be counted');
  });

  test('a THROWING shadow read also falls back', () => {
    const key = tmpStore('.aqua-artifacts.json', '{"real":"data"}');
    const shadow = fakeShadow();
    shadow.readSync = () => { throw new Error('connection lost'); };
    const d = createDualWriteAdapter(createJsonFileAdapter(), shadow,
      { readFrom: ['.aqua-artifacts.json'], onShadowError: () => {} });
    assert.equal(d.readSync(key), '{"real":"data"}');
    assert.equal(d.stats().shadowFailures, 1);
  });

  test('a genuinely absent store still reads null — the fallback invents nothing', () => {
    const key = tmpStore('.aqua-artifacts.json');   // no file written
    const d = createDualWriteAdapter(createJsonFileAdapter(), fakeShadow(),
      { readFrom: ['.aqua-artifacts.json'] });
    assert.equal(d.readSync(key), null);
    assert.equal(d.stats().readFallbacks, 0, 'a first boot must not look like a fallback');
  });

  test('existsSync says yes if EITHER side has it', () => {
    const key = tmpStore('.aqua-artifacts.json', '{}');
    const d = createDualWriteAdapter(createJsonFileAdapter(), fakeShadow(),
      { readFrom: ['.aqua-artifacts.json'] });
    assert.equal(d.existsSync(key), true, 'a store that exists in JSON reported as missing');
  });
});

// ── The boot line ────────────────────────────────────────────────────────────

describe('read flip — the boot line names what flipped', () => {
  test('no flips says so', () => {
    assert.match(storageBootLine({ mode: 'shadow', readFrom: [] }), /no read comes from Postgres/);
  });

  test('a flip is named, with the reminder that writes still go to both', () => {
    const line = storageBootLine({ mode: 'shadow', readFrom: ['.aqua-artifacts.json'] });
    assert.match(line, /reads=\[\.aqua-artifacts\.json\]/);
    assert.match(line, /writes still go to both/);
  });

  test('a REFUSED flip is reported, not silently dropped', () => {
    // The most dangerous silent outcome: someone sets the flag, sees no error,
    // and believes the substrate moved when drift quietly kept it on JSON.
    const line = storageBootLine({
      mode: 'shadow', readFrom: [],
      notes: ['.aqua-artifacts.json still drifts — reads stay on JSON'],
    });
    assert.match(line, /still drifts/);
  });
});

// ── The gate ─────────────────────────────────────────────────────────────────

describe('read flip — drift gates it, checked at the moment of the decision', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/core/storage/index.js'), 'utf8'));

  test('hydrate runs BEFORE any flip is considered', () => {
    // An unhydrated cache answers null for everything, so every read would
    // fall back — working, with the new substrate contributing nothing and
    // nobody noticing.
    const hydrateAt = src.indexOf('shadow.hydrate()');
    const diffAt = src.indexOf('diffManifests(');
    assert.ok(hydrateAt > -1, 'the shadow is never hydrated');
    assert.ok(hydrateAt < diffAt, 'drift is compared before the cache is loaded');
  });

  test('the drift check is per store, not global', () => {
    assert.match(src, /for \(const store of requested\)/);
    assert.match(src, /dirty\.has\(store\)/);
  });

  test('a drifting store is refused and the reason recorded', () => {
    assert.match(src, /still drifts — reads stay on JSON/);
  });

  test('missing-in-shadow counts as dirty, not just a mismatch', () => {
    // A store the shadow has never received is exactly the case where reading
    // from it would serve an empty store. It must not flip.
    assert.match(src, /diff\.missingShadow/);
  });
});
