/**
 * ACIB v3 final founder decisions (2026-11-12): D-1 confidence-interval labels (method unchanged),
 * D-2 per-request ceiling 4,500 (daily and run budgets unchanged; pre-send refusal), D-3 filler
 * library rules. Synthetic fixtures only; no real dataset; the real freeze file is never written;
 * global fetch tripwire and child-process fetch guard (0 external requests).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analysePairs, CI_LABEL, P_LABEL, REPORTING_PURPOSE } from '../answer/pairedAnalysis.mjs';
import { createManager, estimateRequestTokens, RequestRejected, QuotaPaused } from '../providers/providerManager.mjs';
import { mockTransport } from '../providers/transports.mjs';
import { preflight } from '../providers/evalConfig.mjs';
import { zeroBudgetGate } from '../answer/evalRun.mjs';
import { validateDataset, PLAN, AUTHOR_DECLARATION, REVIEWER_DECLARATION, sha256 } from '../governance/acibV3Governance.mjs';
import { fillerFields, makeFiller, fillerMetadata } from './fixtures/acibV3Filler.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
const REPO = path.join(AQUA, '..');
const EX = 'C:/Users/dell/aquiplex-eval-example';
const FREEZE = path.join(AQUA, 'eval/datasets/acib.v3.FREEZE.json');
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error('network forbidden'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'no network request'); assert.equal(fs.existsSync(FREEZE), false, 'no freeze record written'); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acib-v3-founder-final-'));
const J = (fc = 2) => JSON.stringify({ factual_correctness: fc, grounding: 2, personalization: 2, temporal_accuracy: null, contradiction_handling: null, uncertainty: null, clarification_quality: 2, hallucination: false, hallucinated_claims: [], confidence: 0.9, notes: '' });

describe('D-1: per-regime 95% bootstrap intervals, clearly labelled; Holm-corrected significance', () => {
  test('the labels say exactly what the intervals and p-values are — and are not', () => {
    assert.match(CI_LABEL, /95% percentile bootstrap CI, computed separately for this regime/);
    assert.match(CI_LABEL, /not multiplicity-adjusted/); assert.match(CI_LABEL, /not a simultaneous interval/);
    assert.match(P_LABEL, /exact McNemar.*Holm-corrected across the two primary regimes/);
    assert.match(REPORTING_PURPOSE, /distinct purposes/);
  });
  test('every interval in the analysis output carries the per-regime label; the method block states both purposes', () => {
    const ds = { scenarios: [{ id: 's', category: 'personal', question: 'q', history: [{ text: 'I teach chemistry.' }], needs: [{ id: 'n', required: true, match: ['chemistry'] }] }] };
    const recs = ['A', 'H'].flatMap(a => [{ type: 'answer', caseId: 's@short', arm: a, text: 'chemistry' }, { type: 'judgement', caseId: 's@short', arm: a, text: J() }]);
    const r = analysePairs({ records: recs, ds, label: 'x', regime: 'short', datasetSha256: 'x', B: 200 });
    for (const blk of [r.primary, r.hallucination, r.sensitivityMissingAsIncorrect, r.judgeScore, r.promptChangedSubset.correct, r.noiseControl.judgeScore]) assert.equal(blk.ci95Label, CI_LABEL);
    assert.equal(r.primary.mcnemarExactPLabel, 'exact McNemar p-value for this regime alone (uncorrected)');
    assert.deepEqual(r.method.reporting, { significance: P_LABEL, intervals: CI_LABEL, purpose: REPORTING_PURPOSE });
  });
  test('the CLI prints the interval as per-regime and not multiplicity-adjusted, and the p-value as Holm-corrected', () => {
    const tag = `d1-${process.pid}`, RES = path.join(AQUA, 'eval/answer/results');
    const dev = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/datasets/acib.v2.dev.json'), 'utf8'));
    const recs = dev.scenarios.slice(0, 2).flatMap(s => ['A', 'H'].flatMap(a => [{ type: 'answer', caseId: `${s.id}@short`, arm: a, text: 'x' }, { type: 'judgement', caseId: `${s.id}@short`, arm: a, text: J() }]));
    fs.writeFileSync(path.join(RES, `${tag}.pairs.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
    try {
      const r = spawnSync(process.execPath, [path.join(AQUA, 'scripts/answer-analyze.mjs'), '--set', 'acib.v2.dev', '--labels', tag, '--bootstrap', '200'], { cwd: AQUA, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /95% CI \[[^\]]*\] pp \(per regime, not multiplicity-adjusted\)/);
      assert.match(r.stdout, /Holm-corrected across the two primary regimes/);
      assert.match(r.stdout, /^REPORTING \(D-1\): .*distinct purposes/m);
      const a = JSON.parse(fs.readFileSync(path.join(RES, `${tag}.analysis.json`), 'utf8'));
      assert.equal(a.primary[0].primary.mcnemarHolmPLabel, P_LABEL);
    } finally { for (const f of fs.readdirSync(RES).filter(x => x.startsWith(tag))) fs.rmSync(path.join(RES, f)); }
  });
  test('the specification never describes the per-regime intervals as simultaneous or multiplicity-adjusted', () => {
    const spec = fs.readFileSync(path.join(REPO, 'AQUA_ACIB_V3_ANALYSIS_SPEC.md'), 'utf8');
    assert.match(spec, /95% percentile bootstrap interval computed separately for each regime/);
    assert.match(spec, /Holm-corrected across the two primary regimes/);
    for (const line of spec.split('\n').filter(l => /simultaneous|multiplicity-adjusted/i.test(l))) assert.match(line, /\bnot\b|\bnever\b/i, `affirmative claim found: ${line.slice(0, 120)}`);
  });
});

describe('D-2: per-request ceiling 4,500; daily and per-run budgets unchanged', () => {
  const ex = f => JSON.parse(fs.readFileSync(`${EX}/${f}`, 'utf8'));
  test('every example config is consistent: 4,500 per request; the v3 daily group budget stays 100,000, per-run 100,000, 80 requests', () => {
    const v3 = ex('config-acib-v3.example.json');
    assert.deepEqual([v3.tokenBudget.perRequest.groq, v3.rateLimits.groq.maxRequestTokens, v3.rateLimits.groq.tokensPerMinute], [4500, 4500, 4500]);
    assert.deepEqual([v3.tokenBudget.group['unverified:groq'], v3.tokenBudget.run.groq, v3.requestBudget.groq, v3.rateLimits.groq.minIntervalMs], [100000, 100000, 80, 61000]);
    assert.deepEqual([v3.keyRotation, v3.waitOnRateLimit], [false, false]);
    const dg = ex('config-diagnostic-v2.example.json');
    assert.deepEqual([dg.tokenBudget.perRequest.groq, dg.rateLimits.groq.maxRequestTokens, dg.tokenBudget.run.groq, dg.tokenBudget.group['unverified:groq']], [4500, 4500, 70000, 100000]);
    const ep = ex('config.existing-pools.example.json');
    assert.deepEqual([ep.rateLimits.groq.maxRequestTokens, ep.rateLimits.gemini.maxRequestTokens], [4500, 4500]);
    assert.match(fs.readFileSync(path.join(AQUA, 'scripts/measure-prompt-sizes.mjs'), 'utf8'), /perRequestCap: 4500/);
  });
  const cfg = (over = {}) => ({
    evaluationOnly: true, credentialSource: 'production', allowProductionCredentials: true, credentialMode: 'existing-numbered-pools',
    founderDecision: { by: 'f', at: '2026-11-12', statement: 's' }, allowNonStandard: [], syntheticDatasets: ['d'], requestBudget: { groq: 80 }, keyRotation: false, waitOnRateLimit: false,
    rateLimits: { groq: { tokensPerMinute: 4500, maxRequestTokens: 4500, minIntervalMs: 61000 } },
    tokenBudget: { perRequest: { groq: 4500 }, run: { groq: 100000 }, group: { 'unverified:groq': 100000 }, ledgerFile: path.join(tmp, `l-${Math.random().toString(36).slice(2)}.jsonl`) },
    models: { answer: { provider: 'groq', model: 'openai/gpt-oss-120b', settings: { temperature: 0, max_tokens: 1500 } }, judge: { provider: 'groq', model: 'qwen/qwen3.8-27b', settings: { temperature: 0, max_tokens: 1024 } } },
    domains: [{ id: 'groq-org-personal', provider: 'groq', envNames: ['GROQ_API_KEY_1'], billing: 'free-tier-verified', billingEvidence: { method: 'console', by: 'f', at: '2026-11-12' } }],
    ...over,
  });
  const ENV = { GROQ_API_KEY_1: 'gsk_SYNTHETIC' + 'x'.repeat(30) };
  const msgOf = chars => [{ role: 'user', content: 'x'.repeat(chars) }];
  const clock = () => { let t = Date.parse('2026-11-12T10:00:00Z'); return { now: () => t, sleep: async ms => { t += ms; } }; };
  test('requests up to 4,500 estimated tokens are sent; 4,501 is refused BEFORE sending (never truncated)', async () => {
    assert.equal(estimateRequestTokens(msgOf(8628), 1500), 4400); assert.equal(estimateRequestTokens(msgOf(8928), 1500), 4500); assert.equal(estimateRequestTokens(msgOf(8931), 1500), 4501);
    const t = mockTransport(() => ({ status: 200, text: 'ok', usage: { prompt_tokens: 2000, completion_tokens: 100 } }));
    const c = clock();
    const m = createManager({ config: cfg(), env: ENV, transport: t, now: c.now, sleep: c.sleep });
    await m.request({ role: 'answer', datasetId: 'd', messages: msgOf(8628) });
    await m.request({ role: 'answer', datasetId: 'd', messages: msgOf(8928) });
    await assert.rejects(m.request({ role: 'answer', datasetId: 'd', messages: msgOf(8931) }), RequestRejected);
    assert.equal(t.calls.length, 2, 'the oversized request was never sent');
    assert.equal(t.calls[1].messages[0].content.length, 8928, 'prompts are sent unmodified (no truncation)');
  });
  test('the daily 100,000 group budget is unchanged: a larger admissible request does not raise daily consumption', async () => {
    const conf = cfg();
    fs.writeFileSync(conf.tokenBudget.ledgerFile, `${JSON.stringify({ day: '2026-11-12', group: 'unverified:groq', provider: 'groq', tokens: 96000, kind: 'reported' })}\n`);
    const t = mockTransport(() => ({ status: 200, text: 'ok' })); const c = clock();
    const m = createManager({ config: conf, env: ENV, transport: t, now: c.now, sleep: c.sleep });
    await assert.rejects(m.request({ role: 'answer', datasetId: 'd', messages: msgOf(8628) }), e => e instanceof QuotaPaused && e.detail.reason === 'group-token-budget');
    assert.equal(t.calls.length, 0);
  });
  test('consistency: a per-request cap above the per-minute share is refused; the 2× production margin still applies to the 100k group budget', () => {
    assert.throws(() => preflight(cfg({ rateLimits: { groq: { tokensPerMinute: 4000, maxRequestTokens: 4500, minIntervalMs: 61000 } } }), ENV), /exceeds rateLimits\.groq\.tokensPerMinute/);
    assert.doesNotThrow(() => preflight(cfg(), ENV));
    const now = Date.parse('2026-11-12T08:00:00Z');
    const g = remaining => () => zeroBudgetGate({ execute: true, config: { ...cfg(), productionUsageCheck: { date: '2026-11-12', by: 'f', method: 'console', remainingDailyTokens: remaining } }, datasetHash: 'd', env: { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, now });
    assert.throws(g(199999), /at least 2 × the largest group budget \(200000\)/);
    assert.doesNotThrow(g(200000));
  });
});

describe('D-3: filler library rules', () => {
  const scen = (p, cat, i) => { const id = `${p}-${cat}-${i}`, t = `${p}${cat.replace(/-/g, '')}x${i}`; const b = { id, category: cat, authors: ['Fixture Author A'], answerability: 'answerable', history: [{ text: `My locker code is ${t}.` }], question: `What is my locker code (${id})?`, needs: [{ id: 'n1', required: true, match: [t], evidence: ['locker code is'] }] };
    if (cat === 'negative') return { ...b, answerability: 'impersonal', needs: [], question: `Why is the sky blue (${id})?` };
    if (cat === 'missing') return { ...b, answerability: 'needs-clarification', needs: [], question: `Can I afford it (${id})?`, unknowns: [{ id: 'u', match: ['budget'] }] };
    if (cat === 'language-mismatch') return { ...b, languages: { question: 'en', evidence: 'es' }, history: [{ text: `Mi código de taquilla es ${t}.` }], needs: [{ id: 'n1', required: true, match: [t], evidence: ['digo de taquilla'] }] };
    if (cat === 'indirect-reference') return { ...b, history: [{ text: `My sister works at ${t}. She loves it.` }], question: `Where does she work (${id})?`, needs: [{ id: 'n1', required: true, match: [t], evidence: ['sister works at'] }], indirect: [{ phrase: 'she', resolves: 'n1' }] };
    return b; };
  const DS = (over = {}) => ({ ...fillerFields('ev', ['Fixture Author A']), scenarios: Object.entries(PLAN.categories).flatMap(([c, [e]]) => Array.from({ length: e }, (_, i) => scen('ev', c, i))), ...over });
  const errs = d => validateDataset(d, { role: 'eval' }).errors.join('\n');
  test('the plan encodes the D-3 rules, and a compliant fixture library passes', () => {
    assert.deepEqual(PLAN.filler, { minDistinctMessages: 300, minTopics: 8, minLengthRatio: 4, veryLongTargetChars: 60000 });
    assert.deepEqual(validateDataset(DS(), { role: 'eval' }).errors, []);
  });
  test('refused: too few or duplicate messages, uniform lengths, answer-bearing filler, missing or inaccurate metadata, no very-long target', () => {
    const f = makeFiller('ev');
    assert.match(errs(DS({ filler: f.slice(0, 120), fillerMetadata: fillerMetadata(f.slice(0, 120), ['Fixture Author A']) })), /at least 300 distinct/);
    const dup = [...f.slice(0, 319), f[0]];
    assert.match(errs(DS({ filler: dup, fillerMetadata: fillerMetadata(dup, ['Fixture Author A']) })), /duplicate messages/);
    const uniform = Array.from({ length: 320 }, (_, i) => `Uniform filler message number ${String(i).padStart(4, '0')}.`);
    assert.match(errs(DS({ filler: uniform, fillerMetadata: fillerMetadata(uniform, ['Fixture Author A']) })), /lengths are too uniform/);
    const leaky = [...f.slice(0, 319), 'By the way, my locker code is evpersonalx0 again.'];
    assert.match(errs(DS({ filler: leaky, fillerMetadata: fillerMetadata(leaky, ['Fixture Author A']) })), /answer-bearing patterns/);
    assert.match(errs(DS({ fillerMetadata: undefined })), /fillerMetadata required/);
    assert.match(errs(DS({ fillerMetadata: { ...fillerMetadata(f, ['Fixture Author A']), messageCount: 999 } })), /messageCount \(999\)/);
    assert.match(errs(DS({ fillerMetadata: { ...fillerMetadata(f, ['Fixture Author A']), includesSemanticallySimilarDistractors: false } })), /semantically/i);
    assert.match(errs(DS({ fillerMetadata: { ...fillerMetadata(f, ['Fixture Author A']), topics: ['one', 'two'] } })), /≥ 8 unrelated topics/);
    assert.match(errs(DS({ veryLongFillerTargetChars: undefined })), /veryLongFillerTargetChars ≥ 60000/);
  });
  test('freeze (dry run): evaluation filler must be written by evaluation authors, and must share nothing with the development filler', () => {
    const spec = path.join(REPO, 'AQUA_ACIB_V3_ANALYSIS_SPEC.md');
    const devScen = Object.entries(PLAN.categories).flatMap(([c, [, d]]) => Array.from({ length: d }, (_, i) => ({ ...scen('dv', c, i), authors: ['Fixture Dev D'] })));
    const write = (n, o) => { const p = path.join(tmp, n); fs.writeFileSync(p, JSON.stringify(o)); return p; };
    const evalFile = write('e.json', DS());
    const manifest = dev => ({ version: 'acib-3', founder: { name: 'Fixture Founder' }, priorResultsExposed: ['Fixture Founder'],
      evalAuthors: [{ name: 'Fixture Author A', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }, { name: 'Fixture Author B', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }],
      devAuthors: [{ name: 'Fixture Dev D' }], implementationAuthors: ['Fixture Engineer'], reviewer: { name: 'Fixture Reviewer R', signedAt: '2026-11-12', statement: REVIEWER_DECLARATION },
      successCriteriaConfirmedBy: 'Fixture Founder', analysisSpecSha256: sha256(fs.readFileSync(spec, 'utf8')), evalPath: evalFile, devPath: write(`d-${Math.random()}.json`, dev) });
    const run = m => { const mf = write(`m-${Math.random()}.json`, m); return spawnSync(process.execPath, [path.join(AQUA, 'scripts/acib-v3-freeze.mjs'), '--manifest', mf, '--scorer', path.join(AQUA, 'eval/answer/answerGraderV3.mjs'), '--analysis-spec', spec, '--dry-run'], { encoding: 'utf8' }); };
    const goodDev = { ...fillerFields('dv', ['Fixture Dev D']), scenarios: devScen };
    const ok = run(manifest(goodDev)); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /DRY RUN/);
    const sharedFiller = makeFiller('ev');
    const shared = run(manifest({ ...goodDev, filler: sharedFiller, fillerMetadata: fillerMetadata(sharedFiller, ['Fixture Dev D']) }));
    assert.equal(shared.status, 2); assert.match(shared.stderr, /share 320 message\(s\)/);
    const wrongAuthor = run(manifest({ ...goodDev, fillerMetadata: { ...goodDev.fillerMetadata, authors: ['Fixture Author A'] } }));
    assert.equal(wrongAuthor.status, 2); assert.match(wrongAuthor.stderr, /development filler must be authored by the development authors/);
    assert.equal(fs.existsSync(FREEZE), false);
  });
  test('the brief, declarations, template and specification state the D-3 requirements consistently; the very-long regime stays a stress test', () => {
    const brief = fs.readFileSync(path.join(REPO, 'AQUA_ACIB_V3_AUTHORING_BRIEF.md'), 'utf8');
    for (const re of [/At least 300 distinct messages/, /At least 8 unrelated topics/, /semantically similar but irrelevant/i, /No filler message may change the correct answer/, /keep exactly the same answer-bearing history/, /must not be constructed to help or hinder any system/, /\*\*separate\*\* library/, /fillerMetadata/, /separate stress test/, /never part of the main improvement result/]) assert.match(brief, re);
    assert.match(AUTHOR_DECLARATION, /filler conversations I wrote were written without knowledge of, or intent to favour, any particular system configuration/);
    const tpl = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/governance/acib-v3-manifest.template.json'), 'utf8'));
    assert.ok(tpl.evalAuthors.every(a => a.declaration === AUTHOR_DECLARATION), 'template carries the current declaration verbatim');
    assert.ok(fs.readFileSync(path.join(REPO, 'AQUA_ACIB_V3_DECLARATIONS.md'), 'utf8').includes(AUTHOR_DECLARATION));
    assert.match(fs.readFileSync(path.join(REPO, 'AQUA_ACIB_V3_ANALYSIS_SPEC.md'), 'utf8'), /Filler \(D-3\)/);
  });
});
