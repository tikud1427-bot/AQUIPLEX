/**
 * Final pre-smoke-test corrections (2026-11-11): answers-only request counts, token pacing and
 * bounded output under Groq's 8,000 tokens-per-minute limit, explicit per-group billing evidence
 * independent of the credential verification, and Gemini authentication through the supported
 * adapter's mechanism (differential check against the real @google/genai SDK with a stub fetch).
 *
 * Synthetic .env mirror (every value carries SECRET); providers mocked; global fetch tripwire
 * (0 external requests); the real .env is never read.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { numberedPoolEnv, authorisedNames, runEvaluation } from '../answer/evalRun.mjs';
import { preflight, PreflightRefused } from '../providers/evalConfig.mjs';
import { createManager, estimateRequestTokens, RequestRejected } from '../providers/providerManager.mjs';
import { mockTransport, liveTransport } from '../providers/transports.mjs';
import { loadCredentials } from '../providers/credentials.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
let fetches = 0;
const realFetch = globalThis.fetch;
const tripwire = async () => { fetches++; throw new Error('network forbidden'); };
globalThis.fetch = tripwire;
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'no network request'); });

const aq = n => `AQ.SECRET${String(n).padStart(2, '0')}${'k'.repeat(44)}`;
const gsk = n => `gsk_SECRET${String(n).padStart(2, '0')}${'z'.repeat(24)}`;
const GEM12 = Array.from({ length: 12 }, (_, i) => `GEMINI_KEY_${i + 1}`);
const GROQ5 = Array.from({ length: 5 }, (_, i) => `GROQ_API_KEY_${i + 1}`);
const ENV_TEXT = [...GEM12.map((n, i) => `${n}=${aq(i + 1)}`), ...GROQ5.map((n, i) => `${n}=${gsk(i + 1)}`), 'GROQ_API_KEY=' + gsk(0)].join('\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-pre-smoke-'));
const DS = 'synthetic-dataset-sha';
const ev = { method: 'console: plan Free, no payment method', by: 'founder', at: '2026-11-11' };
const RECORD = { by: 'founder', at: '2026-11-11', statement: 'I personally verified all 12 existing Gemini credentials.', envNames: GEM12 };
// The smoke-test configuration (as in the example), with verified billing filled in.
const SMOKE_LIMITS = { groq: { tokensPerMinute: 4000, maxRequestTokens: 4000, minIntervalMs: 61_000 }, gemini: { tokensPerMinute: 4000, maxRequestTokens: 4000, minIntervalMs: 61_000 } };
const cfg = (over = {}) => ({
  evaluationOnly: true, credentialSource: 'production', allowProductionCredentials: true, credentialMode: 'existing-numbered-pools', productionUsageCheck: { date: new Date().toISOString().slice(0, 10), by: 'founder', method: 'console usage page', remainingDailyTokens: 1000000000 }, tokenBudget: { perRequest: { groq: 1000000, gemini: 1000000 }, run: { groq: 100000000, gemini: 100000000 }, group: { 'unverified:groq': 100000000, 'unverified:gemini': 100000000, 'groq-a': 100000000, 'groq-b': 100000000, 'gemini-proj-a': 100000000, 'gemini-proj-b': 100000000 }, ledgerFile: path.join(os.tmpdir(), `aqua-test-ledger-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`) },
  founderDecision: { by: 'founder', at: '2026-11-11', statement: 'existing numbered pools' },
  credentialVerification: RECORD, allowNonStandard: GEM12,
  syntheticDatasets: [DS], requestBudget: { groq: 4, gemini: 4 }, rateLimits: SMOKE_LIMITS,
  models: {
    answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 1500 } },
    judge: { provider: 'groq', model: 'qwen/qwen3.8-27b', settings: { temperature: 0, max_tokens: 1024 } },
  },
  domains: [
    { id: 'groq-org', provider: 'groq', envNames: GROQ5, billing: 'free-tier-verified', billingEvidence: ev },
    { id: 'gemini-project', provider: 'gemini', envNames: GEM12, billing: 'free-tier-verified', billingEvidence: { ...ev, method: 'Cloud console: no billing account linked' } },
  ],
  ...over,
});
const POOL = numberedPoolEnv(ENV_TEXT, authorisedNames(cfg()));
/** Fake clock: sleep advances time instantly; every wait is recorded. */
const clock = () => { let t = Date.parse('2026-11-12T03:00:00Z'); const waits = []; return { now: () => t, sleep: async ms => { waits.push(ms); t += ms; }, waits }; };
const JUDGE = '{"factual_correctness":2,"grounding":2,"personalization":2,"temporal_accuracy":null,"contradiction_handling":null,"uncertainty":null,"clarification_quality":2,"hallucination":false,"hallucinated_claims":[],"confidence":0.9,"notes":"ok"}';
// Measured 2026-11-11 offline: acib.v2.dev case 1 (short regime) is 5,923 characters per arm (system + user);
// the judge prompt with a 6,000-character answer is 7,933 characters.
const ANSWER_PROMPT = [{ role: 'system', content: 's'.repeat(5000) }, { role: 'user', content: 'u'.repeat(923) }];
const cases = n => Array.from({ length: n }, (_, i) => ({ caseId: `c${i + 1}`, datasetId: DS, arms: { A: ANSWER_PROMPT, H: ANSWER_PROMPT }, judge: () => [{ role: 'user', content: 'j'.repeat(7933) }] }));
const store = () => path.join(tmp, `pairs-${Math.random().toString(36).slice(2)}.jsonl`);
const timedTransport = c => { const t = mockTransport(call => { t.sentAt.push(c.now()); return { status: 200, text: call.model === 'qwen/qwen3.8-27b' ? JUDGE : 'answer', usage: {} }; }); t.sentAt = []; return t; };

