/**
 * Paired A/H analysis of completed answer-evaluation runs — OFFLINE, no provider requests.
 * Specification: AQUA_ACIB_V3_ANALYSIS_SPEC.md (pre-registered; its sha256 is frozen with ACIB v3).
 *
 *   node scripts/answer-analyze.mjs --set <dataset> --labels <primary label>[,<label>] [--secondary-labels <label>,…]
 *                                   [--arms A,H] [--bootstrap 10000] [--seed aqua-analysis-v1] [--out <file>]
 *   ACIB v3 (reviewer only; AQUA_V3_REVIEWER_MODE=yes):
 *     … --v3-dataset-file <frozen eval file> --results-dir <outside the repository> --reviewer "<name>"
 *
 * One label = one pair store = one regime. PRIMARY labels (the two regimes, short and long) are
 * Holm-adjusted together and drive the pre-registered claim verdict; SECONDARY labels (e.g. very
 * long) are analysed and reported but never adjusted into, or used for, the verdict.
 * If `<label>.sample.json` exists, only those scenarios are expected.
 *
 * Evidence class: "independent" ONLY in reviewer mode with the CANONICAL v3 freeze record (the
 * dataset's sha256 is verified against it). Every other analysis — including any ACIB v2 run — is
 * labelled DEVELOPMENT / REGRESSION EVIDENCE and its verdict is "not-applicable".
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analysePairs, holm, claimVerdict, SPEC, pairRows, stressDiagnostics, P_LABEL, REPORTING_PURPOSE } from '../eval/answer/pairedAnalysis.mjs';
import { sha256 } from '../eval/governance/acibV3Governance.mjs';
import { resolveReviewerDataset, ReviewerModeRefused } from '../eval/governance/reviewerMode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const refuse = msg => { console.error(`answer-analyze: REFUSED — ${msg}`); process.exit(2); };
const list = k => (opt(k) ?? '').split(',').map(s => s.trim()).filter(Boolean);

const LABELS = list('--labels');
const SECONDARY = list('--secondary-labels');
const ARMS = opt('--arms', 'A,H').split(',').map(s => s.trim());
const B = Number(opt('--bootstrap', '10000'));
const SEED = opt('--seed', 'aqua-analysis-v1');
if (!LABELS.length) refuse('--labels is required');
if (ARMS.length !== 2 || ARMS[0] === ARMS[1]) refuse('--arms must name two different arms');

let RAW, SET, RESULTS, independent = false, banner = null;
if (opt('--v3-dataset-file')) {
  let rv;
  try { rv = resolveReviewerDataset({ datasetFile: opt('--v3-dataset-file'), resultsDir: opt('--results-dir'), reviewer: opt('--reviewer'), env: process.env }); }
  catch (err) { if (err instanceof ReviewerModeRefused) refuse(err.message); throw err; }
  RAW = rv.RAW; SET = 'acib.v3.eval'; RESULTS = rv.resultsDir; independent = rv.canonical; banner = rv.banner;
} else {
  SET = opt('--set');
  if (!SET) refuse('--set is required (or --v3-dataset-file in reviewer mode)');
  const dsFile = path.join(ROOT, 'eval/datasets', `${SET}.json`);
  if (!existsSync(dsFile)) refuse(`no dataset ${SET} in the repository`);
  RAW = readFileSync(dsFile, 'utf8');
  RESULTS = path.join(ROOT, 'eval/answer/results');
}
const DS = JSON.parse(RAW);
const HASH = sha256(RAW);

const load = label => {
  const store = path.join(RESULTS, `${label}.pairs.jsonl`);
  if (!existsSync(store)) refuse(`no pair store for label ${label}`);
  const records = readFileSync(store, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const regimes = [...new Set(records.map(r => r.caseId?.split('@')[1]).filter(Boolean))];
  const sampleFile = path.join(RESULTS, `${label}.sample.json`);
  const scenarioIds = existsSync(sampleFile) ? JSON.parse(readFileSync(sampleFile, 'utf8')).scenarioIds : null;
  return { label, records, regime: regimes.join(',') || null, scenarioIds };
};
const analyse = ({ label, records, regime, scenarioIds }) => analysePairs({ records, ds: DS, arms: ARMS, label, regime, datasetSha256: HASH, independent, B, seed: `${SEED}|${label}`, scenarioIds });
const primaryData = LABELS.map(load);
// C-4: the very-long stress sample is NEVER a primary (confirmatory) analysis.
for (const d of primaryData) if (SPEC.stressRegimes.includes(d.regime)) refuse(`label ${d.label} is a ${d.regime} stress sample: pass it with --secondary-labels (descriptive only, never confirmatory)`);
const primary = primaryData.map(analyse);
const adj = holm(primary.map(r => r.primary.mcnemarExactP));
primary.forEach((r, i) => { r.primary.mcnemarHolmP = Math.round(adj[i] * 10000) / 10000; r.primary.mcnemarHolmPLabel = P_LABEL; r.role = 'primary'; });
const secondary = SECONDARY.map(load).map(d => {
  const r = { ...analyse(d), role: SPEC.stressRegimes.includes(d.regime) ? 'STRESS TEST (C-4): descriptive only; not Holm-adjusted; never used for the verdict' : 'secondary (not Holm-adjusted; not used for the verdict)' };
  if (SPEC.stressRegimes.includes(d.regime)) {
    // Degradation with history length: the same scenarios in the long primary regime, if analysed.
    const base = primaryData.find(p => p.regime === 'long');
    r.stress = stressDiagnostics(pairRows({ records: d.records, ds: DS, arms: ARMS }), ARMS, base ? pairRows({ records: base.records, ds: DS, arms: ARMS }) : null);
  }
  return r;
});
const verdict = claimVerdict(primary, { independent });

// Pre-registration check: hashes of the analysis, grading and judging code used for this report.
const codeHashes = Object.fromEntries(['eval/answer/pairedAnalysis.mjs', 'eval/answer/answerGrader.mjs', 'eval/answer/answerGraderV3.mjs', 'eval/answer/judgeRunner.mjs', 'scripts/answer-analyze.mjs'].map(f => [f, sha256(readFileSync(path.join(ROOT, f), 'utf8'))]));
const out = opt('--out', path.join(RESULTS, `${[...LABELS, ...SECONDARY].join('+')}.analysis.json`));
writeFileSync(out, `${JSON.stringify({ createdAt: new Date().toISOString(), dataset: { set: SET, sha256: HASH }, independent, reviewerMode: banner, spec: SPEC, codeHashes, verdict, primary, secondary }, null, 1)}\n`);

// Every rate is printed with its raw numerator/denominator (C-2).
const ci = c => `[${c.map(x => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}`)).join(', ')}] pp`;
if (banner) console.log(banner);
console.log(`EVIDENCE: ${primary[0].evidence}`);
console.log(`REPORTING (D-1): ${REPORTING_PURPOSE}`);
for (const r of [...primary, ...secondary]) {
  const p = r.primary;
  console.log(`[${r.label} · ${r.regime} · ${r.role}] complete ${r.counts.complete}/${r.counts.cases} (missing ${r.counts.missing}, never run ${r.counts.scenariosNeverRun})`);
  console.log(`  primary (paired factual correctness): A ${p.A.text} · H ${p.H.text} · RD(H−A) ${p.riskDifferencePp} pp, 95% CI ${ci(p.ci95)} (per regime, not multiplicity-adjusted) · McNemar p ${p.mcnemarExactP} uncorrected${p.mcnemarHolmP != null ? `, ${p.mcnemarHolmP} Holm-corrected across the two primary regimes` : ''}`);
  console.log(`  hallucination (separate harm measure): A ${r.hallucination.A.text} · H ${r.hallucination.H.text} · RD ${r.hallucination.riskDifferencePp} pp ${ci(r.hallucination.ci95)} · p ${r.hallucination.mcnemarExactP}`);
  for (const m of r.criticalMeasures) console.log(`  critical · ${m.id}: A ${m.A.text} · H ${m.H.text}${m.riskDifferencePp != null ? ` · RD ${m.riskDifferencePp} pp` : ''}${m.flagged ? '  ⚠ DECLINE ≥ 10 pp — FLAGGED' : ''} · eligible cases ${m.eligibleCaseIds.length}`);
  // Hallucination guardrail: case-level harm counts are ALWAYS printed (cases listed in the JSON, harm.cases).
  for (const a of ARMS) console.log(`  harm · ${a}: ${Object.entries(r.harm.counts[a]).map(([t, f]) => `${t} ${f.text}`).join(' · ')}`);
  console.log(`  judge score (0–8): mean diff ${r.judgeScore.meanDiff} [${r.judgeScore.ci95.join(', ')}] · dz ${r.judgeScore.dz} · sign-flip p ${r.judgeScore.signFlipP}`);
  console.log(`  noise control (identical prompts): discordant ${r.noiseControl.discordance.text} [${r.noiseControl.discordanceCI95.join(', ')}]`);
  console.log(`  prompt-changed subset (descriptive, not primary): A ${r.promptChangedSubset.correct.A.text} · H ${r.promptChangedSubset.correct.H.text}`);
  if (r.stress) for (const [a, s] of Object.entries(r.stress.perArm)) console.log(`  stress · ${a}: retrieval ${s.longHistoryRetrieval.text} · distractors ${s.distractorContamination.text} · tempting ${s.temptingContamination.text} · stale ${s.staleAssertedAsCurrent.text} · mean prompt tokens ${s.contextBudget.meanPromptTokens ?? 'n/a'}`);
}
console.log(`VERDICT: ${verdict.verdict}${verdict.reason ? ` — ${verdict.reason}` : ''}`);
if (verdict.criticalFlags?.length) console.log(`CRITICAL FLAGS: ${verdict.criticalFlags.map(f => `${f.regime}/${f.measure} A ${f.A} → H ${f.H}`).join('; ')}`);
console.log(`written: ${path.relative(process.cwd(), out)}`);
