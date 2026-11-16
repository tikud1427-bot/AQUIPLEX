/**
 * Final zero-cost readiness (2026-11-11): the existing numbered Groq pool under a
 * 4-request smoke cap. Synthetic .env mirror (every value carries SECRET); all
 * providers mocked; global fetch tripwire (0 requests); the real .env is never read.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { numberedPoolEnv, authorisedNames, liveSetup, runEvaluation, productionDataGuard, acquireRunLock, RunLocked } from '../answer/evalRun.mjs';
import { mockTransport } from '../providers/transports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error('network forbidden'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'no network request'); });

const gsk = n => `gsk_SECRET${String(n).padStart(2, '0')}${'z'.repeat(24)}`;
const ENV_TEXT = [
  'DATABASE_URL=postgres://SECRET', 'GROQ_API_KEY=' + gsk(0), `GEMINI_API_KEY=AIza${'SECRET'.padEnd(35, 'q')}`,
  ...Array.from({ length: 12 }, (_, i) => `GEMINI_KEY_${i + 1}=AQ.SECRET${i}${'y'.repeat(40)}`),
  ...Array.from({ length: 5 }, (_, i) => `GROQ_API_KEY_${i + 1}=${gsk(i + 1)}`),
].join('\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-zero-cost-'));
const envFile = path.join(tmp, '.env');
fs.writeFileSync(envFile, ENV_TEXT);
const DS = 'synthetic-dataset-sha';
const ev = { method: 'console', by: 'founder', at: '2026-11-11' };
const GROQ5 = ['GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4', 'GROQ_API_KEY_5'];
const cfg = (over = {}) => ({
  evaluationOnly: true, credentialSource: 'production', allowProductionCredentials: true, credentialMode: 'existing-numbered-pools', productionUsageCheck: { date: new Date().toISOString().slice(0, 10), by: 'founder', method: 'console usage page', remainingDailyTokens: 1000000000 }, tokenBudget: { perRequest: { groq: 1000000, gemini: 1000000 }, run: { groq: 100000000, gemini: 100000000 }, group: { 'unverified:groq': 100000000, 'unverified:gemini': 100000000, 'groq-a': 100000000, 'groq-b': 100000000, 'gemini-proj-a': 100000000, 'gemini-proj-b': 100000000 }, ledgerFile: path.join(os.tmpdir(), `aqua-test-ledger-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`) },
  founderDecision: { by: 'founder', at: '2026-11-11', statement: 'existing numbered pools' }, allowNonStandard: [], syntheticDatasets: [DS],
  requestBudget: { groq: 4 }, rateLimits: { groq: { tokensPerMinute: 1000000, minIntervalMs: 0 }, gemini: { tokensPerMinute: 1000000, minIntervalMs: 0 } },
  models: { answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 1500 } }, judge: { provider: 'groq', model: 'other-family-judge', settings: { temperature: 0, max_tokens: 1024 } } },
  domains: [{ id: 'groq-org', provider: 'groq', envNames: GROQ5, billing: 'free-tier-verified', billingEvidence: ev }],
  ...over,
});
const JUDGE = '{"factual_correctness":2,"grounding":2,"personalization":2,"temporal_accuracy":null,"contradiction_handling":null,"uncertainty":null,"clarification_quality":2,"hallucination":false,"hallucinated_claims":[],"confidence":0.9,"notes":"ok"}';
const ok = call => ({ status: 200, text: call.model === 'other-family-judge' ? JUDGE : 'answer', usage: { prompt_tokens: 10, completion_tokens: 3 } });
const cases = n => Array.from({ length: n }, (_, i) => ({ caseId: `c${i + 1}`, datasetId: DS, arms: { A: [{ role: 'user', content: `c${i + 1} A` }], H: [{ role: 'user', content: `c${i + 1} H` }] }, judge: (_a, ans) => [{ role: 'user', content: `judge ${ans}` }] }));
const POOL = numberedPoolEnv(ENV_TEXT, authorisedNames(cfg()));
const setupWith = (transport, over = {}) => ({ env: POOL, config: cfg(over), transport });
const store = () => path.join(tmp, `pairs-${Math.random().toString(36).slice(2)}.jsonl`);

describe('1. evaluation isolation', () => {
  test('only the explicitly authorised numbered Groq variables reach the manager — no Gemini AQ. value, no unnumbered key, no other secret', () => {
    assert.deepEqual(Object.keys(POOL).sort(), [...GROQ5].sort());
  });
  test('the live setup path hands the manager exactly those variables (transport built, never called)', () => {
    const cfgFile = path.join(tmp, 'cfg.json');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg()));
    const s = liveSetup({ configFile: cfgFile, datasetHash: DS, env: { AQUA_ANSWER_EVAL_APPROVED: 'yes', AQUA_EVAL_LIVE_APPROVED: 'yes' }, repoEnvPath: envFile });
    assert.deepEqual(Object.keys(s.env).sort(), [...GROQ5].sort());
  });
  test('static: the evaluation request path imports nothing from production routing', () => {
    for (const f of ['eval/providers/providerManager.mjs', 'eval/providers/transports.mjs', 'eval/providers/pairRunner.mjs', 'eval/providers/evalConfig.mjs', 'eval/providers/credentials.mjs', 'eval/answer/evalRun.mjs']) {
      const src = fs.readFileSync(path.join(AQUA, f), 'utf8');
      // Real module references only (static import, require, dynamic import) — comments may name production files.
      const refs = [...src.matchAll(/(?:^\s*import\s[^;]*?from\s+|\brequire\(\s*|\bimport\(\s*)['"]([^'"]+)['"]/gm)].map(m => m[1]);
      assert.ok(refs.length > 0, `${f}: imports were found`);
      for (const r of refs) assert.doesNotMatch(r, /src\/providers|keyPool|providers\/router|core\/strategy|^\.\.\/\.\.\/src\//, `${f} imports ${r}`);
    }
  });
  test('provider credentials in the process environment are refused, by NAME (no value is echoed)', () => {
    const r = productionDataGuard({ AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_DATA_DIR: tmp, GROQ_API_KEY_1: gsk(1), GEMINI_KEY_3: 'AQ.SECRETx', OPENROUTER_API_KEY: 'sk-or-SECRET' }).join(' ');
    assert.match(r, /GROQ_API_KEY_1, GEMINI_KEY_3, OPENROUTER_API_KEY/);
    assert.doesNotMatch(r, /SECRET/);
  });
});

describe('2. the 4-request cap protects the shared quota group', () => {
  test('one pair = 2 answers + 2 judgements = exactly 4 requests; the next case pauses at the cap without a 5th request', async () => {
    const t = mockTransport(ok);
    const r = await runEvaluation({ setup: setupWith(t), cases: cases(2), storeFile: store(), arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(t.calls.length, 4);
    assert.equal(r.status, 'paused');
    assert.equal(r.answered, 2); assert.equal(r.judged, 2);
  });
  test('no retry can exceed the cap: network failures stop at 4 attempts', async () => {
    const t = mockTransport([new Error('ECONNRESET'), new Error('ECONNRESET'), ok({ model: 'openai/gpt-oss-120b' }), new Error('ECONNRESET'), new Error('ECONNRESET'), ok({ model: 'x' })]);
    const r = await runEvaluation({ setup: { ...setupWith(t), config: cfg() }, cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer'] });
    assert.ok(t.calls.length <= 4, `attempts ${t.calls.length}`);
    assert.equal(r.status, 'paused');
  });
  test('a quota error pauses at once: 1 request, no judging attempt, no further case', async () => {
    const t = mockTransport(() => ({ status: 429, bodyText: 'Rate limit reached on requests per day (RPD). Upgrade to Dev Tier at https://console.groq.com/settings/billing', headers: { 'retry-after': '3600' } }));
    const r = await runEvaluation({ setup: setupWith(t), cases: cases(3), storeFile: store(), arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r.status, 'paused');
    assert.equal(t.calls.length, 1, 'the shared group was hit once; nothing continued silently');
  });
  test('one live evaluation at a time: a second lock is refused; a stale lock is reclaimed', () => {
    const lockFile = path.join(tmp, 'eval.lock');
    const a = acquireRunLock(lockFile, { pid: 111, isAlive: p => p === 111 });
    assert.throws(() => acquireRunLock(lockFile, { pid: 222, isAlive: p => p === 111 }), RunLocked);
    a.release();
    const b = acquireRunLock(lockFile, { pid: 333, isAlive: () => true });
    assert.throws(() => acquireRunLock(lockFile, { pid: 444, isAlive: p => p === 333 }), RunLocked);
    const c = acquireRunLock(lockFile, { pid: 555, isAlive: p => p === 555 });      // 333 is now "dead": stale → reclaimed
    c.release(); b.release();
    assert.equal(fs.existsSync(lockFile), false);
  });
});

describe('3. failure handling, resume, no fallback, no leakage', () => {
  test('an invalid key is skipped (and counts toward the cap)', async () => {
    const t = mockTransport(call => (call.envName === 'GROQ_API_KEY_1' ? { status: 401, bodyText: 'invalid api key' } : ok(call)));
    const r = await runEvaluation({ setup: setupWith(t, { keyRotation: true }), cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer'] });
    assert.equal(r.answered, 2);
    assert.equal(t.calls.length, 3, '1 refused + 2 answers, within the cap of 4');
  });
  test('pause and resume: a later run completes only what is missing', async () => {
    const s = store();
    const t1 = mockTransport(ok);
    const r1 = await runEvaluation({ setup: setupWith(t1), cases: cases(2), storeFile: s, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r1.status, 'paused');
    const t2 = mockTransport(ok);
    const r2 = await runEvaluation({ setup: setupWith(t2), cases: cases(2), storeFile: s, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r2.status, 'complete');
    assert.equal(t2.calls.length, 4, 'only case 2: its 2 answers + 2 judgements');
    const recs = fs.readFileSync(s, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(new Set(recs.map(x => `${x.type}${x.caseId}${x.arm}`)).size, recs.length, 'no duplicate record');
  });
  test('no unnumbered fallback and no paid fallback: billing stops after 1 request on a numbered key', async () => {
    const t = mockTransport(() => ({ status: 402, bodyText: 'payment required' }));
    const r = await runEvaluation({ setup: setupWith(t), cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r.status, 'stopped-billing');
    assert.equal(t.calls.length, 1);
    assert.match(t.calls[0].envName, /^GROQ_API_KEY_[1-5]$/);
  });
  test('every key invalid → pause; the unnumbered GROQ_API_KEY is never reachable (it never entered the manager)', async () => {
    const t = mockTransport(() => ({ status: 401, bodyText: 'invalid api key' }));
    const r = await runEvaluation({ setup: setupWith(t, { requestBudget: { groq: 50 }, keyRotation: true }), cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer'] });
    assert.equal(r.status, 'paused');
    assert.deepEqual(t.calls.map(c => c.envName).sort(), [...GROQ5].sort());
  });
  test('no secret in the store, the run record or the refusal output of the CLI', async () => {
    const s = store();
    const r = await runEvaluation({ setup: setupWith(mockTransport(ok)), cases: cases(1), storeFile: s, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    for (const x of [fs.readFileSync(s, 'utf8'), JSON.stringify(r)]) assert.doesNotMatch(x, /SECRET/);
    const guard = pathToFileURL(path.join(HERE, 'fixtures/fetchGuard.mjs')).href;
    const out = path.join(tmp, 'fg.txt');
    const p = spawnSync(process.execPath, ['--import', guard, path.join(AQUA, 'scripts/answer-eval.mjs'), '--limit', '1'], { cwd: AQUA, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, FETCH_GUARD_OUT: out, GROQ_API_KEY_1: gsk(1) } });
    assert.equal(p.status, 2, p.stderr);
    assert.match(p.stderr, /provider credentials are present in the process environment \(GROQ_API_KEY_1\)/);
    assert.doesNotMatch(`${p.stdout}${p.stderr}`, /SECRET/);
    assert.equal(Number(fs.readFileSync(out, 'utf8')), 0);
  });
});