describe('1. answers-only: exactly two answering requests, zero judge requests', () => {
  test('one case, arms A and H: 2 Groq gpt-oss-120b requests, 0 judge requests, judging queued (not run)', async () => {
    const c = clock(); const t = timedTransport(c);
    const r = await runEvaluation({ setup: { env: POOL, config: cfg(), transport: t }, cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer'], managerOptions: { now: c.now, sleep: c.sleep } });
    assert.equal(t.calls.length, 2);
    assert.ok(t.calls.every(x => x.provider === 'groq' && x.model === 'openai/gpt-oss-120b'));
    assert.equal(t.calls.filter(x => x.model === 'qwen/qwen3.8-27b').length, 0);
    assert.equal(r.status, 'complete-judging-queued');
    assert.equal(r.answered, 2); assert.equal(r.judged, 0);
  });
  test('it cannot continue into judging: re-running answers-only sends nothing; only an explicit judge run judges', async () => {
    const c = clock(); const sf = store();
    const t1 = timedTransport(c);
    await runEvaluation({ setup: { env: POOL, config: cfg(), transport: t1 }, cases: cases(1), storeFile: sf, arms: ['A', 'H'], phases: ['answer'], managerOptions: { now: c.now, sleep: c.sleep } });
    const t2 = timedTransport(c);
    const again = await runEvaluation({ setup: { env: POOL, config: cfg(), transport: t2 }, cases: cases(1), storeFile: sf, arms: ['A', 'H'], phases: ['answer'], managerOptions: { now: c.now, sleep: c.sleep } });
    assert.equal(t2.calls.length, 0, 'no request at all, no judge request');
    assert.equal(again.status, 'complete-judging-queued');
    const t3 = timedTransport(c);
    await runEvaluation({ setup: { env: POOL, config: cfg(), transport: t3 }, cases: cases(1), storeFile: sf, arms: ['A', 'H'], phases: ['judge'], managerOptions: { now: c.now, sleep: c.sleep } });
    assert.deepEqual(t3.calls.map(x => x.model), ['qwen/qwen3.8-27b', 'qwen/qwen3.8-27b'], 'judging happens only in a separate judge run, and never re-answers');
  });
  test('the CLI maps --answers-only to the answer phase only (dry run, child process, 0 external requests)', () => {
    const label = `pre-smoke-${process.pid}-${Date.now()}`;
    const out = path.join(tmp, 'ext.txt');
    const guard = pathToFileURL(path.join(HERE, 'fixtures/fetchGuard.mjs')).href;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|GEMINI_KEY|GROQ|OPENROUTER|NVIDIA|DATABASE_URL|MONGO/i.test(k)));
    const r = spawnSync(process.execPath, ['--import', guard, path.join(AQUA, 'scripts/answer-eval.mjs'), '--set', 'acib.v2.dev', '--limit', '1', '--regime', 'short', '--arms', 'A,H', '--answers-only', '--label', label], {
      cwd: AQUA, encoding: 'utf8', timeout: 240_000, env: { ...env, FETCH_GUARD_OUT: out, AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_DATA_DIR: fs.mkdtempSync(path.join(tmp, 'data-')) },
    });
    try {
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stdout, /complete-judging-queued · answered 2 · judged 0/);
      assert.equal(fs.readFileSync(out, 'utf8'), '0');
    } finally {
      for (const f of fs.readdirSync(path.join(AQUA, 'eval/answer/results')).filter(f => f.startsWith(label))) fs.rmSync(path.join(AQUA, 'eval/answer/results', f));
    }
  });
});

