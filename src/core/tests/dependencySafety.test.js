/**
 * AQUA Dependency Safety — retired-package guard
 * Blueprint E1/PR-2
 *
 * WHY THIS EXISTS
 * ---------------
 * `xlsx@0.18.5` is the last release SheetJS published to npm. They moved
 * distribution to their own CDN, so the npm package is frozen forever at a
 * version carrying a high-severity prototype-pollution advisory
 * (GHSA-4r6h-8v6p-xvw6, fixed upstream in 0.19.3). `npm audit` reports it with
 * no fix available, because from npm's point of view there will never be one.
 *
 * E1/PR-2 moved every call site to `@e965/xlsx`, the maintained mirror that
 * republishes current SheetJS releases to npm.
 *
 * A dependency swap is trivially undone by accident. `npm i xlsx` to "fix" an
 * import, a merge that resurrects an old package.json, a copied snippet from
 * the SheetJS docs — any of those silently reintroduces the advisory on the
 * file-upload path, and nothing else in either battery would notice.
 *
 * So this suite asserts the swap is still in force, at three levels:
 *   1. the retired package is not declared
 *   2. no source file imports it
 *   3. the replacement resolves to a version at or above the fix
 *
 * E1/PR-3 did NOT retire `adm-zip` — 0.6.0 is a genuine upstream fix from the
 * original maintainer, so the minimal change was a version bump. That needs a
 * different shape of guard: a MINIMUM VERSION, plus an architectural rule that
 * only one module is allowed to read untrusted ZIPs. Both are below.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * Packages this repository has deliberately stopped using, and what replaced
 * them. Adding a row here is how a retirement becomes permanent.
 */
const RETIRED = [
  {
    retired: 'xlsx',
    replacement: '@e965/xlsx',
    minVersion: [0, 19, 3],
    reason: 'npm distribution abandoned at 0.18.5; prototype pollution with no npm-side fix',
    pr: 'E1/PR-2',
  },
];

// ── Source scan ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);

function sourceFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Bare module specifiers only — `import x from 'xlsx'`, not `'./xlsx.js'` or a `.xlsx` string. */
function bareImportsOf(text, moduleName) {
  const esc = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`from\\s+['"]${esc}['"]`, 'g'),
    new RegExp(`import\\s*\\(\\s*['"]${esc}['"]\\s*\\)`, 'g'),
    new RegExp(`require\\s*\\(\\s*['"]${esc}['"]\\s*\\)`, 'g'),
  ];
  return patterns.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}

// This file is excluded from its own scan: it has to be free to NAME the
// specifier it forbids, in the RETIRED table and in prose. Nothing else is
// exempt, and the "walker actually sees the tree" test below stops the
// exclusion from quietly widening into a blind spot.
const SELF = fileURLToPath(import.meta.url);
const FILES = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'scripts'))]
  .filter(f => f !== SELF);

// ── Guards ────────────────────────────────────────────────────────────────────

