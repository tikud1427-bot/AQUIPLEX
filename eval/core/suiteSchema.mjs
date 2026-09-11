/**
 * AQUA Eval — suite contract
 * Blueprint E2/PR-1
 *
 * A suite is a plain object. The runner knows nothing about extraction,
 * retrieval, or anything else this project measures — it knows how to execute
 * cases, how to record a case that could not run, and how to refuse a suite
 * that is malformed.
 *
 * That separation is the point. E2/PR-2 through PR-5 add datasets and scorers
 * by writing suites; none of them touches the runner. If a later suite needs
 * the runner changed, that is a signal the contract below was wrong, not an
 * invitation to special-case it.
 *
 *   {
 *     id       'extraction-core'      stable, file-safe, used as the report key
 *     title    one line
 *     about    why this suite exists — printed in the report, read by humans
 *     cases    [{ id, ... }]          whatever the suite's run() understands
 *     run      async (case, ctx) => { status, actual?, reason? }
 *     score    (case, actual)  => { correct: boolean, ...extra }
 *     metrics  (scored)        => { name: number }    aggregate, suite-defined
 *   }
 *
 * run() returns one of:
 *   { status: 'ok', actual }        executed, hand it to score()
 *   { status: 'skipped', reason }   COULD NOT RUN — never scored, never guessed
 *
 * A throw from run() becomes status 'error'. That is deliberately NOT the same
 * as a wrong answer: an extractor that crashes and an extractor that answers
 * incorrectly are different failures, and a harness that conflates them will
 * report a crash as a quality regression and send someone hunting in the wrong
 * place.
 */

const isFn = v => typeof v === 'function';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export class SuiteError extends Error {
  constructor(message) { super(message); this.name = 'SuiteError'; }
}

/**
 * Validate a suite before a single case runs.
 *
 * Loud and early on purpose: a suite with a missing `score` would otherwise
 * run 200 cases and report 0% — a number that looks like a catastrophic
 * quality result and is actually a typo.
 */
export function validateSuite(suite) {
  if (!suite || typeof suite !== 'object') throw new SuiteError('suite must be an object');
  if (!ID_RE.test(suite.id ?? '')) {
    throw new SuiteError(`suite.id must match ${ID_RE} (got ${JSON.stringify(suite.id)})`);
  }
  if (!suite.title) throw new SuiteError(`${suite.id}: suite.title is required`);
  if (!suite.about) throw new SuiteError(`${suite.id}: suite.about is required — a suite whose purpose is not written down cannot be judged`);
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new SuiteError(`${suite.id}: suite.cases must be a non-empty array`);
  }
  for (const fn of ['run', 'score', 'metrics']) {
    if (!isFn(suite[fn])) throw new SuiteError(`${suite.id}: suite.${fn} must be a function`);
  }

  const seen = new Set();
  for (const [i, c] of suite.cases.entries()) {
    if (!c || typeof c !== 'object') throw new SuiteError(`${suite.id}: case ${i} is not an object`);
    if (c.id === undefined || c.id === null || String(c.id).length === 0) {
      throw new SuiteError(`${suite.id}: case ${i} has no id`);
    }
    const id = String(c.id);
    if (seen.has(id)) throw new SuiteError(`${suite.id}: duplicate case id "${id}" — ids key the report and must be unique`);
    seen.add(id);
  }
  return true;
}

/** Normalise whatever run() returned into the runner's internal shape. */
export function normalizeRunResult(result) {
  if (result === undefined || result === null) {
    throw new SuiteError('run() returned nothing — return { status: "ok", actual } or { status: "skipped", reason }');
  }
  if (result.status === 'skipped') {
    if (!result.reason) throw new SuiteError('a skipped case must carry a reason — "not executed" without a why is not a result');
    return { status: 'skipped', reason: String(result.reason) };
  }
  if (result.status === 'ok') return { status: 'ok', actual: result.actual };
  throw new SuiteError(`run() returned unknown status ${JSON.stringify(result.status)}`);
}
