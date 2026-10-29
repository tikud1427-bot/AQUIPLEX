/**
 * scripts/backfill-sensitivity.mjs: dry run by default, tags on --apply,
 * idempotent, never deletes, never prints a fact's key or value.
 * Each step is a separate process on an isolated data dir, like production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const aquaRoot = path.resolve(here, '..', '..', '..');
const script = path.join(aquaRoot, 'scripts', 'backfill-sensitivity.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-backfill-'));
const env = { ...process.env, AQUA_DATA_DIR: dataDir, AQUA_DISABLE_MONGO_MIRROR: '1', MONGO_URI: '', DATABASE_URL: '' };

function node(args) {
  const r = spawnSync(process.execPath, args, { cwd: aquaRoot, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function evalModule(src) {
  return node(['--input-type=module', '-e', src]);
}
const ltm = pathToFileURL(path.join(aquaRoot, 'src', 'memory', 'longTermMemory.js')).href;
const readFacts = () => JSON.parse(evalModule(`
  const L = await import(${JSON.stringify(ltm)});
  process.stdout.write(JSON.stringify(L.getFacts('user:b1', { includeArchived: true })));`).trim().split('\n').pop());

test('dry run → apply → apply again', () => {
  evalModule(`
    const L = await import(${JSON.stringify(ltm)});
    const base = { confidence: 0.7, importance: 4, category: 'custom' };
    L.storeFact('user:b1', { ...base, key: 'custom_very_bored', value: 'very bored' });
    L.storeFact('user:b1', { ...base, key: 'custom_right_eye', value: 'moving automatically' });
    L.storeFact('user:b1', { ...base, key: 'city', value: 'Pune', category: 'location' });`);
  assert.equal(readFacts().length, 3, 'precondition: seeded and persisted');

  const dry = node([script]);
  assert.match(dry, /mode=DRY-RUN/);
  assert.match(dry, /sensitive=2 \(health=1 mood=1\) alreadyTagged=0 wouldTag=2/);
  assert.doesNotMatch(dry, /bored|right_eye|moving/i, 'never prints keys or values');
  assert.ok(readFacts().every(f => !f.sensitivity), 'dry run wrote nothing');

  const run = node([script, '--apply']);
  assert.match(run, /tagged=2/);
  const tagged = Object.fromEntries(readFacts().map(f => [f.key, f.sensitivity ?? null]));
  assert.deepEqual(tagged, { custom_very_bored: 'mood', custom_right_eye: 'health', city: null });

  const again = node([script, '--apply']);
  assert.match(again, /alreadyTagged=2 tagged=0/, 'idempotent');
  assert.equal(readFacts().length, 3, 'nothing deleted (L5)');
});
