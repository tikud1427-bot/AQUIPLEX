# AQUA Parser Baseline

**Blueprint reference:** Epic E1 (Platform Safety) · PR-1
**Status:** landed
**Changes behaviour:** no — additive tests, fixtures, one script, three npm scripts

---

## Why this exists

Epic E1 replaces two dependencies that sit on the direct file-upload path:

| Dependency | Advisory | Reached from | Replaced in |
|---|---|---|---|
| `adm-zip` | crafted ZIP triggers a 4 GB allocation | `upload/archiveExtractor.js`, `upload/documentPipeline.js`, `project/documentParser.js`, `project/fileIngester.js` | E1/PR-3 |
| `xlsx` (SheetJS 0.18.5) | prototype pollution | `project/documentParser.js` | E1/PR-2 |

A dependency swap on a parser is only safe if we can prove the replacement
reads **the same bytes** to **the same text**. Before this PR we could not,
for one specific reason: the existing parser suite builds its fixtures with
the very libraries under replacement.

```js
// src/project/tests/documentParser.test.js
function buildDocx(...) { const zip = new AdmZip(); … }   // ← adm-zip
function buildPptx(...) { const zip = new AdmZip(); … }   // ← adm-zip
function buildXlsx(...) { return XLSX.write(…); }         // ← xlsx
```

Swap the library and the fixture changes with it. Parity measured against a
moving input is not parity — it is two unknowns compared to each other.

So PR-1 does exactly one thing: **it stops the inputs moving, and records what
the current code produces from them.**

## What it establishes

**Frozen inputs.** Ten fixtures, committed as bytes, built by
`scripts/build-parser-fixtures.mjs` using **no third-party dependency at
all** — ZIP, TAR and the OOXML/ODF/EPUB skeletons are written by hand against
their format specs with only `node:zlib` and `node:crypto`.

**Frozen outputs.** `golden.json` records the exact result of all six parser
entry points that touch `adm-zip` or `xlsx`:

```
documentParser.parseDocument('.xlsx')      ← xlsx
documentParser.parseDocument('.pptx')      ← adm-zip
documentParser.parseDocument('.docx')      ← mammoth (frozen for completeness)
documentPipeline.processDocument('.odt')   ← adm-zip
documentPipeline.processDocument('.epub')  ← adm-zip
archiveExtractor.extractArchive(zip|tar|tar.gz)  ← adm-zip (zip lane)
fileIngester.extractZip()                  ← adm-zip
```

**Integrity.** Every fixture's sha256 is in `manifest.json` and asserted. The
builder is re-run *in-process* during the test and its output byte-compared
against the committed files, so the fixtures cannot silently drift from the
spec that produced them.

**The contract for the rest of E1:** `golden.json` must not change unless the
PR intends to change behaviour — and then the diff is what the reviewer signs
off on. A PR that claims parity while moving the golden is wrong about one of
the two.

## Observed quirks, pinned deliberately

A characterization suite records what the code *does*, not what it *should*
do. Three real behaviours are pinned that a reviewer might mistake for test
bugs. None is fixed here — a fix is a behaviour change and needs its own PR.

**1. Empty sheets are not dropped from XLSX output.**
`parseXlsx()` filters with `!s.endsWith('--')`, but the string it builds is
`` `-- Sheet: ${name} --\n${csv}` ``. With an empty `csv` the value ends in a
**newline**, so the filter never matches and the bare header survives:

```
-- Sheet: Notes --
A note about the results

-- Sheet: Empty --        ← header with no rows under it
```

Minor, real, and out of scope for a no-behaviour-change PR. Fix candidate for
E1/PR-2, where the golden diff will show it clearly.

**2. A skipped spreadsheet row becomes an empty CSV line** (`,,`) rather than
being omitted. Sheet-to-CSV semantics differ between SheetJS forks here, which
is exactly why it is frozen.

**3. `007` survives as text and `Smith, John` stays CSV-quoted.** Both are
numeric-coercion and quoting decisions a fork could change without noticing.

## The documented security gap

`highratio.zip` expands ~1000:1 and extracts today without complaint. The
existing caps are per-entry *size* (20 MB) and total *size* (300 MB) — there
is **no ratio ceiling**, and the caps in `archiveExtractor.js` run *after*
`adm-zip` has already parsed the container, which is where the advisory lives.

`parserBaseline.test.js` asserts the current permissive behaviour under the
name **`BASELINE GAP: no compression-ratio ceiling exists today`**. When
E1/PR-3 adds the ceiling, that assertion inverts — and the inversion is the
visible proof the ceiling works, rather than a claim in a commit message.

## Bite

Measured, not asserted. Each mutation was applied, the suite run, then
reverted:

| Mutation | Failures |
|---|---|
| PPTX sorted lexicographically instead of numerically | 2 |
| XLSX sheet-header format changed | 3 |
| One byte flipped in `sample.odt` | 4 |
| *(reverted)* | **0 — 43/43 pass** |

## Files

```
scripts/build-parser-fixtures.mjs                     new  deterministic, zero-dep builder
src/upload/tests/fixtures/                            new  10 fixtures + manifest + golden + README
src/upload/tests/parserBaseline.test.js               new  archive + pipeline characterization
src/project/tests/documentParserBaseline.test.js      new  xlsx / pptx / docx characterization
package.json                                          +3 scripts (additive)
AQUA_PARSER_BASELINE.md                               this file
```

No production module was modified.

## Commands

```bash
npm run test:parsers              # the two baseline suites
npm run fixtures:parsers:check    # verify committed fixture bytes
npm run fixtures:parsers          # rebuild fixtures + manifest
node scripts/build-parser-fixtures.mjs --golden   # re-record expected output
```
