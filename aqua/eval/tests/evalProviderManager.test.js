/**
 * Evaluation provider manager (2026-11-11). Every provider is MOCKED; the clock
 * and sleep are fake. Every credential value below contains the marker "SECRET"
 * so leakage can be checked by searching every output surface for it.
 * A global fetch tripwire proves no network request is made by this file.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { loadCredentials, malformedReason } from '../providers/credentials.mjs';
import { classify } from '../providers/errorTaxonomy.mjs';
import { preflight, buildDomains, PreflightRefused } from '../providers/evalConfig.mjs';
import { createManager, QuotaPaused, BillingStop, ReviewRequired, RequestRejected, DataRefused } from '../providers/providerManager.mjs';
import { runPairs } from '../providers/pairRunner.mjs';
import { mockTransport, liveTransport, LiveTransportRefused } from '../providers/transports.mjs';

// ── Network tripwire for the whole file ───────────────────────────────────────
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network is forbidden in this test'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetchCalls, 0, 'no network request was made'); });

const gsk = n => `gsk_SECRET${'A'.repeat(20)}${n}`;
const aiza = n => `AIza${`SECRET${n}`.padEnd(35, 'x')}`;
const aq = n => `AQ.SECRET-ephemeral-token-value-${n}`;
const ENV = {
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`GEMINI_KEY_${i + 1}`, aq(i + 1)])),
  GEMINI_API_KEY: aiza(0),
  ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`GROQ_API_KEY_${i + 1}`, gsk(i + 1)])),
  GROQ_API_KEY: gsk(0),
};
const DS = 'synthetic-acib-sha';
const ev = (by = 'founder') => ({ method: 'console-check', by, at: '2026-11-11' });
/** Config factory. Default: Groq answers, Gemini judges; unverified groupings; free tier declared per domain. */
function cfg(over = {}) {
  return {
    // Manager-behaviour tests use evaluation credentials; production sources are tested explicitly below
    // (they require credentialMode 'existing-numbered-pools' + founderDecision + requestBudget since 2026-11-11).
    evaluationOnly: true, credentialSource: 'evaluation', allowProductionCredentials: false, syntheticDatasets: [DS],
    allowNonStandard: Array.from({ length: 12 }, (_, i) => `GEMINI_KEY_${i + 1}`),
    models: { answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 700 } }, judge: { provider: 'gemini', model: 'gemini-2.5-flash', settings: { temperature: 0, max_tokens: 400 } } },
    domains: [
      { id: 'groq-all', provider: 'groq', envNames: ['GROQ_API_KEY', 'GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4', 'GROQ_API_KEY_5'], billing: 'free-tier-verified', billingEvidence: ev() },
      { id: 'gemini-all', provider: 'gemini', envNames: ['GEMINI_API_KEY', ...Array.from({ length: 12 }, (_, i) => `GEMINI_KEY_${i + 1}`)], billing: 'free-tier-verified', billingEvidence: ev() },
    ],
    ...over,
  };
}
function clock(start = Date.UTC(2026, 10, 11, 12)) {
  let t = start;
  return { now: () => t, sleep: async ms => { t += ms; }, advance: ms => { t += ms; } };
}
const ok = (text = 'ok') => ({ status: 200, text, usage: { prompt_tokens: 10, completion_tokens: 5 } });
const err = (status, body, headers = {}) => ({ status, headers, bodyText: body });
const MSG = [{ role: 'user', content: 'synthetic question' }];
const mgr = (transport, over = {}, c = clock()) => ({ c, m: createManager({ config: cfg(over.config), env: ENV, transport, now: c.now, sleep: c.sleep, ...over.opts }) });

