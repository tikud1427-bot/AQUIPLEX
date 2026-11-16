/**
 * ACIB v3 governance and grader readiness (2026-11-12): v3 grader, new categories, declarations,
 * freeze validation (dry run), reviewer-only mode end to end (VALIDATION freeze record), the
 * pre-registered claim rule, hallucination as a separate endpoint, and the daily production-usage
 * check. SYNTHETIC data only (no v3 dataset exists; no author or reviewer is appointed). The real
 * freeze file is never written. Global fetch tripwire (0 external requests).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fillerFields } from './fixtures/acibV3Filler.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest, validateDataset, freezeRecord, sha256, PLAN, AUTHOR_DECLARATION, REVIEWER_DECLARATION } from '../governance/acibV3Governance.mjs';
import { resolveReviewerDataset, ReviewerModeRefused } from '../governance/reviewerMode.mjs';
import { gradeAnswerV3, aggregateGradesV3 } from '../answer/answerGraderV3.mjs';
import { claimVerdict, analysePairs, SPEC } from '../answer/pairedAnalysis.mjs';
import { zeroBudgetGate, ZeroBudgetRefused } from '../answer/evalRun.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
const REPO = path.join(AQUA, '..');
const FREEZE = path.join(AQUA, 'eval/datasets/acib.v3.FREEZE.json');
const SPEC_FILE = path.join(REPO, 'AQUA_ACIB_V3_ANALYSIS_SPEC.md');
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error('network forbidden'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'no network request'); assert.equal(fs.existsSync(FREEZE), false, 'the real freeze file was never written'); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acib-v3-ready-'));

/** A synthetic scenario that satisfies every v3 rule for its category. */
function scen(prefix, cat, i) {
  const id = `${prefix}-${cat}-${i}`, tag = `${prefix}${cat.replace(/-/g, '')}x${i}`;
  const base = { id, category: cat, authors: [prefix === 'ev' ? 'Author One' : 'Dev Author'], answerability: 'answerable',
    history: [{ id: 'm1', conv: 'c-a', text: `My locker code is ${tag}.` }], question: `What is my locker code (${id})?`,
    needs: [{ id: 'n1', required: true, match: [tag], evidence: ['locker code is'] }] };
  if (cat === 'negative') return { ...base, answerability: 'impersonal', needs: [], question: `Why is the sky blue (${id})?`, distractors: [{ id: 'd', match: [tag] }] };
  if (cat === 'missing') return { ...base, answerability: 'needs-clarification', needs: [], question: `Can I afford the trip (${id})?`, unknowns: [{ id: 'u', label: 'budget', match: ['budget'] }] };
  if (cat === 'language-mismatch') return { ...base, languages: { question: 'en', evidence: 'es' }, history: [{ id: 'm1', conv: 'c-a', text: `Mi código de taquilla es ${tag}.` }], needs: [{ id: 'n1', required: true, match: [tag], evidence: ['digo de taquilla'] }] };
  if (cat === 'indirect-reference') return { ...base, history: [{ id: 'm1', conv: 'c-a', text: `My sister works at ${tag}. She loves it.` }], question: `Where does she work (${id})?`, needs: [{ id: 'n1', required: true, match: [tag], evidence: ['sister works at'] }], indirect: [{ phrase: 'she', resolves: 'n1' }] };
  if (cat === 'tempting') return { ...base, tempting: [{ id: 't', match: ['gym locker'] }] };
  return base;
}
const build = (prefix, role) => ({ id: `synthetic-${prefix}`, version: '3', ...fillerFields(prefix, prefix === 'ev' ? ['Author One'] : ['Dev Author']),
  scenarios: Object.entries(PLAN.categories).flatMap(([cat, [e, d]]) => Array.from({ length: role === 'eval' ? e : d }, (_, i) => scen(prefix, cat, i))) });
