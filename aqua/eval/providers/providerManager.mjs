/**
 * Evaluation provider manager (2026-11-11). EVALUATION ONLY — production
 * rotation (src/providers/keyPool.cjs, keyRotation.js) is not used or changed.
 *
 * Quota domains are the unit of rotation (evalConfig.mjs): a Gemini project or a
 * Groq organisation, or — when unverified — all of a provider's keys together.
 *
 *   key-scoped failure (invalid, expired, restricted)  → mark the KEY, try another key in the domain
 *   temporary 429                                      → cool the DOMAIN until Retry-After; wait inline if
 *                                                        short, else try an INDEPENDENT verified domain, else pause
 *   quota exhausted                                    → PAUSE the DOMAIN until its reset (all its keys)
 *   billing / paid-tier required                       → STOP everything; never another route
 *   network / 5xx                                      → bounded retry on the same key
 *   request too large                                  → reject the request (no retry)
 *   unknown                                            → STOP for review
 *
 * Only domains with VERIFIED free-tier status ever receive a request. The model
 * for a role never changes inside a run (no fallback to another model or provider).
 * Observability: events with provider, model, envName, domain hash, tokens,
 * category, retries, cooldown state — never a credential value.
 */
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { classify, CATEGORIES } from './errorTaxonomy.mjs';
import { preflight } from './evalConfig.mjs';

export class QuotaPaused extends Error {
  constructor(provider, resumeAt, detail) { super(`${provider}: every eligible quota domain is paused until ${new Date(resumeAt).toISOString()}`); this.name = 'QuotaPaused'; this.provider = provider; this.resumeAt = resumeAt; this.detail = detail; }
}
export class BillingStop extends Error { constructor(detail) { super('billing / paid tier required — evaluation stopped; no other route is tried'); this.name = 'BillingStop'; this.detail = detail; } }
export class ReviewRequired extends Error { constructor(detail) { super('unclassified provider error — evaluation stopped for review'); this.name = 'ReviewRequired'; this.detail = detail; } }
export class RequestRejected extends Error { constructor(detail) { super(`request rejected (${detail.category})`); this.name = 'RequestRejected'; this.detail = detail; } }
export class DataRefused extends Error { constructor(msg) { super(msg); this.name = 'DataRefused'; } }

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;

/**
 * Conservative request-size estimate (no tokenizer is installed): ceil(chars / 3) for the prompt —
 * English text averages ~4 characters per token, so /3 over-estimates — plus 8 tokens of chat
 * framing per message and 16 per request, PLUS the full bounded output (max_tokens), because
 * providers count requested output against per-minute token limits.
 */
export function estimateRequestTokens(messages, maxOutput) {
  const chars = (messages ?? []).reduce((s, m) => s + String(m.content ?? '').length, 0);
  return Math.ceil(chars / 3) + 8 * (messages ?? []).length + 16 + (Number.isInteger(maxOutput) ? maxOutput : 0);
}

