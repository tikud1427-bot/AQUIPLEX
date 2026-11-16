/**
 * Founder-verified Gemini credentials (2026-11-11). The founder personally verified the 12
 * AQ.-prefixed GEMINI_KEY_<n>; they are usable for evaluation ONLY through a recorded
 * credentialVerification in credentialMode 'existing-numbered-pools'. Without the record,
 * or outside that mode, or for an unnumbered name, they stay refused.
 *
 * Synthetic .env mirror (every value carries SECRET); providers mocked or a stubbed fetchImpl;
 * global fetch tripwire (0 requests); the real .env is never read.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { numberedPoolEnv, authorisedNames, liveSetup, runEvaluation, zeroBudgetGate, ZeroBudgetRefused } from '../answer/evalRun.mjs';
import { buildDomains, preflight, PreflightRefused } from '../providers/evalConfig.mjs';
import { createManager, QuotaPaused } from '../providers/providerManager.mjs';
import { mockTransport, liveTransport } from '../providers/transports.mjs';
import { loadCredentials } from '../providers/credentials.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error('network forbidden'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'no network request'); });

const aq = n => `AQ.SECRET${String(n).padStart(2, '0')}${'k'.repeat(44)}`;
const gsk = n => `gsk_SECRET${String(n).padStart(2, '0')}${'z'.repeat(24)}`;
const GEM12 = Array.from({ length: 12 }, (_, i) => `GEMINI_KEY_${i + 1}`);
const GROQ5 = Array.from({ length: 5 }, (_, i) => `GROQ_API_KEY_${i + 1}`);
const ENV_TEXT = [
  'DATABASE_URL=postgres://SECRET', 'GROQ_API_KEY=' + gsk(0), `GEMINI_API_KEY=AIza${'SECRET'.padEnd(35, 'q')}`, 'OPENROUTER_API_KEY=sk-or-SECRET0000000000',
  ...GEM12.map((n, i) => `${n}=${aq(i + 1)}`),
  ...GROQ5.map((n, i) => `${n}=${gsk(i + 1)}`),
].join('\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-founder-gemini-'));
const envFile = path.join(tmp, '.env');
fs.writeFileSync(envFile, ENV_TEXT);
const DS = 'synthetic-dataset-sha';
const ev = { method: 'console', by: 'founder', at: '2026-11-11' };
const RECORD = { by: 'founder', at: '2026-11-11', statement: 'I personally verified all 12 existing Gemini credentials; approved for evaluation.', envNames: GEM12 };
const QWEN = 'qwen/qwen3.8-27b';
const cfg = (over = {}) => ({
  evaluationOnly: true, credentialSource: 'production', allowProductionCredentials: true, credentialMode: 'existing-numbered-pools', productionUsageCheck: { date: new Date().toISOString().slice(0, 10), by: 'founder', method: 'console usage page', remainingDailyTokens: 1000000000 }, tokenBudget: { perRequest: { groq: 1000000, gemini: 1000000 }, run: { groq: 100000000, gemini: 100000000 }, group: { 'unverified:groq': 100000000, 'unverified:gemini': 100000000, 'groq-a': 100000000, 'groq-b': 100000000, 'gemini-proj-a': 100000000, 'gemini-proj-b': 100000000 }, ledgerFile: path.join(os.tmpdir(), `aqua-test-ledger-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`) },
  founderDecision: { by: 'founder', at: '2026-11-11', statement: 'existing numbered pools' },
  credentialVerification: RECORD, allowNonStandard: GEM12,
  syntheticDatasets: [DS], requestBudget: { groq: 4, gemini: 4 }, rateLimits: { groq: { tokensPerMinute: 1000000, minIntervalMs: 0 }, gemini: { tokensPerMinute: 1000000, minIntervalMs: 0 } },
  models: {
    answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 1500 } },
    judge: { provider: 'gemini', model: 'gemini-2.5-flash', settings: { temperature: 0, max_tokens: 1024 } },
  },
  domains: [
    { id: 'groq-org', provider: 'groq', envNames: GROQ5, billing: 'free-tier-verified', billingEvidence: ev },
    { id: 'gemini-project', provider: 'gemini', envNames: GEM12, billing: 'free-tier-verified', billingEvidence: ev },
  ],
  ...over,
});
const POOL = numberedPoolEnv(ENV_TEXT, authorisedNames(cfg()));
const gate = c => () => zeroBudgetGate({ execute: true, config: c, datasetHash: DS, env: { AQUA_ANSWER_EVAL_APPROVED: 'yes' } });
const JUDGE = '{"factual_correctness":2,"grounding":2,"personalization":2,"temporal_accuracy":null,"contradiction_handling":null,"uncertainty":null,"clarification_quality":2,"hallucination":false,"hallucinated_claims":[],"confidence":0.9,"notes":"ok"}';
const ok = call => ({ status: 200, text: call.provider === 'gemini' || call.model === QWEN ? JUDGE : 'answer', usage: { prompt_tokens: 10, completion_tokens: 3 } });
const cases = n => Array.from({ length: n }, (_, i) => ({ caseId: `c${i + 1}`, datasetId: DS, arms: { A: [{ role: 'user', content: `c${i + 1} A` }], H: [{ role: 'user', content: `c${i + 1} H` }] }, judge: (_a, ans) => [{ role: 'user', content: `judge ${ans}` }] }));
const store = () => path.join(tmp, `pairs-${Math.random().toString(36).slice(2)}.jsonl`);
const MSG = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'synthetic' }];

describe('1. authentication compatibility', () => {
  test('the production adapter passes GEMINI_KEY values as apiKey, and the SDK sends an apiKey in the x-goog-api-key header', () => {
    const adapter = fs.readFileSync(path.join(AQUA, 'src/providers/gemini.js'), 'utf8');
    assert.match(adapter, /new GoogleGenAI\(\{\s*apiKey:\s*key\s*\}\)/, 'production adapter: API-key auth');
    const sdk = fs.readFileSync(path.join(AQUA, 'node_modules/@google/genai/dist/node/index.mjs'), 'utf8');
    assert.match(sdk, /const GOOGLE_API_KEY_HEADER = 'x-goog-api-key';/);
    assert.match(sdk, /headers\.append\(GOOGLE_API_KEY_HEADER, this\.apiKey\)/, 'NodeAuth adds the key as x-goog-api-key');
    // Only 'auth_tokens/…' (ephemeral, live API) is treated differently — an AQ. value is not one.
    assert.match(sdk, /this\.apiKey\.startsWith\('auth_tokens\/'\)/);
    assert.equal(aq(1).startsWith('auth_tokens/'), false);
  });
  test('the evaluation transport sends an AQ. credential the same way: x-goog-api-key, generateContent, never in the URL', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }), { status: 200 }); };
    const t = liveTransport({ env: { AQUA_EVAL_LIVE_APPROVED: 'yes' }, fetchImpl });
    const credential = loadCredentials('gemini', { GEMINI_KEY_7: aq(7) }).usable[0];
    const r = await t({ provider: 'gemini', model: 'gemini-2.5-flash', credential, messages: MSG, settings: { temperature: 0, max_tokens: 64 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(seen[0].init.headers['x-goog-api-key'], aq(7));
    assert.equal('Authorization' in seen[0].init.headers, false, 'not sent as a Bearer token');
    assert.doesNotMatch(seen[0].url, /SECRET|key=/);
    assert.doesNotMatch(seen[0].init.body, /SECRET/);
    assert.equal(r.text, 'hi');
    assert.doesNotMatch(JSON.stringify(r), /SECRET/);
  });
});

describe('2. founder verification record', () => {
  test('with the record, all 12 AQ. Gemini credentials are accepted; the unnumbered key is still excluded', () => {
    const { domains, excluded } = buildDomains(cfg(), { ...POOL, GEMINI_API_KEY: `AIza${'SECRET'.padEnd(35, 'q')}` });
    const gem = domains.filter(d => d.provider === 'gemini').flatMap(d => d.credentials.map(c => c.envName));
    assert.deepEqual(gem, GEM12);
    assert.deepEqual(excluded.map(e => `${e.envName}:${e.reason}`), ['GEMINI_API_KEY:unnumbered-excluded']);
    assert.doesNotThrow(gate(cfg()));
    assert.doesNotThrow(() => preflight(cfg(), POOL));
  });
  test('the manager receives exactly the 12 Gemini + 5 Groq numbered names — nothing unnumbered, nothing else', () => {
    assert.deepEqual(Object.keys(POOL).sort(), [...GEM12, ...GROQ5].sort());
    const s = liveSetup({ configFile: (fs.writeFileSync(path.join(tmp, 'c.json'), JSON.stringify(cfg())), path.join(tmp, 'c.json')), datasetHash: DS, env: { AQUA_ANSWER_EVAL_APPROVED: 'yes', AQUA_EVAL_LIVE_APPROVED: 'yes' }, repoEnvPath: envFile });
    assert.deepEqual(Object.keys(s.env).sort(), [...GEM12, ...GROQ5].sort());
  });
  test('WITHOUT the record, opting in is refused by the gate and by the preflight, and the values are excluded', () => {
    const c = cfg({ credentialVerification: undefined });
    assert.throws(gate(c), e => e instanceof ZeroBudgetRefused && /not covered by credentialVerification/.test(e.message));
    assert.throws(() => preflight(c, POOL), e => e instanceof PreflightRefused && /not covered by credentialVerification/.test(e.message));
    const { domains, excluded } = buildDomains(c, POOL);
    assert.equal(excluded.filter(e => e.reason === 'non-standard-not-covered-by-verification').length, 12);
    assert.equal(domains.filter(d => d.provider === 'gemini').length, 0);
  });
  test('an incomplete record (no statement / bad date / no envNames) counts as no record', () => {
    for (const bad of [{ ...RECORD, statement: '' }, { ...RECORD, at: 'yesterday' }, { ...RECORD, envNames: undefined }, { ...RECORD, by: '' }]) {
      assert.throws(gate(cfg({ credentialVerification: bad })), ZeroBudgetRefused);
    }
  });
  test('a partial record covers only the names it lists', () => {
    const c = cfg({ credentialVerification: { ...RECORD, envNames: ['GEMINI_KEY_1', 'GEMINI_KEY_2'] } });
    assert.throws(gate(c), /GEMINI_KEY_3, GEMINI_KEY_4/);
    const { domains } = buildDomains(c, POOL);
    assert.deepEqual(domains.filter(d => d.provider === 'gemini').flatMap(d => d.credentials.map(x => x.envName)), ['GEMINI_KEY_1', 'GEMINI_KEY_2']);
  });
  test('the record does not opt anything in by itself: with allowNonStandard empty, the AQ. values stay excluded', () => {
    const { domains } = buildDomains(cfg({ allowNonStandard: [] }), POOL);
    assert.equal(domains.filter(d => d.provider === 'gemini').length, 0);
  });
  test('the record cannot cover unnumbered or non-Gemini names', () => {
    const c = cfg({ allowNonStandard: ['GEMINI_API_KEY', 'GROQ_API_KEY_1'], credentialVerification: { ...RECORD, envNames: ['GEMINI_API_KEY', 'GROQ_API_KEY_1'] } });
    assert.throws(gate(c), /GEMINI_API_KEY, GROQ_API_KEY_1 not covered/);
  });
  test('outside existing-numbered-pools mode, the record is ignored and opt-in is refused', () => {
    const c = cfg({ credentialMode: undefined, credentialSource: 'evaluation', allowProductionCredentials: false });
    assert.throws(() => zeroBudgetGate({ execute: true, config: c, credentialsFile: path.join(os.tmpdir(), 'e.env'), datasetHash: DS, env: { AQUA_ANSWER_EVAL_APPROVED: 'yes' } }), /are never used outside credentialMode 'existing-numbered-pools'/);
  });
  test('a Gemini role needs its own requestBudget.gemini', () => {
    assert.throws(() => preflight(cfg({ requestBudget: { groq: 4 } }), POOL), /requestBudget\.gemini/);
  });
});

describe('3. account-aware quota grouping', () => {
  test('without verified grouping, all 12 Gemini keys are ONE quota group and all 5 Groq keys ONE group', () => {
    const { domains } = buildDomains(cfg(), POOL);
    const by = p => domains.filter(d => d.provider === p);
    assert.equal(by('gemini').length, 1); assert.equal(by('gemini')[0].verified, false); assert.equal(by('gemini')[0].credentials.length, 12);
    assert.equal(by('groq').length, 1); assert.equal(by('groq')[0].credentials.length, 5);
    assert.equal(by('gemini')[0].billing, 'free-tier-verified');
  });
  test('shared Gemini quota exhaustion pauses the group after ONE request — no rotation through the other 11 keys', async () => {
    const t = mockTransport(() => ({ status: 429, bodyText: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for metric generate_content_free_tier_requests, limit: 250, PerDay"}}' }));
    const m = createManager({ config: cfg({ models: { answer: cfg().models.judge, judge: cfg().models.answer } }), env: POOL, transport: t });
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), QuotaPaused);
    assert.equal(t.calls.length, 1);
  });
  test('verified separate projects are separate groups: one exhausted project → the next project serves', async () => {
    const two = cfg({ keyRotation: true, waitOnRateLimit: true,
      models: { answer: cfg().models.judge, judge: cfg().models.answer },
      domains: [
        cfg().domains[0],
        { id: 'gemini-proj-a', provider: 'gemini', envNames: GEM12.slice(0, 6), verification: ev, billing: 'free-tier-verified', billingEvidence: ev },
        { id: 'gemini-proj-b', provider: 'gemini', envNames: GEM12.slice(6), verification: ev, billing: 'free-tier-verified', billingEvidence: ev },
      ],
    });
    assert.deepEqual(buildDomains(two, POOL).domains.filter(d => d.provider === 'gemini').map(d => d.credentials.length), [6, 6]);
    let n = 0;
    const t = mockTransport(() => (n++ === 0 ? { status: 429, bodyText: 'Quota exceeded ... PerDay' } : { status: 200, text: 'ok', usage: {} }));
    const r = await createManager({ config: two, env: POOL, transport: t }).request({ role: 'answer', datasetId: DS, messages: MSG });
    assert.equal(r.text, 'ok');
    assert.equal(t.calls.length, 2);
    assert.ok(GEM12.slice(0, 6).includes(t.calls[0].envName) && GEM12.slice(6).includes(t.calls[1].envName), 'second request went to the OTHER project');
  });
  test('a billing signal on a Gemini key stops the run after 1 request (no paid fallback, no other provider)', async () => {
    const t = mockTransport(() => ({ status: 429, bodyText: 'Quota exceeded for metric generate_content_free_tier_requests, limit: 0' }));
    const r = await runEvaluation({ setup: { env: POOL, config: cfg({ models: { answer: cfg().models.judge, judge: cfg().models.answer } }), transport: t }, cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r.status, 'stopped-billing');
    assert.equal(t.calls.length, 1);
    assert.ok(t.calls.every(c => c.provider === 'gemini'));
  });
});

describe('4. models, caps and the A/B lock', () => {
  test('Groq gpt-oss-120b answers + Gemini judge: one pair = 2 Groq + 2 Gemini requests; per-provider caps pause without an extra request', async () => {
    const t = mockTransport(ok);
    const r = await runEvaluation({ setup: { env: POOL, config: cfg({ requestBudget: { groq: 2, gemini: 2 } }), transport: t }, cases: cases(2), storeFile: store(), arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r.status, 'paused');
    assert.deepEqual(t.calls.map(c => `${c.provider}/${c.model}`), ['groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-120b', 'gemini/gemini-2.5-flash', 'gemini/gemini-2.5-flash']);
  });
  test('Groq Qwen judge (initial candidate) is accepted by config only; it shares the Groq cap', async () => {
    const t = mockTransport(ok);
    const c = cfg({ requestBudget: { groq: 4 }, allowNonStandard: [], credentialVerification: undefined, models: { ...cfg().models, judge: { provider: 'groq', model: QWEN, settings: { temperature: 0, max_tokens: 1024 } } } });
    const r = await runEvaluation({ setup: { env: POOL, config: c, transport: t }, cases: cases(2), storeFile: store(), arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(t.calls.length, 4);
    assert.equal(r.status, 'paused');
    assert.deepEqual([...new Set(t.calls.map(x => x.model))], ['openai/gpt-oss-120b', QWEN]);
  });
  test('both arms use the same answering model and settings, and the stored pair carries no credential', async () => {
    const t = mockTransport(ok);
    const sf = store();
    await runEvaluation({ setup: { env: POOL, config: cfg(), transport: t }, cases: cases(1), storeFile: sf, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    const answers = t.calls.filter(c => c.provider === 'groq');
    assert.equal(answers.length, 2);
    assert.equal(new Set(answers.map(c => `${c.model}|${JSON.stringify(c.settings)}`)).size, 1);
    const text = fs.readFileSync(sf, 'utf8');
    const recs = text.trim().split('\n').map(l => JSON.parse(l)).filter(x => x.type === 'answer');
    assert.equal(new Set(recs.map(x => `${x.model}|${x.settingsHash}`)).size, 1);
    assert.doesNotMatch(text, /SECRET/);
  });
});