const EVAL = build('ev', 'eval'), DEV = build('dv', 'dev');
const evalFile = path.join(tmp, 'acib.v3.eval.json'), devFile = path.join(tmp, 'acib.v3.dev.json');
fs.writeFileSync(evalFile, JSON.stringify(EVAL)); fs.writeFileSync(devFile, JSON.stringify(DEV));
const SPEC_SHA = sha256(fs.readFileSync(SPEC_FILE, 'utf8'));
const MANIFEST = {
  version: 'acib-3',
  evalAuthors: [{ name: 'Author One', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }, { name: 'Author Two', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }],
  devAuthors: [{ name: 'Dev Author' }], implementationAuthors: ['Engine Author', 'AI agent'], founder: { name: 'Fixture Founder' }, priorResultsExposed: ['Fixture Founder', 'Engine Author'],
  reviewer: { name: 'Reviewer R', signedAt: '2026-11-12', statement: REVIEWER_DECLARATION },
  successCriteriaConfirmedBy: 'Founder, 2026-11-20', analysisSpecSha256: SPEC_SHA, evalPath: evalFile, devPath: devFile,
};
const freezeCli = (manifest, extra = ['--scorer', path.join(AQUA, 'eval/answer/answerGraderV3.mjs'), '--analysis-spec', SPEC_FILE, '--dry-run']) => {
  const mf = path.join(tmp, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(mf, JSON.stringify(manifest));
  return spawnSync(process.execPath, [path.join(AQUA, 'scripts/acib-v3-freeze.mjs'), '--manifest', mf, ...extra], { encoding: 'utf8' });
};

describe('1. dataset and manifest rules (new categories, declarations)', () => {
  test('a synthetic 174 / 62 set covering all 13 categories passes the builder checks', () => {
    assert.deepEqual(validateDataset(EVAL, { role: 'eval' }).errors, []);
    assert.deepEqual(validateDataset(DEV, { role: 'dev' }).errors, []);
  });
  test('language-mismatch, indirect-reference, clarification, impersonal and filler rules are enforced', () => {
    const bad = JSON.parse(JSON.stringify(EVAL));
    const lm = bad.scenarios.find(s => s.category === 'language-mismatch'); lm.languages = { question: 'en', evidence: 'en' };
    const ir = bad.scenarios.find(s => s.category === 'indirect-reference'); ir.indirect = [{ phrase: 'zzz', resolves: 'nope' }];
    const mi = bad.scenarios.find(s => s.category === 'missing'); mi.unknowns = [];
    const ng = bad.scenarios.find(s => s.category === 'negative'); ng.needs = [{ id: 'p', required: true, match: ['locker'], evidence: ['locker'] }];
    delete bad.filler;
    const e = validateDataset(bad, { role: 'eval' }).errors.join('\n');
    for (const re of [/two different language codes/, /indirect phrase "zzz"/, /resolves "nope" is not a need id/, /needs-clarification requires/, /impersonal scenario must have no required/, /filler\[\]/]) assert.match(e, re);
  });
  test('declarations must be verbatim and dated; dev authors must differ from eval authors and the reviewer; the spec hash is required', () => {
    assert.deepEqual(validateManifest(MANIFEST).errors, []);
    const e = validateManifest({ ...MANIFEST, evalAuthors: [{ ...MANIFEST.evalAuthors[0], declaration: 'I wrote some scenarios.' }, { name: 'Author Two', declaration: AUTHOR_DECLARATION }], devAuthors: [{ name: 'Author One' }], reviewer: { ...MANIFEST.reviewer, statement: 'Looks fine.' }, analysisSpecSha256: 'abc' }).errors.join('\n');
    for (const re of [/author declaration must be recorded verbatim/, /declaredAt must be a date/, /development authors must not be evaluation authors: author one/, /reviewer declaration, verbatim/, /analysisSpecSha256 required/]) assert.match(e, re);
    assert.match(validateManifest({ ...MANIFEST, devAuthors: [{ name: 'Reviewer R' }] }).errors.join(), /reviewer must not be a development author/);
  });
});

describe('2. freeze validation (dry run; the real freeze file is never written)', () => {
  test('a complete synthetic package passes every check and writes NOTHING', () => {
    const r = freezeCli(MANIFEST);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN — every check passed; NOTHING written/);
    assert.equal(fs.existsSync(FREEZE), false);
  });
  test('refused: analysis spec changed after pre-registration, no grader, eval set inside the repository, dev/eval overlap', () => {
    assert.match(freezeCli({ ...MANIFEST, analysisSpecSha256: 'b'.repeat(64) }).stderr, /does not match manifest\.analysisSpecSha256/);
    assert.match(freezeCli(MANIFEST, ['--analysis-spec', SPEC_FILE, '--dry-run']).stderr, /--scorer <v3 grader file> is required/);
    assert.match(freezeCli({ ...MANIFEST, evalPath: path.join(REPO, 'aqua/eval/datasets/acib.v3.eval.json') }).stderr, /must not be stored inside the repository/);
    const dup = JSON.parse(JSON.stringify(DEV)); dup.scenarios[0].question = EVAL.scenarios[0].question;
    const dupFile = path.join(tmp, 'dev-dup.json'); fs.writeFileSync(dupFile, JSON.stringify(dup));
    assert.match(freezeCli({ ...MANIFEST, devPath: dupFile }).stderr, /shares scenarios .* with the evaluation set/);
  });
  test('the freeze record carries the eval, dev, grader and analysis-spec hashes and the declarations', () => {
    const rec = freezeRecord({ manifest: MANIFEST, evalText: fs.readFileSync(evalFile, 'utf8'), devText: fs.readFileSync(devFile, 'utf8'), scorerText: 'grader', analysisSpecText: fs.readFileSync(SPEC_FILE, 'utf8') });
    assert.equal(rec.eval.count, 174); assert.equal(rec.dev.count, 62);
    assert.equal(rec.analysisSpec.sha256, SPEC_SHA); assert.equal(rec.analysisSpec.verified, true);
    assert.deepEqual(rec.evalAuthors.map(a => a.declaredAt), ['2026-11-12', '2026-11-12']);
    assert.equal(rec.eval.location, 'outside the repository (path withheld)');
  });
});

