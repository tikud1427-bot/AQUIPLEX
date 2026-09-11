# AQUA Dependency Safety

**Blueprint reference:** Epic E1 (Platform Safety)
**Covers:** dependencies retired because they carry unfixable advisories on the
file-upload path. Extended by each PR that retires one.

| Retired | Replacement | Advisory | Landed |
|---|---|---|---|
| `xlsx@0.18.5` | `@e965/xlsx@^0.20.3` | prototype pollution, GHSA-4r6h-8v6p-xvw6 | **E1/PR-2** |
| `adm-zip@^0.5.17` | `adm-zip@^0.6.0` **+ zipGuard** | crafted ZIP → 4 GB allocation, GHSA-xcpc-8h2w-3j85 | **E1/PR-3** |

---

## E1/PR-2 — `xlsx` → `@e965/xlsx`

### Why the advisory has no fix

`xlsx@0.18.5` is the last release SheetJS published to npm. Distribution moved
to the vendor's own CDN, which is not a registry `npm install` can reach in
this project's network policy. From npm's point of view the package is frozen
forever at a version carrying a high-severity prototype-pollution advisory
fixed upstream in 0.19.3. `npm audit` reports it as *no fix available*, and
that will not change.

`@e965/xlsx` is the community mirror that republishes current SheetJS releases
to npm. Same codebase, same API, reachable by the registry.

### What changed

Four call sites, import specifier only. No logic was touched.

```
src/project/documentParser.js            READ  — parseXlsx()      import + header comment
src/artifacts/exporters/xlsxExporter.js  WRITE — export()         import + header comment
src/project/tests/documentParser.test.js       fixture builder    import
src/artifacts/tests/binaryExporters.test.js    independent reader import
```

> **Correction to the architecture audit.** The audit recorded `xlsx` as
> reached only from `documentParser.js`. It is also on the artifact **write**
> path via `xlsxExporter.js`. Four call sites, not one. The audit under-counted
> and this document is the correction.

### Parity evidence

This is the PR that E1/PR-1 was built to make provable. Three independent
checks, all clean:

**1. Frozen fixture → frozen golden.** `sample.xlsx` carries nine
parity-sensitive cases — comma-in-value CSV quoting, leading-zero string,
decimal, unicode, XML entity, gap column, skipped row, empty sheet, multi-sheet
ordering. Output is **byte-identical**. `golden.json` did not move by one
character, which is the whole contract.

**2. A/B across 14 cases the fixture does not cover.** Both libraries were
installed side by side and run over the same hand-built workbooks:

```
date cell (numFmt serial) · formula cell + cached value · boolean cell
error cell · inline string · embedded newline · embedded double quote
leading/trailing spaces · big number & precision · negative number
sparse far cell (Z100) · unicode + emoji + RTL · semicolon & tab in value
empty shared string

→ 14 identical, 0 differ
```

**3. Cross-version write/read.** The write path matters as much as the read
path, because exported workbooks leave the system:

```
0.20.3-written file reads identically in 0.18.5 : true
0.18.5-written file reads identically in 0.20.3 : true
both writers produce the same logical workbook  : true
```

Combined: **23 parity cases, zero divergence.**

Neither the A/B nor the cross-version probe is committed — both require the
retired package installed, so a committed version would be dead code the moment
the PR lands. They are recorded here as migration evidence.

### The guard

`src/core/tests/dependencySafety.test.js` asserts the swap stays in force. A
dependency swap is trivially undone by accident — `npm i xlsx` to satisfy an
import, a merge resurrecting an old `package.json`, a snippet copied from the
vendor docs — and nothing else in either battery would notice the advisory
coming back onto the upload path.

Three levels, driven by a `RETIRED` table that E1/PR-3 extends with `adm-zip`:

1. the retired package is not declared in `package.json`
2. no file under `src/` or `scripts/` imports it
3. the replacement resolves at or above the fixed version

Plus a fourth test that re-asserts fixture parity *next to the version guard*,
so a future version bump fails where someone would actually be looking.

The suite also guards itself: a "the walker actually sees the source tree" test
stops a broken scanner from making every other assertion pass vacuously. The
guard file is the only file exempt from its own scan — it has to be free to
name the specifier it forbids.

**Bite, measured:**

| Mutation | Failures |
|---|---|
| reintroduce `xlsx` as a dependency | 1 |
| …and point `documentParser` back at it | 2 |
| raise the required version above what is installed | 1 |
| *(reverted)* | **0 — 6/6 pass** |

### Two defects in the guard, caught on first run

1. **My own doc comment matched my own detector.** The header explains "bare
   specifiers only — `import x from 'xlsx'`" and the scanner flagged that line.
   Correct detection, wrong scope. The file is now excluded from its own scan,
   with the vacuity guard covering the exemption.
2. **`require('@e965/xlsx/package.json')` throws.** The package restricts
   subpath access via `exports`. The version check now reads the installed
   manifest from disk.

### Results

