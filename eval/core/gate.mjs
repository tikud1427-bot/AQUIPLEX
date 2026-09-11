/**
 * AQUA Eval — the regression gate
 * Blueprint E2/PR-6 · Constitution L14
 *
 * The last piece of Epic 2. Until now the baselines were numbers in a file
 * that nobody was obliged to look at. This makes them a merge condition.
 *
 * THE NOISE BAND IS ZERO, AND THAT WAS MEASURED
 * ---------------------------------------------
 * The blueprint says noise bands come from three consecutive runs. They were
 * run: the comparable body is BYTE-IDENTICAL across three, and Ananya's Node
 * 20 reproduced the same figures as Node 22 to the fourth decimal. There is no
 * model call and no clock in either suite, so the band is genuinely 0 rather
 * than merely small.
 *
 * `EPSILON` therefore exists only to absorb IEEE-754 drift, not real
 * variation. Setting a generous band "to be safe" would hide exactly the small
 * regressions this gate exists to catch — a 2% drop in negation fidelity is
 * the kind of thing that never gets noticed once it is inside a tolerance.
 *
 * DIRECTION MATTERS, AND GETTING IT WRONG IS THE OBVIOUS TRAP
 * ----------------------------------------------------------
 * Most metrics are higher-is-better. `noise_lines`, `noisy_queries` and
 * `false_positives` are LOWER-is-better. A gate that treated everything as
 * higher-is-better would wave through a doubling of noise as an improvement —
 * the precise failure the datasets were built to expose.
 */

/** Absorbs float representation drift. NOT a tolerance for real change. */
export const EPSILON = 1e-9;

/** Metrics where a larger number is worse. Everything else is higher-is-better. */
export const LOWER_IS_BETTER = new Set([
  'noise_lines', 'noisy_queries', 'false_positives',
  // A wrongly-admitted segment costs an extractor call and can mint a bad
  // entity. Fewer is better, and the gate said otherwise: it reported
  // `n_false_admits 17 → 16` as a REGRESSION and blocked on it, which is the
  // exact inversion this file's header warns about, pointing the other way.
  'n_false_admits', 'n_captured_but_unreachable',
  // Found by widening the completeness test to every baseline instead of a
  // hand-listed two: forensic-edited reports this and nobody had declared it,
  // so the gate would have waved through a DOUBLING of false positives on that
  // suite as an improvement.
  'n_false_positives',
  // Same lesson, found the same way — by breaking the rule on purpose and
  // watching the gate. `forensic-report` counts what the whole rule EMITS over
  // a fixed corpus with fixed labels. Deleting the cross-file condition, so
  // that ordinary table rows inside one document are accused of tampering,
  // took it 17 -> 20 and the gate called that an improvement and passed.
  //
  // This is the FINDING-2 failure mode exactly: 90 accusations from 20 rows.
  // On a fixed corpus more accusations is worse, and a genuine recall win that
  // raises it should have to say so in a baseline update rather than arrive
  // unremarked.
  'n_report_findings',
]);

/**
 * Metrics that describe the dataset or the route taken, not quality.
 *
 * `n_via_*` counts which lane admitted a segment. They move whenever an
 * upstream lane gets better at its job — improving the entity extractor pushed
 * `n_via_cue_proper_noun` 45 → 29 because the cue fallback was no longer
 * needed, and the gate read a 16-point drop as a regression while
 * `gate_recall` had not moved at all.
 *
 * A route count is a diagnostic. Reported, never gated: there is no direction
 * in which it is "better", and pretending there is turns a healthy shift in
 * where work happens into a blocked build.
 */
export const STRUCTURAL = new Set([
  'positives', 'negatives', 'labelled_claims',
  'answerable_queries', 'silence_queries', 'n_claim_bearing',
]);

/**
 * Per-category case counts published by `extraction-core`.
 *
 * They exist so a caller can tell a scored 0.0 from a 0/0 — the E6 promotion
 * gate failed on `negation 0%` when no negation case had been sent. They
 * describe the DATASET, so they are structural: a change means the corpus
 * changed, which is never an improvement or a regression, and grading them
 * would turn a deliberate dataset edit into a blocked build.
 */
export const STRUCTURAL_PREFIXES = ['n_cases_'];

/**
 * DIAGNOSTIC — reported, compared, and never gated in either direction.
 *
 * STRUCTURAL was the wrong home for these and the distinction is worth keeping
 * sharp. A structural change means the DATASET moved, so every other metric now
 * means something different and the run must stop. A diagnostic change means
 * the SYSTEM moved work from one lane to another, which is often the intended
 * result of an improvement.
 *
 * Route counts are the clear case. Improving the entity extractor pushed
 * `n_via_cue_proper_noun` 45 → 29, because the cue fallback was no longer
 * needed to catch third-person subjects — while `gate_recall` did not move at
 * all. Gating that as a regression blocks the build for getting better, and
 * gating it as structural would claim the dataset had changed, which is worse:
 * it is a true statement about the wrong thing.
 *
 * There is no direction in which a route count is "better". Report it, let a
 * human read it, and gate on the quality metrics next to it.
 */
export const DIAGNOSTIC = new Set([
  'n_admitted',
  'n_via_cue_proper_noun', 'n_via_declarative_intent', 'n_via_entity_extractor',
]);

