/**
 * Intelligence Evaluation Phase 2 (2026-11-12): seeded A/H order, hard token budgets (request, run,
 * quota group with a cross-run ledger), expanded human-review queue, paired statistical analysis
 * (effect sizes, CIs, exact tests, noise control, prompt-changed subset), stratified diagnostic sample.
 *
 * Synthetic credentials (every value carries SECRET); providers mocked; global fetch tripwire
 * (0 external requests); the real .env is never read.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runEvaluation, mergeStore } from '../answer/evalRun.mjs';
import { preflight } from '../providers/evalConfig.mjs';
import { createManager, RequestRejected, QuotaPaused, estimateRequestTokens } from '../providers/providerManager.mjs';
import { armOrder, DEFAULT_ORDER_SEED } from '../providers/pairRunner.mjs';
import { mockTransport } from '../providers/transports.mjs';
import { mcnemarExact, wilson, holm, signFlipP, bootstrapCI, analysePairs, DEV_LABEL, IND_LABEL } from '../answer/pairedAnalysis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
const RESULTS = path.join(AQUA, 'eval/answer/results');
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error('network forbidden'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'no network request'); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-phase2-'));
const gsk = n => `gsk_SECRET${String(n).padStart(2, '0')}${'z'.repeat(24)}`;
const POOL = { GROQ_API_KEY_1: gsk(1) };
const DS = 'synthetic-dataset-sha';
const ev = { method: 'console: Free plan, no payment method', by: 'founder', at: '2026-11-12' };
const ledger = () => path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.jsonl`);
const cfg = (over = {}) => ({
  evaluationOnly: true, credentialSource: 'production', allowProductionCredentials: true, credentialMode: 'existing-numbered-pools', productionUsageCheck: { date: new Date().toISOString().slice(0, 10), by: 'founder', method: 'console usage page', remainingDailyTokens: 1000000000 },
  founderDecision: { by: 'founder', at: '2026-11-12', statement: 'phase 2 tests' }, allowNonStandard: [], syntheticDatasets: [DS],
  requestBudget: { groq: 100 }, keyRotation: false, waitOnRateLimit: false,
  rateLimits: { groq: { tokensPerMinute: 1_000_000, minIntervalMs: 0 } },
  tokenBudget: { perRequest: { groq: 4000 }, run: { groq: 1_000_000 }, group: { 'unverified:groq': 1_000_000 }, ledgerFile: ledger() },
  models: { answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 1500 } }, judge: { provider: 'groq', model: 'qwen/qwen3.8-27b', settings: { temperature: 0, max_tokens: 1024 } } },
  domains: [{ id: 'groq-org', provider: 'groq', envNames: ['GROQ_API_KEY_1'], billing: 'free-tier-verified', billingEvidence: ev }],
  ...over,
});
const tb = (over = {}) => ({ ...cfg().tokenBudget, ...over });
const clock = (start = '2026-11-12T10:00:00Z') => { let t = Date.parse(start); return { now: () => t, sleep: async ms => { t += ms; }, advance: ms => { t += ms; } }; };
const J = ({ fc = 2, g = 2, p = 2, cq = 2, hall = false, conf = 0.9 } = {}) => JSON.stringify({ factual_correctness: fc, grounding: g, personalization: p, temporal_accuracy: null, contradiction_handling: null, uncertainty: null, clarification_quality: cq, hallucination: hall, hallucinated_claims: [], confidence: conf, notes: 'x' });
const MSG = [{ role: 'user', content: 'x'.repeat(3000) }];          // estimate 1000 + 8 + 16 + 1500 = 2524
const EST = estimateRequestTokens(MSG, 1500);
const cases = n => Array.from({ length: n }, (_, i) => ({ caseId: `c${i + 1}`, datasetId: DS, arms: { A: [{ role: 'user', content: `c${i + 1} A ${'x'.repeat(2990)}` }], H: [{ role: 'user', content: `c${i + 1} H ${'x'.repeat(2990)}` }] }, judge: () => [{ role: 'user', content: 'judge' }] }));
const store = () => path.join(tmp, `pairs-${Math.random().toString(36).slice(2)}.jsonl`);

describe('1. reproducible, recorded A/H order', () => {
  test('armOrder is deterministic per (seed, case), changes with the seed, and is balanced', () => {
    assert.deepEqual(armOrder(['A', 'H'], 'case-1', 's'), armOrder(['A', 'H'], 'case-1', 's'));
    const ids = Array.from({ length: 400 }, (_, i) => `k${i}`);
    const swapped = ids.filter(id => armOrder(['A', 'H'], id, DEFAULT_ORDER_SEED)[0] === 'H').length;
    assert.ok(swapped > 160 && swapped < 240, `${swapped}/400 H-first`);
    assert.ok(ids.some(id => armOrder(['A', 'H'], id, 'seed-1')[0] !== armOrder(['A', 'H'], id, 'seed-2')[0]));
  });
  test('the run follows the seeded order for answering AND judging, and records order and seed', async () => {
    const t = mockTransport(call => ({ status: 200, text: call.model === 'qwen/qwen3.8-27b' ? J() : 'answer', usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const sf = store();
    const r = await runEvaluation({ setup: { env: POOL, config: cfg({ orderSeed: 'phase2-seed' }), transport: t }, cases: cases(6), storeFile: sf, arms: ['A', 'H'], phases: ['answer', 'judge'] });
    assert.equal(r.orderSeed, 'phase2-seed');
    const recs = fs.readFileSync(sf, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    for (const c of cases(6)) {
      const expected = armOrder(['A', 'H'], c.caseId, 'phase2-seed');
      const ans = recs.filter(x => x.type === 'answer' && x.caseId === c.caseId);
      assert.deepEqual(ans.map(x => x.arm), expected, `${c.caseId} answer order`);
      assert.ok(ans.every(x => x.orderSeed === 'phase2-seed' && JSON.stringify(x.armOrder) === JSON.stringify(expected)));
      assert.deepEqual(recs.filter(x => x.type === 'judgement' && x.caseId === c.caseId).map(x => x.arm), expected, `${c.caseId} judge order`);
      assert.ok(ans.every(x => typeof x.promptHashNormalised === 'string'));
    }
    assert.ok(cases(6).some(c => armOrder(['A', 'H'], c.caseId, 'phase2-seed')[0] === 'H'), 'at least one case runs H first');
  });
  test('the normalised prompt hash ignores the per-build random delimiter only', async () => {
    const { normalisedPromptHash } = await import('../providers/pairRunner.mjs');
    const m = id => [{ role: 'system', content: `ctx <<<UNTRUSTED-CONTENT ${id}>>> fact <<<END-UNTRUSTED-CONTENT ${id}>>>` }];
    assert.equal(normalisedPromptHash(m('Ab12')), normalisedPromptHash(m('Zz99')));
    assert.notEqual(normalisedPromptHash(m('Ab12')), normalisedPromptHash([{ role: 'system', content: 'ctx <<<UNTRUSTED-CONTENT Ab12>>> other fact <<<END-UNTRUSTED-CONTENT Ab12>>>' }]));
  });
});

describe('2. hard token budgets', () => {
  const ok = () => ({ status: 200, text: 'answer', usage: { prompt_tokens: 900, completion_tokens: 100 } });
  test('per request: an estimate above tokenBudget.perRequest is rejected before sending', async () => {
    const t = mockTransport(ok);
    const m = createManager({ config: cfg({ tokenBudget: tb({ perRequest: { groq: EST - 1 } }) }), env: POOL, transport: t });
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), RequestRejected);
    assert.equal(t.calls.length, 0);
  });
  test('per run: the next request pauses when its estimate would cross the run budget (nothing sent)', async () => {
    const t = mockTransport(ok);
    // Charged per request = reported 1,000. Budget 2,000 + EST − 1: after 2 requests (2,000) the 3rd needs EST → refused.
    const m = createManager({ config: cfg({ tokenBudget: tb({ run: { groq: 2000 + EST - 1 } }) }), env: POOL, transport: t });
    await m.request({ role: 'answer', datasetId: DS, messages: MSG });
    await m.request({ role: 'answer', datasetId: DS, messages: MSG });
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), e => e instanceof QuotaPaused && e.detail.reason === 'run-token-budget');
    assert.equal(t.calls.length, 2);
    assert.equal(m.state().tokens.run.groq, 2000, 'provider-reported usage is charged');
  });
  test('per quota group: the daily group budget holds ACROSS runs via the ledger, and resets the next UTC day', async () => {
    const lf = ledger(); const c = clock();
    const conf = cfg({ tokenBudget: tb({ group: { 'unverified:groq': 2000 + EST - 1 }, ledgerFile: lf }) });
    const t1 = mockTransport(ok);
    const m1 = createManager({ config: conf, env: POOL, transport: t1, now: c.now, sleep: c.sleep });
    await m1.request({ role: 'answer', datasetId: DS, messages: MSG });
    await m1.request({ role: 'answer', datasetId: DS, messages: MSG });
    const t2 = mockTransport(ok);
    const m2 = createManager({ config: conf, env: POOL, transport: t2, now: c.now, sleep: c.sleep });   // a NEW run, same day
    await assert.rejects(m2.request({ role: 'answer', datasetId: DS, messages: MSG }), e => e instanceof QuotaPaused && e.detail.reason === 'group-token-budget' && e.resumeAt === Date.parse('2026-11-13T00:00:00Z'));
    assert.equal(t2.calls.length, 0);
    c.advance(24 * 3600 * 1000);
    const m3 = createManager({ config: conf, env: POOL, transport: t2, now: c.now, sleep: c.sleep });
    await m3.request({ role: 'answer', datasetId: DS, messages: MSG });
    assert.equal(t2.calls.length, 1, 'the next UTC day has a fresh group budget');
    const lines = fs.readFileSync(lf, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => `${l.day}:${l.group}:${l.tokens}:${l.kind}`), ['2026-11-12:unverified:groq:1000:reported', '2026-11-12:unverified:groq:1000:reported', '2026-11-13:unverified:groq:1000:reported']);
    assert.doesNotMatch(fs.readFileSync(lf, 'utf8'), /SECRET|gsk_/);
  });
  test('an attempt without reported usage (error) is charged its full estimate', async () => {
    const t = mockTransport(() => ({ status: 429, bodyText: 'Rate limit reached ... per day' }));
    const m = createManager({ config: cfg(), env: POOL, transport: t });
    await assert.rejects(m.request({ role: 'answer', datasetId: DS, messages: MSG }), QuotaPaused);
    assert.equal(m.state().tokens.run.groq, EST);
  });
  test('request caps and the immediate pause on any 429 are preserved with token budgets present', async () => {
    const t = mockTransport(() => ({ status: 429, bodyText: 'tokens per minute (TPM)', headers: { 'retry-after': '2' } }));
    const r = await runEvaluation({ setup: { env: POOL, config: cfg(), transport: t }, cases: cases(1), storeFile: store(), arms: ['A', 'H'], phases: ['answer'] });
    assert.equal(r.status, 'paused'); assert.equal(t.calls.length, 1);
    const t2 = mockTransport(ok);
    const r2 = await runEvaluation({ setup: { env: POOL, config: cfg({ requestBudget: { groq: 1 } }), transport: t2 }, cases: cases(2), storeFile: store(), arms: ['A', 'H'], phases: ['answer'] });
    assert.equal(r2.status, 'paused'); assert.equal(t2.calls.length, 1);
  });
  test('production pools refuse a config without every token budget (naming the effective group id)', () => {
    assert.throws(() => preflight(cfg({ tokenBudget: undefined }), POOL), e => /tokenBudget\.perRequest\.groq/.test(e.message) && /tokenBudget\.run\.groq/.test(e.message) && /tokenBudget\.group\["unverified:groq"\]/.test(e.message) && /ledgerFile/.test(e.message));
    assert.throws(() => preflight(cfg({ tokenBudget: tb({ group: { 'groq-org': 5000 } }) }), POOL), /group\["unverified:groq"\]/, 'unverified ownership → one shared group');
    assert.doesNotThrow(() => preflight(cfg(), POOL));
  });
});

describe('3. human-review queue', () => {
  const ds = { scenarios: ['s1', 's2', 's3', 's4', 's5', 's6'].map(id => ({ id, category: 'personal', question: 'What do I teach?', history: [{ id: 'm1', conv: 'c', text: 'I teach chemistry.' }], needs: [{ id: 'subject', required: true, match: ['chemistry'], evidence: [], slots: [] }] })) };
  const ans = (caseId, arm, text = 'You teach chemistry.') => ({ type: 'answer', caseId: `${caseId}@short`, arm, text });
  const jud = (caseId, arm, text) => ({ type: 'judgement', caseId: `${caseId}@short`, arm, judgeModel: 'groq/qwen', text });
  const write = recs => { const f = store(); fs.writeFileSync(f, recs.map(r => JSON.stringify(r)).join('\n') + '\n'); return f; };
  const f = write([
    ans('s1', 'A'), ans('s1', 'H'), jud('s1', 'A', J()), jud('s1', 'H', J()),                                   // agree, valid
    ans('s2', 'A'), ans('s2', 'H'), jud('s2', 'A', J()), jud('s2', 'H', J({ g: 1 })),                           // A/H disagreement
    ans('s3', 'A'), ans('s3', 'H'), jud('s3', 'A', 'not json'), jud('s3', 'H', J()),                            // malformed
    ans('s4', 'A'), ans('s4', 'H'), jud('s4', 'A', J({ conf: 0.4 })), jud('s4', 'H', J({ conf: 0.4 })),         // low confidence
    ans('s5', 'A', 'I do not know.'), ans('s5', 'H'), jud('s5', 'A', J({ fc: 2 })), jud('s5', 'H', J()),        // judge 2 vs deterministic 0
    ans('s6', 'A'), ans('s6', 'H'), jud('s6', 'A', J()), jud('s6', 'H', J()),
  ]);
  test('malformed, low-confidence, A/H disagreement and judge-vs-deterministic items are all queued', () => {
    const m = mergeStore({ storeFile: f, ds, arms: ['A', 'H'], reviewSampleRate: 0 });
    const has = (caseId, reason) => m.review.some(r => r.caseId === `${caseId}@short` && r.reason.startsWith(reason));
    assert.ok(has('s2', 'ah-disagreement')); assert.deepEqual(m.review.find(r => r.reason === 'ah-disagreement' && r.caseId === 's2@short').dimensions, ['grounding']);
    assert.ok(has('s3', 'malformed')); assert.ok(has('s4', 'low-confidence')); assert.ok(has('s5', 'judge-vs-deterministic'));
    assert.ok(!has('s1', 'ah-disagreement') && !has('s6', 'ah-disagreement'));
    assert.equal(m.reviewCounts['random-audit'] ?? 0, 0);
  });
  test('the random audit samples only otherwise-unqueued valid judgements, reproducibly by seed', () => {
    const all = mergeStore({ storeFile: f, ds, arms: ['A', 'H'], reviewSampleRate: 1, reviewSeed: 'x' });
    const audit = all.review.filter(r => r.reason === 'random-audit').map(r => `${r.caseId}|${r.arm}`).sort();
    // s3|H is valid (only s3|A was malformed), so it is eligible; every queued judgement is excluded.
    assert.deepEqual(audit, ['s1@short|A', 's1@short|H', 's3@short|H', 's5@short|H', 's6@short|A', 's6@short|H']);
    const a = mergeStore({ storeFile: f, ds, arms: ['A', 'H'], reviewSampleRate: 0.5, reviewSeed: 'seed-q' });
    const b = mergeStore({ storeFile: f, ds, arms: ['A', 'H'], reviewSampleRate: 0.5, reviewSeed: 'seed-q' });
    assert.deepEqual(a.review, b.review);
    assert.deepEqual(a.reviewSample, { rate: 0.5, seed: 'seed-q' });
  });
});

describe('4. paired statistics', () => {
  test('exact McNemar, Wilson, Holm and the exact sign-flip test match hand-computed values', () => {
    const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-12, `${x} ≈ ${y}`);
    near(mcnemarExact(5, 0), 0.0625);
    near(mcnemarExact(6, 0), 0.03125);
    assert.equal(mcnemarExact(0, 0), 1);
    assert.equal(mcnemarExact(3, 3), 1);
    assert.ok(Math.abs(mcnemarExact(10, 2) - 158 / 4096) < 1e-12);
    const [lo, hi] = wilson(0, 10); assert.equal(lo, 0); assert.ok(Math.abs(hi - 0.2775) < 1e-3);
    assert.deepEqual(holm([0.01, 0.04, 0.03]).map(x => Math.round(x * 1000) / 1000), [0.03, 0.06, 0.06]);
    assert.equal(signFlipP([1, 1, 1, 1, 1]), 2 / 32);
    assert.equal(signFlipP([0, 0]), 1);
  });
  test('bootstrap CIs are reproducible with the same seed', () => {
    const xs = [0, 1, 0, 1, 1, 0, 1, 1, 1, 0];
    const m = s => s.reduce((a, b) => a + b, 0) / s.length;
    assert.deepEqual(bootstrapCI(xs, m, { B: 2000, seed: 'k' }), bootstrapCI(xs, m, { B: 2000, seed: 'k' }));
  });

  // 12 scenarios: s1–s6 identical prompts (noise control), s7–s12 changed prompts.
  const ids = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
  const ds = { scenarios: ids.map((id, i) => ({ id, category: i < 6 ? 'personal' : 'missing', question: 'q', history: [{ id: 'm', conv: 'c', text: 'I teach chemistry.' }], needs: [{ id: 'n', required: true, match: ['chemistry'], evidence: [], slots: [] }] })) };
  const recs = [];
  const add = (id, arm, judge, hash) => { recs.push({ type: 'answer', caseId: `${id}@long`, arm, text: 'chemistry', promptHashNormalised: hash }); if (judge !== undefined) recs.push({ type: 'judgement', caseId: `${id}@long`, arm, text: judge }); };
  for (let i = 1; i <= 6; i++) { add(`s${i}`, 'A', J(), 'same'); add(`s${i}`, 'H', i === 6 ? J({ fc: 1 }) : J(), 'same'); }      // noise: 1 discordant of 6
  for (let i = 7; i <= 11; i++) { add(`s${i}`, 'A', J({ fc: 1 }), `a${i}`); add(`s${i}`, 'H', J(), `h${i}`); }                    // H wins 5
  add('s12', 'A', J(), 'a12'); add('s12', 'H', undefined, 'h12');                                                                  // H judgement missing
  const res = analysePairs({ records: recs, ds, label: 'unit', regime: 'long', datasetSha256: 'x', B: 2000 });

  test('primary: paired counts, risk difference, CI and exact McNemar on complete pairs', () => {
    assert.equal(res.counts.complete, 11); assert.equal(res.counts.missing, 1);
    assert.deepEqual(res.primary.discordant, { A_only: 1, H_only: 5 });
    assert.equal(res.primary.riskDifference, Math.round((4 / 11) * 10000) / 10000);
    assert.equal(res.primary.mcnemarExactP, Math.round(mcnemarExact(1, 5) * 10000) / 10000);
    assert.ok(res.primary.ci95[0] <= res.primary.riskDifference && res.primary.riskDifference <= res.primary.ci95[1]);
  });
  test('sensitivity counts the missing judgement as incorrect; missing cases are listed', () => {
    assert.equal(res.sensitivityMissingAsIncorrect.n, 12);
    assert.deepEqual(res.sensitivityMissingAsIncorrect.discordant, { A_only: 2, H_only: 5 });
    assert.deepEqual(res.missing, [{ caseId: 's12@long', A: 'ok', H: 'not-judged' }]);
  });
  test('noise control = identical-prompt cases, reported as a discordance rate; prompt-changed subset is descriptive only', () => {
    assert.equal(res.noiseControl.n, 6); assert.equal(res.noiseControl.discordant, 1);
    assert.equal(res.promptChangedSubset.n, 5);
    assert.equal('mcnemarExactP' in res.promptChangedSubset.correct, false, 'no p-value on the treatment-selected subset');
    assert.equal('signFlipP' in res.promptChangedSubset.judgeScore, false);
    assert.match(res.promptChangedSubset.note, /not an independent primary result/i);
  });
  test('effect sizes: mean score difference, dz and a sign-flip p are reported', () => {
    assert.equal(res.judgeScore.n, 11);
    assert.equal(res.judgeScore.meanDiff, Math.round(((5 - 1) / 11) * 10000) / 10000);
    assert.ok(Number.isFinite(res.judgeScore.dz) && Number.isFinite(res.judgeScore.signFlipP));
    assert.ok(res.categories.byCategory.personal && res.categories.byCategory.missing);
  });
  test('evidence is DEVELOPMENT unless the caller verified a v3 freeze', () => {
    assert.equal(res.evidence, DEV_LABEL); assert.equal(res.independent, false);
    assert.equal(analysePairs({ records: recs, ds, label: 'u', regime: 'long', datasetSha256: 'x', B: 200, independent: true }).evidence, IND_LABEL);
  });
});

describe('5. offline CLIs (child processes, 0 external requests)', () => {
  const guard = pathToFileURL(path.join(HERE, 'fixtures/fetchGuard.mjs')).href;
  const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|GEMINI_KEY|GROQ|OPENROUTER|NVIDIA|DATABASE_URL|MONGO/i.test(k))), AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_DATA_DIR: fs.mkdtempSync(path.join(tmp, 'data-')) });
  const cleanup = label => { for (const f of fs.readdirSync(RESULTS).filter(x => x.startsWith(label))) fs.rmSync(path.join(RESULTS, f)); };
  test('answer-analyze labels acib.v2 results DEVELOPMENT / REGRESSION EVIDENCE', () => {
    const label = `phase2-analyze-${process.pid}`;
    const dev = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/datasets/acib.v2.dev.json'), 'utf8'));
    const recs = dev.scenarios.slice(0, 4).flatMap(s => ['A', 'H'].flatMap(arm => [
      { type: 'answer', caseId: `${s.id}@short`, arm, text: 'answer', promptHashNormalised: 'p' },
      { type: 'judgement', caseId: `${s.id}@short`, arm, text: J() },
    ]));
    fs.writeFileSync(path.join(RESULTS, `${label}.pairs.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
    const out = path.join(tmp, 'ext-a.txt');
    try {
      const r = spawnSync(process.execPath, ['--import', guard, path.join(AQUA, 'scripts/answer-analyze.mjs'), '--set', 'acib.v2.dev', '--labels', label, '--bootstrap', '500'], { cwd: AQUA, encoding: 'utf8', env: { ...env(), FETCH_GUARD_OUT: out } });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^EVIDENCE: DEVELOPMENT \/ REGRESSION EVIDENCE — NOT INDEPENDENT/m);
      assert.match(r.stdout, /noise control \(identical prompts\): discordant 0\/4 \(0\.0%\)/, 'raw numerator/denominator (C-2)');
      const a = JSON.parse(fs.readFileSync(path.join(RESULTS, `${label}.analysis.json`), 'utf8'));
      assert.equal(a.independent, false); assert.equal(a.primary[0].counts.complete, 4); assert.equal(a.primary[0].counts.scenariosNeverRun, 36);
      assert.equal(a.verdict.verdict, 'not-applicable', 'development evidence never yields a claim');
      assert.match(r.stdout, /^VERDICT: not-applicable/m);
      assert.equal(fs.readFileSync(out, 'utf8'), '0');
    } finally { cleanup(label); }
  });
  test('answer-eval --sample-per-category draws a recorded, seeded, stratified sample; a different sample under the same label is refused', () => {
    const label = `phase2-sample-${process.pid}`;
    const run = (seed, extra = []) => spawnSync(process.execPath, ['--import', guard, path.join(AQUA, 'scripts/answer-eval.mjs'), '--set', 'acib.v2.dev', '--regime', 'short', '--arms', 'A,H', '--answers-only', '--sample-per-category', '1', '--sample-seed', seed, '--label', label, ...extra], { cwd: AQUA, encoding: 'utf8', timeout: 300_000, env: { ...env(), FETCH_GUARD_OUT: path.join(tmp, `ext-${seed}.txt`) } });
    try {
      const r = run('diag-seed-1');
      assert.equal(r.status, 3, r.stderr);
      const sample = JSON.parse(fs.readFileSync(path.join(RESULTS, `${label}.sample.json`), 'utf8'));
      const dev = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/datasets/acib.v2.dev.json'), 'utf8'));
      const cats = [...new Set(dev.scenarios.map(s => s.category))];
      assert.equal(sample.scenarioIds.length, cats.length);
      assert.deepEqual([...new Set(sample.scenarioIds.map(id => dev.scenarios.find(s => s.id === id).category))].sort(), cats.sort());
      assert.match(r.stdout, new RegExp(`answered ${cats.length * 2} · judged 0`));
      assert.equal(fs.readFileSync(path.join(tmp, 'ext-diag-seed-1.txt'), 'utf8'), '0');
      const again = run('another-seed');
      assert.equal(again.status, 2); assert.match(again.stderr, /different sample/);
    } finally { cleanup(label); }
  });
});
