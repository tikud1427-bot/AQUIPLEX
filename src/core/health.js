/**
 * AQUA Health Monitor v3 — Circuit Breaker
 *
 * Circuit breaker states:
 *   CLOSED    — normal operation, all requests pass through
 *   OPEN      — provider down, requests rejected immediately (no network call)
 *   HALF_OPEN — trial state after cooldown expires: ONE probe request allowed
 *               success → CLOSED   (reset consecutiveFailures, shrink cooldownCount)
 *               failure → OPEN     (longer backoff, back to waiting)
 *
 * Why this matters:
 *   Without HALF_OPEN, providers stay OPEN until manually reset.
 *   HALF_OPEN lets the system automatically rediscover working providers
 *   without risking a flood of requests during recovery.
 *
 * Health score (0–100) drives provider ranking in router.
 * Score = (successRate × 60) + 40 - latencyPenalty - failurePenalty
 */

const START_MS     = Date.now();   // server boot timestamp

const WINDOW       = 20;          // rolling window for success/latency stats
const COOLDOWN_MS  = 60_000;      // base cooldown: 1 min
const COOLDOWN_MAX = 600_000;     // cap: 10 min
const FAIL_THRESH  = 3;           // consecutive failures before OPEN

// Circuit breaker state constants
const CB_CLOSED    = 'closed';
const CB_OPEN      = 'open';
const CB_HALF_OPEN = 'half_open';

function fresh() {
  return {
    outcomes:            [],      // bool[] rolling window
    latencies:           [],      // ms[] rolling window
    consecutiveFailures: 0,
    cooldownUntil:       0,
    cooldownCount:       0,
    totalRequests:       0,
    totalSuccesses:      0,
    totalFailures:       0,
    lastSuccess:         0,
    lastFailure:         0,
    // Circuit breaker
    circuitState:        CB_CLOSED,
    halfOpenProbe:       false,   // true while a probe request is in-flight
  };
}

