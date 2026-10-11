/**
 * services/ai.client.js — NVIDIA as the final fallback, with its own key pool.
 *
 * Offline: axios.post is replaced for the duration of each test, every other
 * provider key is removed so the cascade reaches NVIDIA, and the fake keys are
 * checked against everything logged.
 *
 * Run: node --test tests/platform/nvidiaFallback.test.js
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const axios = require('axios');

const STRIP = /^(GROQ_|OPENROUTER_|GEMINI_|Gemini_|NVIDIA_)/;
let savedEnv, realPost, logs;
const realLog = console.log, realWarn = console.warn, realErr = console.error;

function freshClient() {
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'ai.client.js'))];
  return require(path.join(ROOT, 'services', 'ai.client.js'));
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of Object.keys(process.env)) if (STRIP.test(k)) delete process.env[k];
  for (let i = 1; i <= 3; i++) process.env[`NVIDIA_API_KEY_${i}`] = `nv-root-secret-${i}`;
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

const slotOf = cfg => /nv-root-secret-(\d)/.exec(cfg.headers.Authorization)?.[1];

describe('ai.client — NVIDIA fallback', () => {
  test('with no other provider configured, NVIDIA answers; Aqua identity prompt is still sent', async () => {
    const seen = [];
    axios.post = async (url, body, cfg) => {
      seen.push({ url, body, slot: slotOf(cfg) });
      return { data: { choices: [{ message: { content: 'nvidia answer' } }] } };
    };
    const { generateAI } = freshClient();
    const out = await generateAI([{ role: 'user', content: 'hello' }]);
    assert.equal(out, 'nvidia answer');
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /integrate\.api\.nvidia\.com\/v1\/chat\/completions$/);
    assert.equal(seen[0].body.model, 'openai/gpt-oss-20b');
    assert.match(seen[0].body.messages[0].content, /Aqua AI/);
  });

  test('a 429 on one key moves to the next key; that key is skipped afterwards', async () => {
    const slots = [];
    axios.post = async (_url, _body, cfg) => {
      const s = slotOf(cfg);
      slots.push(s);
      if (s === '1') throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, headers: { 'retry-after': '30' } } });
      return { data: { choices: [{ message: { content: `from ${s}` } }] } };
    };
    const { generateAI } = freshClient();
    assert.equal(await generateAI([{ role: 'user', content: 'a' }]), 'from 2');
    assert.equal(await generateAI([{ role: 'user', content: 'b' }]), 'from 3');
    assert.equal(await generateAI([{ role: 'user', content: 'c' }]), 'from 2', 'key #1 is cooling');
    assert.deepEqual(slots, ['1', '2', '3', '2']);
  });

  test('every key failing → ALL_PROVIDERS_FAILED (unchanged terminal contract)', async () => {
    axios.post = async () => { throw Object.assign(new Error('401'), { response: { status: 401 } }); };
    const { generateAI } = freshClient();
    await assert.rejects(generateAI([{ role: 'user', content: 'x' }]), /ALL_PROVIDERS_FAILED/);
  });

  test('no key value ever reaches a log line', async () => {
    axios.post = async () => { throw Object.assign(new Error('429'), { response: { status: 429, headers: {} } }); };
    const { generateAI } = freshClient();
    await assert.rejects(generateAI([{ role: 'user', content: 'x' }]));
    assert.ok(logs.some(l => /key=#\d/.test(l)), 'logs should name key slots');
    assert.ok(!logs.some(l => l.includes('nv-root-secret')), 'a key leaked into a log');
  });
});
