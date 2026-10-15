/**
 * The root test command and CI must run the SAME battery.
 *
 * 🔴 THE DEFECT THIS CLOSES
 * -------------------------
 * `test:aqua` enumerated five of aqua's twenty-two test scripts by hand:
 *
 *     cd aqua && npm run test:edit && npm run test:upload
 *             && npm run test:identity && npm run test:search
 *             && npm run test:account
 *
 * Measured against a real run: that is 239 aqua tests. `cd aqua && npm test`
 * is 2886. So `npm test` at the repo root reported a green battery of ~320
 * while leaving 2647 aqua tests unrun — among them EVERY test for the thing
 * this project is about:
 *
 *     eval/tests   the gate, and every committed baseline's findings
 *     src/brain    understanding, context engine, claims, reflection
 *     src/pic      retrieval, the relevance gate, the polarity lane
 *     src/core     the claim substrate
 *     src/memory, src/mind, src/cognition, src/understanding,
 *     src/files, src/routes, src/orchestrator, src/providers,
 *     src/embeddings, src/intelligence, src/artifacts
 *
 * CI was never wrong — `.github/workflows/eval-gate.yml` sets
 * `working-directory: aqua` and runs the full suite plus the gate. The trap was
 * local: a developer changing `src/brain`, running `npm test` at the root, and
 * getting a green result from a command that never loaded the file they edited.
 *
 * A HAND-MAINTAINED LIST OF WHAT TO BE COMPLETE OVER IS NOT COMPLETENESS.
 * The eval gate's own baseline tests settled this argument once already and
 * were rewritten to read the directory instead of naming its contents. The
 * same rule applies to a test command: delegating to `npm test` inside `aqua`
 * means a new suite is covered the moment it exists, with nobody to remember.
 *
 * WHAT THIS COSTS, STATED PLAINLY: the root battery goes from seconds to about
 * two minutes. That is the price of the command meaning what it says, and it
 * is the same wall-clock CI has always paid.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const aquaPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'aqua', 'package.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'eval-gate.yml'), 'utf8');

describe('root test wiring — local and CI run the same thing', () => {
  test('test:aqua DELEGATES to aqua\'s own suite rather than naming scripts', () => {
    const cmd = rootPkg.scripts['test:aqua'];
    assert.match(cmd, /cd aqua && npm (test|run test:all)\b/,
      'test:aqua must delegate, so a new aqua suite is covered without anyone updating this line');
  });

  test('test:aqua names no individual aqua script', () => {
    // The regression shape: someone re-adds `&& npm run test:foo` to skip a
    // slow suite, and the root battery silently narrows again.
    const cmd = rootPkg.scripts['test:aqua'];
    const named = Object.keys(aquaPkg.scripts)
      .filter(s => s.startsWith('test:') && s !== 'test:all')
      .filter(s => cmd.includes(`run ${s}`));
    assert.deepEqual(named, [], `test:aqua enumerates ${named.join(', ')} instead of delegating`);
  });

  test('aqua\'s own `test` still means ALL of it', () => {
    // The delegation above is only worth anything if the target is complete.
    assert.match(aquaPkg.scripts.test, /test:all/);
    assert.match(aquaPkg.scripts['test:all'], /run-tests\.mjs\s*$/,
      'test:all must run the discovering runner with no path filter');
  });

  test('the root battery reaches the engine, not just the platform', () => {
    assert.match(rootPkg.scripts.test, /test:aqua/);
  });

  test('the root battery runs the platform tests too, and CI runs them on every PR', () => {
    // These tests (auth, CSRF, sessions, account deletion, launch safety) sat
    // outside both `npm test` and CI: three of them had gone stale unseen.
    assert.match(rootPkg.scripts.test, /test:platform/);
    assert.match(rootPkg.scripts['test:platform'], /node --test "tests\/\*\*\/\*\.test\.js"/);
    const platformCi = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'platform-tests.yml'), 'utf8');
    assert.match(platformCi, /run:\s*npm run test:platform/);
    assert.doesNotMatch(platformCi, /paths:/, 'a path filter would skip index.js changes');
  });

  test('CI runs the same battery the root command does', () => {
    // CI was never the broken half; this pins that it stays the reference.
    assert.match(workflow, /working-directory:\s*aqua/);
    assert.match(workflow, /run:\s*npm test/);
    assert.match(workflow, /run:\s*npm run eval:gate/);
  });

  test('the eval gate runs SOMEWHERE — it is not covered by npm test', () => {
    // `npm test` inside aqua does not run the gate; the gate is a separate
    // command comparing against committed baselines. If CI ever stopped
    // invoking it, every baseline in the repo would become decorative.
    assert.match(workflow, /npm run eval:gate/);
    assert.ok(aquaPkg.scripts['eval:gate'], 'aqua must expose eval:gate for CI to call');
  });
});
