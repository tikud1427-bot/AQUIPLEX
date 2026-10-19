/**
 * The gate measures the read paths production serves — and cannot silently
 * measure a different one.
 *
 * 2026-10-16 finding: with DATABASE_URL exported, `context-core` and
 * `context-dense-v3` reported 0 on every metric. Their adapter left the read
 * mode implicit, so the environment flipped it to canonical-only while the
 * suites had seeded only legacy stores. The gate was grading whatever the shell
 * exported, and no suite graded the canonical read production serves with a
 * database. These tests pin the repair:
 *
 *   1. legacy suites state their mode explicitly and use chat's function;
 *   2. the canonical suite resolves the mode exactly as routes/chat.js does;
 *   3. the gate never inherits a DATABASE_URL, and a suite that needs Postgres
 *      is reported NOT RUN (or fails, with AQUA_GATE_REQUIRE_DB=1) — never passed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '..', '..');
const read = rel => readFileSync(path.join(AQUA, rel), 'utf8');

const chat = read('src/routes/chat.js');
const legacyAdapter = read('eval/adapters/contextEngineRetrieval.mjs');
const canonicalAdapter = read('eval/adapters/canonicalContextRetrieval.mjs');
const gate = read('eval/gate.mjs');

describe('production read path (routes/chat.js) — the reference both adapters follow', () => {
  test('chat resolves the SERVED read mode and passes it to assembleContextAsync', () => {
    assert.match(chat, /await Brain\.resolveReadMode\(\)/);
    assert.match(chat, /Brain\.assembleContextAsync\(memoryOwner, userMessage, floorRetrieve, \{/);
    assert.match(chat, /canonicalOnly: readMode !== 'legacy'/);
  });
});

describe('legacy context suites', () => {
  test('state the legacy read explicitly instead of inheriting it from the environment', () => {
    assert.match(legacyAdapter, /export const LEGACY_READ = false;/);
    assert.match(legacyAdapter, /canonicalOnly: LEGACY_READ/);
  });

  test('call the function chat calls, not the synchronous variant', () => {
    assert.match(legacyAdapter, /await brain\.assembleContextAsync\(/);
    assert.doesNotMatch(legacyAdapter, /brain\.assembleContext\(/);
  });
});

describe('canonical context suite', () => {
  test('resolves the read mode as chat does and refuses to measure the legacy read', () => {
    assert.match(canonicalAdapter, /await brain\.resolveReadMode\(\)/);
    assert.match(canonicalAdapter, /canonicalOnly: read\.mode !== 'legacy'/);
    assert.match(canonicalAdapter, /refusing to measure the wrong path/);
    assert.match(canonicalAdapter, /await brain\.assembleContextAsync\(/);
  });

  test('writes claims through the production understanding path, replaying only the model', () => {
    assert.match(canonicalAdapter, /brain\.understandTurn\(\{/);
    assert.match(canonicalAdapter, /E6 replay miss/);
  });

  test('the suite declares that it needs Postgres', async () => {
    const suite = (await import('../suites/context-canonical.suite.mjs')).default;
    assert.deepEqual(suite.requires, ['postgres']);
    assert.equal(typeof suite.available, 'function');
  });
});

describe('the gate', () => {
  test('maps the database only from AQUA_TEST_DATABASE_URL', () => {
    assert.match(gate, /Object\.assign\(process\.env, testDatabaseEnv\(process\.env\)\)/);
  });

  const runGate = (env) => spawnSync(process.execPath, ['eval/gate.mjs', 'context-canonical'], {
    cwd: AQUA, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, AQUA_TEST_DATABASE_URL: '', DATABASE_URL: 'postgresql://must-not-be-used:1/x', ...env },
  });

  test('without a test database the canonical suite is NOT RUN, and an inherited DATABASE_URL is ignored', () => {
    const r = runGate({ AQUA_GATE_REQUIRE_DB: '' });
    const out = `${r.stdout}${r.stderr}`;
    assert.match(out, /context-canonical[\s\S]*NOT RUN — requires postgres/);
    assert.doesNotMatch(out, /must-not-be-used/);
    assert.doesNotMatch(out, /eval:gate passed\s*$/m, 'a gate that ran nothing must not print a bare pass');
  });

  test('with AQUA_GATE_REQUIRE_DB=1 a missing database fails the gate', () => {
    const r = runGate({ AQUA_GATE_REQUIRE_DB: '1' });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /NOT RUN/);
  });
});
