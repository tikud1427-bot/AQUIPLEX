/**
 * Paired A/H statistical analysis (Phase 2, 2026-11-12; founder decisions C-1..C-4 applied).
 * OFFLINE ONLY: reads a pair store and the benchmark dataset; never calls a provider.
 * Specification: AQUA_ACIB_V3_ANALYSIS_SPEC.md (pre-registered).
 *
 * Unit of analysis: the CASE (scenario × regime); each case contributes one A and one H answer.
 *
 *   PRIMARY (per primary regime, complete pairs): PAIRED FACTUAL CORRECTNESS
 *     evidence sufficient (the scenario has required facts):
 *         correct = judge factual_correctness = 2 AND every required fact is given (deterministic)
 *     evidence insufficient (no required facts: missing / unanswerable / impersonal):
 *         correct = judge factual_correctness = 2 (no wrong statement) — a cautious answer or a
 *         necessary clarifying question is NOT a factual failure; a confident wrong guess is.
 *     effect: paired risk difference RD = (c − b)/n with case-level bootstrap 95% CI (seeded);
 *     test: exact McNemar; Holm across the two primary regimes.
 *   HARM: hallucination (judge flag), reported separately.
 *   CRITICAL MEASURES (C-2): six per-answer success measures; a decline of ≥ 10 pp is flagged.
 *   Every rate carries its raw numerator/denominator.
 *   SECONDARY: judge score (dz, sign-flip), deterministic metrics, noise control, prompt-changed
 *     subset (no p-values), categories (no tests), missing-data sensitivity.
 *   STRESS (C-4): the very-long sample — descriptive diagnostics only, never a confirmatory claim.
 *
 * Evidence class: 'independent' ONLY when the caller verified the canonical v3 freeze record for
 * this exact dataset; otherwise every output carries the DEVELOPMENT label and the verdict is
 * 'not-applicable'.
 */
import crypto from 'node:crypto';
import { parseJudgement } from './judgeRunner.mjs';
import { gradeAnswerV3 } from './answerGraderV3.mjs';

/**
 * C-2 critical measures. Identifiers are MEASURE ids; the dataset category ids they draw on
 * (cross-person, cross-project, tempting) are the authoring brief's / PLAN's, unchanged and unmerged.
 * scope(row) → does the case count; success(arm) → true | false | null (null = not gradable: excluded).
 */
export const CRITICAL_MEASURES = Object.freeze([
  { id: 'wrong-person-attribution', label: 'Wrong-person attribution', definition: 'cross-person scenarios: success = no other person\'s fact attributed to the subject (deterministic crossEntity.forbid) and judge factual_correctness = 2',
    scope: r => r.category === 'cross-person', success: w => (w.grade?.cross_entity_errors === 1 ? false : w.judge ? w.judge.factual_correctness === 2 : null) },
  { id: 'wrong-project-attribution', label: 'Wrong-project attribution', definition: 'cross-project scenarios: success = no other project\'s fact attributed (deterministic crossEntity.forbid) and judge factual_correctness = 2',
    scope: r => r.category === 'cross-project', success: w => (w.grade?.cross_entity_errors === 1 ? false : w.judge ? w.judge.factual_correctness === 2 : null) },
  { id: 'hallucination-unsupported-claims', label: 'Hallucination and unsupported personal claims', definition: 'all scenarios: success = judge hallucination = false AND no ungrounded figure (deterministic) AND no missing fact asserted as known',
    scope: () => true, success: w => (w.judge ? w.judge.hallucination === false && (w.grade?.ungrounded_figures ?? 0) === 0 && w.grade?.unknown_asserted !== 1 : null) },
  { id: 'answerability-uncertainty', label: 'Answerability and uncertainty handling', definition: 'scenarios annotated answerable-with-caveat or unanswerable, or with unknowns[]: success = answerability_handling = 1 (or uncertainty_handling = 1 when only unknowns are annotated)',
    scope: r => ['answerable-with-caveat', 'unanswerable'].includes(r.scenario?.answerability) || (r.scenario?.unknowns ?? []).length > 0,
    success: w => { const g = w.grade; if (!g) return null; const v = ['answerable-with-caveat', 'unanswerable', 'needs-clarification'].includes(w.answerability) ? g.answerability_handling : g.uncertainty_handling; return v == null ? null : v === 1; } },
  { id: 'clarification-when-missing', label: 'Clarification behaviour when essential information is missing', definition: 'needs-clarification scenarios: success = exactly one question targeting the missing information, and nothing invented (answerability_handling = 1)',
    scope: r => r.scenario?.answerability === 'needs-clarification', success: w => (w.grade?.answerability_handling == null ? null : w.grade.answerability_handling === 1) },
  { id: 'tempting-distractor-resistance', label: 'Tempting distractor resistance', definition: 'scenarios with tempting[] annotations (category tempting and any other): success = no tempting fact used (deterministic)',
    scope: r => (r.scenario?.tempting ?? []).length > 0, success: w => (w.grade?.tempting_mentions == null ? null : w.grade.tempting_mentions === 0) },
]);

