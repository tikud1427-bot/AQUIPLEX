/**
 * AQUA Document Parser Baseline — XLSX / PPTX / DOCX characterization
 * Blueprint E1/PR-1
 *
 * WHY THIS EXISTS ALONGSIDE documentParser.test.js
 * ------------------------------------------------
 * The existing suite proves parseDocument() WORKS. It cannot prove a library
 * swap is behaviour-neutral, because it builds its own fixtures with the
 * libraries under replacement:
 *
 *     buildXlsx() → XLSX.write()      ← the library E1/PR-2 replaces
 *     buildPptx() → new AdmZip()      ← the library E1/PR-3 replaces
 *     buildDocx() → new AdmZip()
 *
 * Swap the library and the input changes too. This suite reads FROZEN BYTES
 * built with no third-party dependency at all, and asserts the exact output.
 *
 * These are CHARACTERIZATION tests. They pin what the code does today,
 * including the quirks listed below. Fixing a quirk is a behaviour change and
 * belongs in its own PR with its own golden diff — not silently here.
 *
 * OBSERVED QUIRKS, PINNED DELIBERATELY
 * ------------------------------------
 * 1. Empty sheets are NOT dropped. parseXlsx() filters with
 *    `!s.endsWith('--')`, but the string it builds is `-- Sheet: X --\n${csv}`;
 *    with an empty csv the value ends in a NEWLINE, so the filter never
 *    matches and the bare header survives into the output. The golden records
 *    the trailing `-- Sheet: Empty --`. Real, minor, and out of scope for a
 *    no-behaviour-change PR — see AQUA_PARSER_BASELINE.md.
 * 2. A skipped spreadsheet row is emitted as a fully empty CSV line (`,,`),
 *    not omitted. Sheet-to-CSV semantics differ between SheetJS forks here,
 *    which is precisely why it is pinned.
 * 3. A leading-zero string ("007") survives as text, and a comma-bearing value
 *    is CSV-quoted. Both are numeric/quoting decisions a fork could change.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeForGolden, SPEC_VERSION } from '../../../scripts/build-parser-fixtures.mjs';
import { parseDocument } from '../documentParser.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../upload/tests/fixtures',
);
const bytes = name => readFileSync(path.join(FIXTURES, name));
const golden = JSON.parse(readFileSync(path.join(FIXTURES, 'golden.json'), 'utf8'));

test('golden was recorded against the current fixture spec', () => {
  assert.equal(golden.specVersion, SPEC_VERSION);
});

// ── XLSX — the `xlsx` (SheetJS) path replaced in E1/PR-2 ─────────────────────

describe('parseDocument — XLSX frozen output', () => {
  test('matches the golden exactly', async () => {
    const actual = normalizeForGolden(await parseDocument('.xlsx', bytes('sample.xlsx')));
    assert.deepStrictEqual(actual, golden['documentParser.xlsx']);
  });

  test('quotes a value containing a comma', async () => {
    const { text } = await parseDocument('.xlsx', bytes('sample.xlsx'));
    assert.ok(text.includes('"Smith, John"'), 'comma-bearing value must stay CSV-quoted');
  });

  test('preserves a leading-zero string instead of coercing it to a number', async () => {
    const { text } = await parseDocument('.xlsx', bytes('sample.xlsx'));
    assert.ok(/^007,/m.test(text), 'expected 007 to survive as text');
  });

  test('preserves unicode and decodes XML entities', async () => {
    const { text } = await parseDocument('.xlsx', bytes('sample.xlsx'));
    assert.ok(text.includes('café ☕'));
    assert.ok(text.includes('Zoë'));
    assert.ok(text.includes('Rock & Roll <live>'));
  });

  test('emits every sheet in workbook order with its header line', async () => {
    const { text, meta } = await parseDocument('.xlsx', bytes('sample.xlsx'));
    assert.equal(meta.sheetCount, 3);
    assert.ok(text.indexOf('-- Sheet: Results --') < text.indexOf('-- Sheet: Notes --'));
  });

  test('QUIRK PINNED: an empty sheet still emits its header line', async () => {
    // See the header note. Asserted so a fork that DOES drop it is caught as a
    // behaviour change rather than passing as "obviously better".
    const { text } = await parseDocument('.xlsx', bytes('sample.xlsx'));
    assert.ok(text.endsWith('-- Sheet: Empty --'), text.slice(-60));
  });

  test('QUIRK PINNED: a skipped row becomes an empty CSV line', async () => {
    const { text } = await parseDocument('.xlsx', bytes('sample.xlsx'));
    assert.ok(text.includes('\n,,\n'), 'row 5 gap should appear as an empty CSV row');
  });
});

// ── PPTX — hand-rolled over adm-zip, replaced in E1/PR-3 ─────────────────────

describe('parseDocument — PPTX frozen output', () => {
  test('matches the golden exactly', async () => {
    const actual = normalizeForGolden(await parseDocument('.pptx', bytes('sample.pptx')));
    assert.deepStrictEqual(actual, golden['documentParser.pptx']);
  });

  test('orders slides numerically, not lexicographically', async () => {
    const { text } = await parseDocument('.pptx', bytes('sample.pptx'));
    assert.ok(text.indexOf('-- Slide 2 --') < text.indexOf('-- Slide 10 --'));
  });

  test('ignores notesSlides — only ppt/slides/slideN.xml is read', async () => {
    const { text } = await parseDocument('.pptx', bytes('sample.pptx'));
    assert.ok(!text.includes('Speaker note'), 'speaker notes must not reach the prompt');
  });

  test('drops a slide with no text runs and does not count it', async () => {
    const { meta } = await parseDocument('.pptx', bytes('sample.pptx'));
    assert.equal(meta.slideCount, 10, 'slide 11 has no runs and must not be counted');
  });

  test('decodes XML entities in run text', async () => {
    const { text } = await parseDocument('.pptx', bytes('sample.pptx'));
    assert.ok(text.includes('Rock & Roll <live>'));
  });
});

// ── DOCX — mammoth, NOT swapped in E1; frozen so the input stops moving ──────

describe('parseDocument — DOCX frozen output', () => {
  test('matches the golden exactly', async () => {
    const actual = normalizeForGolden(await parseDocument('.docx', bytes('sample.docx')));
    assert.deepStrictEqual(actual, golden['documentParser.docx']);
  });

  test('preserves paragraph order and unicode', async () => {
    const { text } = await parseDocument('.docx', bytes('sample.docx'));
    assert.ok(text.indexOf('First paragraph.') < text.indexOf('Second paragraph'));
    assert.ok(text.includes('café ☕'));
    assert.ok(text.includes('Third & last.'));
  });
});

// ── Cross-cutting: the fixtures are real files of their format ───────────────

describe('parser baseline — fixture realism', () => {
  test('OOXML fixtures are ZIP containers with the PK signature', () => {
    for (const name of ['sample.xlsx', 'sample.pptx', 'sample.docx', 'sample.odt', 'sample.epub']) {
      assert.deepEqual(bytes(name).subarray(0, 2), Buffer.from('PK'), `${name} is not a ZIP container`);
    }
  });

  test('every document fixture round-trips through the real dispatcher', async () => {
    for (const [ext, file] of [['.xlsx', 'sample.xlsx'], ['.pptx', 'sample.pptx'], ['.docx', 'sample.docx']]) {
      const result = await parseDocument(ext, bytes(file));
      assert.ok(result && result.text.length > 0, `${file} produced no text`);
    }
  });
});
