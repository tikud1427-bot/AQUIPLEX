/**
 * Zero-budget integration (2026-11-11): answer-eval / answer-judge → evalRun →
 * provider manager → pair runner. Every provider is mocked; a global fetch tripwire
 * proves no network request in-process, and the CLI tests run under a preloaded
 * fetch guard that counts any non-loopback request. Synthetic credentials only.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runEvaluation, zeroBudgetGate, ZeroBudgetRefused, dryRunSetup, acibCases, mergeStore, parseEnvFile, REPO_ROOT } from '../answer/evalRun.mjs';
import { PreflightRefused, buildDomains } from '../providers/evalConfig.mjs';
import { mockTransport } from '../providers/transports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in this test file'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetchCalls, 0, 'no network request in-process'); });

const DS = 'synthetic-dataset-sha';
const tmpStore = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-int-')), 'pairs.jsonl');
const ev = { method: 'console', by: 'reviewer', at: '2026-11-11' };
function setupWith(transport, over = {}) {
  const env = { GROQ_API_KEY_1: `gsk_SECRET${'A'.repeat(20)}1`, GROQ_API_KEY_2: `gsk_SECRET${'A'.repeat(20)}2`, GEMINI_API_KEY: `AIza${'SECRET'.padEnd(35, 'x')}` };
  const config = {
    evaluationOnly: true, credentialSource: 'evaluation', allowProductionCredentials: false, allowNonStandard: [], syntheticDatasets: [DS],
    models: { answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 700 } }, judge: { provider: 'gemini', model: 'gemini-2.5-flash', settings: { temperature: 0, max_tokens: 400 } } },
    domains: [
      { id: 'groq-org', provider: 'groq', envNames: ['GROQ_API_KEY_1', 'GROQ_API_KEY_2'], verification: ev, billing: 'free-tier-verified', billingEvidence: ev },
      { id: 'gemini-proj', provider: 'gemini', envNames: ['GEMINI_API_KEY'], verification: ev, billing: 'free-tier-verified', billingEvidence: ev },
    ],
    ...over,
  };
  return { env, config, transport };
}
const JUDGE_OK = JSON.stringify({ factual_correctness: 2, grounding: 2, personalization: 1, temporal_accuracy: null, contradiction_handling: null, uncertainty: null, clarification_quality: 2, hallucination: false, hallucinated_claims: [], confidence: 0.9, notes: 'ok' });
const ok = text => ({ status: 200, text, usage: { prompt_tokens: 12, completion_tokens: 4 } });
const CASES = ['s1', 's2', 's3'].map(id => ({ caseId: id, datasetId: DS, arms: { A: [{ role: 'user', content: `${id} context A` }], H: async () => [{ role: 'user', content: `${id} context H` }] }, judge: (_arm, a) => [{ role: 'user', content: `You are grading an assistant… ANSWER: ${a}` }] }));

describe('every request goes through the manager', () => {
  test('answers and judgements: all calls via the injected transport, from configured credentials, with the configured models', async () => {
    const t = mockTransport(call => (call.provider === 'gemini' ? ok(JUDGE_OK) : ok('answer')));
    const r = await runEvaluation({ setup: setupWith(t), cases: CASES, storeFile: tmpStore(), arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r.status, 'complete');
    assert.equal(t.calls.length, 12, '6 answers + 6 judgements');
    assert.ok(t.calls.every(c => ['GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GEMINI_API_KEY'].includes(c.envName)));
    assert.equal(r.usage.reduce((n, u) => n + u.requests, 0), 12, 'the manager accounted for every request');
    assert.doesNotMatch(JSON.stringify(r), /SECRET/, 'the run record carries no credential value');
  });
});

describe('A/B model consistency', () => {
  test('both arms of every pair: identical model and generation settings', async () => {
    const t = mockTransport(call => (call.provider === 'gemini' ? ok(JUDGE_OK) : ok('answer')));
    await runEvaluation({ setup: setupWith(t), cases: CASES, storeFile: tmpStore(), arms: ['A', 'H'], phases: ['answer', 'judge'] });
    const answers = t.calls.filter(c => c.provider === 'groq');
    assert.ok(answers.every(c => c.model === 'openai/gpt-oss-120b' && JSON.stringify(c.settings) === JSON.stringify({ temperature: 0, max_tokens: 700 })));
    // Arm order within a case is randomised (seeded); every case still gets both arms, consecutively.
    const seen = answers.map(c => c.messages[0].content.split(' ').slice(0, 3).join(' '));
    assert.deepEqual([...seen].sort(), ['s1 context A', 's1 context H', 's2 context A', 's2 context H', 's3 context A', 's3 context H']);
    for (let i = 0; i < seen.length; i += 2) assert.equal(seen[i].split(' ')[0], seen[i + 1].split(' ')[0], 'both arms of a case run consecutively');
  });
  test('real pipeline prompts (ACIB, lazily built): arms differ in context only', async () => {
    const ds = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/datasets/acib.v2.dev.json'), 'utf8'));
    const { runScenario, closeAcib } = await import('../adapters/acibPipeline.mjs');
    const t = mockTransport(call => (call.provider === 'gemini' ? ok(JUDGE_OK) : ok('answer')));
    try {
      const cases = acibCases({ ds, datasetHash: DS, scenarios: ds.scenarios.slice(0, 1), armEnvs: { A: {}, H: { AQUA_HYBRID_CONTEXT: 'on' } }, regime: 'short', label: 'int', runScenario });
      const r = await runEvaluation({ setup: setupWith(t), cases, storeFile: tmpStore(), arms: ['A', 'H'], phases: ['answer'] });
      assert.equal(r.answered, 2);
      const [a, h] = t.calls.filter(c => c.provider === 'groq');
      assert.equal(a.model, h.model); assert.deepEqual(a.settings, h.settings);
      assert.match(a.messages[0].content, /AQUA SELF-KNOWLEDGE/, 'the real system prompt was sent');
    } finally { closeAcib(); }
  });
});

describe('quota exhaustion pauses — never a paid route', () => {
  test('answer quota exhausted → paused; nothing else is tried; resume completes without duplicates', async () => {
    const store = tmpStore();
    let exhausted = false, n = 0;
    const script = call => {
      if (call.provider === 'groq') { n++; if (n === 3) exhausted = true; if (exhausted) return { status: 429, bodyText: 'Rate limit reached on requests per day (RPD). Upgrade to Dev Tier at https://console.groq.com/settings/billing', headers: { 'retry-after': '3600' } }; }
      return call.provider === 'gemini' ? ok(JUDGE_OK) : ok('answer');
    };
    const t1 = mockTransport(script);
    const r1 = await runEvaluation({ setup: setupWith(t1), cases: CASES, storeFile: store, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r1.status, 'paused');
    assert.equal(r1.pausedAt, 's2');
    assert.ok(t1.calls.filter(c => c.provider === 'groq').every(c => c.model === 'openai/gpt-oss-120b'), 'no other answering model');
    assert.equal(t1.calls.filter(c => c.provider === 'groq').length, 3, 'the shared org quota was hit once, not rotated through its other key');
    // Later: quota reset (a new process — new manager), resume.
    exhausted = false; n = -100;
    const t2 = mockTransport(script);
    const r2 = await runEvaluation({ setup: setupWith(t2), cases: CASES, storeFile: store, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r2.status, 'complete');
    const recs = fs.readFileSync(store, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const answers = recs.filter(r => r.type === 'answer');
    assert.equal(answers.length, 6, 'exactly one answer per case and arm');
    assert.equal(new Set(answers.map(a => `${a.caseId}${a.arm}`)).size, 6);
    assert.equal(t2.calls.filter(c => c.provider === 'groq').length, 4, 'only the 4 missing answers (s2 A/H, s3 A/H) were requested');
  });
  test('billing / paid tier → run stops; no other key, provider or model', async () => {
    const t = mockTransport(() => ({ status: 402, bodyText: 'payment required' }));
    const r = await runEvaluation({ setup: setupWith(t), cases: CASES, storeFile: tmpStore(), arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r.status, 'stopped-billing');
    assert.equal(t.calls.length, 1);
  });
});

describe('resume and the judge queue', () => {
  test('judge quota exhausted → pairs queued, answering continues; a later judge-only run drains the queue without re-answering', async () => {
    const store = tmpStore();
    const t1 = mockTransport(call => (call.provider === 'gemini' ? { status: 429, bodyText: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded … per day"}}' } : ok('answer')));
    const r1 = await runEvaluation({ setup: setupWith(t1), cases: CASES, storeFile: store, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r1.status, 'complete-judging-queued');
    assert.equal(r1.answered, 6);
    assert.deepEqual(r1.judgeQueued, ['s1', 's2', 's3']);
    const t2 = mockTransport(call => (call.provider === 'gemini' ? ok(JUDGE_OK) : ok('SHOULD NOT BE CALLED')));
    const r2 = await runEvaluation({ setup: setupWith(t2), cases: CASES, storeFile: store, arms: ['A', 'H'], phases: ['judge'] });
    assert.equal(r2.status, 'complete');
    assert.equal(r2.judged, 6);
    assert.equal(t2.calls.filter(c => c.provider === 'groq').length, 0, 'no answer regenerated');
    const recs = fs.readFileSync(store, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type === 'judgement');
    assert.ok(recs.every(j => j.judgeModel === 'gemini/gemini-2.5-flash' && j.answerModel === 'groq/openai/gpt-oss-120b'), 'judge and answer identity recorded');
  });
  test('a changed answering model cannot finish a pair started with another', async () => {
    const store = tmpStore();
    const half = mockTransport(call => (call.messages[0].content.includes('context H') ? { status: 429, bodyText: 'requests per day (RPD)' } : ok('a')));
    await runEvaluation({ setup: setupWith(half), cases: CASES.slice(0, 1), storeFile: store, arms: ['A', 'H'], phases: ['answer'] });
    const s = setupWith(mockTransport(() => ok('x')));
    s.config.models.answer = { ...s.config.models.answer, model: 'openai/gpt-oss-20b' };
    const r = await runEvaluation({ setup: s, cases: CASES.slice(0, 1), storeFile: store, arms: ['A', 'H'], phases: ['answer'] });
    assert.deepEqual(r.refused.map(x => x.reason), ['model-mismatch']);
  });
  test('merge un-blinds from the store and grades; the judge never received an arm', async () => {
    const store = tmpStore();
    const t = mockTransport(call => (call.provider === 'gemini' ? ok(JUDGE_OK) : ok('answer')));
    const ds = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/datasets/acib.v2.dev.json'), 'utf8'));
    const cases = ds.scenarios.slice(0, 2).map(s => ({ caseId: `${s.id}@long`, datasetId: DS, arms: { A: [{ role: 'user', content: 'a' }], H: [{ role: 'user', content: 'h' }] }, judge: (_arm, ans) => [{ role: 'user', content: `You are grading an assistant… ${ans}` }] }));
    await runEvaluation({ setup: setupWith(t), cases, storeFile: store, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    const m = mergeStore({ storeFile: store, ds, arms: ['A', 'H'] });
    assert.deepEqual([m.aggregates.A.answers, m.aggregates.H.answers, m.aggregates.A.judged], [2, 2, 2]);
    assert.ok(t.calls.filter(c => c.provider === 'gemini').every(c => !/\bA\b|\bH\b|arm/.test(c.messages[0].content.replace(/You are grading an assistant…/, ''))));
  });
});

describe('refusal conditions', () => {
  const base = () => setupWith(null).config;
  const refuses = (over, re, extra = {}) => assert.throws(() => zeroBudgetGate({ execute: true, config: over === undefined ? undefined : { ...base(), ...over }, credentialsFile: path.join(os.tmpdir(), 'eval.env'), datasetHash: DS, env: { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, ...extra }), e => e instanceof ZeroBudgetRefused && re.test(e.message));
  test('no per-run approval', () => assert.throws(() => zeroBudgetGate({ execute: true, config: base(), credentialsFile: path.join(os.tmpdir(), 'e.env'), datasetHash: DS, env: {} }), /AQUA_ANSWER_EVAL_APPROVED/));
  test('no provider config / no credentials file', () => { refuses(undefined, /provider-config/); refuses({}, /credentials-env/, { credentialsFile: null }); });
  test('credentials from the repository (.env or any file inside it)', () => {
    refuses({}, /repository \.env is never used|inside the repository/, { credentialsFile: path.join(REPO_ROOT, '.env') });
    refuses({}, /inside the repository/, { credentialsFile: path.join(REPO_ROOT, 'aqua', 'some.env') });
  });
  test('production credentials', () => { refuses({ credentialSource: 'production' }, /credentialSource must be 'evaluation'/); refuses({ allowProductionCredentials: true }, /allowProductionCredentials/); });
  test('non-standard (AQ.) credentials opted in', () => refuses({ allowNonStandard: ['GEMINI_KEY_1'] }, /AQ\.-prefixed Gemini values\) are never used/));
  test('dataset not allow-listed as synthetic', () => refuses({ syntheticDatasets: ['other'] }, /not in syntheticDatasets/));
  test('judge identical to the answering model', () => refuses({ models: { answer: base().models.answer, judge: base().models.answer } }, /judge must be a different model/));
  test('free-tier verification is mandatory: unknown billing → refused before any request', async () => {
    const t = mockTransport(() => ok('x'));
    const s = setupWith(t); s.config.domains = s.config.domains.map(d => ({ ...d, billing: 'unknown' }));
    await assert.rejects(runEvaluation({ setup: s, cases: CASES, storeFile: tmpStore(), arms: ['A', 'H'], phases: ['answer'] }), PreflightRefused);
    assert.equal(t.calls.length, 0);
  });
  test('AQ.-prefixed values are excluded even if present in an evaluation credentials file', () => {
    const { domains, excluded } = buildDomains({ ...base(), domains: [] }, { GEMINI_KEY_1: 'AQ.SECRET-not-a-standard-key-value', GEMINI_API_KEY: `AIza${'x'.repeat(35)}` });
    assert.deepEqual(excluded.map(e => `${e.envName}:${e.reason}`), ['GEMINI_KEY_1:non-standard-format-not-opted-in']);
    assert.ok(!domains.some(d => d.credentials.some(c => c.envName === 'GEMINI_KEY_1')));
  });
  test('dry runs use synthetic setup only (no process.env credential is read)', () => {
    const s = dryRunSetup(DS);
    assert.deepEqual(Object.keys(s.env).sort(), ['GEMINI_API_KEY', 'GROQ_API_KEY_1']);
    assert.match(s.env.GROQ_API_KEY_1, /DRYRUN/);
    assert.equal(s.config.credentialSource, 'evaluation');
  });
  test('parseEnvFile', () => assert.deepEqual(parseEnvFile('# c\nA=1\nB="two"\n\nbad\n'), { A: '1', B: 'two' }));
});

describe('CLI refusals (child processes, fetch guard, exit 2, zero requests)', () => {
  const guard = pathToFileURL(path.join(HERE, 'fixtures/fetchGuard.mjs')).href;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-int-cli-'));
  const credFile = path.join(tmp, 'eval.env');
  fs.writeFileSync(credFile, `GROQ_API_KEY_1=gsk_SECRET${'B'.repeat(24)}\nGEMINI_API_KEY=AIza${'SECRET'.padEnd(35, 'y')}\n`);
  const evalHash = fs.readFileSync(path.join(AQUA, 'eval/datasets/acib.v2.eval.FROZEN.sha256'), 'utf8').trim().split(/\s+/)[0];
  const cfgFile = (over = {}) => { const f = path.join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify({ ...setupWith(null).config, syntheticDatasets: [evalHash], ...over })); return f; };
  const run = (script, extra, env = {}) => {
    const out = path.join(tmp, `fg-${Math.random().toString(36).slice(2)}.txt`);
    const r = spawnSync(process.execPath, ['--import', guard, path.join(AQUA, 'scripts', script), ...extra], { cwd: AQUA, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, FETCH_GUARD_OUT: out, AQUA_ANSWER_EVAL_APPROVED: '', AQUA_EVAL_LIVE_APPROVED: '', ...env } });
    return { ...r, external: Number(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 0) };
  };
  const cases = [
    ['no approval', ['--execute', '--limit', '1'], {}, /AQUA_ANSWER_EVAL_APPROVED/],
    ['no config/credentials', ['--execute', '--limit', '1'], { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, /provider-config/],
    ['the repository .env', () => ['--execute', '--limit', '1', '--provider-config', cfgFile(), '--credentials-env', path.join(REPO_ROOT, '.env')], { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, /never used for evaluation|inside the repository/],
    ['production credentials', () => ['--execute', '--limit', '1', '--provider-config', cfgFile({ credentialSource: 'production', allowProductionCredentials: true }), '--credentials-env', credFile], { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, /credentialSource must be 'evaluation'/],
    ['AQ. opt-in', () => ['--execute', '--limit', '1', '--provider-config', cfgFile({ allowNonStandard: ['GEMINI_KEY_1'] }), '--credentials-env', credFile], { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, /AQ\.-prefixed Gemini values\) are never used outside/],
    ['unknown billing (preflight before any live transport)', () => ['--execute', '--limit', '1', '--provider-config', cfgFile({ domains: setupWith(null).config.domains.map(d => ({ ...d, billing: 'unknown' })) }), '--credentials-env', credFile], { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, /not proof of free quota/],
    ['live transport not approved', () => ['--execute', '--limit', '1', '--provider-config', cfgFile(), '--credentials-env', credFile], { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, /AQUA_EVAL_LIVE_APPROVED/],
    ['a legacy priced flag', ['--price-in', '1'], {}, /zero-budget/],
    ['an invalid arm pair', ['--arms', 'A,A'], {}, /exactly two different arms/],
  ];
  for (const [name, argv, env, re] of cases) {
    test(`answer-eval refuses: ${name}`, () => {
      const r = run('answer-eval.mjs', typeof argv === 'function' ? argv() : argv, env);
      assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, re); assert.equal(r.external, 0);
      assert.doesNotMatch(`${r.stdout}${r.stderr}`, /SECRET/, 'no credential value printed');
    });
  }
  test('answer-judge refuses: no approval / legacy priced flag / unknown label', () => {
    for (const [argv, env, re] of [[['--label', 'x', '--price-in', '1'], {}, /zero-budget/], [['--label', 'no-such-label'], {}, /no pair store/], [['--label'], {}, /label is required/]]) {
      const r = run('answer-judge.mjs', argv, env);
      assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, re); assert.equal(r.external, 0);
    }
  });
});
