/**
 * Embeddings ride the shared Gemini key pool — recovery without corrupting
 * order, without resubmitting successful work, and without storing anything
 * that is not a real, correctly-aligned vector.
 *
 * Offline: only the network call is replaced (__setEmbedTransportForTests);
 * key selection, cooldown, quarantine, response validation, batching and the
 * cache all run for real. Provider env vars are stripped first.
 *
 * Run: node --test src/embeddings/tests/embeddingKeyRotation.test.js
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const STRIP = /^(GEMINI_|Gemini_|AQUA_EMBED)/;
const strip = () => { for (const k of Object.keys(process.env)) if (STRIP.test(k)) delete process.env[k]; };
strip();

const E = await import('../embeddingProvider.js');
const { EMBED_DIM, EMBED_MODEL } = await import('../embeddingModel.js');
const G = await import('../../providers/gemini.js');
const lib = require('../../providers/keyPool.cjs');
const pool = lib.getKeyPool('gemini');

const KEY = n => `emb-SECRET-${n}`;
const slotOf = key => /emb-SECRET-(\w+)/.exec(key)[1];
const httpErr = (status, message = `HTTP ${status}`, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** A deterministic vector that encodes WHICH text it belongs to. */
const vecFor = text => { const v = new Array(EMBED_DIM).fill(0); v[0] = text.length; v[1] = text.charCodeAt(0); return v; };
const okResponse = texts => ({ embeddings: texts.map(t => ({ values: vecFor(t) })) });

let calls;
const warnings = [];
const realWarn = console.warn, realLog = console.log;
console.warn = (...a) => warnings.push(a.join(' '));
console.log = (...a) => warnings.push(a.join(' '));
after(() => { console.warn = realWarn; console.log = realLog; E.__clearEmbedTransportForTests(); strip(); });

function useTransport(fn) {
  calls = [];
  E.__setEmbedTransportForTests(async (key, texts) => {
    calls.push({ slot: slotOf(key), texts: [...texts] });
    return fn(slotOf(key), texts, calls.length);
  });
}

beforeEach(() => {
  strip();
  for (const n of [1, 2, 3]) process.env[`GEMINI_KEY_${n}`] = KEY(n);
  pool.resetCredentials();
  G.__resetForTests();
});