describe('credential inventory', () => {
  test('numbered and unnumbered keys load; blanks, placeholders, whitespace, duplicates and wrong-provider keys are excluded', () => {
    const env = { GROQ_API_KEY_1: gsk(1), GROQ_API_KEY_2: '', GROQ_API_KEY_3: 'your_api_key_here', GROQ_API_KEY_4: ` ${gsk(4)}`, GROQ_API_KEY_5: gsk(1), GROQ_API_KEY: aiza(9) };
    const { usable, excluded } = loadCredentials('groq', env);
    assert.deepEqual(usable.map(c => c.envName), ['GROQ_API_KEY_1']);
    assert.deepEqual(excluded.map(e => `${e.envName}:${e.reason}`), ['GROQ_API_KEY_2:malformed:blank', 'GROQ_API_KEY_3:malformed:placeholder', 'GROQ_API_KEY_4:malformed:surrounding-whitespace', 'GROQ_API_KEY_5:duplicate-of:GROQ_API_KEY_1', 'GROQ_API_KEY:incompatible-format']);
  });
  test('non-standard Gemini values are classified, never assumed to be API keys', () => {
    const { usable } = loadCredentials('gemini', ENV);
    assert.equal(usable.filter(c => c.compatibility === 'non-standard').length, 12);
    assert.equal(usable.find(c => c.envName === 'GEMINI_API_KEY').compatibility, 'standard');
  });
  test('a credential object never reveals its value', () => {
    const [c] = loadCredentials('groq', ENV).usable;
    for (const s of [JSON.stringify(c), String(c), inspect(c), `${c}`, JSON.stringify({ c })]) assert.doesNotMatch(s, /SECRET/);
  });
  test('malformedReason', () => { assert.equal(malformedReason('a b'), 'contains-whitespace'); assert.equal(malformedReason('"x"'), 'contains-quotes'); assert.equal(malformedReason('short'), 'too-short'); });
});

describe('preflight: zero-cost protection', () => {
  test('refuses without explicit evaluation-only configuration', () => assert.throws(() => preflight(cfg({ evaluationOnly: false }), ENV), PreflightRefused));
  test('refuses production credentials unless explicitly enabled', () => assert.throws(() => preflight(cfg({ credentialSource: 'production', allowProductionCredentials: false }), ENV), /production credentials/));
  test('refuses when billing / free eligibility is unknown — a valid key is not proof of free quota', () => {
    const c = cfg(); c.domains = c.domains.map(d => ({ ...d, billing: 'unknown' }));
    assert.throws(() => preflight(c, ENV), /not proof of free quota/);
  });
  test('refuses a free-tier claim without evidence, and a domain marked paid', () => {
    const c1 = cfg(); c1.domains[0] = { ...c1.domains[0], billingEvidence: undefined };
    assert.throws(() => preflight(c1, ENV), /groq quota domain has verified free-tier/);
    const c2 = cfg(); c2.domains[0] = { ...c2.domains[0], billing: 'paid' };
    assert.throws(() => preflight(c2, ENV), /groq quota domain/);
  });
  test('refuses when no synthetic dataset is allow-listed', () => assert.throws(() => preflight(cfg({ syntheticDatasets: [] }), ENV), /syntheticDatasets/));
  test('non-standard credentials are excluded unless explicitly opted in', () => {
    const { domains, excluded } = buildDomains(cfg({ allowNonStandard: [] }), ENV);
    assert.equal(excluded.filter(e => e.reason === 'non-standard-format-not-opted-in').length, 12);
    assert.deepEqual(domains.find(d => d.provider === 'gemini').credentials.map(c => c.envName), ['GEMINI_API_KEY']);
  });
  test('keys without a VERIFIED grouping share ONE domain — never assumed independent', () => {
    const { domains } = buildDomains(cfg(), ENV);
    assert.deepEqual(domains.map(d => [d.id, d.credentials.length]), [['unverified:gemini', 13], ['unverified:groq', 6]]);
  });
});

