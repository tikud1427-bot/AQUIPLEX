/**
 * AQUA — Test Coverage Guard
 *
 * WHY THIS EXISTS
 * ---------------
 * A test file that no npm script runs is indistinguishable from a test file
 * that does not exist. AQUA has hit this three times now:
 *
 *   • `src/embeddings/tests/*` — three suites, wired into nothing, found only
 *     during the embedding-model fix.
 *   • `src/routes/tests/consolidationCadence.test.js` — 12 tests written and
 *     verified in the consolidation sprint, then never executed again because
 *     `test:brain` lists route files by name and that name was not added.
 *   • The Jul-31 audit measured the full extent: 38 of 121 suites unreachable,
 *     including `classifier.test.js`, `mongoMirror.test.js`,
 *     `learningLedger.test.js`, `authScoping.test.js` and `uploadAuth.test.js`
 *     — i.e. exactly the modules that were failing in production.
 *
 * This is the same failure mode as a feature flag nobody reports: the code
 * exists, the intent exists, and nothing runs. `brainRoutes.test.js` already
 * solves the flag half by PINNING the flag key list so a new flag cannot be
 * added silently. This file is that mechanism for suites.
 *
 * A FOURTH INSTANCE, AND WHY THIS FILE CHANGED
 * --------------------------------------------
 * The directory globs this guard used to recommend fixed reachability on a
 * Node 22 container and broke it completely everywhere else. `node --test`
 * only learned to expand glob patterns in v21; older versions treat the
 * pattern as a literal filename, print
 *
 *     Could not find '/…/aqua/src/**\/tests/*.test.js'
 *
 * and exit 0 having run NOTHING. Silent zero — the same class of failure as an
 * unreported feature flag, and invisible to a guard that only checked whether
 * a glob STRING appeared in package.json. The text matched; the tests never ran.
 *
 * So the mechanism changed to `scripts/run-tests.mjs`, which discovers files
 * and passes explicit paths (supported since Node 18), and this guard now
 * checks the MECHANISM rather than the text.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. The runner actually discovers every `*.test.js` under `src/` — compared
 *      against an independent walk, so agreement is evidence, not assumption.
 *   2. No test script passes a glob to `node --test`. That is the silent-zero
 *      trap, and it must never come back.
 *   3. The runner exits NON-ZERO when it finds nothing, so a future breakage
 *      is a red build rather than a quiet success.
 *   4. Every explicitly named test path still exists.
 *
 * Deliberately NOT asserted: that every suite passes, or that scripts do not
 * overlap. Overlap is cheap; a suite running twice is strictly safer than a
 * suite running never.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// src/core/tests/ → repo root
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC  = path.join(ROOT, 'src');
// E2/PR-1: `eval/` became a second default discovery root. This guard exists to
// catch a widened or narrowed root — so it is TAUGHT the new one rather than
// relaxed. Filtered by existence so the guard still works on a tree without it.
const EVAL = path.join(ROOT, 'eval');
const DISCOVERY_ROOTS = [SRC, EVAL].filter(d => fs.existsSync(d));

/** Every test file under src/, as repo-relative POSIX paths. */
function findTestFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTestFiles(full, out);
    else if (entry.name.endsWith('.test.js')) {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function scriptText() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return Object.values(pkg.scripts ?? {}).join('\n');
}

/** Test paths a script names literally (not via a glob). */
function explicitPaths(text) {
  return [...new Set(text.match(/src\/[\w./-]+\.test\.js/g) ?? [])];
}

const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');