/** Pre-registered parameters (founder decisions C-1, C-2, C-4; 2026-11-12). */
export const SPEC = Object.freeze({
  alpha: 0.05,
  minimumMeaningfulImprovement: 0.05,         // C-1: +5 percentage points paired risk difference (confirmed)
  criticalDeclineThreshold: -0.10,            // C-2: a critical measure declining by ≥ 10 pp is flagged
  criticalMeasures: Object.freeze(CRITICAL_MEASURES.map(m => m.id)),
  primaryRegimes: Object.freeze(['short', 'long']),
  stressRegimes: Object.freeze(['very-long']),  // C-4: descriptive only, never confirmatory
});

/**
 * D-1 (2026-11-12) reporting labels. The method is unchanged: significance is the exact McNemar test,
 * Holm-corrected across the two primary regimes; every confidence interval is a 95% percentile
 * bootstrap computed separately for its regime. The two serve distinct purposes and the intervals
 * are never described as simultaneous or multiplicity-adjusted.
 */
export const CI_LABEL = '95% percentile bootstrap CI, computed separately for this regime; not multiplicity-adjusted and not a simultaneous interval';
export const P_LABEL = 'exact McNemar p-value, Holm-corrected across the two primary regimes (family-wise α = 0.05)';
export const UNCORRECTED_P_LABEL = 'exact McNemar p-value for this regime alone (uncorrected)';
export const REPORTING_PURPOSE = 'The Holm-corrected p-value decides statistical significance across the two primary regimes; the per-regime 95% CI describes the size and precision of the effect within that regime. They serve distinct purposes.';

export const CORE = ['factual_correctness', 'grounding', 'personalization', 'clarification_quality'];
export const DEV_LABEL = 'DEVELOPMENT / REGRESSION EVIDENCE — NOT INDEPENDENT; must not be cited as evidence that H improves answers';
export const IND_LABEL = 'INDEPENDENT EVALUATION (frozen ACIB v3, independently authored and reviewed)';

/** Seeded PRNG (mulberry32) from a string seed. */
export function rng(seed) {
  let a = crypto.createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const lgamma = n => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };   // log(n!)