describe('rotation and quota domains', () => {
  test('invalid credential → another key in the same domain', async () => {
    const t = mockTransport([err(401, '{"error":{"message":"Invalid API Key","code":"invalid_api_key"}}'), ok()]);
    const { m } = mgr(t);
    const r = await m.request({ role: 'answer', datasetId: DS, messages: MSG });
    assert.equal(t.calls.length, 2);
    assert.notEqual(t.calls[0].envName, t.calls[1].envName);
    assert.equal(r.model, 'openai/gpt-oss-120b');
    assert.equal(m.state().keys.find(k => k.envName === t.calls[0].envName).status, 'invalid');
  });
  test('expired authorization token → that key is marked expired; another key serves', async () => {
    const t = mockTransport([err(401, '{"error":{"status":"UNAUTHENTICATED","message":"Request had invalid authentication credentials. ACCESS_TOKEN_EXPIRED"}}'), ok()]);
    const { m } = mgr(t);
    await m.request({ role: 'judge', datasetId: DS, messages: MSG });
    assert.equal(m.state().keys.find(k => k.envName === t.calls[0].envName).status, 'expired');
  });
  test('key-specific restriction → another key', async () => {
    const t = mockTransport([err(403, '{"error":{"status":"PERMISSION_DENIED","message":"API_KEY_SERVICE_BLOCKED"}}'), ok()]);
    const { m } = mgr(t);
    await m.request({ role: 'judge', datasetId: DS, messages: MSG });
    assert.equal(m.state().keys.find(k => k.envName === t.calls[0].envName).status, 'restricted');
  });
  test('shared Gemini PROJECT quota exhausted → ONE request, domain paused — no rotation through the other 12 keys', async () => {
    const t = mockTransport([err(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, per day"}}')]);
    const { m } = mgr(t);
    await assert.rejects(m.request({ role: 'judge', datasetId: DS, messages: MSG }), QuotaPaused);
    assert.equal(t.calls.length, 1);
    assert.equal(m.state().domains.find(d => d.provider === 'gemini').status, 'paused');
  });
  test('shared Groq ORGANISATION quota exhausted → ONE request — no rotation through the other 5 keys', async () => {
    const t = mockTransport([err(429, 'Rate limit reached for model `openai/gpt-oss-120b` on requests per day (RPD): Limit 1000, Used 1000. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing')]);
    const { m } = mgr(t);
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), QuotaPaused);
    assert.equal(t.calls.length, 1);
  });
  test('independent VERIFIED domains: an exhausted org falls back to the other org with the SAME model', async () => {
    const c = cfg();
    c.domains = [
      { id: 'groq-org-1', provider: 'groq', envNames: ['GROQ_API_KEY_1', 'GROQ_API_KEY_2'], verification: ev('ops'), billing: 'free-tier-verified', billingEvidence: ev() },
      { id: 'groq-org-2', provider: 'groq', envNames: ['GROQ_API_KEY_3'], verification: ev('ops'), billing: 'free-tier-verified', billingEvidence: ev() },
      c.domains[1],
    ];
    const t = mockTransport(call => (call.envName === 'GROQ_API_KEY_3' ? ok('from org 2') : err(429, 'Rate limit reached on requests per day (RPD)')));
    const cl = clock();
    const m = createManager({ config: c, env: ENV, transport: t, now: cl.now, sleep: cl.sleep });
    const r = await m.request({ role: 'answer', datasetId: DS, messages: MSG });
    assert.equal(r.text, 'from org 2');
    assert.equal(t.calls.length, 2, 'org 1 tried once (its other key shares the quota), then org 2');
    assert.ok(t.calls.every(x => x.model === 'openai/gpt-oss-120b'));
  });
  test('an unverified domain declaration does not create independence', () => {
    const c = cfg();
    c.domains = [
      { id: 'claimed-1', provider: 'groq', envNames: ['GROQ_API_KEY_1'], billing: 'free-tier-verified', billingEvidence: ev() },   // no verification
      { id: 'claimed-2', provider: 'groq', envNames: ['GROQ_API_KEY_2'], billing: 'free-tier-verified', billingEvidence: ev() },
      c.domains[1],
    ];
    const { domains } = buildDomains(c, ENV);
    assert.equal(domains.filter(d => d.provider === 'groq').length, 1);
  });
});

describe('Retry-After and resume', () => {
  test('temporary 429 with a short Retry-After: wait exactly that long, then retry', async () => {
    const t = mockTransport([err(429, 'Rate limit reached on tokens per minute (TPM)', { 'retry-after': '2' }), ok()]);
    const { m, c } = mgr(t);
    const t0 = c.now();
    await m.request({ role: 'answer', datasetId: DS, messages: MSG });
    assert.equal(c.now() - t0, 2000);
    assert.equal(t.calls.length, 2);
  });
  test('temporary 429 with a long Retry-After and no other domain → paused until then', async () => {
    const t = mockTransport([err(429, 'tokens per minute (TPM)', { 'retry-after': '120' })]);
    const { m, c } = mgr(t);
    const t0 = c.now();
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), e => e instanceof QuotaPaused && e.resumeAt === t0 + 120_000);
  });
  test('resume after the quota resets: the paused domain serves again', async () => {
    let exhausted = true;
    const t = mockTransport(() => (exhausted ? err(429, 'requests per day (RPD)', { 'retry-after': '3600' }) : ok('after reset')));
    const { m, c } = mgr(t);
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), QuotaPaused);
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), QuotaPaused, 'still paused: no request sent');
    assert.equal(t.calls.length, 1);
    c.advance(3_600_001); exhausted = false;
    assert.equal((await m.request({ role: 'answer', datasetId: DS, messages: MSG })).text, 'after reset');
  });
});

