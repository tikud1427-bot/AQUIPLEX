/**
 * AQUA Provider Errors — Shared Error Classification (v5)
 *
 * Single source of truth for "what kind of failure was this", consumed by
 * gemini.js / groq.js / openrouter.js (per-model routing) AND by router.js
 * (per-provider routing, health accounting, backoff, and the retryable-vs-
 * terminal decision that keeps a transient blip from becoming an HTTP 500).
 *
 * ── Why v5 exists (the GSM8K production bug) ─────────────────────────────────
 * v4 folded OpenRouter's TRANSIENT free-tier capacity errors — "No endpoints
 * found", "No allowed providers are available" — into `model_not_found`, and
 * `model_not_found` routes to markModelUnavailable(), which is PERMANENT
 * ("deprecated", never retried again this process). Over a 1319-question
 * benchmark run every OpenRouter model eventually threw one of those
 * transient messages under load and was permanently culled one by one, until
 * getCandidateModels('openrouter') returned [] forever and every OpenRouter
 * call threw "All OpenRouter models permanently unavailable". That is the
 * exact reported symptom.
 *
 * The fix is at THIS boundary: a model being temporarily out of serving
 * capacity is NOT the same event as a model being deprecated. v5 splits them:
 *
 *   model_not_found    permanent — the model id is wrong / removed / retired.
 *                      Explicit deprecation language, or a bare 404 with no
 *                      capacity hint. → markModelUnavailable (permanent).
 *   model_unavailable  TRANSIENT — the model exists but has no free endpoint
 *                      right now ("no endpoints", "no allowed providers",
 *                      "overloaded", "at capacity"). → markModelTempFailed
 *                      (self-heals after a cooldown).
 *
 * ── Every category also carries routing metadata ─────────────────────────────
 *   retryable  — is it worth trying again (same or another provider)?
 *   scope      — 'model' (this model id) | 'provider' (key/connection/config)
 *   permanent  — will retrying THIS process ever help? (auth, config, dead model)
 *
 * These three drive router.js §retry-rounds and health.js accounting, and are
 * surfaced to the HTTP layer so chat.js can answer AQEval with a retryable
 * 503 + Retry-After instead of a terminal 500 whenever retryable capacity
 * still exists.
 *
 * Categories (superset of v4 — every v4 type still returned, same spelling):
 *   model_not_found   404 / "not found" / "does not exist" / deprecation.  PERMANENT.
 *   model_unavailable NEW — transient no-capacity ("no endpoints", …).      retryable.
 *   rate_limit        429 / "too many requests" / "quota".                  retryable.
 *   auth              401 / 403 / bad key.                                   permanent.
 *   config            missing/invalid key, nothing configured.              permanent.
 *   server_error      5xx.                                                  retryable.
 *   network           no HTTP status (DNS/connect/reset/fetch failure).     retryable.
 *   timeout           our own AbortController fired (router budget).        retryable.
 *   invalid_response  transport ok, but empty / unusable body.              retryable.
 *   unknown           uncategorized — treated as retryable (generous), but  retryable.
 *                     still counts toward the circuit breaker so it can't loop forever.
 */

// ── Message hint tables ───────────────────────────────────────────────────────

// TRANSIENT capacity — the model exists, just has no free endpoint right now.
// Checked BEFORE the not-found table so "no endpoints found" (which also
// contains the word "found") is correctly read as transient, not permanent.
const TRANSIENT_UNAVAILABLE_HINTS = [
  'no endpoints', 'no allowed providers', 'no available providers',
  'no instances available', 'temporarily unavailable', 'currently unavailable',
  'overloaded', 'at capacity', 'over capacity', 'try again later',
  'no providers available', 'temporarily rate-limited by upstream',
];

// PERMANENT model-scoped — the id is wrong / removed / retired.
const NOT_FOUND_HINTS = [
  'not found', 'model not available', 'is not a valid model', 'not a valid model',
  'does not exist', 'unknown model', 'invalid model',
];
const DEPRECATED_HINTS = [
  'deprecated', 'decommissioned', 'has been retired', 'no longer available', 'is retired',
];

// Rate limit / quota by message (only consulted when there is no explicit status).
const RATE_LIMIT_HINTS = ['rate limit', 'rate-limit', 'too many requests', 'quota', 'resource_exhausted'];

// Missing / invalid credentials or configuration — permanent, provider-scoped.
const CONFIG_HINTS = [
  'no api key', 'api key not', 'keys configured', 'not configured', 'missing api key',
  'invalid api key', 'incorrect api key', 'no ' /* combined with 'keys configured' below */,
];

