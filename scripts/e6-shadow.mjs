#!/usr/bin/env node
/**
 * E6/PR-11 — the shadow run.
 *
 * Runs BOTH extractors over the same 200 labelled cases in
 * `extraction-core.v1`, scores them with the SAME suite, and prints the
 * comparison against the committed baseline and the blueprint's promotion
 * gate:
 *
 *   precision ≥ 0.85 · recall ≥ 0.70 · negation ≥ 0.95
 *
 * "Run alongside regex, write to a separate table, compare, do not read. Flip
 * readers only when eval says it is better." Nothing here writes anything.
 *
 * WHY YOU HAVE TO RUN IT
 * ----------------------
 * Real provider calls. The analysis sandbox has no key and its egress blocks
 * every provider, so these numbers cannot be produced there. Everything that
 * does not need a provider — every stage's logic, and the comparison
 * arithmetic below — is already under test and runs anywhere.
 *
 * USAGE
 *
 *   cd aqua
 *   node scripts/e6-shadow.mjs                      # all 200 cases
 *   node scripts/e6-shadow.mjs --limit 20           # a cheap smoke run first
 *   node scripts/e6-shadow.mjs --model <model-id>   # pin, strongly advised
 *   node scripts/e6-shadow.mjs --provider groq      # groq or openrouter (default)
 *   node scripts/e6-shadow.mjs --repeat 3           # measure run-to-run noise
 *   node scripts/e6-shadow.mjs --pace 1200          # ms between calls (default 350)
 *   node scripts/e6-shadow.mjs --json out.json      # machine record
 *
 * COST. One provider call per admitted segment, cached by content hash within
 * the run. `gate-core` measured the candidate gate admitting 176 of 200, so
 * budget for roughly that many calls on a full pass. Start with --limit.
 *
 * ⚠️ IT REFUSES TO PUBLISH AN UNATTRIBUTABLE RUN
 * -----------------------------------------------
 * If the transport does not report which model answered, the comparison is
 * printed but marked NOT PUBLISHABLE and the exit code is non-zero. A
 * difference in these numbers could be the new prompt or could be a different
 * model, and nothing in the output would distinguish them —
 * `getCandidateModels` rotates for OpenRouter, so that is a live possibility
 * rather than a theoretical one. PR-5b added the pin and the model echo
 * precisely so this check can pass; if it fails, pass --model.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ── Root .env, BEFORE any provider import ────────────────────────────────────
//
// 🔴 THE SCRIPT'S OWN ERROR MESSAGE PROMISED SOMETHING IT COULD NOT DELIVER.
// "No Groq keys configured — this script needs the same key the app uses" is
// accurate and useless: the app is `index.js`, which calls `dotenv.config()`,
// and this script called nothing. So a correctly configured machine reported
// no keys, and the operator's next move is to go looking for a key that was
// already there.
//
// Same semantics as `index.js` and `evaluation/runners/aqua-standalone.mjs`,
// which solved this first: existing process.env values are NEVER overridden,
// so a shell export still wins over the file. `dotenv` is resolved from the
// engine's own dependency tree — no new dependency.
//
// Silent when the file is absent: a CI runner passing keys as real environment
// variables is a normal way to run this, not a misconfiguration.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.join(here, '..', '..', '.env');
  if (existsSync(envPath)) {
    createRequire(path.join(here, '..', 'package.json'))('dotenv')
      .config({ path: envPath, quiet: true });
  }
}

import suite from '../eval/suites/extraction-core.suite.mjs';
import { extractWithCurrentEngine, surfacesOf } from '../eval/adapters/currentExtractor.mjs';
import { extractE6 } from '../eval/adapters/e6Extractor.mjs';
import { generateOpenRouter } from '../src/providers/openrouter.js';
import { generateGroq, msUntilAnyKeyFree } from '../src/providers/groq.js';
import { buildExtractionPrompt } from '../src/brain/understanding/extractionPrompt.js';
import { __clearExtractionCache } from '../src/brain/understanding/extractionClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

/** The blueprint's exit criteria for E6. Not negotiable, and not invented here. */
/**
 * A pass is discarded if the transport failed on more than this share of cases.
 * Not a tuning knob: anything above a couple of stragglers means the numbers
 * describe the provider's availability, not the extractor.
 */
export const MAX_PASS_ERROR_RATE = 0.02;

