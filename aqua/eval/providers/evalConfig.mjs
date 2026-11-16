/**
 * Evaluation provider configuration + preflight (2026-11-11). EVALUATION ONLY.
 *
 * Nothing here can be inferred from a key. What the evaluation may do is DECLARED
 * by the operator in a config file, and the preflight refuses to run unless the
 * declarations make every possible request free and attributable:
 *
 *   evaluationOnly: true                          required
 *   allowProductionCredentials: true              required when credentials come from the production env
 *   credentialSource: 'production' | 'evaluation' required (the repo .env labels itself "production env")
 *   syntheticDatasets: [sha256, …]                only these benchmark datasets may be sent (never user histories)
 *   models: { answer: {provider, model, settings}, judge: {provider, model, settings} }
 *   domains: [{ id, provider, envNames[],
 *               verification: { method, by, at },      ← who established that these keys share ONE project/org
 *               billing: 'free-tier-verified' | 'unknown' | 'paid',
 *               billingEvidence: { method, by, at },   ← who confirmed no billing is attached
 *               resetPolicy?: { dailyResetUtcHour } }]
 *   allowNonStandard: [envName, …]                non-standard-format credentials, explicitly opted in
 *   credentialVerification: { by, at, statement, envNames[] }
 *                                                 production pools only: the founder's recorded verification
 *                                                 of non-standard numbered Gemini credentials (AQ.-prefixed);
 *                                                 an opted-in name it does not cover is refused
 *   rateLimits: { <provider>: { tokensPerMinute, minIntervalMs, maxRequestTokens? } }
 *                                                 production pools: required per role provider; the manager
 *                                                 paces every attempt and rejects oversize requests unsent
 *
 *   tokenBudget: { perRequest: {provider: n}, run: {provider: n}, group: {<domain id>: n per UTC day}, ledgerFile }
 *                                                 production pools: all required (hard caps; see providerManager)
 *   orderSeed: string                             reproducible A/B order per case (recorded with every answer)
 *
 * Production pools also require: billing 'free-tier-verified' + billingEvidence on EVERY declared
 * domain (the credential verification is never billing evidence) and a bounded max_tokens per role.
 *
 * Rules:
 *   · a credential in no VERIFIED domain joins one implicit domain per provider,
 *     `unverified:<provider>` — two keys are NEVER assumed to be separate quota domains;
 *   · a domain whose billing is not 'free-tier-verified' can serve NO request;
 *   · a valid key is never evidence of free quota (validation does not touch billing).
 */
import { loadCredentials } from './credentials.mjs';
import crypto from 'node:crypto';

export class PreflightRefused extends Error {
  constructor(reasons) { super(`evaluation preflight refused:\n  - ${reasons.join('\n  - ')}`); this.name = 'PreflightRefused'; this.reasons = reasons; }
}

const verified = v => !!(v && v.method && v.by && v.at && !Number.isNaN(Date.parse(v.at)));

/**
 * Founder-verified credentials (2026-11-11). In credentialMode 'existing-numbered-pools', a
 * NON-STANDARD numbered credential (the AQ.-prefixed GEMINI_KEY_<n>) is usable only when it is
 * BOTH opted in (allowNonStandard) AND covered by a recorded verification:
 *   credentialVerification: { by, at, statement, envNames: [...] }
 * Outside that mode, or for an unnumbered name, non-standard credentials are never accepted
 * through this record. Returns the set of names the record covers (empty if the record is invalid).
 */
export const VERIFIABLE_NONSTANDARD = /^GEMINI_KEY_\d+$/;
export function verifiedNonStandardNames(config) {
  if (config?.credentialMode !== 'existing-numbered-pools') return new Set();
  const v = config?.credentialVerification;
  if (!v?.by || !v?.at || Number.isNaN(Date.parse(v.at)) || !v?.statement || !Array.isArray(v.envNames)) return new Set();
  return new Set(v.envNames.filter(n => VERIFIABLE_NONSTANDARD.test(n)));
}
/** Opted-in non-standard names that the config may actually use. */
function nonStandardAllowed(config) {
  const opted = new Set(config?.allowNonStandard ?? []);
  if (config?.credentialSource !== 'production') return opted;          // evaluation-only credentials: the gate refuses opt-in anyway
  const rec = verifiedNonStandardNames(config);
  return new Set([...opted].filter(n => rec.has(n)));
}
export const domainHash = id => crypto.createHash('sha256').update(`aqua-eval-domain:${id}`).digest('hex').slice(0, 12);

/**
 * Build the quota domains from the config and the credential inventory.
 * Returns { domains: [{ id, hash, provider, credentials[], verified, billing, resetPolicy }], excluded: [...] }.
 */