/**
 * Suites that must NEVER be gated, whatever baseline files exist on disk.
 *
 * `selftest` grades the harness itself and is DELIBERATELY incomplete — it
 * carries a skip and a throw so every runner path is exercised. E2/PR-6
 * excluded it by relying on the ABSENCE of a baseline file, which held right
 * up until someone ran `--update`: that regenerated a baseline for every
 * suite, and the gate then blocked forever on a suite designed to be
 * incomplete.
 *
 * Excluding it by NAME rather than by the absence of a file is the fix. An
 * invariant that depends on a file not existing is not an invariant.
 */
export const NOT_GATED = new Set(['selftest']);

export const VERDICT = Object.freeze({
  PASS: 'pass', IMPROVED: 'improved', REGRESSED: 'regressed',
  MISSING: 'missing', NEW: 'new', STRUCTURAL_CHANGE: 'structural-change',
});

/**
 * Compare one suite's fresh result against its committed baseline.
 *
 * @param {object} baseline  the committed `{ suiteFingerprint, coverage, metrics }`
 * @param {object} report    a fresh `{ manifest, result }`
 * @returns {{ ok: boolean, blocking: string[], rows: object[] }}
 */
export function compareToBaseline(baseline, report) {
  const rows = [];
  const blocking = [];
  const metrics = report.result.metrics ?? {};

  // ── Refusals: conditions under which a comparison is meaningless ──────────
  //
  // These are not "failures" in the metric sense — they mean the two sides are
  // not comparable at all, and reporting a metric delta would be inventing a
  // result. The gate refuses rather than guesses.
  if (!report.result.coverage.complete) {
    blocking.push(
      `INCOMPLETE RUN (${report.result.coverage.skipped} skipped, ` +
      `${report.result.coverage.errored} errored) — a partial run's numbers are not comparable`);
  }
  if (baseline.suiteFingerprint && report.manifest.suiteFingerprint !== baseline.suiteFingerprint) {
    blocking.push(
      `DATASET CHANGED (baseline ${baseline.suiteFingerprint}, run ${report.manifest.suiteFingerprint}) — ` +
      'two runs over different data are not comparable. Regenerate the baseline in a PR that says why.');
  }

  // ── Per-metric comparison ────────────────────────────────────────────────
  const seen = new Set();
  for (const [name, was] of Object.entries(baseline.metrics ?? {})) {
    seen.add(name);
    if (!(name in metrics)) {
      rows.push({ name, was, now: null, verdict: VERDICT.MISSING });
      blocking.push(`METRIC REMOVED: ${name} — a measurement disappeared, which is not an improvement`);
      continue;
    }
    const now = metrics[name];
    const delta = now - was;

    if (STRUCTURAL.has(name) || STRUCTURAL_PREFIXES.some(pre => name.startsWith(pre))) {
      const same = Math.abs(delta) < EPSILON;
      rows.push({ name, was, now, delta, verdict: same ? VERDICT.PASS : VERDICT.STRUCTURAL_CHANGE });
      if (!same) {
        blocking.push(`DATASET SHAPE CHANGED: ${name} ${was} → ${now} — every other metric now means something different`);
      }
      continue;
    }

    if (DIAGNOSTIC.has(name)) {
      rows.push({ name, was, now, delta, verdict: VERDICT.PASS });
      continue;
    }

    const worse = LOWER_IS_BETTER.has(name) ? delta > EPSILON : delta < -EPSILON;
    const better = LOWER_IS_BETTER.has(name) ? delta < -EPSILON : delta > EPSILON;
    const verdict = worse ? VERDICT.REGRESSED : better ? VERDICT.IMPROVED : VERDICT.PASS;
    rows.push({ name, was, now, delta, verdict });
    if (worse) blocking.push(`REGRESSED: ${name} ${fmt(was)} → ${fmt(now)} (${fmt(delta, true)})`);
  }

  // A new metric is reported, never blocking — adding a measurement is good.
  for (const [name, now] of Object.entries(metrics)) {
    if (!seen.has(name)) rows.push({ name, was: null, now, verdict: VERDICT.NEW });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: blocking.length === 0, blocking, rows };
}

const fmt = (n, signed = false) => {
  if (n === null || n === undefined) return '—';
  const s = Math.abs(n) < 1 && n !== 0 ? n.toFixed(4) : String(n);
  return signed && n > 0 ? `+${s}` : s;
};

/** Human-readable gate report. */
export function gateReport(suiteId, { ok, blocking, rows }) {
  const lines = [`── gate: ${suiteId} ──`];
  const interesting = rows.filter(r => r.verdict !== VERDICT.PASS);
  if (!interesting.length) {
    lines.push(`   ${rows.length} metrics, all unchanged`);
  } else {
    for (const r of interesting) {
      const mark = { improved: '↑', regressed: '↓', missing: '✗', new: '+', 'structural-change': '!' }[r.verdict];
      lines.push(`   ${mark} ${r.name.padEnd(26)} ${fmt(r.was)} → ${fmt(r.now)}`);
    }
    const unchanged = rows.length - interesting.length;
    if (unchanged) lines.push(`   · ${unchanged} unchanged`);
  }
  for (const b of blocking) lines.push(`   ✗ ${b}`);
  lines.push(`   ${ok ? 'PASS' : 'BLOCKED'}`);
  return lines.join('\n');
}
