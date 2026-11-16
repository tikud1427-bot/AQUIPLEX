/**
 * Final pre-execution check (2026-11-11): one test per checklist item for the answers-only smoke
 * test with the existing production pools. Strict defaults in that mode: no key rotation, and any
 * rate-limit / quota 429 pauses at once.
 *
 * Synthetic .env mirror (every value carries SECRET); providers mocked or a stub fetchImpl;
 * global fetch tripwire (0 external requests); the real .env is never read.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { numberedPoolEnv, authorisedNames, runEvaluation } from '../answer/evalRun.mjs';
import { mockTransport, liveTransport } from '../providers/transports.mjs';

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
const ENV_TEXT = [...GEM12.map((n, i) => `${n}=${aq(i + 1)}`), ...GROQ5.map((n, i) => `${n}=${gsk(i + 1)}`), 'GROQ_API_KEY=' + gsk(0)].join('\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-final-pre-'));
const DS = 'synthetic-dataset-sha';
const ev = { method: 'console: plan Free, no payment method', by: 'founder', at: '2026-11-11' };
// The smoke configuration as the founder will fill it in (example + verified billing).
const cfg = (over = {}) => ({
  evaluationOnly: true, credentialSource: 'production', allowProductionCredentials: true, credentialMode: 'existing-numbered-pools', productionUsageCheck: { date: new Date().toISOString().slice(0, 10), by: 'founder', method: 'console usage page', remainingDailyTokens: 1000000000 }, tokenBudget: { perRequest: { groq: 1000000, gemini: 1000000 }, run: { groq: 100000000, gemini: 100000000 }, group: { 'unverified:groq': 100000000, 'unverified:gemini': 100000000, 'groq-a': 100000000, 'groq-b': 100000000, 'gemini-proj-a': 100000000, 'gemini-proj-b': 100000000 }, ledgerFile: path.join(os.tmpdir(), `aqua-test-ledger-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`) },
  founderDecision: { by: 'founder', at: '2026-11-11', statement: 'existing numbered pools' },
  credentialVerification: { by: 'founder', at: '2026-11-11', statement: 'verified all 12 Gemini credentials', envNames: GEM12 }, allowNonStandard: GEM12,
  syntheticDatasets: [DS], requestBudget: { groq: 4, gemini: 4 },
  rateLimits: { groq: { tokensPerMinute: 4000, maxRequestTokens: 4000, minIntervalMs: 61_000 }, gemini: { tokensPerMinute: 4000, maxRequestTokens: 4000, minIntervalMs: 61_000 } },
  models: { answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 1500 } }, judge: { provider: 'groq', model: 'qwen/qwen3.8-27b', settings: { temperature: 0, max_tokens: 1024 } } },
  domains: [
    { id: 'groq-org', provider: 'groq', envNames: GROQ5, billing: 'free-tier-verified', billingEvidence: ev },
    { id: 'gemini-project', provider: 'gemini', envNames: GEM12, billing: 'free-tier-verified', billingEvidence: { ...ev, method: 'Cloud console: no billing account linked' } },
  ],
  ...over,
});
const POOL = numberedPoolEnv(ENV_TEXT, authorisedNames(cfg()));
const clock = () => { let t = Date.parse('2026-11-12T03:00:00Z'); const waits = []; return { now: () => t, sleep: async ms => { waits.push(ms); t += ms; }, waits }; };
const PROMPT = [{ role: 'system', content: 's'.repeat(5000) }, { role: 'user', content: 'u'.repeat(923) }];
const cases = n => Array.from({ length: n }, (_, i) => ({ caseId: `c${i + 1}`, datasetId: DS, arms: { A: PROMPT, H: PROMPT }, judge: () => [{ role: 'user', content: 'judge' }] }));
const store = () => path.join(tmp, `pairs-${Math.random().toString(36).slice(2)}.jsonl`);
const answersOnly = async (transport, over = {}, sf = store(), c = clock()) => ({ c, sf, r: await runEvaluation({ setup: { env: POOL, config: cfg(over), transport }, cases: cases(1), storeFile: sf, arms: ['A', 'H'], phases: ['answer'], managerOptions: { now: c.now, sleep: c.sleep } }) });
const ok = () => ({ status: 200, text: 'answer', usage: { prompt_tokens: 1480, completion_tokens: 210 } });
const GROQ_TPM_429 = { status: 429, bodyText: 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1700. Please try again in 5s.', headers: { 'retry-after': '5' } };
const GROQ_RPD_429 = { status: 429, bodyText: 'Rate limit reached on requests per day (RPD). Upgrade to Dev Tier at https://console.groq.com/settings/billing' };

describe('1. any Groq rate-limit response pauses the evaluation immediately', () => {
  for (const [name, res, reason] of [['per-minute 429 with a 5 s Retry-After', GROQ_TPM_429, 'rate_limited_temporary'], ['daily 429', GROQ_RPD_429, 'quota_exhausted'], ['unexplained 429', { status: 429, bodyText: '' }, 'quota_exhausted']]) {
    test(`${name}: 1 request, no wait, no retry, status paused`, async () => {
      const t = mockTransport(() => res);
      const { r, c } = await answersOnly(t);
      assert.equal(t.calls.length, 1, 'the second arm is never sent');
      assert.equal(r.status, 'paused');
      assert.equal(r.pauseReason, reason);
      assert.deepEqual(c.waits, [], 'no inline wait');
    });
  }
  test('even with a second verified Groq organisation, a 429 does not move to it', async () => {
    const t = mockTransport(() => GROQ_TPM_429);
    const split = { domains: [
      { id: 'groq-a', provider: 'groq', envNames: GROQ5.slice(0, 2), verification: ev, billing: 'free-tier-verified', billingEvidence: ev },
      { id: 'groq-b', provider: 'groq', envNames: GROQ5.slice(2), verification: ev, billing: 'free-tier-verified', billingEvidence: ev },
      cfg().domains[1],
    ] };
    const { r } = await answersOnly(t, split);
    assert.equal(t.calls.length, 1); assert.equal(r.status, 'paused');
  });
});

describe('2. no automatic switch to another Groq key or to Gemini', () => {
  test('both answering requests use the same key (GROQ_API_KEY_1) and only Groq', async () => {
    const t = mockTransport(ok);
    await answersOnly(t);
    assert.deepEqual(t.calls.map(x => `${x.provider}:${x.envName}`), ['groq:GROQ_API_KEY_1', 'groq:GROQ_API_KEY_1']);
  });
  test('a failed key (401) stops the run for review — no second key, no Gemini', async () => {
    const t = mockTransport(() => ({ status: 401, bodyText: 'invalid api key' }));
    const { r } = await answersOnly(t);
    assert.equal(t.calls.length, 1);
    assert.equal(r.status, 'stopped-review');
    assert.ok(t.calls.every(x => x.provider === 'groq'));
  });
  test('a server error retries on the SAME key only', async () => {
    let n = 0;
    const t = mockTransport(() => (n++ === 0 ? { status: 503, bodyText: 'unavailable' } : ok()));
    await answersOnly(t);
    assert.ok(t.calls.every(x => x.envName === 'GROQ_API_KEY_1' && x.provider === 'groq'));
  });
});

describe('3. no automatic retry can exceed the request cap', () => {
  test('cap 2: endless network failures stop at 2 attempts', async () => {
    const t = mockTransport(() => new Error('ECONNRESET'));
    await answersOnly(t, { requestBudget: { groq: 2, gemini: 4 } }).catch(() => {});
    assert.ok(t.calls.length <= 2, `${t.calls.length} attempts`);
  });
  test('cap 4: retries counted before sending; never more than 4 attempts in the run', async () => {
    const t = mockTransport(() => new Error('ECONNRESET'));
    await answersOnly(t).catch(() => {});
    assert.ok(t.calls.length <= 4, `${t.calls.length} attempts`);
  });
});

describe('4–5. answers-only: exactly 2 requests, 0 judge requests; a re-run repeats nothing', () => {
  test('2 Groq gpt-oss-120b requests, 0 judge requests; the same command again sends 0', async () => {
    const t1 = mockTransport(ok);
    const { r, sf } = await answersOnly(t1);
    assert.equal(t1.calls.length, 2);
    assert.ok(t1.calls.every(x => x.model === 'openai/gpt-oss-120b'));
    assert.equal(r.status, 'complete-judging-queued'); assert.equal(r.judged, 0);
    const t2 = mockTransport(ok);
    const again = await answersOnly(t2, {}, sf);
    assert.equal(t2.calls.length, 0);
    assert.equal(again.r.skipped, 2);
  });
  test('after a pause, the re-run sends only the missing arm', async () => {
    let n = 0;
    const t1 = mockTransport(() => (n++ === 0 ? ok() : GROQ_TPM_429));
    const { sf, r } = await answersOnly(t1);
    assert.equal(r.status, 'paused');
    const t2 = mockTransport(ok);
    await answersOnly(t2, {}, sf);
    assert.equal(t2.calls.length, 1, 'only arm H');
  });
});

describe('6. provider-reported token usage is recorded', () => {
  test('Groq usage from the response body reaches the pair store and the run summary', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'real answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1523, completion_tokens: 387, total_tokens: 1910 } }), { status: 200 });
    const transport = liveTransport({ env: { AQUA_EVAL_LIVE_APPROVED: 'yes' }, fetchImpl });
    const { r, sf } = await answersOnly(transport);
    const recs = fs.readFileSync(sf, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(recs.length, 2);
    for (const x of recs) assert.deepEqual(x.usage, { prompt_tokens: 1523, completion_tokens: 387, total_tokens: 1910 });
    const s = r.usage.reduce((a, u) => ({ n: a.n + u.requests, p: a.p + u.promptTokens, c: a.c + u.completionTokens }), { n: 0, p: 0, c: 0 });
    assert.deepEqual(s, { n: 2, p: 3046, c: 774 }, 'pacing waits are not counted as requests');
    assert.doesNotMatch(fs.readFileSync(sf, 'utf8'), /SECRET/);
  });
});

describe('7. the output states clearly whether the run completed or paused', () => {
  test('CLI (dry run, child process): "RESULT: COMPLETED (answers only; judging NOT run …)" with request count; 0 external requests', () => {
    const label = `final-pre-${process.pid}-${Date.now()}`;
    const out = path.join(tmp, 'ext.txt');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|GEMINI_KEY|GROQ|OPENROUTER|NVIDIA|DATABASE_URL|MONGO/i.test(k)));
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(HERE, 'fixtures/fetchGuard.mjs')).href, path.join(AQUA, 'scripts/answer-eval.mjs'), '--set', 'acib.v2.dev', '--limit', '1', '--regime', 'short', '--arms', 'A,H', '--answers-only', '--label', label], {
      cwd: AQUA, encoding: 'utf8', timeout: 240_000, env: { ...env, FETCH_GUARD_OUT: out, AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_DATA_DIR: fs.mkdtempSync(path.join(tmp, 'data-')) },
    });
    try {
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stdout, /RESULT: COMPLETED \(answers only; judging NOT run — use answer-judge\.mjs\) · requests sent 2 · provider-reported tokens/);
      assert.equal(fs.readFileSync(out, 'utf8'), '0');
    } finally {
      for (const f of fs.readdirSync(path.join(AQUA, 'eval/answer/results')).filter(f => f.startsWith(label))) fs.rmSync(path.join(AQUA, 'eval/answer/results', f));
    }
  });
  test('a paused run reports status "paused", the reason and the resume time', async () => {
    const { r } = await answersOnly(mockTransport(() => GROQ_TPM_429));
    assert.equal(r.status, 'paused'); assert.equal(r.pauseReason, 'rate_limited_temporary'); assert.ok(r.resumeAt > 0);
    const src = fs.readFileSync(path.join(AQUA, 'scripts/answer-eval.mjs'), 'utf8');
    assert.match(src, /'paused': `PAUSED \(\$\{run\.pauseReason/);
  });
});
