#!/usr/bin/env node
/**
 * ACIB v1 — run the benchmark and write its reproducibility record (2026-11-10).
 *
 *   node scripts/acib-run.mjs                      → eval/acib/results/acib-v1.<timestamp>.json
 *   node scripts/acib-run.mjs --label after-x      → eval/acib/results/acib-v1.after-x.json
 *   node scripts/acib-run.mjs --freeze-baseline    → eval/acib/acib-v1.baseline.json (+ .sha256);
 *                                                    refuses if a baseline already exists
 *
 * The record holds: benchmark version, dataset id/version/sha256 (and whether
 * it matches its freeze), pipeline version (git commit, dirty flag and a
 * sha256 over every non-test source file under aqua/src — the working tree,
 * committed or not), the execution configuration (every gate's resolved value,
 * overrides, infrastructure present), and per scenario × regime: expected
 * evidence, the context items actually retrieved, and every metric.
 *
 * No provider, no database, no external network (blocked and counted).
 * Safe by construction: the data dir is a fresh temp dir, the Mongo mirror and
 * DATABASE_URL are disabled before anything under src/ is imported.
 */
import '../eval/core/isolateDataDir.mjs';
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.DATABASE_URL = '';

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const valueOf = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

function sourceFingerprint() {
  const files = [];
  const walk = d => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'tests' && e !== 'node_modules') walk(p); }
      else if (/\.(m?js|cjs)$/.test(e) && !/\.test\./.test(e)) files.push(p);
    }
  };
  walk(path.join(AQUA, 'src'));
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(path.relative(AQUA, f).replace(/\\/g, '/')).update('\0').update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).update('\0');
  return { files: files.length, sha256: h.digest('hex') };
}

// --suite (Sprint 3): acib-v1 (default) | acib-v1-needs | acib-heldout-v1 | acib-heldout-v1-needs
const SUITE_ID = valueOf('--suite') ?? 'acib-v1';
if (!/^acib-[a-z0-9-]+$/.test(SUITE_ID)) { console.error(`unknown suite ${SUITE_ID}`); process.exit(4); }
const { default: suite, BENCHMARK_VERSION, DATASET } = await import(`../eval/suites/${SUITE_ID}.suite.mjs`);
const { runSuite } = await import('../eval/core/runner.mjs');
const { runConfiguration } = await import('../eval/adapters/acibPipeline.mjs');

const configuration = await runConfiguration();
const started = Date.now();
const out = await runSuite(suite, { caseTimeoutMs: 300_000 });
const record = {
  benchmark: BENCHMARK_VERSION,
  suite: SUITE_ID,
  dataset: DATASET,
  pipeline: { commit: out.manifest.commit, dirty: out.manifest.dirty, source: sourceFingerprint() },
  configuration,
  executedAt: out.manifest.ranAt,
  durationMs: Date.now() - started,
  node: out.manifest.node,
  platform: out.manifest.platform,
  coverage: out.result.coverage,
  metrics: out.result.metrics,
  metricsError: out.result.metricsError,
  scenarios: out.result.cases.map(c => ({
    case: c.id, status: c.status, correct: c.correct ?? null, reason: c.reason ?? null,
    regime: c.detail?.regime, taskType: c.detail?.taskType, confidence: c.detail?.confidence, readMode: c.detail?.readMode,
    promptTokens: c.detail?.promptTokens, networkBlocked: c.detail?.networkBlocked,
    questionMs: c.detail?.questionMs ?? null, infoNeeds: c.detail?.infoNeeds ?? null, hybridTokens: c.detail?.hybridTokens ?? 0,
    expected: c.detail?.expected, retrieved: c.detail?.retrieved,
    arms: c.detail?.arms, planner: c.detail?.planner, plannerSlots: c.detail?.plannerSlots,
  })),
};

const json = JSON.stringify(record, null, 2) + '\n';
if (flag('--freeze-baseline')) {
  const dir = path.join(AQUA, 'eval', 'acib');
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${SUITE_ID}.baseline.json`);
  if (existsSync(target)) {
    console.error(`refusing: ${path.relative(AQUA, target)} exists — a baseline is replaced only as a reviewed change (AQUA_ACIB_V1_IMPLEMENTATION.md §7)`);
    process.exit(2);
  }
  if (!record.coverage.complete || record.metricsError) { console.error('refusing: the run is incomplete — a baseline must cover every case'); process.exit(3); }
  writeFileSync(target, json);
  writeFileSync(`${target}.sha256`, `${crypto.createHash('sha256').update(json).digest('hex')}  ${SUITE_ID}.baseline.json\n`);
  console.log(`baseline frozen: ${path.relative(AQUA, target)}`);
} else {
  const dir = path.join(AQUA, 'eval', 'acib', 'results');
  mkdirSync(dir, { recursive: true });
  const label = valueOf('--label') ?? record.executedAt.replace(/[:.]/g, '-');
  const target = path.join(dir, `${SUITE_ID}.${label}.json`);
  writeFileSync(target, json);
  console.log(`record written: ${path.relative(AQUA, target)}`);
}
console.log(`cases ${record.coverage.executed}/${record.coverage.total} · skipped ${record.coverage.skipped} · errored ${record.coverage.errored} · network attempts ${(record.metrics.short_network_attempts ?? 0) + (record.metrics.long_network_attempts ?? 0)} · ${record.durationMs} ms`);
process.exit(0);