describe('3. v3 annotation grader', () => {
  const g = (s, a) => gradeAnswerV3(s, a, { sources: (s.history ?? []).map(h => h.text).join('\n') });
  const ans = { id: 'a', category: 'personal', answerability: 'answerable', question: 'q?', history: [{ text: 'My code is K9.' }], needs: [{ id: 'n', required: true, match: ['K9'] }] };
  test('answerable / answerable-with-caveat', () => {
    assert.equal(g(ans, 'Your code is K9.').answerability_handling, 1);
    assert.equal(g(ans, 'Your code is K9. Want me to save it?').answerability_handling, 0.5);
    assert.equal(g(ans, 'I am not sure.').answerability_handling, 0);
    const cav = { ...ans, answerability: 'answerable-with-caveat' };
    assert.equal(g(cav, 'It is K9, as of what you last mentioned.').answerability_handling, 1);
    assert.equal(g(cav, 'It is K9.').answerability_handling, 0.5);
  });
  test('needs-clarification: one targeted question = 1; untargeted = 0.5; nothing = 0', () => {
    const s = { id: 'm', category: 'missing', answerability: 'needs-clarification', question: 'Can I afford it?', history: [], needs: [], unknowns: [{ id: 'u', match: ['budget|income'] }] };
    assert.equal(g(s, 'It depends on your numbers. What is your monthly budget?').answerability_handling, 1);
    assert.equal(g(s, 'Could you tell me more?').answerability_handling, 0.5);
    assert.equal(g(s, 'Yes, go for it.').answerability_handling, 0);
  });
  test('impersonal, tempting, cross-entity, paraphrase, indirect and language-mismatch metrics', () => {
    const neg = { id: 'n', category: 'negative', answerability: 'impersonal', question: 'Why is the sky blue?', history: [{ text: 'I love my dog Rex.' }], needs: [], distractors: [{ id: 'd', match: ['Rex'] }] };
    assert.equal(g(neg, 'Rayleigh scattering.').answerability_handling, 1);
    assert.equal(g(neg, 'Like Rex, the sky… scattering.').answerability_handling, 0);
    const rich = { id: 'r', category: 'indirect-reference', answerability: 'answerable', question: 'Where does she work?', history: [{ text: 'My sister works at Mill Lane.' }],
      needs: [{ id: 'n1', required: true, match: ['Mill Lane'], paraphrase: true }], indirect: [{ phrase: 'she', resolves: 'n1' }],
      tempting: [{ id: 't', match: ['gym'] }], crossEntity: [{ id: 'x', forbid: ['your brother'] }] };
    const r1 = g(rich, 'She works at Mill Lane.');
    assert.deepEqual([r1.indirect_resolution, r1.paraphrase_recall, r1.tempting_mentions, r1.cross_entity_errors], [1, 1, 0, 0]);
    const r2 = g(rich, 'Your brother works at the gym.');
    assert.deepEqual([r2.indirect_resolution, r2.tempting_mentions, r2.cross_entity_errors], [0, 1, 1]);
    const lm = { id: 'l', category: 'language-mismatch', answerability: 'answerable', question: 'Where do I work?', history: [{ text: 'Trabajo en una panadería.' }], needs: [{ id: 'n', required: true, match: ['bakery|panader'] }] };
    assert.equal(g(lm, 'You work in a bakery.').language_mismatch_recall, 1);
    assert.equal(g(ans, 'K9').language_mismatch_recall, null);
  });
  test('v1/v2 metrics are unchanged (the v3 grader extends, never replaces), and aggregates include the v3 metrics', async () => {
    const { gradeAnswer } = await import('../answer/answerGrader.mjs');
    const base = gradeAnswer(ans, 'Your code is K9.', { sources: 'My code is K9.' });
    const v3 = g(ans, 'Your code is K9.');
    for (const k of Object.keys(base)) assert.deepEqual(v3[k], base[k], k);
    const agg = aggregateGradesV3([v3, g(ans, 'no idea')]);
    assert.equal(agg.answerability_handling, 0.5); assert.equal(agg.answerability_handling_n, 2);
  });
});