describe('no paid fallback, failure classes', () => {
  test('billing / paid tier → STOP: never another key or domain, and every later request refused', async () => {
    const c = cfg();
    c.domains = [
      { id: 'groq-org-1', provider: 'groq', envNames: ['GROQ_API_KEY_1'], verification: ev(), billing: 'free-tier-verified', billingEvidence: ev() },
      { id: 'groq-org-2', provider: 'groq', envNames: ['GROQ_API_KEY_2'], verification: ev(), billing: 'free-tier-verified', billingEvidence: ev() },
      c.domains[1],
    ];
    const t = mockTransport([err(402, '{"error":{"message":"payment required"}}'), ok()]);
    const cl = clock();
    const m = createManager({ config: c, env: ENV, transport: t, now: cl.now, sleep: cl.sleep });
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), BillingStop);
    await assert.rejects(m.request({ role: 'judge', datasetId: DS, messages: MSG }), BillingStop);
    assert.equal(t.calls.length, 1);
  });
  test('a zero free-tier limit means paid-only → billing stop; an ordinary Groq 429 that advertises an upgrade is NOT billing', () => {
    assert.equal(classify(err(429, '{"error":{"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 0"}}')).category, 'billing_required');
    assert.equal(classify(err(429, 'Rate limit reached on requests per day (RPD): Limit 1000, Used 1000. Upgrade to Dev Tier today at https://console.groq.com/settings/billing')).category, 'quota_exhausted');
  });
  test('unknown error → stop for review', async () => {
    const t = mockTransport([err(418, 'teapot'), ok()]);
    const { m } = mgr(t);
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), ReviewRequired);
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), ReviewRequired);
    assert.equal(t.calls.length, 1);
  });
  test('network failure → bounded retry (then success, or give up after 2)', async () => {
    const t1 = mockTransport([new Error('ECONNRESET'), ok()]);
    assert.equal((await mgr(t1).m.request({ role: 'answer', datasetId: DS, messages: MSG })).retries, 1);
    const t2 = mockTransport([new Error('ECONNRESET')]);
    await assert.rejects(mgr(t2).m.request({ role: 'answer', datasetId: DS, messages: MSG }), e => e.name === 'RetriesExhausted');
    assert.equal(t2.calls.length, 3);
  });
  test('413 (oversize prompt; Groq labels it rate_limit_exceeded) is rejected, not treated as quota', async () => {
    const t = mockTransport([err(413, '{"error":{"code":"rate_limit_exceeded","message":"Request too large"}}')]);
    await assert.rejects(mgr(t).m.request({ role: 'answer', datasetId: DS, messages: MSG }), RequestRejected);
    assert.equal(t.calls.length, 1);
  });
  test('a non-synthetic dataset is refused before any request', async () => {
    const t = mockTransport([ok()]);
    await assert.rejects(mgr(t).m.request({ role: 'answer', datasetId: 'real-user-history', messages: MSG }), DataRefused);
    assert.equal(t.calls.length, 0);
  });
  test('the live transport refuses to exist without explicit approval', () => {
    assert.throws(() => liveTransport({ env: {} }), LiveTransportRefused);
  });
});

describe('no secret leakage', () => {
  test('events, state, summary, domains, exclusions and errors never contain a credential value', async () => {
    const t = mockTransport([err(401, 'invalid api key'), err(429, 'tokens per minute', { 'retry-after': '1' }), ok(), err(402, 'payment required')]);
    const { m } = mgr(t);
    await m.request({ role: 'answer', datasetId: DS, messages: MSG });
    let stopErr; try { await m.request({ role: 'answer', datasetId: DS, messages: MSG }); } catch (e) { stopErr = e; }
    const surfaces = [m.events, m.state(), m.summary(), m.domains, m.excluded, stopErr, stopErr?.detail, t.calls.map(c => ({ envName: c.envName }))];
    for (const s of surfaces) { assert.doesNotMatch(JSON.stringify(s) ?? '', /SECRET/); assert.doesNotMatch(inspect(s, { depth: 6 }), /SECRET/); }
    // The events carry only allow-listed fields.
    assert.deepEqual(Object.keys(m.events[0]).sort(), ['at', 'caseId', 'category', 'completionTokens', 'cooldown', 'domain', 'envName', 'model', 'outcome', 'promptTokens', 'provider', 'retry', 'role'].sort());
    assert.match(m.events[0].domain, /^[0-9a-f]{12}$/, 'the quota domain is hashed');
  });
});

