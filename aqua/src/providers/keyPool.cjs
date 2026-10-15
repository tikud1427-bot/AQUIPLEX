'use strict';
/**
 * AQUA Provider Key Pool — ONE credential system for both AI call paths.
 *
 * Shared, dependency-free CommonJS so BOTH halves of the product load the same
 * module instance:
 *   · the ESM engine   (aqua/src/providers/*.js, embeddings)  `import lib from './keyPool.cjs'`
 *   · the CJS platform (services/ai.client.js)                `require('../aqua/src/providers/keyPool.cjs')`
 * Node caches a CommonJS module once per process whichever loader asks first,
 * so a key rejected by the platform's Gemini call is skipped by the engine's
 * Gemini call too. There is exactly one cooldown system per process.
 *
 * ── Discovery (re-read from process.env on every call; cheap) ────────────────
 *   gemini      GEMINI_KEY_<n>          + GEMINI_API_KEY (#bare) + Gemini_API_Key (#legacy)
 *   groq        GROQ_API_KEY_<n>        + GROQ_API_KEY (#bare)
 *   openrouter  OPENROUTER_API_KEY_<n>  + OPENROUTER_API_KEY (#bare)
 *   nvidia      NVIDIA_API_KEY_<n>      + NVIDIA_API_KEY (#bare)
 * Any <n>: slots are discovered, sorted numerically (10 follows 9), blanks and
 * whitespace-only values ignored, identical values used once (the first slot
 * wins; later ones are reported as duplicates). A slot label ("#3", "#bare")
 * is the ONLY identifier that ever leaves this module.
 *
 * ── Credential state (process-local; see STATE STORE below) ──────────────────
 * State is keyed by the credential itself, held in memory only, so:
 *   · a credential's state follows it if it moves to another slot;
 *   · REPLACING a slot's value (operator rotated the key, restarted) starts the
 *     new credential fresh — the "controlled configuration refresh";
 *   · `resetCredentials({ slot })` is the explicit administrative reset.
 *   cooling   429 → key-wide or (key, model) cooldown, Retry-After honoured.
 *             Expires on its own.
 *   rejected  401/403/invalid/expired → STICKY. Never revived by time unless
 *             AQUA_PROVIDER_KEY_REJECT_TTL_MS is set by the operator. Billing
 *             (402) is a rejection with a TTL (credits can be topped up).
 *   verified  a successful call within VERIFIED_WINDOW_MS. A populated env var
 *             is never "valid" — health is `unknown` until a call proves it.
 *
 * ── Formats are informational only ───────────────────────────────────────────
 * A slot whose value does not look like the provider's documented key format
 * is REPORTED (diagnostics, startup line) and never excluded or deprioritised.
 * This repository has been burnt by declaring live keys invalid from their
 * prefix (scripts/env-doctor.mjs). Shape is not validity; only a call is.
 *
 * ── Never logged, serialised or hashed-out ───────────────────────────────────
 * Key values, suffixes, hashes, Authorization headers. Everything this module
 * prints or returns from a public function carries slot labels only.
 *
 * ── STATE STORE ──────────────────────────────────────────────────────────────
 * Cooldowns live in this process. Two app instances behind a load balancer
 * each learn a key's 429 independently (each pays one throttled request).
 * The store is isolated behind {get,set,delete,clear,entries} so a shared
 * backend can be dropped in; it is synchronous on purpose (acquire() is on the
 * hot path), so a Redis-backed store would mirror into a local cache and
 * publish changes asynchronously rather than block a request on the network.
 */

const DEFAULT_VERIFIED_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BILLING_TTL_MS = 24 * 60 * 60 * 1000;

const SPECS = Object.freeze({
  gemini: {
    name: 'Gemini',
    numbered: /^GEMINI_KEY_(\d+)$/,
    bare: [['GEMINI_API_KEY', 'bare'], ['Gemini_API_Key', 'legacy']],
    // Google AI Studio API keys. Other shapes are REPORTED, never excluded.
    format: /^AIza[0-9A-Za-z_-]{35}$/,
    formatName: 'Google API key (AIza…)',
  },
  groq: {
    name: 'Groq',
    numbered: /^GROQ_API_KEY_(\d+)$/,
    bare: [['GROQ_API_KEY', 'bare']],
    format: /^gsk_[0-9A-Za-z]{20,}$/,
    formatName: 'Groq API key (gsk_…)',
  },
  openrouter: {
    name: 'OpenRouter',
    numbered: /^OPENROUTER_API_KEY_(\d+)$/,
    bare: [['OPENROUTER_API_KEY', 'bare']],
    format: /^sk-or-[0-9A-Za-z_-]{10,}$/,
    formatName: 'OpenRouter API key (sk-or-…)',
  },
  nvidia: {
    name: 'NVIDIA',
    numbered: /^NVIDIA_API_KEY_(\d+)$/,
    bare: [['NVIDIA_API_KEY', 'bare']],
    format: /^nvapi-[0-9A-Za-z_-]{10,}$/,
    formatName: 'NVIDIA API key (nvapi-…)',
  },
});

