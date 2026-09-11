/**
 * AQUA Eval — the runner
 * Blueprint E2/PR-1 · Constitution L14
 *
 * WHY THIS EXISTS
 * ---------------
 * `flagproof.mjs` answers "does this flag do anything at all". `rollout.mjs`
 * answers "what does turning it on cost me". Neither answers **"is it right"**,
 * and until something does, every extraction and retrieval change in this
 * project ships on an opinion.
 *
 * That is not a hypothetical. The comprehension layer has been patched
 * repeatedly — capitalisation gates, sentence splitting, closed goal verbs,
 * closed self-declaration verbs — and each fix was judged by reading examples.
 * E6 replaces that layer wholesale with an LLM extractor. Without a number for
 * what the regex extractor scores today, E6 has nothing to beat and no way to
 * fail.
 *
 * WHAT THIS RUNNER DELIBERATELY DOES NOT KNOW
 * -------------------------------------------
 * Extraction. Retrieval. Claims. Anything about AQUA. It executes cases,
 * records the ones that could not run, and hands the rest to the suite's own
 * scorer. Every later E2 PR adds a suite; none of them edits this file.
 *
 * THREE OUTCOMES, NEVER TWO
 * -------------------------
 *   ok        executed and scored
 *   skipped   COULD NOT RUN — reported with a reason, never scored, never
 *             estimated (AQEval's rule, and the right one)
 *   error     run() threw — an execution failure, NOT a wrong answer
 *
 * Collapsing `error` into "incorrect" is the mistake that makes a crash look
 * like a quality regression and sends someone debugging the model instead of
 * the harness.
 */
import { validateSuite, normalizeRunResult } from './suiteSchema.mjs';
import { buildManifest } from './manifest.mjs';

/**
 * Execute one suite.
 *
 * @param {object} suite   see suiteSchema.mjs
 * @param {object} [opts]
 * @param {object} [opts.context]  passed to run() — where a later suite gets
 *                                 its engine handles, temp dirs, etc.
 * @param {number} [opts.caseTimeoutMs]  per-case wall clock; a hung case must
 *                                       not hang the whole harness
 * @returns {Promise<object>} report — { schemaVersion, manifest, result }
 */
export async function runSuite(suite, { context = {}, caseTimeoutMs = 30_000 } = {}) {
  validateSuite(suite);
  const manifest = buildManifest(suite);

  const cases = [];
  for (const testCase of suite.cases) {
    cases.push(await runOne(suite, testCase, context, caseTimeoutMs));
  }

  // Sorted by id so the comparable body is stable regardless of case order in
  // the source file — a dataset reordered in review must not read as a change.
  cases.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const executed = cases.filter(c => c.status === 'ok');
  const skipped = cases.filter(c => c.status === 'skipped');
  const errored = cases.filter(c => c.status === 'error');

  // Metrics are computed over EXECUTED cases only. A suite that ran 40 of 200
  // cases must never report a number that reads like it ran all of them, so
  // `coverage` travels with the metrics and `complete` is explicit.
  let metrics = {};
  let metricsError = null;
  try {
    metrics = executed.length ? (suite.metrics(executed.map(c => c.scored)) ?? {}) : {};
  } catch (err) {
    metricsError = err?.message ?? String(err);
  }

  return {
    schemaVersion: 1,
    manifest,
    result: {
      suite: { id: suite.id, title: suite.title, about: suite.about },
      coverage: {
        total: cases.length,
        executed: executed.length,
        skipped: skipped.length,
        errored: errored.length,
        complete: skipped.length === 0 && errored.length === 0,
      },
      metrics,
      metricsError,
      cases: cases.map(stripInternal),
    },
  };
}

async function runOne(suite, testCase, context, caseTimeoutMs) {
  const id = String(testCase.id);
  const started = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - started) / 1e6;

  let outcome;
  try {
    outcome = normalizeRunResult(await withTimeout(
      Promise.resolve(suite.run(testCase, context)), caseTimeoutMs, id,
    ));
  } catch (err) {
    return { id, status: 'error', reason: err?.message ?? String(err), durationMs: ms() };
  }

  if (outcome.status === 'skipped') {
    return { id, status: 'skipped', reason: outcome.reason, durationMs: ms() };
  }

  let scored;
  try {
    scored = suite.score(testCase, outcome.actual);
    if (!scored || typeof scored.correct !== 'boolean') {
      throw new Error('score() must return an object with a boolean `correct`');
    }
  } catch (err) {
    // A scorer that throws is a harness bug, not a model result. Same
    // reasoning as a throwing run(): it must not be counted as incorrect.
    return { id, status: 'error', reason: `score(): ${err?.message ?? err}`, durationMs: ms() };
  }

  return { id, status: 'ok', correct: scored.correct, scored, durationMs: ms() };
}

function withTimeout(promise, timeoutMs, id) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      // NOT unref'd. An unref'd timer cannot keep the event loop alive, so a
      // case that never settles would drain the loop and take the harness with
      // it — the exact failure this timeout exists to rescue. The timer is
      // cleared on settle above, so a normal case never holds the process open.
      timer = setTimeout(() => reject(new Error(`case "${id}" exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

/**
 * Per-case timings are real but they are NOT part of the comparable body —
 * they differ on every machine, and a report that changes because the laptop
 * was busy cannot gate anything. Kept out of `cases`, summarised in the
 * human view instead.
 */
function stripInternal(c) {
  const out = { id: c.id, status: c.status };
  if (c.status === 'ok') {
    out.correct = c.correct;
    const extra = { ...c.scored };
    delete extra.correct;
    if (Object.keys(extra).length) out.detail = extra;
  } else {
    out.reason = c.reason;
  }
  return out;
}