describe('A/B pairs: model consistency, persistence, resume', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-pairs-')), 'store.jsonl');
  const CASES = ['c1', 'c2', 'c3'].map(id => ({ caseId: id, datasetId: DS, arms: { A: [{ role: 'user', content: `${id} A` }], B: [{ role: 'user', content: `${id} B` }] }, judge: (arm, ans) => [{ role: 'user', content: `judge ${arm}: ${ans}` }] }));

  test('A and B use the same model and settings; completed work is never requested twice', async () => {
    const store = tmp();
    const t = mockTransport(() => ok('answer'));
    const c = cfg();
    const m = createManager({ config: c, env: ENV, transport: t, ...clock() });
    const r1 = await runPairs({ cases: CASES, manager: m, config: c, storeFile: store });
    assert.equal(r1.status, 'complete');
    const answerCalls = t.calls.filter(x => x.provider === 'groq');
    assert.equal(answerCalls.length, 6);
    assert.ok(answerCalls.every(x => x.model === 'openai/gpt-oss-120b' && JSON.stringify(x.settings) === JSON.stringify(c.models.answer.settings)));
    const judgeCalls = t.calls.filter(x => x.provider === 'gemini');
    assert.equal(judgeCalls.length, 6);
    const recs = fs.readFileSync(store, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(recs.filter(x => x.type === 'judgement').every(x => x.judgeModel === 'gemini/gemini-2.5-flash' && x.answerModel === 'groq/openai/gpt-oss-120b'));
    const before = t.calls.length;
    const r2 = await runPairs({ cases: CASES, manager: m, config: c, storeFile: store });
    assert.equal(t.calls.length, before, 'a re-run sends nothing');
    assert.equal(r2.skipped, 12);
  });

  test('quota exhausted mid-pair → pause; resume later completes only the missing arm with the same model', async () => {
    const store = tmp();
    let n = 0, exhausted = false;
    const t = mockTransport(call => {
      if (call.provider === 'groq') { n++; if (n === 2) exhausted = true; if (exhausted && n >= 2) return err(429, 'requests per day (RPD)', { 'retry-after': '600' }); }
      return ok('a');
    });
    const c = cfg();
    const cl = clock();
    const m = createManager({ config: c, env: ENV, transport: t, now: cl.now, sleep: cl.sleep });
    const r1 = await runPairs({ cases: CASES, manager: m, config: c, storeFile: store });
    assert.equal(r1.status, 'paused');
    assert.equal(r1.pausedAt, 'c1');
    const stored = () => fs.readFileSync(store, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.type === 'answer');
    assert.deepEqual(stored().map(x => `${x.caseId}${x.arm}`), ['c1A'], 'arm A is kept');
    cl.advance(600_001); exhausted = false;
    const r2 = await runPairs({ cases: CASES, manager: m, config: c, storeFile: store });
    assert.equal(r2.status, 'complete');
    const a = stored();
    assert.equal(a.filter(x => x.caseId === 'c1' && x.arm === 'A').length, 1, 'arm A was not regenerated');
    assert.ok(a.every(x => x.model === 'groq/openai/gpt-oss-120b'));
  });

  test('a pair started with one model is never finished with another', async () => {
    const store = tmp();
    const c1 = cfg();
    const m1 = createManager({ config: c1, env: ENV, transport: mockTransport(call => (call.provider === 'groq' && call.messages[0].content.endsWith('B') ? err(429, 'requests per day (RPD)') : ok())), ...clock() });
    await runPairs({ cases: CASES.slice(0, 1), manager: m1, config: c1, storeFile: store });
    const c2 = cfg(); c2.models.answer = { ...c2.models.answer, model: 'openai/gpt-oss-20b' };
    const t2 = mockTransport(() => ok());
    const m2 = createManager({ config: c2, env: ENV, transport: t2, ...clock() });
    const r = await runPairs({ cases: CASES.slice(0, 1), manager: m2, config: c2, storeFile: store });
    assert.deepEqual(r.refused.map(x => x.reason), ['model-mismatch']);
    assert.equal(t2.calls.length, 0);
  });

  test('judge provider exhausted → completed pairs are queued for judging; answering continues', async () => {
    const store = tmp();
    const t = mockTransport(call => (call.provider === 'gemini' ? err(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"per day"}}') : ok()));
    const c = cfg();
    const m = createManager({ config: c, env: ENV, transport: t, ...clock() });
    const r = await runPairs({ cases: CASES, manager: m, config: c, storeFile: store });
    assert.equal(r.status, 'complete-judging-queued');
    assert.equal(r.answered, 6);
    assert.deepEqual(r.judgeQueued, ['c1', 'c2', 'c3']);
    assert.equal(t.calls.filter(x => x.provider === 'gemini').length, 1, 'the exhausted judge project was asked once');
  });
});
