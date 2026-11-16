/**
 * Evaluation error taxonomy (2026-11-11). Every provider response that is not a
 * success is placed in exactly ONE category, and each category has ONE scope —
 * which is what decides whether rotating to another credential can help.
 *
 *   category                 scope     action
 *   invalid_credential       key       mark key invalid; try another key in the SAME domain
 *   expired_credential       key       mark key expired (short-lived token); try another key
 *   key_restricted           key       mark key restricted; try another key
 *   rate_limited_temporary   domain    cool the DOMAIN until Retry-After (no rotation inside it)
 *   quota_exhausted          domain    PAUSE the domain until its reset; another INDEPENDENT domain may serve
 *   billing_required         global    STOP the run; never retried through any other route
 *   request_too_large        request   do not retry (the request itself must change)
 *   network                  request   bounded retry
 *   server_error             request   bounded retry
 *   unknown                  global    fail safe; human review
 *
 * Rate limits for Gemini are per Google Cloud PROJECT and for Groq per
 * ORGANISATION (provider documentation), so a 429 is a DOMAIN event: another key
 * of the same project/org shares the limit. Only key-scoped failures rotate keys.
 *
 * Wording heuristics follow the providers' documented/observed error bodies
 * (Gemini RESOURCE_EXHAUSTED with per-day / free-tier quota metrics; Groq
 * "Rate limit reached … on requests per day (RPD)" / "tokens per day (TPD)").
 * Anything not recognised is `unknown`, never guessed into a retryable class.
 */
export const CATEGORIES = Object.freeze({
  invalid_credential: 'key', expired_credential: 'key', key_restricted: 'key',
  rate_limited_temporary: 'domain', quota_exhausted: 'domain',
  billing_required: 'global', request_too_large: 'request',
  network: 'request', server_error: 'request', unknown: 'global',
});

const BILLING = /billing|payment required|insufficient (credits|balance|funds)|out of credits|paid (tier|plan)|upgrade (your|to)|requires? a paid|enable billing|credit balance|spend (limit|cap)/i;
const EXPIRED = /expired|ACCESS_TOKEN_EXPIRED|token has expired|invalid_grant/i;
const RESTRICTED = /API_KEY_SERVICE_BLOCKED|API_KEY_HTTP_REFERRER_BLOCKED|API_KEY_IP_ADDRESS_BLOCKED|API_KEY_ANDROID_APP_BLOCKED|API_KEY_IOS_APP_BLOCKED|referer|referrer|not authorized to use|restricted|blocked for this (key|API key)|SERVICE_DISABLED|has not been used in project|is disabled/i;
const INVALID = /API_KEY_INVALID|invalid api key|api key not valid|invalid_api_key|invalid authentication|unauthenticated|incorrect api key/i;
// Daily / project / free-tier exhaustion vs per-minute throttling.
const DAILY = /per ?day|\bRPD\b|\bTPD\b|daily|PerDay|free_tier_requests|FreeTier|quota exceeded for (?:quota )?metric|exceeded your current quota/i;
const PER_MINUTE = /per ?minute|\bRPM\b|\bTPM\b|PerMinute|try again in \d+(\.\d+)?s/i;

export function retryAfterMs(res, now = Date.now()) {
  const h = res?.headers ?? {};
  const get = k => (typeof h.get === 'function' ? h.get(k) : h[k] ?? h[k.toLowerCase()]);
  const ra = get('retry-after') ?? get('Retry-After');
  if (ra != null && ra !== '') {
    const s = Number(ra);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.max(0, d - now);
  }
  const body = typeof res?.bodyText === 'string' ? res.bodyText : JSON.stringify(res?.json ?? '');
  const m = body.match(/(?:retry in|try again in|retryDelay"?\s*:\s*"?)(\d+(?:\.\d+)?)\s*(ms|s)?/i);
  if (m) return Math.round(Number(m[1]) * (m[2] === 'ms' ? 1 : 1000));
  return null;
}

/**
 * Classify one failed attempt. `res` = { status, headers, json, bodyText } or
 * { networkError: Error }. Returns { category, scope, retryAfterMs }.
 */
export function classify(res, now = Date.now()) {
  const out = (category, ra = null) => ({ category, scope: CATEGORIES[category], retryAfterMs: ra });
  if (res?.networkError) {
    const msg = String(res.networkError?.message ?? res.networkError);
    return out(/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(msg) ? 'network' : 'unknown');
  }
  const status = res?.status;
  const body = typeof res?.bodyText === 'string' ? res.bodyText : JSON.stringify(res?.json ?? '');
  const ra = retryAfterMs(res, now);
  if (status === 429) {
    // A 429 is a rate/quota event even when its body advertises a paid upgrade ("Upgrade to
    // Dev Tier … /settings/billing" is part of Groq's ordinary 429 text). Exception: a quota of
    // ZERO means this model has no free allocation on this domain → paid-only → billing stop.
    if (/"?limit"?\s*[:=]\s*0\b|limit:\s*0\b|quota_value"?\s*:\s*"?0\b/i.test(body)) return out('billing_required');
    if (DAILY.test(body)) return out('quota_exhausted', ra);
    if (PER_MINUTE.test(body) || ra != null) return out('rate_limited_temporary', ra);
    return out('quota_exhausted', ra);                      // unexplained 429: the conservative reading pauses the domain
  }
  if (status === 402 || BILLING.test(body)) return out('billing_required');
  if (status === 413) return out('request_too_large');      // Groq answers oversize prompts with 413 + "rate_limit_exceeded": NOT a quota event
  if (status === 401 || status === 403 || status === 400) {
    if (EXPIRED.test(body)) return out('expired_credential');
    if (RESTRICTED.test(body)) return out('key_restricted');
    if (INVALID.test(body) || status === 401) return out('invalid_credential');
    if (status === 403) return out('key_restricted');
    return out('unknown');                                  // a 400 we cannot attribute: review, do not retry
  }
  if (status >= 500 && status <= 599) return out('server_error', ra);
  return out('unknown');
}