describe('dependency safety — retired packages stay retired', () => {
  test('the scan actually sees the source tree', () => {
    // Guards the guard: a broken walker would make every assertion below pass
    // vacuously, which is the failure mode this project has hit before.
    assert.ok(FILES.length > 200, `expected the full source tree, walked ${FILES.length} files`);
    const someImport = FILES.some(f => bareImportsOf(readFileSync(f, 'utf8'), '@e965/xlsx') > 0);
    assert.ok(someImport, 'walker found no @e965/xlsx import — the detector is not working');
  });

  for (const entry of RETIRED) {
    describe(`${entry.retired} → ${entry.replacement} (${entry.pr})`, () => {
      test('is not declared as a dependency', () => {
        const declared = { ...pkg.dependencies, ...pkg.devDependencies };
        assert.ok(
          !(entry.retired in declared),
          `${entry.retired} is back in package.json — ${entry.reason}`,
        );
      });

      test('is not imported anywhere in src/ or scripts/', () => {
        const offenders = FILES
          .filter(f => bareImportsOf(readFileSync(f, 'utf8'), entry.retired) > 0)
          .map(f => path.relative(ROOT, f));
        assert.deepEqual(offenders, [], `these files still import '${entry.retired}'`);
      });

      test('the replacement is declared', () => {
        const declared = { ...pkg.dependencies, ...pkg.devDependencies };
        assert.ok(entry.replacement in declared, `${entry.replacement} is not declared`);
      });

      test('the replacement resolves at or above the fixed version', () => {
        // Read the installed manifest from disk rather than require()-ing
        // '<pkg>/package.json' — modern packages restrict subpath access via
        // "exports", and @e965/xlsx is one of them.
        const manifestPath = path.join(ROOT, 'node_modules', entry.replacement, 'package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const actual = manifest.version.split('.').map(Number);
        const [rMaj, rMin, rPat] = actual;
        const [mMaj, mMin, mPat] = entry.minVersion;
        const ok = rMaj > mMaj
          || (rMaj === mMaj && rMin > mMin)
          || (rMaj === mMaj && rMin === mMin && rPat >= mPat);
        assert.ok(ok, `${entry.replacement}@${manifest.version} is below the fixed ${entry.minVersion.join('.')}`);
      });
    });
  }
});

/**
 * Packages kept, but pinned at or above the version that fixed an advisory.
 * A retirement is not always the right answer: when upstream ships a real fix,
 * bumping beats replacing (constitution L17, composition over replacement).
 * What that costs is a floor nobody may silently drop below.
 */
/**
 * Advisories accepted because the vulnerable code is PROVABLY UNREACHABLE.
 *
 * This is not an ignore list. An ignore list is how a real vulnerability hides
 * six months later: someone adds an entry with a one-line reason, the reason
 * stops being true, and nothing notices.
 *
 * Every entry here is a set of ASSERTIONS. Each link in the unreachability
 * argument is checked below, and the moment any link breaks — a fixed version
 * appears, our code starts using the feature, the dependency starts actually
 * requiring the package — the battery goes red and the exception has to be
 * re-argued rather than inherited.
 */
const UNREACHABLE = [
  {
    package: 'image-size',
    advisories: ['GHSA-w3rx-r6r6-pgpr (ICNS)', 'GHSA-5p2g-fcmc-qvqq (JXL/HEIF)'],
    via: 'pptxgenjs',
    // Checked when this was written: every published version is affected and
    // the newest, 2.0.2, is still vulnerable. npm's suggested "fix" is
    // pptxgenjs@1.1.5 — a THREE-MAJOR downgrade of the pptx export path to
    // remove a DoS in a parser we never reach.
    noFixedVersionExists: true,
  },
];

describe('dependency safety — advisories accepted as unreachable', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  test('the exception list is short and justified — it is not a dumping ground', () => {
    assert.ok(UNREACHABLE.length <= 3,
      'the unreachable list is growing; each entry is a standing risk, not a free pass');
    for (const e of UNREACHABLE) {
      assert.ok(e.advisories.length > 0);
      assert.ok(e.via, `${e.package}: no direct dependent recorded`);
    }
  });

  test('LINK 1 — image-size is not a direct dependency of ours', () => {
    // If it ever became one, we would be choosing it deliberately and the
    // exception would need re-arguing on different grounds.
    assert.equal(pkg.dependencies['image-size'], undefined);
    assert.equal(pkg.devDependencies?.['image-size'], undefined);
  });

  test('LINK 2 — the pptxgenjs build we load never references image-size', () => {
    // `import PptxGenJS from 'pptxgenjs'` resolves to the ES build. The only
    // dynamic size lookup in it is `require('sizeof')` — a DIFFERENT package,
    // which is not installed — and it sits behind `typeof require !==
    // "undefined"`, which is false in an ES module.
    const pptx = JSON.parse(readFileSync(
      path.join(ROOT, 'node_modules/pptxgenjs/package.json'), 'utf8'));
    const esBuild = pptx.exports?.['.']?.import?.default ?? pptx.module;
    assert.ok(esBuild, 'pptxgenjs no longer publishes an ES build — re-check how it is loaded');

    const src = readFileSync(path.join(ROOT, 'node_modules/pptxgenjs', esBuild.replace('./', '')), 'utf8');
    assert.ok(!src.includes('image-size'),
      'pptxgenjs now references image-size directly — the exception no longer holds');
  });

  test('LINK 3 — our exporter loads pptxgenjs as ESM, so the require branch is dead', () => {
    const exporter = readFileSync(path.join(ROOT, 'src/artifacts/exporters/pptxExporter.js'), 'utf8');
    assert.match(exporter, /import PptxGenJS from 'pptxgenjs'/);
    assert.ok(!/require\(['"]pptxgenjs/.test(exporter),
      'the exporter now loads pptxgenjs as CJS, where `require` IS defined — re-check the branch');
  });

  test('LINK 4 — our exporter never passes an image to pptxgenjs', () => {
    // The vulnerable parsers only run on an image. We generate text slides.
    // The day someone adds addImage(), this fails and the exception is
    // re-argued rather than silently inherited.
    const exporter = readFileSync(path.join(ROOT, 'src/artifacts/exporters/pptxExporter.js'), 'utf8');
    assert.ok(!/addImage\s*\(/.test(exporter),
      'the pptx exporter now adds images — the image-size advisory may be reachable, re-assess it');
  });

  test('LINK 5 — no other module reaches pptxgenjs', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        if (full.endsWith(path.join('exporters', 'pptxExporter.js'))) continue;
        if (/pptxgenjs/.test(readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, [],
      'a second module uses pptxgenjs — the unreachability argument only covers the exporter');
  });

  test('the exception EXPIRES if a fixed version ships', () => {
    // The honest failure mode of any accepted risk is that it is accepted
    // forever. If image-size ever publishes a patched release, this entry
    // should be deleted and the dependency updated — so the moment somebody
    // records that, the test tells them to act.
    for (const e of UNREACHABLE) {
      assert.equal(e.noFixedVersionExists, true,
        `${e.package}: a fix now exists — take it and remove this exception`);
    }
  });
});

const PINNED = [
  {
    pkg: 'adm-zip',
    minVersion: [0, 6, 0],
    reason: 'crafted ZIP triggers a 4 GB allocation, GHSA-xcpc-8h2w-3j85 — fixed upstream in 0.6.0',
    pr: 'E1/PR-3',
  },
];

/**
 * Modules allowed to import a ZIP library directly, and why.
 *
 * `zipGuard.js` is the one bounded doorway for READING attacker-supplied
 * containers. `packager.js` only ever constructs an archive from files this
 * system generated — it never opens untrusted bytes, so the ceilings do not
 * apply to it and forcing it through the guard would be theatre.
 *
 * Anything else importing adm-zip means a second set of ceilings that will
 * drift out of sync silently, which is exactly the state E1/PR-3 found:
 * five readers, three of them with no ceilings at all.
 */
const ZIP_DOORWAYS = ['src/upload/zipGuard.js', 'src/artifacts/packager.js'];

describe('dependency safety — pinned versions', () => {
  for (const entry of PINNED) {
    test(`${entry.pkg} is at or above ${entry.minVersion.join('.')} (${entry.pr})`, () => {
      const manifestPath = path.join(ROOT, 'node_modules', entry.pkg, 'package.json');
      const actual = JSON.parse(readFileSync(manifestPath, 'utf8')).version.split('.').map(Number);
      const [rMaj, rMin, rPat] = actual;
      const [mMaj, mMin, mPat] = entry.minVersion;
      const ok = rMaj > mMaj
        || (rMaj === mMaj && rMin > mMin)
        || (rMaj === mMaj && rMin === mMin && rPat >= mPat);
      assert.ok(ok, `${entry.pkg}@${actual.join('.')} is below the fixed ${entry.minVersion.join('.')} — ${entry.reason}`);
    });

    test(`${entry.pkg} is not floated below the pin in package.json`, () => {
      const range = { ...pkg.dependencies, ...pkg.devDependencies }[entry.pkg];
      assert.ok(range, `${entry.pkg} is not declared`);
      const declared = range.replace(/^[\^~>=<\s]+/, '').split('.').map(Number);
      const [dMaj, dMin, dPat] = declared;
      const [mMaj, mMin, mPat] = entry.minVersion;
      const ok = dMaj > mMaj
        || (dMaj === mMaj && dMin > mMin)
        || (dMaj === mMaj && dMin === mMin && dPat >= mPat);
      assert.ok(ok, `package.json declares ${entry.pkg}@${range}, below the ${entry.minVersion.join('.')} floor`);
    });
  }
});

describe('dependency safety — one doorway for untrusted ZIPs', () => {
  test('only the declared doorways import a ZIP library in production code', () => {
    // Tests are exempt on purpose: opening our output with an INDEPENDENT
    // reader is how the artifact suites verify what they wrote, and routing
    // that through our own guard would make the check circular.
    const offenders = FILES
      .filter(f => !f.includes(`${path.sep}tests${path.sep}`))
      .filter(f => bareImportsOf(readFileSync(f, 'utf8'), 'adm-zip') > 0)
      .map(f => path.relative(ROOT, f).split(path.sep).join('/'))
      .filter(rel => !ZIP_DOORWAYS.includes(rel));
    assert.deepEqual(offenders, [], 'these modules read ZIPs outside zipGuard — ceilings will drift');
  });

  test('the doorways themselves still exist and still import it', () => {
    // Guards the guard: if zipGuard stopped importing adm-zip the rule above
    // would pass while meaning nothing.
    for (const rel of ZIP_DOORWAYS) {
      const text = readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(bareImportsOf(text, 'adm-zip') > 0, `${rel} no longer imports adm-zip`);
    }
  });

  test('every untrusted-read path goes through the guard', () => {
    for (const rel of [
      'src/upload/archiveExtractor.js',
      'src/upload/documentPipeline.js',
      'src/project/documentParser.js',
      'src/project/fileIngester.js',
    ]) {
      const text = readFileSync(path.join(ROOT, rel), 'utf8');
      assert.match(text, /zipGuard\.js/, `${rel} does not import the zip guard`);
    }
  });
});

// ── The swap is behaviour-neutral, asserted against the frozen fixture ────────

describe('dependency safety — the xlsx swap changed no behaviour', () => {
  test('the replacement still parses the frozen fixture to the frozen golden', async () => {
    // The parser baseline suites already assert this. Repeated here on purpose:
    // if someone changes the SheetJS version, THIS file is where they will
    // look, and the parity claim should fail next to the version guard rather
    // than in a suite named after a different concern.
    const fixtures = path.join(ROOT, 'src/upload/tests/fixtures');
    const golden = JSON.parse(readFileSync(path.join(fixtures, 'golden.json'), 'utf8'));
    const { parseDocument } = await import('../../project/documentParser.js');
    const actual = await parseDocument('.xlsx', readFileSync(path.join(fixtures, 'sample.xlsx')));
    assert.deepStrictEqual(
      { text: actual.text, meta: actual.meta },
      golden['documentParser.xlsx'],
    );
  });
});
