import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHuggingFaceCrossEncoder } from '../contextEngine/crossEncoder.js';

describe('E7 PR-8 Hugging Face cross-encoder adapter', () => {
  test('sends query/candidate as a text pair and returns relevance score', async () => {
    let request;
    const adapter = createHuggingFaceCrossEncoder({
      token: 'test-token',
      model: 'test-model',
      fetchImpl: async (_url, init) => {
        request = { url: _url, init };
        return { ok: true, status: 200, async json() { return [{ label: 'relevant', score: 0.87 }]; } };
      },
    });
    const score = await adapter.scorePair('what is aqua?', { statement: 'Aqua is a personal AI.' });
    assert.equal(score, 0.87);
    assert.match(request.url, /test-model/);
    const body = JSON.parse(request.init.body);
    assert.equal(body.inputs.text, 'what is aqua?');
    assert.equal(body.inputs.text_pair, 'Aqua is a personal AI.');
  });


  test('caches identical query/candidate pairs with bounded adapter cache', async () => {
    let calls = 0;
    const adapter = createHuggingFaceCrossEncoder({
      token: 'test-token',
      model: 'test-model',
      cacheSize: 2,
      cacheTtlMs: 60_000,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, async json() { return [{ label: 'relevant', score: 0.91 }]; } };
      },
    });
    assert.equal(await adapter.scorePair('q', { statement: 'x' }), 0.91);
    assert.equal(await adapter.scorePair('q', { statement: 'x' }), 0.91);
    assert.equal(calls, 1);
    assert.equal(adapter.cacheStats().size, 1);
    adapter.clearCache();
    assert.equal(adapter.cacheStats().size, 0);
  });

  test('rejects non-successful inference responses', async () => {
    const adapter = createHuggingFaceCrossEncoder({
      token: 'test-token',
      fetchImpl: async () => ({ ok: false, status: 503, async json() { return { error: 'loading' }; } }),
    });
    await assert.rejects(() => adapter.scorePair('q', { statement: 'x' }), /HTTP 503/);
  });

  test('requires explicit credentials', () => {
    assert.throws(() => createHuggingFaceCrossEncoder({ token: '' }), /HF_TOKEN/);
  });
});
