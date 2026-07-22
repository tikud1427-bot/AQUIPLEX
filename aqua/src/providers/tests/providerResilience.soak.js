/**
 * Provider resilience soak — 1200 requests through the REAL router / health /
 * circuit-breaker machinery under sustained ~30% transient failure.
 *
 * Uses a VIRTUAL CLOCK so provider cooldowns (60s) actually expire over the
 * run — this models a real benchmark where each request takes real wall-clock
 * time. (The earlier instantaneous loop never advanced the clock, so cooldowns
 * could never expire and the breaker could never recover the normal way, which
 * masked a real bug: markSuccess didn't close the circuit from OPEN, so a
 * degraded-mode success left it stuck open and every request re-entered
 * degraded mode. That is now fixed in health.js and asserted here.)
 *
 * Proves: (a) high completion, (b) transient exhaustion is RETRYABLE not a 500,
 * (c) NO permanent model deprecation, (d) the breaker RECOVERS — degraded mode
 * is a bounded blip, not the steady state.
 *
 * Run: npm run soak:providers   (exits non-zero on regression)
 * Full routing trace: AQUA_PROVIDER_LOG=debug node src/providers/tests/providerResilience.soak.js
 */
import { generateText } from '../router.js';
import { __resetForTests as resetHealth, getHealthReport } from '../../core/health.js';
import { __resetForTests as resetRegistry, getRegistrySnapshot } from '../modelRegistry.js';

const N              = 1200;
const FAIL_RATE      = 0.30;   // 30% of attempts fail transiently
const AUTH_RATE      = 0.001;  // rare terminal failure
const REQ_LATENCY_MS = 800;    // simulated wall-clock per request

// Virtual clock — health.js reads the global Date.now(), so patch it there.
const realNow = Date.now;
let   clock   = realNow();
Date.now = () => clock;

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
  sleep:      async (ms) => { clock += ms; }, // backoff advances virtual time
  config:     { maxRounds: 5, retryBudgetMs: 60_000, baseBackoffMs: 5, capBackoffMs: 25 },
};

// Count how often the router actually enters degraded mode, and silence the
// per-request trace so the soak prints just its verdict.
let degradedEntries = 0;
const realWarn = console.warn, realLog = console.log;
console.warn = (...a) => { if (String(a[0]).includes('degraded mode')) degradedEntries++; };
console.log  = () => {};

(async () => {
  resetHealth();
  resetRegistry();

  let completed = 0, retryableFail = 0, terminalFail = 0, maxRounds = 0;
  const openSamples = [];

  for (let i = 0; i < N; i++) {
    clock += REQ_LATENCY_MS; // simulate real elapsed time between requests
    try {
      const r = await generateText(
        `q${i}`, 'sys', [{ role: 'user', content: `q${i}` }],
        { attempts: [] }, 'simple_qa', undefined, undefined, deps,
      );
      if (r?.text) { completed++; maxRounds = Math.max(maxRounds, r.rounds ?? 1); }
    } catch (e) {
      if (e?.retryable) retryableFail++; else terminalFail++;
    }
    if (i % 100 === 0) {
      const rep = getHealthReport();
      openSamples.push(Object.values(rep).filter(p => p.circuitState === 'open').length);
    }
  }

  console.log = realLog; console.warn = realWarn;

  const report     = getHealthReport();
  const registry   = getRegistrySnapshot();
  const deprecated = Object.entries(registry).flatMap(([p, ms]) =>
    ms.filter(m => m.status === 'deprecated').map(m => `${p}/${m.modelId}`));
  const pct        = (completed / N) * 100;
  const finalOpen  = Object.entries(report).filter(([, p]) => p.circuitState === 'open').map(([p]) => p);
  const degradedPct = (degradedEntries / N) * 100;
  const elapsedMin  = ((clock - realNow()) / 60_000).toFixed(1);

  console.log('\n=== PROVIDER RESILIENCE SOAK (virtual clock, cooldowns expire) ===');
  console.log(`requests=${N} completed=${completed} (${pct.toFixed(2)}%) retryableFail=${retryableFail} terminalFail=${terminalFail} maxRoundsUsed=${maxRounds}`);
  console.log(`simulated elapsed=${elapsedMin}min  degraded-mode entries=${degradedEntries} (${degradedPct.toFixed(1)}% of requests)`);
  console.log(`open-circuit count sampled every 100 req: [${openSamples.join(', ')}]`);
  console.log(`circuits OPEN at end: [${finalOpen.join(', ') || 'none'}]`);
  console.log(`models permanently deprecated by transient failures: [${deprecated.join(', ') || 'none'}]`);
  console.log('final provider health:', JSON.stringify(report, null, 2));

  const THRESH_PCT = 98, MAX_TERMINAL = Math.ceil(N * 0.02), MAX_DEGRADED_PCT = 25;
  const failures = [];
  if (pct < THRESH_PCT)            failures.push(`completion ${pct.toFixed(2)}% < ${THRESH_PCT}%`);
  if (terminalFail > MAX_TERMINAL) failures.push(`terminal(500) failures ${terminalFail} exceed 2% (${MAX_TERMINAL})`);
  if (deprecated.length)           failures.push(`transient failures permanently deprecated models: ${deprecated.join(', ')}`);
  if (degradedPct > MAX_DEGRADED_PCT) failures.push(`degraded-mode on ${degradedPct.toFixed(1)}% of requests (>${MAX_DEGRADED_PCT}%) — breaker not recovering`);
  if (finalOpen.length === 3)      failures.push('all circuits OPEN at end — breaker not recovering');

  if (failures.length) {
    console.error('FAIL:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('PASS \u2713 (high completion, breaker recovers, bounded degraded mode, zero permanent lockout)\n');
  process.exit(0);
})();
