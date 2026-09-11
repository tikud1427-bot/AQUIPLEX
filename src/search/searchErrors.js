/**
 * AQUA Web Search — Error Classification
 *
 * Single source of truth for "what kind of search failure was this",
 * mirroring src/providers/providerErrors.js exactly — the LLM providers
 * learned the hard way (Issue 4) that ad-hoc per-provider if/else chains
 * conflate key problems with provider problems. Same lesson applied here
 * from day one:
 *
 *   auth        — 401 / 403: THIS KEY is bad (revoked / wrong). Long key
 *                 cooldown; the provider itself is fine — try the next key.
 *   rate_limit  — 429: THIS KEY is exhausted for now. Escalating key
 *                 cooldown; provider fine — try the next key.
 *   quota       — 402 / "insufficient credits": key/account out of credits.
 *                 Long key cooldown (paying won't happen mid-request).
 *   bad_request — 400: OUR query was malformed. No key or provider blame;
 *                 not retryable with another key (same query → same 400).
 *   server_error— 5xx: the PROVIDER is struggling. Short key cooldown +
 *                 provider-level strike (circuit breaker input).
 *   timeout     — our own AbortController fired. Provider strike.
 *   network     — DNS/connect/reset, no HTTP status. Provider strike.
 *   invalid_response — 2xx but unusable body. Provider strike.
 *   unknown     — anything else. Treated like server_error.
 *
 * classify() returns everything the caller needs to act:
 *   { kind, keyCooldownMs, providerStrike, retryNextKey }
 */

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
  'ECONNABORTED', 'EPIPE', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const COOLDOWN = {
  AUTH_MS:        15 * 60 * 1_000, // bad key — don't hammer it
  QUOTA_MS:       15 * 60 * 1_000,
  RATE_BASE_MS:   60 * 1_000,      // doubled per consecutive strike by KeyPool
  TRANSIENT_MS:   20 * 1_000,      // server/timeout/network — brief pause
};

/** Extract an HTTP status from whatever shape fetch / our code produced. */
export function extractSearchStatus(err) {
  return err?.status ?? err?.statusCode ?? err?.response?.status ?? null;
}

/**
 * @param {Error & { status?: number, code?: string, cause?: any }} err
 * @returns {{ kind: string, keyCooldownMs: number, providerStrike: boolean, retryNextKey: boolean }}
 */
export function classifySearchError(err) {
  const status = extractSearchStatus(err);
  const msg    = String(err?.message ?? '').toLowerCase();
  const code   = err?.code ?? err?.cause?.code;

  if (err?.name === 'AbortError' || msg === 'timeout' || msg.includes('aborted')) {
    return { kind: 'timeout', keyCooldownMs: COOLDOWN.TRANSIENT_MS, providerStrike: true, retryNextKey: true };
  }

  if (status === 401 || status === 403) {
    return { kind: 'auth', keyCooldownMs: COOLDOWN.AUTH_MS, providerStrike: false, retryNextKey: true };
  }
  if (status === 402 || msg.includes('insufficient credits') || msg.includes('out of credits') || msg.includes('quota')) {
    return { kind: 'quota', keyCooldownMs: COOLDOWN.QUOTA_MS, providerStrike: false, retryNextKey: true };
  }
  if (status === 429) {
    return { kind: 'rate_limit', keyCooldownMs: COOLDOWN.RATE_BASE_MS, providerStrike: false, retryNextKey: true };
  }
  if (status === 400) {
    // Same query on another key produces the same 400 — do NOT burn keys.
    return { kind: 'bad_request', keyCooldownMs: 0, providerStrike: false, retryNextKey: false };
  }
  if (status !== null && status >= 500) {
    return { kind: 'server_error', keyCooldownMs: COOLDOWN.TRANSIENT_MS, providerStrike: true, retryNextKey: true };
  }
  if (code && NETWORK_ERROR_CODES.has(code)) {
    return { kind: 'network', keyCooldownMs: COOLDOWN.TRANSIENT_MS, providerStrike: true, retryNextKey: true };
  }
  if (msg.includes('fetch failed') || msg.includes('network')) {
    return { kind: 'network', keyCooldownMs: COOLDOWN.TRANSIENT_MS, providerStrike: true, retryNextKey: true };
  }
  if (msg.includes('invalid_response') || msg.includes('empty response')) {
    return { kind: 'invalid_response', keyCooldownMs: COOLDOWN.TRANSIENT_MS, providerStrike: true, retryNextKey: true };
  }

  return { kind: 'unknown', keyCooldownMs: COOLDOWN.TRANSIENT_MS, providerStrike: true, retryNextKey: true };
}