describe('embeddings — key recovery', () => {
  test('a 429 on the first key → the same batch succeeds on the next key, in order', async () => {
    useTransport((slot, texts) => { if (slot === '1') throw httpErr(429, 'Please retry in 30s.'); return okResponse(texts); });
    const texts = ['alpha', 'bb', 'charlie'];
    const out = await E.embed(texts);
    assert.deepEqual(out, texts.map(vecFor), 'each vector stays attached to its own input');
    assert.deepEqual(calls.map(c => c.slot), ['1', '2']);
    const s1 = pool.snapshot().slots.find(s => s.slot === '#1');
    assert.equal(s1.coolingForModels[0].model, EMBED_MODEL, 'cooled for the EMBEDDING model only');
    assert.equal(s1.status, 'available', 'chat on another model may still use this key');
  });

  test('a rejected key (401/expired) is quarantined and never used again — by embeddings OR chat', async () => {
    useTransport((slot, texts) => { if (slot === '1') throw httpErr(400, 'API key expired. Please renew the API key.'); return okResponse(texts); });
    await E.embed(['x']);
    calls.length = 0;
    for (const t of ['p', 'q', 'r', 's']) await E.embed([t]);
    assert.ok(!calls.some(c => c.slot === '1'));
    // Same pool as the chat adapter: gemini.js skips it too.
    const chatSlots = [];
    G.__setClientFactoryForTests(key => ({ models: { generateContent: async () => { chatSlots.push(slotOf(key)); return { text: 'ok', candidates: [{ finishReason: 'STOP' }] }; } } }));
    for (let i = 0; i < 3; i++) await G.generateGemini('s', [{ role: 'user', content: 'x' }]);
    assert.ok(!chatSlots.includes('1'), 'the chat adapter reused a key embeddings found rejected');
    G.__setClientFactoryForTests(null);
  });

  test('a multi-chunk batch: a chunk that fails over does not resubmit the chunk that succeeded', async () => {
    const texts = Array.from({ length: 70 }, (_, i) => `text-${i}`); // 64 + 6 → two chunks
    useTransport((slot, chunk, n) => { if (n === 2) throw httpErr(429); return okResponse(chunk); });
    const out = await E.embed(texts);
    assert.deepEqual(out, texts.map(vecFor), 'all 70 vectors, in input order');
    assert.equal(calls.length, 3, 'chunk 1 once, chunk 2 twice (429 then success)');
    assert.equal(calls[0].texts.length, 64);
    assert.deepEqual(calls[1].texts, calls[2].texts, 'only the failed chunk was retried');
    assert.equal(calls[1].texts.length, 6);
  });

  test('a misaligned response (fewer vectors than inputs) is discarded, not stored, not cached', async () => {
    useTransport((_slot, texts) => ({ embeddings: texts.slice(1).map(t => ({ values: vecFor(t) })) }));
    const out = await E.embed(['one', 'two', 'three']);
    assert.deepEqual(out, [null, null, null], 'vector i could belong to text i+1 — refuse all of them');
    assert.equal(calls.length, 1, 'another key would get the same shape — no key cycling');
    useTransport((_slot, texts) => okResponse(texts));
    assert.deepEqual(await E.embed(['one']), [vecFor('one')], 'nothing was cached from the bad response');
  });

  test('an individually invalid vector (wrong dimension / non-finite) is null; its neighbours survive', async () => {
    useTransport((_slot, texts) => ({ embeddings: [
      { values: vecFor(texts[0]) },
      { values: [1, 2, 3] },
      { values: vecFor(texts[2]).map((v, i) => (i === 5 ? Number.NaN : v)) },
    ] }));
    const out = await E.embed(['good', 'short', 'nan']);
    assert.deepEqual(out[0], vecFor('good'));
    assert.equal(out[1], null);
    assert.equal(out[2], null);
  });

  test('a 5xx does not cycle keys: one attempt, keyword fallback (nulls), no key cooled', async () => {
    useTransport(() => { throw httpErr(503, 'backend error'); });
    assert.deepEqual(await E.embed(['a', 'b']), [null, null]);
    assert.equal(calls.length, 1);
    assert.equal(pool.availability().available, 3);
  });

  test('every key exhausted → nulls (the keyword fallback), never a throw', async () => {
    useTransport(() => { throw httpErr(401); });
    assert.deepEqual(await E.embed(['a', 'b']), [null, null]);
    assert.equal(await E.embedOne('c'), null);
    assert.equal(calls.length, 3, 'each key tried once, then the pool is known-bad');
  });

  test('retries are bounded: three throttled keys out of many, then fallback', async () => {
    for (let n = 4; n <= 12; n++) process.env[`GEMINI_KEY_${n}`] = KEY(n);
    useTransport(() => { throw httpErr(429); });
    assert.deepEqual(await E.embed(['a']), [null]);
    assert.equal(calls.length, 3);
  });

  test('slots 9..12 (and the unnumbered key) feed embeddings', async () => {
    strip();
    for (const n of [9, 10, 11, 12]) process.env[`GEMINI_KEY_${n}`] = KEY(n);
    process.env.GEMINI_API_KEY = KEY('bare');
    pool.resetCredentials();
    useTransport((_slot, texts) => okResponse(texts));
    assert.equal(E.isEmbeddingEnabled(), true);
    for (const t of ['a', 'b', 'c', 'd', 'e']) await E.embed([t]);
    assert.deepEqual(calls.map(c => c.slot), ['9', '10', '11', '12', 'bare']);
  });

  test('no key value reaches a log line', () => {
    assert.ok(warnings.some(w => /key=#\d/.test(w)), 'nothing logged — vacuous');
    assert.ok(!warnings.some(w => w.includes('emb-SECRET')));
  });
});
