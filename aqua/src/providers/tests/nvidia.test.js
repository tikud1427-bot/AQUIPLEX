/**
 * NVIDIA adapter — key pool, error scoping, pinning, streaming, accounting.
 *
 * Fully offline: a local HTTP server answers like integrate.api.nvidia.com and
 * the REAL adapter (real OpenAI SDK → real classifier → real registry → real
 * cost counters) is pointed at it via NVIDIA_BASE_URL. Every NVIDIA_* variable
 * inherited from the environment is removed first, so no test can reach the
 * live API or read a real key. Same technique as openrouterResilience.test.js.
 *
 * Run: node --test src/providers/tests/nvidia.test.js
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const FAKE = n => `nv-fake-secret-${n}-XYZ`;
const slotOfAuth = auth => {
  const m = /nv-fake-secret-(\w+)-XYZ/.exec(String(auth ?? ''));
  return m ? `#${m[1]}` : null;
};

let server;
let requests = [];
/** (req, body, slot) => { status, headers?, json? } | { sse: [chunks] } */
let respond = () => ({ status: 200, json: completion('ok') });

function completion(content, { finish = 'stop', usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } = {}) {
  return {
    id: 'cmpl-x', object: 'chat.completion', model: 'openai/gpt-oss-20b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage,
  };
}

