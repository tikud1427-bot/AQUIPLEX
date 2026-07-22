/**
 * AQUA Backoff — exponential backoff with full jitter.
 *
 * Extracted as its own pure, zero-dependency module so the router's retry
 * loop and the test/soak harnesses share ONE backoff implementation instead
 * of three ad-hoc `setTimeout(2 ** n)` copies. Deterministic given an
 * injected RNG + clock, so the router's resilience tests can assert the
 * exact sleep sequence without wall-clock flakiness.
 *
 * Full jitter (AWS "Exponential Backoff And Jitter", the variant that
 * minimizes contention): the nominal delay doubles each attempt up to a cap,
 * then the ACTUAL delay is a uniform random pick in [floorMs, nominal]. Under
 * a benchmark stampede (1000+ concurrent GSM8K items all rate-limited at the
 * same instant) fixed backoff would resynchronize every retry into the same
 * millisecond and re-trip the provider's rate limit forever; jitter spreads
 * the herd out so retries actually land in different rate-limit windows.
 *
 *   attempt 1 → nominal = base·2^0, sleep ∈ [floor, base·1]
 *   attempt 2 → nominal = base·2^1, sleep ∈ [floor, base·2]
 *   attempt 3 → nominal = base·2^2, sleep ∈ [floor, base·4]
 *   … capped at capMs.
 *
 * A provider-supplied Retry-After (429 / 503) is honoured by passing it as
 * `minMs` — the sleep is never SHORTER than what the provider told us to
 * wait, but jitter can still push it later to de-correlate the herd.
 */

/**
 * @param {number} attempt      1-based retry attempt number (1 = first retry).
 * @param {object} [opts]
 * @param {number} [opts.baseMs=500]   base unit; nominal delay = baseMs·2^(attempt-1).
 * @param {number} [opts.capMs=8000]   hard ceiling on the nominal delay.
 * @param {number} [opts.floorMs=0]    lower bound on the jittered result.
 * @param {number} [opts.minMs=0]      provider hint (Retry-After) — result is never below this.
 * @param {() => number} [opts.rng=Math.random]  injectable RNG (tests).
 * @returns {number} milliseconds to sleep (integer, ≥ 0).
 */
export function computeBackoff(attempt, opts = {}) {
  const baseMs  = opts.baseMs  ?? 500;
  const capMs   = opts.capMs   ?? 8_000;
  const floorMs = opts.floorMs ?? 0;
  const minMs   = opts.minMs   ?? 0;
  const rng     = opts.rng     ?? Math.random;

  const n       = Math.max(1, Math.floor(attempt));
  // 2^(n-1) can overflow for absurd n; clamp the exponent before shifting.
  const expPow  = Math.min(2 ** (n - 1), capMs / Math.max(1, baseMs) + 1);
  const nominal = Math.min(baseMs * expPow, capMs);

  // Full jitter across [0, nominal], then lift to the floors.
  const jittered = rng() * nominal;
  const result   = Math.max(floorMs, minMs, jittered);
  return Math.round(result);
}

/**
 * Abortable sleep. Resolves after `ms`, or early (still resolves — never
 * rejects) if `signal` fires, so a client disconnect during a backoff wait
 * cancels the pending delay instead of holding the request open.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
