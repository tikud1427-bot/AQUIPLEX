/**
 * E11 closure guard (2026-10-04). Every AQUA route answers through the shared
 * envelope, with three deliberate, pinned exceptions:
 *   · chat.js / brain.js build some envelopes by hand because the body is a
 *     pre-built payload (chat SSE/edit/artifact turns) — they still carry a
 *     taxonomy `code` on every failure;
 *   · brain.js keeps the DOMAIN code `WORLD_MODEL_UNAVAILABLE` on its 503s,
 *     and project/artifacts edit routes keep their engine's domain codes — the
 *     same decision recorded in PATCH_2026-10-06: replacing a code external
 *     /v1 clients may read is a product call, not a refactor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = /res\.status\([^)]*\)\.json\(|res\.json\(/;

test('no route file outside the pinned exceptions bypasses ok()/fail()', () => {
  const offenders = fs.readdirSync(DIR).filter(f => f.endsWith('.js'))
    .filter(f => !['chat.js', 'brain.js', 'envelope.js'].includes(f))
    .filter(f => RAW.test(fs.readFileSync(path.join(DIR, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('every hand-built failure in chat.js and brain.js carries a code', () => {
  for (const f of ['chat.js', 'brain.js']) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const m of src.matchAll(/res\.status\([^)]*\)\.json\(\{([\s\S]{0,240})/g)) {
      assert.match(m[1], /code:/, `${f}: a failure without a code: ${m[0].slice(0, 120)}`);
    }
  }
});

test('brain 503 keeps its domain code (deliberate, see header)', () => {
  assert.match(fs.readFileSync(path.join(DIR, 'brain.js'), 'utf8'), /res\.status\(503\)\.json\(\{ success: false, code: 'WORLD_MODEL_UNAVAILABLE'/);
});
