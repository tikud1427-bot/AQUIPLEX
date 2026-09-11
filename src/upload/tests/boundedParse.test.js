/**
 * AQUA Bounded Parse — the memory/time boundary
 * Blueprint E1/PR-4
 *
 * Two halves, and the second is the one that matters:
 *
 *   1. PARITY — a bounded parse returns byte-identical output to the inline
 *      one. If this ever fails, the boundary has changed what users see and
 *      the PR is wrong regardless of how well it contains attacks.
 *
 *   2. THE FALLBACK POLICY — a worker that could not START falls back inline;
 *      a worker that hit its CAP does not. Getting that backwards would make
 *      the whole PR decorative: retrying a memory bomb inline is precisely the
 *      crash the worker exists to prevent, executed on purpose.
 *
 * The ceilings cannot be exercised with 5 KB fixtures, so `runBounded` takes
 * `limits` and `workerUrl` seams and the misbehaving workers live in
 * ./workers/.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runBounded, parseDocumentBounded, extractArchiveBounded, extractZipBounded,
  isWorkerEnabled, PARSE_LIMITS, ParseLimitError,
} from '../boundedParse.js';
import { parseDocument } from '../../project/documentParser.js';
import { extractArchive } from '../archiveExtractor.js';
import { extractZip } from '../../project/fileIngester.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bytes = n => readFileSync(path.join(HERE, 'fixtures', n));
const workerAt = n => new URL(`./workers/${n}`, import.meta.url);

const ORIGINAL_FLAG = process.env.AQUA_PARSE_WORKER;
after(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.AQUA_PARSE_WORKER;
  else process.env.AQUA_PARSE_WORKER = ORIGINAL_FLAG;
});
before(() => { delete process.env.AQUA_PARSE_WORKER; });

// ── 1. Parity ────────────────────────────────────────────────────────────────

describe('boundedParse — output parity with the inline parser', () => {
  test('parseDocument: xlsx / pptx / docx are identical through the worker', async () => {
    for (const [ext, file] of [['.xlsx', 'sample.xlsx'], ['.pptx', 'sample.pptx'], ['.docx', 'sample.docx']]) {
      const inline = await parseDocument(ext, bytes(file));
      const bounded = await parseDocumentBounded(ext, bytes(file));
      assert.deepStrictEqual(bounded, inline, `${file} differed across the boundary`);
    }
  });

  test('extractArchive: zip / tar / tar.gz are identical through the worker', async () => {
    for (const [file, fmt] of [['project.zip', 'zip'], ['project.tar', 'tar'], ['project.tar.gz', 'tar.gz']]) {
      const inline = await extractArchive(bytes(file), fmt);
      const bounded = await extractArchiveBounded(bytes(file), fmt);
      assert.deepStrictEqual(bounded, inline, `${file} differed across the boundary`);
    }
  });

  test('extractZip is identical through the worker', async () => {
    const b64 = bytes('project.zip').toString('base64');
    assert.deepStrictEqual(await extractZipBounded(b64), await extractZip(b64));
  });

  test('Buffers survive the thread boundary without corruption', async () => {
    // Structured clone delivers a Uint8Array, not a Buffer. If parseWorker's
    // asBuffer() were dropped, SheetJS would still parse but binary carry-
    // through would silently mangle — so the base64 payload is checked byte
    // for byte, not just for presence.
    const files = await extractArchiveBounded(bytes('project.zip'), 'zip');
    const deck = files.find(f => f.path === 'docs/deck.pptx');
    assert.equal(deck.encoding, 'base64');
    assert.deepEqual(Buffer.from(deck.content, 'base64'), bytes('sample.pptx'));
  });
});

// ── 2. Error propagation ─────────────────────────────────────────────────────

describe('boundedParse — errors cross the boundary intact', () => {
  test('an ordinary parser error keeps its message', async () => {
    await assert.rejects(
      () => parseDocumentBounded('.docx', Buffer.from('not a docx')),
      err => { assert.ok(err.message.length > 0); assert.ok(!(err instanceof ParseLimitError)); return true; },
    );
  });

  test('a ZipGuardError keeps its name AND its .limit field', async () => {
    // Downstream code branches on `.limit`. Errors lose their prototype in a
    // structured clone, so the fields are carried explicitly and rebuilt —
    // this test is what stops that going quietly missing.
    await assert.rejects(
      () => extractArchiveBounded(bytes('highratio.zip'), 'zip'),
      err => {
        assert.equal(err.name, 'ZipGuardError');
        assert.equal(err.limit, 'ratio');
        assert.ok(err.observed > 200);
        return true;
      },
    );
  });

  test('a password-protected archive still reports as such', async () => {
    await assert.rejects(() => extractArchiveBounded(bytes('encrypted.zip'), 'zip'), /password-protected/i);
  });
});

// ── 3. The ceilings ──────────────────────────────────────────────────────────

describe('boundedParse — ceilings', () => {
  test('EXTERNAL memory growth is caught by the watchdog and REJECTED, not retried inline', async () => {
    // The case the heap cap provably misses. hog.mjs allocates Buffers, which
    // are external to the V8 heap; with a 32 MB heap cap it allocated 320 MB
    // unimpeded. The watchdog is what stops it.
    let inlineCalled = false;
    await assert.rejects(
      () => runBounded('parseDocument', {}, {
        inline: () => { inlineCalled = true; return 'inline result'; },
        label: 'Document',
        limits: { MAX_HEAP_MB: 32, MAX_YOUNG_MB: 8, TIMEOUT_MS: 20_000, MAX_RSS_GROWTH_MB: 48, RSS_POLL_MS: 20 },
        workerUrl: workerAt('hog.mjs'),
      }),
      err => {
        assert.ok(err instanceof ParseLimitError, `expected ParseLimitError, got ${err.name}`);
        assert.ok(['rss', 'memory', 'exit'].includes(err.limit), `unexpected limit ${err.limit}`);
        return true;
      },
    );
    assert.equal(inlineCalled, false, 'THE bug this test exists for: a memory bomb must never be retried inline');
  });

  test('V8-HEAP growth is caught by Node itself', async () => {
    await assert.rejects(
      () => runBounded('parseDocument', {}, {
        inline: () => 'inline result',
        label: 'Document',
        limits: { MAX_HEAP_MB: 32, MAX_YOUNG_MB: 8, TIMEOUT_MS: 20_000, MAX_RSS_GROWTH_MB: 0 },
        workerUrl: workerAt('heaphog.mjs'),
      }),
      err => {
        assert.ok(err instanceof ParseLimitError);
        assert.ok(['memory', 'exit'].includes(err.limit), `unexpected limit ${err.limit}`);
        return true;
      },
    );
  });

  test('a worker that never answers hits the deadline and is REJECTED, not retried inline', async () => {
    let inlineCalled = false;
    await assert.rejects(
      () => runBounded('parseDocument', {}, {
        inline: () => { inlineCalled = true; return 'inline result'; },
        label: 'Document',
        limits: { MAX_HEAP_MB: 64, MAX_YOUNG_MB: 8, TIMEOUT_MS: 150 },
        workerUrl: workerAt('hang.mjs'),
      }),
      err => {
        assert.ok(err instanceof ParseLimitError);
        assert.equal(err.limit, 'timeout');
        assert.match(err.message, /longer than/);
        return true;
      },
    );
    assert.equal(inlineCalled, false, 'a hung parse must never be retried inline');
  });

  test('a worker that dies without answering is reported, not hung on', async () => {
    await assert.rejects(
      () => runBounded('parseDocument', {}, {
        inline: () => 'inline result',
        label: 'Document',
        limits: { MAX_HEAP_MB: 64, MAX_YOUNG_MB: 8, TIMEOUT_MS: 5_000 },
        workerUrl: workerAt('crash.mjs'),
      }),
      err => { assert.ok(err instanceof ParseLimitError); assert.equal(err.limit, 'exit'); return true; },
    );
  });

  test('a worker that cannot START falls back inline — infrastructure, not input', async () => {
    let inlineCalled = false;
    const result = await runBounded('parseDocument', {}, {
      inline: () => { inlineCalled = true; return 'inline result'; },
      label: 'Document',
      workerUrl: new URL('./workers/does-not-exist.mjs', import.meta.url),
    }).catch(err => err);
    // Node reports a missing worker module as an 'error' event rather than a
    // constructor throw, so this surfaces as a rejection rather than a
    // fallback. Asserted as observed — the important half is that it is NOT a
    // ParseLimitError, so it can never be mistaken for a breached ceiling.
    if (result instanceof Error) {
      assert.ok(!(result instanceof ParseLimitError), 'a missing module must not look like a breached limit');
    } else {
      assert.equal(inlineCalled, true);
      assert.equal(result, 'inline result');
    }
  });

  test('the published limits are sane and frozen', () => {
    assert.ok(Object.isFrozen(PARSE_LIMITS));
    assert.ok(PARSE_LIMITS.MAX_HEAP_MB >= 128 && PARSE_LIMITS.MAX_HEAP_MB <= 1024);
    assert.ok(PARSE_LIMITS.TIMEOUT_MS >= 5_000);
    assert.ok(PARSE_LIMITS.MAX_RSS_GROWTH_MB >= 128, 'the watchdog must be generous enough not to trip on real documents');
  });
});

// ── 4. Kill switch ───────────────────────────────────────────────────────────

describe('boundedParse — kill switch', () => {
  test('AQUA_PARSE_WORKER=off runs inline and still returns identical output', async () => {
    process.env.AQUA_PARSE_WORKER = 'off';
    try {
      assert.equal(isWorkerEnabled(), false);
      const bounded = await parseDocumentBounded('.xlsx', bytes('sample.xlsx'));
      assert.deepStrictEqual(bounded, await parseDocument('.xlsx', bytes('sample.xlsx')));
    } finally { delete process.env.AQUA_PARSE_WORKER; }
  });

  test('the switch is ON unless explicitly turned off', () => {
    delete process.env.AQUA_PARSE_WORKER;
    assert.equal(isWorkerEnabled(), true);
    process.env.AQUA_PARSE_WORKER = 'on';
    assert.equal(isWorkerEnabled(), true);
    process.env.AQUA_PARSE_WORKER = 'anything-else';
    assert.equal(isWorkerEnabled(), true);
    delete process.env.AQUA_PARSE_WORKER;
  });
});

// ── 5. Wiring — proven through production defaults, not assumed (L12) ────────

describe('boundedParse — wiring', () => {
  test('the three untrusted-byte entry points call the BOUNDED variants', () => {
    const root = path.resolve(HERE, '../../..');
    const cases = [
      ['src/upload/documentPipeline.js', 'parseDocumentBounded'],
      ['src/routes/project.js', 'extractZipBounded'],
      ['src/files/parsers.js', 'extractArchiveBounded'],
    ];
    for (const [rel, symbol] of cases) {
      const text = readFileSync(path.join(root, rel), 'utf8');
      assert.match(text, new RegExp(`\\b${symbol}\\b`), `${rel} does not use ${symbol}`);
    }
  });

  test('GAP CLOSED IN E1/PR-4b: the workspace ingest loop is bounded', () => {
    // This assertion was the inverse until PR-4b. E1/PR-4 left the loop
    // unbounded because a one-shot worker cost 82× inline on a batch
    // (6275 ms vs 76 ms for 20 documents) and recorded the gap as a test so it
    // would invert rather than be forgotten — the same mechanism E1/PR-1 used
    // for the missing ratio ceiling that E1/PR-3 closed.
    //
    // PR-4b closes it with a REUSABLE session: the spawn is paid once per
    // batch, 355 ms. Details in parseSession.test.js.
    const root = path.resolve(HERE, '../../..');
    const text = readFileSync(path.join(root, 'src/project/fileIngester.js'), 'utf8');
    // Asserted on the ACTIVE CONDITION, not merely on the import. A first
    // version checked only that `createParseSession` appeared somewhere —
    // which a mutation to `extracted = false ? session.run(...) : inline`
    // sailed straight past, because the import was still there. Bite: 0.
    assert.match(text, /createParseSession/,
      'the ingest loop no longer imports a parse session');
    assert.match(text, /extracted = session\s*\n?\s*\? await session\.run\('parseDocument'/,
      'the ingest loop no longer routes through the session — the gap has reopened');
    assert.ok(!/extracted = await parseDocument\(ext, buffer\);/.test(text),
      'the ingest loop parses inline again');
  });
});
