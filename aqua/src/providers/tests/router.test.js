import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from '../router.js';
import { __resetForTests as resetHealth } from '../../core/health.js';
import { __resetForTests as resetRegistry } from '../modelRegistry.js';

// Fake providers — the DI seam lets these stand in for the real SDK adapters,
// so router behavior is asserted with zero network calls.
const ok  = (name) => async () => ({ text: `ok:${name}`, truncated: false, finishReason: 'stop' });
const err = (o)    => async () => { throw Object.assign(new Error(o.message ?? 'boom'), o); };

// Tight retry config so tests run instantly; sleep is a spy that never waits.
const fastCfg  = { config: { maxRounds: 4, retryBudgetMs: 999_999, baseBackoffMs: 1, capBackoffMs: 2 }, rng: () => 0 };
const spySleep = () => { const calls = []; return { calls, sleep: async (ms) => { calls.push(ms); } }; };
const run = (deps) =>
  generateText('q', 'sys', [{ role: 'user', content: 'q' }], { attempts: [] }, 'simple_qa', undefined, undefined, deps);

describe('router — resilient provider orchestration', () => {
  beforeEach(() => { resetHealth(); resetRegistry(); });

  test('first provider success → no retries, correct shape, zero backoff', async () => {
    const s = spySleep();
    const r = await run({ gemini: ok('g'), groq: ok('groq'), openrouter: ok('or'), sleep: s.sleep, ...fastCfg });
    assert.match(r.text, /^ok:/);
    assert.equal(r.rounds, 1);
    assert.equal(r.attempts, 1);
    assert.equal(s.calls.length, 0, 'no backoff on first-try success');
  });

  test('transient 429 burst then recovery → succeeds, backoff engaged', async () => {
    let n = 0;
    const flaky = async () => { n++; if (n <= 4) throw Object.assign(new Error('rl'), { status: 429 }); return { text: 'ok:recovered', truncated: false, finishReason: 'stop' }; };
    const s = spySleep();
    const r = await run({ gemini: flaky, groq: flaky, openrouter: flaky, sleep: s.sleep, ...fastCfg });
    assert.match(r.text, /^ok:/);
    assert.ok(s.calls.length >= 1, 'exponential backoff slept between rounds');
    assert.ok(r.rounds >= 2, 'recovery happened on a later round');
  });

  test('non-retryable auth on all providers → throws terminal, retryable=false, no backoff', async () => {
    const s = spySleep();
    await assert.rejects(
      run({ gemini: err({ status: 401 }), groq: err({ status: 401 }), openrouter: err({ status: 401 }), sleep: s.sleep, ...fastCfg }),
      (e) => { assert.equal(e.retryable, false); assert.equal(e.type, 'auth'); assert.equal(e.code, 'AUTH'); return true; },
    );
    assert.equal(s.calls.length, 0, 'terminal failures must not trigger retry rounds');
  });

  test('persistent transient exhaustion → retryable terminal with structured attempts', async () => {
    const ctx = { attempts: [] };
    await assert.rejects(
      generateText('q', 'sys', [{ role: 'user', content: 'q' }], ctx, 'simple_qa', undefined, undefined,
        { gemini: err({ status: 503 }), groq: err({ status: 503 }), openrouter: err({ code: 'ECONNRESET' }), sleep: async () => {}, ...fastCfg }),
      (e) => {
        assert.equal(e.retryable, true);
        assert.ok(e.retryAfterMs > 0);
        assert.ok(Array.isArray(e.attempts) && e.attempts.length > 0);
        assert.ok(Array.isArray(e.providerErrors) && e.providerErrors[0].type);
        return true;
      },
    );
    assert.ok(ctx.attempts.every(a => a.outcome === 'failed'));
    assert.ok(ctx.attempts.some(a => a.error && a.error.retryable === true), 'attempts carry structured error objects');
  });

  test('one provider fails transiently, another succeeds same round → immediate fallback, no backoff', async () => {
    const s = spySleep();
    const r = await run({ gemini: err({ status: 500 }), groq: ok('groq'), openrouter: ok('or'), sleep: s.sleep, ...fastCfg });
    assert.match(r.text, /^ok:/);
    assert.equal(r.rounds, 1, 'same-round fallback — no extra round needed');
    assert.equal(s.calls.length, 0);
  });

  test('Retry-After on 429 raises the terminal retryAfterMs hint', async () => {
    const rl = err({ status: 429, response: { headers: { get: (h) => (h === 'retry-after' ? '7' : null) } } });
    await assert.rejects(
      generateText('q', 'sys', [{ role: 'user', content: 'q' }], { attempts: [] }, 'simple_qa', undefined, undefined,
        { gemini: rl, groq: rl, openrouter: rl, sleep: async () => {}, config: { maxRounds: 2, retryBudgetMs: 999_999, baseBackoffMs: 1, capBackoffMs: 2 }, rng: () => 0 }),
      (e) => { assert.equal(e.retryable, true); assert.ok(e.retryAfterMs >= 7000); return true; },
    );
  });
});
