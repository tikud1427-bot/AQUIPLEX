/**
 * Judge queued pairs / merge results of an answer-eval run — ZERO-BUDGET (integration 2026-11-11).
 *
 *   node scripts/answer-judge.mjs --label <l>                         # dry run: drain the judging queue with the mock judge
 *   node scripts/answer-judge.mjs --label <l> --merge                 # un-blind from the pair store, aggregates + review queue (no requests)
 *   AQUA_ANSWER_EVAL_APPROVED=yes AQUA_EVAL_LIVE_APPROVED=yes \
 *     node scripts/answer-judge.mjs --label <l> --execute --provider-config <cfg> --credentials-env <file outside repo>
 *
 * Judging only: completed answers are never regenerated (phases ['judge']). Every request
 * goes through the evaluation provider manager (free tier only, pause on exhaustion).
 * Must use the same --set/--regime/--arms as the answer-eval run of this label.
 */
import '../eval/core/isolateDataDir.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const refuse = msg => { console.error(`answer-judge: REFUSED — ${msg}`); process.exit(2); };
const LABEL = opt('--label');
if (!LABEL) refuse('--label is required');
for (const legacy of ['--price-in', '--price-out', '--max-usd']) if (args.includes(legacy)) refuse(`${legacy} is no longer accepted: evaluation is zero-budget`);
// No production data, dry run or live: no real database, no Mongo mirror, never the real ~/.aquiplex store.
const dataRisk = productionDataGuard(process.env);
if (dataRisk.length) refuse(dataRisk.join('; '));
const SET = opt('--set', 'acib.v2.eval');
const REGIME = opt('--regime', 'long');
const ARMS = opt('--arms', 'A,H').split(',').map(s => s.trim());
const EXECUTE = args.includes('--execute');
// ACIB v3 reviewer-only mode (same rules as answer-eval): frozen external set, external results.
let RAW, REVIEWER = null;
if (opt('--v3-dataset-file')) {
  try { REVIEWER = resolveReviewerDataset({ datasetFile: opt('--v3-dataset-file'), resultsDir: opt('--results-dir'), reviewer: opt('--reviewer'), env: process.env }); }
  catch (err) { if (err instanceof ReviewerModeRefused) refuse(err.message); throw err; }
  RAW = REVIEWER.RAW;
  console.log(REVIEWER.banner);
} else RAW = readFileSync(path.join(ROOT, 'eval/datasets', `${SET}.json`), 'utf8');
const DS = JSON.parse(RAW);
const HASH = datasetHash(RAW);
const RESULTS = REVIEWER ? REVIEWER.resultsDir : path.join(ROOT, 'eval/answer/results');
const storeFile = path.join(RESULTS, `${LABEL}.pairs.jsonl`);
if (!existsSync(storeFile)) refuse(`no pair store for label ${LABEL}`);

if (args.includes('--merge')) {
  // Review queue: malformed, low-confidence, A/H disagreements, judge-vs-deterministic, plus a seeded random audit.
  const merged = mergeStore({ storeFile, ds: DS, arms: ARMS, reviewSampleRate: Number(opt('--review-sample', '0.1')), reviewSeed: opt('--review-seed', 'aqua-review-v1') });
  writeFileSync(path.join(RESULTS, `${LABEL}.merged.json`), `${JSON.stringify(merged, null, 1)}\n`);
  console.log(`merged: ${merged.counts.answers} answers · ${merged.counts.judgements} judgements · review queue ${merged.review.length} ${JSON.stringify(merged.reviewCounts)} (audit sample ${merged.reviewSample.rate}, seed ${merged.reviewSample.seed})`);
  process.exit(0);
}

let setup;
try { setup = EXECUTE ? liveSetup({ configFile: opt('--provider-config'), credentialsFile: opt('--credentials-env'), datasetHash: HASH }) : dryRunSetup(HASH); }
catch (err) { if (err instanceof ZeroBudgetRefused || err instanceof PreflightRefused || err.name === 'LiveTransportRefused') refuse(err.message); throw err; }

// One LIVE evaluation at a time machine-wide (request budgets and quota state are per process).
if (EXECUTE) { try { const lock = acquireRunLock(); process.on('exit', () => lock.release()); } catch (err) { if (err.name === 'RunLocked') refuse(err.message); throw err; } }
// Only the cases this store has answers for; prompts are never rebuilt for judging.
const answered = new Set(readFileSync(storeFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.type === 'answer').map(r => r.caseId.split('@')[0]));
const cases = acibCases({ ds: DS, datasetHash: HASH, scenarios: DS.scenarios.filter(s => answered.has(s.id)), armEnvs: Object.fromEntries(ARMS.map(a => [a, {}])), regime: REGIME, label: LABEL, runScenario });
let run;
try { run = await runEvaluation({ setup, cases, storeFile, arms: ARMS, phases: ['judge'] }); }
catch (err) { if (err instanceof PreflightRefused) refuse(err.message); throw err; }
finally { closeAcib(); }
console.log(`answer-judge ${EXECUTE ? 'executed' : 'dry-run'}: ${run.status} · judged ${run.judged} · skipped (already judged) ${run.skipped}${run.judgeQueued.length ? ` · still queued ${run.judgeQueued.length}` : ''}`);
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
