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
    const r = await run({ gemini: ok('g'), groq: ok('groq'), openrouter: ok('or'), nvidia: ok('nv'), sleep: s.sleep, ...fastCfg });
    assert.match(r.text, /^ok:/);
    assert.equal(r.rounds, 1);
    assert.equal(r.attempts, 1);
    assert.equal(s.calls.length, 0, 'no backoff on first-try success');
  });

  test('transient 429 burst then recovery → succeeds, backoff engaged', async () => {
    let n = 0;
    const flaky = async () => { n++; if (n <= 4) throw Object.assign(new Error('rl'), { status: 429 }); return { text: 'ok:recovered', truncated: false, finishReason: 'stop' }; };
    const s = spySleep();
    const r = await run({ gemini: flaky, groq: flaky, openrouter: flaky, nvidia: flaky, sleep: s.sleep, ...fastCfg });
    assert.match(r.text, /^ok:/);
    assert.ok(s.calls.length >= 1, 'exponential backoff slept between rounds');
    assert.ok(r.rounds >= 2, 'recovery happened on a later round');
  });

  test('non-retryable auth on all providers → throws terminal, retryable=false, no backoff', async () => {
    const s = spySleep();
    await assert.rejects(
      run({ gemini: err({ status: 401 }), groq: err({ status: 401 }), openrouter: err({ status: 401 }), nvidia: err({ status: 401 }), sleep: s.sleep, ...fastCfg }),
      (e) => { assert.equal(e.retryable, false); assert.equal(e.type, 'auth'); assert.equal(e.code, 'AUTH'); return true; },
    );
    assert.equal(s.calls.length, 0, 'terminal failures must not trigger retry rounds');
  });

  test('persistent transient exhaustion → retryable terminal with structured attempts', async () => {
    const ctx = { attempts: [] };
    await assert.rejects(
      generateText('q', 'sys', [{ role: 'user', content: 'q' }], ctx, 'simple_qa', undefined, undefined,
        { gemini: err({ status: 503 }), groq: err({ status: 503 }), openrouter: err({ code: 'ECONNRESET' }), nvidia: err({ status: 503 }), sleep: async () => {}, ...fastCfg }),
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
    const r = await run({ gemini: err({ status: 500 }), groq: ok('groq'), openrouter: ok('or'), nvidia: ok('nv'), sleep: s.sleep, ...fastCfg });
    assert.match(r.text, /^ok:/);
    assert.equal(r.rounds, 1, 'same-round fallback — no extra round needed');
    assert.equal(s.calls.length, 0);
  });

  test('Retry-After on 429 raises the terminal retryAfterMs hint', async () => {
    const rl = err({ status: 429, response: { headers: { get: (h) => (h === 'retry-after' ? '7' : null) } } });
    await assert.rejects(
      generateText('q', 'sys', [{ role: 'user', content: 'q' }], { attempts: [] }, 'simple_qa', undefined, undefined,
        { gemini: rl, groq: rl, openrouter: rl, nvidia: rl, sleep: async () => {}, config: { maxRounds: 2, retryBudgetMs: 999_999, baseBackoffMs: 1, capBackoffMs: 2 }, rng: () => 0 }),
      (e) => { assert.equal(e.retryable, true); assert.ok(e.retryAfterMs >= 7000); return true; },
    );
  });
});

// ── NVIDIA as a fourth provider (2026-10) ─────────────────────────────────────
import { rankProviders, scoreProvider, preferredProviders, generateTextStream } from '../router.js';
import { markFailure, getProviderState, isProviderHealthy } from '../../core/health.js';
import { getProviderStrategy } from '../../core/strategy.js';

const ALL = ['gemini', 'groq', 'openrouter', 'nvidia'];
const allFail = (o) => Object.fromEntries(ALL.map(p => [p, err(o)]));