const state = {
  gemini:     fresh(),
  groq:       fresh(),
  openrouter: fresh(),
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function successRate(s) {
  if (!s.outcomes.length) return 0.75; // optimistic default (no data yet)
  return s.outcomes.filter(Boolean).length / s.outcomes.length;
}

function avgLatencyMs(s) {
  if (!s.latencies.length) return 600;
  return s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length;
}

function computeScore(s) {
  if (s.circuitState === CB_OPEN) return 0;

  const srPart      = successRate(s) * 60;          // 0–60
  const latPenalty  = Math.min(avgLatencyMs(s) / 200, 20); // 0–20
  const failPenalty = Math.min(s.consecutiveFailures * 10, 30); // 0–30

  return Math.max(0, Math.min(100, srPart + 40 - latPenalty - failPenalty));
}

function push(arr, val) {
  arr.push(val);
  if (arr.length > WINDOW) arr.shift();
}

// ── Circuit breaker transitions ───────────────────────────────────────────────

function transitionToOpen(s, provider, reason, minMs = 0) {
  // Exponential provider-level backoff, but never SHORTER than a cooldown the
  // provider explicitly asked for (429/503 Retry-After, threaded from
  // markFailure's opts.cooldownMs). Still capped at COOLDOWN_MAX.
  const backoff = COOLDOWN_MS * 2 ** s.cooldownCount;
  const ms = Math.min(Math.max(backoff, minMs || 0), COOLDOWN_MAX);
  s.cooldownUntil = Date.now() + ms;
  s.cooldownCount++;
  s.circuitState  = CB_OPEN;
  s.halfOpenProbe = false;
  console.log(`[CB] ${provider} → OPEN | backoff=${(ms/1000).toFixed(0)}s | reason=${reason}`);
}

function transitionToClosed(s, provider) {
  s.circuitState        = CB_CLOSED;
  s.consecutiveFailures = 0;
  s.halfOpenProbe       = false;
  s.cooldownCount       = Math.max(0, s.cooldownCount - 1);
  console.log(`[CB] ${provider} → CLOSED (probe succeeded)`);
}

function transitionToHalfOpen(s, provider) {
  s.circuitState  = CB_HALF_OPEN;
  s.halfOpenProbe = false;
  console.log(`[CB] ${provider} → HALF_OPEN (cooldown expired, probing)`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if a request should be sent to this provider.
 * Manages HALF_OPEN probe slot — only one probe in-flight at a time.
 */
export function isProviderHealthy(provider) {
  const s = state[provider];
  if (!s) return false;

  const now = Date.now();

  switch (s.circuitState) {
    case CB_CLOSED:
      return true;

    case CB_OPEN:
      if (now >= s.cooldownUntil) {
        transitionToHalfOpen(s, provider);
        s.halfOpenProbe = true;
        return true;   // allow the one probe
      }
      return false;    // still open

    case CB_HALF_OPEN:
      if (!s.halfOpenProbe) {
        // Probe slot free — allow one more attempt
        s.halfOpenProbe = true;
        return true;
      }
      return false;    // probe already in-flight

    default:
      return false;
  }
}

/**
 * Composite health score 0–100. Used by router for ranking.
 * Returns 0 if OPEN (forces skip).
 */
export function getHealthScore(provider) {
  const s = state[provider];
  return s ? computeScore(s) : 0;
}

/**
 * Raw state snapshot for router's latency-aware scoring.
 */
export function getProviderState(provider) {
  const s = state[provider];
  if (!s) return null;
  return {
    score:               computeScore(s),
    circuitState:        s.circuitState,
    successRate:         successRate(s),
    avgLatencyMs:        avgLatencyMs(s),
    consecutiveFailures: s.consecutiveFailures,
    onCooldown:          s.circuitState === CB_OPEN,
    totalRequests:       s.totalRequests,
  };
}

export function markSuccess(provider, latencyMs) {
  const s = state[provider];
  if (!s) return;

  push(s.outcomes, true);
  if (latencyMs != null) push(s.latencies, latencyMs);
  s.totalRequests++;
  s.totalSuccesses++;
  s.lastSuccess = Date.now();

  if (s.circuitState === CB_HALF_OPEN) {
    transitionToClosed(s, provider);
  } else {
    s.consecutiveFailures = 0;
  }

  console.log(`[HEALTH] ${provider} ✓ ${latencyMs ?? '?'}ms | score=${computeScore(s).toFixed(0)} | cb=${s.circuitState}`);
}

/**
 * @param {string} provider
 * @param {string} [reason]
 * @param {object} [opts]
 * @param {number} [opts.cooldownMs] provider-supplied Retry-After (429/503) — the
 *   circuit's OPEN cooldown is never shorter than this. Omitted → pure
 *   exponential backoff, identical to the pre-v4 behavior the tests pin.
 * @param {string} [opts.type] structured error type (providerErrors.js) for observability.
 */
export function markFailure(provider, reason = 'unknown', opts = {}) {
  const s = state[provider];
  if (!s) return;

  push(s.outcomes, false);
  s.consecutiveFailures++;
  s.totalRequests++;
  s.totalFailures++;
  s.lastFailure       = Date.now();
  s.lastFailureReason = reason;
  if (opts.type) s.lastFailureType = opts.type;

  const minMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : 0;

  switch (s.circuitState) {
    case CB_HALF_OPEN:
      // Probe failed → back to OPEN with longer backoff
      s.halfOpenProbe = false;
      transitionToOpen(s, provider, `probe_failed:${reason}`, minMs);
      break;

    case CB_CLOSED:
      if (s.consecutiveFailures >= FAIL_THRESH) {
        transitionToOpen(s, provider, reason, minMs);
      } else {
        console.log(`[HEALTH] ${provider} ✗ ${s.consecutiveFailures}/${FAIL_THRESH} | reason=${reason}`);
      }
      break;

    case CB_OPEN:
      // Already open — just increment
      break;
  }
}

/**
 * Test-only: resets all in-memory health/circuit-breaker state back to
 * fresh. No production code path calls this — it exists purely so test
 * suites can exercise circuit-breaker transitions from a known-clean state
 * instead of depending on test execution order across a shared singleton.
 */
export function __resetForTests() {
  state.gemini     = fresh();
  state.groq       = fresh();
  state.openrouter = fresh();
}

export function getUptime() {
  const uptimeMs = Date.now() - START_MS;
  const s = Math.floor(uptimeMs / 1000);
  return {
    startedAt:  new Date(START_MS).toISOString(),
    uptimeMs,
    uptimeHuman: `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`,
  };
}

export function getHealthReport() {
  const now = Date.now();
  const out = {};
  for (const [name, s] of Object.entries(state)) {
    out[name] = {
      circuitState:        s.circuitState,
      score:               computeScore(s).toFixed(1),
      successRate:         (successRate(s) * 100).toFixed(1) + '%',
      avgLatencyMs:        avgLatencyMs(s).toFixed(0) + 'ms',
      consecutiveFailures: s.consecutiveFailures,
      cooldownRemainingS:  s.cooldownUntil > now
        ? +((s.cooldownUntil - now) / 1000).toFixed(0)
        : null,
      totalRequests:       s.totalRequests,
      totalSuccesses:      s.totalSuccesses,
      totalFailures:       s.totalFailures,
    };
  }
  return out;
}
