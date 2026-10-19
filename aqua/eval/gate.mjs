#!/usr/bin/env node
/**
 * AQUA Eval — gate CLI
 * Blueprint E2/PR-6
 *
 *   npm run eval:gate           run every suite that has a baseline, compare, exit
 *   npm run eval:gate -- --update   regenerate the baselines (deliberate act)
 *
 * EXIT CODES
 *   0  every metric held or improved
 *   1  a metric regressed, a measurement disappeared, the dataset changed,
 *      or a run was incomplete
 *
 * Suites WITHOUT a committed baseline are reported and skipped rather than
 * failing. The self-test suite has no baseline by design — it grades the
 * harness, and a harness self-check is not a quality metric to gate on.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Isolation ────────────────────────────────────────────────────────────────
//
// 🔴 THE GATE WAS THE ONE ENTRY POINT THIS GUARD DID NOT COVER.
//
// `scripts/run-tests.mjs` sandboxes AQUA_DATA_DIR before spawning, and
// `src/core/tests/testCoverage.test.js` asserts that it took. Both were written
// because, unset, the variable resolves to `os.homedir()/.aquiplex` — a
// developer's REAL store. Neither reached the gate, which runs as
// `node eval/gate.mjs` and never spawns through the runner.
//
// Observed, not hypothesised. A plain `npm run eval:gate -- extraction-core
// --update` on a developer machine printed:
//
//   [EVIDENCE]  Loaded 409 fact(s), 405 evidence object(s) across 18 owner(s)
//   [REASONING] Graph loaded: 1521 node(s), 7729 edge(s) across 19 owner(s)
//
// from `C:\Users\<user>\.aquiplex`. That is a person's live conversations,
// minds and projects, read by an eval run — and `capture-core` drives the real
// turn path with `drainJobs`, while several suites call `purgeOwner`. The
// baseline being regenerated was measured against a store nobody controls, and
// it differs machine to machine.
//
// Set HERE, before any suite is imported, where ESM hoisting cannot reach it.
// Half the adapters assign AQUA_DATA_DIR in their own module bodies; that only
// works when the adapter happens to be the first thing to touch `dataDir.js`,
// which is an ordering accident, not isolation.
//
// An explicit AQUA_DATA_DIR from the caller is respected — pointing a run at a
// fixture directory on purpose means it.
if (!process.env.AQUA_DATA_DIR) {
  process.env.AQUA_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'aqua-eval-'));
}
// The mirror would otherwise try to reach a real cluster from an eval run.
process.env.AQUA_DISABLE_MONGO_MIRROR ??= '1';

import { runSuite } from './core/runner.mjs';
import { compareToBaseline, gateReport, NOT_GATED } from './core/gate.mjs';
import { toJSON } from './core/report.mjs';
import { testDatabaseEnv } from '../src/core/db/testDatabaseEnv.js';

// THE DATABASE IS NEVER INHERITED (2026-10-16). The gate's legacy context
// suites used to read whatever DATABASE_URL the shell exported: with one, the
// read mode flipped to canonical and their metrics went to 0; with a developer's
// real database, a database suite would have written into it. Exactly the
// runner's rule: Postgres only via AQUA_TEST_DATABASE_URL, else none.
Object.assign(process.env, testDatabaseEnv(process.env));
const requireDb = String(process.env.AQUA_GATE_REQUIRE_DB ?? '') === '1';
const notRun = [];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = path.join(HERE, 'suites');
const BASELINES = path.join(HERE, 'baselines');
const args = process.argv.slice(2);
const update = args.includes('--update');
const named = args.filter(a => !a.startsWith('--'));

// `--update` must name the suite it is rewriting. The first version rewrote
// EVERY baseline from one command, which is how three of them were replaced —
// including the harness self-test's, which then blocked the gate permanently.
if (update && named.length === 0) {
  console.error('eval:gate --update requires a suite id, e.g.  npm run eval:gate -- extraction-core --update');
  console.error('Rewriting every baseline at once is how a baseline gets replaced by accident.');
  process.exit(1);
}

let failed = false;
let compared = 0;
const regressedSuites = [];

for (const file of readdirSync(SUITES).filter(f => f.endsWith('.suite.mjs')).sort()) {
  const suite = (await import(pathToFileURL(path.join(SUITES, file)).href)).default;
  // Not every `.suite.mjs` file is a gate-compatible suite — some (e.g.
  // reflection-lifecycle-integration.suite.mjs) are dependency-free
  // integration checks meant to be run directly (`node eval/suites/<file>`),
  // documented that way, and share the directory/extension for organization
  // only. Reported and skipped, never a crash that takes the rest of the
  // gate run down with it (L13: a gate that fails without saying why is
  // indistinguishable from a lane that never ran).
  if (!suite || typeof suite.id !== 'string') {
    console.log(`\n── gate: ${file} ──\n   not a gate-compatible suite module (no default export with an id) — skipped, not gated. Run it directly if it's meant to be a standalone check.`);
    continue;
  }
  const baselinePath = path.join(BASELINES, `${suite.id}.v1.json`);

  if (NOT_GATED.has(suite.id)) {
    console.log(`\n── gate: ${suite.id} ──\n   not gated — it grades the harness and is deliberately incomplete`);
    continue;
  }
  if (named.length && !named.includes(suite.id)) continue;

  // A suite that needs infrastructure (today: Postgres) says so. Missing it is
  // reported as NOT RUN — never folded into "passed" — and fails the gate when
  // AQUA_GATE_REQUIRE_DB=1 (CI provides the database, so there it must run).
  // Checked before the baseline, so missing infrastructure is always visible.
  if (Array.isArray(suite.requires) && typeof suite.available === 'function') {
    const avail = await suite.available();
    if (!avail.ok) {
      console.log(`\n── gate: ${suite.id} ──\n   NOT RUN — requires ${suite.requires.join(', ')}: ${avail.reason}`);
      notRun.push(suite.id);
      if (requireDb) failed = true;
      continue;
    }
  }

  if (!existsSync(baselinePath) && !update) {
    console.log(`\n── gate: ${suite.id} ──\n   no baseline — skipped (not a failure)`);
    continue;
  }

  const report = await runSuite(suite);

  if (update) {
    // Regenerating a baseline is a DELIBERATE act that belongs in a PR saying
    // why the numbers moved. It is not something the gate does on its own when
    // a comparison fails, which would make the gate a rubber stamp.
    writeFileSync(baselinePath, `${JSON.stringify({
      schemaVersion: report.schemaVersion,
      recordedAt: report.manifest.ranAt,
      node: report.manifest.node,
      suiteFingerprint: report.manifest.suiteFingerprint,
      caseCount: report.manifest.caseCount,
      // The note explains what the baseline IS and what has to beat it. It is
      // hand-written and PRESERVED across regeneration: the first version
      // overwrote it with a generic string, which silently destroyed the one
      // piece of a baseline file that a human wrote on purpose.
      note: existsSync(baselinePath)
        ? JSON.parse(readFileSync(baselinePath, 'utf8')).note
        : `Baseline for ${suite.id}.`,
      coverage: report.result.coverage,
      metrics: report.result.metrics,
    }, null, 2)}\n`);
    console.log(`\n── gate: ${suite.id} ──\n   baseline UPDATED — justify the movement in the PR description`);
    compared++;
    continue;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const result = compareToBaseline(baseline, report);
  console.log(`\n${gateReport(suite.id, result)}`);
  if (!result.ok) { failed = true; regressedSuites.push(suite.id); }
  compared++;
}

if (compared === 0) {
  console.error(notRun.length
    ? `\neval:gate — nothing was checked: ${notRun.join(', ')} NOT RUN (missing infrastructure).`
    : '\neval:gate — no suites had baselines. Nothing was checked.');
  process.exit(1);
}

// E12: the outcome as a scrapeable record (src/core/evalGateSummary.js →
// /metrics aqua_eval_gate_*). Only a full, non-update run is recorded; a write
// failure never changes the gate's verdict or exit code.
if (!update && !named.length) {
  try {
    const out = path.join(HERE, 'out');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'gate-summary.json'), `${JSON.stringify({
      ranAt: new Date().toISOString(), passed: !failed, compared, regressions: regressedSuites, notRun,
    }, null, 2)}\n`);
  } catch { /* the record is best-effort */ }
}

if (notRun.length) {
  console.log(`\n⚠ NOT RUN (missing infrastructure): ${notRun.join(', ')}${requireDb ? ' — AQUA_GATE_REQUIRE_DB=1, so this blocks' : ''}`);
}
console.log(failed
  ? (regressedSuites.length
      ? '\n✗ eval:gate BLOCKED — a metric moved the wrong way. Fix it, or update the baseline in a PR that explains why.\n'
      : '\n✗ eval:gate BLOCKED — a required suite could not run.\n')
  : `\n✓ eval:gate passed${notRun.length ? ` (${notRun.length} suite(s) NOT RUN — see above)` : ''}\n`);
process.exit(failed ? 1 : 0);