/** What the runner says it would execute. */
function runnerDiscovers(...args) {
  const res = spawnSync(process.execPath, [RUNNER, '--list', ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: res.status,
    files: (res.stdout ?? '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.endsWith('.test.js')),
  };
}

/** Only the scripts that run tests — not lint, start, bench, soak. */
function testScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return Object.entries(pkg.scripts ?? {}).filter(([k]) => k === 'test' || k.startsWith('test:'));
}

describe('the test battery reaches every suite', () => {
  test('the runner discovers every test file under every default root', () => {
    const walked = DISCOVERY_ROOTS.flatMap(r => findTestFiles(r)).sort();
    assert.ok(walked.length > 100, `expected the full suite set, found ${walked.length}`);
    assert.ok(DISCOVERY_ROOTS.length >= 2, 'eval/ is not a discovery root — its tests would never run');

    const { files } = runnerDiscovers();
    const missed = walked.filter(f => !files.includes(f));
    const extra  = files.filter(f => !walked.includes(f));

    assert.deepEqual(missed, [], missed.length
      ? `${missed.length} test file(s) exist but the runner would not execute them:\n  ${missed.join('\n  ')}`
      : '');
    assert.deepEqual(extra, [], 'the runner listed files that are not test files');
  });

  test('no test script passes a glob to node --test — the silent-zero trap', () => {
    // `node --test "src/**/tests/*.test.js"` runs zero tests and exits 0 on any
    // Node below v21. Quoting is what breaks it, and unquoting cannot save the
    // `**` form because `sh` has no globstar. Route through the runner instead.
    const offenders = testScripts()
      .filter(([, cmd]) => /--test\b/.test(cmd) && /[*?]/.test(cmd))
      .map(([name, cmd]) => `${name}: ${cmd}`);

    assert.deepEqual(offenders, [], offenders.length
      ? 'these scripts hand a glob straight to node --test, which silently runs '
        + `NOTHING on Node < 21. Use "node scripts/run-tests.mjs <dir>":\n  ${offenders.join('\n  ')}`
      : '');
  });

  test('every test script either uses the runner or names files that exist', () => {
    // `test:edit` invokes two node:test files directly with `node`, which runs
    // them. That is NOT the silent-zero hazard: a named path either exists or
    // the command fails loudly, and assertion 5 checks existence. Only a glob
    // can match nothing and still exit 0, which is why that one is absolute.
    const strays = testScripts()
      .filter(([, cmd]) => !cmd.includes('run-tests.mjs')
                        && !cmd.includes('npm run')
                        && !/src\/[\w./-]+\.test\.js/.test(cmd))
      .map(([name, cmd]) => `${name}: ${cmd}`);

    assert.deepEqual(strays, [], strays.length
      ? `these test scripts neither use the runner nor name a real test file:\n  ${strays.join('\n  ')}` : '');
  });

  test('finding nothing is an ERROR, never a quiet success', () => {
    // The whole point. If discovery ever breaks, the build must go red.
    const res = spawnSync(process.execPath, [RUNNER, '--list', 'src/definitely-not-here'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(res.status, 0, 'a zero-file run must exit non-zero');
  });

  test('the suite never writes to a real data directory', () => {
    // The suite writes to whatever AQUA_DATA_DIR resolves to. Unset, that is
    // os.homedir()/.aquiplex — a developer's LIVE store. A full run then loads
    // their real conversations, projects and minds, creates test owners
    // alongside them, and deletes some workspaces. Harmless while the glob bug
    // meant zero tests ran; live the moment the suite actually executes.
    //
    // The runner sets the variable before Node starts. This asserts it took.
    const dir = process.env.AQUA_DATA_DIR ?? '';
    assert.notEqual(dir, '', 'the runner must hand every suite an isolated AQUA_DATA_DIR');

    const home = os.homedir?.() ?? '';
    assert.ok(
      !home || !path.resolve(dir).startsWith(path.resolve(home, '.aquiplex')),
      `tests are pointed at a real store: ${dir}. Run them through scripts/run-tests.mjs.`,
    );
  });

  test('in-file AQUA_DATA_DIR assignment is NOT how isolation works', () => {
    // Recording the trap, because half the suites already fell into it and the
    // obvious "fix" is to add more of the same. ESM evaluates every static
    // import BEFORE any body code, and dataDir.js resolves DATA_DIR at module
    // load — so `process.env.AQUA_DATA_DIR = ...` in a test body runs too late.
    // Only setting it before the process starts, or setting it then using
    // dynamic `await import()`, actually isolates.
    const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.mjs'), 'utf8');
    assert.match(runner, /AQUA_DATA_DIR:/,
      'the runner is the only place isolation can be enforced for every suite');
  });

  test('every explicitly named test path still exists', () => {
    const missing = explicitPaths(scriptText())
      .filter((rel) => !fs.existsSync(path.join(ROOT, rel)));

    assert.deepEqual(
      missing, [],
      'package.json names test file(s) that do not exist (renamed or deleted). '
        + `npm reports nothing for these:\n  ${missing.join('\n  ')}`,
    );
  });
});