describe('router — nvidia participates in normal ranking', () => {
  beforeEach(() => { resetHealth(); resetRegistry(); delete process.env.AQUA_PROVIDER_PREFER; });

  test('every strategy includes nvidia, last — a fallback, never the configured primary', () => {
    for (const t of ['fast_chat', 'coding', 'architecture', 'research', 'reasoning', 'creative_writing', 'file_analysis', 'agent_task', 'simple_qa']) {
      const order = getProviderStrategy(t);
      assert.ok(order.includes('nvidia'), `${t} omits nvidia`);
      assert.equal(order.at(-1), 'nvidia', `${t}: nvidia must not lead the configured order`);
    }
  });

  test('with equal health, nvidia never outranks an incumbent on its preliminary prior', () => {
    for (const t of ['conversation', 'simple_qa', 'coding', 'reasoning', 'research', 'agent_task', 'file_analysis']) {
      const ranked = rankProviders(t).map(r => r.provider);
      assert.ok(ranked.includes('nvidia'), `${t}: nvidia not ranked`);
      assert.notEqual(ranked[0], 'nvidia', `${t}: nvidia became primary without configuration`);
      assert.ok(scoreProvider('nvidia', t) > 0);
    }
  });

  test('AQUA_PROVIDER_PREFER=nvidia moves it to the front; the rest stay as fallback', () => {
    process.env.AQUA_PROVIDER_PREFER = 'nvidia';
    const ranked = rankProviders('simple_qa').map(r => r.provider);
    assert.equal(ranked[0], 'nvidia');
    assert.deepEqual([...ranked].sort(), [...ALL].sort());
    assert.deepEqual(preferredProviders({ AQUA_PROVIDER_PREFER: ' NVIDIA , groq ' }), ['nvidia', 'groq']);
  });

  test('a preferred but UNHEALTHY provider is still skipped', () => {
    process.env.AQUA_PROVIDER_PREFER = 'nvidia';
    for (let i = 0; i < 3; i++) markFailure('nvidia', 'x');
    assert.equal(isProviderHealthy('nvidia'), false);
    assert.ok(!rankProviders('simple_qa').some(r => r.provider === 'nvidia'));
  });

  test('preference reaches the call order: nvidia answers first when preferred', async () => {
    process.env.AQUA_PROVIDER_PREFER = 'nvidia';
    const r = await run({ gemini: ok('g'), groq: ok('groq'), openrouter: ok('or'), nvidia: ok('nv'), sleep: async () => {}, ...fastCfg });
    assert.equal(r.provider, 'nvidia');
    assert.equal(r.text, 'ok:nv');
  });

  test('fallback: every incumbent fails → nvidia answers in the same round', async () => {
    const r = await run({ gemini: err({ status: 500 }), groq: err({ status: 503 }), openrouter: err({ code: 'ECONNRESET' }), nvidia: ok('nv'), sleep: async () => {}, ...fastCfg });
    assert.equal(r.provider, 'nvidia');
    assert.equal(r.rounds, 1);
    assert.equal(getProviderState('nvidia').consecutiveFailures, 0);
  });

  test('all four non-retryable → terminal auth, no retry rounds', async () => {
    const s = spySleep();
    await assert.rejects(run({ ...allFail({ status: 401 }), sleep: s.sleep, ...fastCfg }),
      e => e.type === 'auth' && e.retryable === false && e.attempts.length === 4);
    assert.equal(s.calls.length, 0);
  });

  test('all-provider degraded mode still attempts nvidia, and its success closes its circuit', async () => {
    for (const p of ALL) for (let i = 0; i < 3; i++) markFailure(p, 'x');
    for (const p of ALL) assert.equal(getProviderState(p).circuitState, 'open');
    const r = await run({ gemini: err({ status: 503 }), groq: err({ status: 503 }), openrouter: err({ status: 503 }), nvidia: ok('nv'), sleep: async () => {}, ...fastCfg });
    assert.equal(r.provider, 'nvidia');
    assert.equal(getProviderState('nvidia').circuitState, 'closed');
  });

  test('a 429 from nvidia is retryable and does not permanently remove it', async () => {
    let n = 0;
    const nv = async () => { if (n++ === 0) throw Object.assign(new Error('rl'), { status: 429 }); return { text: 'ok:nv', truncated: false, finishReason: 'stop' }; };
    const r = await run({ ...allFail({ status: 503 }), nvidia: nv, sleep: async () => {}, ...fastCfg });
    assert.equal(r.provider, 'nvidia');
    assert.ok(r.rounds >= 2);
  });
});

describe('router — streaming reaches nvidia', () => {
  beforeEach(() => { resetHealth(); resetRegistry(); delete process.env.AQUA_PROVIDER_PREFER; });

  const failStream = async () => { throw Object.assign(new Error('down'), { status: 503 }); };

  test('pre-token failures on the incumbents fall through to streamNvidia', async () => {
    const events = [];
    const r = await generateTextStream({
      userMessage: 'q', systemPrompt: 'sys', messages: [{ role: 'user', content: 'q' }],
      preTaskType: 'simple_qa', onEvent: e => events.push(e),
      deps: { stream: {
        gemini: failStream, groq: failStream, openrouter: failStream,
        nvidia: async (_s, _m, _sig, _mt, onDelta) => { onDelta('hi'); onDelta(' there'); return { text: 'hi there', truncated: false, finishReason: 'stop', streamed: true, model: 'openai/gpt-oss-20b', usage: { inputTokens: 1, outputTokens: 2 } }; },
      } },
    });
    assert.equal(r.provider, 'nvidia');
    assert.equal(r.model, 'openai/gpt-oss-20b');
    assert.equal(events.filter(e => e.type === 'token').map(e => e.text).join(''), 'hi there');
    assert.equal(events.filter(e => e.type === 'provider_failed').length, 3);
  });
});