const AUTH_HINTS = ['unauthorized', 'invalid authentication', 'permission denied', 'forbidden'];

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
  'ECONNABORTED', 'EPIPE', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

// ── Category metadata: retryable / scope / permanent ──────────────────────────

const META = {
  model_not_found:   { retryable: false, scope: 'model',    permanent: true  },
  model_unavailable: { retryable: true,  scope: 'model',    permanent: false },
  rate_limit:        { retryable: true,  scope: 'model',    permanent: false },
  auth:              { retryable: false, scope: 'provider', permanent: true  },
  config:            { retryable: false, scope: 'provider', permanent: true  },
  server_error:      { retryable: true,  scope: 'model',    permanent: false },
  network:           { retryable: true,  scope: 'provider', permanent: false },
  timeout:           { retryable: true,  scope: 'provider', permanent: false },
  invalid_response:  { retryable: true,  scope: 'model',    permanent: false },
  unknown:           { retryable: true,  scope: 'provider', permanent: false },
};

export const RETRYABLE_TYPES = new Set(
  Object.entries(META).filter(([, m]) => m.retryable).map(([t]) => t),
);

export function isRetryable(type)  { return META[type]?.retryable ?? false; }
export function errorScope(type)   { return META[type]?.scope ?? 'provider'; }
export function isPermanent(type)  { return META[type]?.permanent ?? false; }

// ── Status / hint helpers ─────────────────────────────────────────────────────

/** Extract an HTTP status code from whatever shape the SDK wrapped it in. */
export function extractStatus(err) {
  return (
    err?.status ??
    err?.statusCode ??
    err?.httpError?.status ??
    err?.response?.status ??
    err?.cause?.status ??
    null
  );
}

function hasHint(msg, table) {
  return table.some(h => msg.includes(h));
}

/**
 * Parse a Retry-After hint (seconds or HTTP-date) from headers or message,
 * plus provider-specific fields. Returns milliseconds to wait, or null.
 *
 * @param {Error} err
 * @param {() => number} [now] injectable clock (tests)
 * @returns {number|null}
 */
export function retryAfterMs(err, now = Date.now) {
  if (err == null) return null;

  // Already-normalized numeric hint.
  if (Number.isFinite(err.retryAfterMs)) return Math.max(0, err.retryAfterMs);
  if (Number.isFinite(err.retryAfterSeconds)) return Math.max(0, err.retryAfterSeconds * 1000);

  // Header, across the shapes different SDKs expose.
  const headerVal = readHeader(err, 'retry-after') ?? readHeader(err, 'x-ratelimit-reset-after');
  const fromHeader = parseRetryAfterValue(headerVal, now);
  if (fromHeader != null) return fromHeader;

  // "... retry after 12 seconds" / "try again in 3s" in the message body.
  const msg = String(err.message ?? '');
  const m = msg.match(/(?:retry after|try again in|wait)\s+(\d+(?:\.\d+)?)\s*(m?s|sec|second|seconds|minute|minutes)?/i);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = (m[2] ?? 's').toLowerCase();
    if (unit === 'ms') return Math.round(n);
    if (unit.startsWith('m') && unit !== 'ms') return Math.round(n * 60_000);
    return Math.round(n * 1000);
  }
  return null;
}

function readHeader(err, name) {
  const h = err?.response?.headers ?? err?.headers ?? err?.responseHeaders;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);           // Headers / fetch
  return h[name] ?? h[name.toLowerCase()] ?? null;               // plain object
}

function parseRetryAfterValue(val, now) {
  if (val == null) return null;
  const s = String(val).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);  // delta-seconds
  const date = Date.parse(s);                                            // HTTP-date
  if (!Number.isNaN(date)) return Math.max(0, date - now());
  return null;
}

// ── Core classifier ───────────────────────────────────────────────────────────

/**
 * @param {Error} err
 * @returns {{ type: string, status: number|null, retryable: boolean,
 *             scope: 'model'|'provider', permanent: boolean, retryAfterMs: number|null }}
 *   `type` is one of the categories documented above. The first four fields
 *   are a strict superset of v4's `{ type, status }`, so existing callers
 *   keep working unchanged.
 */
