/**
 * AQUA Eval — report
 * Blueprint E2/PR-1
 *
 * Two outputs from one run, and the split matters:
 *
 *   toJSON(report)     the machine record. Keys sorted, manifest separated
 *                      from result, so two runs of the same commit over the
 *                      same suite are BYTE-IDENTICAL in `result`. That
 *                      property is what E2/PR-6's regression gate stands on.
 *
 *   toHuman(report)    what a person reads. Coverage first, because a metric
 *                      without its coverage is the easiest number in this
 *                      project to misread.
 *
 * Timings and timestamps live only in the human view and the manifest. A
 * report that changes because the machine was busy cannot gate anything.
 */

/** Stable stringify — object keys sorted at every depth, arrays left in order. */
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortValue(v[k])]));
  }
  return v;
}

export function toJSON(report, { pretty = true } = {}) {
  // Two shapes: one report, or a multi-suite envelope `{ schemaVersion,
  // reports: [...] }`. E2/PR-1 handled only the first, so `npm run eval --json`
  // across several suites silently wrote a file containing nothing but
  // `{"schemaVersion":1}` — no error, no warning, a 25-byte lie. Found in
  // E2/PR-6 the moment the gate needed to read it. Fixed here rather than
  // behind a flag: a bug fix behind a flag is a bug that stays (L15).
  const stable = Array.isArray(report.reports)
    ? {
        schemaVersion: report.schemaVersion,
        reports: report.reports.map(r => ({
          schemaVersion: r.schemaVersion,
          manifest: sortValue(r.manifest),
          result: sortValue(r.result),
        })),
      }
    : {
        schemaVersion: report.schemaVersion,
        manifest: sortValue(report.manifest),
        result: sortValue(report.result),
      };
  return JSON.stringify(stable, null, pretty ? 2 : 0) + '\n';
}

/** Just the part that must not drift. Used by the regression gate in PR-6. */
export function comparableBody(report) {
  return JSON.stringify(sortValue(report.result));
}

const pct = n => `${(n * 100).toFixed(1)}%`;

export function toHuman(report) {
  const { result, manifest } = report;
  const { coverage, metrics, suite } = result;
  const lines = [];

  lines.push(`── ${suite.id} — ${suite.title} ──`);
  lines.push(suite.about.trim().split('\n').map(l => `   ${l.trim()}`).join('\n'));
  lines.push('');

  // COVERAGE FIRST, ALWAYS. A precision figure means nothing until you know
  // how many cases it was computed over.
  lines.push(`   cases      ${coverage.total}`);
  lines.push(`   executed   ${coverage.executed}`);
  if (coverage.skipped) lines.push(`   skipped    ${coverage.skipped}   (NOT EXECUTED — see reasons below)`);
  if (coverage.errored) lines.push(`   errored    ${coverage.errored}   (harness or code failure, NOT a wrong answer)`);
  if (!coverage.complete) {
    lines.push('');
    lines.push('   ⚠ INCOMPLETE RUN — metrics below cover the executed cases only.');
  }
  lines.push('');

  if (result.metricsError) {
    lines.push(`   ✗ metrics() threw: ${result.metricsError}`);
  } else if (Object.keys(metrics).length === 0) {
    lines.push('   (no metrics — nothing executed)');
  } else {
    for (const [name, value] of Object.entries(metrics).sort()) {
      const shown = typeof value === 'number'
        ? (value >= 0 && value <= 1 ? `${value.toFixed(4)}  (${pct(value)})` : String(value))
        : String(value);
      lines.push(`   ${name.padEnd(24)} ${shown}`);
    }
  }

  const notRun = result.cases.filter(c => c.status !== 'ok');
  if (notRun.length) {
    lines.push('');
    lines.push('   not executed:');
    for (const c of notRun.slice(0, 20)) {
      lines.push(`     ${c.status.padEnd(8)} ${String(c.id).padEnd(28)} ${c.reason ?? ''}`);
    }
    if (notRun.length > 20) lines.push(`     … and ${notRun.length - 20} more`);
  }

  lines.push('');
  lines.push(`   commit ${manifest.commit.slice(0, 12)}${manifest.dirty ? ' (dirty)' : ''} · node ${manifest.node} · suite ${manifest.suiteFingerprint}`);
  return lines.join('\n');
}
