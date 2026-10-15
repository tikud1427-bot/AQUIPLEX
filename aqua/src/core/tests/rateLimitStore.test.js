/**
 * The platform's rate-limit store adapter, exercised through the REAL
 * express-rate-limit v8 the platform uses (root dependency), so the Store
 * interface compatibility is proven rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const req = createRequire(path.join(PLATFORM, 'package.json'));
const { createRateLimitStore, memoryBackend } = req('./utils/rateLimitStore.js');

let express, rateLimit;
try { express = req('express'); ({ rateLimit } = req('express-rate-limit')); } catch { /* platform deps absent */ }
const skip = express && rateLimit ? false : 'platform dependencies (express, express-rate-limit) are not installed';

test('the store enforces the limit through express-rate-limit v8', { skip }, async () => {
  const app = express();
  app.use(rateLimit({ store: createRateLimitStore({ prefix: 't' }), windowMs: 60_000, limit: 2,
    standardHeaders: 'draft-7', legacyHeaders: false }));
  app.get('/', (_q, r) => r.send('ok'));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(url)).status);
    assert.deepEqual(codes, [200, 200, 429]);
  } finally { server.close(); }
});

test('backend contract: a custom (shared) backend receives every hit, undo and reset', async () => {
  const calls = [];
  const backend = {
    kind: 'fake-shared',
    hit: async (key, windowMs) => { calls.push(['hit', key, windowMs]); return { count: 1, resetAt: 1000 }; },
    undo: async key => calls.push(['undo', key]),
    reset: async key => calls.push(['reset', key]),
  };
  const store = createRateLimitStore({ prefix: 'auth', backend });
  store.init({ windowMs: 900_000 });
  const r = await store.increment('1.2.3.4');
  await store.decrement('1.2.3.4'); await store.resetKey('1.2.3.4');
  assert.equal(r.totalHits, 1);
  assert.deepEqual(calls, [['hit', 'auth:1.2.3.4', 900_000], ['undo', 'auth:1.2.3.4'], ['reset', 'auth:1.2.3.4']]);
  assert.equal(store.localKeys, false, 'a shared backend must not claim local keys');
});

test('memory backend: fixed window, and bounded (G6)', () => {
  const b = memoryBackend({ maxKeys: 10 });
  assert.equal(b.hit('k', 1000, 0).count, 1);
  assert.equal(b.hit('k', 1000, 500).count, 2);
  assert.equal(b.hit('k', 1000, 1500).count, 1, 'a new window starts after resetAt');
  for (let i = 0; i < 50; i++) b.hit(`x${i}`, 1000, 2000);
  assert.ok(b._size() <= 10);
});
