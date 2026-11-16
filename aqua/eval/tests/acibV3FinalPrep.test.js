/**
 * ACIB v3 final preparation (2026-11-12): verdict rules (every branch + precedence), critical-measure
 * denominators, the hallucination guardrail, the reviewer build helper, and the development-only
 * prompt-size measurement. Synthetic data; identities are labelled FIXTURES and run only against a
 * NON-canonical freeze record (never independent). The real freeze file is never written. Global
 * fetch tripwire; child processes preload the fetch guard (0 external requests).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fillerFields } from './fixtures/acibV3Filler.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimVerdict, VERDICT_PRECEDENCE, SPEC, criticalMeasures, harmCases, harmCounts, analysePairs, frac, HARM_TYPES } from '../answer/pairedAnalysis.mjs';
import { gradeAnswerV3 } from '../answer/answerGraderV3.mjs';
import { freezeRecord, sha256, PLAN, AUTHOR_DECLARATION, REVIEWER_DECLARATION } from '../governance/acibV3Governance.mjs';
import { prepareReviewer, ReviewerPrepareRefused } from '../governance/reviewerPrepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
const REPO = path.join(AQUA, '..');
const FREEZE = path.join(AQUA, 'eval/datasets/acib.v3.FREEZE.json');
const SPEC_FILE = path.join(REPO, 'AQUA_ACIB_V3_ANALYSIS_SPEC.md');
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error('network forbidden'); };
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'no network request'); assert.equal(fs.existsSync(FREEZE), false, 'the real freeze file was never written'); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acib-v3-final-'));
const fr = (k, n) => frac(k, n);

// ── 1. Verdict rules ─────────────────────────────────────────────────────────────
const R = (regime, rd, lo, holmP, { hallP = 1, hallRD = 0, flagged = [] } = {}) => ({ regime, primary: { riskDifference: rd, ci95: [lo, rd + 0.05], mcnemarHolmP: holmP, A: fr(100, 174), H: fr(110, 174) }, hallucination: { mcnemarExactP: hallP, riskDifference: hallRD }, criticalMeasures: flagged.map(id => ({ id, flagged: true, A: fr(20, 20), H: fr(16, 20), riskDifference: -0.2 })) });
const V = (rs, ind = true) => claimVerdict(rs, { independent: ind }).verdict;
describe('1. verdict rules — every branch, documented precedence', () => {
  test('the method constants are unchanged: α 0.05, MPI +5 pp, critical decline −10 pp, two primary regimes', () => {
    assert.equal(SPEC.alpha, 0.05); assert.equal(SPEC.minimumMeaningfulImprovement, 0.05); assert.equal(SPEC.criticalDeclineThreshold, -0.10);
    assert.deepEqual(SPEC.primaryRegimes, ['short', 'long']); assert.deepEqual(SPEC.stressRegimes, ['very-long']);
  });
  test('precedence is exactly the documented order, and the specification lists it in that order', () => {
    assert.deepEqual(VERDICT_PRECEDENCE, ['regression', 'not-claimable-hallucination', 'not-claimable-critical-regression', 'meaningful-improvement', 'significant-below-meaningful', 'inconclusive', 'no-detectable-difference']);
    const spec = fs.readFileSync(SPEC_FILE, 'utf8');
    const line = spec.split('\n').find(l => l.startsWith('**Precedence**'));
    assert.ok(line, 'the specification states the precedence explicitly');
    const pos = VERDICT_PRECEDENCE.map(v => line.indexOf(`\`${v}\``));
    assert.ok(pos.every(p => p > 0), 'every verdict is documented'); assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'in precedence order');
  });
  test('regression in EITHER regime wins, even when the other regime is a meaningful improvement', () => {
    assert.equal(V([R('short', 0.10, 0.04, 0.001), R('long', -0.06, -0.11, 0.03)]), 'regression');
    assert.equal(V([R('short', -0.06, -0.11, 0.03), R('long', 0.10, 0.04, 0.001)]), 'regression');
  });
  test('meaningful improvement needs, in ONE regime: Holm-significant + RD ≥ +5 pp + CI above zero; the other regime may be a non-significant decline', () => {
    assert.equal(V([R('short', 0.06, 0.01, 0.02), R('long', -0.03, -0.08, 0.4)]), 'meaningful-improvement');
    const both = claimVerdict([R('short', 0.06, 0.01, 0.02), R('long', 0.07, 0.02, 0.01)], { independent: true });
    assert.equal(both.verdict, 'meaningful-improvement'); assert.deepEqual(both.regimes.map(r => r.regime), ['short', 'long']);
  });
  test('guardrails block an otherwise meaningful improvement', () => {
    assert.equal(V([R('long', 0.08, 0.02, 0.01, { hallP: 0.02, hallRD: 0.04 })]), 'not-claimable-hallucination');
    assert.equal(V([R('long', 0.08, 0.02, 0.01, { flagged: ['hallucination-unsupported-claims'] })]), 'not-claimable-hallucination');
    for (const id of ['wrong-person-attribution', 'wrong-project-attribution', 'answerability-uncertainty', 'clarification-when-missing', 'tempting-distractor-resistance']) assert.equal(V([R('long', 0.08, 0.02, 0.01, { flagged: [id] })]), 'not-claimable-critical-regression', id);
    assert.equal(V([R('long', 0.08, 0.02, 0.01, { hallP: 0.3, hallRD: 0.02 })]), 'meaningful-improvement', 'a non-significant hallucination rise does not block (it is reported)');
  });
  test('significant but below +5 pp → significant-below-meaningful; ≥ +5 pp without sufficient evidence → inconclusive', () => {
    assert.equal(V([R('short', 0.04, 0.01, 0.01)]), 'significant-below-meaningful');
    assert.equal(V([R('short', 0.07, -0.01, 0.12)]), 'inconclusive', 'not significant after Holm');
    assert.equal(V([R('short', 0.07, -0.004, 0.04)]), 'inconclusive', 'significant, but the 95% CI is not above zero (procedures disagree at the edge)');
    assert.equal(V([R('short', 0.07, 0, 0.04)]), 'inconclusive', 'a CI lower bound of exactly 0 is not "above zero"');
  });
  test('short and long are NEVER averaged: +4 pp significant and +6 pp non-significant is not a meaningful improvement', () => {
    assert.equal(V([R('short', 0.04, 0.01, 0.01), R('long', 0.06, -0.02, 0.2)]), 'significant-below-meaningful');
  });
  test('no-detectable-difference otherwise; development evidence is not-applicable whatever the numbers', () => {
    assert.equal(V([R('short', 0.02, -0.03, 0.5), R('long', -0.01, -0.05, 0.8)]), 'no-detectable-difference');
    assert.equal(V([R('short', 0.30, 0.2, 0.0001)], false), 'not-applicable');
  });
});

// ── 2. Denominators and 3. hallucination guardrail ───────────────────────────────
const J = ({ fc = 2, hall = false, claims = [] } = {}) => ({ factual_correctness: fc, grounding: 2, personalization: 2, temporal_accuracy: null, contradiction_handling: null, uncertainty: null, clarification_quality: 2, hallucination: hall, hallucinated_claims: claims, confidence: 0.9, notes: '' });
const mkArm = (s, answer, judge) => ({ answer, judge, answerability: s.answerability, grade: gradeAnswerV3(s, answer, { sources: (s.history ?? []).map(h => h.text).join('\n') }) });
const CP = { id: 'cp', category: 'cross-person', answerability: 'answerable', question: 'Where does my sister work?', history: [{ text: 'My sister works at Mill Lane. My brother works at the docks.' }], needs: [{ id: 'n', required: true, match: ['Mill Lane'] }], crossEntity: [{ id: 'bro', forbid: ['docks'] }] };
const PERSONAL = { id: 'p', category: 'personal', answerability: 'answerable', question: 'What do I teach?', history: [{ text: 'I teach chemistry.' }], needs: [{ id: 'n', required: true, match: ['chemistry'] }] };
const MISSING = { id: 'm', category: 'missing', answerability: 'needs-clarification', question: 'Can I afford it?', history: [{ text: 'The flat is 240k.' }], needs: [], unknowns: [{ id: 'inc', match: ['income'] }] };
const row = (s, i, a, h) => ({ caseId: `${s.id}${i}@long`, category: s.category, scenario: s, arms: { A: a, H: h } });

describe('2. critical-measure denominators', () => {
  test('no eligible scenario → "not available" (never 0 % or 100 %), RD null, never flagged, no ids', () => {
    const ms = criticalMeasures([row(PERSONAL, 1, mkArm(PERSONAL, 'chemistry', J()), mkArm(PERSONAL, 'chemistry', J()))], ['A', 'H']);
    for (const id of ['wrong-person-attribution', 'wrong-project-attribution', 'clarification-when-missing', 'tempting-distractor-resistance']) {
      const m = ms.find(x => x.id === id);
      assert.deepEqual([m.n, m.available, m.A.text, m.H.text, m.riskDifference, m.flagged, m.eligibleCaseIds.length], [0, false, 'not available', 'not available', null, false, 0], id);
    }
  });
  test('the denominator is eligible complete pairs only; eligible case ids are listed; out-of-scope cases never count', () => {
    const rows = [row(CP, 1, mkArm(CP, 'Mill Lane.', J()), mkArm(CP, 'Mill Lane.', J())), row(CP, 2, mkArm(CP, 'Mill Lane.', J()), mkArm(CP, 'She works at the docks.', J({ fc: 0 }))), row(PERSONAL, 3, mkArm(PERSONAL, 'chemistry', J()), mkArm(PERSONAL, 'chemistry', J()))];
    const m = criticalMeasures(rows, ['A', 'H']).find(x => x.id === 'wrong-person-attribution');
    assert.deepEqual(m.eligibleCaseIds, ['cp1@long', 'cp2@long']);
    assert.equal(m.A.text, '2/2 (100.0%)'); assert.equal(m.H.text, '1/2 (50.0%)'); assert.equal(m.flagged, true);
    const all = criticalMeasures(rows, ['A', 'H']).find(x => x.id === 'hallucination-unsupported-claims');
    assert.equal(all.n, 3);
  });
  test('in-scope but ungradable pairs are excluded from the denominator and listed separately', () => {
    const noJudge = { ...mkArm(MISSING, 'What is your income?', null) };
    const rows = [row(MISSING, 1, mkArm(MISSING, 'What is your income?', J()), mkArm(MISSING, 'What is your income?', J())), row(MISSING, 2, mkArm(MISSING, 'x', J()), { ...noJudge, grade: { ...noJudge.grade, answerability_handling: null } })];
    const m = criticalMeasures(rows, ['A', 'H']).find(x => x.id === 'clarification-when-missing');
    assert.deepEqual([m.n, m.eligibleCaseIds, m.inScopeButUngradable], [1, ['m1@long'], ['m2@long']]);
  });
  test('the primary block with no complete pair is "not available" too', () => {
    const r = analysePairs({ records: [], ds: { scenarios: [PERSONAL] }, label: 'x', regime: 'short', datasetSha256: 'x', B: 100 });
    assert.equal(r.primary.A.text, 'not available'); assert.equal(r.primary.riskDifference, null);
  });
});

describe('3. hallucination guardrail — case-level visibility', () => {
  const HALLU = { id: 'h', category: 'personal', answerability: 'answerable', question: 'How much do I earn?', history: [{ text: 'I work at the depot.' }], needs: [], distractors: [] };
  const rows = [
    row(HALLU, 1, mkArm(HALLU, 'You work at the depot.', J()), mkArm(HALLU, 'You earn 52,000 a year at the depot.', J({ fc: 0, hall: true, claims: ['earns 52,000'] }))),
    row(MISSING, 2, mkArm(MISSING, 'What is your income?', J()), mkArm(MISSING, 'With your income of 85,000 you can afford it.', J({ fc: 0, hall: true }))),
    row(CP, 3, mkArm(CP, 'Mill Lane.', J()), mkArm(CP, 'She works at the docks.', J({ fc: 0 }))),
  ];
  test('every harm type is listed per case and arm (invented fact with claims, unsupported figure, missing fact as known, wrong person)', () => {
    const cs = harmCases(rows, ['A', 'H']);
    const types = cs.map(c => `${c.caseId}/${c.arm}/${c.type}`).sort();
    assert.deepEqual(types, ['cp3@long/H/wrong-person-attribution', 'h1@long/H/invented-personal-fact', 'h1@long/H/unsupported-figure', 'm2@long/H/invented-personal-fact', 'm2@long/H/missing-fact-presented-as-known', 'm2@long/H/unsupported-figure'].sort());
    assert.deepEqual(cs.find(c => c.caseId === 'h1@long' && c.type === 'invented-personal-fact').claims, ['earns 52,000']);
    assert.ok(cs.every(c => c.arm === 'H'), 'arm A is clean');
    const counts = harmCounts(rows, ['A', 'H']);
    assert.equal(counts.H['invented-personal-fact'].text, '2/3 (66.7%)'); assert.equal(counts.A['invented-personal-fact'].text, '0/3 (0.0%)');
    assert.deepEqual(Object.keys(counts.H), [...HARM_TYPES]);
  });
  test('harm is attached to every verdict — including a meaningful improvement — so an aggregate cannot conceal it', () => {
    const base = R('long', 0.09, 0.03, 0.004);
    base.harm = { counts: harmCounts(rows, ['A', 'H']), cases: harmCases(rows, ['A', 'H']) };
    const v = claimVerdict([base], { independent: true });
    assert.equal(v.verdict, 'meaningful-improvement'); assert.equal(v.harm[0].cases, 6); assert.equal(v.harm[0].counts.H['wrong-person-attribution'].text, '1/3 (33.3%)');
    assert.equal(claimVerdict([base], { independent: false }).harm[0].cases, 6, 'also on development evidence');
  });
});

// ── 4. Reviewer build helper ─────────────────────────────────────────────────────
function scen(prefix, cat, i) {
  const id = `${prefix}-${cat}-${i}`, tag = `${prefix}${cat.replace(/-/g, '')}x${i}`;
  const base = { id, category: cat, authors: ['Fixture Author A'], answerability: 'answerable', history: [{ id: 'm1', conv: 'c-a', text: `My locker code is ${tag}.` }], question: `What is my locker code (${id})?`, needs: [{ id: 'n1', required: true, match: [tag], evidence: ['locker code is'] }] };
  if (cat === 'negative') return { ...base, answerability: 'impersonal', needs: [], question: `Why is the sky blue (${id})?` };
  if (cat === 'missing') return { ...base, answerability: 'needs-clarification', needs: [], question: `Can I afford the trip (${id})?`, unknowns: [{ id: 'u', label: 'budget', match: ['budget'] }] };
  if (cat === 'language-mismatch') return { ...base, languages: { question: 'en', evidence: 'es' }, history: [{ id: 'm1', conv: 'c-a', text: `Mi código de taquilla es ${tag}.` }], needs: [{ id: 'n1', required: true, match: [tag], evidence: ['digo de taquilla'] }] };
  if (cat === 'indirect-reference') return { ...base, history: [{ id: 'm1', conv: 'c-a', text: `My sister works at ${tag}. She loves it.` }], question: `Where does she work (${id})?`, needs: [{ id: 'n1', required: true, match: [tag], evidence: ['sister works at'] }], indirect: [{ phrase: 'she', resolves: 'n1' }] };
  return base;
}
const build = (prefix, role) => ({ id: `fixture-${prefix}`, ...fillerFields(prefix, prefix === 'ev' ? ['Fixture Author A'] : ['Fixture Dev D']), scenarios: Object.entries(PLAN.categories).flatMap(([cat, [e, d]]) => Array.from({ length: role === 'eval' ? e : d }, (_, i) => scen(prefix, cat, i))) });
const evalFile = path.join(tmp, 'fixture.v3.eval.json'), devFile = path.join(tmp, 'fixture.v3.dev.json');
fs.writeFileSync(evalFile, JSON.stringify(build('ev', 'eval'))); fs.writeFileSync(devFile, JSON.stringify(build('dv', 'dev')));
const SPEC_SHA = sha256(fs.readFileSync(SPEC_FILE, 'utf8'));
const MANIFEST = {
  version: 'acib-3', founder: { name: 'Fixture Founder' }, priorResultsExposed: ['Fixture Founder'],
  evalAuthors: [{ name: 'Fixture Author A', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }, { name: 'Fixture Author B', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }],
  devAuthors: [{ name: 'Fixture Dev D' }], implementationAuthors: ['Fixture Engineer'],
  reviewer: { name: 'Fixture Reviewer R', signedAt: '2026-11-12', statement: REVIEWER_DECLARATION },
  successCriteriaConfirmedBy: 'Fixture Founder', analysisSpecSha256: SPEC_SHA, evalPath: evalFile, devPath: devFile,
};
const manifestFile = path.join(tmp, 'manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify(MANIFEST));
const recordFor = m => freezeRecord({ manifest: m, evalText: fs.readFileSync(evalFile, 'utf8'), devText: fs.readFileSync(devFile, 'utf8'), scorerText: fs.readFileSync(path.join(AQUA, 'eval/answer/answerGraderV3.mjs'), 'utf8'), analysisSpecText: fs.readFileSync(SPEC_FILE, 'utf8') });
const freezeFile = path.join(tmp, 'fixture.FREEZE.json'); fs.writeFileSync(freezeFile, JSON.stringify(recordFor(MANIFEST)));
const base = () => ({ manifestFile, evalFile, resultsDir: path.join(tmp, `results-${Math.random().toString(36).slice(2)}`), reviewer: 'Fixture Reviewer R', specFile: SPEC_FILE, freezeFile });
const refusedWith = (over, re) => { try { prepareReviewer({ ...base(), ...over }); assert.fail('should refuse'); } catch (e) { assert.ok(e instanceof ReviewerPrepareRefused, e.message); assert.match(e.message, re); } };

describe('4. reviewer build helper', () => {
  test('synthetic fixture package: every check passes; dry run writes NOTHING; VALIDATION ONLY, never independent', () => {
    const o = base();
    const evalBefore = fs.readFileSync(evalFile);
    const r = prepareReviewer({ ...o, dryRun: true });
    assert.equal(r.ok, true); assert.equal(r.canonical, false); assert.match(r.banner, /VALIDATION ONLY/);
    assert.equal(r.prepared.independentEligible, false); assert.equal(r.prepared.validationOnly, true);
    assert.equal(fs.existsSync(o.resultsDir), false, 'dry run wrote nothing');
    assert.ok(r.checks.length >= 20 && r.checks.every(c => c.ok));
    assert.equal(r.prepared.providerConfigDatasetHash, sha256(evalBefore.toString('utf8')));
    assert.deepEqual(fs.readFileSync(evalFile), evalBefore, 'the evaluation file is byte-for-byte unchanged');
  });
  test('without --dry-run it creates only prepared.json and README.txt outside the repository; no secrets, no dataset content', () => {
    const o = base();
    const r = prepareReviewer({ ...o, dryRun: false });
    assert.deepEqual(fs.readdirSync(o.resultsDir).sort(), ['README.txt', 'prepared.json']);
    const text = fs.readFileSync(path.join(o.resultsDir, 'prepared.json'), 'utf8') + fs.readFileSync(path.join(o.resultsDir, 'README.txt'), 'utf8');
    assert.doesNotMatch(text, /gsk_|AIza|AQ\.|API_KEY|locker code/); assert.match(text, /VALIDATION ONLY/);
    assert.equal(r.writes.length, 2);
  });
  test('refusals: placeholder identity, future date, missing signature, reviewer mismatch, altered or development file, inside-repo or non-empty results, changed spec, manifest ≠ record, no freeze', () => {
    const write = m => { const f = path.join(tmp, `m-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(m)); return f; };
    refusedWith({ manifestFile: write({ ...MANIFEST, reviewer: { ...MANIFEST.reviewer, name: '<independent reviewer>' } }) }, /manifest valid/);
    refusedWith({ manifestFile: write({ ...MANIFEST, evalAuthors: [{ ...MANIFEST.evalAuthors[0], declaredAt: '2099-01-01' }, MANIFEST.evalAuthors[1]] }) }, /manifest valid/);
    refusedWith({ manifestFile: write({ ...MANIFEST, evalAuthors: [{ name: 'Fixture Author A' }, MANIFEST.evalAuthors[1]] }) }, /manifest valid/);
    refusedWith({ reviewer: 'Somebody Else' }, /--reviewer is the recorded reviewer/);
    const altered = path.join(tmp, 'altered.json'); fs.writeFileSync(altered, fs.readFileSync(evalFile, 'utf8') + '\n');
    refusedWith({ evalFile: altered }, /is the frozen evaluation set/);
    refusedWith({ evalFile: devFile }, /is NOT the development set|is the frozen evaluation set/);
    refusedWith({ resultsDir: path.join(AQUA, 'eval/answer/results') }, /results directory outside the repository/);
    const full = fs.mkdtempSync(path.join(tmp, 'full-')); fs.writeFileSync(path.join(full, 'old.jsonl'), '{}');
    refusedWith({ resultsDir: full }, /absent or empty/);
    const spec2 = path.join(tmp, 'spec-changed.md'); fs.writeFileSync(spec2, fs.readFileSync(SPEC_FILE, 'utf8') + '\nedited after pre-registration\n');
    refusedWith({ specFile: spec2 }, /analysis spec unchanged/);
    refusedWith({ manifestFile: write({ ...MANIFEST, reviewer: { ...MANIFEST.reviewer, signedAt: '2026-11-11' } }) }, /sign-off date matches/);
    refusedWith({ freezeFile: path.join(tmp, 'none.json') }, /freeze record present/);
  });
  test('the development set is refused even when (wrongly) frozen as the eval file of a record', () => {
    const rec = recordFor(MANIFEST); rec.dev.sha256 = rec.eval.sha256;   // a record that would let the dev hash pass as eval
    const f = path.join(tmp, 'devconfused.FREEZE.json'); fs.writeFileSync(f, JSON.stringify(rec));
    refusedWith({ freezeFile: f }, /is NOT the development set/);
  });
  test('CLI: dry run exits 0 and prints every check; a refusal exits 2 and lists the failed checks', () => {
    const guard = pathToFileURL(path.join(HERE, 'fixtures/fetchGuard.mjs')).href;
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|GEMINI_KEY|GROQ|OPENROUTER|NVIDIA/i.test(k))), AQUA_V3_FREEZE_FILE: freezeFile, FETCH_GUARD_OUT: path.join(tmp, 'ext.txt') };
    const run = extra => spawnSync(process.execPath, ['--import', guard, path.join(AQUA, 'scripts/acib-v3-reviewer-prepare.mjs'), '--manifest', manifestFile, '--eval-file', evalFile, '--results-dir', path.join(tmp, 'cli-results'), '--dry-run', ...extra], { cwd: AQUA, encoding: 'utf8', env });
    const ok = run(['--reviewer', 'Fixture Reviewer R']);
    assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /VALIDATION ONLY/); assert.match(ok.stdout, /DRY RUN — nothing written/);
    assert.equal(fs.existsSync(path.join(tmp, 'cli-results')), false);
    const bad = run(['--reviewer', 'Someone']);
    assert.equal(bad.status, 2); assert.match(bad.stderr, /✗ --reviewer is the recorded reviewer/);
    assert.equal(fs.readFileSync(env.FETCH_GUARD_OUT, 'utf8'), '0');
  });
});

// ── 5. Prompt-size measurement (development only) ────────────────────────────────
describe('5. prompt-size measurement', () => {
  const guard = pathToFileURL(path.join(HERE, 'fixtures/fetchGuard.mjs')).href;
  const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|GEMINI_KEY|GROQ|OPENROUTER|NVIDIA|DATABASE_URL|MONGO/i.test(k))), AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_DATA_DIR: fs.mkdtempSync(path.join(tmp, 'data-')), FETCH_GUARD_OUT: path.join(tmp, `ext-m-${Math.random().toString(36).slice(2)}.txt`) });
  const run = (argv, e = env()) => ({ r: spawnSync(process.execPath, ['--import', guard, path.join(AQUA, 'scripts/measure-prompt-sizes.mjs'), ...argv], { cwd: AQUA, encoding: 'utf8', timeout: 300_000, env: e }), e });
  test('evaluation sets are refused', () => {
    for (const set of ['acib.v2.eval', 'acib.heldout.v1', 'acib.v3.eval']) { const { r } = run(['--set', set]); assert.equal(r.status, 2); assert.match(r.stderr, /not an allow-listed development set/); }
  });
  test('a development measurement uses the exact evaluation path, labels estimates, and reports per-scenario and summary statistics', () => {
    const out = path.join(tmp, 'm.json');
    const { r, e } = run(['--set', 'acib.v2.dev', '--regime', 'long', '--limit', '2', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.match(m.method, /Exact evaluation prompt path/); assert.match(m.method, /ESTIMATES/);
    assert.equal(m.perScenario.length, 4); assert.deepEqual(Object.keys(m.overall.promptChars), ['n', 'min', 'median', 'mean', 'p95', 'max']);
    assert.ok(m.largest.length > 0 && m.largest[0].id); assert.ok('overPerRequestCap_conservative' in m.risks);
    assert.equal(fs.readFileSync(e.FETCH_GUARD_OUT, 'utf8'), '0');
  });
});
