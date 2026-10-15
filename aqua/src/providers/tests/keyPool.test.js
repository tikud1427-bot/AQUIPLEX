/**
 * Shared provider key pool (keyPool.cjs) — discovery, credential state,
 * failure classification, the rotation loop, and observability.
 *
 * Pure unit tests: every pool here gets its own injected env, clock and state
 * store, so nothing depends on process.env, on test order, or on the network.
 * Fake secrets carry a marker ("SECRET") that every log/snapshot check hunts for.
 *
 * Run: node --test src/providers/tests/keyPool.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('../keyPool.cjs');
const { KeyPool, MemoryStateStore, discoverKeySlots, classifyKeyFailure, openRouterRateLimitScope, retryHintMs, runWithKeyRotation, getProviderUsageSnapshot } = lib;

const SECRET = (p, n) => `${p}-SECRET-${n}-value`;
const geminiEnv = (nums, extra = {}) => Object.fromEntries([...nums.map(n => [`GEMINI_KEY_${n}`, SECRET('gm', n)]), ...Object.entries(extra)]);

function makePool(provider, env, clock = { t: 1_000_000 }) {
  const pool = new KeyPool(provider, { env: () => env, now: () => clock.t, store: new MemoryStateStore() });
  return { pool, clock };
}

function httpErr(status, message = `HTTP ${status}`, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const quiet = () => {};

describe('discovery', () => {
  test('empty pool: no slots, hasKeys false, a clear config error from the loop', async () => {
    const { pool } = makePool('gemini', {});
    assert.deepEqual(pool.entries(), []);
    assert.equal(pool.hasKeys(), false);
    assert.equal(pool.msUntilAvailable(), null);
    assert.match(pool.snapshot().summary, /no credentials configured/);
    await assert.rejects(
      runWithKeyRotation({ pool, models: ['m'], attempt: async () => ({}), decide: () => ({ action: 'next_model' }), log: quiet }),
      e => e.code === 'NO_KEYS' && /No Gemini keys configured/.test(e.message));
  });

  test('blank and whitespace-only values are ignored and reported', () => {
    const env = { GEMINI_KEY_1: '', GEMINI_KEY_2: '   ', GEMINI_KEY_3: SECRET('gm', 3) };
    const d = discoverKeySlots('gemini', env);
    assert.deepEqual(d.slots.map(s => s.slot), ['#3']);
    assert.deepEqual(d.blanks.map(b => b.slot), ['#1', '#2']);
  });

  test('numeric (not lexicographic) order across 1..12 and beyond', () => {
    const env = geminiEnv([12, 1, 10, 2, 9, 11, 100, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(discoverKeySlots('gemini', env).slots.map(s => s.slot),
      ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9', '#10', '#11', '#12', '#100']);
  });

  test('GEMINI_KEY_9..12 are discovered with no hard-coded maximum', () => {
    const { pool } = makePool('gemini', geminiEnv([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    const slots = pool.entries().map(e => e.slot);
    for (const n of [9, 10, 11, 12]) assert.ok(slots.includes(`#${n}`), `#${n} missing`);
    assert.equal(pool.size(), 12);
  });

  test('sparse numbering is fine', () => {
    assert.deepEqual(discoverKeySlots('groq', { GROQ_API_KEY_2: 'a', GROQ_API_KEY_7: 'b' }).slots.map(s => s.slot), ['#2', '#7']);
  });

  test('duplicates across numbered slots AND the unnumbered key are used once, first slot wins', () => {
    const env = geminiEnv([1, 2, 3], { GEMINI_KEY_4: SECRET('gm', 2), GEMINI_API_KEY: SECRET('gm', 3) });
    const d = discoverKeySlots('gemini', env);
    assert.deepEqual(d.slots.map(s => s.slot), ['#1', '#2', '#3']);
    assert.deepEqual(d.duplicates.map(x => [x.slot, x.duplicateOf]), [['#4', '#2'], ['#bare', '#3']]);
    const snap = new KeyPool('gemini', { env: () => env }).snapshot();
    assert.equal(snap.discoveredSlots, 5);
    assert.equal(snap.distinctCredentials, 3);
    assert.match(snap.summary, /2 duplicate slot\(s\) ignored \(#4=#2, #bare=#3\)/);
  });

  test('backward compatibility: the unnumbered and legacy names are honoured for every provider', () => {
    assert.deepEqual(discoverKeySlots('gemini', { GEMINI_API_KEY: 'x' }).slots.map(s => s.slot), ['#bare']);
    assert.deepEqual(discoverKeySlots('gemini', { Gemini_API_Key: 'y' }).slots.map(s => s.slot), ['#legacy']);
    assert.deepEqual(discoverKeySlots('groq', { GROQ_API_KEY: 'x', GROQ_API_KEY_1: 'z' }).slots.map(s => s.slot), ['#1', '#bare']);
    assert.deepEqual(discoverKeySlots('openrouter', { OPENROUTER_API_KEY: 'x' }).slots.map(s => s.slot), ['#bare']);
    assert.deepEqual(discoverKeySlots('nvidia', { NVIDIA_API_KEY: 'x' }).slots.map(s => s.slot), ['#bare']);
  });

  test('refresh: the env is re-read, so a new slot joins and a REPLACED value starts fresh', () => {
    const env = geminiEnv([1, 2]);
    const { pool } = makePool('gemini', env);
    pool.reject(pool.entries()[0], 'auth');
    assert.equal(pool.availability().rejected, 1);
    env.GEMINI_KEY_13 = SECRET('gm', 13);
    assert.ok(pool.entries().some(e => e.slot === '#13'), 'a slot added at runtime is discovered');
    env.GEMINI_KEY_1 = SECRET('gm', 'rotated'); // operator replaced the bad key
    assert.equal(pool.availability().rejected, 0, 'a replaced credential is not tainted by the old one');
  });

  test('format is INFORMATIONAL: a non-standard value is reported, never excluded or deprioritised', () => {
    const env = { GEMINI_KEY_1: 'AQ.not-a-standard-shape-SECRET', GEMINI_API_KEY: `AIza${'x'.repeat(35)}` };
    const { pool } = makePool('gemini', env);
    const snap = pool.snapshot();
    assert.deepEqual(snap.unrecognizedFormat, ['#1']);
    assert.equal(snap.slots.find(s => s.slot === '#1').health, 'unknown', 'shape is not validity — not "rejected"');
    assert.equal(pool.acquire().slot, '#1', 'the non-standard slot still takes its round-robin turn first');
  });
});

describe('credential state', () => {
  test('round-robin is deterministic and skips cooling keys', () => {
    const { pool } = makePool('groq', { GROQ_API_KEY_1: 'a', GROQ_API_KEY_2: 'b', GROQ_API_KEY_3: 'c' });
    assert.deepEqual([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()].map(e => e.slot), ['#1', '#2', '#3', '#1']);
    pool.coolDown(pool.entries()[1], 10_000);
    assert.deepEqual([pool.acquire(), pool.acquire(), pool.acquire()].map(e => e.slot), ['#3', '#1', '#3']);
  });

  test('a cooldown expires on its own; a (key, model) cooldown blocks only that model', () => {
    const { pool, clock } = makePool('gemini', geminiEnv([1]));
    const e = pool.entries()[0];
    pool.coolDown(e, 5_000, { model: 'model-a' });
    assert.equal(pool.acquire({ model: 'model-a' }), null);
    assert.equal(pool.acquire({ model: 'model-b' }).slot, '#1', 'another model still has this key');
    assert.equal(pool.msUntilAvailable('model-a'), 5_000);
    clock.t += 5_001;
    assert.equal(pool.acquire({ model: 'model-a' }).slot, '#1');
  });

  test('a REJECTED key is not revived by time passing, only by reset (or a replaced value)', () => {
    const { pool, clock } = makePool('gemini', geminiEnv([1, 2]));
    pool.reject(pool.entries()[0], 'auth');
    clock.t += 30 * 86_400_000;
    assert.equal(pool.acquire().slot, '#2');
    assert.equal(pool.acquire().slot, '#2', '#1 is still quarantined a month later');
    assert.equal(pool.msUntilAvailable(), 0);
    pool.resetCredentials({ slot: '#1' });
    assert.ok([pool.acquire().slot, pool.acquire().slot].includes('#1'), 'administrative reset revives it');
  });

  test('operator opt-in AQUA_PROVIDER_KEY_REJECT_TTL_MS lets a rejected key expire', () => {
    const env = { ...geminiEnv([1]), AQUA_PROVIDER_KEY_REJECT_TTL_MS: '60000' };
    const { pool, clock } = makePool('gemini', env);
    pool.reject(pool.entries()[0], 'auth');
    assert.equal(pool.acquire(), null);
    clock.t += 60_001;
    assert.equal(pool.acquire().slot, '#1');
  });

  test('billing rejection carries a TTL; all-rejected pool reports null wait (waiting will not help)', () => {
    const { pool, clock } = makePool('nvidia', { NVIDIA_API_KEY_1: 'a' });
    pool.reject(pool.entries()[0], 'billing', { ttlMs: 1_000 });
    assert.equal(pool.msUntilAvailable(), null);
    clock.t += 1_001;
    assert.equal(pool.acquire().slot, '#1');
  });

  test('health: unknown until a call succeeds, verified after, rejected when refused', () => {
    const { pool } = makePool('groq', { GROQ_API_KEY_1: 'a', GROQ_API_KEY_2: 'b' });
    assert.deepEqual(pool.snapshot().slots.map(s => s.health), ['unknown', 'unknown']);
    assert.match(pool.snapshot().summary, /credential checks pending/);
    const [a, b] = pool.entries();
    pool.reportSuccess(a);
    pool.reject(b);
    assert.deepEqual(pool.snapshot().slots.map(s => s.health), ['verified', 'rejected']);
    assert.match(pool.snapshot().summary, /1 rejected; 1 verified, 0 unverified/);
  });

  test('snapshots never contain a secret, a fragment of one, or a hash-like digest of one', () => {
    const env = geminiEnv([1, 2, 3], { GEMINI_API_KEY: SECRET('gm', 2) });
    const { pool } = makePool('gemini', env);
    pool.reject(pool.entries()[0]);
    pool.coolDown(pool.entries()[1], 1_000, { model: 'm' });
    const json = JSON.stringify(pool.snapshot());
    assert.ok(!json.includes('SECRET'), 'a key value leaked into the snapshot');
    assert.ok(!/-value\b/.test(json), 'a key suffix leaked into the snapshot');
    assert.ok(!/[0-9a-f]{32,}/.test(json), 'something hash-shaped is in the snapshot');
  });
});

describe('failure classification (credential-relevant part)', () => {
  test('auth / billing / rate_limit / content / other', () => {
    assert.equal(classifyKeyFailure(httpErr(401)).kind, 'auth');
    assert.equal(classifyKeyFailure(httpErr(403, 'Forbidden')).kind, 'auth');
    assert.equal(classifyKeyFailure(httpErr(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}')).kind, 'auth');
    assert.equal(classifyKeyFailure(httpErr(400, 'API key expired. Please renew the API key.')).kind, 'auth');
    assert.equal(classifyKeyFailure(httpErr(400, 'Invalid value at contents[0]')).kind, 'other', 'a malformed request is not a key problem');
    assert.equal(classifyKeyFailure(httpErr(402, 'Insufficient credits')).kind, 'billing');
    assert.equal(classifyKeyFailure(httpErr(403, 'Your input was flagged by moderation')).kind, 'content', 'a moderation refusal must not quarantine the key');
    assert.equal(classifyKeyFailure(httpErr(429)).kind, 'rate_limit');
    assert.equal(classifyKeyFailure(httpErr(503)).kind, 'other');
    assert.equal(classifyKeyFailure(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })).kind, 'other');
    assert.equal(classifyKeyFailure(new Error('invalid api key')).kind, 'other', 'wording without a status never quarantines a key');
  });

  test('retry hints from every provider shape', () => {
    const now = 1_700_000_000_000;
    assert.equal(retryHintMs(httpErr(429, 'x', { headers: { 'retry-after': '7' } })), 7_000);
    assert.equal(retryHintMs(httpErr(429, 'x', { response: { headers: { 'Retry-After': '3' } } })), 3_000);
    assert.equal(retryHintMs(httpErr(429, 'x', { headers: { 'x-ratelimit-reset-requests': '2m59.56s' } })), 179_560);
    assert.equal(retryHintMs(httpErr(429, '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"31s"}]}}')), 31_000);
    assert.equal(retryHintMs(httpErr(429, 'Quota exceeded. Please retry in 12.5s.')), 12_500);
    assert.equal(retryHintMs(httpErr(429, 'x', { error: { metadata: { headers: { 'X-RateLimit-Reset': String(now + 45_000) } } } }), now), 45_000);
    assert.equal(retryHintMs(httpErr(429, 'no hint here')), null);
  });

  test('OpenRouter 429 scope: account limits are KEY-scoped, upstream saturation is MODEL-scoped', () => {
    assert.equal(openRouterRateLimitScope(httpErr(429, 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day')), 'key');
    assert.equal(openRouterRateLimitScope(httpErr(429, 'meta-llama/llama-3.3-70b-instruct:free is temporarily rate-limited upstream. Please retry shortly')), 'model');
    assert.equal(openRouterRateLimitScope(httpErr(429, 'Too Many Requests')), 'model', 'unrecognised → the pre-existing model scope');
  });
});

describe('the rotation loop', () => {
  const decideKeyScoped = err => {
    const k = classifyKeyFailure(err);
    if (k.kind === 'auth') return { action: 'key_rejected' };
    if (k.kind === 'billing') return { action: 'key_billing', ttlMs: 60_000 };
    if (k.kind === 'rate_limit') return { action: 'key_rate_limited', cooldownMs: k.retryAfterMs ?? 30_000 };
    return { action: 'next_model' };
  };
  const pool3 = () => makePool('groq', { GROQ_API_KEY_1: SECRET('gq', 1), GROQ_API_KEY_2: SECRET('gq', 2), GROQ_API_KEY_3: SECRET('gq', 3) });
  const slotOf = key => /gq-SECRET-(\d+)/.exec(key)[1];

  test('429 on the first key → the SAME request succeeds on the next key; the good key is not penalised', async () => {
    const { pool } = pool3();
    const seen = [];
    const r = await runWithKeyRotation({
      pool, models: ['m'], decide: decideKeyScoped, log: quiet,
      attempt: async ({ key }) => { seen.push(slotOf(key)); if (slotOf(key) === '1') throw httpErr(429, 'x', { headers: { 'retry-after': '9' } }); return { text: 'ok' }; },
    });
    assert.deepEqual(seen, ['1', '2']);
    assert.equal(r.keySlot, '#2');
    assert.equal(r.keyAttempts, 2);
    const snap = pool.snapshot();
    assert.equal(snap.slots[0].status, 'cooling');
    assert.ok(snap.slots[0].cooldownRemainingMs <= 9_000 && snap.slots[0].cooldownRemainingMs > 8_000, 'Retry-After respected');
    assert.equal(snap.slots[1].status, 'available');
    assert.equal(snap.slots[1].health, 'verified');
  });

  test('401 on the first key → next key succeeds; rejections do not spend the attempt budget', async () => {
    const { pool } = pool3();
    const r = await runWithKeyRotation({
      pool, models: ['m'], decide: decideKeyScoped, log: quiet, maxKeysPerModel: 1, maxAttempts: 1,
      attempt: async ({ key }) => { if (slotOf(key) !== '3') throw httpErr(401); return { text: 'ok' }; },
    });
    assert.equal(r.keySlot, '#3', 'two rejections, then the one budgeted attempt');
  });

  test('a model-scoped failure moves to the next model and touches no key', async () => {
    const { pool } = pool3();
    const calls = [];
    const r = await runWithKeyRotation({
      pool, models: ['dead', 'alive'], log: quiet,
      decide: () => ({ action: 'next_model' }),
      attempt: async ({ modelId, slot }) => { calls.push(`${modelId}@${slot}`); if (modelId === 'dead') throw httpErr(404); return { text: 'ok', model: modelId }; },
    });
    assert.deepEqual(calls, ['dead@#1', 'alive@#2']);
    assert.equal(r.model, 'alive');
    assert.equal(pool.availability().available, 3, 'no key cooled or rejected by a model failure');
  });

  test('every key cooling → ONE structured, retryable wait carrying the soonest free time', async () => {
    const { pool } = pool3();
    const waits = { 1: '30', 2: '5', 3: '12' };
    await assert.rejects(runWithKeyRotation({
      pool, models: ['m'], decide: decideKeyScoped, log: quiet,
      attempt: async ({ key }) => { throw httpErr(429, 'x', { headers: { 'retry-after': waits[slotOf(key)] } }); },
    }), e => e.code === 'ALL_KEYS_COOLING' && e.status === 429 && e.retryAfterMs === 5_000);
    // While cooling, the next call sends nothing and fails fast with the wait.
    let sent = 0;
    await assert.rejects(runWithKeyRotation({ pool, models: ['m'], decide: decideKeyScoped, log: quiet, attempt: async () => { sent++; } }),
      e => e.code === 'ALL_KEYS_COOLING');
    assert.equal(sent, 0);
  });

  test('every key rejected → a clear, terminal auth error; later calls send nothing', async () => {
    const { pool } = pool3();
    await assert.rejects(runWithKeyRotation({ pool, models: ['m'], decide: decideKeyScoped, log: quiet, attempt: async () => { throw httpErr(403); } }),
      e => e.code === 'ALL_KEYS_REJECTED' && e.status === 401);
    let sent = 0;
    await assert.rejects(runWithKeyRotation({ pool, models: ['m'], decide: decideKeyScoped, log: quiet, attempt: async () => { sent++; } }),
      e => e.code === 'ALL_KEYS_REJECTED');
    assert.equal(sent, 0);
  });

  test('every key out of credits → ALL_KEYS_BILLING (402), not a fake rate-limit wait', async () => {
    const { pool } = pool3();
    await assert.rejects(runWithKeyRotation({ pool, models: ['m'], decide: decideKeyScoped, log: quiet, attempt: async () => { throw httpErr(402); } }),
      e => e.code === 'ALL_KEYS_BILLING' && e.status === 402);
  });

  test('retries stop at the configured limits', async () => {
    const env = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`GROQ_API_KEY_${i + 1}`, `k${i}`]));
    const { pool } = makePool('groq', env);
    let n = 0;
    await assert.rejects(runWithKeyRotation({
      pool, models: ['a', 'b'], log: quiet, maxKeysPerModel: 3, maxAttempts: 4,
      decide: (_e, { modelId }) => ({ action: 'key_rate_limited', cooldownMs: 1_000, model: modelId }),
      attempt: async () => { n++; throw httpErr(429); },
    }));
    assert.equal(n, 4, '3 on model a, then 1 on model b, then the request budget is spent');
  });

  test('an aborted signal stops further attempts', async () => {
    const { pool } = pool3();
    const ac = new AbortController();
    let n = 0;
    await assert.rejects(runWithKeyRotation({
      pool, models: ['m'], decide: decideKeyScoped, log: quiet, signal: ac.signal,
      attempt: async () => { n++; ac.abort(); throw httpErr(429); },
    }), /TIMEOUT/);
    assert.equal(n, 1);
    ac.abort();
    let m = 0;
    await assert.rejects(runWithKeyRotation({ pool, models: ['m'], decide: decideKeyScoped, log: quiet, signal: ac.signal, attempt: async () => { m++; } }), /TIMEOUT/);
    assert.equal(m, 0, 'already-aborted → no request');
  });

  test('a streaming partial (content already emitted) is returned, never retried on another key', async () => {
    const { pool } = pool3();
    let n = 0;
    const r = await runWithKeyRotation({
      pool, models: ['m'], decide: decideKeyScoped, log: quiet,
      attempt: async () => { n++; throw Object.assign(new Error('socket hang up'), { partial: { text: 'half', finishReason: 'interrupted' } }); },
    });
    assert.equal(n, 1);
    assert.equal(r.text, 'half');
    assert.equal(r.finishReason, 'interrupted');
  });

  test('logs carry slot labels only', async () => {
    const { pool } = pool3();
    const logs = [];
    await runWithKeyRotation({
      pool, models: ['m'], decide: decideKeyScoped, log: l => logs.push(l),
      attempt: async ({ key }) => { if (slotOf(key) === '1') throw httpErr(401); return { text: 'ok' }; },
    });
    assert.ok(logs.some(l => /key=#1/.test(l)) && logs.some(l => /key=#2/.test(l)));
    assert.ok(!logs.some(l => l.includes('SECRET')), 'a key reached a log line');
  });
});

describe('usage observability', () => {
  test('one success records usage once; failed attempts carry no tokens; unknown usage stays null', async () => {
    lib.__resetForTests();
    const { pool } = makePool('openrouter', { OPENROUTER_API_KEY_1: 'a', OPENROUTER_API_KEY_2: 'b' });
    await runWithKeyRotation({
      pool, models: ['obs-model'], purpose: 'chat', log: quiet,
      decide: () => ({ action: 'key_rate_limited', cooldownMs: 1_000 }),
      attempt: async ({ slot }) => { if (slot === '#1') throw httpErr(429); return { text: 'ok', usage: { inputTokens: 10, outputTokens: 4 } }; },
    });
    await runWithKeyRotation({
      pool, models: ['obs-model-2'], purpose: 'chat', log: quiet, decide: () => ({ action: 'next_model' }),
      attempt: async () => ({ text: 'ok', usage: null }),
    });
    const rows = getProviderUsageSnapshot().filter(r => r.provider === 'openrouter');
    const ok = rows.find(r => r.model === 'obs-model' && r.slot === '#2');
    const failed = rows.find(r => r.model === 'obs-model' && r.slot === '#1');
    assert.deepEqual([ok.successes, ok.inputTokens, ok.outputTokens, ok.keySwitches], [1, 10, 4, 1]);
    assert.deepEqual([failed.failures, failed.inputTokens, failed.rateLimited], [1, null, 1], 'a failed attempt has unknown (null) tokens, not 0');
    const unk = rows.find(r => r.model === 'obs-model-2');
    assert.equal(unk.inputTokens, null);
    assert.equal(unk.callsWithUnreportedUsage, 1);
  });
});
