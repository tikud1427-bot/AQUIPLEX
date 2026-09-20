/**
 * Repository hygiene — E1/PR-7
 *
 * A deletion PR is the only kind that undoes itself. A merge, a stale branch,
 * a copied backup folder — and the drifted duplicate is back, silently, with
 * no test failing. So the deletion ships with a guard.
 *
 * WHAT THIS PINS, AND WHY EACH ONE
 * --------------------------------
 * The root `src/` tree was the dangerous one: a COPY of the aqua provider
 * layer whose `router.js` had DRIFTED (484 vs 490 lines) from the live file.
 * Two provider routers in one repo, one of them wrong, neither obviously
 * authoritative — that is the shape of an incident, not clutter.
 *
 * `projectRetriever (1).js` was the same defect in miniature: 468 lines
 * against the live 491.
 *
 * WHAT IS DELIBERATELY NOT POLICED
 * --------------------------------
 * Downloaded PR archives at the repo root. They are cleaned by the script and
 * ignored by git, but a test that failed whenever a tarball was downloaded
 * would fail during every future apply — a guard nobody can keep green gets
 * deleted, and then it guards nothing.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const at = (...p) => path.join(ROOT, ...p);
const exists = (...p) => fs.existsSync(at(...p));

describe('repo hygiene — the duplicate tree stays gone', () => {
  test('the root src/ provider tree is gone', () => {
    // Not merely absent: it must not come back as a directory at all.
    assert.equal(exists('src'), false,
      'root src/ is back — it is a DRIFTED copy of aqua/src/providers, not a second implementation');
  });

  test('the loose duplicate project modules are gone', () => {
    for (const f of [
      'callGraph.js', 'contextCompressor.js',
      'projectRetriever (1).js', 'symbolGraph (1).js',
    ]) {
      assert.equal(exists(f), false, `${f} is back — the live copy lives in aqua/src/project/`);
    }
  });

  test('their orphaned root tests are gone', () => {
    for (const f of [
      'callGraph.test.js', 'contextCompressor.test.js',
      'projectRetriever.callgraph.test.js', 'projectRetriever.digest.test.js',
      'symbolGraph.test.js', 'symbolGraph.events-jobs.test.js',
    ]) {
      assert.equal(exists(f), false, `${f} is back — no npm script runs root-level tests, so it is dead weight`);
    }
  });

  test('no root file was created by a shell redirect accident', () => {
    // `how HEAD~1:package.json` was a `git show` redirect that became a file.
    const odd = fs.readdirSync(ROOT).filter(f => /^how |:/.test(f));
    assert.deepEqual(odd, []);
  });

  test('build residue does not accumulate at the root', () => {
    const residue = fs.readdirSync(ROOT)
      .filter(f => /\.(diff|patch)$/.test(f) || /^\.fuse_hidden/.test(f) || /\.migrated-to-datadir$/.test(f));
    assert.deepEqual(residue, [], 'patches, diffs, FUSE stubs and migration stubs belong in git history, not the tree');
  });

  test('the superseded apply script is gone', () => {
    assert.equal(exists('apply.sh'), false, 'apply.sh is superseded by apply-pr.sh');
  });

  test('the root router.js fossil is gone', () => {
    // index.js only ever does `import("./aqua/router.js")`. This file had zero
    // live importers and was never in the original PR-7 delete list.
    assert.equal(exists('router.js'), false,
      'root router.js is back — index.js mounts aqua/router.js, this copy is dead');
  });

  test('no package.json script points at the removed root src/ tree', () => {
    // The reference-check in PR7-cleanup.sh greps require()/import syntax; an
    // npm script string ("node src/core/db/cli.mjs") is neither, so it was
    // invisible to that gate. db:migrate, db:drift, db:status, test:edit,
    // bench:cognition and soak:providers all drifted back to root src/ this
    // way. This is what keeps that regression from recurring silently.
    const pkg = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));
    const offenders = Object.entries(pkg.scripts)
      .filter(([, v]) => /\bsrc\//.test(v) && !/\baqua\/src\//.test(v) && !/run-tests\.mjs/.test(v))
      .map(([k]) => k);
    assert.deepEqual(offenders, [],
      `these scripts still reference root src/: ${offenders.join(', ')}`);
  });
});

describe('repo hygiene — what must NOT be deleted', () => {
  // Two of these were on the original audit's delete list and were WRONG.
  // Asserting them is how a future cleanup pass cannot repeat the mistake.

  test('evaluation/ survives — it is AQEval, not cruft', () => {
    assert.ok(exists('evaluation'), 'evaluation/ is a deliberate benchmark framework');
    assert.ok(exists('evaluation', 'configs', 'adapters'), 'AQEval provider adapters are missing');
  });

  test('aqua/src/files/evidenceValidator.js survives — a test imports it', () => {
    // Audited as "dead code". It has no production caller, but
    // evidenceQCandRetrieval.test.js imports it. Deleting it breaks a suite.
    assert.ok(exists('aqua', 'src', 'files', 'evidenceValidator.js'));
    const suite = fs.readFileSync(at('aqua', 'src', 'files', 'tests', 'evidenceQCandRetrieval.test.js'), 'utf8');
    assert.match(suite, /evidenceValidator/, 'the importing test changed — re-check before deleting');
  });

  test('blogs.js survives — index.js requires it', () => {
    assert.ok(exists('blogs.js'));
    assert.match(fs.readFileSync(at('index.js'), 'utf8'), /require\("\.\/blogs"\)/);
  });

  test('the aqua engine is untouched by this PR', () => {
    for (const f of [
      ['aqua', 'src', 'upload', 'zipGuard.js'],
      ['aqua', 'src', 'upload', 'boundedParse.js'],
      ['aqua', 'src', 'core', 'untrustedContent.js'],
      ['aqua', 'src', 'providers', 'router.js'],
    ]) {
      assert.ok(exists(...f), `${f.join('/')} went missing — cleanup overreached`);
    }
  });
});

describe('repo hygiene — git ignores what the script removes', () => {
  test('.gitignore covers archives, patches and FUSE stubs', () => {
    const ig = fs.readFileSync(at('.gitignore'), 'utf8');
    for (const pattern of ['*.tar.gz', '*.patch', '*.diff', '.fuse_hidden*', '*.migrated-to-datadir']) {
      assert.ok(ig.includes(pattern), `.gitignore is missing ${pattern}`);
    }
  });
});
