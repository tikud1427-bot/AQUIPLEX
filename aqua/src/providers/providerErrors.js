/**
 * AQUA Provider Errors — Shared Error Classification
 *
 * Root problem (Issue 4/12): each provider file categorized failures with
 * its own ad-hoc if/else chain, and OpenRouter's single-model 404s were
 * propagated as if the whole provider had failed — incorrectly dragging
 * openrouter's provider-level health/circuit breaker down for a problem
 * scoped to one model. This module is the single source of truth for
 * "what kind of failure was this", shared by gemini.js / groq.js /
 * openrouter.js so a dead model is never confused with a dead provider.
 *
 * Categories (Issue 4's explicit list):
 *   model_not_found  — 404 / "model not found" / "no endpoints" / "deprecated"
 *   rate_limit       — 429
 *   auth             — 401 / 403
 *   server_error     — 5xx
 *   network          — no HTTP status at all (DNS/connect/abort/fetch failure)
 *   timeout          — our own AbortController fired (router's timeout budget)
 *   invalid_response — not a transport error; caller got a response with no
 *                      usable content (empty body) — same call site that used
 *                      to throw "X returned empty response"
 *   unknown          — anything else; still a genuine failure, just uncategorized
 *
 * Only `timeout`, `network`, `auth`, `server_error`, `rate_limit`,
 * `invalid_response`, and `unknown` are genuine failures per Issue 1's list.
 * `model_not_found` is ALSO a genuine failure — just one that must stay
 * scoped to the specific model, never the provider (see Issue 4 §"Only
 * disable the specific model").
 */

const NOT_FOUND_HINTS = [
  'not found', 'no endpoints', 'model not available', 'no allowed providers',
  'is not a valid model', 'does not exist',
];

const DEPRECATED_HINTS = ['deprecated', 'decommissioned', 'has been retired', 'no longer available'];

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
  'ECONNABORTED', 'EPIPE', 'EHOSTUNREACH',
]);

/** Extract an HTTP status code from whatever shape the SDK wrapped it in. */
export function extractStatus(err) {
  return (
    err?.status ??
    err?.statusCode ??
    err?.httpError?.status ??
    err?.response?.status ??
    null
  );
}

/**
 * @param {Error} err
 * @returns {{ type: 'model_not_found'|'rate_limit'|'auth'|'server_error'|
 *             'network'|'timeout'|'invalid_response'|'unknown', status: number|null }}
 */
export function classifyProviderError(err) {
  if (!err) return { type: 'unknown', status: null };
  if (err.message === 'TIMEOUT') return { type: 'timeout', status: null };
  if (err.message === 'INVALID_RESPONSE') return { type: 'invalid_response', status: null };

  const status = extractStatus(err);
  const msg    = String(err.message ?? '').toLowerCase();
  const code   = err.code ?? err.cause?.code;

  if (status === 404 || NOT_FOUND_HINTS.some(h => msg.includes(h)) || DEPRECATED_HINTS.some(h => msg.includes(h))) {
    return { type: 'model_not_found', status: status ?? 404 };
  }
  if (status === 429) return { type: 'rate_limit', status };
  if (status === 401 || status === 403) return { type: 'auth', status };
  if (status != null && status >= 500) return { type: 'server_error', status };
  if (code && NETWORK_ERROR_CODES.has(code)) return { type: 'network', status: null };
  if (status == null && (msg.includes('fetch failed') || msg.includes('network') || err.name === 'FetchError')) {
    return { type: 'network', status: null };
  }
  return { type: 'unknown', status };
}

/** Human-readable one-liner for logs — keeps log format consistent across providers. */
export function describeError(classification, context = '') {
  const { type, status } = classification;
  const statusPart = status ? ` status=${status}` : '';
  return `${type}${statusPart}${context ? ` (${context})` : ''}`;
}