```
npm test        1759 / 85 suites / 0 fail     (from 1753 / 82)
flagproof       30/30
fixtures        10 verified
golden.json     byte-identical
router          boots, flags unchanged
npm audit       2 high → 1 high   (adm-zip only — E1/PR-3)
```

### Residual debt

- `documentParser.test.js` still *builds* its XLSX fixture with SheetJS rather
  than reading frozen bytes. Reduced but not eliminated: both build and parse
  now use the same maintained library. The frozen suite from PR-1 is the real
  oracle; migrating the older builder is optional cleanup, tracked for PR-3
  where `adm-zip` forces the same decision for DOCX and PPTX.
- `@e965/xlsx` is a community mirror, not a vendor release. It is the correct
  trade against an unfixable advisory, but it is a third party in the supply
  chain and should be pinned and reviewed on bump, not floated.

### Applying

This PR changes `package.json` and `package-lock.json`, so it needs an install:

```bash
npm ci          # or: npm install
npm test
npm audit
```

---

## E1/PR-3 — `adm-zip` bumped, and every ZIP read put behind one doorway

### Why a bump, not a replacement

`adm-zip@0.6.0` was published by the original maintainer, has zero
dependencies, is MIT, and is the genuine upstream fix for
GHSA-xcpc-8h2w-3j85. Constitution L17 — composition over replacement — says
bump. A hand-rolled ZIP reader would have moved a security-critical parser
from a maintained project into ours for no measured benefit.

The API surface this repository uses (`new AdmZip(buffer)`, `getEntries()`,
`entryName`, `isDirectory`, `header.flags`, `header.size`,
`header.compressedSize`, `getData()`, `getEntry()`, and the write path's
`addFile`/`toBuffer`) is unchanged across the major bump. npm flags 0.6.0 as
breaking; for us it is not.

### What the bump does NOT fix — measured, not assumed

Probed directly against 0.6.0 before designing anything:

| Attack | Result on 0.6.0 alone |
|---|---|
| header declares 4 GiB for a 1-byte payload | **fixed** — returns 1 byte, heap unmoved. This is the advisory. |
| 64 MiB payload at 1027:1 | **extracts in full**, unremarked |
| 20,000 entries | **parses fine** |

So the dependency bump closes the allocation bug and closes nothing about
expansion. Both halves were needed, which is why the guard ships with it.

### The exposure the guard closes

Five paths read attacker-supplied ZIP containers. Three had no ceilings at all
— and `.pptx`, `.odt` and `.epub` **are** ZIP files, which made "upload a
document" the softest target in the product:

| Path | entries | per-entry | total | ratio |
|---|:--:|:--:|:--:|:--:|
| `archiveExtractor.extractArchive('zip')` | ✅ | ✅ | ✅ | ❌ |
| `fileIngester.extractZip` | ✅ | ✅ | ✅ | ❌ |
| `documentParser.parsePptx` | ❌ | ❌ | ❌ | ❌ |
| `documentPipeline.parseOdt` | ❌ | ❌ | ❌ | ❌ |
| `documentPipeline.parseEpub` | ❌ | ❌ | ❌ | ❌ |

`documentPipeline` has no input size cap for `.odt`/`.epub` either, so an
arbitrarily large book reached `new AdmZip()` unbounded.

### `src/upload/zipGuard.js`

One bounded doorway, two profiles, four ceilings — all checked against the
central directory **before a single byte is decompressed**, because a ceiling
enforced after inflation is not a ceiling.

```
                    entries   per-entry   total     ratio
archive             10,000    20 MB       300 MB    200×
document             2,000    25 MB       100 MB    200×
```

- **archive** keeps the exact three numbers `archiveExtractor` and
  `fileIngester` already enforced, so those paths change in exactly one way:
  ratio. The numbers are pinned by test so a future edit is deliberate.
- **document** is entirely new. A 100-slide deck with media runs to a few
  hundred parts; 2,000 leaves headroom while making a 20,000-part "document"
  impossible.
- **200×** matches `MAX_GZIP_RATIO`, the ceiling `archiveExtractor` has always
  applied to `.tar.gz`. One idea, one number — a ZIP bomb and a gzip bomb are
  the same attack through a different container. XML compresses ~10–30:1 and
  repetitive spreadsheet data can reach ~100:1, so 200× refuses bombs without
  refusing real documents.

Ratio is measured across the **whole container**, not per entry: one small
highly-compressible file inside an otherwise ordinary archive is normal, and
per-entry ratios would reject it. Total expansion is the number that actually
describes a bomb, and the per-entry ceiling already bounds the single-huge-
entry case.

`readEntry()` additionally counts **actual** bytes against the budget. The
declared-size ceilings read the central directory, so a header that lies
*small* would slip past them; this is the other direction of the same lie.

### The architectural invariant

`adm-zip` is now imported by exactly two modules, and a test enforces it:

- `src/upload/zipGuard.js` — the only reader of untrusted containers
- `src/artifacts/packager.js` — only ever *constructs* an archive from files
  this system generated. It never opens untrusted bytes, so the ceilings do
  not apply and forcing it through the guard would be theatre.

