/**
 * Answer-level A/B evaluation — ZERO-BUDGET (integration 2026-11-11).
 *
 *   A = production defaults · B = AQUA_INFO_NEEDS=on · H = AQUA_HYBRID_CONTEXT=on
 *   A pair is exactly two arms (default A,H). Both are answered by the SAME model with
 *   the SAME settings (eval/providers/pairRunner.mjs locks the model per pair).
 *
 * Every model request goes through the evaluation provider manager
 * (eval/providers/providerManager.mjs): verified free-tier quota domains only, no paid
 * fallback, quota exhaustion PAUSES (resume by re-running the same --label), the judge
 * queue keeps completed pairs when the judge provider is exhausted. See
 * eval/answer/evalRun.mjs for the zero-budget gate.
 *
 *   node scripts/answer-eval.mjs                                   # dry run: synthetic config + mock transport, no network
 *   node scripts/answer-eval.mjs --limit 5 --arms A,H --label dry1
 *   AQUA_ANSWER_EVAL_APPROVED=yes AQUA_EVAL_LIVE_APPROVED=yes \
 *     node scripts/answer-eval.mjs --execute --provider-config <eval-config.json> --credentials-env <file outside repo> --label run1
 *
 * Outputs (eval/answer/results/): <label>.pairs.jsonl (answers + judgements, resumable),
 * <label>.json (status, quota state, usage — content-free, plus deterministic grades).
 * --answers-only: answer both arms now; judge later with answer-judge.mjs (same label).
 * Exit: 0 complete · 2 refused · 3 paused / judging queued / stopped.
 */
import '../eval/core/isolateDataDir.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, closeAcib } from '../eval/adapters/acibPipeline.mjs';
import { datasetHash } from '../eval/suites/acibSuite.mjs';
import { dryRunSetup, liveSetup, acibCases, runEvaluation, mergeStore, ZeroBudgetRefused, productionDataGuard, acquireRunLock } from '../eval/answer/evalRun.mjs';
import { PreflightRefused } from '../eval/providers/evalConfig.mjs';
import { resolveReviewerDataset, ReviewerModeRefused } from '../eval/governance/reviewerMode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SET = opt('--set', 'acib.v2.eval');
const REGIME = opt('--regime', 'long');
const LIMIT = Number(opt('--limit', '10'));
const LABEL = opt('--label', `dry-${new Date().toISOString().slice(0, 10)}`);
const EXECUTE = args.includes('--execute');
const ALL_ARMS = Object.freeze({ A: {}, B: { AQUA_INFO_NEEDS: 'on' }, H: { AQUA_HYBRID_CONTEXT: 'on' } });
const ARMS = opt('--arms', 'A,H').split(',').map(s => s.trim()).filter(Boolean);
const refuse = msg => { console.error(`answer-eval: REFUSED — ${msg}`); process.exit(2); };
if (ARMS.length !== 2 || ARMS[0] === ARMS[1] || !ARMS.every(a => ALL_ARMS[a])) refuse('--arms must name exactly two different arms of A, B, H');
for (const legacy of ['--price-in', '--price-out', '--max-usd']) if (args.includes(legacy)) refuse(`${legacy} is no longer accepted: evaluation is zero-budget (free-tier quota only), there is no priced path`);
// No production data, dry run or live: no real database, no Mongo mirror, never the real ~/.aquiplex store.
const dataRisk = productionDataGuard(process.env);
if (dataRisk.length) refuse(dataRisk.join('; '));

// ACIB v3 reviewer-only mode: the frozen evaluation set from OUTSIDE the repository, results to
// --results-dir (outside the repository). Otherwise: a repository dataset with its .FROZEN.sha256.
const V3FILE = opt('--v3-dataset-file');
let RAW, REVIEWER = null;
if (V3FILE) {
  try { REVIEWER = resolveReviewerDataset({ datasetFile: V3FILE, resultsDir: opt('--results-dir'), reviewer: opt('--reviewer'), env: process.env }); }
  catch (err) { if (err instanceof ReviewerModeRefused) refuse(err.message); throw err; }
  RAW = REVIEWER.RAW;
  console.log(REVIEWER.banner);
} else {
  RAW = readFileSync(path.join(ROOT, 'eval/datasets', `${SET}.json`), 'utf8');
}
const DS = JSON.parse(RAW);
const HASH = datasetHash(RAW);
if (!REVIEWER) {
  let FROZEN = null;
  try { FROZEN = readFileSync(path.join(ROOT, 'eval/datasets', `${SET}.FROZEN.sha256`), 'utf8').trim().split(/\s+/)[0]; } catch { /* none */ }
  if (FROZEN !== HASH) refuse(`dataset ${SET} is not intact (frozen hash mismatch)`);
}

let setup;
try {
  setup = EXECUTE ? liveSetup({ configFile: opt('--provider-config'), credentialsFile: opt('--credentials-env'), datasetHash: HASH }) : dryRunSetup(HASH);
} catch (err) {
  if (err instanceof ZeroBudgetRefused || err instanceof PreflightRefused || err.name === 'LiveTransportRefused') refuse(err.message);
  throw err;
}

