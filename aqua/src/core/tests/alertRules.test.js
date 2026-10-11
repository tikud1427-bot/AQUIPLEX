/**
 * Alert rules reference only metrics the code actually emits — an alert on a
 * metric nobody exports never fires, which is a dark stage (L13).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.resolve(HERE, '..', '..', '..', '..', 'ops', 'prometheus', 'aqua-alerts.yml');
const EXPOSITION = path.resolve(HERE, '..', 'metricsExposition.js');

test('every metric in the alert rules is emitted by metricsExposition.js', { skip: existsSync(RULES) ? false : 'ops/ not present in this checkout' }, () => {
  const rules = readFileSync(RULES, 'utf8');
  const emitted = new Set([...readFileSync(EXPOSITION, 'utf8').matchAll(/emit\('(aqua_[a-z0-9_]+)'/g)].map(m => m[1]));
  const used = new Set([...rules.matchAll(/\b(aqua_[a-z0-9_]+)\b/g)].map(m => m[1]));
  const missing = [...used].filter(m => !emitted.has(m));
  assert.deepEqual(missing, [], `alert rules reference metrics nothing emits: ${missing.join(', ')}`);
  assert.ok(used.size >= 8);
});

// Emitted is not fed. aqua_request_* and aqua_provider_* (two of the alerts)
// are written only by logCompletion(), which had no caller from the initial
// commit until 2026-10-05: /metrics showed aqua_requests_total 0 after 30 live
// chats, no provider series existed, and both alerts could never fire.
test('the recorder behind the request/provider alerts is called by both chat paths', () => {
  const chat = readFileSync(path.resolve(HERE, '..', '..', 'routes', 'chat.js'), 'utf8');
  const calls = [...chat.matchAll(/logCompletion\(ctx, \{ (error: err|taskType)/g)].map(m => m[1]);
  assert.deepEqual(calls.sort(), ['error: err', 'error: err', 'taskType', 'taskType'],
    'POST /chat and /chat/stream must each record success and failure');
});