Test files are exempt: opening our own output with an *independent* reader is
how the artifact suites verify what they wrote, and routing that through our
own guard would make the check circular.

Without this rule the ceilings drift silently — which is precisely the state
PR-3 found, with five readers and three sets of missing limits.

### The inversion

PR-1 committed an assertion named **`BASELINE GAP: no compression-ratio
ceiling exists today`**, which passed because `highratio.zip` extracted at
~1000:1 without complaint. PR-3 replaces it with
**`GAP CLOSED IN E1/PR-3: a high-ratio archive is refused`**.

That inversion is the proof the ceiling works. A commit message claiming it
would not have been.

It ships with a companion test that guards against the lazy version of the
fix: the same 1 MiB payload **stored uncompressed** must still extract. If the
fixture were being refused for size or entry count rather than ratio, that
test fails.

### Results

```
npm test        1782 / 92 suites / 0 fail     (from 1759 / 85)
golden.json     byte-identical — ceilings refuse bombs, not documents
npm audit       1 high → 0 vulnerabilities
```

**Bite, measured:**

| Mutation | Failures |
|---|---|
| remove the ratio ceiling | 4 |
| remove the entry-count ceiling | 1 |
| remove the actual-bytes budget | 1 |
| re-import `adm-zip` in `documentParser` | 1 |
| downgrade the `adm-zip` pin to 0.5.17 | 2 |
| *(reverted)* | **0 — 55/55 pass** |

### Two defects in my own tests, caught on first run

1. `assert.throws(fn, /^Presentation expands/)` failed because Node matches a
   RegExp against `String(err)`, which carries the `ZipGuardError:` class
   prefix. The message is now checked directly.
2. The read-budget test carried a dead `zip.profile = {...}` line from an
   abandoned approach — profiles are frozen, so it did nothing. Replaced with a
   test that actually exhausts the budget.

### Residual debt

- The `document` profile's ceilings are reasoned, not measured against a corpus
  of real-world decks and books. They are generous enough that a false positive
  is unlikely, but nobody has run 1,000 real `.pptx` files through them. Worth
  doing before this is load-bearing at scale.
- `documentPipeline` still has no input-size cap for `.odt`/`.epub`. The ratio
  and total ceilings bound the *output*, which is the memory risk; bounding the
  input as well is cheap and belongs with the E1/PR-4 worker change.
- `parsePptx` reads `ppt/slides/slideN.xml` only, so its entry ceiling protects
  the container scan rather than the read. That is correct today and would need
  revisiting if the parser ever walked media parts.

### Applying

Changes `package.json` and `package-lock.json`:

```bash
npm ci
npm test
npm audit
```

---

## The `image-size` advisories — accepted as unreachable, with proof

**Two high advisories** appeared after Epic 1 closed at zero: ICNS and JXL/HEIF
parsers in `image-size` allow denial of service through infinite loops. They
reach us transitively through `pptxgenjs`.

### There is no fixed version

```
range        : *
patched      : <=2.0.2      ← and 2.0.2 IS the latest published
fixAvailable : pptxgenjs@1.1.5   (isSemVerMajor: true)
```

Every published version is affected. npm's suggested fix is a **three-major
downgrade of the pptx export path** to remove a DoS in a parser we never reach.
That trade is not worth making, so the question became: is it reachable at all?

### Five links, each checked

| | claim |
|---|---|
| **1** | `image-size` is not a direct dependency of ours |
| **2** | the pptxgenjs **ES build we load** never references `image-size` — the only dynamic size lookup is `require('sizeof')`, a *different* package that is not installed |
| **3** | our exporter loads pptxgenjs as **ESM**, where `typeof require === 'undefined'`, so that branch is dead regardless |
| **4** | our exporter **never calls `addImage`** — the vulnerable parsers only run on an image |
| **5** | no other module in `src/` reaches pptxgenjs |

The dependency is declared in `pptxgenjs`'s manifest and **never required by
its code**. Unreachable three ways over.

### This is not an ignore list

An ignore list is how a real vulnerability hides six months later: someone adds
an entry with a one-line reason, the reason stops being true, and nothing
notices.

Every link above is an **assertion in `dependencySafety.test.js`**. The battery
goes red the moment any of them breaks:

| mutation | failures |
|---|---|
| the exporter starts adding images | 1 |
| a fixed version becomes available | 1 |
| `image-size` becomes a direct dependency | 1 |
| *(reverted)* | **0 — 18/18** |

There is also an **expiry**: an entry asserts `noFixedVersionExists`, so the day
`image-size` ships a patch, the test says *take it and remove this exception*.
The honest failure mode of any accepted risk is that it is accepted forever.

### What this does not claim

`npm audit` will still report 2 high, because audit reads the dependency tree
and not the call graph. The number is **correct and the risk is not** — and the
right response to that is a checked argument, not a suppressed warning.

If `pptxgenjs` ever publishes a release that drops `image-size`, or the pptx
exporter grows image support, this section is what gets revisited.

### Results

```
npm test    2289 / 212 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0 · pptx exporter unchanged and still loading
```