/** Consecutive failures that mean the provider is gone, not flaky. */
export const ABORT_AFTER_CONSECUTIVE_ERRORS = 10;

/**
 * How long the harness will sleep waiting for a rate-limited key, per stall.
 *
 * 🔴 A RATE LIMIT IS A WAIT, NOT A FAILURE, AND THE HARNESS DID NOT KNOW THAT.
 *
 * A `--repeat 3 --limit 60` run aborted all three passes after 33 calls, 31 of
 * them errors, while the provider was reporting cooldowns of 106s, 151s, 580s
 * and 830s. Every one was a known, finite wait that the run marched through and
 * scored as a dead transport. The abort added last session was right about the
 * SYMPTOM and wrong about the cause.
 *
 * `msUntilAnyKeyFree()` gives the figure exactly. Above this ceiling the daily
 * quota is binding rather than the per-minute one, and sleeping through that is
 * worse than stopping and saying so.
 */
export const MAX_STALL_WAIT_MS = 15 * 60 * 1000;

export const PROMOTION_GATE = Object.freeze({
  precision: 0.85,
  recall: 0.70,
  negation: 0.95,
});

/**
 * Decide promotion from measured metrics.
 *
 * Exported and pure so the arithmetic is tested without a provider — the
 * numbers need a key, the DECISION about them does not, and a promotion rule
 * that only runs on the day you want to promote has never been exercised.
 */
export function evaluatePromotion(metrics, baseline, { comparable = true, noise = {} } = {}) {
  // 🔴 0/0 IS NOT 0.0, AND THE GATE USED TO FAIL ON IT.
  //
  // The first shadow run reported `negation 0% — FAIL` and returned DO NOT
  // PROMOTE. No negation case had been sent: `--limit 20` took a prefix of a
  // category-ordered dataset and the first negative is at index 160. The
  // aggregator divided zero by zero, got 0, and the gate read it as a
  // catastrophic score. The regex control scored the identical 0.0 on the same
  // slice, which is what proved it was arithmetic rather than extraction.
  //
  // An unmeasured metric now reports `null` and is SKIPPED, not failed. It also
  // blocks promotion — untested is not passed — but it is reported as
  // "not measured" so nobody re-diagnoses a working extractor.
  const negatives = metrics.negatives ?? 0;
  const measured = {
    precision: negatives > 0 ? 1 - (metrics.false_positives ?? 0) / negatives : null,
    // `positives` is the TRUE denominator of detection_recall
    // (pos.filter(emitted).length / pos.length), so it is the right thing to
    // ask whether anything was measured.
    recall: (metrics.positives ?? 0) > 0 ? (metrics.detection_recall ?? 0) : null,
    // `n_cases_negation` is published by the suite precisely so this can tell
    // "the extractor scored zero" from "no negation case was sent".
    negation: (metrics.n_cases_negation ?? 0) > 0 ? (metrics.detection_negation ?? 0) : null,
  };

  const checks = [
    ['precision', measured.precision, PROMOTION_GATE.precision],
    ['recall', measured.recall, PROMOTION_GATE.recall],
    ['negation', measured.negation, PROMOTION_GATE.negation],
  ].map(([name, got, need]) => (got == null
    ? { name, got: null, need, pass: false, measured: false }
    : { name, got, need, pass: got >= need, measured: true }));

  // Beating the gate is necessary but not sufficient: a new extractor that
  // met every threshold while scoring BELOW the committed baseline on some
  // dimension would be a regression wearing a passing grade.
  //
  // ⚠️ ONLY WHEN THE TWO NUMBERS DESCRIBE THE SAME CASES. The first run listed
  // `silence_on_negatives 0.9 → 0` as a regression, comparing a 200-case
  // baseline with 40 negatives against a 20-case slice with none. That is not
  // a regression, it is two different populations. On a partial run the
  // comparison is refused outright rather than reported wrongly.
  //
  // ⚠️ AND ONLY WHEN THE DROP EXCEEDS THE MEASURED NOISE. Run 2 blocked
  // promotion on `fidelity_accuracy 64.7% → 64.1%` — 0.6 points — while two
  // identical runs of the same pinned model differed by 16 points on
  // `detection_modality`. Comparing to nine decimal places against a provider
  // that is not reproducible manufactures regressions.
  //
  // With `--repeat`, a drop must clear the observed range for that metric.
  // Without it there is no estimate, so the drop is reported as UNVERIFIED
  // rather than asserted — it still blocks promotion, because an unverified
  // drop is not a cleared one, but it no longer claims to be a finding.
  const regressions = [];
  if (comparable) {
    for (const k of ['detection_recall', 'subject_recall', 'predicate_accuracy',
      'fidelity_accuracy', 'silence_on_negatives']) {
      const before = baseline?.[k] ?? 0, after = metrics?.[k] ?? 0;
      if (!(after < before - 1e-9)) continue;
      const range = noise?.[k]?.range ?? null;
      const real = isRealRegression(before, after, range);
      if (real === false) continue;                     // inside the noise floor
      regressions.push({ metric: k, before, after, noiseRange: range, verified: real === true });
    }
  }

  return {
    comparable,
    checks,
    regressions,
    gatePassed: checks.every(c => c.pass),
    // A partial run can never promote, however good it looks. The baseline it
    // would be promoted against describes cases it did not run.
    promote: comparable && checks.every(c => c.pass) && regressions.length === 0,
  };
}

