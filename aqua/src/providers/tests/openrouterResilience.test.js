import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// This is the direct end-to-end regression for THE GSM8K bug: OpenRouter's
// free tier returns a 404 "No endpoints found for this model" as a TRANSIENT
// capacity signal. Pre-fix, the adapter classified that as model_not_found and
// permanently deprecated the model, eventually emptying the whole provider.
// Post-fix it must mark the model temp_failed (self-healing), never deprecated,
// and never touch a different provider's health.
//
// We stand up a tiny local HTTP server that answers like OpenRouter-under-load,
// point the real OpenAI SDK at it via OPENROUTER_BASE_URL, and drive the REAL
// generateOpenRouter → real classifier → real registry. Zero new deps.

let server, baseUrl;

function makeServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

describe('openrouter adapter — transient 404 does not permanently kill models', () => {
  before(() => {
    process.env.OPENROUTER_API_KEY_1 = 'test-key-1';
    process.env.OPENROUTER_API_KEY_2 = 'test-key-2';
  });

  beforeEach(async () => {
    const { __resetForTests } = await import('../modelRegistry.js');
    __resetForTests();
  });

  after(() => {
    if (server) server.close();
    delete process.env.OPENROUTER_BASE_URL;
  });

  test('"No endpoints found" 404 → models go temp_failed (self-healing), NOT deprecated', async (t) => {
    t.diagnostic('starting fake OpenRouter that 404s "no endpoints" for every model');
    server = await makeServer((req, res, _body) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'No endpoints found for this model', code: 404, type: 'invalid_request_error' },
      }));
    });
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;

    // Fresh import AFTER env is set so the SDK client picks up the base URL.
    const { generateOpenRouter } = await import('../openrouter.js');
    const { getRegistrySnapshot } = await import('../modelRegistry.js');
    const { __resetForTests: resetHealth, getProviderState } = await import('../../core/health.js');
    resetHealth();

    await assert.rejects(
      generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined),
      'every candidate model 404s → the call ultimately rejects',
    );

    const snap = getRegistrySnapshot().openrouter;
    const deprecated = snap.filter(m => m.status === 'deprecated');
    const tempFailed = snap.filter(m => m.status === 'temp_failed');

    assert.equal(deprecated.length, 0, 'NO model may be permanently deprecated by a transient "no endpoints" 404');
    assert.ok(tempFailed.length > 0, 'attempted models should be marked temp_failed (self-healing)');

    // Provider-level health must be untouched — this was a MODEL-scoped event.
    // (openrouter.js only propagates auth/network as provider failures.)
    assert.notEqual(getProviderState('openrouter').circuitState, 'open',
      'a model-scoped 404 must not open the provider circuit');

    // Sibling providers completely unaffected.
    assert.equal(getRegistrySnapshot().gemini.every(m => m.status === 'working'), true);
    assert.equal(getRegistrySnapshot().groq.every(m => m.status === 'working'), true);
  });

  test('a genuine 404 "is not a valid model" IS permanently deprecated (permanence preserved for real dead ids)', async (t) => {
    server?.close();
    server = await makeServer((req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'openrouter/nope is not a valid model ID', code: 404 } }));
    });
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;

    const { generateOpenRouter } = await import('../openrouter.js');
    const { getRegistrySnapshot } = await import('../modelRegistry.js');

    await assert.rejects(generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined));

    const snap = getRegistrySnapshot().openrouter;
    assert.ok(snap.some(m => m.status === 'deprecated'),
      'a real invalid-model-id 404 should still permanently deprecate (that behavior is intentional)');
  });
});
