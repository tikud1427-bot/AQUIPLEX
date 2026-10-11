/**
 * The test runner must never hand a developer's real DATABASE_URL to tests.
 * Run: node --test src/core/tests/testDatabaseEnv.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDatabaseEnv } from '../db/testDatabaseEnv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('a configured production DATABASE_URL is NOT passed through', () => {
  assert.deepEqual(testDatabaseEnv({ DATABASE_URL: 'postgresql://prod/aqua' }), { DATABASE_URL: '' });
});

test('the override is an empty string, not undefined — dotenv must not be able to refill it', () => {
  // dotenv skips keys that already exist in process.env; undefined would be
  // dropped by spawn and the developer's .env value would come straight back.
  assert.strictEqual(testDatabaseEnv({}).DATABASE_URL, '');
});

test('an explicit test database is used', () => {
  assert.deepEqual(testDatabaseEnv({ DATABASE_URL: 'postgresql://prod/aqua', AQUA_TEST_DATABASE_URL: ' postgresql://localhost/aqua_test ' }),
    { DATABASE_URL: 'postgresql://localhost/aqua_test' });
});

test('the runner actually applies it to the child environment', () => {
  const src = readFileSync(path.join(ROOT, 'scripts', 'run-tests.mjs'), 'utf8');
  const envBlock = src.slice(src.indexOf("spawnSync(process.execPath, ['--test'"));
  assert.match(envBlock, /\.\.\.testDatabaseEnv\(process\.env\)/, 'run-tests.mjs no longer sandboxes DATABASE_URL');
  assert.ok(envBlock.indexOf('...process.env') < envBlock.indexOf('...testDatabaseEnv('),
    'testDatabaseEnv must come AFTER ...process.env or the real value wins');
});
