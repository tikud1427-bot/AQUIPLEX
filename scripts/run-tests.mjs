#!/usr/bin/env node
/**
 * AQUA test runner.
 *
 * WHY THIS EXISTS
 * ---------------
 * The npm test scripts passed glob patterns straight to `node --test`:
 *
 *     node --test "src/**\/tests/*.test.js"
 *
 * Node only learned to expand those itself in v21. On anything older it treats
 * the pattern as a literal filename and prints
 *
 *     Could not find '/…/aqua/src/**\/tests/*.test.js'
 *
 * …then exits 0 having run NOTHING. Not a crash, not a red suite — a silent
 * zero. Every "1500 tests pass" claim was true on a Node 22 container and
 * completely unverified on the machine that actually ships the code. That is
 * the same failure the dark-test work was meant to end: tests that exist,
 * report nothing, and are believed anyway.
 *
 * Quoting is what breaks it. Unquoted, the SHELL expands `src/mind/tests/*.js`
 * on any system — but `**` needs globstar, which `sh` does not have, so the
 * one script that matters most cannot be fixed that way.
 *
 * So: no globs anywhere. This walks the tree, collects the files, and hands
 * `node --test` an explicit list. Explicit paths have worked since Node 18.
 *
 * It also cannot rot. Adding a directory or a suite requires no edit here and
 * no edit to package.json — discovery is the mechanism, which is what the
 * directory globs were reaching for and could not safely deliver.
 *
 * Usage:
 *   node scripts/run-tests.mjs              # everything under src/
 *   node scripts/run-tests.mjs src/mind     # one area
 *   node scripts/run-tests.mjs --list       # print what would run, run nothing
 */
import { readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);
const IS_TEST = /\.test\.m?js$/;

function collect(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (IS_TEST.test(e.name)) out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
const list = args.includes('--list');
const targets = args.filter(a => !a.startsWith('--'));
// E2/PR-1: `eval/` joins `src/` as a default root. The eval harness has real
// behavioural tests, and a test the battery never discovers is worse than no
// test — it reads as coverage while proving nothing. Filtered by existence so
// reverting E2 cannot break `npm test`.
const DEFAULT_ROOTS = ['src', 'eval'].filter(d => existsSync(path.resolve(ROOT, d)));
const roots = (targets.length ? targets : DEFAULT_ROOTS).map(t => path.resolve(ROOT, t));

for (const r of roots) {
  if (!existsSync(r)) {
    console.error(`run-tests: no such path: ${path.relative(ROOT, r)}`);
    process.exit(1);
  }
}

const files = [...new Set(
  roots.flatMap(r => (statSync(r).isDirectory() ? collect(r) : IS_TEST.test(r) ? [r] : [])),
)].sort();

if (!files.length) {
  // A zero-file run is the exact failure this script exists to prevent, so it
  // is an ERROR, never a quiet success.
  console.error(`run-tests: found no *.test.js under ${roots.map(r => path.relative(ROOT, r)).join(', ')}`);
  process.exit(1);
}

if (list) {
  for (const f of files) console.log(path.relative(ROOT, f));
  console.log(`\n${files.length} test file(s)`);
  process.exit(0);
}

// ── Isolation ────────────────────────────────────────────────────────────────
//
// The suite writes to whatever AQUA_DATA_DIR resolves to. Unset, that is
// `os.homedir()/.aquiplex` — a developer's REAL store. A full run then loads
// their live conversations, projects, minds and attachments, creates test
// owners and workspaces alongside them, and deletes some. Harmless while the
// glob bug meant zero tests ran; live the moment the suite actually executes.
//
// About half the suites try to isolate themselves by assigning AQUA_DATA_DIR in
// the file body. That does not work, and the reason is worth stating so nobody
// "fixes" it that way again: ESM evaluates every static import BEFORE any body
// code, and `dataDir.js` resolves DATA_DIR at module load. By the time the
// assignment runs, the path is already decided. Only a suite that sets the
// variable and then uses dynamic `await import()` actually isolates.
//
// So it is set HERE, before Node starts, where hoisting cannot reach it. One
// place, every file, no per-suite discipline required.
//
// An explicit AQUA_DATA_DIR from the caller is respected — someone
// deliberately pointing a run at a fixture directory means it.
const explicitDir = process.env.AQUA_DATA_DIR;
const sandbox = explicitDir ?? mkdtempSync(path.join(os.tmpdir(), 'aqua-test-'));

const res = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: ROOT,
  env: {
    ...process.env,
    AQUA_DATA_DIR: sandbox,
    // The mirror would otherwise try to reach a real cluster from a test run.
    AQUA_DISABLE_MONGO_MIRROR: process.env.AQUA_DISABLE_MONGO_MIRROR ?? '1',
  },
});

if (!explicitDir) {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.exit(res.status ?? 1);
