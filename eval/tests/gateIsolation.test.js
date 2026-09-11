/**
 * The eval gate must not run against a real store.
 *
 * 🔴 HOW THIS WAS FOUND — FROM A CONSOLE PASTE, NOT A TEST
 * --------------------------------------------------------
 * A plain `npm run eval:gate -- extraction-core --update` on a developer
 * machine printed:
 *
 *   [EVIDENCE]  Loaded 409 fact(s), 405 evidence object(s) across 18 owner(s)
 *               from C:\\Users\\<user>\\.aquiplex\\.aqua-evidence.json
 *   [REASONING] Graph loaded: 1521 node(s), 7729 edge(s) across 19 owner(s)
 *
 * That is a person's live conversations, minds and projects, loaded by an eval
 * run. `capture-core` drives the real turn path with `drainJobs`; several
 * suites call `purgeOwner`. A baseline regenerated in that state is measured
 * against a store nobody controls and that differs between machines.
 *
 * THE GUARD ALREADY EXISTED AND DID NOT REACH HERE.
 * `scripts/run-tests.mjs` sandboxes AQUA_DATA_DIR before spawning, and
 * `testCoverage.test.js` asserts that it took. Both were written for exactly
 * this hazard. Neither covered the gate, which runs as `node eval/gate.mjs`
 * and never spawns through the runner — so the one command a developer is told
 * to run before committing was the one command with no protection.
 *
 * Half the adapters assign AQUA_DATA_DIR in their own module bodies. That
 * isolates only when the adapter happens to be the first thing to touch
 * `dataDir.js`, which is an ordering accident. ESM evaluates every static
 * import before any body code, so a suite with a static engine import has
 * already lost.
 *
 * WHAT THE FIX DID NOT CHANGE: all 138 metrics across all nine gated suites
 * are identical with isolation forced. The committed baselines were never
 * contaminated — the exposure was to the developer's store, not to the numbers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = readFileSync(path.join(HERE, '../gate.mjs'), 'utf8');
const RUNNER = readFileSync(path.join(HERE, '../../scripts/run-tests.mjs'), 'utf8');

describe('eval gate — isolation', () => {
  test('the gate sets AQUA_DATA_DIR when the caller has not', () => {
    assert.match(GATE, /process\.env\.AQUA_DATA_DIR\s*=\s*mkdtempSync/,
      'eval/gate.mjs must sandbox AQUA_DATA_DIR — it does not spawn through run-tests.mjs');
  });

  test('it does so BEFORE any suite is imported', () => {
    // The whole point. `dataDir.js` resolves DATA_DIR at module load, so an
    // assignment that runs after a suite import is decoration. Suites are
    // loaded dynamically further down the file; the assignment must precede
    // that, and it must not sit behind a function call that runs later.
    const assign = GATE.indexOf('process.env.AQUA_DATA_DIR = mkdtempSync');
    const load = GATE.search(/await import\(|pathToFileURL\([^)]*SUITES/);
    assert.ok(assign > 0, 'no sandbox assignment found');
    assert.ok(load === -1 || assign < load,
      'AQUA_DATA_DIR is set after suites are loaded — too late, the path is already resolved');
  });

  test('an explicit AQUA_DATA_DIR from the caller is respected', () => {
    // Pointing a run at a fixture directory on purpose has to keep working,
    // and the runner makes the same allowance for the same reason.
    assert.match(GATE, /if \(!process\.env\.AQUA_DATA_DIR\)/,
      'the gate must not clobber a directory the caller chose deliberately');
  });

  test('the mongo mirror is disabled, as it is for tests', () => {
    // Without this an eval run reaches for a real cluster. The runner already
    // sets it; the gate needs the same, for the same reason.
    assert.match(GATE, /AQUA_DISABLE_MONGO_MIRROR/);
    assert.match(RUNNER, /AQUA_DISABLE_MONGO_MIRROR/);
  });

  test('this run is not pointed at a real store', () => {
    // The live check, mirroring testCoverage.test.js. Catches the case where
    // the source looks right but something upstream still resolved home.
    const dir = process.env.AQUA_DATA_DIR ?? '';
    const home = os.homedir?.() ?? '';
    assert.ok(
      !dir || !home || !path.resolve(dir).startsWith(path.resolve(home, '.aquiplex')),
      `pointed at a real store: ${dir}`,
    );
  });

  test('BOTH entry points are covered — that was the actual defect', () => {
    // The hazard was known, written up, fixed once, and tested once. It was
    // missed here because the protection was attached to the runner rather
    // than to the thing being protected. Asserting both together so a third
    // entry point cannot inherit the same gap quietly.
    for (const [name, src] of [['run-tests.mjs', RUNNER], ['gate.mjs', GATE]]) {
      assert.match(src, /AQUA_DATA_DIR/, `${name} does not mention AQUA_DATA_DIR`);
      assert.match(src, /mkdtempSync/, `${name} does not create a sandbox directory`);
    }
  });
});
