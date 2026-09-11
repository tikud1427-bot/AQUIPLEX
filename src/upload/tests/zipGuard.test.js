/**
 * AQUA ZIP Guard — ceilings
 * Blueprint E1/PR-3
 *
 * Every ceiling is asserted twice: once that a hostile container is refused,
 * once that a LEGITIMATE container of the same shape still passes. Refusing
 * everything is easy; refusing bombs without refusing real slide decks is the
 * actual problem, and it is the half that breaks first when limits get tuned.
 *
 * Fixtures are built here rather than committed because a bomb is defined by
 * its RATIO, not its bytes — a committed 300 MB fixture would be absurd, and a
 * committed small one would stop testing the thing it is named after. The
 * builder is the same zero-dependency one PR-1 introduced, so these archives
 * are byte-deterministic too.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildZip } from '../../../scripts/build-parser-fixtures.mjs';
import { openZip, openDocumentZip, ZIP_PROFILES, ZipGuardError } from '../zipGuard.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const bytes = name => readFileSync(path.join(FIXTURES, name));

/** A container that expands `ratio`-ish times: one highly compressible entry. */
const bomb = (uncompressedBytes) =>
  buildZip([{ name: 'bulk/data.txt', data: Buffer.alloc(uncompressedBytes, 0x41), deflate: true }]);

// ── Profiles ─────────────────────────────────────────────────────────────────

describe('zipGuard — profiles', () => {
  test('both profiles are frozen and complete', () => {
    for (const name of ['archive', 'document']) {
      const p = ZIP_PROFILES[name];
      assert.ok(Object.isFrozen(p), `${name} profile must be frozen`);
      for (const k of ['MAX_ENTRIES', 'MAX_ENTRY_BYTES', 'MAX_TOTAL_BYTES', 'MAX_RATIO']) {
        assert.equal(typeof p[k], 'number', `${name}.${k}`);
        assert.ok(p[k] > 0, `${name}.${k} must be positive`);
      }
    }
  });

  test('the archive profile keeps the exact ceilings the code already enforced', () => {
    // These three numbers are NOT new. Changing them here would be a silent
    // behaviour change to every existing upload, so they are pinned.
    const a = ZIP_PROFILES.archive;
    assert.equal(a.MAX_ENTRIES, 10_000);
    assert.equal(a.MAX_ENTRY_BYTES, 20_000_000);
    assert.equal(a.MAX_TOTAL_BYTES, 300_000_000);
  });

  test('the document profile is tighter than the archive profile', () => {
    const { archive: a, document: d } = ZIP_PROFILES;
    assert.ok(d.MAX_ENTRIES < a.MAX_ENTRIES);
    assert.ok(d.MAX_TOTAL_BYTES < a.MAX_TOTAL_BYTES);
  });

  test('an unknown profile is refused, not silently defaulted', () => {
    assert.throws(() => openZip(bytes('project.zip'), 'nope'), ZipGuardError);
  });
});

// ── The ratio ceiling — the gap PR-1 documented ──────────────────────────────

describe('zipGuard — expansion ratio', () => {
  test('refuses a zip bomb', () => {
    const b = bomb(8 * 1024 * 1024); // ~1000:1
    assert.throws(() => openZip(b, 'archive'), err => {
      assert.equal(err.name, 'ZipGuardError');
      assert.equal(err.limit, 'ratio');
      assert.match(err.message, /expands \d+×/);
      assert.ok(err.observed > ZIP_PROFILES.archive.MAX_RATIO);
      return true;
    });
  });

  test('refuses a bomb dressed as a document too', () => {
    assert.throws(() => openDocumentZip(bomb(8 * 1024 * 1024), 'Presentation'), err => {
      assert.equal(err.limit, 'ratio');
      return true;
    });
  });

  test('ACCEPTS ordinary compressible XML — the false-positive half', () => {
    // ~40 KB of repetitive but realistic markup, deflated. Real documents
    // compress well; the ceiling must not treat "compresses well" as hostile.
    const xml = `<?xml version="1.0"?><doc>${'<p>Some ordinary sentence of prose.</p>'.repeat(1000)}</doc>`;
    const z = buildZip([{ name: 'content.xml', data: xml, deflate: true }]);
    const ratio = Buffer.byteLength(xml) / z.length;
    assert.ok(ratio > 20, `fixture should be genuinely compressible, measured ${ratio.toFixed(0)}:1`);
    assert.ok(ratio < ZIP_PROFILES.document.MAX_RATIO, 'fixture must sit under the ceiling');
    const zip = openDocumentZip(z, 'Document');
    assert.equal(zip.readEntry(zip.entries[0]).toString('utf8').length, xml.length);
  });

  test('an empty container does not divide by zero', () => {
    const zip = openZip(buildZip([]), 'archive');
    assert.deepEqual(zip.entries, []);
  });
});

