/**
 * E12: cost counters reflect real provider traffic, and an unpriced call never
 * shows up as $0. Before 2026-10-04 nothing in production called the cost
 * recorder, so /metrics exported 0 calls and aqua_cost_usd_total 0 forever.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordProviderCall, getCostMetrics, setPriceTable, _resetCostMetrics } from '../costAccounting.js';
import { renderPrometheus } from '../metricsExposition.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
beforeEach(() => _resetCostMetrics());

test('an unpriced call counts tokens and WITHHOLDS the USD total', () => {
  recordProviderCall({ provider: 'groq', model: 'm', usage: { inputTokens: 100, outputTokens: 20 }, purpose: 'extraction' });
  const c = getCostMetrics();
  assert.equal(c.calls, 1); assert.equal(c.inputTokens, 100); assert.equal(c.unpricedCalls, 1);
  assert.equal(c.complete, false);
  assert.equal(c.byPurpose.extraction.calls, 1);
  const text = renderPrometheus({ cost: c });
  assert.match(text, /aqua_cost_calls_total 1/);
  assert.doesNotMatch(text, /aqua_cost_usd_total/, 'a partial sum was exported as spend');
});

test('when every call is priced the USD total is exported', () => {
  setPriceTable({ 'groq/m': { inputPerMTok: 1, outputPerMTok: 2 } });
  recordProviderCall({ provider: 'groq', model: 'm', usage: { inputTokens: 1_000_000, outputTokens: 500_000 } });
  assert.match(renderPrometheus({ cost: getCostMetrics() }), /aqua_cost_usd_total 2/);
});

test('a call with no usage report is counted as unpriced, never as free', () => {
  setPriceTable({ 'gemini/m': { inputPerMTok: 1, outputPerMTok: 1 } });
  recordProviderCall({ provider: 'gemini', model: 'm', usage: null });
  const c = getCostMetrics();
  assert.equal(c.unpricedCalls, 1); assert.equal(c.unreportedUsageCalls, 1);
});

test('every provider transport records its successful calls', () => {
  // Success exits per adapter. Since the shared key pool (2026-10-15) every
  // adapter funnels truncated and normal completions through ONE generate exit
  // plus one stream exit (2); gemini.js adds its media-analysis exit (3).
  const SUCCESS_EXITS = { 'groq.js': 2, 'gemini.js': 3, 'openrouter.js': 2, 'nvidia.js': 2 };
  for (const [f, min] of Object.entries(SUCCESS_EXITS)) {
    const s = readFileSync(path.join(SRC, 'providers', f), 'utf8');
    assert.match(s, /recordProviderCall\(/, `${f} does not record cost`);
    assert.ok((s.match(/return countedCall\(/g) ?? []).length >= min, `${f}: a success path is not counted`);
  }
  assert.match(readFileSync(path.join(SRC, 'brain', 'index.js'), 'utf8'), /purpose: 'extraction'/,
    'E6 extraction spend is no longer attributed');
});

test('an nvidia call is accounted exactly like the others, and stays unpriced until priced', () => {
  recordProviderCall({ provider: 'nvidia', model: 'openai/gpt-oss-20b', usage: { inputTokens: 40, outputTokens: 9 }, purpose: 'chat' });
  let c = getCostMetrics();
  assert.equal(c.calls, 1); assert.equal(c.inputTokens, 40); assert.equal(c.outputTokens, 9);
  assert.equal(c.unpricedCalls, 1, 'an unpriced NVIDIA call must not read as free');
  _resetCostMetrics();
  setPriceTable({ 'nvidia/openai/gpt-oss-20b': { inputPerMTok: 1, outputPerMTok: 1 } });
  recordProviderCall({ provider: 'nvidia', model: 'openai/gpt-oss-20b', usage: { inputTokens: 1_000_000, outputTokens: 0 } });
  c = getCostMetrics();
  assert.equal(c.unpricedCalls, 0); assert.equal(c.pricedCostUsd, 1);
});
