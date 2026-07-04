import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCandidateModels, pickModel, getModelSpec,
  markModelUnavailable, markModelRateLimited, markModelTempFailed, markModelWorking,
  validateEntry, validateRegistryOnStartup, getRegistrySnapshot,
  __resetForTests,
} from '../modelRegistry.js';

describe('modelRegistry.js — candidate selection', () => {
  test('every provider has at least one candidate model by default', () => {
    __resetForTests();
    for (const p of ['gemini', 'groq', 'openrouter']) {
      assert.ok(getCandidateModels(p).length > 0, `${p} should have candidates`);
    }
  });

  test('gemini/groq (rotate:false) always prefer the first entry in listed order', () => {
    __resetForTests();
    const first = pickModel('gemini').modelId;
    // Calling repeatedly should not rotate a non-rotating provider.
    assert.equal(pickModel('gemini').modelId, first);
    assert.equal(pickModel('gemini').modelId, first);
  });

  test('unknown provider returns an empty candidate list, not a throw', () => {
    __resetForTests();
    assert.deepEqual(getCandidateModels('not_a_provider'), []);
    assert.equal(pickModel('not_a_provider'), null);
  });

  test('getModelSpec returns the full entry for clamping maxTokens', () => {
    __resetForTests();
    const spec = getModelSpec('groq', 'openai/gpt-oss-120b');
    assert.ok(spec);
    assert.equal(spec.provider, 'groq');
    assert.ok(spec.maxOutputTokens > 0);
  });
});

describe('modelRegistry.js — Issue 4: model-scoped failures never touch siblings', () => {
  test('marking one OpenRouter model deprecated removes ONLY that model from candidates', () => {
    __resetForTests();
    const before = getCandidateModels('openrouter').map(m => m.modelId);
    const target = before[0];

    markModelUnavailable('openrouter', target, 'test 404');

    const after = getCandidateModels('openrouter').map(m => m.modelId);
    assert.ok(!after.includes(target), 'deprecated model should be excluded');
    for (const id of before) {
      if (id !== target) assert.ok(after.includes(id), `sibling model ${id} should remain available`);
    }
    assert.equal(after.length, before.length - 1);
  });

  test('marking a model unavailable never disables a different provider\u2019s models', () => {
    __resetForTests();
    const geminiBefore = getCandidateModels('gemini').length;
    markModelUnavailable('openrouter', getCandidateModels('openrouter')[0].modelId, 'test 404');
    assert.equal(getCandidateModels('gemini').length, geminiBefore);
  });

  test('deprecation is permanent — does not self-heal over time', (t) => {
    __resetForTests();
    t.mock.timers.enable({ apis: ['Date'] });
    const target = getCandidateModels('groq')[0].modelId;
    markModelUnavailable('groq', target, 'test 404');
    t.mock.timers.tick(365 * 24 * 60 * 60 * 1000); // one year later
    assert.ok(!getCandidateModels('groq').map(m => m.modelId).includes(target));
  });

  test('rate-limited model self-heals after its cooldown expires', (t) => {
    __resetForTests();
    t.mock.timers.enable({ apis: ['Date'] });
    const target = getCandidateModels('openrouter')[0].modelId;

    markModelRateLimited('openrouter', target, 120_000);
    assert.ok(!getCandidateModels('openrouter').map(m => m.modelId).includes(target));

    t.mock.timers.tick(121_000);
    assert.ok(getCandidateModels('openrouter').map(m => m.modelId).includes(target), 'should self-heal after cooldown');
  });

  test('temp-failed model self-heals after its cooldown expires', (t) => {
    __resetForTests();
    t.mock.timers.enable({ apis: ['Date'] });
    const target = getCandidateModels('openrouter')[1].modelId;

    markModelTempFailed('openrouter', target, 45_000);
    assert.ok(!getCandidateModels('openrouter').map(m => m.modelId).includes(target));

    t.mock.timers.tick(46_000);
    assert.ok(getCandidateModels('openrouter').map(m => m.modelId).includes(target));
  });

  test('markModelWorking clears a rate-limited/temp-failed state immediately', () => {
    __resetForTests();
    const target = getCandidateModels('openrouter')[0].modelId;
    markModelRateLimited('openrouter', target, 999_999);
    assert.ok(!getCandidateModels('openrouter').map(m => m.modelId).includes(target));
    markModelWorking('openrouter', target);
    assert.ok(getCandidateModels('openrouter').map(m => m.modelId).includes(target));
  });

  test('a deprecated model cannot be revived by markModelTempFailed/markModelRateLimited (deprecation wins)', () => {
    __resetForTests();
    const target = getCandidateModels('groq')[0].modelId;
    markModelUnavailable('groq', target, 'test 404');
    markModelTempFailed('groq', target, 1); // should be a no-op against a deprecated entry
    assert.ok(!getCandidateModels('groq').map(m => m.modelId).includes(target));
  });

  test('exhausting every OpenRouter model leaves an empty candidate list, not a throw', () => {
    __resetForTests();
    for (const m of getCandidateModels('openrouter')) {
      markModelUnavailable('openrouter', m.modelId, 'test 404');
    }
    assert.deepEqual(getCandidateModels('openrouter'), []);
    assert.equal(pickModel('openrouter'), null);
  });
});

