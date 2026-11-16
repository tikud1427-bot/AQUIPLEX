/**
 * Founder decisions C-1..C-6 (2026-11-12): meaningful-improvement rules, critical measures with raw
 * counts, the very-long stress sample, independence (no impersonation, no placeholders), live
 * execution still blocked, and the grader requirement that caution is never a factual failure.
 * Synthetic data only; the real freeze file is never written; global fetch tripwire (0 requests).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gradeAnswerV3 } from '../answer/answerGraderV3.mjs';
import { gradeAnswer } from '../answer/answerGrader.mjs';
import { isFactuallyCorrect, criticalMeasures, CRITICAL_MEASURES, SPEC, claimVerdict, analysePairs, frac } from '../answer/pairedAnalysis.mjs';
import { validateManifest, PLAN, AUTHOR_DECLARATION, REVIEWER_DECLARATION } from '../governance/acibV3Governance.mjs';
import { zeroBudgetGate, ZeroBudgetRefused } from '../answer/evalRun.mjs';
import { liveTransport, LiveTransportRefused } from '../providers/transports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
const REPO = path.join(AQUA, '..');
const RESULTS = path.join(AQUA, 'eval/answer/results');
const FREEZE = path.join(AQUA, 'eval/datasets/acib.v3.FREEZE.json');
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error('network forbidden'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'no network request'); assert.equal(fs.existsSync(FREEZE), false, 'the real freeze file was never written'); });

const J = ({ fc = 2, hall = false, conf = 0.9 } = {}) => ({ factual_correctness: fc, grounding: 2, personalization: 2, temporal_accuracy: null, contradiction_handling: null, uncertainty: null, clarification_quality: 2, hallucination: hall, hallucinated_claims: [], confidence: conf, notes: '' });
const grade = (s, a) => gradeAnswerV3(s, a, { sources: (s.history ?? []).map(h => h.text).join('\n') });
const arm = (s, answer, judge) => ({ answer, grade: grade(s, answer), judge, answerability: s.answerability });

// Scenarios for the five founder-specified grader cases.
const ANSWERABLE = { id: 'ans', category: 'personal', answerability: 'answerable', question: 'What subject do I teach?', history: [{ text: 'I teach chemistry in Leicester.' }], needs: [{ id: 'n', required: true, match: ['chemistry'] }] };
const CAVEAT = { id: 'cav', category: 'changing', answerability: 'answerable-with-caveat', question: 'What is my rent?', history: [{ text: 'My rent is 950 a month, though the landlord mentioned a review in spring.' }], needs: [{ id: 'n', required: true, match: ['950'] }] };
const UNANSWERABLE = { id: 'una', category: 'missing', answerability: 'unanswerable', question: "What was my grandmother's maiden name?", history: [{ text: 'My grandmother grew up in Cork.' }], needs: [], unknowns: [{ id: 'maiden', label: 'maiden name', match: ['maiden name|née|surname'] }] };
const AMBIGUOUS = { id: 'amb', category: 'missing', answerability: 'needs-clarification', question: 'Can we afford the flat?', history: [{ text: 'We found a flat for 240k.' }], needs: [], unknowns: [{ id: 'income', label: 'household income', match: ['income|earn|salary'] }, { id: 'deposit', label: 'deposit', match: ['deposit|savings'] }] };

describe('grader: caution is never a factual failure; dimensions stay distinct', () => {
  test('answerable question answered correctly', () => {
    const g = grade(ANSWERABLE, 'You teach chemistry.');
    assert.deepEqual([g.evidence_sufficient, g.required_facts_given, g.answerability_handling, g.factual_correctness], [true, 1, 1, 1]);
    assert.equal(isFactuallyCorrect(arm(ANSWERABLE, 'You teach chemistry.', J())), true);
  });
  test('…but abstaining on an ANSWERABLE question is not factually correct, even with no wrong statement', () => {
    const w = arm(ANSWERABLE, "I'm not sure what you teach.", J({ fc: 2 }));
    assert.equal(w.grade.required_facts_given, 0); assert.equal(isFactuallyCorrect(w), false);
  });
  test('answerable-with-caveat question answered with appropriate qualification', () => {
    assert.equal(grade(CAVEAT, 'Your rent is 950 a month, but it may change after the spring review.').answerability_handling, 1);
    assert.equal(grade(CAVEAT, 'Your rent is 950 a month.').answerability_handling, 0.5, 'correct but unqualified');
    assert.equal(isFactuallyCorrect(arm(CAVEAT, 'Your rent is 950 a month, but it may change after the spring review.', J())), true);
  });
  test('unanswerable question handled with appropriate uncertainty → NOT a factual failure', () => {
    const a = "You haven't told me your grandmother's maiden name, so I don't know it.";
    const g = grade(UNANSWERABLE, a);
    assert.deepEqual([g.evidence_sufficient, g.required_facts_given, g.unknown_asserted, g.answerability_handling], [false, null, 0, 1]);
    assert.equal(g.factual_correctness, null, 'the v1/v2 factual metric does not apply (no required facts) — never counted as 0');
    assert.equal(isFactuallyCorrect(arm(UNANSWERABLE, a, J({ fc: 2 }))), true);
  });
  test('ambiguous question answered with a necessary clarification → NOT a factual failure', () => {
    const a = 'It depends on your finances. What is your household income?';
    const g = grade(AMBIGUOUS, a);
    assert.deepEqual([g.evidence_sufficient, g.unknown_asserted, g.answerability_handling, g.questions_asked], [false, 0, 1, 1]);
    assert.equal(isFactuallyCorrect(arm(AMBIGUOUS, a, J({ fc: 2 }))), true);
    const m = criticalMeasures([{ caseId: 'amb@short', category: 'missing', scenario: AMBIGUOUS, arms: { A: arm(AMBIGUOUS, a, J()), H: arm(AMBIGUOUS, a, J()) } }], ['A', 'H']);
    assert.equal(m.find(x => x.id === 'clarification-when-missing').A.text, '1/1 (100.0%)');
  });
  test('an incorrect confident guess when evidence is missing fails — factual, answerability, uncertainty AND hallucination', () => {
    const guess = 'Her maiden name was O\'Brien, surname registered in 1931.';
    const g = grade(UNANSWERABLE, guess);
    assert.deepEqual([g.unknown_asserted, g.answerability_handling], [1, 0]);
    const w = arm(UNANSWERABLE, guess, J({ fc: 0, hall: true }));
    assert.equal(isFactuallyCorrect(w), false);
    const amb = grade(AMBIGUOUS, 'Yes. With your income of 85,000 you can easily afford it.');
    assert.deepEqual([amb.unknown_asserted, amb.answerability_handling], [1, 0]);
    const hm = CRITICAL_MEASURES.find(x => x.id === 'hallucination-unsupported-claims');
    assert.equal(hm.success(w), false);
  });
  test('the existing (v1/v2) grader scores are unchanged: its file hash and its outputs', () => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(AQUA, 'eval/answer/answerGrader.mjs'), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    assert.equal(sha, '9fd2495d705bdd069c834437b804bd70a856eef143d7efd10c51358b1231efda');
    for (const [s, a] of [[ANSWERABLE, 'You teach chemistry.'], [UNANSWERABLE, 'I do not know.'], [AMBIGUOUS, 'What is your income?']]) {
      const base = gradeAnswer(s, a, { sources: (s.history ?? []).map(h => h.text).join('\n') }), v3 = grade(s, a);
      for (const k of Object.keys(base)) assert.deepEqual(v3[k], base[k], `${s.id}.${k}`);
    }
  });
});

describe('C-2: critical measures, identifiers and raw counts', () => {
  test('six measures, ids as decided, each scoped on authoring-brief / grader identifiers that exist', () => {
    assert.deepEqual(SPEC.criticalMeasures, ['wrong-person-attribution', 'wrong-project-attribution', 'hallucination-unsupported-claims', 'answerability-uncertainty', 'clarification-when-missing', 'tempting-distractor-resistance']);
    for (const c of ['cross-person', 'cross-project', 'tempting']) assert.ok(PLAN.categories[c], `category ${c} is a PLAN category`);
    for (const a of ['answerable-with-caveat', 'unanswerable', 'needs-clarification']) assert.ok(PLAN.answerability.includes(a), a);
    const brief = fs.readFileSync(path.join(REPO, 'AQUA_ACIB_V3_AUTHORING_BRIEF.md'), 'utf8');
    for (const id of ['`cross-person`', '`cross-project`', '`tempting`', 'crossEntity', 'tempting[]', 'unknowns', 'unanswerable', 'needs-clarification', 'answerable-with-caveat']) assert.ok(brief.includes(id), `brief names ${id}`);
    const g = grade({ ...ANSWERABLE, tempting: [{ id: 't', match: ['x'] }], crossEntity: [{ id: 'c', forbid: ['y'] }], unknowns: [{ id: 'u', match: ['z'] }] }, 'a');
    for (const k of ['cross_entity_errors', 'tempting_mentions', 'unknown_asserted', 'answerability_handling', 'uncertainty_handling', 'ungrounded_figures']) assert.ok(k in g, `grader emits ${k}`);
    assert.deepEqual(Object.keys(PLAN.categories).length, 13, 'no category renamed or merged');
  });
  test('a decline of ≥ 10 pp is flagged, with numerator/denominator on both arms', () => {
    const T = { id: 't', category: 'tempting', answerability: 'answerable', question: 'Which gym do I use?', history: [{ text: 'I go to Pulse gym. My locker number is 12.' }], needs: [{ id: 'n', required: true, match: ['Pulse'] }], tempting: [{ id: 'lk', match: ['locker'] }] };
    const rows = Array.from({ length: 10 }, (_, i) => ({ caseId: `t${i}@long`, category: 'tempting', scenario: T, arms: {
      A: arm(T, 'Pulse gym.', J()), H: arm(T, i < 2 ? 'Pulse gym, locker 12.' : 'Pulse gym.', J()) } }));
    const m = criticalMeasures(rows, ['A', 'H']).find(x => x.id === 'tempting-distractor-resistance');
    assert.equal(m.A.text, '10/10 (100.0%)'); assert.equal(m.H.text, '8/10 (80.0%)'); assert.equal(m.riskDifferencePp, -20); assert.equal(m.flagged, true);
    const one = criticalMeasures(rows.slice(1), ['A', 'H']).find(x => x.id === 'tempting-distractor-resistance');
    assert.equal(one.H.text, '8/9 (88.9%)'); assert.equal(one.flagged, true, '−11.1 pp is flagged');
    assert.equal(frac(0, 0).text, 'not available', 'an empty scope is "not available", never 0 % or 100 %');
    assert.equal(frac(0, 0).pct, null);
  });
  test('an aggregate improvement cannot hide a hallucination or critical regression', () => {
    const fr = (k, n) => ({ k, n, text: `${k}/${n}` });
    const base = { regime: 'long', primary: { riskDifference: 0.09, ci95: [0.03, 0.15], mcnemarHolmP: 0.004, A: fr(120, 174), H: fr(136, 174) }, hallucination: { mcnemarExactP: 0.3, riskDifference: 0.03 } };
    const flag = id => [{ id, flagged: true, A: fr(160, 174), H: fr(140, 174), riskDifference: -0.115 }];
    assert.equal(claimVerdict([{ ...base, criticalMeasures: flag('hallucination-unsupported-claims') }], { independent: true }).verdict, 'not-claimable-hallucination');
    const v = claimVerdict([{ ...base, criticalMeasures: flag('wrong-person-attribution') }], { independent: true });
    assert.equal(v.verdict, 'not-claimable-critical-regression'); assert.deepEqual(v.criticalFlags.map(f => `${f.measure} ${f.A}→${f.H}`), ['wrong-person-attribution 160/174→140/174']);
    assert.equal(claimVerdict([{ ...base, criticalMeasures: [] }], { independent: true }).verdict, 'meaningful-improvement');
  });
  test('C-1: significant below +5 pp is not meaningful; ≥ +5 pp without evidence is inconclusive', () => {
    const fr = (k, n) => ({ k, n, text: `${k}/${n}` });
    const R = (rd, lo, p) => ({ regime: 'short', primary: { riskDifference: rd, ci95: [lo, rd + 0.04], mcnemarHolmP: p, A: fr(1, 2), H: fr(1, 2) }, hallucination: { mcnemarExactP: 1, riskDifference: 0 }, criticalMeasures: [] });
    assert.equal(claimVerdict([R(0.049, 0.004, 0.01)], { independent: true }).verdict, 'significant-below-meaningful');
    assert.equal(claimVerdict([R(0.05, 0.004, 0.01)], { independent: true }).verdict, 'meaningful-improvement', 'exactly +5 pp with significance');
    assert.equal(claimVerdict([R(0.07, -0.01, 0.09)], { independent: true }).verdict, 'inconclusive');
    assert.equal(claimVerdict([R(0.07, 0.01, 0.06)], { independent: true }).verdict, 'inconclusive', 'Holm p ≥ 0.05');
  });
});

describe('C-4: very-long stress sample', () => {
  const S = { id: 'v1', category: 'contradiction', answerability: 'answerable', question: 'When is the meeting?', history: [{ text: 'The meeting is on the 9th.' }], needs: [{ id: 'n', required: true, match: ['9th'] }], distractors: [{ id: 'd', match: ['dentist'] }] };
  const ds = { scenarios: [S] };
  const recs = regime => ['A', 'H'].flatMap(a => [{ type: 'answer', caseId: `v1@${regime}`, arm: a, text: a === 'H' && regime === 'very-long' ? 'The 9th, after the dentist.' : 'On the 9th.', usage: { prompt_tokens: regime === 'very-long' ? 3900 : 1400 } }, { type: 'judgement', caseId: `v1@${regime}`, arm: a, text: JSON.stringify(J()) }]);
  test('analysed as a stress test with per-arm diagnostics and raw counts, never as primary', () => {
    const r = analysePairs({ records: recs('very-long'), ds, label: 'vl', regime: 'very-long', datasetSha256: 'x', B: 200 });
    assert.equal(r.stressTest, true);
    assert.equal(r.stress.perArm.H.distractorContamination.text, '1/1 (100.0%)'); assert.equal(r.stress.perArm.A.distractorContamination.text, '0/1 (0.0%)');
    assert.equal(r.stress.perArm.A.contextBudget.meanPromptTokens, 3900);
    assert.match(r.stress.note, /never a confirmatory/);
  });
  test('the analysis CLI refuses a very-long label as primary, and reports it (with degradation vs long) as secondary', () => {
    const tag = `c4-${process.pid}`;
    const dev = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/datasets/acib.v2.dev.json'), 'utf8'));
    const ids = dev.scenarios.slice(0, 3).map(s => s.id);
    const mk = regime => ids.flatMap(id => ['A', 'H'].flatMap(a => [{ type: 'answer', caseId: `${id}@${regime}`, arm: a, text: 'answer', usage: { prompt_tokens: 1000 } }, { type: 'judgement', caseId: `${id}@${regime}`, arm: a, text: JSON.stringify(J()) }])).map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(RESULTS, `${tag}-long.pairs.jsonl`), mk('long'));
    fs.writeFileSync(path.join(RESULTS, `${tag}-vl.pairs.jsonl`), mk('very-long'));
    const run = argv => spawnSync(process.execPath, [path.join(AQUA, 'scripts/answer-analyze.mjs'), '--set', 'acib.v2.dev', '--bootstrap', '200', ...argv], { cwd: AQUA, encoding: 'utf8' });
    try {
      const bad = run(['--labels', `${tag}-vl`]);
      assert.equal(bad.status, 2); assert.match(bad.stderr, /stress sample: pass it with --secondary-labels/);
      const ok = run(['--labels', `${tag}-long`, '--secondary-labels', `${tag}-vl`]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /STRESS TEST \(C-4\)/); assert.match(ok.stdout, /stress · A: retrieval/);
      const a = JSON.parse(fs.readFileSync(path.join(RESULTS, `${tag}-long+${tag}-vl.analysis.json`), 'utf8'));
      assert.equal(a.secondary[0].stress.degradationVsBaseline.A.scenarios, 3);
      assert.equal(a.verdict.verdict, 'not-applicable');
      assert.match(ok.stdout, /primary \(paired factual correctness\): A \d+\/3 \(/, 'raw counts printed');
    } finally { for (const f of fs.readdirSync(RESULTS).filter(x => x.startsWith(tag))) fs.rmSync(path.join(RESULTS, f)); }
  });
});

describe('C-5: independence cannot be impersonated; the freeze stays blocked', () => {
  const OK = {
    version: 'acib-3', founder: { name: 'Fixture Founder' }, priorResultsExposed: ['Fixture Founder', 'Fixture Analyst'],
    evalAuthors: [{ name: 'Fixture Author A', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }, { name: 'Fixture Author B', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }],
    devAuthors: [{ name: 'Fixture Dev D' }], implementationAuthors: ['Fixture Engineer', 'AI implementation agent'],
    reviewer: { name: 'Fixture Reviewer R', signedAt: '2026-11-12', statement: REVIEWER_DECLARATION },
    successCriteriaConfirmedBy: 'Fixture Founder', analysisSpecSha256: 'c'.repeat(64), evalPath: path.join(os.tmpdir(), 'e.json'), devPath: 'd.json',
  };
  const errs = over => validateManifest({ ...OK, ...over }).errors.join('\n');
  test('a consistent manifest passes (synthetic fixture names only)', () => assert.deepEqual(validateManifest(OK).errors, []));
  test('the founder, anyone exposed to prior results, or an implementer cannot be an evaluation author or the reviewer', () => {
    assert.match(errs({ evalAuthors: [OK.evalAuthors[0], { ...OK.evalAuthors[1], name: 'Fixture Founder' }] }), /must be independent: fixture founder/);
    assert.match(errs({ evalAuthors: [OK.evalAuthors[0], { ...OK.evalAuthors[1], name: 'Fixture Analyst' }] }), /must be independent: fixture analyst/);
    assert.match(errs({ reviewer: { ...OK.reviewer, name: 'Fixture Founder' } }), /reviewer must be independent/);
    assert.match(errs({ reviewer: { ...OK.reviewer, name: 'AI implementation agent' } }), /reviewer must not be an implementation author/);
    assert.match(errs({ founder: undefined }), /founder\.name required/);
    assert.match(errs({ priorResultsExposed: undefined }), /priorResultsExposed\[\] required/);
  });
  test('placeholders and future dates are refused: no invented identities, signatures or dates', () => {
    assert.match(errs({ evalAuthors: [{ ...OK.evalAuthors[0], name: '<independent author 1>' }, { ...OK.evalAuthors[1], name: 'TBD' }] }), /is a placeholder/);
    assert.match(errs({ reviewer: { ...OK.reviewer, name: 'Reviewer' } }), /"Reviewer" is a placeholder/);
    assert.match(errs({ evalAuthors: [{ ...OK.evalAuthors[0], declaredAt: '2099-01-01' }, OK.evalAuthors[1]] }), /declaredAt is in the future/);
    assert.match(errs({ reviewer: { ...OK.reviewer, signedAt: '2099-01-01' } }), /signedAt is in the future/);
  });
  test('the repository template is refused, and the freeze CLI refuses it and writes nothing', () => {
    const tpl = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/governance/acib-v3-manifest.template.json'), 'utf8'));
    const v = validateManifest(tpl);
    assert.equal(v.ok, false); assert.ok(v.errors.filter(e => /placeholder/.test(e)).length >= 4);
    const r = spawnSync(process.execPath, [path.join(AQUA, 'scripts/acib-v3-freeze.mjs'), '--manifest', path.join(AQUA, 'eval/governance/acib-v3-manifest.template.json'), '--dry-run'], { encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stderr, /REFUSED/);
    assert.equal(fs.existsSync(FREEZE), false);
  });
});

describe('C-6: live execution stays blocked', () => {
  test('no live transport without the explicit switch; the v3 example config is refused as written', () => {
    assert.throws(() => liveTransport({ env: {} }), LiveTransportRefused);
    const ex = JSON.parse(fs.readFileSync('C:/Users/dell/aquiplex-eval-example/config-acib-v3.example.json', 'utf8'));
    assert.throws(() => zeroBudgetGate({ execute: true, config: ex, datasetHash: 'h', env: { AQUA_ANSWER_EVAL_APPROVED: 'yes' } }), ZeroBudgetRefused);
    assert.deepEqual(ex.domains.flatMap(d => d.envNames), ['GROQ_API_KEY_1'], 'GROQ_API_KEY_1 only');
    assert.equal(ex.tokenBudget.group['unverified:groq'], 100000);
    assert.equal(ex.keyRotation, false); assert.equal(ex.waitOnRateLimit, false);
  });
});