export function buildDomains(config, env) {
  const domains = [];
  const excluded = [];
  for (const provider of ['gemini', 'groq']) {
    const { usable, excluded: ex } = loadCredentials(provider, env);
    excluded.push(...ex.map(e => ({ provider, ...e })));
    const allowNS = nonStandardAllowed(config);
    const numberedOnly = config.numberedOnly === true || config.credentialMode === 'existing-numbered-pools';
    const creds = usable.filter(c => {
      // Existing-pool mode: only GEMINI_KEY_<n> / GROQ_API_KEY_<n>; the unnumbered production
      // keys (GEMINI_API_KEY, GROQ_API_KEY) are never an evaluation fallback.
      if (numberedOnly && c.slot === '#bare') { excluded.push({ provider, envName: c.envName, reason: 'unnumbered-excluded' }); return false; }
      if (c.compatibility === 'standard' || allowNS.has(c.envName)) return true;
      excluded.push({ provider, envName: c.envName, reason: (config.allowNonStandard ?? []).includes(c.envName) ? 'non-standard-not-covered-by-verification' : 'non-standard-format-not-opted-in' });
      return false;
    });
    const byName = new Map(creds.map(c => [c.envName, c]));
    const assigned = new Set();
    for (const d of (config.domains ?? []).filter(x => x.provider === provider)) {
      const members = (d.envNames ?? []).map(n => byName.get(n)).filter(Boolean);
      if (!members.length) continue;
      if (!verified(d.verification)) continue;                 // unverified grouping → falls into the shared domain below
      for (const m of members) {
        if (assigned.has(m.envName)) throw new PreflightRefused([`${m.envName} is declared in two domains`]);
        assigned.add(m.envName);
      }
      domains.push({
        id: d.id, hash: domainHash(d.id), provider, credentials: members, verified: true,
        billing: d.billing === 'free-tier-verified' && verified(d.billingEvidence) ? 'free-tier-verified' : (d.billing === 'paid' ? 'paid' : 'unknown'),
        resetPolicy: d.resetPolicy ?? null,
      });
    }
    const rest = creds.filter(c => !assigned.has(c.envName));
    if (rest.length) {
      // Every credential not in a VERIFIED domain shares ONE domain: never assume independence.
      // Its billing is free only if EVERY declared domain these keys appear in says so with evidence.
      const declared = (config.domains ?? []).filter(d => d.provider === provider && (d.envNames ?? []).some(n => rest.some(r => r.envName === n)));
      const allFree = rest.every(r => declared.some(d => d.envNames.includes(r.envName) && d.billing === 'free-tier-verified' && verified(d.billingEvidence)));
      const id = `unverified:${provider}`;
      domains.push({ id, hash: domainHash(id), provider, credentials: rest, verified: false, billing: allFree ? 'free-tier-verified' : 'unknown', resetPolicy: null });
    }
  }
  return { domains, excluded };
}

