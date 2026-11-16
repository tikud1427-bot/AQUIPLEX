/**
 * Evaluation readiness (2026-11-11): approval-switch safety, live request formats,
 * response parsing, and a one-case smoke REHEARSAL through the live code path —
 * with the network replaced by a stub (`fetchImpl`). No live call is possible:
 * a global fetch tripwire counts any real request (asserted 0), and every
 * credential below is synthetic and carries the marker SECRET.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zeroBudgetGate, liveSetup, runEvaluation, acibCases, productionDataGuard, insideRepo, ZeroBudgetRefused, REPO_ROOT } from '../answer/evalRun.mjs';
import { PreflightRefused } from '../providers/evalConfig.mjs';
import { liveTransport, LiveTransportRefused } from '../providers/transports.mjs';
import { createManager, ReviewRequired, DataRefused } from '../providers/providerManager.mjs';
import { loadCredentials } from '../providers/credentials.mjs';
import { classify } from '../providers/errorTaxonomy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
let realFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { realFetches++; throw new Error('network forbidden'); };
after(() => { globalThis.fetch = realFetch; assert.equal(realFetches, 0, 'no real network request was made'); });

const BOTH = { AQUA_ANSWER_EVAL_APPROVED: 'yes', AQUA_EVAL_LIVE_APPROVED: 'yes' };
const DEV_RAW = fs.readFileSync(path.join(AQUA, 'eval/datasets/acib.v2.dev.json'), 'utf8');
const DEV_HASH = fs.readFileSync(path.join(AQUA, 'eval/datasets/acib.v2.dev.FROZEN.sha256'), 'utf8').trim().split(/\s+/)[0];
const DEV = JSON.parse(DEV_RAW);
const ev = { method: 'console', by: 'reviewer', at: '2026-11-11' };
const GROQ_KEY = `gsk_SECRET${'Q'.repeat(24)}`;
const GEMINI_KEY = `AIza${'SECRET'.padEnd(35, 'g')}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-readiness-'));
const credFile = path.join(tmp, 'eval.env');
fs.writeFileSync(credFile, `GROQ_API_KEY_1=${GROQ_KEY}\nGEMINI_API_KEY=${GEMINI_KEY}\n`);
const config = (over = {}) => ({
  evaluationOnly: true, credentialSource: 'evaluation', allowProductionCredentials: false, allowNonStandard: [], syntheticDatasets: [DEV_HASH],
  models: { answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 700 } }, judge: { provider: 'gemini', model: 'gemini-2.5-flash', settings: { temperature: 0, max_tokens: 400 } } },
  domains: [
    { id: 'groq-org', provider: 'groq', envNames: ['GROQ_API_KEY_1'], verification: ev, billing: 'free-tier-verified', billingEvidence: ev },
    { id: 'gemini-project', provider: 'gemini', envNames: ['GEMINI_API_KEY'], verification: ev, billing: 'free-tier-verified', billingEvidence: ev },
  ],
  ...over,
});
const cfgFile = c => { const f = path.join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(c)); return f; };

// ── A fetch stub that speaks both providers' documented shapes ─────────────────
const JUDGE_JSON = JSON.stringify({ factual_correctness: 2, grounding: 2, personalization: 2, temporal_accuracy: null, contradiction_handling: null, uncertainty: null, clarification_quality: 2, hallucination: false, hallucinated_claims: [], confidence: 0.9, notes: 'ok' });
function providerStub(behaviour = {}) {
  const requests = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    const req = { url: u.href, host: u.hostname, path: u.pathname, method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) };
    requests.push(req);
    const custom = behaviour[u.hostname]?.(req, requests);
    if (custom) return custom;
    if (u.hostname === 'api.groq.com') return new Response(JSON.stringify({ model: req.body.model, choices: [{ message: { role: 'assistant', content: 'An answer from the synthetic history.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'generativelanguage.googleapis.com') return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JUDGE_JSON.slice(0, 40) }, { text: JUDGE_JSON.slice(40) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
  fn.requests = requests;
  return fn;
}
const redact = x => JSON.stringify(x).replaceAll(GROQ_KEY, '<groq>').replaceAll(GEMINI_KEY, '<gemini>');

describe('1. approval switches cannot override any protection (both switches = yes)', () => {
  const gate = (over, extra = {}) => () => zeroBudgetGate({ execute: true, config: config(over), credentialsFile: credFile, datasetHash: DEV_HASH, env: BOTH, ...extra });
  test('production credentials are still refused', () => {
    assert.throws(gate({ credentialSource: 'production' }), ZeroBudgetRefused);
    assert.throws(gate({ allowProductionCredentials: true }), ZeroBudgetRefused);
  });
  test('AQ./non-standard credentials are refused outside existing-numbered-pools mode', () => assert.throws(gate({ allowNonStandard: ['GEMINI_KEY_1'] }), ZeroBudgetRefused));
  test('non-synthetic data is still refused', () => assert.throws(gate({ syntheticDatasets: ['not-this-dataset'] }), /syntheticDatasets/));
  test('credential and config paths inside the repository are still refused — including via a junction/symlink and a different letter case', () => {
    assert.throws(gate({}, { credentialsFile: path.join(REPO_ROOT, '.env') }), ZeroBudgetRefused);
    assert.throws(gate({}, { credentialsFile: path.join(REPO_ROOT, 'aqua', 'eval.env') }), /inside the repository/);
    assert.throws(gate({}, { configFile: path.join(REPO_ROOT, 'aqua', 'cfg.json') }), /provider config must not be inside the repository/);
    const link = path.join(tmp, `link-${Date.now()}`);
    fs.symlinkSync(path.join(REPO_ROOT, 'aqua'), link, 'junction');
    try {
      assert.equal(insideRepo(path.join(link, 'eval.env')), true, 'a junction into the repository is resolved');
      assert.throws(gate({}, { credentialsFile: path.join(link, 'eval.env') }), /inside the repository/);
    } finally { fs.unlinkSync(link); }
    if (process.platform === 'win32') assert.equal(insideRepo(path.join(REPO_ROOT.toUpperCase(), 'aqua', 'x.env')), true, 'case-insensitive on Windows');
  });
  test('free-tier verification is still mandatory: unknown billing / missing evidence / paid → refused before a live transport exists', () => {
    for (const domains of [
      config().domains.map(d => ({ ...d, billing: 'unknown' })),
      config().domains.map(d => ({ ...d, billingEvidence: undefined })),
      config().domains.map(d => ({ ...d, billing: 'paid' })),
    ]) {
      assert.throws(() => liveSetup({ configFile: cfgFile(config({ domains })), credentialsFile: credFile, datasetHash: DEV_HASH, env: BOTH }), PreflightRefused);
    }
  });
  test('the switches are exact: YES / true / 1 / " yes" do not approve', () => {
    for (const v of ['YES', 'true', '1', ' yes', 'yes ']) {
      assert.throws(gate({}, { env: { ...BOTH, AQUA_ANSWER_EVAL_APPROVED: v } }), /AQUA_ANSWER_EVAL_APPROVED/);
      assert.throws(() => liveTransport({ env: { AQUA_EVAL_LIVE_APPROVED: v } }), LiveTransportRefused);
    }
  });
  test('switches are read only from the process environment — not from the config or the credentials file', () => {
    assert.throws(() => zeroBudgetGate({ execute: true, config: { ...config(), AQUA_ANSWER_EVAL_APPROVED: 'yes', approved: true }, credentialsFile: credFile, datasetHash: DEV_HASH, env: {} }), /AQUA_ANSWER_EVAL_APPROVED/);
    const sneaky = path.join(tmp, 'sneaky.env');
    fs.writeFileSync(sneaky, `GROQ_API_KEY_1=${GROQ_KEY}\nGEMINI_API_KEY=${GEMINI_KEY}\nAQUA_EVAL_LIVE_APPROVED=yes\nAQUA_ANSWER_EVAL_APPROVED=yes\n`);
    assert.throws(() => liveSetup({ configFile: cfgFile(config()), credentialsFile: sneaky, datasetHash: DEV_HASH, env: { AQUA_ANSWER_EVAL_APPROVED: 'yes' } }), LiveTransportRefused);
  });
  test('quota exhaustion, billing stop and the synthetic-data check hold with both switches set (the manager never reads them)', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, BOTH);
    try {
      const stub = providerStub({ 'api.groq.com': () => new Response(JSON.stringify({ error: { message: 'Rate limit reached for model on requests per day (RPD): Limit 1000, Used 1000. Upgrade to Dev Tier today at https://console.groq.com/settings/billing', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after': '3600' } }) });
      const setup = { env: { GROQ_API_KEY_1: GROQ_KEY, GEMINI_API_KEY: GEMINI_KEY }, config: config(), transport: liveTransport({ env: BOTH, fetchImpl: stub }) };
      const cases = [{ caseId: 'q1', datasetId: DEV_HASH, arms: { A: [{ role: 'user', content: 'a' }], H: [{ role: 'user', content: 'h' }] }, judge: () => [{ role: 'user', content: 'j' }] }];
      const r = await runEvaluation({ setup, cases, storeFile: path.join(tmp, `q-${Date.now()}.jsonl`), arms: ['A', 'H'], phases: ['answer', 'judge'] });
      assert.equal(r.status, 'paused', 'quota exhaustion pauses');
      assert.equal(stub.requests.filter(x => x.host === 'api.groq.com').length, 1);
      assert.equal(stub.requests.filter(x => x.host !== 'api.groq.com').length, 0, 'no other provider was used for answering');

      const billing = providerStub({ 'api.groq.com': () => new Response('{"error":{"message":"payment required"}}', { status: 402 }) });
      const r2 = await runEvaluation({ setup: { ...setup, transport: liveTransport({ env: BOTH, fetchImpl: billing }) }, cases, storeFile: path.join(tmp, `b-${Date.now()}.jsonl`), arms: ['A', 'H'], phases: ['answer', 'judge'] });
      assert.equal(r2.status, 'stopped-billing');
      assert.equal(billing.requests.length, 1, 'no paid fallback, no second route');

      const m = createManager({ config: config(), env: setup.env, transport: liveTransport({ env: BOTH, fetchImpl: providerStub() }) });
      await assert.rejects(m.request({ role: 'answer', datasetId: 'real-user-history', messages: [{ role: 'user', content: 'x' }] }), DataRefused);
    } finally { for (const k of Object.keys(BOTH)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  });
  test('static: no module behind the switches reads them', () => {
    for (const f of ['providers/providerManager.mjs', 'providers/evalConfig.mjs', 'providers/pairRunner.mjs', 'providers/errorTaxonomy.mjs', 'providers/credentials.mjs']) {
      assert.doesNotMatch(fs.readFileSync(path.join(AQUA, 'eval', f), 'utf8'), /APPROVED/, f);
    }
  });
});

describe('2. request formats and response parsing (live transport, stubbed network)', () => {
  const cred = provider => loadCredentials(provider, { GROQ_API_KEY_1: GROQ_KEY, GEMINI_API_KEY: GEMINI_KEY }).usable[0];
  const msgs = [{ role: 'system', content: 'SYSTEM PROMPT' }, { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'question' }];
  test('Groq: OpenAI-compatible POST, Bearer auth, only known settings; content, usage and finish reason parsed', async () => {
    const stub = providerStub();
    const t = liveTransport({ env: BOTH, fetchImpl: stub });
    const r = await t({ provider: 'groq', model: 'openai/gpt-oss-120b', credential: cred('groq'), messages: msgs, settings: { temperature: 0, max_tokens: 700, unexpected_key: 'dropped' } });
    const q = stub.requests[0];
    assert.equal(q.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(q.method, 'POST');
    assert.equal(q.headers.Authorization === `Bearer ${GROQ_KEY}`, true, 'Bearer header carries the key');
    assert.deepEqual(Object.keys(q.body).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
    assert.deepEqual(q.body.messages, msgs, 'messages as given, system message included');
    assert.deepEqual([r.status, r.text, r.usage.prompt_tokens, r.usage.completion_tokens, r.finishReason], [200, 'An answer from the synthetic history.', 900, 60, 'stop']);
    assert.equal(r.json, null, 'a success body is not retained');
  });
  test('Gemini: generateContent, x-goog-api-key (no Authorization), system → systemInstruction, roles user/model, generationConfig; parts joined', async () => {
    const stub = providerStub();
    const t = liveTransport({ env: BOTH, fetchImpl: stub });
    const r = await t({ provider: 'gemini', model: 'gemini-2.5-flash', credential: cred('gemini'), messages: msgs, settings: { temperature: 0, max_tokens: 400, thinking_budget: 0 } });
    const q = stub.requests[0];
    assert.equal(q.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(q.headers['x-goog-api-key'] === GEMINI_KEY, true);
    assert.equal(q.headers.Authorization, undefined);
    assert.deepEqual(q.body.systemInstruction, { parts: [{ text: 'SYSTEM PROMPT' }] });
    assert.deepEqual(q.body.contents.map(c => c.role), ['user', 'model', 'user']);
    assert.deepEqual(q.body.generationConfig, { temperature: 0, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } });
    assert.equal(r.text, JUDGE_JSON, 'multi-part text joined');
    assert.deepEqual([r.usage.prompt_tokens, r.usage.completion_tokens, r.finishReason], [500, 80, 'STOP']);
  });
  test('errors: status, Retry-After and the body reach the classifier; bodies are truncated', async () => {
    const stub = providerStub({ 'api.groq.com': () => new Response(`{"error":{"message":"Rate limit reached on tokens per minute (TPM). ${'x'.repeat(3000)}"}}`, { status: 429, headers: { 'retry-after': '7', 'x-ratelimit-remaining-requests': '0' } }) });
    const r = await liveTransport({ env: BOTH, fetchImpl: stub })({ provider: 'groq', model: 'm', credential: cred('groq'), messages: msgs, settings: {} });
    assert.equal(r.status, 429);
    assert.equal(r.headers['retry-after'], '7');
    assert.ok(r.bodyText.length <= 2000);
    const c = classify(r);
    assert.deepEqual([c.category, c.retryAfterMs], ['rate_limited_temporary', 7000]);
  });
  test('an empty completion (reasoning used the whole budget) stops for review and is not stored', async () => {
    const stub = providerStub({ 'api.groq.com': () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 900, completion_tokens: 700 } }), { status: 200 }) });
    const store = path.join(tmp, `e-${Date.now()}.jsonl`);
    const setup = { env: { GROQ_API_KEY_1: GROQ_KEY, GEMINI_API_KEY: GEMINI_KEY }, config: config(), transport: liveTransport({ env: BOTH, fetchImpl: stub }) };
    const r = await runEvaluation({ setup, cases: [{ caseId: 'e1', datasetId: DEV_HASH, arms: { A: [{ role: 'user', content: 'a' }], H: [{ role: 'user', content: 'h' }] } }], storeFile: store, arms: ['A', 'H'], phases: ['answer'] });
    assert.equal(r.status, 'stopped-review');
    assert.equal(fs.existsSync(store) ? fs.readFileSync(store, 'utf8').trim() : '', '', 'nothing persisted');
    assert.equal(stub.requests.length, 1, 'not retried blindly');
  });
});

describe('3. one-case smoke rehearsal (live code path, stubbed network)', () => {
  test('A and H: same answering model and settings; judge is a different model; persisted; resume sends nothing', async () => {
    const { runScenario, closeAcib } = await import('../adapters/acibPipeline.mjs');
    const stub = providerStub();
    const setup = liveSetup({ configFile: cfgFile(config()), credentialsFile: credFile, datasetHash: DEV_HASH, env: BOTH });
    // Swap only the network: the transport is the real liveTransport with a stubbed fetch.
    setup.transport = liveTransport({ env: BOTH, fetchImpl: stub });
    const store = path.join(tmp, `smoke-${Date.now()}.pairs.jsonl`);
    const cases = acibCases({ ds: DEV, datasetHash: DEV_HASH, scenarios: DEV.scenarios.slice(0, 1), armEnvs: { A: {}, H: { AQUA_HYBRID_CONTEXT: 'on' } }, regime: 'short', label: 'smoke-rehearsal', runScenario });
    try {
      const r = await runEvaluation({ setup, cases, storeFile: store, arms: ['A', 'H'], phases: ['answer', 'judge'] });
      assert.equal(r.status, 'complete');
      const answers = stub.requests.filter(x => x.host === 'api.groq.com');
      const judges = stub.requests.filter(x => x.host === 'generativelanguage.googleapis.com');
      assert.equal(answers.length, 2); assert.equal(judges.length, 2);
      assert.equal(answers[0].body.model, answers[1].body.model);
      assert.deepEqual([answers[0].body.temperature, answers[0].body.max_tokens], [answers[1].body.temperature, answers[1].body.max_tokens]);
      assert.match(answers[0].body.messages[0].content, /AQUA SELF-KNOWLEDGE/, 'the real pipeline prompt');
      assert.match(judges[0].path, /gemini-2\.5-flash/);
      assert.notEqual(judges[0].path.includes(answers[0].body.model), true, 'the judge is a different model');
      const recs = fs.readFileSync(store, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      // Arm order is randomised per case (seeded, recorded); both answers precede both judgements.
      assert.deepEqual(recs.map(x => `${x.type}:${x.arm}`).slice(0, 2).sort(), ['answer:A', 'answer:H']);
      assert.deepEqual(recs.map(x => `${x.type}:${x.arm}`).slice(2).sort(), ['judgement:A', 'judgement:H']);
      assert.deepEqual(recs[0].armOrder, recs.slice(0, 2).map(x => x.arm), 'the recorded order is the order used');
      assert.ok(recs.every(x => !redact(x).includes('SECRET')), 'no credential in the store');
      assert.doesNotMatch(redact(r).replace(/<groq>|<gemini>/g, ''), /SECRET/, 'no credential in the run record');
      const n = stub.requests.length;
      const again = await runEvaluation({ setup, cases, storeFile: store, arms: ['A', 'H'], phases: ['answer', 'judge'] });
      assert.equal(stub.requests.length, n, 'resume: nothing re-requested');
      assert.equal(again.skipped, 4);
    } finally { closeAcib(); }
  });
});

describe('4. no production data access', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-home-'));
  const safe = { AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_DATA_DIR: path.join(os.tmpdir(), 'aqua-eval-x') };
  test('the isolated evaluation environment passes', () => assert.deepEqual(productionDataGuard(safe, home), []));
  test('a database URL, a Mongo URI, the mirror enabled, or the real ~/.aquiplex store are each refused', () => {
    assert.match(productionDataGuard({ ...safe, DATABASE_URL: 'postgres://x' }, home).join(), /DATABASE_URL/);
    assert.match(productionDataGuard({ ...safe, MONGO_URI: 'mongodb://x' }, home).join(), /MONGO_URI/);
    assert.match(productionDataGuard({ ...safe, AQUA_DISABLE_MONGO_MIRROR: '0' }, home).join(), /AQUA_DISABLE_MONGO_MIRROR/);
    assert.match(productionDataGuard({ ...safe, AQUA_DATA_DIR: path.join(home, '.aquiplex') }, home).join(), /real ~\/\.aquiplex/);
    assert.match(productionDataGuard({ ...safe, AQUA_DATA_DIR: undefined }, home).join(), /AQUA_DATA_DIR is not set/);
  });
  test('this test process itself runs isolated', () => {
    assert.deepEqual(productionDataGuard(process.env).filter(r => !/DATABASE_URL|MONGO/.test(r)), []);
  });
});
