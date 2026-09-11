/**
 * AQUA — the reusable parse session
 * Blueprint E1/PR-4b · closes the gap E1/PR-4 declared
 *
 * E1/PR-4 bounded three call sites and left the workspace ingest loop
 * unbounded, because a one-shot worker cost 82× inline on a 20-document batch
 * (6275 ms vs 76 ms). A session pays the spawn once: **355 ms**.
 *
 * THE ASSERTION THIS SUITE EXISTS FOR IS RESPAWN. A one-shot worker that dies
 * takes one parse with it; a SESSION that dies would take the whole batch.
 * `ingestFiles` already promises "one bad document can't fail an entire batch
 * upload", and a shared worker is the easiest way to break that promise
 * without noticing.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createParseSession } from '../parseSession.js';
import { PARSE_LIMITS, ParseLimitError } from '../boundedParse.js';
import { parseDocument } from '../../project/documentParser.js';
import { ingestFiles } from '../../project/fileIngester.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const bytes = n => fs.readFileSync(path.join(HERE, 'fixtures', n));
const workerAt = n => new URL(`./workers/${n}`, import.meta.url);

const sessions = [];
const session = (opts) => { const s = createParseSession(opts); sessions.push(s); return s; };
after(async () => { for (const s of sessions) await s.close(); });

const docx = () => bytes('sample.docx');
const parseVia = (s, buf = docx(), ext = '.docx') =>
  s.run('parseDocument', { ext, buffer: buf }, { inline: () => parseDocument(ext, buf) });

// ── Parity ───────────────────────────────────────────────────────────────────

describe('parse session — output is identical to inline', () => {
  test('every supported format round-trips unchanged', async () => {
    const s = session();
    for (const [ext, file] of [['.docx', 'sample.docx'], ['.xlsx', 'sample.xlsx'], ['.pptx', 'sample.pptx']]) {
      const viaSession = await parseVia(s, bytes(file), ext);
      assert.deepStrictEqual(viaSession, await parseDocument(ext, bytes(file)), file);
    }
  });

  test('the SAME worker handles many parses — that is the whole point', async () => {
    const s = session();
    for (let i = 0; i < 5; i++) await parseVia(s);
    const stats = s.stats();
    assert.equal(stats.parses, 5);
    assert.equal(stats.respawns, 0, 'the worker died during a healthy batch');
  });

  test('a parser error crosses the boundary with its message', async () => {
    const s = session();
    await assert.rejects(() => parseVia(s, Buffer.from('not a docx')), err => {
      assert.ok(err.message.length > 0);
      return true;
    });
  });
});

// ── Respawn: the property a one-shot worker does not need ────────────────────

describe('parse session — a death does not take the batch with it', () => {
  test('THE LOAD-BEARING ONE: after a real death, the SAME session recovers', async () => {
    // 🔴 The first version of this test closed the session and built a NEW one
    // by hand — which proves nothing about recovery, only that the constructor
    // works twice. Measuring bite exposed it: removing `worker = null` from
    // the death handler failed ZERO tests, because no test ever asked the
    // same session to parse again after a death.
    //
    // This kills the worker underneath a live session and then reuses THAT
    // session. Without the drop, the dead handle is reused and every
    // subsequent file in the batch fails — one bad document taking the whole
    // upload with it, exactly the promise ingestFiles makes.
    const s = session();
    await parseVia(s);
    assert.equal(s.stats().alive, true);

    await s.killWorkerForTests();
    assert.equal(s.stats().alive, false, 'the dead worker was not dropped');

    const after = await parseVia(s);
    assert.deepStrictEqual(after, await parseDocument('.docx', docx()),
      'the session did not recover — one death would fail the rest of the batch');
    assert.ok(s.stats().respawns >= 1);
  });

  test('a worker that exits mid-request rejects THAT request, not the session', async () => {
    const s = session({ workerUrl: workerAt('sessionCrash.mjs') });
    await assert.rejects(
      () => s.run('parseDocument', { ext: '.docx', buffer: docx() }, { inline: () => 'inline' }),
      err => { assert.ok(err instanceof ParseLimitError || err instanceof Error); return true; },
    );
    assert.ok(s.stats().respawns >= 1, 'the death was not recorded');
  });

  test('a hung parse is rejected and the worker is replaced', async () => {
    // Without replacing it, one hung document would wedge every file after it
    // in the batch — a far worse outcome than failing the one document.
    const s = session({
      workerUrl: workerAt('sessionHang.mjs'),
      limits: { ...PARSE_LIMITS, TIMEOUT_MS: 150 },
    });
    await assert.rejects(
      () => s.run('parseDocument', { ext: '.docx', buffer: docx() }, { inline: () => 'inline' }),
      err => { assert.equal(err.limit, 'timeout'); return true; },
    );
    assert.equal(s.stats().alive, false, 'the hung worker was left in place');
  });

  test('a limit breach is NEVER retried inline', async () => {
    // E1/PR-4's split, preserved: retrying a memory bomb inline is exactly the
    // crash the worker exists to prevent, executed on purpose.
    let inlineCalled = false;
    const s = session({
      workerUrl: workerAt('sessionHang.mjs'),
      limits: { ...PARSE_LIMITS, TIMEOUT_MS: 120 },
    });
    await assert.rejects(() => s.run('parseDocument', { ext: '.docx', buffer: docx() },
      { inline: () => { inlineCalled = true; return 'inline'; } }));
    assert.equal(inlineCalled, false);
  });
});

// ── Isolation between requests ───────────────────────────────────────────────

describe('parse session — no state bleeds between documents', () => {
  test('interleaved parses return their OWN results', async () => {
    // A session carries one user's document after another. A parser that
    // remembered anything would be a cross-document leak nobody would spot.
    const s = session();
    const [a, b, c] = await Promise.all([
      parseVia(s, bytes('sample.docx'), '.docx'),
      parseVia(s, bytes('sample.xlsx'), '.xlsx'),
      parseVia(s, bytes('sample.pptx'), '.pptx'),
    ]);
    assert.deepStrictEqual(a, await parseDocument('.docx', bytes('sample.docx')));
    assert.deepStrictEqual(b, await parseDocument('.xlsx', bytes('sample.xlsx')));
    assert.deepStrictEqual(c, await parseDocument('.pptx', bytes('sample.pptx')));
  });

  test('the worker file holds no module-level mutable state', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/upload/parseSessionWorker.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/^\s*let\s|^\s*var\s/m.test(src), 'the session worker has mutable module state');
  });
});

// ── The kill switch and the closed session ───────────────────────────────────

describe('parse session — lifecycle', () => {
  test('AQUA_PARSE_WORKER=off runs inline, as everywhere else', async () => {
    const prev = process.env.AQUA_PARSE_WORKER;
    process.env.AQUA_PARSE_WORKER = 'off';
    try {
      const s = session();
      assert.equal(await s.run('parseDocument', {}, { inline: () => 'inline-result' }), 'inline-result');
      assert.equal(s.stats().alive, false, 'a worker was spawned despite the kill switch');
    } finally {
      if (prev === undefined) delete process.env.AQUA_PARSE_WORKER; else process.env.AQUA_PARSE_WORKER = prev;
    }
  });

  test('a closed session refuses rather than silently spawning again', async () => {
    const s = createParseSession();
    await s.close();
    await assert.rejects(() => s.run('parseDocument', {}, { inline: () => 'x' }), /closed/);
  });

  test('close is idempotent', async () => {
    const s = createParseSession();
    await s.close();
    await assert.doesNotReject(() => s.close());
  });
});

// ── The gap this closes ──────────────────────────────────────────────────────

describe('parse session — the ingest loop is bounded now', () => {
  test('GAP CLOSED: the workspace ingest loop parses through a session', async () => {
    // E1/PR-4 recorded this as an inverting test:
    //   "KNOWN GAP: the workspace ingest loop is still unbounded (E1/PR-4b)"
    // That assertion is inverted in boundedParse.test.js by this PR.
    const src = fs.readFileSync(path.join(ROOT, 'src/project/fileIngester.js'), 'utf8');
    assert.match(src, /createParseSession/);
    assert.match(src, /session\.run\('parseDocument'/);
  });

  test('a batch of documents is parsed correctly and completely', async () => {
    const b64 = docx().toString('base64');
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `doc${i}.docx`, content: b64, encoding: 'base64',
    }));
    const out = await ingestFiles(files);
    assert.equal(out.length, 6, 'the bounded loop dropped documents');
  });

  test('a batch with NO documents spawns no worker at all', async () => {
    // Most uploads are plain source files. Spawning a worker for them would be
    // a cost with no benefit, so the session is created lazily.
    const t = Date.now();
    await ingestFiles([{ path: 'a.js', content: 'const a = 1;' }]);
    assert.ok(Date.now() - t < 150, 'a worker was spawned for a batch containing no documents');
  });

  test('the session is closed even when the loop throws', () => {
    // A session that outlives its batch leaves a thread alive for the life of
    // the process — one leaked thread per upload is a slow, invisible leak.
    const src = fs.readFileSync(path.join(ROOT, 'src/project/fileIngester.js'), 'utf8');
    assert.match(src, /\}\s*finally\s*\{/);
    assert.match(src, /await session\.close\(\)/);
  });
});