// ── Entry count ──────────────────────────────────────────────────────────────

describe('zipGuard — entry count', () => {
  test('refuses more entries than the document profile allows', () => {
    const many = buildZip(Array.from({ length: ZIP_PROFILES.document.MAX_ENTRIES + 1 },
      (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
    assert.throws(() => openDocumentZip(many, 'Presentation'), err => {
      assert.equal(err.limit, 'entries');
      return true;
    });
  });

  test('ACCEPTS a slide deck with a realistic part count', () => {
    // 100 slides + rels + layouts + media ≈ 600 parts. Well within 2,000.
    const parts = Array.from({ length: 600 }, (_, i) => ({ name: `ppt/part${i}.xml`, data: '<x/>' }));
    const zip = openDocumentZip(buildZip(parts), 'Presentation');
    assert.equal(zip.entries.length, 600);
  });
});

// ── Size ceilings ────────────────────────────────────────────────────────────

describe('zipGuard — size ceilings', () => {
  test('skips a single oversize entry rather than failing the whole container', () => {
    // Preserves the pre-PR-3 behaviour of archiveExtractor and fileIngester:
    // one absurd file in an otherwise fine archive should not lose the archive.
    const big = Buffer.alloc(ZIP_PROFILES.document.MAX_ENTRY_BYTES + 1, 0x42);
    const z = buildZip([{ name: 'ok.txt', data: 'fine' }, { name: 'huge.bin', data: big }]);
    const zip = openDocumentZip(z, 'Document');
    assert.equal(zip.skippedOversize, 1);
    assert.deepEqual(zip.entries.map(e => e.entryName), ['ok.txt']);
  });

  test('directories are not entries', () => {
    const zip = openZip(bytes('project.zip'), 'archive');
    assert.ok(zip.entries.every(e => !e.isDirectory));
  });

  test('the read budget catches a container that under-reports its own size', () => {
    // The declared-size ceilings are checked against the central directory, so
    // a header that lies SMALL slips past them. readEntry() counts ACTUAL bytes
    // for exactly that case. Exercised here by reading past the budget: a
    // 2 MB entry read 60 times exceeds the 100 MB document budget.
    const z = buildZip([{ name: 'a.bin', data: Buffer.alloc(2_000_000, 0x41) }]);
    const zip = openDocumentZip(z, 'Document');
    assert.throws(() => {
      for (let i = 0; i < 60; i++) zip.readEntry(zip.entries[0]);
    }, err => {
      assert.equal(err.name, 'ZipGuardError');
      assert.equal(err.limit, 'actual');
      assert.match(err.message, /under-reports its own size/);
      return true;
    });
  });
});

// ── Behaviour preserved from before the guard ────────────────────────────────

describe('zipGuard — preserved behaviour', () => {
  test('a password-protected container is refused with the same message as before', () => {
    assert.throws(() => openZip(bytes('encrypted.zip'), 'archive'), err => {
      assert.equal(err.limit, 'encrypted');
      assert.match(err.message, /password-protected/i);
      return true;
    });
  });

  test('a corrupt container is refused, not partially read', () => {
    assert.throws(() => openZip(Buffer.from('not a zip at all'), 'archive'), err => {
      assert.equal(err.limit, 'parse');
      return true;
    });
  });

  test('the label reaches the message so five callers do not invent five wordings', () => {
    assert.throws(() => openZip(bomb(8 * 1024 * 1024), 'archive', { label: 'Presentation' }), err => {
      // assert.throws() matches a RegExp against String(err), which carries the
      // class prefix — so the message is checked directly instead.
      assert.ok(err.message.startsWith('Presentation expands'), err.message);
      return true;
    });
  });

  test('every frozen fixture still opens cleanly under the guard', () => {
    for (const name of ['project.zip', 'sample.xlsx', 'sample.pptx', 'sample.docx', 'sample.odt', 'sample.epub']) {
      const profile = name === 'project.zip' ? 'archive' : 'document';
      const zip = openZip(bytes(name), profile);
      assert.ok(zip.entries.length > 0, `${name} produced no entries`);
    }
  });
});