describe('2. tokens, pacing and bounded output under Groq 8,000 TPM', () => {
  test('the measured smoke prompts estimate at 3,507 (answer) and 3,693 (judge) tokens including the full output bound', () => {
    assert.equal(estimateRequestTokens(ANSWER_PROMPT, 1500), Math.ceil(5923 / 3) + 16 + 16 + 1500);
    assert.equal(estimateRequestTokens(ANSWER_PROMPT, 1500), 3507);
    assert.equal(estimateRequestTokens(cases(1)[0].judge(), 1024), 3693);
    assert.ok(3507 <= SMOKE_LIMITS.groq.maxRequestTokens && 3693 <= SMOKE_LIMITS.groq.maxRequestTokens);
  });
  test('the two answering requests are paced ≥ 61 s apart: at most one evaluation request in any minute (≤ 4,000 of 8,000 TPM)', async () => {
    const c = clock(); const t = timedTransport(c);
    await runEvaluation({ setup: { env: POOL, config: cfg(), transport: t }, cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer'], managerOptions: { now: c.now, sleep: c.sleep } });
    assert.equal(t.sentAt.length, 2);
    assert.ok(t.sentAt[1] - t.sentAt[0] >= 61_000, `gap ${t.sentAt[1] - t.sentAt[0]} ms`);
  });
  test('the per-minute token window alone also spaces requests (minIntervalMs 0)', async () => {
    const c = clock(); const t = timedTransport(c);
    const limits = { ...SMOKE_LIMITS, groq: { tokensPerMinute: 4000, minIntervalMs: 0 } };
    await runEvaluation({ setup: { env: POOL, config: cfg({ rateLimits: limits }), transport: t }, cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer'], managerOptions: { now: c.now, sleep: c.sleep } });
    assert.ok(t.sentAt[1] - t.sentAt[0] >= 60_000, '3,507 + 3,507 > 4,000: the second waits for the window');
  });
  test('a full pair (answers + judge) stays at one request per minute, 4 requests, never two in one window', async () => {
    const c = clock(); const t = timedTransport(c);
    const r = await runEvaluation({ setup: { env: POOL, config: cfg(), transport: t }, cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer', 'judge'], managerOptions: { now: c.now, sleep: c.sleep } });
    assert.equal(r.status, 'complete'); assert.equal(t.calls.length, 4);
    for (let i = 1; i < t.sentAt.length; i++) assert.ok(t.sentAt[i] - t.sentAt[i - 1] >= 61_000);
  });
  test('retries are paced too', async () => {
    const c = clock(); let n = 0;
    const t = mockTransport(() => { t.sentAt.push(c.now()); return n++ === 0 ? new Error('ECONNRESET') : { status: 200, text: 'answer', usage: {} }; }); t.sentAt = [];
    const m = createManager({ config: cfg(), env: POOL, transport: t, now: c.now, sleep: c.sleep });
    await m.request({ role: 'answer', datasetId: DS, messages: ANSWER_PROMPT });
    assert.equal(t.sentAt.length, 2);
    assert.ok(t.sentAt[1] - t.sentAt[0] >= 61_000);
  });
  test('an oversize request is rejected BEFORE sending (no 413 spent), and the run stops cleanly', async () => {
    const c = clock(); const t = timedTransport(c);
    const big = [{ caseId: 'big', datasetId: DS, arms: { A: [{ role: 'user', content: 'x'.repeat(9000) }], H: [{ role: 'user', content: 'x'.repeat(9000) }] } }];
    const r = await runEvaluation({ setup: { env: POOL, config: cfg(), transport: t }, cases: big, storeFile: store(), arms: ['A', 'H'], phases: ['answer'], managerOptions: { now: c.now, sleep: c.sleep } });
    assert.equal(t.calls.length, 0);
    assert.equal(r.status, 'stopped-rejected');
    assert.equal(r.rejected.category, 'over_token_limit');
    await assert.rejects(createManager({ config: cfg(), env: POOL, transport: t, now: c.now, sleep: c.sleep }).request({ role: 'answer', datasetId: DS, messages: big[0].arms.A }), RequestRejected);
  });
  test('production pools refuse a config without pacing or without a bounded output', () => {
    assert.throws(() => preflight(cfg({ rateLimits: undefined }), POOL), /rateLimits\.groq/);
    assert.throws(() => preflight(cfg({ models: { ...cfg().models, answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0 } } } }), POOL), /max_tokens: a positive integer output bound/);
    assert.throws(() => preflight(cfg({ models: { ...cfg().models, answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { max_tokens: 4000 } } } }), POOL), /leaves no room for the prompt/);
  });
});

describe('3. explicit verification for both providers and every quota group', () => {
  test('the filled-in smoke config passes', () => assert.doesNotThrow(() => preflight(cfg(), POOL)));
  test('every declared group needs its own billing evidence — even a group no role uses', () => {
    const unknownGemini = cfg({ domains: [cfg().domains[0], { ...cfg().domains[1], billing: 'unknown' }] });
    assert.throws(() => preflight(unknownGemini, POOL), e => e instanceof PreflightRefused && /domain gemini-project: billing 'free-tier-verified'/.test(e.message));
    const noEvidenceGroq = cfg({ domains: [{ ...cfg().domains[0], billingEvidence: undefined }, cfg().domains[1]] });
    assert.throws(() => preflight(noEvidenceGroq, POOL), /domain groq-org/);
  });
  test('the founder credential verification is NOT billing evidence', () => {
    // Record present, billing not established → refused.
    const noBilling = cfg({ models: { ...cfg().models, judge: { provider: 'gemini', model: 'gemini-2.5-flash', settings: { max_tokens: 1024 } } }, domains: [cfg().domains[0], { ...cfg().domains[1], billing: 'free-tier-verified', billingEvidence: undefined }] });
    assert.throws(() => preflight(noBilling, POOL), /domain gemini-project/);
    // Billing evidence that merely repeats the credential verification → refused.
    const copied = cfg({ domains: [cfg().domains[0], { ...cfg().domains[1], billingEvidence: { method: RECORD.statement, by: 'founder', at: '2026-11-11' } }] });
    assert.throws(() => preflight(copied, POOL), /repeats the credential verification/);
  });
  test('ownership is conservative: undocumented grouping keeps 12 Gemini keys in ONE group and 5 Groq keys in ONE group', () => {
    const m = createManager({ config: cfg(), env: POOL, transport: mockTransport(() => ({ status: 200, text: 'x' })) });
    assert.deepEqual(m.domains.map(d => `${d.provider}:${d.envNames.length}:${d.verified}`).sort(), ['gemini:12:false', 'groq:5:false']);
  });
});

describe('4. Gemini credentials only through the supported authentication mechanism', () => {
  test('differential: the real @google/genai SDK (production adapter library) and the evaluation transport build the same request', async () => {
    const key = aq(3);
    const capture = [];
    const stub = async (url, init) => { capture.push({ url: String(url), headers: new Headers(init?.headers) }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }], role: 'model' }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const { GoogleGenAI } = await import('@google/genai');
    globalThis.fetch = stub;                     // the SDK uses global fetch; the stub never touches the network
    try { await new GoogleGenAI({ apiKey: key }).models.generateContent({ model: 'gemini-2.5-flash', contents: 'synthetic' }); }
    finally { globalThis.fetch = tripwire; }
    const credential = loadCredentials('gemini', { GEMINI_KEY_3: key }).usable[0];
    await liveTransport({ env: { AQUA_EVAL_LIVE_APPROVED: 'yes' }, fetchImpl: async (url, init) => stub(url, init) })({ provider: 'gemini', model: 'gemini-2.5-flash', credential, messages: [{ role: 'user', content: 'synthetic' }], settings: {} });
    assert.equal(capture.length, 2);
    const [sdk, evalReq] = capture;
    assert.equal(evalReq.url, sdk.url, 'same endpoint (v1beta generateContent)');
    assert.equal(sdk.headers.get('x-goog-api-key'), key); assert.equal(evalReq.headers.get('x-goog-api-key'), key);
    assert.equal(sdk.headers.has('authorization'), false); assert.equal(evalReq.headers.has('authorization'), false);
    assert.doesNotMatch(sdk.url + evalReq.url, /key=|SECRET/);
  });
  test('static: credential values are revealed only in the evaluation transport, Gemini only into x-goog-api-key', () => {
    const files = ['providerManager.mjs', 'pairRunner.mjs', 'evalConfig.mjs', 'credentials.mjs', 'transports.mjs'].map(f => [f, fs.readFileSync(path.join(AQUA, 'eval/providers', f), 'utf8')]);
    files.push(['evalRun.mjs', fs.readFileSync(path.join(AQUA, 'eval/answer/evalRun.mjs'), 'utf8')]);
    const callers = files.filter(([f, s]) => f !== 'credentials.mjs' && /revealForRequest\(/.test(s)).map(([f]) => f);
    assert.deepEqual(callers, ['transports.mjs']);
    const t = files.find(([f]) => f === 'transports.mjs')[1];
    const geminiBranch = t.slice(t.indexOf("provider === 'gemini'"), t.indexOf('unsupported provider'));
    assert.deepEqual([...geminiBranch.matchAll(/(['\w-]+):\s*revealForRequest/g)].map(m => m[1]), ["'x-goog-api-key'"]);
  });
});