/** Exact two-sided binomial test, p = 0.5 (McNemar on discordant pairs). */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  const lf = lgamma(n);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(lf - lgamma(i) - lgamma(n - i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/** Wilson score interval for a proportion. */
export function wilson(k, n, z = 1.959963984540054) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, centre = (p + z * z / (2 * n)) / d, half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Percentile bootstrap CI of stat(sample) over units (resampled with replacement). */
export function bootstrapCI(units, stat, { B = 10000, seed = 'aqua-bootstrap-v1', alpha = 0.05 } = {}) {
  if (!units.length) return [null, null];
  const r = rng(seed), vals = new Array(B);
  for (let i = 0; i < B; i++) { const s = new Array(units.length); for (let j = 0; j < units.length; j++) s[j] = units[Math.floor(r() * units.length)]; vals[i] = stat(s); }
  vals.sort((x, y) => x - y);
  return [vals[Math.floor((alpha / 2) * B)], vals[Math.min(B - 1, Math.ceil((1 - alpha / 2) * B) - 1)]];
}

/** Two-sided sign-flip permutation test of mean(d) = 0. Exact for ≤ 16 non-zero differences. */
export function signFlipP(diffs, { B = 10000, seed = 'aqua-signflip-v1' } = {}) {
  const nz = diffs.filter(d => d !== 0);
  if (!nz.length) return 1;
  const obs = Math.abs(nz.reduce((s, d) => s + d, 0));
  let extreme = 0, total = 0;
  if (nz.length <= 16) {
    for (let mask = 0; mask < 2 ** nz.length; mask++) { let s = 0; for (let i = 0; i < nz.length; i++) s += (mask >> i) & 1 ? -nz[i] : nz[i]; if (Math.abs(s) >= obs - 1e-12) extreme++; total++; }
    return extreme / total;
  }
  const r = rng(seed);
  for (let i = 0; i < B; i++) { let s = 0; for (const d of nz) s += r() < 0.5 ? -d : d; if (Math.abs(s) >= obs - 1e-12) extreme++; }
  return (extreme + 1) / (B + 1);
}

/** Holm step-down adjustment; returns adjusted p-values in input order. */
export function holm(ps) {
  const idx = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(ps.length); let run = 0;
  idx.forEach(([p, i], rank) => { run = Math.max(run, Math.min(1, (ps.length - rank) * p)); out[i] = run; });
  return out;
}

const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const sd = xs => { if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };
const r4 = x => (x == null ? null : Math.round(x * 10000) / 10000);
/**
 * Raw count with its denominator and percentage — always shown together (C-2). A zero denominator
 * is "not available": never 0 % or 100 %, never a risk of zero.
 */
export const NOT_AVAILABLE = 'not available';
export const frac = (k, n) => (n
  ? { k, n, pct: Math.round((k / n) * 1000) / 10, available: true, text: `${k}/${n} (${(Math.round((k / n) * 1000) / 10).toFixed(1)}%)` }
  : { k: null, n: 0, pct: null, available: false, text: NOT_AVAILABLE });

/**
 * PRIMARY per-answer correctness (see header). `w` is one arm of a row.
 * Evidence insufficient → only "no wrong statement" is required, so caution is never a failure.
 */
export function isFactuallyCorrect(w) {
  if (!w?.judge) return false;
  if (w.judge.factual_correctness !== 2) return false;
  if (w.grade?.evidence_sufficient) return w.grade.required_facts_given === 1;
  return true;
}
const hallucinated = w => !!w?.judge && w.judge.hallucination === true;
const score = v => CORE.reduce((s, d) => s + (Number.isFinite(v?.[d]) ? v[d] : 0), 0);

/**
 * The pre-registered claim rule (AQUA_ACIB_V3_ANALYSIS_SPEC.md §5), applied to the PRIMARY regimes
 * only (each result must carry primary.mcnemarHolmP). Development evidence never yields a claim, and
 * the very-long stress sample is never passed here.
 *
 *   regression                          any primary regime: Holm p < α and RD < 0
 *   not-claimable-hallucination         an otherwise meaningful improvement, but hallucination rose
 *                                       significantly, or the hallucination critical measure is flagged
 *   not-claimable-critical-regression   an otherwise meaningful improvement, but another critical
 *                                       measure declined by ≥ 10 pp
 *   meaningful-improvement              a primary regime: Holm p < α, CI lower bound > 0 AND RD ≥ +5 pp;
 *                                       no hallucination increase; no critical-measure flag
 *   significant-below-meaningful        Holm p < α, 0 < RD < +5 pp — statistically significant, NOT meaningful
 *   inconclusive                        RD ≥ +5 pp in a primary regime without sufficient statistical evidence
 *   no-detectable-difference            otherwise
 */
/** Verdict precedence (first match wins). Exported so documentation and tests use the same list. */
export const VERDICT_PRECEDENCE = Object.freeze([
  'regression', 'not-claimable-hallucination', 'not-claimable-critical-regression', 'meaningful-improvement',
  'significant-below-meaningful', 'inconclusive', 'no-detectable-difference',
]);

export function claimVerdict(results, { independent }) {
  const harm = harmSummary(results);
  if (!independent) return { verdict: 'not-applicable', reason: 'DEVELOPMENT / REGRESSION EVIDENCE: no improvement claim is ever made from it', harm };
  const { alpha, minimumMeaningfulImprovement: mpi } = SPEC;
  // Each regime is judged on its OWN result; short and long are never averaged together.
  const sig = r => r.primary.mcnemarHolmP != null && r.primary.mcnemarHolmP < alpha;
  const regress = results.filter(r => sig(r) && r.primary.riskDifference < 0);
  const meaningful = results.filter(r => sig(r) && r.primary.riskDifference > 0 && r.primary.ci95[0] != null && r.primary.ci95[0] > 0 && r.primary.riskDifference >= mpi);
  const small = results.filter(r => sig(r) && r.primary.riskDifference > 0 && r.primary.riskDifference < mpi);
  // Practical threshold reached but statistical evidence insufficient: not significant after Holm,
  // OR significant but the 95% CI does not lie above zero (the two procedures can disagree at the edge).
  const largeNotSig = results.filter(r => r.primary.riskDifference != null && r.primary.riskDifference >= mpi && !meaningful.includes(r));
  const flags = results.flatMap(r => (r.criticalMeasures ?? []).filter(m => m.flagged).map(m => ({ regime: r.regime, measure: m.id, A: m.A.text, H: m.H.text, riskDifference: m.riskDifference })));
  const hallFlag = results.filter(r => r.hallucination.mcnemarExactP < alpha && r.hallucination.riskDifference > 0).map(r => r.regime);
  const hallMeasure = flags.filter(f => f.measure === 'hallucination-unsupported-claims');
  const otherFlags = flags.filter(f => f.measure !== 'hallucination-unsupported-claims');
  const regimes = rs => rs.map(r => ({ regime: r.regime, riskDifference: r.primary.riskDifference, ci95: r.primary.ci95, holmP: r.primary.mcnemarHolmP, A: r.primary.A.text, H: r.primary.H.text, meaningfulConfirmed: r.primary.ci95[0] >= mpi }));
  const common = { hallucinationIncrease: hallFlag, criticalFlags: flags, harm };
  if (regress.length) return { verdict: 'regression', regimes: regimes(regress), ...common };
  if (meaningful.length && (hallFlag.length || hallMeasure.length)) return { verdict: 'not-claimable-hallucination', regimes: regimes(meaningful), ...common };
  if (meaningful.length && otherFlags.length) return { verdict: 'not-claimable-critical-regression', regimes: regimes(meaningful), ...common };
  if (meaningful.length) return { verdict: 'meaningful-improvement', regimes: regimes(meaningful), ...common };
  if (small.length) return { verdict: 'significant-below-meaningful', regimes: regimes(small), ...common };
  if (largeNotSig.length) return { verdict: 'inconclusive', regimes: regimes(largeNotSig), ...common };
  return { verdict: 'no-detectable-difference', regimes: [], ...common };
}

/**
 * Hallucination guardrail — CASE-LEVEL visibility (never hidden by an aggregate). Every answer with a
 * harm signal is listed with its case, arm and type:
 *   invented-personal-fact           judge hallucination = true (with the judge's hallucinated_claims)
 *   unsupported-figure               deterministic: a figure not found in the history, files or question
 *   missing-fact-presented-as-known  deterministic: an unknown stated with a value and no decline
 *   wrong-person-attribution         deterministic crossEntity.forbid hit in a cross-person scenario
 *   wrong-project-attribution        … in a cross-project scenario
 *   wrong-entity-attribution         … in any other scenario
 */
export const HARM_TYPES = Object.freeze(['invented-personal-fact', 'unsupported-figure', 'missing-fact-presented-as-known', 'wrong-person-attribution', 'wrong-project-attribution', 'wrong-entity-attribution']);
export function harmCases(rows, arms) {
  const out = [];
  for (const r of rows) for (const a of arms) {
    const w = r.arms[a]; if (!w || w.answer == null) continue;
    const add = (type, detail = {}) => out.push({ caseId: r.caseId, arm: a, category: r.category, type, ...detail });
    if (w.judge?.hallucination === true) add('invented-personal-fact', { claims: w.judge.hallucinated_claims ?? [] });
    if ((w.grade?.ungrounded_figures ?? 0) > 0) add('unsupported-figure', { count: w.grade.ungrounded_figures });
    if (w.grade?.unknown_asserted === 1) add('missing-fact-presented-as-known');
    if (w.grade?.cross_entity_errors === 1) add(r.category === 'cross-person' ? 'wrong-person-attribution' : r.category === 'cross-project' ? 'wrong-project-attribution' : 'wrong-entity-attribution');
  }
  return out;
}
/** Per-arm counts of harm cases (answers, not cases), for every type, with the number of answers checked. */
export function harmCounts(rows, arms) {
  const cases = harmCases(rows, arms);
  return Object.fromEntries(arms.map(a => {
    const answered = rows.filter(r => r.arms[a]?.answer != null).length;
    return [a, Object.fromEntries(HARM_TYPES.map(t => [t, frac(cases.filter(c => c.arm === a && c.type === t).length, answered)]))];
  }));
}
function harmSummary(results) {
  return (results ?? []).map(r => ({ regime: r.regime, counts: r.harm?.counts ?? null, cases: r.harm?.cases?.length ?? 0 }));
}

/** Build per-case rows from store records (each arm: answer, full v3 grade, judgement, prompt hash, usage). */
export function pairRows({ records, ds, arms = ['A', 'H'] }) {
  const byScenario = new Map(ds.scenarios.map(s => [s.id, s]));
  const rows = new Map();
  const row = caseId => {
    if (!rows.has(caseId)) {
      const s = byScenario.get(caseId.split('@')[0]);
      rows.set(caseId, { caseId, category: s?.category ?? 'unknown', scenario: s, arms: Object.fromEntries(arms.map(a => [a, { answer: null, judge: null, judgeError: null, det: null, grade: null, answerability: s?.answerability ?? null, promptHash: null, usage: null }])) });
    }
    return rows.get(caseId);
  };
  for (const r of records.filter(x => x.type === 'answer')) {
    const w = row(r.caseId).arms[r.arm]; if (!w) continue;
    w.answer = r.text; w.promptHash = r.promptHashNormalised ?? null; w.usage = r.usage ?? null;
    const s = byScenario.get(r.caseId.split('@')[0]);
    if (s) { w.grade = gradeAnswerV3(s, r.text, { sources: [...(s.history ?? []).map(h => h.text), ...(s.uploads ?? []).map(u => u.content)].join('\n') }); w.det = w.grade.factual_correctness; }
  }
  for (const r of records.filter(x => x.type === 'judgement')) {
    const w = row(r.caseId).arms[r.arm]; if (!w) continue;
    const p = parseJudgement(r.text);
    if (p.ok) w.judge = p.value; else w.judgeError = p.error;
  }
  return [...rows.values()];
}

function binaryBlock(units, arms, opts, { withTest = true } = {}) {
  const [A, H] = arms;
  const n = units.length;
  const kA = units.filter(u => u.a).length, kH = units.filter(u => u.h).length;
  const b = units.filter(u => u.a && !u.h).length, c = units.filter(u => !u.a && u.h).length;
  const rd = n ? (c - b) / n : null;
  return {
    n, A_correct: kA, H_correct: kH, A: frac(kA, n), H: frac(kH, n),
    discordant: { [`${A}_only`]: b, [`${H}_only`]: c },
    riskDifference: r4(rd), riskDifferencePp: rd == null ? null : Math.round(rd * 1000) / 10,
    ci95: bootstrapCI(units, s => s.reduce((t, u) => t + (u.h ? 1 : 0) - (u.a ? 1 : 0), 0) / s.length, opts).map(r4),
    ci95Label: CI_LABEL,
    ...(withTest ? { mcnemarExactP: r4(mcnemarExact(b, c)), mcnemarExactPLabel: UNCORRECTED_P_LABEL } : {}),
  };
}
function scoreBlock(diffs, opts, { withTest = true } = {}) {
  const m = mean(diffs), s = sd(diffs);
  return {
    n: diffs.length, meanDiff: r4(m), sd: r4(s), dz: s ? r4(m / s) : null,
    ci95: bootstrapCI(diffs, x => mean(x), { ...opts, seed: `${opts.seed}|score` }).map(r4),
    ci95Label: CI_LABEL,
    ...(withTest ? { signFlipP: r4(signFlipP(diffs, { B: opts.B, seed: `${opts.seed}|signflip` })) } : {}),
  };
}

/** C-2: the six critical measures for complete pairs, with raw counts and the ≥ 10 pp decline flag. */
export function criticalMeasures(complete, arms) {
  const [A, H] = arms;
  return CRITICAL_MEASURES.map(m => {
    // Denominator = ELIGIBLE complete pairs only: in the measure's scope AND gradable on both arms.
    const inScope = complete.filter(m.scope);
    const graded = inScope.map(r => ({ caseId: r.caseId, a: m.success(r.arms[A]), h: m.success(r.arms[H]) }));
    const pairs = graded.filter(p => p.a != null && p.h != null);
    const n = pairs.length, kA = pairs.filter(p => p.a).length, kH = pairs.filter(p => p.h).length;
    const rd = n ? (kH - kA) / n : null;
    return {
      id: m.id, label: m.label, definition: m.definition, n, available: n > 0,
      A: frac(kA, n), H: frac(kH, n),
      riskDifference: r4(rd), riskDifferencePp: rd == null ? null : Math.round(rd * 1000) / 10,
      flagged: rd != null && rd <= SPEC.criticalDeclineThreshold + 1e-12,     // never flagged (nor "safe") without data
      eligibleCaseIds: pairs.map(p => p.caseId),
      inScopeButUngradable: graded.filter(p => p.a == null || p.h == null).map(p => p.caseId),
    };
  });
}

/**
 * C-4 stress diagnostics (very-long sample): descriptive, per arm, raw counts. Optionally compared
 * with the same scenarios in another regime (`baselineRows`, e.g. long) to show degradation with
 * history length. Never used for a claim.
 */
export function stressDiagnostics(rows, arms, baselineRows = null) {
  const out = { note: 'STRESS TEST (C-4): descriptive only; never a confirmatory or standalone improvement claim.', perArm: {} };
  for (const a of arms) {
    const W = rows.map(r => r.arms[a]).filter(w => w.answer != null);
    const has = (k, pred) => { const xs = W.filter(w => w.grade?.[k] != null); return frac(xs.filter(w => pred(w.grade[k])).length, xs.length); };
    const prompt = W.map(w => w.usage?.prompt_tokens).filter(Number.isFinite);
    out.perArm[a] = {
      longHistoryRetrieval: frac(W.filter(w => w.judge && isFactuallyCorrect(w)).length, W.filter(w => w.judge).length),
      requiredFactsGiven: has('required_facts_given', v => v === 1),
      distractorContamination: has('distractor_mentions', v => v === 1),
      temptingContamination: has('tempting_mentions', v => v === 1),
      staleAssertedAsCurrent: has('stale_asserted', v => v === 1),
      contradictionHandled: has('contradiction_handling', v => v === 1),
      contextBudget: { answers: prompt.length, meanPromptTokens: prompt.length ? Math.round(mean(prompt)) : null, maxPromptTokens: prompt.length ? Math.max(...prompt) : null },
    };
  }
  if (baselineRows) {
    const base = new Map(baselineRows.map(r => [r.caseId.split('@')[0], r]));
    out.degradationVsBaseline = Object.fromEntries(arms.map(a => {
      const pairs = rows.map(r => [base.get(r.caseId.split('@')[0])?.arms[a], r.arms[a]]).filter(([b, v]) => b?.judge && v?.judge);
      return [a, { scenarios: pairs.length, baseline: frac(pairs.filter(([b]) => isFactuallyCorrect(b)).length, pairs.length), stress: frac(pairs.filter(([, v]) => isFactuallyCorrect(v)).length, pairs.length) }];
    }));
  }
  return out;
}

/**
 * Analyse one label (one regime). `independent` must be true ONLY when a v3 freeze record for
 * this exact dataset was verified by the caller.
 */
export function analysePairs({ records, ds, arms = ['A', 'H'], label, regime, datasetSha256, independent = false, B = 10000, seed = 'aqua-analysis-v1', scenarioIds = null }) {
  const [A, H] = arms;
  const rows = pairRows({ records, ds, arms });
  const opts = { B, seed };
  const complete = rows.filter(r => r.arms[A].judge && r.arms[H].judge);
  const missing = rows.filter(r => !(r.arms[A].judge && r.arms[H].judge)).map(r => ({
    caseId: r.caseId,
    [A]: r.arms[A].judge ? 'ok' : r.arms[A].judgeError ? `invalid-judgement:${r.arms[A].judgeError}` : r.arms[A].answer == null ? 'no-answer' : 'not-judged',
    [H]: r.arms[H].judge ? 'ok' : r.arms[H].judgeError ? `invalid-judgement:${r.arms[H].judgeError}` : r.arms[H].answer == null ? 'no-answer' : 'not-judged',
  }));
  // Expected scenarios (the whole dataset, or the recorded sample) with NO record at all are missing too.
  const seen = new Set(rows.map(r => r.caseId.split('@')[0]));
  const neverRun = (scenarioIds ?? ds.scenarios.map(s => s.id)).filter(id => !seen.has(id));

  const units = rs => rs.map(r => ({ a: isFactuallyCorrect(r.arms[A]), h: isFactuallyCorrect(r.arms[H]) }));
  const diffs = rs => rs.map(r => score(r.arms[H].judge) - score(r.arms[A].judge));
  const status = r => (r.arms[A].promptHash && r.arms[H].promptHash ? (r.arms[A].promptHash === r.arms[H].promptHash ? 'unchanged' : 'changed') : 'unknown');
  const unchanged = complete.filter(r => status(r) === 'unchanged');
  const changed = complete.filter(r => status(r) === 'changed');
  const detPairs = complete.filter(r => r.arms[A].det != null && r.arms[H].det != null);

  const noiseUnits = units(unchanged);
  const noiseDisc = noiseUnits.filter(u => u.a !== u.h).length;
  const byCat = {};
  for (const r of complete) {
    const k = r.category; const e = (byCat[k] ??= { n: 0, kA: 0, kH: 0, scoreDiffs: [] });
    e.n++; if (isFactuallyCorrect(r.arms[A])) e.kA++; if (isFactuallyCorrect(r.arms[H])) e.kH++; e.scoreDiffs.push(score(r.arms[H].judge) - score(r.arms[A].judge));
  }
  for (const [k, e] of Object.entries(byCat)) byCat[k] = { n: e.n, A: frac(e.kA, e.n), H: frac(e.kH, e.n), riskDifference: r4((e.kH - e.kA) / e.n), meanScoreDiff: r4(mean(e.scoreDiffs)) };

  const isStress = SPEC.stressRegimes.includes(regime);
  return {
    evidence: independent ? IND_LABEL : DEV_LABEL,
    independent: !!independent,
    label, regime, datasetSha256, arms: { control: A, treatment: H },
    stressTest: isStress,
    method: { unit: 'case (scenario × regime)', primary: 'paired factual correctness: no wrong statement (judge factual_correctness = 2) and, when evidence is sufficient, every required fact given; paired RD (H − A), bootstrap 95% CI, exact McNemar, Holm over the two primary regimes', bootstrap: B, seed, spec: SPEC,
      reporting: { significance: P_LABEL, intervals: CI_LABEL, purpose: REPORTING_PURPOSE } },
    counts: { cases: rows.length, complete: complete.length, missing: missing.length, scenariosNeverRun: neverRun.length },
    primary: binaryBlock(units(complete), arms, opts),
    hallucination: (() => {
      // HARM endpoint, reported separately: answers WITH a hallucination (judge flag).
      const u = complete.map(r => ({ a: hallucinated(r.arms[A]), h: hallucinated(r.arms[H]) }));
      const { A_correct, H_correct, A: fa, H: fh, ...rest } = binaryBlock(u, arms, { ...opts, seed: `${seed}|halluc` });
      return { note: 'Separate harm endpoint: counts are answers WITH a hallucination; a positive risk difference means H hallucinates more.', A_hallucinated: A_correct, H_hallucinated: H_correct, A: fa, H: fh, ...rest };
    })(),
    criticalMeasures: criticalMeasures(complete, arms),
    harm: { note: 'Hallucination guardrail: every answer with a harm signal, case by case (types in HARM_TYPES). Counts are per arm over answers checked.', counts: harmCounts(rows, arms), cases: harmCases(rows, arms) },
    sensitivityMissingAsIncorrect: binaryBlock(units(rows), arms, { ...opts, seed: `${seed}|sens` }),
    judgeScore: scoreBlock(diffs(complete), opts),
    deterministicFactual: detPairs.length ? {
      n: detPairs.length, A_mean: r4(mean(detPairs.map(r => r.arms[A].det))), H_mean: r4(mean(detPairs.map(r => r.arms[H].det))),
      ...scoreBlock(detPairs.map(r => r.arms[H].det - r.arms[A].det), { ...opts, seed: `${seed}|det` }),
    } : null,
    noiseControl: {
      note: 'Cases whose A and H prompts are identical (normalised hash). Any difference is model nondeterminism, not the treatment.',
      n: unchanged.length, discordant: noiseDisc, discordance: frac(noiseDisc, unchanged.length), discordanceRate: unchanged.length ? r4(noiseDisc / unchanged.length) : null,
      discordanceCI95: wilson(noiseDisc, unchanged.length).map(r4),
      judgeScore: scoreBlock(diffs(unchanged), { ...opts, seed: `${seed}|noise` }, { withTest: false }),
    },
    promptChangedSubset: {
      note: 'SECONDARY, DESCRIPTIVE ONLY: selected by the treatment\'s own effect on the prompt. Not an independent primary result; no p-values.',
      n: changed.length,
      correct: binaryBlock(units(changed), arms, { ...opts, seed: `${seed}|changed` }, { withTest: false }),
      judgeScore: scoreBlock(diffs(changed), { ...opts, seed: `${seed}|changed-score` }, { withTest: false }),
    },
    promptStatusUnknown: complete.filter(r => status(r) === 'unknown').length,
    categories: { note: 'Dataset categories (authoring-brief ids). Descriptive only; no tests (small n per category).', byCategory: byCat },
    ...(isStress ? { stress: stressDiagnostics(rows, arms) } : {}),
    missing, scenariosNeverRun: neverRun,
  };
}
