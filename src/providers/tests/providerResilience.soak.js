/**
 * Provider resilience soak — 1200 simulated requests through the REAL router /
 * health / circuit-breaker machinery with flaky fake providers (transient,
 * provider-scoped failures). Proves, at benchmark scale, that:
 *   (a) completion stays high under sustained ~30% attempt failure,
 *   (b) transient exhaustion surfaces as RETRYABLE (503-mappable), not a
 *       terminal 500,
 *   (c) there is no permanent provider lockout (degraded mode keeps serving).
 *
 * Run: npm run soak:providers   (exits non-zero on regression)
 *
 * NOTE: fakes throw PROVIDER-scoped transient errors (TIMEOUT / ECONNRESET) so
 * they exercise the router's retry-round + circuit-breaker recovery without
 * fighting the registry's real-time model cooldowns. Per-model self-heal under
 * mock time is covered separately by modelRegistry.test.js.
 */
import { generateText } from '../router.js';
import { __resetForTests as resetHealth, getHealthReport } from '../../core/health.js';
import { __resetForTests as resetRegistry, getRegistrySnapshot } from '../modelRegistry.js';

const N         = 1200;
const FAIL_RATE = 0.30;   // 30% of attempts fail transiently
const AUTH_RATE = 0.001;  // rare terminal failure

function flaky(name, { authRate = 0 } = {}) {
  return async () => {
    const r = Math.random();
    if (r < authRate) throw Object.assign(new Error('invalid api key'), { status: 401 });
    if (r < FAIL_RATE) {
      return Math.random() < 0.5
        ? Promise.reject(new Error('TIMEOUT'))
        : Promise.reject(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
    }
    return { text: `answer from ${name}`, truncated: false, finishReason: 'stop' };
  };
}

const deps = {
  gemini:     flaky('gemini'),
  groq:       flaky('groq'),
  openrouter: flaky('openrouter', { authRate: AUTH_RATE }),
  sleep:      async () => {}, // instant — keeps the soak fast; backoff LOGIC still exercised
  config:     { maxRounds: 5, retryBudgetMs: 60_000, baseBackoffMs: 5, capBackoffMs: 25 },
};

(async () => {
  resetHealth();
  resetRegistry();

  let completed = 0, retryableFail = 0, terminalFail = 0, maxRounds = 0;
  const t0 = Date.now();

  for (let i = 0; i < N; i++) {
    try {
      const r = await generateText(
        `q${i}`, 'sys', [{ role: 'user', content: `q${i}` }],
        { attempts: [] }, 'simple_qa', undefined, undefined, deps,
      );
      if (r?.text) { completed++; maxRounds = Math.max(maxRounds, r.rounds ?? 1); }
    } catch (e) {
      if (e?.retryable) retryableFail++; else terminalFail++;
    }
  }

  const ms     = Date.now() - t0;
  const pct    = (completed / N) * 100;
  const report = getHealthReport();
  const registry = getRegistrySnapshot();

  // THE original bug: transient errors permanently deprecating models until a
  // provider had zero candidates forever. Assert that never happened — no model
  // should be in the permanent 'deprecated' state after a storm of transient
  // failures. (Per-model self-heal under mock time is pinned by modelRegistry.test.js;
  // provider-circuit auto-recovery after cooldown is pinned by health.test.js.)
  const deprecated = Object.entries(registry).flatMap(([p, models]) =>
    models.filter(m => m.status === 'deprecated').map(m => `${p}/${m.modelId}`));

  // How many circuits are OPEN is informational, not a failure: when every
  // circuit is open the router's degraded mode still attempts each provider,
  // which is exactly why completion stays high. The SLO is completion, not
  // circuit state at a single instant.
  const openCircuits = Object.entries(report).filter(([, p]) => p.circuitState === 'open').map(([p]) => p);

  console.log('\n=== PROVIDER RESILIENCE SOAK ===');
  console.log(`requests=${N} completed=${completed} (${pct.toFixed(2)}%) retryableFail=${retryableFail} terminalFail=${terminalFail} maxRoundsUsed=${maxRounds} in ${ms}ms`);
  console.log(`circuits OPEN at end (served via degraded mode, informational): [${openCircuits.join(', ') || 'none'}]`);
  console.log(`models permanently deprecated by transient failures: [${deprecated.join(', ') || 'none'}]`);
  console.log('final provider health:', JSON.stringify(report, null, 2));

  const THRESH_PCT   = 98;
  const MAX_TERMINAL = Math.ceil(N * 0.02);

  const failures = [];
  if (pct < THRESH_PCT)            failures.push(`completion ${pct.toFixed(2)}% < ${THRESH_PCT}%`);
  if (terminalFail > MAX_TERMINAL) failures.push(`terminal(500) failures ${terminalFail} exceed 2% (${MAX_TERMINAL})`);
  if (deprecated.length)           failures.push(`transient failures permanently deprecated models: ${deprecated.join(', ')}`);

  if (failures.length) {
    console.error('FAIL:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('PASS \u2713 (high completion, transient-only exhaustion, zero permanent model lockout)\n');
  process.exit(0);
})();
