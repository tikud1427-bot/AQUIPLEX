/**
 * Key-pool diagnostics: the offline doctor report, the opt-in probe's
 * classification, and the startup summary — none of which may print a secret,
 * call a credential "valid" because it is populated, or touch the network
 * unless asked.
 *
 * Offline: the probe runs against an injected fake fetch.
 *
 * Run: node --test src/providers/tests/providerKeysDoctor.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { offlineReport, probeOne, parseEnvText } from '../../../scripts/provider-keys-doctor.mjs';

const env = parseEnvText([
  '# comment',
  ...Array.from({ length: 12 }, (_, i) => `GEMINI_KEY_${i + 1}=AQ.ephemeral-SECRET-${i + 1}`),
  `GEMINI_API_KEY=AIza${'S'.repeat(35)}`,
  'GROQ_API_KEY=gsk_SECRETSECRETSECRETSECRET1',
  'GROQ_API_KEY_1=gsk_SECRETSECRETSECRETSECRET1',
  'OPENROUTER_API_KEY_2=',
].join('\n'));

describe('offline doctor report', () => {
  test('counts slots, ignores duplicates and blanks, flags (never rejects) non-standard shapes', () => {
    const r = offlineReport(env);
    assert.equal(r.gemini.distinctCredentials, 13);
    assert.deepEqual(r.gemini.slots.slice(8, 12).map(s => s.slot), ['#9', '#10', '#11', '#12']);
    assert.equal(r.gemini.slots.filter(s => s.format.startsWith('non-standard')).length, 12);
    assert.match(r.gemini.summary, /credential checks pending/);
    assert.doesNotMatch(r.gemini.summary, /valid\b(?! )/, 'a populated slot must not be called valid');
    assert.equal(r.groq.distinctCredentials, 1);
    assert.deepEqual(r.groq.duplicateSlotsIgnored, [{ slot: '#bare', duplicateOf: '#1' }]);
    assert.deepEqual(r.openrouter.blankSlotsIgnored, ['#2']);
    assert.equal(r.nvidia.distinctCredentials, 0);
  });

  test('the report carries no key material', () => {
    const json = JSON.stringify(offlineReport(env));
    assert.ok(!json.includes('SECRET'));
    assert.ok(!json.includes('S'.repeat(35)), 'the standard-format fake key leaked');
  });
});

describe('opt-in probe', () => {
  const fakeFetch = (status, body = '') => async (url, init) => {
    fakeFetch.last = { url, init };
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };

  test('read-only GET, credential in a header, results named by category', async () => {
    let r = await probeOne('gemini', 'k-SECRET', fakeFetch(200, '{"models":[]}'));
    assert.equal(r.result, 'authenticated');
    assert.equal(fakeFetch.last.init.method, 'GET');
    assert.ok(!fakeFetch.last.url.includes('k-SECRET'), 'credential in the URL');
    assert.equal(fakeFetch.last.init.headers['x-goog-api-key'], 'k-SECRET');

    r = await probeOne('gemini', 'k', fakeFetch(400, '{"error":{"message":"API key expired. Please renew the API key.","details":[{"reason":"API_KEY_EXPIRED"}]}}'));
    assert.deepEqual(r, { result: 'rejected', status: 400 });
    r = await probeOne('groq', 'k', fakeFetch(401, 'Invalid API Key'));
    assert.deepEqual(r, { result: 'rejected', status: 401 });
    r = await probeOne('groq', 'k', fakeFetch(429, 'slow down'));
    assert.match(r.result, /rate_limited/);
    r = await probeOne('openrouter', 'k', fakeFetch(402, 'Insufficient credits'));
    assert.equal(r.result, 'billing');
  });

  test('OpenRouter probe reports non-secret quota facts; unknown stays unknown', async () => {
    const r = await probeOne('openrouter', 'k', fakeFetch(200, JSON.stringify({ data: { label: 'sk-or-v1-SECRET...', is_free_tier: true, limit: null, limit_remaining: null, usage: 0.5 } })));
    assert.deepEqual(r.quota, { freeTier: true, limit: null, limitRemaining: null, usage: 0.5 });
    assert.ok(!JSON.stringify(r).includes('SECRET'), 'the label (which can echo the key) is not passed through');
  });

  test('NVIDIA is not probed (no read-only authenticated endpoint) and a network failure is reported as such', async () => {
    assert.deepEqual(await probeOne('nvidia', 'k', fakeFetch(200)), { result: 'not_probed', status: null });
    const r = await probeOne('groq', 'k', async () => { throw new TypeError('fetch failed'); });
    assert.deepEqual(r, { result: 'network_error', status: null });
  });
});

describe('startup summary', () => {
  test('reports slots and pending checks, makes NO network call, prints no secret', async () => {
    const saved = { ...process.env };
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => { fetched++; throw new Error('startup must not call out'); };
    const logs = [];
    const realLog = console.log, realWarn = console.warn;
    console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
    try {
      for (const k of Object.keys(process.env)) if (/^(GEMINI_|Gemini_|GROQ_|OPENROUTER_|NVIDIA_)/.test(k)) delete process.env[k];
      for (let i = 1; i <= 12; i++) process.env[`GEMINI_KEY_${i}`] = `AQ.startup-SECRET-${i}`;
      const { runStartupValidation } = await import('../../core/startupValidation.js');
      const r = runStartupValidation();
      const line = logs.find(l => l.includes('[STARTUP] Gemini:'));
      assert.match(line, /Gemini: 12 distinct configured slots; 0 cooling; 0 rejected; credential checks pending/);
      assert.match(line, /non-standard format \(validity unknown\): #1,#2,#3,#4,#5,#6,#7,#8,#9,#10,#11,#12/);
      assert.equal(r.credentials.gemini.distinctCredentials, 12);
      assert.equal(fetched, 0);
      assert.ok(!logs.some(l => l.includes('SECRET')));
      assert.ok(!JSON.stringify(r).includes('SECRET'));
    } finally {
      console.log = realLog; console.warn = realWarn;
      globalThis.fetch = realFetch;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
