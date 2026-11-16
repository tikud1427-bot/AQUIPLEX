/**
 * Existing numbered key pools for evaluation (founder decision 2026-11-11).
 * Synthetic environment that MIRRORS the real .env layout (names, kinds of value),
 * never its values: 12 AQ.-prefixed GEMINI_KEY_<n>, a bare GEMINI_API_KEY, five
 * standard GROQ_API_KEY_<n>, a bare GROQ_API_KEY, plus blanks, malformed values and
 * unrelated secrets. Every value carries the marker SECRET. All providers mocked;
 * a global fetch tripwire proves no network request. The real .env is never read.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { numberedPoolEnv, zeroBudgetGate, liveSetup, runEvaluation, ZeroBudgetRefused } from '../answer/evalRun.mjs';
import { preflight, buildDomains, PreflightRefused } from '../providers/evalConfig.mjs';
import { createManager, QuotaPaused, BillingStop } from '../providers/providerManager.mjs';
import { loadCredentials } from '../providers/credentials.mjs';
import { mockTransport, LiveTransportRefused } from '../providers/transports.mjs';

let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error('network forbidden'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'no network request'); });

const aq = n => `AQ.SECRET${String(n).padStart(2, '0')}${'x'.repeat(40)}`;
const gsk = n => `gsk_SECRET${String(n).padStart(2, '0')}${'g'.repeat(24)}`;
const ENV_TEXT = [
  '# AQUIPLEX — production env (synthetic mirror for tests)',
  'DATABASE_URL=postgres://SECRET-db', 'SESSION_SECRET=SECRET-session', 'MONGO_URI=mongodb://SECRET-mongo',
  'GROQ_API_KEY=' + gsk(0), `GEMINI_API_KEY=AIza${'SECRET'.padEnd(35, 'b')}`, 'OPENROUTER_API_KEY=sk-or-SECRET0000000000',
  ...Array.from({ length: 12 }, (_, i) => `GEMINI_KEY_${i + 1}=${aq(i + 1)}`),
  'GEMINI_KEY_13=',
  ...Array.from({ length: 5 }, (_, i) => `GROQ_API_KEY_${i + 1}=${gsk(i + 1)}`),
  'GROQ_API_KEY_6=your_api_key_here', 'GROQ_API_KEY_7=gsk_SECRET with an internal space', 'OPENROUTER_API_KEY_1=sk-or-SECRET1111111111',
].join('\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-existing-pool-'));
const envFile = path.join(tmp, '.env');
fs.writeFileSync(envFile, ENV_TEXT);
const POOL = numberedPoolEnv(ENV_TEXT);
const DS = 'synthetic-dataset-sha';
const ev = { method: 'console', by: 'founder', at: '2026-11-11' };
const cfg = (over = {}) => ({
  evaluationOnly: true, credentialSource: 'production', allowProductionCredentials: true, credentialMode: 'existing-numbered-pools', productionUsageCheck: { date: new Date().toISOString().slice(0, 10), by: 'founder', method: 'console usage page', remainingDailyTokens: 1000000000 }, tokenBudget: { perRequest: { groq: 1000000, gemini: 1000000 }, run: { groq: 100000000, gemini: 100000000 }, group: { 'unverified:groq': 100000000, 'unverified:gemini': 100000000, 'groq-a': 100000000, 'groq-b': 100000000, 'gemini-proj-a': 100000000, 'gemini-proj-b': 100000000 }, ledgerFile: path.join(os.tmpdir(), `aqua-test-ledger-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`) },
  founderDecision: { by: 'founder', at: '2026-11-11', statement: 'Use the existing numbered key pools for evaluation; do not create new keys.' },
  allowNonStandard: [], syntheticDatasets: [DS], requestBudget: { groq: 50 }, rateLimits: { groq: { tokensPerMinute: 1000000, minIntervalMs: 0 }, gemini: { tokensPerMinute: 1000000, minIntervalMs: 0 } },
  models: { answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 1500 } }, judge: { provider: 'groq', model: 'judge-model-different-from-answer', settings: { temperature: 0, max_tokens: 1024 } } },
  domains: [{ id: 'groq-unverified-billing-checked', provider: 'groq', envNames: ['GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4', 'GROQ_API_KEY_5'], billing: 'free-tier-verified', billingEvidence: ev }],
  ...over,
});
const ok = t => ({ status: 200, text: t, usage: { prompt_tokens: 10, completion_tokens: 3 } });
const MSG = [{ role: 'user', content: 'synthetic' }];

describe('reading the existing environment', () => {
  test('only GEMINI_KEY_<n> and GROQ_API_KEY_<n> leave the .env text — no unnumbered key, database URL or other secret', () => {
    assert.deepEqual(Object.keys(POOL).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      [...Array.from({ length: 13 }, (_, i) => `GEMINI_KEY_${i + 1}`), ...Array.from({ length: 7 }, (_, i) => `GROQ_API_KEY_${i + 1}`)]);
    for (const k of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'DATABASE_URL', 'SESSION_SECRET', 'MONGO_URI', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_1']) assert.equal(k in POOL, false, k);
  });
  test('all numbered names are recognised, in numeric order (10, 11, 12 after 9)', () => {
    assert.deepEqual(loadCredentials('gemini', POOL).usable.map(c => c.envName), Array.from({ length: 12 }, (_, i) => `GEMINI_KEY_${i + 1}`));
    assert.deepEqual(loadCredentials('groq', POOL).usable.map(c => c.envName), ['GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4', 'GROQ_API_KEY_5']);
  });
  test('missing and malformed keys are filtered with a reason, never a value', () => {
    const ex = [...loadCredentials('gemini', POOL).excluded, ...loadCredentials('groq', POOL).excluded];
    assert.deepEqual(ex.map(e => `${e.envName}:${e.reason}`).sort(), ['GEMINI_KEY_13:malformed:blank', 'GROQ_API_KEY_6:malformed:placeholder', 'GROQ_API_KEY_7:malformed:contains-whitespace'].sort());
    assert.doesNotMatch(JSON.stringify(ex), /SECRET/);
  });
});

describe('exclusions', () => {
  test('without opt-in and a recorded founder verification, every AQ.-prefixed Gemini value is excluded', () => {
    const { domains, excluded } = buildDomains(cfg(), POOL);
    assert.equal(excluded.filter(e => e.reason === 'non-standard-format-not-opted-in').length, 12);
    assert.equal(domains.filter(d => d.provider === 'gemini').length, 0);
  });
  test('the AQ. values cannot be opted in WITHOUT a recorded credentialVerification (integration gate)', () => {
    assert.throws(() => zeroBudgetGate({ execute: true, config: cfg({ allowNonStandard: ['GEMINI_KEY_1'] }), datasetHash: DS, env: { AQUA_ANSWER_EVAL_APPROVED: 'yes' } }), /never used for evaluation/);
  });
  test('a Gemini judge is refused when no Gemini credential is verified and opted in', () => {
    const c = cfg({ models: { ...cfg().models, judge: { provider: 'gemini', model: 'gemini-2.5-flash' } }, requestBudget: { groq: 50, gemini: 10 } });
    assert.throws(() => preflight(c, POOL), /no gemini quota domain/);
  });
  test('unnumbered production keys are excluded even when present', () => {
    const withBare = { ...POOL, GROQ_API_KEY: gsk(0), GEMINI_API_KEY: `AIza${'SECRET'.padEnd(35, 'b')}` };
    const { domains, excluded } = buildDomains(cfg(), withBare);
    assert.deepEqual(excluded.filter(e => e.reason === 'unnumbered-excluded').map(e => e.envName).sort(), ['GEMINI_API_KEY', 'GROQ_API_KEY']);
    assert.ok(!domains.some(d => d.credentials.some(c => c.slot === '#bare')));
  });
  test('no unnumbered fallback: with every numbered key invalid, the bare key is never tried', async () => {
    const withBare = { ...POOL, GROQ_API_KEY: gsk(0) };
    const t = mockTransport(() => ({ status: 401, bodyText: 'invalid api key' }));
    const m = createManager({ config: cfg({ keyRotation: true }), env: withBare, transport: t, sleep: async () => {} });
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), QuotaPaused);
    // Each numbered key tried at most once (round-robin order over a shrinking healthy list); the bare key never.
    assert.deepEqual(t.calls.map(c => c.envName).sort(), ['GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4', 'GROQ_API_KEY_5']);
  });
});

describe('quota groups', () => {
  test('without verified grouping, the five Groq keys are ONE quota group', () => {
    const { domains } = buildDomains(cfg(), POOL);
    const groq = domains.filter(d => d.provider === 'groq');
    assert.equal(groq.length, 1);
    assert.equal(groq[0].verified, false);
    assert.equal(groq[0].credentials.length, 5);
  });
  test('shared quota exhaustion pauses after ONE request — no rotation through the other four keys', async () => {
    const t = mockTransport(() => ({ status: 429, bodyText: 'Rate limit reached on requests per day (RPD). Upgrade to Dev Tier at https://console.groq.com/settings/billing', headers: { 'retry-after': '3600' } }));
    const m = createManager({ config: cfg(), env: POOL, transport: t });
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), QuotaPaused);
    assert.equal(t.calls.length, 1);
  });
  test('an invalid individual credential is skipped safely; the next numbered key serves', async () => {
    const t = mockTransport(call => (call.envName === 'GROQ_API_KEY_1' ? { status: 401, bodyText: 'invalid api key' } : ok('fine')));
    const m = createManager({ config: cfg({ keyRotation: true }), env: POOL, transport: t });
    const r = await m.request({ role: 'answer', datasetId: DS, messages: MSG });
    assert.match(r.envName, /^GROQ_API_KEY_[2-5]$/, 'another numbered key serves');
    assert.equal(t.calls.length, 2);
    assert.equal(m.state().keys.find(k => k.envName === 'GROQ_API_KEY_1').status, 'invalid');
  });
});

describe('zero cost and production protection', () => {
  test('billing → stop; no other key, no other provider', async () => {
    const t = mockTransport(() => ({ status: 402, bodyText: 'payment required' }));
    const m = createManager({ config: cfg(), env: POOL, transport: t });
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), BillingStop);
    assert.equal(t.calls.length, 1);
  });
  test('unknown billing → refused before any request (a valid key is not proof of free quota)', () => {
    assert.throws(() => preflight(cfg({ domains: [{ ...cfg().domains[0], billing: 'unknown' }] }), POOL), PreflightRefused);
  });
  test('production pools need the recorded founder decision, the mode, and a per-run request budget', () => {
    assert.throws(() => preflight(cfg({ founderDecision: undefined }), POOL), /founderDecision/);
    assert.throws(() => preflight(cfg({ credentialMode: undefined }), POOL), /existing-numbered-pools/);
    assert.throws(() => preflight(cfg({ requestBudget: {} }), POOL), /requestBudget\.groq/);
  });
  test('the per-run request budget pauses the run (protecting production quota); retries count', async () => {
    const t = mockTransport(() => ok('a'));
    const m = createManager({ config: cfg({ requestBudget: { groq: 3 } }), env: POOL, transport: t });
    for (let i = 0; i < 3; i++) await m.request({ role: 'answer', datasetId: DS, messages: MSG });
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), e => e instanceof QuotaPaused && e.detail.reason === 'run-request-budget');
    assert.equal(t.calls.length, 3);
    const t2 = mockTransport([new Error('ECONNRESET'), new Error('ECONNRESET'), ok('late')]);
    const m2 = createManager({ config: cfg({ requestBudget: { groq: 2 } }), env: POOL, transport: t2, sleep: async () => {} });
    await assert.rejects(m2.request({ role: 'answer', datasetId: DS, messages: MSG }), QuotaPaused);
    assert.equal(t2.calls.length, 2, 'the third (retry) attempt would exceed the budget');
  });
  test('integration gate: the mode refuses a separate credentials file, and still refuses non-synthetic data and in-repo config', () => {
    const env = { AQUA_ANSWER_EVAL_APPROVED: 'yes' };
    assert.throws(() => zeroBudgetGate({ execute: true, config: cfg(), credentialsFile: path.join(tmp, 'other.env'), datasetHash: DS, env }), /not used with credentialMode/);
    assert.throws(() => zeroBudgetGate({ execute: true, config: cfg({ founderDecision: { by: 'x' } }), datasetHash: DS, env }), /founderDecision/);
    assert.throws(() => zeroBudgetGate({ execute: true, config: cfg({ syntheticDatasets: ['x'] }), datasetHash: DS, env }), /syntheticDatasets/);
    assert.throws(() => zeroBudgetGate({ execute: true, config: cfg(), configFile: path.join(path.resolve(import.meta.dirname, '../..'), 'cfg.json'), datasetHash: DS, env }), /inside the repository/);
    assert.doesNotThrow(() => zeroBudgetGate({ execute: true, config: cfg(), datasetHash: DS, env }));
  });
  test('liveSetup in this mode reads only the numbered variables, then still needs the live switch', () => {
    const cfgFile = path.join(tmp, 'cfg.json');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg()));
    assert.throws(() => liveSetup({ configFile: cfgFile, datasetHash: DS, env: { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, repoEnvPath: envFile }), LiveTransportRefused);
  });
});

describe('A/B consistency, resumability, no leakage', () => {
  test('both arms on the same model and settings; a resume sends nothing; no credential in records', async () => {
    const store = path.join(tmp, `pairs-${Date.now()}.jsonl`);
    const t = mockTransport(call => ok(call.model === 'judge-model-different-from-answer' ? '{"factual_correctness":2,"grounding":2,"personalization":2,"temporal_accuracy":null,"contradiction_handling":null,"uncertainty":null,"clarification_quality":2,"hallucination":false,"hallucinated_claims":[],"confidence":0.9,"notes":"ok"}' : 'answer'));
    const cases = ['c1', 'c2'].map(id => ({ caseId: id, datasetId: DS, arms: { A: [{ role: 'user', content: `${id} A` }], H: [{ role: 'user', content: `${id} H` }] }, judge: (_a, ans) => [{ role: 'user', content: `judge ${ans}` }] }));
    const setup = { env: POOL, config: cfg(), transport: t };
    const r = await runEvaluation({ setup, cases, storeFile: store, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r.status, 'complete');
    const answers = t.calls.filter(c => c.model === 'openai/gpt-oss-120b');
    assert.equal(answers.length, 4);
    assert.ok(answers.every(c => JSON.stringify(c.settings) === JSON.stringify(cfg().models.answer.settings)));
    assert.ok(t.calls.every(c => /^GROQ_API_KEY_[1-5]$/.test(c.envName)), 'numbered Groq keys only');
    const n = t.calls.length;
    await runEvaluation({ setup, cases, storeFile: store, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(t.calls.length, n, 'resume: nothing re-requested');
    for (const s of [fs.readFileSync(store, 'utf8'), JSON.stringify(r)]) assert.doesNotMatch(s, /SECRET/);
  });
});

describe('production provider behaviour is unchanged', () => {
  test('the production key pool still discovers numbered AND unnumbered slots exactly as before (evaluation filtering does not touch it)', () => {
    const require = createRequire(import.meta.url);
    const keyPool = require('../../src/providers/keyPool.cjs');
    const fullEnv = Object.fromEntries(ENV_TEXT.split('\n').filter(l => /^[A-Z]/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const groq = keyPool.discoverKeySlots('groq', fullEnv);
    assert.ok(groq.slots.some(s => s.slot === '#bare'), 'production still uses the bare GROQ_API_KEY');
    assert.ok(groq.slots.some(s => s.slot === '#5'));
    const gem = keyPool.discoverKeySlots('gemini', fullEnv);
    assert.equal(gem.slots.filter(s => /^#\d+$/.test(s.slot)).length, 12, 'production still sees the 12 numbered Gemini slots');
  });
});