describe('4. pre-registered endpoints and claim rule', () => {
  test('primary = paired factual correctness; hallucination is a SEPARATE endpoint', () => {
    const J = (fc, hall) => JSON.stringify({ factual_correctness: fc, grounding: 2, personalization: 2, temporal_accuracy: null, contradiction_handling: null, uncertainty: null, clarification_quality: 2, hallucination: hall, hallucinated_claims: [], confidence: 0.9, notes: '' });
    const ds = { scenarios: [{ id: 's1', category: 'personal', question: 'q', history: [], needs: [] }] };
    const recs = [{ type: 'answer', caseId: 's1@short', arm: 'A', text: 'x' }, { type: 'answer', caseId: 's1@short', arm: 'H', text: 'x' }, { type: 'judgement', caseId: 's1@short', arm: 'A', text: J(2, false) }, { type: 'judgement', caseId: 's1@short', arm: 'H', text: J(2, true) }];
    const r = analysePairs({ records: recs, ds, label: 'x', regime: 'short', datasetSha256: 'x', B: 200 });
    assert.equal(r.primary.A_correct, 1); assert.equal(r.primary.H_correct, 1, 'a hallucinating but factually correct answer counts as correct in the PRIMARY endpoint');
    assert.equal(r.hallucination.A_hallucinated, 0); assert.equal(r.hallucination.H_hallucinated, 1);
  });
  const fr = (k, n) => ({ k, n, text: `${k}/${n}` });
  const R = (regime, rd, lo, holmP, { hallP = 1, hallRD = 0, flagged = [] } = {}) => ({ regime, primary: { riskDifference: rd, ci95: [lo, rd + 0.05], mcnemarHolmP: holmP, A: fr(100, 174), H: fr(110, 174) }, hallucination: { mcnemarExactP: hallP, riskDifference: hallRD }, criticalMeasures: flagged.map(id => ({ id, flagged: true, A: fr(8, 10), H: fr(6, 10), riskDifference: -0.2 })) });
  test('verdicts follow the specification exactly (C-1 / C-2 names)', () => {
    assert.equal(claimVerdict([R('short', 0.08, 0.02, 0.01), R('long', 0.01, -0.03, 0.6)], { independent: true }).verdict, 'meaningful-improvement');
    assert.equal(claimVerdict([R('short', 0.08, 0.02, 0.01, { flagged: ['tempting-distractor-resistance'] })], { independent: true }).verdict, 'not-claimable-critical-regression');
    assert.equal(claimVerdict([R('short', 0.08, 0.02, 0.01, { hallP: 0.01, hallRD: 0.06 })], { independent: true }).verdict, 'not-claimable-hallucination');
    assert.equal(claimVerdict([R('short', 0.08, 0.02, 0.01), R('long', -0.07, -0.12, 0.02)], { independent: true }).verdict, 'regression');
    assert.equal(claimVerdict([R('short', 0.03, 0.005, 0.04)], { independent: true }).verdict, 'significant-below-meaningful');
    assert.equal(claimVerdict([R('short', 0.08, -0.01, 0.06)], { independent: true }).verdict, 'inconclusive', '≥ +5 pp without statistical evidence');
    assert.equal(claimVerdict([R('short', 0.02, -0.01, 0.6)], { independent: true }).verdict, 'no-detectable-difference');
    assert.equal(claimVerdict([R('short', 0.30, 0.2, 0.0001)], { independent: false }).verdict, 'not-applicable', 'development evidence never yields a claim');
    assert.equal(SPEC.minimumMeaningfulImprovement, 0.05);
  });
});