/**
 * Round-robin over categories, order-stable within each.
 *
 * A prefix slice of a grouped dataset is not a sample of it. This keeps the
 * per-category proportions as even as the budget allows and is fully
 * deterministic, so `--limit 40` twice is the same forty cases.
 */
export function stratify(cases, limit) {
  if (!Number.isFinite(limit) || limit >= cases.length) return cases;
  const buckets = new Map();
  for (const c of cases) {
    const k = c.cat ?? 'uncategorised';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(c);
  }
  const queues = [...buckets.values()];
  const out = [];
  for (let round = 0; out.length < limit; round++) {
    let took = false;
    for (const q of queues) {
      if (round >= q.length) continue;
      out.push(q[round]);
      took = true;
      if (out.length >= limit) break;
    }
    if (!took) break;
  }
  // Restore dataset order so output reads naturally and is reproducible.
  const chosen = new Set(out.map(c => c.id));
  return cases.filter(c => chosen.has(c.id));
}

/**
 * Spread of one metric across repeat runs.
 *
 * 🔴 WHY THIS EXISTS: TWO IDENTICAL RUNS DISAGREED BY 16 POINTS.
 *
 * `--provider groq --model openai/gpt-oss-120b` was run twice over the same 200
 * cases at REQUESTED_TEMPERATURE 0. Between them, only the eval adapter's
 * surface casing changed — and `surfaces` feeds `subjectHits` and nothing else,
 * so `subject_recall` and `overall_strict_accuracy` were the only two metrics
 * that change could touch. Everything else moved anyway:
 *
 *   detection_modality   52.0% → 68.0%   (+16.0)
 *   fidelity_accuracy    66.5% → 64.1%   (− 2.4)
 *   predicate_accuracy   49.1% → 47.3%   (− 1.8)
 *   detection_recall     82.5% → 83.8%   (+ 1.3)
 *
 * Temperature 0 is requested and passed. The provider does not honour it as
 * determinism — batched MoE inference varies run to run. Asking harder will not
 * fix it, so the harness measures it instead.
 *
 * This matters because the second run BLOCKED PROMOTION on
 * `fidelity_accuracy 64.7% → 64.1%`, a 0.6-point gap, while carrying 16 points
 * of unmeasured noise. A single run cannot support that decision.
 */
/**
 * Is this pass DATA, or a record of the provider not answering?
 *
 * Extracted so it can be graded by behaviour. It was previously inline in
 * `main()` and covered only by `assert.match(src, /perCase\.push\(\{/)` — a
 * test that the STRING exists in the file. That proves nothing about which
 * pass gets reported, and the whole reason this logic exists is that an
 * earlier version reported a pass in which the provider had answered nothing
 * and published 0.0% detection as a measurement.
 *
 * @param {{aborted:boolean, passErrors:number}} pass
 * @param {number} caseCount
 */
export function passIsValid(pass, caseCount) {
  const errorRate = caseCount ? (pass.passErrors ?? 0) / caseCount : 1;
  return { valid: !pass.aborted && errorRate <= MAX_PASS_ERROR_RATE, errorRate };
}

/**
 * Which pass do we report?
 *
 * THE LAST VALID ONE — not an average, and not `passes[passes.length - 1]`.
 * Averaging invents a run that never happened and cannot be reproduced from
 * any single command. Taking the last pass unconditionally is what published
 * a fully-errored pass as a result.
 *
 * Returns null when nothing was measured, so the caller must handle "no data"
 * explicitly rather than receiving a plausible-looking empty pass.
 */