export function classifyProviderError(err) {
  const base = (type, status) => ({
    type, status: status ?? null,
    retryable: isRetryable(type), scope: errorScope(type), permanent: isPermanent(type),
    retryAfterMs: retryAfterMs(err),
  });

  if (!err) return base('unknown', null);
  if (err.message === 'TIMEOUT')          return base('timeout', null);
  if (err.message === 'INVALID_RESPONSE') return base('invalid_response', null);

  const status = extractStatus(err);
  const msg    = String(err.message ?? '').toLowerCase();
  const code   = err.code ?? err.cause?.code;
  const noCandidateCode = err.code === 'NO_CANDIDATE_MODELS';

  // 1. Deprecation language is ALWAYS permanent — even if a status says otherwise.
  //    A deprecated model does not come back by retrying.
  if (hasHint(msg, DEPRECATED_HINTS)) return base('model_not_found', status);

  // 2. Adapter's "no models currently available" sentinel — models are cooling
  //    down or deprecated; retrying (after a cooldown) may well succeed.
  if (noCandidateCode) return base('model_unavailable', status);

  // 3. Explicit status codes win over message-sniffing (except deprecation above).
  if (status === 429) return base('rate_limit', status);
  if (status === 401 || status === 403) return base('auth', status);
  if (status === 404) {
    // 404 is ambiguous on OpenRouter free tier: it's returned both for a
    // genuinely-wrong model id AND for "no endpoints" transient capacity.
    return hasHint(msg, TRANSIENT_UNAVAILABLE_HINTS)
      ? base('model_unavailable', status)
      : base('model_not_found', status);
  }
  if (status != null && status >= 500) return base('server_error', status);

  // 4. Transport-level (no HTTP status at all).
  if (code && NETWORK_ERROR_CODES.has(code)) return base('network', null);
  if (status == null && (msg.includes('fetch failed') || msg.includes('network') || err.name === 'FetchError')) {
    return base('network', null);
  }

  // 5. Message-only disambiguation (no usable status).
  //    Transient capacity checked BEFORE not-found so "no endpoints found"
  //    (contains "found") is read as transient, not permanent.
  if (hasHint(msg, TRANSIENT_UNAVAILABLE_HINTS)) return base('model_unavailable', status);
  if (hasHint(msg, NOT_FOUND_HINTS))             return base('model_not_found', status);
  if (msg.includes('keys configured') || msg.includes('not configured')
      || msg.includes('missing api key') || msg.includes('no api key')) {
    return base('config', status);
  }
  if (hasHint(msg, RATE_LIMIT_HINTS)) return base('rate_limit', status);
  if (hasHint(msg, AUTH_HINTS))       return base('auth', status);

  return base('unknown', status);
}

// ── Structured provider error object (Task 8) ─────────────────────────────────

/**
 * A first-class, serializable provider failure. Thrown by router.js on
 * terminal exhaustion and attached to each attempt record, so every layer
 * above the router (chat.js, observability, AQEval's fallbackChain) reads
 * the SAME structured shape instead of re-sniffing an error string.
 */
export class ProviderError extends Error {
  constructor({ provider, type, status = null, message, retryAfterMs = null, attempt = null, cause = null }) {
    super(message ?? `${provider ?? 'provider'} ${type}`);
    this.name         = 'ProviderError';
    this.code         = String(type ?? 'unknown').toUpperCase();
    this.provider     = provider ?? null;
    this.type         = type ?? 'unknown';
    this.status       = status;
    this.retryable    = isRetryable(this.type);
    this.scope        = errorScope(this.type);
    this.permanent    = isPermanent(this.type);
    this.retryAfterMs = retryAfterMs;
    this.attempt      = attempt;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      error: 'provider_error',
      provider: this.provider, type: this.type, code: this.code, status: this.status,
      retryable: this.retryable, scope: this.scope, permanent: this.permanent,
      retryAfterMs: this.retryAfterMs, attempt: this.attempt, message: this.message,
    };
  }
}

/**
 * Build a ProviderError from a raw provider throw + its classification.
 * @param {object} args
 * @param {string} args.provider
 * @param {Error}  [args.cause]        the original error (kept as .cause)
 * @param {object} [args.classification] result of classifyProviderError (recomputed if absent)
 * @param {number} [args.attempt]
 * @returns {ProviderError}
 */
export function createProviderError({ provider, cause, classification, attempt = null, message } = {}) {
  const cls = classification ?? classifyProviderError(cause);
  return new ProviderError({
    provider,
    type: cls.type,
    status: cls.status,
    message: message ?? cause?.message,
    retryAfterMs: cls.retryAfterMs,
    attempt,
    cause,
  });
}

/** Human-readable one-liner for logs — keeps log format consistent across providers. */
export function describeError(classification, context = '') {
  const { type, status } = classification;
  const statusPart = status ? ` status=${status}` : '';
  return `${type}${statusPart}${context ? ` (${context})` : ''}`;
}