describe('5. reviewer-only evaluation mode', () => {
  const recFile = path.join(tmp, 'validation.FREEZE.json');
  fs.writeFileSync(recFile, JSON.stringify(freezeRecord({ manifest: MANIFEST, evalText: fs.readFileSync(evalFile, 'utf8'), devText: fs.readFileSync(devFile, 'utf8'), scorerText: 'g', analysisSpecText: fs.readFileSync(SPEC_FILE, 'utf8') })));
  const resultsDir = fs.mkdtempSync(path.join(tmp, 'results-'));
  const ok = { datasetFile: evalFile, resultsDir, reviewer: 'Reviewer R', env: { AQUA_V3_REVIEWER_MODE: 'yes' }, freezeFile: recFile };
  test('every precondition is enforced', () => {
    const why = over => { try { resolveReviewerDataset({ ...ok, ...over }); return ''; } catch (e) { assert.ok(e instanceof ReviewerModeRefused); return e.message; } };
    assert.match(why({ env: {} }), /AQUA_V3_REVIEWER_MODE=yes/);
    assert.match(why({ reviewer: 'Someone Else' }), /--reviewer must name the reviewer/);
    assert.match(why({ resultsDir: path.join(AQUA, 'eval/answer/results') }), /--results-dir must be outside the repository/);
    assert.match(why({ datasetFile: path.join(AQUA, 'eval/datasets/acib.v2.eval.json') }), /must stay outside the repository/);
    const altered = path.join(tmp, 'altered.json'); fs.writeFileSync(altered, fs.readFileSync(evalFile, 'utf8') + ' ');
    assert.match(why({ datasetFile: altered }), /does not match the frozen sha256/);
    assert.match(why({ freezeFile: path.join(tmp, 'none.json') }), /no ACIB v3 freeze record/);
    const r = resolveReviewerDataset(ok);
    assert.equal(r.canonical, false); assert.match(r.banner, /VALIDATION ONLY/);
  });
  test('end to end (dry runs, mock transport): answers, judging, merge and analysis stay outside the repository and are never labelled independent', () => {
    const label = `v3-validation-${process.pid}`;
    const repoResultsBefore = fs.readdirSync(path.join(AQUA, 'eval/answer/results')).sort();
    const guard = pathToFileURL(path.join(HERE, 'fixtures/fetchGuard.mjs')).href;
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|GEMINI_KEY|GROQ|OPENROUTER|NVIDIA|DATABASE_URL|MONGO/i.test(k))), AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_DATA_DIR: fs.mkdtempSync(path.join(tmp, 'data-')), AQUA_V3_REVIEWER_MODE: 'yes', AQUA_V3_FREEZE_FILE: recFile, FETCH_GUARD_OUT: path.join(tmp, 'ext.txt') };
    const rv = ['--v3-dataset-file', evalFile, '--results-dir', resultsDir, '--reviewer', 'Reviewer R'];
    const run = (script, argv) => spawnSync(process.execPath, ['--import', guard, path.join(AQUA, 'scripts', script), ...argv, ...rv], { cwd: AQUA, encoding: 'utf8', timeout: 300_000, env });
    const a = run('answer-eval.mjs', ['--limit', '2', '--regime', 'short', '--arms', 'A,H', '--answers-only', '--label', label]);
    assert.equal(a.status, 3, a.stderr); assert.match(a.stdout, /VALIDATION ONLY/); assert.match(a.stdout, /answered 4 · judged 0/);
    assert.equal(fs.readFileSync(env.FETCH_GUARD_OUT, 'utf8'), '0');
    const j = run('answer-judge.mjs', ['--label', label, '--regime', 'short', '--arms', 'A,H']);
    assert.equal(j.status, 0, j.stderr); assert.match(j.stdout, /judged 4/);
    const m = run('answer-judge.mjs', ['--label', label, '--regime', 'short', '--arms', 'A,H', '--merge']);
    assert.equal(m.status, 0, m.stderr);
    const z = run('answer-analyze.mjs', ['--labels', label, '--bootstrap', '300']);
    assert.equal(z.status, 0, z.stderr);
    assert.match(z.stdout, /VALIDATION ONLY/); assert.match(z.stdout, /EVIDENCE: DEVELOPMENT/); assert.match(z.stdout, /VERDICT: not-applicable/);
    for (const f of [`${label}.pairs.jsonl`, `${label}.json`, `${label}.merged.json`, `${label}.analysis.json`]) assert.ok(fs.existsSync(path.join(resultsDir, f)), f);
    // Other test files run in parallel and use the repository results directory; none of THIS run's files may be there.
    assert.deepEqual(fs.readdirSync(path.join(AQUA, 'eval/answer/results')).filter(f => f.startsWith(label)), [], 'nothing of this run written to the repository results directory');
    void repoResultsBefore;
    const an = JSON.parse(fs.readFileSync(path.join(resultsDir, `${label}.analysis.json`), 'utf8'));
    assert.equal(an.independent, false); assert.equal(an.dataset.set, 'acib.v3.eval');
  });
});