export function pickReportedPass(passes) {
  const good = (passes ?? []).filter(p => p.valid);
  return good.length ? good[good.length - 1] : null;
}

export function spread(values) {
  const v = values.filter(x => typeof x === 'number');
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean, min: Math.min(...v), max: Math.max(...v), range: Math.max(...v) - Math.min(...v), n: v.length };
}

/**
 * Is a drop against the baseline larger than the run-to-run noise?
 *
 * With one run there is no noise estimate, so nothing can be called a
 * regression honestly — the caller is told to repeat rather than given a
 * verdict built on a single sample.
 */
export function isRealRegression(before, after, noiseRange) {
  if (!(after < before)) return false;
  if (noiseRange == null) return null;      // unmeasured — not a verdict
  return (before - after) > noiseRange;
}

/** Metrics that are counts, not rates — rendering these as percentages produced
 *  a "false_positives 0.0% – 300.0%" line at the top of the first noise table. */
const IS_COUNT = /^(n_|false_positives$|positives$|negatives$|labelled_claims$)/;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const pct = n => `${(n * 100).toFixed(1)}%`;
const arrow = (a, b) => (b > a ? '▲' : b < a ? '▼' : '=');

async function main() {
  const dataset = JSON.parse(readFileSync(path.join(ROOT, 'eval/datasets/extraction-core.v1.json'), 'utf8'));
  const baseline = JSON.parse(readFileSync(path.join(ROOT, 'eval/baselines/extraction-core.v1.json'), 'utf8')).metrics;

  const limit = Number(flag('--limit', dataset.cases.length));

  /**
   * 🔴 `--limit` TOOK A PREFIX OF A CATEGORY-ORDERED DATASET.
   *
   * `extraction-core.v1` is grouped by category: cases 0-19 are all `identity`
   * and the first NEGATIVE case is at index 160. So `--limit 20` measured
   * twenty identity sentences, zero negatives, and nothing from decision,
   * modality, people, task or temporal — then printed those numbers beside a
   * baseline computed over all 200.
   *
   * The first shadow run failed the promotion gate on `negation 0%` when no
   * negation case had been sent, and listed `silence_on_negatives 0.9 → 0` as a
   * regression when the denominator was zero. Both came from here.
   *
   * Round-robin across categories instead. Deterministic — no RNG, so two runs
   * of the same --limit send the same cases and their numbers are comparable —
   * and it takes from every category before taking a second from any, so a
   * small budget still touches negatives.
   */
  const cases = stratify(dataset.cases, limit);
  const modelPin = flag('--model', null);

  /**
   * The transport. One segment per call — never several, see PR-5's header.
   *
   * ⚠️ PROVIDER IS SELECTABLE, AND OPENROUTER IS NO LONGER THE OBVIOUS CHOICE.
   *
   * This script was hardwired to OpenRouter, whose registry entry
   * `openai/gpt-oss-120b:free` is now deprecated — OpenRouter itself answers the
   * 404 with "the paid version is available now — use openai/gpt-oss-120b".
   *
   * The registry ALREADY lists that exact slug under groq (modelRegistry.js:90).
   * So the same model this run wants is reachable on a provider the project is
   * already configured for, without a paid OpenRouter route.
   *
   * There is a measurement reason to prefer it, not just a billing one. Free
   * OpenRouter routes are rate-limited (commonly ~50/day) and the roster rotates
   * weekly; a full pass is ~176 calls. A run that half-completes, or that gets
   * silently rerouted to whatever is free that week, measures the model rather
   * than E6 — which is the exact ambiguity the NOT PUBLISHABLE guard below
   * exists to catch. Both signatures are identical, so this is a binding
   * choice, not a rewrite.
   */
  const providerName = String(flag('--provider', 'openrouter')).toLowerCase();
  const generate = providerName === 'groq' ? generateGroq : generateOpenRouter;
  if (!['groq', 'openrouter'].includes(providerName)) {
    console.error(`\n✗ Unknown --provider "${providerName}" — expected groq or openrouter.\n`);
    process.exit(1);
  }

  const callModel = async ({ system, user, temperature, model }) => {
    const res = await generate(system, [{ role: 'user', content: user }],
      undefined, 1024, { model: model ?? modelPin ?? undefined, temperature });
    return { text: res.text, model: res.model ?? null };
  };

  // Fail before spending anything, rather than after 200 calls.
  try {
    const probe = buildExtractionPrompt('I work at Nummo.');
    await callModel({ system: probe.system, user: probe.user, temperature: 0, model: modelPin });
  } catch (err) {
    console.error(`\n✗ No usable provider: ${err?.message ?? err}`);
    console.error(`  Provider: ${providerName}. This script needs the same key the app uses.`);
    console.error('  If a model 404s as deprecated, the registry entry is stale — list the');
    console.error('  live ones first, then pin one:');
    console.error('    curl -s https://openrouter.ai/api/v1/models | jq -r \'.data[]|select(.pricing.prompt=="0")|.id\'');
    console.error('  Or use the provider the registry already has this model on:');
    console.error('    node scripts/e6-shadow.mjs --provider groq --model openai/gpt-oss-120b --limit 20');
    console.error('  Nothing was measured —');
    console.error('  a run with no transport emits no claims and would score 0.0% detection,');
    console.error('  which is indistinguishable from a catastrophically bad extractor.\n');
    process.exit(1);
  }

  const repeat = Math.max(1, Number(flag('--repeat', 1)));
  const paceMs = Math.max(0, Number(flag('--pace', 350)));
  const scoredCurrent = [];
  const e6Stats = { called: 0, cached: 0, errors: 0, models: new Set(), discardedByGate: {} };
  const passes = [];

  for (let pass = 0; pass < repeat; pass++) {
    // ⚠️ THE CACHE MUST GO BETWEEN PASSES OR THE VARIANCE IS ALWAYS ZERO.
    //
    // `extractionClient` memoises on a content hash, which is what makes a
    // single run reproducible. Repeating inside one process without clearing it
    // would replay pass 1 and report a spread of 0.000 — a confident, wrong
    // answer to the exact question `--repeat` exists to ask.
    if (pass > 0) { __clearExtractionCache(); process.stderr.write(`\n  ── pass ${pass + 1}/${repeat} ──\n`); }

    const scoredE6 = [];
    const perCase = [];
    let passErrors = 0, consecutiveErrors = 0, aborted = false;
    const unmeasured = [];   // cases the transport never answered

    for (const [i, c] of cases.entries()) {
      if (pass === 0) {
        const cur = extractWithCurrentEngine(c.text);
        scoredCurrent.push(suite.score(c, { facts: cur.facts ?? [], surfaces: surfacesOf(cur) }));
      }

      // Pace, so the per-minute limit is not walked into at full speed. The
      // earlier run issued 175 calls back to back and cooled every key.
      if (paceMs > 0 && !(pass === 0 && i === 0)) await sleep(paceMs);

      let e6 = await extractE6(c.text, { callModel, modelPin });

      // A stall is waitable when the provider says when it ends. Retry the SAME
      // case once after sleeping; the alternative is scoring an empty
      // extraction, which reads as a confident 0% rather than as a pause.
      if ((e6.stats.errors ?? 0) > 0 && providerName === 'groq') {
        const wait = msUntilAnyKeyFree();
        if (wait != null && wait > 0 && wait <= MAX_STALL_WAIT_MS) {
          process.stderr.write(`\n  ⏸  all keys cooling — sleeping ${Math.ceil(wait / 1000)}s, retrying case ${i + 1}\n`);
          await sleep(wait + 1000);
          e6 = await extractE6(c.text, { callModel, modelPin });
        } else if (wait != null && wait > MAX_STALL_WAIT_MS) {
          process.stderr.write(`\n  ✗ cooldown is ${Math.ceil(wait / 60000)} min — that is the DAILY quota, not the per-minute one.\n`);
        }
      }

      // ── A CASE THE TRANSPORT NEVER ANSWERED IS UNMEASURED, NOT A MISS ──────
      //
      // 🔴 THE RUN-LEVEL GUARD DID NOT REACH THE CASE LEVEL.
      //
      // The header of this script already refuses a run with no transport:
      // "a run with no transport emits no claims and would score 0.0%
      // detection, which is indistinguishable from a catastrophically bad
      // extractor." That reasoning is exactly as true for ONE case as for two
      // hundred, and this line scored every errored case as an extraction miss
      // — `e6.facts` is empty because nothing was asked, and an empty answer
      // grades identically to a wrong one.
      //
      // It bit immediately. In the first three-pass run all four transport
      // errors landed in pass 3, `pickReportedPass` takes the last VALID pass,
      // and 4/200 sits exactly on the 2% validity threshold — so the published
      // numbers came from the only pass with errors in it. On a 20-case
      // category a single unanswered case is five percentage points, and
      // `detection_negation` was reported at 70% against 85% in both clean
      // passes.
      //
      // Excluded from the scored set, so the denominator shrinks honestly
      // rather than the numerator being punished. This is the same rule the
      // suite already applies one level up: a metric with no cases is
      // unmeasured, not zero.
      const caseErrored = (e6.stats.errors ?? 0) > 0;
      const sc = suite.score(c, { facts: e6.facts, surfaces: e6.surfaces });
      if (caseErrored) unmeasured.push({ id: c.id, cat: c.cat });
      else scoredE6.push(sc);

      // ── PER-CASE RECORD ────────────────────────────────────────────────────
      //
      // 🔴 WITHOUT THIS, A CLEAN RUN STILL CANNOT ANSWER "WHY".
      //
      // `detection_negation` has read exactly 85.0% on both valid full runs —
      // 17 of 20, three cases missed, and the same three every time while every
      // other metric moved. Two explanations were checkable offline and both
      // came back negative: prompt rule 2 covers negation explicitly ("Never
      // drop a negation … polarity 'negated', not an omission"), and every
      // labelled negation predicate IS in the registry.
      //
      // What remains is whether the model returned [] or a gate rejected the
      // claim, and `discardedByGate` is aggregated across all 200 cases, so it
      // cannot say. One number, three suspects, no way to tell them apart.
      //
      // The scored metrics stay exactly as they were — this is a record of what
      // happened per case, not a new measurement.
      perCase.push({
        id: c.id, cat: c.cat,
        labelledClaims: (c.claims ?? []).length,
        e6Emitted: e6.facts.length,
        e6DiscardedBy: e6.stats.byGate ?? {},
        e6Errors: e6.stats.errors ?? 0,
        subjectHits: sc.subjectHits ?? 0,
        predicateHits: sc.predicateHits ?? 0,
        fidelityHits: sc.fidelityHits ?? 0,
        correct: !!sc.correct,
      });

      const errs = e6.stats.errors ?? 0;
      passErrors += errs;
      consecutiveErrors = errs > 0 ? consecutiveErrors + 1 : 0;

      e6Stats.called += e6.stats.called ?? 0;
      e6Stats.cached += e6.stats.cached ?? 0;
      e6Stats.errors += errs;
      for (const m of e6.stats.models ?? []) e6Stats.models.add(m);
      for (const [g, n] of Object.entries(e6.stats.byGate ?? {})) {
        e6Stats.discardedByGate[g] = (e6Stats.discardedByGate[g] ?? 0) + n;
      }

      // 🔴 STOP WHEN THE TRANSPORT DIES, RATHER THAN SCORING THE SILENCE.
      //
      // The pre-flight probe catches a provider that is dead at the START. It
      // cannot catch one that dies at case 130, which is what happened: all
      // four Groq keys hit rate limits mid-pass-2 (cooldowns of 186s to 657s),
      // pass 2 finished blind, and pass 3 made ZERO successful calls. Every
      // case scored an empty extraction — and empty scores 0% detection and
      // 100% silence_on_negatives, exactly the shape this file's own header
      // warns is "indistinguishable from a catastrophically bad extractor".
      if (consecutiveErrors >= ABORT_AFTER_CONSECUTIVE_ERRORS) {
        aborted = true;
        process.stderr.write(
          `\n  ✗ pass ${pass + 1} ABORTED at case ${i + 1}: ` +
          `${consecutiveErrors} consecutive transport errors. Not scoring silence as data.\n`);
        break;
      }
      if ((i + 1) % 20 === 0) process.stderr.write(`  … ${i + 1}/${cases.length}\n`);
    }

    // A pass is VALID only if the transport answered for essentially all of it.
    // An invalid pass is kept for the record and excluded from every number.
    const { valid, errorRate } = passIsValid({ aborted, passErrors }, cases.length);
    passes.push({ metrics: suite.metrics(scoredE6), perCase, unmeasured, valid, passErrors, errorRate, aborted, index: pass + 1 });
    if (!valid) {
      console.error(`  ⚠️  pass ${pass + 1} INVALID — ${passErrors} transport errors ` +
        `(${(errorRate * 100).toFixed(1)}% of cases). Excluded from results.`);
    }
  }

  const mCur = suite.metrics(scoredCurrent);

  // Only VALID passes are data. The previous version reported
  // `passes[passes.length - 1]` unconditionally and picked a pass in which the
  // provider had answered nothing — publishing 0.0% detection as a measurement.
  const good = passes.filter(p => p.valid);
  if (!pickReportedPass(passes)) {
    console.error(`\n✗ NOTHING WAS MEASURED — all ${passes.length} pass(es) failed on transport.`);
    console.error(`  ${e6Stats.errors} errors across ${e6Stats.called} calls.`);
    console.error('  Cooldowns of this length are the DAILY quota, not the per-minute one —');
    console.error('  pacing and waiting cannot get past it. The keys have to reset.');
    console.error('  Once they have: --repeat 3 --limit 40 --pace 1200   (~105 calls).');
    process.exit(1);
  }

  // The last VALID pass, not an average — averaging invents a run that never
  // happened and cannot be reproduced from any single command.
  const reported = pickReportedPass(passes);
  const mE6 = reported.metrics;

  const noise = {};
  if (good.length > 1) {
    for (const k of Object.keys(mE6)) {
      const sp = spread(good.map(p => p.metrics[k]));
      if (sp && sp.range > 0) noise[k] = sp;
    }
  }

  console.log(`\nE6 SHADOW RUN · ${cases.length} cases · ${e6Stats.called} calls, ${e6Stats.cached} cache hits`);
  console.log(`models seen: ${[...e6Stats.models].join(', ') || '(none reported)'}\n`);
  console.log('metric                     baseline    current       E6');
  for (const k of ['detection_recall', 'subject_recall', 'predicate_accuracy',
    'fidelity_accuracy', 'silence_on_negatives', 'overall_strict_accuracy',
    'detection_negation', 'detection_temporal', 'detection_modality']) {
    const b = baseline[k] ?? 0, c = mCur[k] ?? 0, e = mE6[k] ?? 0;
    console.log(`${k.padEnd(26)} ${pct(b).padStart(7)}  ${pct(c).padStart(8)}  ${pct(e).padStart(8)} ${arrow(c, e)}`);
  }

  // A partial run is not comparable to a full-set baseline, and the script now
  // says so rather than printing a difference between two populations.
  const fullRun = cases.length === dataset.cases.length;
  const verdict = evaluatePromotion(mE6, baseline, { comparable: fullRun, noise });
  if (!fullRun) {
    console.log(`\n⚠️  PARTIAL RUN — ${cases.length} of ${dataset.cases.length} cases.`);
    console.log('   Baseline comparison and promotion are DISABLED: the committed baseline');
    console.log('   describes all 200 cases and this run did not send them. The current-vs-E6');
    console.log('   columns above are still valid — both lanes saw exactly these cases.');
  }
  console.log('\nPROMOTION GATE');
  for (const c of verdict.checks) {
    // An unmeasured check prints NOT MEASURED, never 0.0% FAIL. It still
    // blocks promotion — untested is not passed — but it no longer looks like
    // a catastrophic score and send someone diagnosing a working extractor.
    const got = c.measured === false ? '    n/a' : pct(c.got).padStart(7);
    const status = c.measured === false ? 'NOT MEASURED (no cases in this run)' : (c.pass ? 'PASS' : 'FAIL');
    console.log(`  ${c.name.padEnd(10)} ${got} need ≥ ${pct(c.need)}  ${status}`);
  }
  if (verdict.regressions.length) {
    console.log('\n  REGRESSIONS vs the committed baseline:');
    for (const r of verdict.regressions) {
      const tag = r.verified ? `exceeds noise ±${pct(r.noiseRange)}`
        : 'UNVERIFIED — no noise estimate, re-run with --repeat 3';
      console.log(`    ${r.metric}: ${pct(r.before)} → ${pct(r.after)}  (${tag})`);
    }
  }

  console.log(`\nreported: pass ${reported.index} of ${passes.length}` +
    (passes.length > good.length ? `  (${passes.length - good.length} INVALID, excluded)` : '') +
    `  ·  ${e6Stats.errors} transport error(s)`);

  if (good.length > 1) {
    const noisy = Object.entries(noise).sort((a, b) => b[1].range - a[1].range);
    console.log(`\nRUN-TO-RUN NOISE over ${good.length} valid passes (same model, temperature 0)`);
    if (!noisy.length) console.log('  none — every metric was identical across passes');
    for (const [k, sp] of noisy.slice(0, 8)) {
      // ⚠️ NOT EVERY METRIC IS A RATE. `false_positives` is a COUNT, and the
      // first noise report rendered 3 of them as "300.0%" — a number that is
      // not wrong so much as meaningless, sitting at the top of the table
      // because it sorted highest. Counts print as counts.
      const fmt = IS_COUNT.test(k) ? (v => v.toFixed(0)) : pct;
      console.log(`  ${k.padEnd(26)} ${String(fmt(sp.min)).padStart(7)} – ${String(fmt(sp.max)).padStart(7)}   range ${fmt(sp.range)}`);
    }
  } else if (repeat > 1) {
    console.log(`\n⚠️  NOISE NOT MEASURED — only ${good.length} of ${repeat} passes were valid.`);
  } else {
    console.log('\n⚠️  NOISE NOT MEASURED — single pass. Two identical runs of this model have');
    console.log('    differed by 16 points on detection_modality, so a small movement here');
    console.log('    means nothing. Use --repeat 3 before acting on any near-threshold number.');
  }

  // ── What actually missed, by category ────────────────────────────────────
  // Errored cases are excluded: they are not extraction failures, and listing
  // them here sends someone reading the diagnosis to the prompt for a problem
  // that was a timeout.
  const missed = reported.perCase.filter(r => r.labelledClaims > 0 && r.e6Emitted === 0 && !r.e6Errors);
  if (missed.length) {
    const byCat = {};
    for (const r of missed) (byCat[r.cat] ??= []).push(r);
    console.log(`\nEMITTED NOTHING — ${missed.length} case(s) with labelled claims`);
    for (const [cat, rows] of Object.entries(byCat).sort()) {
      const gates = {};
      for (const r of rows) for (const [g, n] of Object.entries(r.e6DiscardedBy)) gates[g] = (gates[g] ?? 0) + n;
      const why = Object.keys(gates).length
        ? Object.entries(gates).map(([g, n]) => `${g}×${n}`).join(', ')
        : 'model returned [] — no gate involved';
      console.log(`  ${cat.padEnd(10)} ${String(rows.length).padStart(2)}  ${why}`);
      for (const r of rows.slice(0, 3)) console.log(`               ${r.id}`);
    }
  }

  const attributable = e6Stats.models.size > 0;
  if (!attributable) {
    console.log('\n⚠️  NOT PUBLISHABLE — no model id was reported for any call.');
    console.log('    A difference in these numbers could be the prompt or a different model,');
    console.log('    and nothing here distinguishes them. Re-run with --model <id>.');
  }

  if (reported.unmeasured?.length) {
    const byCat = {};
    for (const u of reported.unmeasured) byCat[u.cat] = (byCat[u.cat] ?? 0) + 1;
    console.log(`\nUNMEASURED — ${reported.unmeasured.length} case(s) the transport never answered, excluded from every metric`);
    console.log(`  ${Object.entries(byCat).map(([c, n]) => `${c}×${n}`).join(', ')}`);
    console.log(`  ${reported.unmeasured.map(u => u.id).join(', ')}`);
  }

  console.log(`\nVERDICT: ${verdict.promote && attributable ? 'PROMOTE' : 'DO NOT PROMOTE'}`);
  if (verdict.gatePassed && verdict.regressions.length) {
    console.log('  (the gate passed but a committed metric went backwards — that is a regression wearing a passing grade)');
  }
  console.log();

  const out = flag('--json');
  if (out) {
    const p = path.resolve(process.cwd(), out);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({
      cases: cases.length, baseline, current: mCur, e6: mE6, verdict,
      attributable, models: [...e6Stats.models], stats: { ...e6Stats, models: [...e6Stats.models] },
      reportedPass: reported.index, validPasses: good.length, totalPasses: passes.length,
      // Per case, from the REPORTED pass. This is what turns a score into a
      // diagnosis: which case missed, whether anything was emitted at all, and
      // which gate dropped it. The aggregate `discardedByGate` above cannot
      // attribute a discard to a case, so "detection_negation 85%" has been
      // unexplainable across three sessions.
      perCase: reported.perCase, unmeasured: reported.unmeasured ?? [],
    }, null, 2));
    console.log(`→ ${p}\n`);
  }

  process.exit(verdict.promote && attributable ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('e6-shadow.mjs')) {
  main().catch(err => { console.error(err); process.exit(1); });
}
