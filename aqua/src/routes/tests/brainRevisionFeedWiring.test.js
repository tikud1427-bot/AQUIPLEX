import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(path.join(here, '..', 'brain.js'), 'utf8');

test('Brain /changes uses the canonical revision feed with legacy fallback', () => {
  assert.match(routes, /getRevisionFeed/);
  assert.match(routes, /router\.get\('\/changes', guarded\(async/);
  assert.match(routes, /legacyReader/);
});

test('Brain guarded wrapper catches rejected async route handlers', () => {
  assert.match(routes, /const result = handler\(req, res\);/);
  assert.match(routes, /result\.catch\(err =>/);
  assert.match(routes, /if \(!res\.headersSent\)/);
});
