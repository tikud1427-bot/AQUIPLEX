/**
 * 2026-11-10 — when every provider circuit is OPEN (typically all free-tier
 * quotas exhausted), one request makes ONE degraded pass, not maxRounds of
 * them. Each extra round re-sent the request to every open circuit.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from '../router.js';
import { __resetForTests as resetHealth, markFailure } from '../../core/health.js';
import { __resetForTests as resetRegistry } from '../modelRegistry.js';

const PROVIDERS = ['gemini', 'groq', 'openrouter', 'nvidia'];
const run = (deps) =>
  generateText('q', 'sys', [{ role: 'user', content: 'q' }], { attempts: [] }, 'simple_qa', undefined, undefined, deps);

beforeEach(() => { resetHealth(); resetRegistry(); });

test('all circuits open + 429 everywhere → one degraded pass, no retry rounds', async () => {
  for (const p of PROVIDERS) for (let i = 0; i < 3; i++) markFailure(p, 'rate_limit', { type: 'rate_limit' });
  let calls = 0;
  const rl = async () => { calls++; throw Object.assign(new Error('rl'), { status: 429 }); };
  const naps = [];
  await assert.rejects(run({
    gemini: rl, groq: rl, openrouter: rl, nvidia: rl,
    sleep: async (ms) => { naps.push(ms); },
    config: { maxRounds: 4, retryBudgetMs: 999_999, baseBackoffMs: 1, capBackoffMs: 2 }, rng: () => 0,
  }), (err) => err.retryable === true);
  assert.equal(calls, PROVIDERS.length, 'each provider tried once — not once per round');
  assert.ok(naps.length <= 1);
});

test('degraded pass still serves the answer when a provider actually works', async () => {
  for (const p of PROVIDERS) for (let i = 0; i < 3; i++) markFailure(p, 'rate_limit', { type: 'rate_limit' });
  const rl = async () => { throw Object.assign(new Error('rl'), { status: 429 }); };
  const r = await run({
    gemini: rl, groq: rl, openrouter: async () => ({ text: 'ok:or', truncated: false, finishReason: 'stop' }), nvidia: rl,
    sleep: async () => {}, config: { maxRounds: 4, retryBudgetMs: 999_999, baseBackoffMs: 1, capBackoffMs: 2 }, rng: () => 0,
  });
  assert.equal(r.text, 'ok:or');
});
