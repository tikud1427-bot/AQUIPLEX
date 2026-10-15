/**
 * Key-scoped failover through the REAL adapters — gemini.js, groq.js,
 * openrouter.js — and the router on top of them.
 *
 * Offline. Gemini and Groq run against fake SDK clients injected with
 * __setClientFactoryForTests (the rotation, classification, registry and pool
 * code all run for real); OpenRouter runs the real OpenAI SDK against a local
 * HTTP server via OPENROUTER_BASE_URL. Every provider variable inherited from
 * the environment is removed first: no test can read a real key or reach a
 * real endpoint. Fake keys carry "SECRET" so log checks can hunt for them.
 *
 * Run: node --test src/providers/tests/keyFailover.test.js
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROVIDER_ENV = /^(GEMINI_|Gemini_|GROQ_|OPENROUTER_|NVIDIA_|AQUA_PROVIDER_)/;
const stripEnv = () => { for (const k of Object.keys(process.env)) if (PROVIDER_ENV.test(k)) delete process.env[k]; };
stripEnv();

const G = await import('../gemini.js');
const Q = await import('../groq.js');
const O = await import('../openrouter.js');
const R = await import('../modelRegistry.js');
const H = await import('../../core/health.js');
const P = await import('../providerErrors.js');
const C = await import('../../core/costAccounting.js');
const ROUTER = await import('../router.js');
const lib = require('../keyPool.cjs');

const logs = [];
const realLog = console.log, realWarn = console.warn, realErr = console.error;
before(() => { const cap = (...a) => logs.push(a.map(String).join(' ')); console.log = cap; console.warn = cap; console.error = cap; });
after(() => { console.log = realLog; console.warn = realWarn; console.error = realErr; stripEnv(); });

const httpErr = (status, message = `HTTP ${status}`, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const KEY = (p, n) => `${p}-SECRET-${n}`;
const slotIn = key => /-SECRET-(\w+)/.exec(key)?.[1];

function resetAll() {
  stripEnv();
  G.__resetForTests(); Q.__resetForTests(); O.__resetForTests();
  R.__resetForTests(); H.__resetForTests(); C._resetCostMetrics();
}

// ── Fake Gemini SDK ───────────────────────────────────────────────────────────
let gCalls = [];
function useGemini(behavior) {
  gCalls = [];
  G.__setClientFactoryForTests(key => ({
    models: {
      generateContent: async req => {
        const call = { slot: slotIn(key), model: req.model, kind: 'gen' };
        gCalls.push(call);
        const r = await behavior(call, req);
        return { text: r.text, candidates: [{ finishReason: r.finishReason ?? 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } };
      },
      generateContentStream: async req => {
        const call = { slot: slotIn(key), model: req.model, kind: 'stream' };
        gCalls.push(call);
        const r = await behavior(call, req);
        return (async function* () {
          for (const c of r.chunks) { if (c instanceof Error) throw c; yield { text: c, candidates: [{}] }; }
        })();
      },
    },
  }));
}
const setGeminiKeys = nums => { for (const n of nums) process.env[`GEMINI_KEY_${n}`] = KEY('gm', n); };
const gGen = (opts = {}, signal) => G.generateGemini('sys', [{ role: 'user', content: 'hi' }], signal, undefined, opts);

describe('gemini — key-scoped failover', () => {
  beforeEach(() => { resetAll(); setGeminiKeys([1, 2]); });

  test('429 on the first key → the same request succeeds on the next key; nothing else is penalised', async () => {
    useGemini(async c => { if (c.slot === '1') throw httpErr(429, 'RESOURCE_EXHAUSTED. Please retry in 20s.'); return { text: 'ok' }; });
    const r = await gGen();
    assert.equal(r.text, 'ok');
    assert.equal(r.keySlot, '#2');
    assert.deepEqual(gCalls.map(c => c.slot), ['1', '2']);
    assert.equal(gCalls[0].model, gCalls[1].model, 'retried on the SAME model with another key');
    assert.equal(H.getProviderState('gemini').consecutiveFailures, 0, 'a key 429 is not a provider failure');
    assert.ok(R.getRegistrySnapshot().gemini.every(m => m.status === 'working'), 'no model was marked');
  });

  test('a (key, model) 429 cooldown honours the provider wait and leaves other models usable', async () => {
    useGemini(async c => { if (c.slot === '1') throw httpErr(429, 'Please retry in 20s.'); return { text: 'ok' }; });
    await gGen();
    const model = gCalls[0].model;
    const s1 = lib.getKeyPool('gemini').snapshot().slots.find(s => s.slot === '#1');
    assert.equal(s1.status, 'available', 'key-wide it is still usable');
    assert.equal(s1.coolingForModels[0].model, model);
    assert.ok(s1.coolingForModels[0].remainingMs > 19_000 && s1.coolingForModels[0].remainingMs <= 20_000, 'Retry hint honoured');
  });

  test('400 API_KEY_INVALID → key quarantined, request continues, the key is never used again', async () => {
    useGemini(async c => { if (c.slot === '1') throw httpErr(400, 'API key not valid. Please pass a valid API key. [API_KEY_INVALID]'); return { text: 'ok' }; });
    assert.equal((await gGen()).keySlot, '#2');
    gCalls = [];
    for (let i = 0; i < 4; i++) await gGen();
    assert.ok(!gCalls.some(c => c.slot === '1'));
    assert.equal(lib.getKeyPool('gemini').snapshot().slots[0].health, 'rejected');
  });

  test('every key throttled on the first model → the next registered model serves (no pointless key cycling)', async () => {
    const models = R.getCandidateModels('gemini').map(m => m.modelId);
    assert.ok(models.length >= 2, 'needs a fallback model');
    useGemini(async c => { if (c.model === models[0]) throw httpErr(429); return { text: `from ${c.model}` }; });
    const r = await gGen();
    assert.equal(r.model, models[1]);
    assert.equal(gCalls.filter(c => c.model === models[0]).length, 2, 'each key tried once on the throttled model');
  });

  test('a PINNED model never becomes another model when its keys are cooling', async () => {
    const models = R.getCandidateModels('gemini').map(m => m.modelId);
    useGemini(async c => { if (c.model === models[0]) throw httpErr(429, 'x', { headers: { 'retry-after': '40' } }); return { text: 'wrong model' }; });
    await assert.rejects(gGen({ model: models[0] }), e => {
      const cls = P.classifyProviderError(e);
      return e.code === 'ALL_KEYS_COOLING' && cls.type === 'rate_limit' && cls.retryable && e.retryAfterMs > 39_000;
    });
    assert.ok(gCalls.every(c => c.model === models[0]), 'a pin was silently substituted');
  });

  test('5xx does not cycle keys or cool them; the error propagates as server_error', async () => {
    useGemini(async () => { throw httpErr(500, 'Internal error'); });
    await assert.rejects(gGen(), e => P.classifyProviderError(e).type === 'server_error');
    const perModel = new Map();
    for (const c of gCalls) perModel.set(c.model, (perModel.get(c.model) ?? 0) + 1);
    assert.ok([...perModel.values()].every(n => n === 1), 'one attempt per model — no key cycling on a server error');
    assert.equal(lib.getKeyPool('gemini').availability().available, 2);
  });

  test('a model-not-found retires THAT model only; keys and the other model are untouched', async () => {
    const models = R.getCandidateModels('gemini').map(m => m.modelId);
    useGemini(async c => { if (c.model === models[0]) throw httpErr(404, `models/${models[0]} is not found`); return { text: 'ok' }; });
    const r = await gGen();
    assert.equal(r.model, models[1]);
    assert.equal(R.getRegistrySnapshot().gemini.find(m => m.modelId === models[0]).status, 'deprecated');
    assert.equal(lib.getKeyPool('gemini').availability().available, 2);
  });

  test('all keys rejected → a terminal, non-retryable auth error', async () => {
    useGemini(async () => { throw httpErr(401, 'UNAUTHENTICATED'); });
    await assert.rejects(gGen(), e => e.code === 'ALL_KEYS_REJECTED' && P.classifyProviderError(e).type === 'auth' && !P.classifyProviderError(e).retryable);
  });

  test('GEMINI_KEY_9..12 are used: with slots 1..8 refused as expired, the pool converges on 9..12', async () => {
    resetAll();
    setGeminiKeys([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    useGemini(async c => { if (Number(c.slot) <= 8) throw httpErr(400, 'API key expired. Please renew the API key.'); return { text: 'ok' }; });
    const first = await gGen();
    assert.equal(first.keySlot, '#9');
    gCalls = [];
    const used = new Set();
    for (let i = 0; i < 8; i++) used.add((await gGen()).keySlot);
    assert.deepEqual([...used].sort(), ['#10', '#11', '#12', '#9']);
    assert.ok(gCalls.every(c => Number(c.slot) >= 9), 'a quarantined slot was retried');
  });

  test('the unnumbered GEMINI_API_KEY alone works (backward compatibility)', async () => {
    resetAll();
    process.env.GEMINI_API_KEY = KEY('gm', 'bare');
    useGemini(async () => ({ text: 'ok' }));
    assert.equal((await gGen()).keySlot, '#bare');
  });

  test('an abort during a call stops — no further key is tried', async () => {
    const ac = new AbortController();
    useGemini(async () => { ac.abort(); throw httpErr(429); });
    await assert.rejects(gGen({}, ac.signal), /TIMEOUT/);
    assert.equal(gCalls.length, 1);
  });

  test('media analysis (upload pipeline) rides the same pool and fails over the same way', async () => {
    useGemini(async c => { if (c.slot === '1') throw httpErr(429); return { text: ' a cat ' }; });
    const r = await G.analyzeMediaWithGemini([{ text: 'describe' }]);
    assert.equal(r.text, 'a cat');
    assert.equal(r.keySlot, '#2');
  });
});

describe('gemini — streaming safety', () => {
  beforeEach(() => { resetAll(); setGeminiKeys([1, 2]); });
  const stream = (onDelta, signal) => G.streamGemini('sys', [{ role: 'user', content: 'hi' }], signal, undefined, onDelta);

  test('a pre-token failure fails over to the next key; the client sees one clean answer', async () => {
    useGemini(async c => (c.slot === '1' ? { chunks: [httpErr(429)] } : { chunks: ['Hel', 'lo'] }));
    const deltas = [];
    const r = await stream(d => deltas.push(d));
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(r.text, 'Hello');
    assert.equal(r.keySlot, '#2');
  });

  test('a post-token failure returns the partial — never restarted, never duplicated', async () => {
    useGemini(async () => ({ chunks: ['first ', httpErr(503, 'stream reset')] }));
    const deltas = [];
    const r = await stream(d => deltas.push(d));
    assert.equal(r.finishReason, 'interrupted');
    assert.equal(r.text, 'first ');
    assert.deepEqual(deltas, ['first ']);
    assert.equal(gCalls.length, 1, 'no second key/model was started after content reached the client');
    assert.equal(C.getCostMetrics().calls, 0, 'an interrupted partial is not counted as a success');
  });
});

// ── Fake Groq SDK ─────────────────────────────────────────────────────────────
let qCalls = [];
function useGroq(behavior) {
  qCalls = [];
  Q.__setClientFactoryForTests(key => ({
    chat: { completions: { create: async body => {
      const call = { slot: slotIn(key), model: body.model, stream: !!body.stream };
      qCalls.push(call);
      const r = await behavior(call, body);
      if (body.stream) {
        return (async function* () {
          for (const c of r.chunks) { if (c instanceof Error) throw c; yield { choices: [{ delta: { content: c }, finish_reason: null }] }; }
        })();
      }
      return { choices: [{ message: { content: r.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } };
    } } },
  }));
}
const setGroqKeys = nums => { for (const n of nums) process.env[`GROQ_API_KEY_${n}`] = KEY('gq', n); };
const qGen = () => Q.generateGroq('sys', [{ role: 'user', content: 'hi' }], undefined, undefined);

describe('groq — key-scoped failover', () => {
  beforeEach(() => { resetAll(); setGroqKeys([1, 2, 3]); });

  test('429 → next key on the same model (previously: jumped straight to the fallback model)', async () => {
    useGroq(async c => { if (c.slot === '1') throw httpErr(429, 'Rate limit reached', { headers: { 'retry-after': '11' } }); return { text: 'ok' }; });
    const r = await qGen();
    assert.equal(r.keySlot, '#2');
    assert.equal(qCalls[0].model, qCalls[1].model);
    assert.equal(Q.msUntilAnyKeyFree(), 0);
    const wait = Q.msUntilAnyKeyFree(qCalls[0].model);
    assert.equal(wait, 0, 'other keys still serve that model');
  });

  test('401 → that key quarantined, request continues; numbered + unnumbered GROQ_API_KEY both in the pool', async () => {
    process.env.GROQ_API_KEY = KEY('gq', 'bare');
    useGroq(async c => { if (c.slot === 'bare') throw httpErr(401, 'Invalid API Key'); return { text: 'ok' }; });
    const seen = new Set();
    for (let i = 0; i < 5; i++) seen.add((await qGen()).keySlot);
    assert.ok(!seen.has('#bare'));
    assert.equal(lib.getKeyPool('groq').snapshot().slots.find(s => s.slot === '#bare').status, 'rejected');
  });

  test('a transient 5xx moves to the next MODEL, cools no key', async () => {
    useGroq(async c => { if (qCalls.length === 1) throw httpErr(503, 'Service Unavailable'); return { text: `ok ${c.model}` }; });
    const r = await qGen();
    assert.notEqual(qCalls[0].model, qCalls[1].model);
    assert.equal(r.text, `ok ${qCalls[1].model}`);
    assert.equal(lib.getKeyPool('groq').availability().available, 3);
  });

  test('every key throttled on every model → one structured, retryable wait (not a hang, not a retry storm)', async () => {
    useGroq(async () => { throw httpErr(429, 'x', { headers: { 'retry-after': '25' } }); });
    await assert.rejects(qGen(), e => {
      const cls = P.classifyProviderError(e);
      return cls.type === 'rate_limit' && cls.retryable && e.retryAfterMs > 24_000 && e.retryAfterMs <= 25_000;
    });
    assert.ok(qCalls.length <= 6, `bounded attempts (got ${qCalls.length})`);
  });

  test('stream: post-token failure returns the partial without a second request', async () => {
    useGroq(async () => ({ chunks: ['a', 'b', httpErr(500)] }));
    const deltas = [];
    const r = await Q.streamGroq('s', [{ role: 'user', content: 'x' }], undefined, undefined, d => deltas.push(d));
    assert.equal(r.finishReason, 'interrupted');
    assert.deepEqual(deltas, ['a', 'b']);
    assert.equal(qCalls.length, 1);
  });

  test('stream: pre-token 429 rotates to the next key', async () => {
    useGroq(async c => { if (c.slot === '1') throw httpErr(429); return { chunks: ['ok'] }; });
    const r = await Q.streamGroq('s', [{ role: 'user', content: 'x' }], undefined, undefined, () => {});
    assert.equal(r.text, 'ok');
    assert.equal(r.keySlot, '#2');
  });
});

// ── OpenRouter over a local HTTP server (real OpenAI SDK) ────────────────────
describe('openrouter — key rotation only where another key can help', () => {
  let server, requests, respond;
  before(async () => {
    server = await new Promise(resolve => {
      const s = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          const slot = slotIn(req.headers.authorization);
          requests.push({ slot, model: parsed.model });
          const r = respond(slot, parsed);
          res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
          res.end(JSON.stringify(r.json ?? {}));
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
  });
  after(() => { server?.close(); });
  beforeEach(() => {
    resetAll();
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    for (const n of [1, 2]) process.env[`OPENROUTER_API_KEY_${n}`] = KEY('or', n);
    requests = [];
  });
  const ok = { status: 200, json: { id: 'x', object: 'chat.completion', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } };
  const oGen = () => O.generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined);

  test('401 on one key → same model, next key (previously the whole provider failed)', async () => {
    respond = slot => (slot === '1' ? { status: 401, json: { error: { message: 'User not found.', code: 401 } } } : ok);
    const r = await oGen();
    assert.equal(r.keySlot, '#2');
    assert.equal(requests[0].model, requests[1].model);
  });

  test('account-scoped 429 (free-models-per-day) → next key, same model; that key then rests', async () => {
    respond = slot => (slot === '1'
      ? { status: 429, json: { error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429 } } }
      : ok);
    await oGen();
    assert.deepEqual(requests.map(r => r.slot), ['1', '2']);
    assert.equal(requests[0].model, requests[1].model);
    requests = [];
    await oGen(); await oGen();
    assert.ok(!requests.some(r => r.slot === '1'), 'a key that hit its account limit was reused');
  });

  test('upstream-saturated 429 stays MODEL-scoped: next model, no key cooled', async () => {
    let first = true;
    respond = () => {
      if (first) { first = false; return { status: 429, json: { error: { message: 'x is temporarily rate-limited upstream. Please retry shortly', code: 429 } } }; }
      return ok;
    };
    await oGen();
    assert.notEqual(requests[0].model, requests[1].model);
    assert.equal(lib.getKeyPool('openrouter').availability().available, 2);
  });

  test('"No endpoints found" stays a transient MODEL failure — never a key failure', async () => {
    let first = true;
    respond = () => {
      if (first) { first = false; return { status: 404, json: { error: { message: 'No endpoints found for this model', code: 404 } } }; }
      return ok;
    };
    await oGen();
    assert.equal(lib.getKeyPool('openrouter').availability().available, 2);
    assert.ok(!R.getRegistrySnapshot().openrouter.some(m => m.status === 'deprecated'));
  });

  test('402 (credits) on one key → next key', async () => {
    respond = slot => (slot === '1' ? { status: 402, json: { error: { message: 'Insufficient credits', code: 402 } } } : ok);
    assert.equal((await oGen()).keySlot, '#2');
  });
});

describe('router integration', () => {
  beforeEach(() => resetAll());

  test('the main engine routes through the expanded pool (only GEMINI_KEY_9..12 configured)', async () => {
    setGeminiKeys([9, 10, 11, 12]);
    useGemini(async () => ({ text: 'The capital of France is Paris.' }));
    const ctx = { requestId: 'kp-1', attempts: [] };
    const r = await ROUTER.generateText('What is the capital of France?', 'sys', [{ role: 'user', content: 'What is the capital of France?' }], ctx, 'simple_qa', undefined, undefined,
      { sleep: async () => {} });
    assert.equal(r.provider, 'gemini');
    const success = r.fallbackChain.find(f => f.outcome === 'success');
    assert.equal(success.keySlot, '#9');
    assert.equal(success.keyAttempts, 1);
  });

  test('Groq stays the default preference for conversation when every provider is healthy', () => {
    const ranked = ROUTER.rankProviders('conversation');
    assert.equal(ranked[0].provider, 'groq');
  });

  test('the adapter receives only a cost purpose — no pin, no temperature', async () => {
    let seen;
    const fake = async (_s, _m, _sig, _mt, opts) => { seen = opts; return { text: 'Paris is the capital of France.', truncated: false, finishReason: 'stop', model: 'm' }; };
    await ROUTER.generateText('capital of France?', 'sys', [{ role: 'user', content: 'capital of France?' }], { requestId: 'kp-2' }, 'simple_qa', undefined, undefined,
      { gemini: fake, groq: fake, openrouter: fake, nvidia: fake, sleep: async () => {} });
    assert.deepEqual(seen, { purpose: 'chat' });
  });
});

describe('no secret ever reaches a log', () => {
  test('across every scenario above', () => {
    assert.ok(logs.length > 0, 'nothing was logged — this check would be vacuous');
    const leaked = logs.filter(l => l.includes('-SECRET-') || /Bearer\s/i.test(l));
    assert.deepEqual(leaked, []);
    assert.ok(logs.some(l => /key=#\d/.test(l)));
  });
});