export function createManager({ config, env = process.env, transport, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), maxInlineWaitMs = 30_000, networkRetries = 2, defaultCooldownMs = 60_000 } = {}) {
  if (typeof transport !== 'function') throw new Error('a transport is required (tests inject a mock; live transports need approval)');
  const { domains, excluded } = preflight(config, env);
  const keyState = new Map();        // envName → { status: 'ok'|'invalid'|'expired'|'restricted' }
  const domainState = new Map();     // domain id → { status: 'ok'|'cooling'|'paused', until, reason }
  const cursor = new Map();          // domain id → round-robin index
  const attemptsByProvider = new Map(); // provider → transport attempts this run (requestBudget)
  const sentLog = new Map();         // provider → [{ at, tokens }] of attempts in the last minute (pacing)
  /**
   * Hard token budgets (config.tokenBudget = { perRequest: {provider: n}, run: {provider: n},
   * group: {<quota-domain id>: n per UTC day}, ledgerFile }). Before EVERY attempt the conservative
   * estimate (prompt chars/3 + framing + the full max_tokens) must fit every applicable budget, or
   * nothing is sent: per-request → RequestRejected; run → QuotaPaused('run-token-budget');
   * group → QuotaPaused('group-token-budget') until the next UTC day. After the attempt, the
   * provider-reported usage (prompt + completion) is charged; an attempt without reported usage
   * (error, network failure) is charged its full estimate. The group ledger is a JSONL file shared
   * by successive runs (one run at a time: the run lock), so a group's daily budget holds across runs.
   */
  const tb = config?.tokenBudget ?? null;
  const runTokens = new Map();       // provider → tokens charged this run
  const groupTokens = new Map();     // `${utcDay}|${domainId}` → tokens charged (ledger + this run)
  const utcDay = () => new Date(now()).toISOString().slice(0, 10);
  const nextUtcDay = () => { const t = new Date(now()); t.setUTCHours(24, 0, 0, 0); return t.getTime(); };
  if (tb?.ledgerFile && existsSync(tb.ledgerFile)) {
    for (const line of readFileSync(tb.ledgerFile, 'utf8').split('\n').filter(Boolean)) {
      try { const e = JSON.parse(line); const k = `${e.day}|${e.group}`; groupTokens.set(k, (groupTokens.get(k) ?? 0) + (Number(e.tokens) || 0)); } catch { /* skip a torn line */ }
    }
  }
  const groupUsed = d => groupTokens.get(`${utcDay()}|${d.id}`) ?? 0;
  const charge = (provider, d, tokens, kind) => {
    runTokens.set(provider, (runTokens.get(provider) ?? 0) + tokens);
    const k = `${utcDay()}|${d.id}`;
    groupTokens.set(k, (groupTokens.get(k) ?? 0) + tokens);
    if (tb?.ledgerFile) appendFileSync(tb.ledgerFile, `${JSON.stringify({ day: utcDay(), at: new Date(now()).toISOString(), group: d.id, provider, tokens, kind })}\n`);
  };
  const events = [];
  let stopped = null;                // { reason, detail } once billing/unknown stops the run
  // Strict behaviour for EXISTING PRODUCTION POOLS (default; a config may opt out explicitly):
  //   keyRotation false      → every request uses the FIRST configured key of the group; a key-scoped
  //                            failure stops the run for review instead of moving to another key;
  //   waitOnRateLimit false  → ANY rate-limit / quota 429 pauses the run at once: no inline wait,
  //                            no retry, no move to another key or quota group.
  const productionPools = config?.credentialMode === 'existing-numbered-pools';
  const keyRotation = typeof config?.keyRotation === 'boolean' ? config.keyRotation : !productionPools;
  const waitOnRateLimit = typeof config?.waitOnRateLimit === 'boolean' ? config.waitOnRateLimit : !productionPools;

  const eligibleDomains = provider => domains.filter(d => d.provider === provider && d.billing === 'free-tier-verified');
  const domainOpen = d => { const s = domainState.get(d.id); if (!s || s.status === 'ok') return true; if (now() >= s.until) { domainState.set(d.id, { status: 'ok' }); return true; } return false; };
  const healthyKeys = d => d.credentials.filter(c => (keyState.get(c.envName)?.status ?? 'ok') === 'ok');
  const resetAt = (d, ra) => {
    if (ra != null) return now() + ra;
    const h = d.resetPolicy?.dailyResetUtcHour;
    if (Number.isInteger(h)) { const t = new Date(now()); t.setUTCHours(h, 0, 0, 0); if (t.getTime() <= now()) t.setUTCDate(t.getUTCDate() + 1); return t.getTime(); }
    return now() + DAY;                                         // unknown reset: wait a full day (conservative)
  };
  const event = e => {
    // Allow-listed fields only.
    const ev = { at: now(), provider: e.provider, model: e.model, envName: e.envName ?? null, domain: e.domain ?? null, outcome: e.outcome, category: e.category ?? null,
      retry: e.retry ?? 0, promptTokens: e.promptTokens ?? null, completionTokens: e.completionTokens ?? null, cooldown: e.cooldown ?? null, role: e.role ?? null, caseId: e.caseId ?? null };
    events.push(ev);
  };

  function pick(provider) {
    for (const d of eligibleDomains(provider)) {
      if (!domainOpen(d)) continue;
      const keys = healthyKeys(d);
      if (!keys.length) continue;
      if (!keyRotation) return { domain: d, key: keys[0] };     // one fixed key; never switches
      const i = (cursor.get(d.id) ?? 0) % keys.length;
      cursor.set(d.id, i + 1);
      return { domain: d, key: keys[i] };
    }
    return null;
  }
  /**
   * Pacing (config.rateLimits[provider] = { tokensPerMinute, minIntervalMs, maxRequestTokens? }):
   * before EVERY attempt (retries included) wait until (a) minIntervalMs has passed since the
   * previous attempt to this provider and (b) the estimated tokens of attempts in the last
   * minute plus this one fit tokensPerMinute. Waits are recorded as events.
   */
  async function pace(provider, model, est, rl, role, caseId) {
    for (let guard = 0; guard < 100; guard++) {
      const log = (sentLog.get(provider) ?? []).filter(x => x.at > now() - MINUTE);
      sentLog.set(provider, log);
      const last = log.length ? log[log.length - 1].at : null;
      const waitInterval = last != null ? last + (rl.minIntervalMs ?? 0) - now() : 0;
      const used = log.reduce((s, x) => s + x.tokens, 0);
      const waitWindow = used + est > rl.tokensPerMinute && log.length ? log[0].at + MINUTE - now() : 0;
      const wait = Math.max(waitInterval, waitWindow, 0);
      if (wait <= 0) { log.push({ at: now(), tokens: est }); return; }
      event({ provider, model, outcome: 'pacing-wait', category: waitWindow >= waitInterval ? 'tokens_per_minute' : 'min_interval', cooldown: { until: now() + wait }, role, caseId });
      await sleep(wait);
    }
    throw new ReviewRequired({ provider, model, reason: 'pacing guard exceeded' });
  }
  const earliestResume = provider => {
    const t = eligibleDomains(provider).map(d => domainState.get(d.id)).filter(s => s && s.status !== 'ok').map(s => s.until);
    return t.length ? Math.min(...t) : null;
  };

  return {
    domains: domains.map(d => ({ id: d.id, hash: d.hash, provider: d.provider, verified: d.verified, billing: d.billing, envNames: d.credentials.map(c => c.envName) })),
    excluded,
    events,
    get stopped() { return stopped; },

    /** One request for `role` ('answer' | 'judge'). The model is the config's — never substituted. */
    async request({ role, caseId = null, datasetId, messages, settings = {} }) {
      if (stopped) throw stopped.reason === 'billing' ? new BillingStop(stopped.detail) : new ReviewRequired(stopped.detail);
      if (!config.syntheticDatasets.includes(datasetId)) throw new DataRefused(`dataset ${String(datasetId).slice(0, 12)}… is not an allow-listed synthetic benchmark — refusing (user histories are never sent)`);
      const { provider, model } = config.models[role];
      const genSettings = { ...(config.models[role].settings ?? {}), ...settings };
      // Size ceiling: a request whose conservative estimate (prompt + bounded output) exceeds the
      // provider's per-request limit is rejected BEFORE it is sent (Groq would answer 413 anyway).
      const rl = config.rateLimits?.[provider] ?? null;
      const est = estimateRequestTokens(messages, genSettings.max_tokens);
      const perRequestCaps = [rl ? (rl.maxRequestTokens ?? rl.tokensPerMinute) : null, tb?.perRequest?.[provider] ?? null].filter(Number.isInteger);
      const perRequestCap = perRequestCaps.length ? Math.min(...perRequestCaps) : null;
      if (perRequestCap != null && est > perRequestCap) {
        const detail = { provider, model, category: 'over_token_limit', estimatedTokens: est, limit: perRequestCap, role, caseId };
        event({ ...detail, outcome: 'request-rejected' });
        throw new RequestRejected(detail);
      }
      let retry = 0;
      for (let guard = 0; guard < 200; guard++) {
        const p = pick(provider);
        if (!p) {
          const resume = earliestResume(provider);
          if (resume != null) throw new QuotaPaused(provider, resume, { role, model });
          throw new QuotaPaused(provider, now() + DAY, { role, model, reason: 'no-healthy-credential' });
        }
        const { domain, key } = p;
        // Per-run request budget (required for existing production pools: the quota is shared with
        // production traffic). Every attempt counts, retries included. At the cap the run PAUSES —
        // resumable by a later run — it never moves to another route.
        const budget = config.requestBudget?.[provider];
        if (Number.isInteger(budget) && (attemptsByProvider.get(provider) ?? 0) >= budget) {
          event({ provider, model, envName: null, domain: domain.hash, outcome: 'budget-reached', category: 'run_request_budget', retry, role, caseId });
          throw new QuotaPaused(provider, now(), { role, model, reason: 'run-request-budget', budget });
        }
        // Hard token budgets: the conservative estimate must fit BEFORE anything is sent.
        const runCap = tb?.run?.[provider];
        if (Number.isInteger(runCap) && (runTokens.get(provider) ?? 0) + est > runCap) {
          event({ provider, model, envName: null, domain: domain.hash, outcome: 'budget-reached', category: 'run_token_budget', retry, role, caseId });
          throw new QuotaPaused(provider, now(), { role, model, reason: 'run-token-budget', budget: runCap });
        }
        const groupCap = tb?.group?.[domain.id];
        if (Number.isInteger(groupCap) && groupUsed(domain) + est > groupCap) {
          event({ provider, model, envName: null, domain: domain.hash, outcome: 'budget-reached', category: 'group_token_budget', retry, role, caseId });
          throw new QuotaPaused(provider, nextUtcDay(), { role, model, reason: 'group-token-budget', budget: groupCap });
        }
        if (rl) await pace(provider, model, est, rl, role, caseId);
        attemptsByProvider.set(provider, (attemptsByProvider.get(provider) ?? 0) + 1);
        let res;
        try { res = await transport({ provider, model, credential: key, messages, settings: genSettings }); }
        catch (err) { res = { networkError: err }; }
        {
          const u = res?.usage;
          const reported = u && Number.isFinite(u.prompt_tokens) ? u.prompt_tokens + (Number(u.completion_tokens) || 0) : null;
          if (reported != null && reported > est) event({ provider, model, envName: key.envName, domain: domain.hash, outcome: 'estimate-exceeded', category: 'token_estimate', retry, role, caseId });
          charge(provider, domain, reported ?? est, reported != null ? 'reported' : 'estimate');
        }
        if (res && !res.networkError && res.status >= 200 && res.status < 300) {
          // A success with NO text (e.g. a reasoning model spent the whole output budget on
          // hidden reasoning, finish reason "length"/"MAX_TOKENS") is not an answer. It is never
          // stored as one and never retried blindly (a retry would spend quota the same way):
          // the run stops for review so the output budget can be fixed.
          if (!String(res.text ?? '').trim()) {
            const detail = { provider, model, envName: key.envName, domain: domain.hash, category: 'empty_completion', finishReason: res.finishReason ?? null, retry, role, caseId };
            stopped = { reason: 'review', detail };
            event({ ...detail, outcome: 'stopped-review', promptTokens: res.usage?.prompt_tokens, completionTokens: res.usage?.completion_tokens });
            throw new ReviewRequired(detail);
          }
          event({ provider, model, envName: key.envName, domain: domain.hash, outcome: 'ok', retry, promptTokens: res.usage?.prompt_tokens, completionTokens: res.usage?.completion_tokens, role, caseId });
          return { text: res.text, usage: res.usage ?? null, provider, model, envName: key.envName, domain: domain.hash, retries: retry };
        }
        const c = classify(res, now());
        const base = { provider, model, envName: key.envName, domain: domain.hash, category: c.category, retry, role, caseId };
        switch (c.category) {
          case 'invalid_credential': case 'expired_credential': case 'key_restricted':
            keyState.set(key.envName, { status: c.category === 'invalid_credential' ? 'invalid' : c.category === 'expired_credential' ? 'expired' : 'restricted' });
            event({ ...base, outcome: 'key-excluded' });
            if (!keyRotation) {                                 // no switch to another key: stop for review
              stopped = { reason: 'review', detail: { ...base, reason: 'key-failed-no-rotation' } };
              throw new ReviewRequired(stopped.detail);
            }
            continue;                                           // another key in the same (or next) domain
          case 'rate_limited_temporary': {
            if (!waitOnRateLimit) {                             // strict: pause at once, no wait, no retry
              const until = now() + (c.retryAfterMs ?? defaultCooldownMs);
              domainState.set(domain.id, { status: 'paused', until, reason: c.category });
              event({ ...base, outcome: 'paused-on-rate-limit', cooldown: { until } });
              throw new QuotaPaused(provider, until, { role, model, reason: c.category });
            }
            const wait = c.retryAfterMs ?? defaultCooldownMs;
            domainState.set(domain.id, { status: 'cooling', until: now() + wait, reason: c.category });
            event({ ...base, outcome: 'domain-cooling', cooldown: { until: now() + wait } });
            if (wait <= maxInlineWaitMs && !eligibleDomains(provider).some(d => d !== domain && domainOpen(d) && healthyKeys(d).length)) {
              await sleep(wait); retry++;
            }
            continue;
          }
          case 'quota_exhausted': {
            const until = resetAt(domain, c.retryAfterMs);
            domainState.set(domain.id, { status: 'paused', until, reason: c.category });
            event({ ...base, outcome: waitOnRateLimit ? 'domain-paused' : 'paused-on-rate-limit', cooldown: { until } });
            if (!waitOnRateLimit) throw new QuotaPaused(provider, until, { role, model, reason: c.category });   // strict: no other group
            continue;                                           // only an INDEPENDENT verified domain can serve now
          }
          case 'billing_required':
            stopped = { reason: 'billing', detail: { ...base } };
            event({ ...base, outcome: 'stopped-billing' });
            throw new BillingStop(base);
          case 'request_too_large':
            event({ ...base, outcome: 'request-rejected' });
            throw new RequestRejected(base);
          case 'network': case 'server_error':
            if (retry >= networkRetries) { event({ ...base, outcome: 'retries-exhausted' }); throw Object.assign(new Error('network retries exhausted'), { name: 'RetriesExhausted', detail: base }); }
            retry++;
            event({ ...base, outcome: 'retry' });
            await sleep(Math.min(8000, 500 * 2 ** (retry - 1)));
            continue;
          default:
            stopped = { reason: 'review', detail: { ...base, status: res?.status ?? null } };
            event({ ...base, outcome: 'stopped-review' });
            throw new ReviewRequired(stopped.detail);
        }
      }
      throw new ReviewRequired({ provider, model, reason: 'attempt guard exceeded' });
    },

    /** Content-free state: per key and per domain. */
    state() {
      return {
        keys: domains.flatMap(d => d.credentials.map(c => ({ provider: d.provider, envName: c.envName, domain: d.hash, status: keyState.get(c.envName)?.status ?? 'unknown-until-used' }))),
        domains: domains.map(d => { domainOpen(d); const s = domainState.get(d.id) ?? { status: 'ok' }; return { provider: d.provider, domain: d.hash, verified: d.verified, billing: d.billing, status: s.status, until: s.until ?? null }; }),
        stopped: stopped ? { reason: stopped.reason } : null,
        tokens: {
          run: Object.fromEntries(runTokens),
          groupsToday: Object.fromEntries(domains.map(d => [d.id, { used: groupUsed(d), budget: tb?.group?.[d.id] ?? null }])),
          budgets: tb ? { perRequest: tb.perRequest ?? null, run: tb.run ?? null } : null,
        },
      };
    },

    /** Aggregate observability (allow-listed fields only). */
    summary() {
      const by = {};
      // Only SENT attempts: each produces exactly one event naming its key. Pacing waits, the
      // budget stop and pre-send rejections carry no key and are not requests.
      for (const e of events.filter(x => x.envName)) {
        const k = `${e.provider}|${e.model}|${e.envName}|${e.domain}`;
        const s = (by[k] ??= { provider: e.provider, model: e.model, envName: e.envName, domain: e.domain, requests: 0, ok: 0, promptTokens: 0, completionTokens: 0, errors: {}, retries: 0 });
        s.requests++; if (e.outcome === 'ok') s.ok++;
        s.promptTokens += e.promptTokens ?? 0; s.completionTokens += e.completionTokens ?? 0;
        if (e.category) s.errors[e.category] = (s.errors[e.category] ?? 0) + 1;
        s.retries = Math.max(s.retries, e.retry ?? 0);
      }
      return Object.values(by);
    },
  };
}

export { CATEGORIES };
