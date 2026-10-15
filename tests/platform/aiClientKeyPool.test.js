/**
 * services/ai.client.js — numbered key pools for Groq / OpenRouter / Gemini,
 * the same pool (one module instance) as the engine, cascade order unchanged.
 *
 * Offline: axios.post is replaced for each test, every provider variable is
 * removed and replaced with fakes, and logs are checked for key material.
 *
 * Run: node --test tests/platform/aiClientKeyPool.test.js
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const POOL = path.join(ROOT, 'aqua', 'src', 'providers', 'keyPool.cjs');
const CLIENT = path.join(ROOT, 'services', 'ai.client.js');
const axios = require('axios');

const STRIP = /^(GROQ_|OPENROUTER_|GEMINI_|Gemini_|NVIDIA_)/;
let savedEnv, realPost, logs;
const realLog = console.log, realWarn = console.warn, realErr = console.error;

function freshClient() {
  delete require.cache[require.resolve(CLIENT)];
  delete require.cache[require.resolve(POOL)];
  return require(CLIENT);
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of Object.keys(process.env)) if (STRIP.test(k)) delete process.env[k];
  realPost = axios.post;
  logs = [];
  const cap = (...a) => logs.push(a.map(String).join(' '));
  console.log = cap; console.warn = cap; console.error = cap;
});

afterEach(() => {
  axios.post = realPost;
  console.log = realLog; console.warn = realWarn; console.error = realErr;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

const bearerSlot = cfg => /SECRET-(\w+)/.exec(cfg?.headers?.Authorization ?? '')?.[1];
const googSlot = cfg => /SECRET-(\w+)/.exec(cfg?.headers?.['x-goog-api-key'] ?? '')?.[1];
const ok = content => ({ data: { choices: [{ message: { content } }] } });
const fail = (status, headers = {}, data = {}) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, headers, data } });
const provider = url => (url.includes('groq.com') ? 'groq' : url.includes('openrouter.ai') ? 'openrouter' : url.includes('googleapis.com') ? 'gemini' : url.includes('nvidia') ? 'nvidia' : '?');
const tiny = [{ role: 'user', content: 'hello' }];

describe('ai.client — Groq numbered pool', () => {
  test('GROQ_API_KEY_1..N alone (no unnumbered key) now reaches Groq', async () => {
    for (const n of [1, 2]) process.env[`GROQ_API_KEY_${n}`] = `gq-SECRET-${n}`;
    const seen = [];
    axios.post = async (url, _b, cfg) => { seen.push([provider(url), bearerSlot(cfg)]); return ok('groq answer'); };
    assert.equal(await freshClient().generateAI(tiny), 'groq answer');
    assert.deepEqual(seen, [['groq', '1']]);
  });

  test('429 on one key → the same request on the next key; that key then rests (no provider-wide cooldown)', async () => {
    for (const n of [1, 2, 3]) process.env[`GROQ_API_KEY_${n}`] = `gq-SECRET-${n}`;
    process.env.GROQ_API_KEY = 'gq-SECRET-bare';
    const slots = [];
    axios.post = async (url, _b, cfg) => {
      const s = bearerSlot(cfg); slots.push(s);
      if (s === '1') throw fail(429, { 'retry-after': '30' });
      return ok(`from ${s}`);
    };
    const { generateAI } = freshClient();
    assert.equal(await generateAI(tiny), 'from 2');
    assert.equal(await generateAI(tiny), 'from 3');
    assert.equal(await generateAI(tiny), 'from bare', 'the unnumbered key is part of the same pool');
    assert.equal(await generateAI(tiny), 'from 2', '#1 is cooling');
    assert.deepEqual(slots, ['1', '2', '3', 'bare', '2'], 'no same-key retry after a 429');
  });

  test('401 quarantines that key only; the request continues on the next key', async () => {
    for (const n of [1, 2]) process.env[`GROQ_API_KEY_${n}`] = `gq-SECRET-${n}`;
    const slots = [];
    axios.post = async (url, _b, cfg) => { const s = bearerSlot(cfg); slots.push(s); if (s === '1') throw fail(401); return ok('fine'); };
    const { generateAI } = freshClient();
    for (let i = 0; i < 3; i++) assert.equal(await generateAI(tiny), 'fine');
    assert.deepEqual(slots, ['1', '2', '2', '2']);
  });

  test('every Groq key throttled → cascade continues to OpenRouter (order unchanged)', async () => {
    for (const n of [1, 2]) process.env[`GROQ_API_KEY_${n}`] = `gq-SECRET-${n}`;
    process.env.OPENROUTER_API_KEY_1 = 'or-SECRET-1';
    const order = [];
    axios.post = async (url) => { order.push(provider(url)); if (provider(url) === 'groq') throw fail(429); return ok('openrouter answer'); };
    assert.equal(await freshClient().generateAI(tiny), 'openrouter answer');
    assert.deepEqual(order, ['groq', 'groq', 'openrouter']);
  });
});

describe('ai.client — OpenRouter and Gemini pools', () => {
  test('OpenRouter: numbered keys alone work; an account-limit 429 moves to the next key', async () => {
    for (const n of [1, 2]) process.env[`OPENROUTER_API_KEY_${n}`] = `or-SECRET-${n}`;
    const slots = [];
    axios.post = async (url, _b, cfg) => {
      const s = bearerSlot(cfg); slots.push(s);
      if (s === '1') throw fail(429, {}, { error: { message: 'Rate limit exceeded: free-models-per-day' } });
      return ok('or');
    };
    assert.equal(await freshClient().generateAI(tiny), 'or');
    assert.deepEqual(slots, ['1', '2']);
  });

  test('Gemini: GEMINI_KEY_9..12 are discovered; the key travels in a header, never the URL', async () => {
    for (const n of [9, 10, 11, 12]) process.env[`GEMINI_KEY_${n}`] = `gm-SECRET-${n}`;
    const seen = [];
    axios.post = async (url, _b, cfg) => {
      seen.push({ url, slot: googSlot(cfg) });
      return { data: { candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }] } };
    };
    assert.equal(await freshClient().generateAI(tiny), 'gemini answer');
    assert.equal(seen[0].slot, '9');
    assert.ok(!seen[0].url.includes('key='), 'a credential was put in the query string');
    assert.ok(!seen[0].url.includes('SECRET'));
  });

  test('Gemini: an invalid key (400 API_KEY_INVALID) is skipped, not fatal to the provider', async () => {
    process.env.GEMINI_KEY_1 = 'gm-SECRET-1';
    process.env.GEMINI_API_KEY = 'gm-SECRET-bare';
    const slots = [];
    axios.post = async (_url, _b, cfg) => {
      const s = googSlot(cfg); slots.push(s);
      if (s === '1') throw fail(400, {}, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
      return { data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };
    };
    assert.equal(await freshClient().generateAI(tiny), 'ok');
    assert.deepEqual(slots, ['1', 'bare']);
  });
});

describe('ai.client — contracts', () => {
  test('total failure keeps the ALL_PROVIDERS_FAILED message; adds code and a wait hint when only cooling', async () => {
    process.env.GROQ_API_KEY_1 = 'gq-SECRET-1';
    axios.post = async () => { throw fail(429, { 'retry-after': '42' }); };
    await assert.rejects(freshClient().generateAI(tiny), e => {
      assert.match(e.message, /ALL_PROVIDERS_FAILED/);
      assert.equal(e.code, 'ALL_PROVIDERS_FAILED');
      assert.ok(e.retryAfterMs > 40_000 && e.retryAfterMs <= 42_000, `retryAfterMs=${e.retryAfterMs}`);
      return true;
    });
  });

  test('generateSearch (no Serper key) still answers through generateAI', async () => {
    process.env.GROQ_API_KEY_1 = 'gq-SECRET-1';
    delete process.env.SERPER_API_KEY;
    axios.post = async () => ok('search answer');
    const r = await freshClient().generateSearch(tiny);
    assert.deepEqual(r, { message: 'search answer', sources: [] });
  });

  test('ONE cooldown system: the platform client and the engine share the same pool instance', async () => {
    process.env.GROQ_API_KEY_1 = 'gq-SECRET-1';
    process.env.GROQ_API_KEY_2 = 'gq-SECRET-2';
    axios.post = async (_u, _b, cfg) => { if (bearerSlot(cfg) === '1') throw fail(401); return ok('x'); };
    freshClient();
    const fromRequire = require(POOL);
    await require(CLIENT).generateAI(tiny);
    const fromImport = (await import(require('node:url').pathToFileURL(POOL).href)).default;
    assert.equal(fromImport.getKeyPool('groq'), fromRequire.getKeyPool('groq'), 'ESM import and CJS require see one pool');
    assert.equal(fromImport.getKeyPool('groq').snapshot().slots.find(s => s.slot === '#1').status, 'rejected',
      'a key rejected on the platform path is rejected for the engine too');
  });

  test('no key value reaches a log line', async () => {
    for (const n of [1, 2]) process.env[`GROQ_API_KEY_${n}`] = `gq-SECRET-${n}`;
    process.env.GEMINI_KEY_1 = 'gm-SECRET-1';
    axios.post = async () => { throw fail(401); };
    await assert.rejects(freshClient().generateAI(tiny));
    assert.ok(logs.some(l => /key=#\d/.test(l)), 'logs should name key slots');
    assert.ok(!logs.some(l => l.includes('SECRET')), 'a key leaked into a log');
  });
});
