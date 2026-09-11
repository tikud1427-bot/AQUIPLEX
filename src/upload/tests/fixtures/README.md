# Parser fixtures — frozen bytes

**Do not edit these files by hand. Do not regenerate them casually.**

These are real documents and archives, committed as bytes, used as the fixed
input for the parser characterization suites:

- `src/upload/tests/parserBaseline.test.js`
- `src/project/tests/documentParserBaseline.test.js`

## Why bytes and not builders

The older suite (`src/project/tests/documentParser.test.js`) builds its
fixtures with `adm-zip` and `xlsx` — the two libraries Blueprint Epic E1 is
replacing. Swap the library and the input changes with it, so "the output is
the same" proves nothing.

Everything here is produced by `scripts/build-parser-fixtures.mjs`, which uses
**no third-party dependency at all**: ZIP, TAR and the OOXML / ODF / EPUB
skeletons are written by hand against their format specs using only
`node:zlib` and `node:crypto`.

## Files

| File | What it exercises |
|---|---|
| `sample.xlsx` | SheetJS read path — comma-in-value, leading-zero string, decimal, unicode, XML entity, gap column, skipped row, empty sheet |
| `sample.pptx` | hand-rolled PPTX over adm-zip — 10-vs-2 slide ordering, entities, text-free slide, notes slide that must stay out |
| `sample.docx` | mammoth read path (not swapped in E1, frozen so the input stops moving) |
| `sample.odt` | `documentPipeline.parseOdt` — content.xml, meta.xml title, line-break |
| `sample.epub` | `documentPipeline.parseEpub` — container → OPF → spine, non-XHTML spine item |
| `project.zip` | `extractArchive('zip')` + `fileIngester.extractZip` — ignore rules, nested binary document, `../` traversal |
| `project.tar` | `extractArchive('tar')` — same logical tree, hand-rolled reader |
| `project.tar.gz` | `extractArchive('tar.gz')` — gunzip budget + tar-inside-gzip |
| `encrypted.zip` | password-protected rejection branch (GP flag bit 0; nothing is actually encrypted) |
| `highratio.zip` | ~1000:1 expansion. Documents that **no ratio ceiling exists today** — E1/PR-3 changes this |

`manifest.json` records size + sha256 + a note per fixture.
`golden.json` records the exact parser output for each one.

## Regenerating

```bash
npm run fixtures:parsers          # rebuild fixtures + manifest
npm run fixtures:parsers:check    # verify committed bytes, write nothing
node scripts/build-parser-fixtures.mjs --golden   # …and re-record golden.json
```

Regenerating `golden.json` is how an **intentional** behaviour change gets
recorded. The resulting diff is the thing a reviewer must justify — if a PR
claims "no behaviour change" and the golden moves, one of the two is wrong.

Changing the fixture *spec* means bumping `SPEC_VERSION` in the builder, which
invalidates every hash and forces a full regeneration.

## Determinism

Structural bytes are fixed (entry order, DOS timestamps at 1980-01-01, version
and attribute fields), so the builder is reproducible and the test asserts it
by rebuilding in-process and comparing.

Two fixtures are `zlibDependent: true` in the manifest — their payload is
DEFLATE/GZIP compressed, so their bytes belong to the zlib of the running Node
build, not to us. Their committed hash is still checked; their rebuild is not
required to match. Declared rather than hidden, because a guarantee that
breaks on a Node upgrade is worse than a narrower one that holds.