function chunk(delta, finish = null, usage = null) {
  return { id: 'c', object: 'chat.completion.chunk', choices: delta === null ? [] : [{ index: 0, delta: { content: delta }, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

let A; // adapter module
let R; // registry
let H; // health
let C; // cost
let P; // providerErrors

const logs = [];
const realLog = console.log, realWarn = console.warn, realErr = console.error;

function clearNvidiaEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith('NVIDIA_')) delete process.env[k];
}
function setKeys(n) {
  for (let i = 1; i <= n; i++) process.env[`NVIDIA_API_KEY_${i}`] = FAKE(i);
}

before(async () => {
  clearNvidiaEnv();
  server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const slot = slotOfAuth(req.headers.authorization);
        requests.push({ url: req.url, body: parsed, slot });
        const r = respond(req, parsed, slot);
        if (r.sse) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const c of r.sse) res.write(typeof c === 'string' ? c : `data: ${JSON.stringify(c)}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.json ?? {}));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  setKeys(5);

  // Imported AFTER the env is clean so the registry's default model is the
  // shipped default, not an operator override.
  A = await import('../nvidia.js');
  R = await import('../modelRegistry.js');
  H = await import('../../core/health.js');
  C = await import('../../core/costAccounting.js');
  P = await import('../providerErrors.js');

  const capture = (...a) => logs.push(a.map(String).join(' '));
  console.log = capture; console.warn = capture; console.error = capture;
});

after(() => {
  console.log = realLog; console.warn = realWarn; console.error = realErr;
  server?.close();
  clearNvidiaEnv();
});

beforeEach(() => {
  clearNvidiaEnv();
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  setKeys(5);
  requests = [];
  respond = () => ({ status: 200, json: completion('ok') });
  A.__resetForTests(); R.__resetForTests(); H.__resetForTests(); C._resetCostMetrics();
});

const gen = (opts = {}, maxTokens) => A.generateNvidia('sys', [{ role: 'user', content: 'hi' }], undefined, maxTokens, opts);

describe('nvidia — key discovery', () => {
  test('finds NVIDIA_API_KEY_1..5', () => {
    assert.deepEqual(A.getKeySlotSummary(), { count: 5, slots: ['#1', '#2', '#3', '#4', '#5'] });
    assert.equal(A.hasConfiguredKeys(), true);
  });

  test('dedupes repeated keys, ignores blank and whitespace-only slots, numeric order', () => {
    clearNvidiaEnv();
    process.env.NVIDIA_API_KEY_10 = FAKE(10);
    process.env.NVIDIA_API_KEY_2 = FAKE(2);
    process.env.NVIDIA_API_KEY_3 = FAKE(2);      // duplicate of #2
    process.env.NVIDIA_API_KEY_4 = '';           // blank
    process.env.NVIDIA_API_KEY_5 = '   ';        // whitespace
    process.env.NVIDIA_API_KEY = FAKE(2);        // bare duplicate
    assert.deepEqual(A.getKeySlotSummary(), { count: 2, slots: ['#2', '#10'] });
  });

  test('a distinct bare NVIDIA_API_KEY joins the pool after the numbered slots', () => {
    clearNvidiaEnv();
    process.env.NVIDIA_API_KEY_1 = FAKE(1);
    process.env.NVIDIA_API_KEY = FAKE('bare');
    assert.deepEqual(A.getKeySlotSummary().slots, ['#1', '#bare']);
  });

  test('no keys → a config error, classified config (not retried)', async () => {
    clearNvidiaEnv();
    assert.equal(A.hasConfiguredKeys(), false);
    assert.equal(A.msUntilAnyKeyFree(), null);
    await assert.rejects(gen(), e => P.classifyProviderError(e).type === 'config');
    assert.equal(requests.length, 0);
  });
});

describe('nvidia — rotation and key-scoped failures', () => {
  test('five calls rotate round-robin across all five keys', async () => {
    for (let i = 0; i < 5; i++) await gen();
    assert.deepEqual(requests.map(r => r.slot), ['#1', '#2', '#3', '#4', '#5']);
  });

  test('429 on one key cools THAT key and retries the same request on the next', async () => {
    respond = (_req, _b, slot) => slot === '#1'
      ? { status: 429, headers: { 'retry-after': '30' }, json: { error: { message: 'Too Many Requests' } } }
      : { status: 200, json: completion('from next key') };
    const r = await gen();
    assert.equal(r.text, 'from next key');
    assert.equal(r.keySlot, '#2');
    assert.deepEqual(requests.map(q => q.slot), ['#1', '#2']);
    assert.equal(A.msUntilAnyKeyFree(), 0, 'other keys are still free');

    // #1 is skipped while cooling: the next rotation lands on #3, #4, #5, #2 — never #1.
    requests = [];
    for (let i = 0; i < 4; i++) await gen();
    assert.ok(!requests.some(q => q.slot === '#1'), 'a cooling key was used');

    const s = H.getProviderState('nvidia');
    assert.equal(s.consecutiveFailures, 0, 'a single key 429 must not touch provider health');
    assert.equal(s.circuitState, 'closed');
  });

  test('Retry-After sets the key cooldown; all keys limited → one rate_limit carrying the exact wait', async () => {
    respond = () => ({ status: 429, headers: { 'retry-after': '7' }, json: { error: { message: 'rate limit' } } });
    await assert.rejects(gen(), e => {
      const cls = P.classifyProviderError(e);
      assert.equal(cls.type, 'rate_limit');
      assert.ok(cls.retryAfterMs > 5_000 && cls.retryAfterMs <= 7_000, `retryAfterMs=${cls.retryAfterMs}`);
      return true;
    });
    assert.equal(requests.length, 5, 'each key tried exactly once');
    const wait = A.msUntilAnyKeyFree();
    assert.ok(wait > 5_000 && wait <= 7_000, `wait=${wait}`);
    // While every key cools, a new call makes NO request and fails fast as rate_limit.
    requests = [];
    await assert.rejects(gen(), e => P.classifyProviderError(e).type === 'rate_limit');
    assert.equal(requests.length, 0);
  });

  test('401 cools that key for 24h and the request continues on the next key', async () => {
    respond = (_req, _b, slot) => slot === '#1'
      ? { status: 401, json: { error: { message: 'Unauthorized' } } }
      : { status: 200, json: completion('ok') };
    const r = await gen();
    assert.equal(r.keySlot, '#2');
    requests = [];
    for (let i = 0; i < 8; i++) await gen();
    assert.ok(!requests.some(q => q.slot === '#1'));
  });

  test('every key rejected → the auth error propagates (not retryable)', async () => {
    respond = () => ({ status: 403, json: { error: { message: 'Forbidden' } } });
    await assert.rejects(gen(), e => P.classifyProviderError(e).type === 'auth');
    assert.equal(requests.length, 5);
  });

  test('a mixed pool (some 429, some 401) is a retryable WAIT, not a permanent auth failure', async () => {
    respond = (_req, _b, slot) => (['#1', '#2'].includes(slot)
      ? { status: 429, headers: { 'retry-after': '9' }, json: { error: { message: 'rate limit' } } }
      : { status: 401, json: { error: { message: 'Unauthorized' } } });
    await assert.rejects(gen(), e => {
      const cls = P.classifyProviderError(e);
      assert.equal(cls.type, 'rate_limit');
      assert.equal(cls.retryable, true);
      assert.ok(cls.retryAfterMs <= 9_000, 'the wait is the THROTTLED key\'s, not a 24h rejection');
      return true;
    });
  });

  test('once every key has been rejected, later calls fail fast as auth — no request, no fake 24h "rate limit"', async () => {
    respond = () => ({ status: 401, json: { error: { message: 'Unauthorized' } } });
    await assert.rejects(gen());
    requests = [];
    await assert.rejects(gen(), e => {
      const cls = P.classifyProviderError(e);
      assert.equal(cls.type, 'auth');
      assert.equal(cls.retryable, false);
      return true;
    });
    assert.equal(requests.length, 0);
  });

  test('402 (credits spent) is key-scoped too', async () => {
    respond = (_req, _b, slot) => slot === '#1'
      ? { status: 402, json: { error: { message: 'Payment Required' } } }
      : { status: 200, json: completion('ok') };
    assert.equal((await gen()).keySlot, '#2');
  });
});

describe('nvidia — model-scoped failures never touch keys', () => {
  test('404 model-not-found deprecates THAT model only; keys stay free', async () => {
    respond = () => ({ status: 404, json: { error: { message: "Function 'x': Not found for account" } } });
    await assert.rejects(gen(), e => P.classifyProviderError(e).type === 'model_not_found');
    assert.equal(requests.length, 1, 'a dead model is not retried on every key');
    assert.equal(A.msUntilAnyKeyFree(), 0, 'no key was cooled by a model failure');
    assert.equal(R.getRegistrySnapshot().nvidia[0].status, 'deprecated');
    assert.ok(R.getCandidateModels('groq').length > 0, 'sibling providers untouched');
    await assert.rejects(gen(), e => e.code === 'NO_CANDIDATE_MODELS');
  });

  test('deprecation wording is permanent, even on a 400', async () => {
    respond = () => ({ status: 400, json: { error: { message: 'This model has reached its end of life' } } });
    await assert.rejects(gen(), e => P.classifyProviderError(e).type === 'model_not_found');
    assert.equal(R.getRegistrySnapshot().nvidia[0].status, 'deprecated');
  });

  test('5xx → server_error: retryable, no key cooled, model not deprecated', async () => {
    respond = () => ({ status: 503, json: { error: { message: 'Service Unavailable' } } });
    await assert.rejects(gen(), e => {
      const cls = P.classifyProviderError(e);
      return cls.type === 'server_error' && cls.retryable;
    });
    assert.equal(A.msUntilAnyKeyFree(), 0);
    assert.notEqual(R.getRegistrySnapshot().nvidia[0].status, 'deprecated');
  });
});

describe('nvidia — model pinning', () => {
  test('a pin sends exactly that model', async () => {
    const r = await gen({ model: 'openai/gpt-oss-20b' });
    assert.equal(requests[0].body.model, 'openai/gpt-oss-20b');
    assert.equal(r.model, 'openai/gpt-oss-20b');
  });

  test('an unregistered pin throws MODEL_PIN_UNAVAILABLE and sends nothing — never substitutes', async () => {
    await assert.rejects(gen({ model: 'openai/gpt-oss-120b' }), e => e.code === 'MODEL_PIN_UNAVAILABLE');
    assert.equal(requests.length, 0);
  });

  test('the default model is openai/gpt-oss-20b', async () => {
    await gen();
    assert.equal(requests[0].body.model, 'openai/gpt-oss-20b');
  });
});

describe('nvidia — generation contract', () => {
  test('returns { text, truncated, finishReason, model, usage } with normalized usage', async () => {
    const r = await gen();
    assert.equal(r.text, 'ok');
    assert.equal(r.truncated, false);
    assert.equal(r.finishReason, 'stop');
    assert.equal(r.model, 'openai/gpt-oss-20b');
    assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 7 });
  });

  test('temperature is sent only when supplied; max_tokens is clamped to the registry cap', async () => {
    await gen({}, 999_999);
    assert.equal('temperature' in requests[0].body, false);
    assert.equal(requests[0].body.max_tokens, 8_192);
    await gen({ temperature: 0 }, 100);
    assert.equal(requests[1].body.temperature, 0);
    assert.equal(requests[1].body.max_tokens, 100);
  });

  test('finish_reason=length with content is a SUCCESSFUL truncated completion', async () => {
    respond = () => ({ status: 200, json: completion('partial', { finish: 'length' }) });
    const r = await gen({}, 50);
    assert.equal(r.truncated, true);
    assert.equal(r.finishReason, 'length');
  });

  test('empty content → invalid_response (retryable), not a success', async () => {
    respond = () => ({ status: 200, json: completion('') });
    await assert.rejects(gen(), e => P.classifyProviderError(e).type === 'invalid_response');
  });

  test('reasoning that exhausts max_tokens (content null, length) → invalid_response', async () => {
    respond = () => ({ status: 200, json: completion(null, { finish: 'length' }) });
    await assert.rejects(gen({}, 16), e => /exhausted max_tokens/.test(e.message)
      && P.classifyProviderError(e).type === 'invalid_response');
  });

  test('an already-aborted signal → TIMEOUT before any request', async () => {
    const ac = new AbortController(); ac.abort();
    await assert.rejects(A.generateNvidia('s', [{ role: 'user', content: 'x' }], ac.signal), /TIMEOUT/);
    assert.equal(requests.length, 0);
  });

  test('a successful call is counted by provider/model/purpose; unpriced stays unpriced', async () => {
    await gen({ purpose: 'extraction' });
    const m = C.getCostMetrics();
    assert.equal(m.calls, 1);
    assert.equal(m.inputTokens, 11);
    assert.equal(m.outputTokens, 7);
    assert.equal(m.unpricedCalls, 1, 'no NVIDIA price is known — never reported as $0');
    assert.equal(m.byPurpose.extraction.calls, 1);
  });

  test('a failed call is not counted', async () => {
    respond = () => ({ status: 503, json: {} });
    await assert.rejects(gen());
    assert.equal(C.getCostMetrics().calls, 0);
  });
});

describe('nvidia — streaming', () => {
  const stream = (onDelta, signal, maxTokens, opts) =>
    A.streamNvidia('sys', [{ role: 'user', content: 'hi' }], signal, maxTokens, onDelta, opts);

  test('SSE deltas reach onDelta in order; [DONE], empty chunks and the usage chunk are handled', async () => {
    respond = () => ({ sse: [
      chunk('Hel'), chunk(null), chunk(''), chunk('lo'), chunk(' world', 'stop'),
      chunk(null, null, { prompt_tokens: 5, completion_tokens: 3 }),
    ] });
    const deltas = [];
    const r = await stream(d => deltas.push(d));
    assert.deepEqual(deltas, ['Hel', 'lo', ' world']);
    assert.equal(r.text, 'Hello world');
    assert.equal(r.streamed, true);
    assert.equal(r.finishReason, 'stop');
    assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 3 });
    assert.equal(requests[0].body.stream, true);
    assert.equal(C.getCostMetrics().byPurpose.chat.calls, 1);
  });

  test('finish_reason=length → truncated', async () => {
    respond = () => ({ sse: [chunk('cut', 'length')] });
    const r = await stream(() => {}, undefined, 10);
    assert.equal(r.truncated, true);
    assert.equal(r.finishReason, 'length');
  });

  test('a pre-token 429 rotates to the next key — the client saw nothing yet', async () => {
    respond = (_req, _b, slot) => slot === '#1'
      ? { status: 429, json: { error: { message: 'rate limit' } } }
      : { sse: [chunk('ok', 'stop')] };
    const r = await stream(() => {});
    assert.equal(r.text, 'ok');
    assert.equal(r.keySlot, '#2');
  });

  test('an empty stream → invalid_response', async () => {
    respond = () => ({ sse: [chunk(null), chunk('', 'stop')] });
    await assert.rejects(stream(() => {}), e => P.classifyProviderError(e).type === 'invalid_response');
  });

  test('aborted after the first token → the partial is returned as interrupted, not retried', async () => {
    const ac = new AbortController();
    respond = () => ({ sse: [chunk('first'), ': keepalive\n\n', chunk('second'), chunk('third', 'stop')] });
    const deltas = [];
    const r = await stream(d => { deltas.push(d); ac.abort(); }, ac.signal);
    assert.equal(r.finishReason, 'interrupted');
    assert.equal(r.truncated, true);
    assert.equal(r.text, 'first');
    assert.equal(requests.length, 1, 'an interrupted stream must not restart on another key');
  });

  test('a pinned stream sends exactly that model', async () => {
    respond = () => ({ sse: [chunk('ok', 'stop')] });
    await stream(() => {}, undefined, undefined, { model: 'openai/gpt-oss-20b' });
    assert.equal(requests[0].body.model, 'openai/gpt-oss-20b');
  });
});

describe('nvidia — no secret ever reaches a log', () => {
  test('across every scenario above, logs name slots, never key material', () => {
    assert.ok(logs.length > 0, 'the adapter logged nothing — this check would be vacuous');
    const leaked = logs.filter(l => l.includes('nv-fake-secret') || /Bearer\s/i.test(l));
    assert.deepEqual(leaked, []);
    assert.ok(logs.some(l => /key=#\d/.test(l)), 'logs should identify keys by slot number');
  });
});