/** Refuse unless the run is evaluation-only, free, attributable and on synthetic data. */
export function preflight(config, env) {
  const reasons = [];
  if (config?.evaluationOnly !== true) reasons.push('evaluationOnly must be true (explicit evaluation-only configuration)');
  if (!['production', 'evaluation'].includes(config?.credentialSource)) reasons.push("credentialSource must be declared: 'production' or 'evaluation'");
  if (config?.credentialSource === 'production' && config?.allowProductionCredentials !== true) reasons.push('the credentials are production credentials: set allowProductionCredentials: true to use them for evaluation');
  // Existing numbered production pools (founder decision 2026-11-11): allowed only as an explicit,
  // recorded decision, numbered keys only, and with a hard per-run request budget per provider so an
  // evaluation can never consume the daily quota production traffic shares.
  if (config?.credentialSource === 'production') {
    if (config?.credentialMode !== 'existing-numbered-pools') reasons.push("production credentials are usable only with credentialMode: 'existing-numbered-pools'");
    const fd = config?.founderDecision;
    if (!fd?.by || !fd?.at || Number.isNaN(Date.parse(fd.at)) || !fd?.statement) reasons.push('founderDecision { by, at, statement } is required to use existing production key pools');
    for (const role of ['answer', 'judge']) {
      const p = config?.models?.[role]?.provider;
      const b = config?.requestBudget?.[p];
      if (p && !(Number.isInteger(b) && b > 0)) reasons.push(`requestBudget.${p}: a positive integer cap on evaluation requests per run is required (the quota is shared with production)`);
    }
    // Every declared account / quota group needs its OWN explicit free-tier evidence. The founder's
    // credential verification approves the keys; it is never evidence of free quota.
    const cvStatement = String(config?.credentialVerification?.statement ?? '').trim();
    for (const d of config?.domains ?? []) {
      if (d.billing !== 'free-tier-verified' || !verified(d.billingEvidence)) reasons.push(`domain ${d.id}: billing 'free-tier-verified' with billingEvidence { method, by, at } is required for every quota group (no group is assumed free)`);
      else if (cvStatement && [d.billingEvidence.method, d.billingEvidence.statement].some(x => String(x ?? '').trim() === cvStatement)) reasons.push(`domain ${d.id}: billingEvidence repeats the credential verification — free-tier status needs its own evidence (console billing / plan check)`);
    }
    // Pacing and bounded output for every provider a role uses.
    for (const role of ['answer', 'judge']) {
      const m = config?.models?.[role];
      if (!m?.provider) continue;
      const rl = config?.rateLimits?.[m.provider];
      if (!(Number.isInteger(rl?.tokensPerMinute) && rl.tokensPerMinute > 0 && Number.isInteger(rl?.minIntervalMs) && rl.minIntervalMs >= 0)) reasons.push(`rateLimits.${m.provider}: { tokensPerMinute, minIntervalMs } is required (pacing below the shared per-minute limit)`);
      const mt = m.settings?.max_tokens;
      if (!(Number.isInteger(mt) && mt > 0)) reasons.push(`models.${role}.settings.max_tokens: a positive integer output bound is required`);
      else if (Number.isInteger(rl?.tokensPerMinute) && mt >= (rl.maxRequestTokens ?? rl.tokensPerMinute)) reasons.push(`models.${role}.settings.max_tokens (${mt}) leaves no room for the prompt under rateLimits.${m.provider}`);
    }
    // Every opted-in non-standard name must be a numbered Gemini name covered by the recorded verification.
    const rec = verifiedNonStandardNames(config);
    const uncovered = (config?.allowNonStandard ?? []).filter(n => !rec.has(n));
    if (uncovered.length) reasons.push(`allowNonStandard: ${uncovered.join(', ')} not covered by credentialVerification { by, at, statement, envNames } (numbered GEMINI_KEY_<n> only)`);
  }
  if (!Array.isArray(config?.syntheticDatasets) || !config.syntheticDatasets.length) reasons.push('syntheticDatasets: list the sha256 of the synthetic benchmark datasets that may be sent');
  for (const role of ['answer', 'judge']) {
    const m = config?.models?.[role];
    if (!m?.provider || !m?.model) reasons.push(`models.${role}: provider and exact model id required`);
  }
  const { domains, excluded } = buildDomains(config ?? {}, env);
  // Production pools: hard token budgets per request, per run and per quota group are mandatory.
  if (config?.credentialSource === 'production') {
    const tb = config?.tokenBudget;
    const pos = v => Number.isInteger(v) && v > 0;
    const used = [...new Set(['answer', 'judge'].map(r => config?.models?.[r]?.provider).filter(Boolean))];
    for (const p of used) {
      if (!pos(tb?.perRequest?.[p])) reasons.push(`tokenBudget.perRequest.${p}: a positive integer token cap per request is required`);
      // D-2 consistency: one admissible request must fit the per-minute evaluation share, or pacing
      // could not honour that share. (The cap itself — 4,500 for ACIB v3 — is configuration.)
      const rlp = config?.rateLimits?.[p];
      const caps = [rlp?.maxRequestTokens ?? rlp?.tokensPerMinute, tb?.perRequest?.[p]].filter(pos);
      if (caps.length && pos(rlp?.tokensPerMinute) && Math.min(...caps) > rlp.tokensPerMinute) reasons.push(`the per-request cap (${Math.min(...caps)}) exceeds rateLimits.${p}.tokensPerMinute (${rlp.tokensPerMinute}): one admissible request must fit the per-minute evaluation share`);
      if (!pos(tb?.run?.[p])) reasons.push(`tokenBudget.run.${p}: a positive integer token cap per run is required`);
      for (const d of domains.filter(x => x.provider === p)) if (!pos(tb?.group?.[d.id])) reasons.push(`tokenBudget.group["${d.id}"]: a positive integer daily token cap for this quota group is required (unverified ownership → the group id is "${d.id}")`);
    }
    if (typeof tb?.ledgerFile !== 'string' || !tb.ledgerFile) reasons.push('tokenBudget.ledgerFile: a ledger path is required (group budgets hold across runs)');
  }
  for (const role of ['answer', 'judge']) {
    const p = config?.models?.[role]?.provider;
    if (!p) continue;
    const free = domains.filter(d => d.provider === p && d.billing === 'free-tier-verified');
    if (!free.length) reasons.push(`no ${p} quota domain has verified free-tier status (billing unknown or paid) — refusing: a valid key is not proof of free quota`);
  }
  if (reasons.length) throw new PreflightRefused(reasons);
  return { domains, excluded };
}