const PROVIDERS = Object.freeze(Object.keys(SPECS));

function specOf(provider) {
  const s = SPECS[provider];
  if (!s) throw new Error(`keyPool: unknown provider "${provider}"`);
  return s;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * @returns {{
 *   slots: Array<{ slot: string, envName: string, key: string }>,
 *   duplicates: Array<{ slot: string, envName: string, duplicateOf: string }>,
 *   blanks: Array<{ slot: string, envName: string }>,
 * }}
 *   `slots[].key` is the secret. It never leaves the provider adapters; every
 *   public reporting function below strips it.
 */
function discoverKeySlots(provider, env = process.env) {
  const spec = specOf(provider);
  const numbered = [];
  for (const name of Object.keys(env)) {
    const m = spec.numbered.exec(name);
    if (m) numbered.push({ n: Number(m[1]), digits: m[1], envName: name });
  }
  numbered.sort((a, b) => (a.n - b.n) || a.digits.localeCompare(b.digits));

  const ordered = [
    ...numbered.map(x => ({ slot: `#${x.digits}`, envName: x.envName })),
    ...spec.bare.map(([envName, label]) => ({ slot: `#${label}`, envName })),
  ];

  const slots = [], duplicates = [], blanks = [];
  const firstSlotOf = new Map();
  const seenNames = new Set();
  for (const { slot, envName } of ordered) {
    if (!(envName in env)) continue;
    // Windows env names are case-insensitive: GEMINI_API_KEY and Gemini_API_Key
    // are one variable there. Same value → reported as a duplicate below.
    seenNames.add(envName);
    const key = String(env[envName] ?? '').trim();
    if (!key) { blanks.push({ slot, envName }); continue; }
    const first = firstSlotOf.get(key);
    if (first) { duplicates.push({ slot, envName, duplicateOf: first }); continue; }
    firstSlotOf.set(key, slot);
    slots.push({ slot, envName, key });
  }
  return { slots, duplicates, blanks };
}

/** 'recognized' | 'unrecognized' — informational only, never used to exclude. */
function credentialFormat(provider, key) {
  return specOf(provider).format.test(String(key ?? '').trim()) ? 'recognized' : 'unrecognized';
}

// ── State store ───────────────────────────────────────────────────────────────

class MemoryStateStore {
  constructor() { this.map = new Map(); }
  get(id) { return this.map.get(id); }
  set(id, v) { this.map.set(id, v); }
  delete(id) { this.map.delete(id); }
  clear() { this.map.clear(); }
  entries() { return this.map.entries(); }
}

function freshState() {
  return {
    cooldownUntil: 0, cooldownReason: null,
    modelCooldowns: new Map(),        // modelId → { until, reason }
    rejected: null,                   // { reason, at, until|null }
    attempts: 0, successes: 0, failures: 0,
    lastSuccessAt: 0, lastFailureAt: 0, lastErrorType: null,
    verifiedAt: 0, verifiedBy: null,  // 'call' | 'probe'
  };
}

// ── Pool ──────────────────────────────────────────────────────────────────────

class KeyPool {
  /**
   * @param {string} provider  one of PROVIDERS
   * @param {object} [opts]
   * @param {() => object} [opts.env]  env source (tests)
   * @param {() => number} [opts.now]  clock (tests)
   * @param {object} [opts.store]      state store (see STATE STORE)
   */
  constructor(provider, { env = () => process.env, now = Date.now, store = new MemoryStateStore() } = {}) {
    specOf(provider);
    this.provider = provider;
    this.env = env;
    this.now = now;
    this.store = store;
    this.cursor = 0;
  }

  get displayName() { return SPECS[this.provider].name; }

  /** Current distinct credentials, in selection order. INTERNAL (carries keys). */
  entries() { return discoverKeySlots(this.provider, this.env()).slots; }

  size() { return this.entries().length; }
  hasKeys() { return this.size() > 0; }

  _state(key) {
    let s = this.store.get(key);
    if (!s) { s = freshState(); this.store.set(key, s); }
    return s;
  }

  /** Operator opt-in: let an auth-rejected key retry after this long. Unset/0 = sticky. */
  _rejectTtlMs() {
    const env = this.env();
    const v = Number.parseInt(String(env.AQUA_PROVIDER_KEY_REJECT_TTL_MS ?? ''), 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** 'available' | 'cooling' | 'rejected' for this credential (optionally for one model). */
  _status(key, model, now = this.now()) {
    const s = this._state(key);
    if (s.rejected) {
      const until = s.rejected.until ?? (this._rejectTtlMs() > 0 ? s.rejected.at + this._rejectTtlMs() : null);
      if (until == null || now < until) return 'rejected';
      s.rejected = null; // an operator-configured TTL (or a billing TTL) elapsed
    }
    if (s.cooldownUntil > now) return 'cooling';
    if (model) {
      const mc = s.modelCooldowns.get(model);
      if (mc && mc.until > now) return 'cooling';
    }
    return 'available';
  }

  /**
   * Next usable credential, round-robin, skipping cooling/rejected ones and any
   * slot in `tried`. Returns null when none is usable. INTERNAL (carries key).
   * @param {{ model?: string|null, tried?: Set<string> }} [opts]
   */
  acquire({ model = null, tried } = {}) {
    const list = this.entries();
    if (!list.length) return null;
    const now = this.now();
    for (let step = 0; step < list.length; step++) {
      const i = (this.cursor + step) % list.length;
      const e = list[i];
      if (tried?.has(e.slot)) continue;
      if (this._status(e.key, model, now) !== 'available') continue;
      this.cursor = (i + 1) % list.length;
      this._state(e.key).attempts++;
      return e;
    }
    return null;
  }

  reportSuccess(entry, { model = null } = {}) {
    const s = this._state(entry.key);
    const now = this.now();
    s.successes++;
    s.lastSuccessAt = now;
    s.verifiedAt = now; s.verifiedBy = 'call';
    if (model) s.modelCooldowns.delete(model);
  }

  /** A failure that changes nothing about the credential (model / server / network). */
  reportNeutralFailure(entry, errorType) {
    const s = this._state(entry.key);
    s.failures++; s.lastFailureAt = this.now(); s.lastErrorType = errorType ?? 'unknown';
  }

  /** Throttle: key-wide when `model` is null, else only for (credential, model). */
  coolDown(entry, ms, { model = null, reason = 'rate_limit' } = {}) {
    const s = this._state(entry.key);
    const now = this.now();
    const until = now + Math.max(0, ms);
    s.failures++; s.lastFailureAt = now; s.lastErrorType = reason;
    if (model) {
      const prev = s.modelCooldowns.get(model);
      s.modelCooldowns.set(model, { until: Math.max(prev?.until ?? 0, until), reason });
    } else {
      s.cooldownUntil = Math.max(s.cooldownUntil, until);
      s.cooldownReason = reason;
    }
  }

  /** Quarantine. `ttlMs` null → sticky (auth); a number → expires (billing). */
  reject(entry, reason = 'auth', { ttlMs = null } = {}) {
    const s = this._state(entry.key);
    const now = this.now();
    s.failures++; s.lastFailureAt = now; s.lastErrorType = reason;
    s.rejected = { reason, at: now, until: ttlMs == null ? null : now + ttlMs };
    s.verifiedAt = 0; s.verifiedBy = null;
  }

  /** Record an opt-in live probe result (scripts/provider-keys-doctor.mjs). */
  recordProbe(entry, ok, reason = 'auth') {
    if (ok) { const s = this._state(entry.key); s.verifiedAt = this.now(); s.verifiedBy = 'probe'; }
    else this.reject(entry, reason);
  }

  /**
   * Milliseconds until some credential can serve `model`: 0 now, null when no
   * credential is configured OR every one is rejected (waiting will not help).
   */
  msUntilAvailable(model = null) {
    const list = this.entries();
    if (!list.length) return null;
    const now = this.now();
    let soonest = null;
    for (const e of list) {
      const st = this._status(e.key, model, now);
      if (st === 'available') return 0;
      if (st === 'rejected') continue;
      const s = this._state(e.key);
      const mc = model ? (s.modelCooldowns.get(model)?.until ?? 0) : 0;
      const wait = Math.max(s.cooldownUntil, mc) - now;
      soonest = soonest == null ? wait : Math.min(soonest, wait);
    }
    return soonest == null ? null : Math.max(0, soonest);
  }

  /** Counts for one model (or key-wide): { configured, available, cooling, rejected, billing }. */
  availability(model = null) {
    const now = this.now();
    const out = { configured: 0, available: 0, cooling: 0, rejected: 0, billing: 0 };
    for (const e of this.entries()) {
      out.configured++;
      const st = this._status(e.key, model, now);
      out[st]++;
      if (st === 'rejected' && this._state(e.key).rejected?.reason === 'billing') out.billing++;
    }
    return out;
  }

  /** Administrative reset — one slot, or the whole pool. */
  resetCredentials({ slot = null } = {}) {
    if (slot == null) { this.store.clear(); this.cursor = 0; return; }
    const e = this.entries().find(x => x.slot === slot);
    if (e) this.store.delete(e.key);
  }

  /**
   * Diagnostic snapshot. Slot labels and counters only — never key material,
   * never a fragment or hash of it. Safe to serialise and log.
   */
  snapshot({ verifiedWindowMs = DEFAULT_VERIFIED_WINDOW_MS } = {}) {
    const { slots, duplicates, blanks } = discoverKeySlots(this.provider, this.env());
    const now = this.now();
    const perSlot = slots.map(({ slot, envName, key }) => {
      const s = this._state(key);
      const status = this._status(key, null, now);
      const modelCooldowns = [...s.modelCooldowns.entries()]
        .filter(([, v]) => v.until > now)
        .map(([model, v]) => ({ model, remainingMs: v.until - now, reason: v.reason }));
      let health = 'unknown';
      if (status === 'rejected') health = 'rejected';
      else if (s.verifiedAt && now - s.verifiedAt <= verifiedWindowMs) health = 'verified';
      return {
        slot, envName, status,
        coolingForModels: modelCooldowns,
        cooldownRemainingMs: status === 'cooling' ? s.cooldownUntil - now : 0,
        rejectedReason: status === 'rejected' ? s.rejected.reason : null,
        health, verifiedBy: health === 'verified' ? s.verifiedBy : null,
        format: credentialFormat(this.provider, key),
        attempts: s.attempts, successes: s.successes, failures: s.failures,
        lastErrorType: s.lastErrorType,
      };
    });
    const count = st => perSlot.filter(p => p.status === st).length;
    const partiallyCooling = perSlot.filter(p => p.status === 'available' && p.coolingForModels.length).length;
    const snap = {
      provider: this.provider,
      discoveredSlots: slots.length + duplicates.length,
      distinctCredentials: slots.length,
      duplicateSlotsIgnored: duplicates.map(d => ({ slot: d.slot, duplicateOf: d.duplicateOf })),
      blankSlotsIgnored: blanks.map(b => b.slot),
      available: count('available'), cooling: count('cooling'), rejected: count('rejected'),
      coolingForSomeModels: partiallyCooling,
      verified: perSlot.filter(p => p.health === 'verified').length,
      unrecognizedFormat: perSlot.filter(p => p.format === 'unrecognized').map(p => p.slot),
      slots: perSlot,
    };
    snap.summary = summaryLine(this.displayName, snap);
    return snap;
  }
}

function summaryLine(name, s) {
  if (!s.distinctCredentials) return `${name}: no credentials configured`;
  const unknown = s.distinctCredentials - s.verified - s.rejected;
  const parts = [`${s.distinctCredentials} distinct configured slot${s.distinctCredentials === 1 ? '' : 's'}`];
  if (s.duplicateSlotsIgnored.length) parts.push(`${s.duplicateSlotsIgnored.length} duplicate slot(s) ignored (${s.duplicateSlotsIgnored.map(d => `${d.slot}=${d.duplicateOf}`).join(', ')})`);
  parts.push(`${s.cooling} cooling`);
  if (s.coolingForSomeModels) parts.push(`${s.coolingForSomeModels} cooling for some models`);
  parts.push(`${s.rejected} rejected`);
  parts.push(unknown === s.distinctCredentials ? 'credential checks pending' : `${s.verified} verified, ${unknown} unverified`);
  if (s.unrecognizedFormat.length) parts.push(`non-standard format (validity unknown): ${s.unrecognizedFormat.join(',')}`);
  return `${name}: ${parts.join('; ')}`;
}

// ── Registry (one pool per provider per process) ─────────────────────────────

const pools = new Map();
function getKeyPool(provider) {
  if (!pools.has(provider)) pools.set(provider, new KeyPool(provider));
  return pools.get(provider);
}

/** Every provider's snapshot — the payload behind /health and the startup log. */
function getCredentialDiagnostics() {
  const out = {};
  for (const p of PROVIDERS) out[p] = getKeyPool(p).snapshot();
  return out;
}

// ── Failure classification (the credential-relevant part only) ──────────────
//
// The engine's providerErrors.js stays the authority on model/server/network
// categories. This answers ONE question both call paths need identically:
// "does this failure say something about the CREDENTIAL?"

function statusOf(err) {
  const s = err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.httpError?.status ?? err?.cause?.status;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function bodyText(err) {
  const parts = [err?.message];
  const d = err?.response?.data ?? err?.error ?? err?.body;
  if (d != null) {
    if (typeof d === 'string') parts.push(d);
    else if (Buffer.isBuffer(d)) parts.push(d.toString('utf8').slice(0, 2000));
    else { try { parts.push(JSON.stringify(d).slice(0, 4000)); } catch { /* ignore */ } }
  }
  return parts.filter(Boolean).join(' ');
}

function headerOf(err, name) {
  const lower = name.toLowerCase();
  const sources = [
    err?.response?.headers, err?.headers, err?.responseHeaders,
    err?.error?.metadata?.headers, err?.response?.data?.error?.metadata?.headers,
  ];
  for (const h of sources) {
    if (!h) continue;
    if (typeof h.get === 'function') { const v = h.get(name); if (v != null) return v; continue; }
    for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  }
  return null;
}

/** "2m59.56s" / "7.66s" / "450ms" / "31s" → ms. */
function parseDuration(s) {
  const str = String(s ?? '').trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1000);
  let total = 0, matched = false;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m;
  while ((m = re.exec(str))) {
    matched = true;
    const n = parseFloat(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(total) : null;
}

/**
 * Retry hint from every place the four providers put one: Retry-After
 * (seconds or HTTP-date), Groq's x-ratelimit-reset-* durations, OpenRouter's
 * X-RateLimit-Reset (epoch ms), Google's RetryInfo `retryDelay` and its
 * "Please retry in 31.5s" message.
 */
function retryHintMs(err, now = Date.now()) {
  if (Number.isFinite(err?.retryAfterMs)) return Math.max(0, err.retryAfterMs);
  const ra = headerOf(err, 'retry-after');
  if (ra != null) {
    const s = String(ra).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
    const d = Date.parse(s);
    if (!Number.isNaN(d)) return Math.max(0, d - now);
  }
  const reset = headerOf(err, 'x-ratelimit-reset');
  if (reset != null && /^\d{12,}$/.test(String(reset).trim())) return Math.max(0, Number(reset) - now);
  for (const h of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const v = parseDuration(headerOf(err, h));
    if (v != null) return v;
  }
  const text = bodyText(err);
  const rd = /"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?s)"?/i.exec(text);
  if (rd) return parseDuration(rd[1]);
  const m = /(?:retry in|retry after|try again in)\s+((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+|\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?))/i.exec(text);
  if (m) {
    const v = m[1].replace(/\s+/g, '');
    if (/minutes?$/i.test(v)) return Math.round(parseFloat(v) * 60_000);
    if (/(seconds?|secs?)$/i.test(v)) return Math.round(parseFloat(v) * 1000);
    return parseDuration(v);
  }
  return null;
}

const KEY_INVALID_RE = /api[ _-]?key[^.]{0,40}?(not valid|invalid|expired|revoked|disabled)|API_KEY_(INVALID|EXPIRED)|ACCESS_TOKEN_EXPIRED|ACCESS_TOKEN_TYPE_UNSUPPORTED|invalid[ _-]?api[ _-]?key|incorrect api key|invalid (authentication|credentials|bearer token|token)|token (has )?expired|UNAUTHENTICATED|user not found/i;
const BILLING_RE = /insufficient (credits|balance|funds)|credit balance|payment required|out of credits|requires? (more )?credits|billing (account|is) (disabled|not)|exceeded your (monthly )?(spend|budget)/i;
const CONTENT_RE = /moderation|flagged|content policy|safety/i;

/**
 * @returns {{ kind: 'auth'|'billing'|'rate_limit'|'content'|'other', status: number|null, retryAfterMs: number|null }}
 *   auth       the credential itself was refused (401, 403, or a 400 that says
 *              the key is invalid/expired — Google's API_KEY_INVALID is a 400)
 *   billing    402 / out-of-credits wording — scoped to that credential's account
 *   rate_limit 429 / RESOURCE_EXHAUSTED
 *   content    a 403 that is a moderation/safety refusal, NOT a credential problem
 *   other      everything else (model, server, network) — not about the key
 */
function classifyKeyFailure(err) {
  const status = statusOf(err);
  const text = bodyText(err);
  const retryAfterMs = retryHintMs(err);
  if (status === 402 || ((status === 403 || status === 400) && BILLING_RE.test(text))) return { kind: 'billing', status, retryAfterMs };
  if (status === 403 && CONTENT_RE.test(text) && !KEY_INVALID_RE.test(text)) return { kind: 'content', status, retryAfterMs };
  if (status === 401 || status === 403) return { kind: 'auth', status, retryAfterMs };
  if (status === 429) return { kind: 'rate_limit', status, retryAfterMs };
  // Wording alone (no status) never quarantines a key: a misread would knock
  // a working credential out until restart.
  if (status === 400 && KEY_INVALID_RE.test(text)) return { kind: 'auth', status, retryAfterMs };
  if (status == null && /resource_exhausted|too many requests|rate limit/i.test(text)) return { kind: 'rate_limit', status, retryAfterMs };
  return { kind: 'other', status, retryAfterMs };
}

/**
 * OpenRouter's 429 has two meanings. The account/key limits
 * ("Rate limit exceeded: free-models-per-day", per-minute key limits) are
 * KEY-scoped — another key (another account) can serve the request. The
 * upstream "<model> is temporarily rate-limited upstream" is MODEL-scoped —
 * another key reaches the same saturated upstream. Default: model (the
 * pre-existing behaviour), so an unrecognised 429 never burns the key pool.
 */
function openRouterRateLimitScope(err) {
  const text = bodyText(err);
  if (/upstream/i.test(text)) return 'model';
  if (/free-models-per-(day|min)|rate limit exceeded:|key limit|requests per (day|minute)|daily limit/i.test(text)) return 'key';
  return 'model';
}

// ── Usage / health observability ──────────────────────────────────────────────
//
// Counters only — no prompts, no content, no owner ids, no key material.
// Unknown token counts stay unknown (`usageUnreported`), never zero.

const telemetry = new Map(); // `${provider}|${model}|${slot}|${purpose}` → counters
const TELEMETRY_MAX_SERIES = 2_000;

function seriesFor(provider, model, slot, purpose) {
  const id = `${provider}|${model ?? '-'}|${slot ?? '-'}|${purpose ?? 'other'}`;
  let t = telemetry.get(id);
  if (!t) {
    if (telemetry.size >= TELEMETRY_MAX_SERIES) telemetry.delete(telemetry.keys().next().value);
    t = {
      provider, model: model ?? null, slot: slot ?? null, purpose: purpose ?? 'other',
      attempts: 0, successes: 0, failures: 0, byErrorType: {},
      keySwitches: 0, rateLimited: 0, lastCooldownMs: null, lastRetryAfterMs: null,
      latencyMsTotal: 0, latencySamples: 0, ttftMsTotal: 0, ttftSamples: 0,
      inputTokens: 0, outputTokens: 0, usageReported: 0, usageUnreported: 0,
    };
    telemetry.set(id, t);
  }
  return t;
}

/**
 * Record ONE attempt. Success usage is recorded once per successful attempt —
 * failed attempts carry no tokens, so a retried request is never double-counted.
 */
function recordKeyAttempt({ provider, model, slot, purpose, outcome, errorType = null, latencyMs = null, ttftMs = null, usage, cooldownMs = null, retryAfterMs = null, keySwitch = false }) {
  try {
    const t = seriesFor(provider, model, slot, purpose);
    t.attempts++;
    if (keySwitch) t.keySwitches++;
    if (Number.isFinite(latencyMs)) { t.latencyMsTotal += latencyMs; t.latencySamples++; }
    if (Number.isFinite(ttftMs)) { t.ttftMsTotal += ttftMs; t.ttftSamples++; }
    if (outcome === 'success') {
      t.successes++;
      if (usage && (Number.isFinite(usage.inputTokens) || Number.isFinite(usage.outputTokens))) {
        t.usageReported++;
        t.inputTokens += Number(usage.inputTokens) || 0;
        t.outputTokens += Number(usage.outputTokens) || 0;
      } else t.usageUnreported++;
    } else {
      t.failures++;
      t.byErrorType[errorType ?? 'unknown'] = (t.byErrorType[errorType ?? 'unknown'] ?? 0) + 1;
      if (errorType === 'rate_limit') t.rateLimited++;
      if (Number.isFinite(cooldownMs)) t.lastCooldownMs = cooldownMs;
      if (Number.isFinite(retryAfterMs)) t.lastRetryAfterMs = retryAfterMs;
    }
  } catch { /* observability never fails a call */ }
}

function getProviderUsageSnapshot() {
  return [...telemetry.values()].map(t => ({
    provider: t.provider, model: t.model, slot: t.slot, purpose: t.purpose,
    attempts: t.attempts, successes: t.successes, failures: t.failures, byErrorType: { ...t.byErrorType },
    keySwitches: t.keySwitches, rateLimited: t.rateLimited,
    lastCooldownMs: t.lastCooldownMs, lastRetryAfterMs: t.lastRetryAfterMs,
    avgLatencyMs: t.latencySamples ? Math.round(t.latencyMsTotal / t.latencySamples) : null,
    avgTtftMs: t.ttftSamples ? Math.round(t.ttftMsTotal / t.ttftSamples) : null,
    // null, not 0, when no successful call reported usage.
    inputTokens: t.usageReported ? t.inputTokens : null,
    outputTokens: t.usageReported ? t.outputTokens : null,
    callsWithUnreportedUsage: t.usageUnreported,
  }));
}

// ── The rotation loop (shared by every adapter and the platform client) ──────

function timeoutError() { return new Error('TIMEOUT'); }

const ACTION_ERROR_TYPE = { key_rate_limited: 'rate_limit', key_rejected: 'auth', key_billing: 'billing' };

function errWith(message, fields) { return Object.assign(new Error(message), fields); }

/**
 * Run one request across candidate models × eligible credentials.
 *
 * For each model (in order), credentials are tried round-robin, each at most
 * once per model. `decide(err, ctx)` maps a failure to ONE of:
 *   { action: 'key_rate_limited', cooldownMs, model?: id|null }  cool, next key, same model
 *   { action: 'key_rejected', reason?: 'auth' }                  quarantine, next key
 *   { action: 'key_billing', ttlMs? }                            quarantine w/ TTL, next key
 *   { action: 'next_model' }                                     model-level; keys untouched
 *   { action: 'throw' }                                          stop now, rethrow
 * Rejections are self-limiting (a credential can be rejected once) so they do
 * not count toward the budget; every other attempt does:
 *   maxKeysPerModel  non-rejected attempts on one model (default 3)
 *   maxAttempts      non-rejected attempts in the whole request (default 8)
 * Streaming: an `attempt` that already emitted content throws an error with
 * `.partial` — that partial IS the answer; it is returned, never retried.
 *
 * Terminal errors when credentials ran out:
 *   ALL_KEYS_COOLING   status 429 + retryAfterMs = soonest credential frees
 *   ALL_KEYS_REJECTED  status 401 (non-retryable)
 *   ALL_KEYS_BILLING   status 402 (non-retryable; credits needed)
 * Otherwise the last provider error is rethrown unchanged.
 */
async function runWithKeyRotation({
  pool, models, attempt, decide, signal, label = '', purpose = 'other',
  maxKeysPerModel = 3, maxAttempts = 8, log = console.log,
  messages = {},
}) {
  if (signal?.aborted) throw timeoutError();
  const provider = pool.provider;
  const name = pool.displayName;
  if (!pool.hasKeys()) throw errWith(messages.noKeys ?? `No ${name} keys configured`, { code: 'NO_KEYS' });

  let lastError = null;
  let lastKeyError = false;      // was the LAST failure about a credential?
  let budget = maxAttempts;
  let attemptsMade = 0;
  let prevSlot = null;
  const modelIds = models.map(m => (typeof m === 'string' ? m : m.modelId));

  outer:
  for (let mi = 0; mi < models.length; mi++) {
    const entryModel = models[mi];
    const modelId = modelIds[mi];
    const tried = new Set();
    let perModel = maxKeysPerModel;

    while (perModel > 0 && budget > 0) {
      if (signal?.aborted) throw timeoutError();
      const cred = pool.acquire({ model: modelId, tried });
      if (!cred) break;
      tried.add(cred.slot);
      const keySwitch = prevSlot != null && prevSlot !== cred.slot;
      prevSlot = cred.slot;
      attemptsMade++;
      log(`[${name.toUpperCase()}] ${label}model=${modelId} key=${cred.slot}`);
      const started = Date.now();
      try {
        const res = await attempt({ key: cred.key, slot: cred.slot, modelId, model: entryModel });
        pool.reportSuccess(cred, { model: modelId });
        recordKeyAttempt({ provider, model: modelId, slot: cred.slot, purpose, outcome: 'success', latencyMs: Date.now() - started, ttftMs: res?.ttftMs ?? null, usage: res?.usage, keySwitch });
        return { ...res, keySlot: cred.slot, keyAttempts: attemptsMade };
      } catch (err) {
        if (err?.partial) {
          // Content already reached the client — the partial is the answer.
          pool.reportSuccess(cred, { model: modelId });
          recordKeyAttempt({ provider, model: modelId, slot: cred.slot, purpose, outcome: 'failure', errorType: 'interrupted', latencyMs: Date.now() - started, keySwitch });
          return { ...err.partial, keySlot: cred.slot, keyAttempts: attemptsMade };
        }
        if (err?.message === 'TIMEOUT' || signal?.aborted) throw timeoutError();
        lastError = err;
        const d = decide(err, { modelId, slot: cred.slot }) ?? { action: 'next_model' };
        const errorType = d.errorType ?? ACTION_ERROR_TYPE[d.action] ?? d.action;
        recordKeyAttempt({ provider, model: modelId, slot: cred.slot, purpose, outcome: 'failure', errorType, latencyMs: Date.now() - started, cooldownMs: d.cooldownMs ?? null, retryAfterMs: classifyKeyFailure(err).retryAfterMs, keySwitch });

        if (d.action === 'key_rejected') {
          pool.reject(cred, d.reason ?? 'auth');
          lastKeyError = true;
          log(`[${name.toUpperCase()}] ${label}key=${cred.slot} credential rejected (${d.reason ?? 'auth'}) → quarantined until reset/restart, trying next key`);
          continue;
        }
        if (d.action === 'key_billing') {
          const ttl = d.ttlMs ?? DEFAULT_BILLING_TTL_MS;
          pool.reject(cred, 'billing', { ttlMs: ttl });
          lastKeyError = true;
          log(`[${name.toUpperCase()}] ${label}key=${cred.slot} billing/credits refused → key cooldown ${Math.ceil(ttl / 1000)}s, trying next key`);
          continue;
        }
        perModel--; budget--;
        if (d.action === 'key_rate_limited') {
          pool.coolDown(cred, d.cooldownMs, { model: d.model ?? null });
          lastKeyError = true;
          log(`[${name.toUpperCase()}] ${label}model=${modelId} key=${cred.slot} rate limited → ${d.model ? 'key+model' : 'key'} cooldown ${Math.ceil(d.cooldownMs / 1000)}s, trying next key`);
          continue;
        }
        pool.reportNeutralFailure(cred, errorType);
        lastKeyError = false;
        if (d.action === 'throw') throw err;
        continue outer; // next_model
      }
    }
    if (budget <= 0) {
      log(`[${name.toUpperCase()}] ${label}attempt budget (${maxAttempts}) spent for this request`);
      break;
    }
  }

  // Credentials ran out (or were never usable): say WHY, with the right wait.
  if (!lastError || lastKeyError) {
    let soonest = null, cooling = 0, rejected = 0, billing = 0, available = 0;
    for (const id of modelIds) {
      const a = pool.availability(id);
      cooling += a.cooling; rejected += a.rejected; billing += a.billing; available += a.available;
      const w = pool.msUntilAvailable(id);
      if (w != null) soonest = soonest == null ? w : Math.min(soonest, w);
    }
    // available > 0 means the attempt BUDGET ran out, not the credentials —
    // the last provider error (a 429 with its own hint) is the honest answer.
    if (available === 0 && cooling > 0 && soonest != null) {
      throw errWith(messages.allCooling?.(soonest) ?? `All ${name} keys rate limited or cooling down (next free in ${Math.ceil(soonest / 1000)}s)`,
        { status: 429, retryAfterMs: soonest, code: 'ALL_KEYS_COOLING', provider });
    }
    if (available === 0 && rejected > 0) {
      if (billing === rejected) {
        throw errWith(messages.allBilling ?? `All ${name} keys refused for billing/credits`, { status: 402, code: 'ALL_KEYS_BILLING', provider });
      }
      throw errWith(messages.allRejected ?? `All ${name} keys rejected (unauthorized, invalid or expired) — fix credentials and restart`,
        { status: 401, code: 'ALL_KEYS_REJECTED', provider });
    }
  }
  throw lastError ?? errWith(`All ${name} attempts exhausted`, { code: 'ATTEMPTS_EXHAUSTED' });
}

// ── Test support ─────────────────────────────────────────────────────────────

function __resetForTests(provider = null) {
  if (provider) { pools.get(provider)?.resetCredentials(); }
  else { for (const p of pools.values()) p.resetCredentials(); }
  if (!provider) telemetry.clear();
}

module.exports = {
  PROVIDERS,
  SPECS,
  KeyPool,
  MemoryStateStore,
  discoverKeySlots,
  credentialFormat,
  getKeyPool,
  getCredentialDiagnostics,
  classifyKeyFailure,
  openRouterRateLimitScope,
  retryHintMs,
  parseDuration,
  runWithKeyRotation,
  recordKeyAttempt,
  getProviderUsageSnapshot,
  __resetForTests,
};