// One LIVE evaluation at a time machine-wide (request budgets and quota state are per process).
if (EXECUTE) { try { const lock = acquireRunLock(); process.on('exit', () => lock.release()); } catch (err) { if (err.name === 'RunLocked') refuse(err.message); throw err; } }
const dir = REVIEWER ? REVIEWER.resultsDir : path.join(ROOT, 'eval/answer/results');
mkdirSync(dir, { recursive: true });
const storeFile = path.join(dir, `${LABEL}.pairs.jsonl`);
// --sample-per-category N --sample-seed S: a stratified, seeded, RECORDED sample (N scenarios per
// category, chosen by sha256(seed|id)). The selection is written to <label>.sample.json; a resumed
// run must reproduce exactly the same selection or it is refused.
let scenarios = DS.scenarios.slice(0, LIMIT);
const PER_CAT = opt('--sample-per-category');
if (PER_CAT) {
  const n = Number(PER_CAT), seed = opt('--sample-seed');
  if (!(Number.isInteger(n) && n > 0) || !seed) refuse('--sample-per-category needs a positive integer and --sample-seed <seed>');
  const key = id => createHash('sha256').update(`${seed}|${id}`).digest('hex');
  const byCat = {};
  for (const s of DS.scenarios) (byCat[s.category] ??= []).push(s);
  scenarios = Object.keys(byCat).sort().flatMap(c => byCat[c].sort((a, b) => key(a.id).localeCompare(key(b.id))).slice(0, n));
  const sample = { set: SET, datasetSha256: HASH, seed, perCategory: n, scenarioIds: scenarios.map(s => s.id) };
  const sampleFile = path.join(dir, `${LABEL}.sample.json`);
  if (existsSync(sampleFile)) {
    const prev = JSON.parse(readFileSync(sampleFile, 'utf8'));
    if (JSON.stringify(prev.scenarioIds) !== JSON.stringify(sample.scenarioIds) || prev.datasetSha256 !== HASH) refuse(`label ${LABEL} was started with a different sample; use the same --sample-per-category/--sample-seed or a new label`);
  } else writeFileSync(sampleFile, `${JSON.stringify(sample, null, 1)}\n`);
}
const cases = acibCases({ ds: DS, datasetHash: HASH, scenarios, armEnvs: Object.fromEntries(ARMS.map(a => [a, ALL_ARMS[a]])), regime: REGIME, label: LABEL, runScenario });

let run;
try {
  // --answers-only: answer both arms, judge later with scripts/answer-judge.mjs (halves a smoke test's requests).
  run = await runEvaluation({ setup, cases, storeFile, arms: ARMS, phases: args.includes('--answers-only') ? ['answer'] : ['answer', 'judge'] });
} catch (err) {
  if (err instanceof PreflightRefused) refuse(err.message);
  throw err;
} finally { closeAcib(); }

const merged = mergeStore({ storeFile, ds: DS, arms: ARMS });
const out = {
  label: LABEL, createdAt: new Date().toISOString(), mode: EXECUTE ? 'executed (free-tier quota only)' : 'dry-run (synthetic config, mock transport — results are plumbing checks, NOT results)',
  dataset: { set: REVIEWER ? 'acib.v3.eval' : SET, sha256: HASH }, reviewerMode: REVIEWER ? REVIEWER.banner : null, regime: REGIME, arms: ARMS, ...run, merged,
};
writeFileSync(path.join(dir, `${LABEL}.json`), `${JSON.stringify(out, null, 1)}\n`);
console.log(`answer-eval ${out.mode}: ${run.status} · answered ${run.answered} · judged ${run.judged} · skipped (already done) ${run.skipped}${run.judgeQueued.length ? ` · judging queued ${run.judgeQueued.length}` : ''}${run.resumeAt ? ` · resume after ${new Date(run.resumeAt).toISOString()}` : ''}`);
console.log(`models: answer ${run.models.answer} · judge ${run.models.judge}`);
// One unambiguous line for the operator: did the run COMPLETE, PAUSE or STOP?
const VERDICT = {
  'complete': 'COMPLETED',
  'complete-judging-queued': 'COMPLETED (answers only; judging NOT run — use answer-judge.mjs)',
  'paused': `PAUSED (${run.pauseReason ?? 'quota'}) — nothing further was sent${run.resumeAt ? `; resume after ${new Date(run.resumeAt).toISOString()}` : ''}`,
  'stopped-billing': 'STOPPED — billing signal; no other route tried',
  'stopped-review': 'STOPPED — needs review (unclassified error, empty completion or failed key)',
  'stopped-rejected': 'STOPPED — request over the token limit; nothing sent',
};
const tok = (run.usage ?? []).reduce((s, u) => ({ p: s.p + (u.promptTokens ?? 0), c: s.c + (u.completionTokens ?? 0), n: s.n + (u.requests ?? 0) }), { p: 0, c: 0, n: 0 });
console.log(`RESULT: ${VERDICT[run.status] ?? run.status.toUpperCase()} · requests sent ${tok.n} · provider-reported tokens: prompt ${tok.p}, completion ${tok.c}`);
if (run.status !== 'complete') process.exitCode = 3;
