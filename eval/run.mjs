#!/usr/bin/env node
/**
 * AQUA Eval — CLI
 * Blueprint E2/PR-1
 *
 *   npm run eval                    every suite in eval/suites/
 *   npm run eval -- selftest        one suite by id
 *   npm run eval -- --json out.json write the machine record
 *   npm run eval -- --quiet         exit code only
 *
 * EXIT CODES
 *   0  every suite ran to completion
 *   1  a suite was malformed, or its metrics() threw
 *   2  a suite ran but was INCOMPLETE (skips or errors)
 *
 * The distinct code for "incomplete" is deliberate. A partial run is not a
 * pass and it is not a crash — it is a result nobody should quote. CI treating
 * it as green is how a harness quietly stops measuring half its dataset.
 */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runSuite } from './core/runner.mjs';
import { toJSON, toHuman } from './core/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE_DIR = path.join(HERE, 'suites');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const valueOf = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const wanted = args.filter(a => !a.startsWith('--') && a !== valueOf('--json'));
const quiet = flag('--quiet');
const jsonPath = valueOf('--json');

function discoverSuites() {
  let names;
  try {
    names = readdirSync(SUITE_DIR).filter(f => f.endsWith('.suite.mjs')).sort();
  } catch {
    return [];
  }
  return names.map(f => path.join(SUITE_DIR, f));
}

const files = discoverSuites();
if (files.length === 0) {
  console.error(`eval: no *.suite.mjs found in ${path.relative(process.cwd(), SUITE_DIR)}`);
  process.exit(1);
}

let worstExit = 0;
const reports = [];

for (const file of files) {
  let suite;
  try {
    suite = (await import(pathToFileURL(file).href)).default;
  } catch (err) {
    console.error(`eval: could not load ${path.basename(file)}: ${err.message}`);
    worstExit = 1;
    continue;
  }

  if (wanted.length && !wanted.includes(suite?.id)) continue;

  let report;
  try {
    report = await runSuite(suite);
  } catch (err) {
    // A malformed suite fails loudly and early rather than reporting 0% —
    // a typo must never be readable as a catastrophic quality result.
    console.error(`eval: ${path.basename(file)} — ${err.message}`);
    worstExit = 1;
    continue;
  }

  reports.push(report);
  if (!quiet) {
    console.log('');
    console.log(toHuman(report));
  }
  if (report.result.metricsError) worstExit = Math.max(worstExit, 1);
  else if (!report.result.coverage.complete) worstExit = Math.max(worstExit, 2);
}

if (wanted.length && reports.length === 0) {
  console.error(`eval: no suite matched ${wanted.join(', ')}`);
  process.exit(1);
}

if (jsonPath) {
  const out = path.resolve(process.cwd(), jsonPath);
  mkdirSync(path.dirname(out), { recursive: true });
  const body = reports.length === 1 ? reports[0] : { schemaVersion: 1, reports };
  writeFileSync(out, toJSON(body));
  if (!quiet) console.log(`\n   → ${path.relative(process.cwd(), out)}`);
}

if (!quiet) console.log('');
process.exit(worstExit);