describe('modelRegistry.js — OpenRouter rotation', () => {
  test('rotate:true providers cycle through candidates rather than always returning the same one', () => {
    __resetForTests();
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      seen.add(getCandidateModels('openrouter')[0].modelId);
    }
    assert.ok(seen.size > 1, 'rotation should surface more than one model as the top pick across calls');
  });
});

describe('modelRegistry.js — Issue 6: startup validation', () => {
  test('validateEntry accepts a well-formed entry', () => {
    const problems = validateEntry({
      provider: 'groq', modelId: 'x', maxOutputTokens: 4096, contextWindow: 8192, capabilities: ['chat'],
    }, 'groq');
    assert.deepEqual(problems, []);
  });

  test('validateEntry flags a missing modelId without throwing', () => {
    const problems = validateEntry({
      provider: 'groq', modelId: '', maxOutputTokens: 4096, contextWindow: 8192, capabilities: ['chat'],
    }, 'groq');
    assert.ok(problems.length > 0);
  });

  test('validateEntry flags invalid maxOutputTokens/contextWindow', () => {
    const problems = validateEntry({
      provider: 'groq', modelId: 'x', maxOutputTokens: -1, contextWindow: 0, capabilities: ['chat'],
    }, 'groq');
    assert.ok(problems.some(p => p.includes('maxOutputTokens')));
    assert.ok(problems.some(p => p.includes('contextWindow')));
  });

  test('validateEntry flags a provider mismatch', () => {
    const problems = validateEntry({
      provider: 'gemini', modelId: 'x', maxOutputTokens: 4096, contextWindow: 8192, capabilities: ['chat'],
    }, 'groq');
    assert.ok(problems.some(p => p.includes('provider mismatch')));
  });

  test('validateEntry never throws on garbage input', () => {
    assert.doesNotThrow(() => validateEntry(null, 'groq'));
    assert.doesNotThrow(() => validateEntry(undefined, 'groq'));
    assert.doesNotThrow(() => validateEntry({}, 'groq'));
  });

  test('validateRegistryOnStartup never throws and reports the real registry as fully valid', () => {
    __resetForTests();
    const result = validateRegistryOnStartup();
    assert.equal(typeof result.validCount, 'number');
    assert.equal(typeof result.disabledCount, 'number');
    assert.equal(result.disabledCount, 0, 'the real registry should have no malformed entries');
    assert.ok(result.validCount > 0);
  });

  test('validateRegistryOnStartup is idempotent (safe to call multiple times)', () => {
    __resetForTests();
    const r1 = validateRegistryOnStartup();
    const r2 = validateRegistryOnStartup();
    assert.deepEqual(r1, r2);
  });
});

describe('modelRegistry.js — introspection', () => {
  test('getRegistrySnapshot returns every provider with an array of model summaries', () => {
    __resetForTests();
    const snap = getRegistrySnapshot();
    for (const p of ['gemini', 'groq', 'openrouter']) {
      assert.ok(Array.isArray(snap[p]));
      assert.ok(snap[p].length > 0);
      assert.ok('modelId' in snap[p][0]);
      assert.ok('status' in snap[p][0]);
    }
  });

  test('snapshot reflects a deprecated model\u2019s status without needing to be re-fetched from candidates', () => {
    __resetForTests();
    const target = getCandidateModels('groq')[0].modelId;
    markModelUnavailable('groq', target, 'test 404');
    const snap = getRegistrySnapshot();
    const entry = snap.groq.find(m => m.modelId === target);
    assert.equal(entry.status, 'deprecated');
  });
});
