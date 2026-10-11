/**
 * The Redis rate-limit backend against a REAL Redis, through the REAL
 * express-rate-limit v8: two stores stand for two server processes and must
 * share one window. Skips visibly without AQUA_TEST_REDIS_URL, e.g.
 *   docker run -d -p 56379:6379 redis:7-alpine redis-server --requirepass aquatest
 *   AQUA_TEST_REDIS_URL=redis://:aquatest@127.0.0.1:56379/2
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const req = createRequire(path.join(PLATFORM, 'package.json'));
const { createRateLimitStore, redisBackend, backendFromEnv } = req('./utils/rateLimitStore.js');
let express, rateLimit;
try { express = req('express'); ({ rateLimit } = req('express-rate-limit')); } catch { /* absent */ }

const URL_ = process.env.AQUA_TEST_REDIS_URL;
const skip = !URL_ ? 'needs a real Redis — set AQUA_TEST_REDIS_URL (see header)'
  : !(express && rateLimit) ? 'platform dependencies (express, express-rate-limit) are not installed' : false;
const prefix = `rl-test-${Date.now().toString(36)}`;
const backends = [];
after(() => backends.forEach(b => b.close?.()));

function serve(backend) {
  const app = express();
  app.use(rateLimit({ store: createRateLimitStore({ prefix, backend }), windowMs: 60_000, limit: 3,
    standardHeaders: 'draft-7', legacyHeaders: false }));
  app.get('/', (_q, r) => r.send('ok'));
  return app.listen(0);
}

test('two processes share ONE window through Redis (the in-memory store doubled it)', { skip }, async () => {
  const a = redisBackend({ url: URL_ }); const b = redisBackend({ url: URL_ });
  backends.push(a, b);
  const sa = serve(a); const sb = serve(b);
  try {
    const get = s => fetch(`http://127.0.0.1:${s.address().port}/`).then(r => r.status);
    const codes = [await get(sa), await get(sb), await get(sa), await get(sb), await get(sa)];
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal(a.stats.fallbacks + b.stats.fallbacks, 0, 'Redis was not actually used');
  } finally { sa.close(); sb.close(); }
});

test('hit sets the window TTL; undo and reset are atomic and owner of nothing else', { skip }, async () => {
  const r = redisBackend({ url: URL_ }); backends.push(r);
  const key = `${prefix}:unit`;
  const h1 = await r.hit(key, 5000);
  const h2 = await r.hit(key, 5000);
  assert.deepEqual([h1.count, h2.count], [1, 2]);
  assert.ok(h2.resetAt - Date.now() <= 5000 && h2.resetAt - Date.now() > 3000);
  await r.undo(key);
  assert.equal((await r.hit(key, 5000)).count, 2);
  await r.reset(key);
  assert.equal((await r.hit(key, 5000)).count, 1);
  await r.reset(key);
  await r.undo(key);                                  // never below zero
  assert.equal((await r.hit(key, 5000)).count, 1);
});

test('Redis unreachable: degrades to per-process counting, counted, never throws', async () => {
  const warned = [];
  const r = redisBackend({ url: 'redis://127.0.0.1:1', onFallback: e => warned.push(e) }); backends.push(r);
  assert.equal((await r.hit('k', 1000)).count, 1);
  assert.equal((await r.hit('k', 1000)).count, 2);
  assert.equal(r.stats.fallbacks, 2);
  assert.ok(warned.length === 2);
});

test('backendFromEnv: memory unless AQUA_RATE_LIMIT_REDIS_URL is set', () => {
  assert.equal(backendFromEnv({}).kind, 'memory');
  const r = backendFromEnv({ AQUA_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:1' });
  assert.equal(r.kind, 'redis'); r.close();
});