describe('6. daily production-usage safety check (D-P2-5)', () => {
  const H = 'h';
  const cfg = over => ({ evaluationOnly: true, credentialSource: 'production', allowProductionCredentials: true, credentialMode: 'existing-numbered-pools', founderDecision: { by: 'f', at: '2026-11-12', statement: 's' }, allowNonStandard: [], syntheticDatasets: [H], tokenBudget: { group: { 'unverified:groq': 100000 } }, models: { answer: { provider: 'groq', model: 'a' }, judge: { provider: 'groq', model: 'b' } }, ...over });
  const gate = (c, now = Date.parse('2026-11-12T08:00:00Z')) => () => zeroBudgetGate({ execute: true, config: c, datasetHash: H, env: { AQUA_ANSWER_EVAL_APPROVED: 'yes' }, now });
  const check = { date: '2026-11-12', by: 'founder', method: 'Groq console usage page', remainingDailyTokens: 200000 };
  test('required, dated TODAY (UTC), and remaining quota ≥ 2 × the group budget', () => {
    assert.throws(gate(cfg()), e => e instanceof ZeroBudgetRefused && /productionUsageCheck/.test(e.message));
    assert.throws(gate(cfg({ productionUsageCheck: { ...check, date: '2026-11-11' } })), /\(today, UTC\)/);
    assert.throws(gate(cfg({ productionUsageCheck: { ...check, remainingDailyTokens: 150000 } })), /at least 2 × the largest group budget \(200000\)/);
    assert.doesNotThrow(gate(cfg({ productionUsageCheck: check })));
    assert.throws(gate(cfg({ productionUsageCheck: check }), Date.parse('2026-11-13T00:30:00Z')), /today, UTC/, 'a new UTC day needs a new check');
  });
});
