/**
 * P6 hardening — the limits P1–P5 documented, now closed:
 *   • PDF: embedded DejaVu subset (₹/Cyrillic/Greek render), Indic still
 *     routed to docx (shaping, not coverage)
 *   • tar: GNU 'L' longname records for unsplittable paths (verified
 *     against the SYSTEM tar binary)
 *   • store: version-cap pruning, model-size cap, per-artifact write
 *     serialization under concurrent edits
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-artifact-p6-'));
process.env.AQUA_ARTIFACTS_DIR = path.join(TMP, 'store');

const store = await import('../artifactStore.js');
await import('../engine.js');
const { getExporter } = await import('../exporters/registry.js');
const { PDF_FONT_COVERAGE } = await import('../exporters/pdfExporter.js');
const { cleanForCoverage }  = await import('../exporters/documentModel.js');
const { createTarBuffer }   = await import('../tarWriter.js');
const { editArtifact }      = await import('../editEngine.js');

before(() => store._resetForTests());
after(() => {
  store._resetForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── PDF Unicode (P6 closes the P2 WinAnsi limit) ──────────────────────────────

test('pdf: embedded font covers ₹, Cyrillic, Greek, accents — renders and reloads', async () => {
  const p = getExporter('pdf');
  const spec = { format: 'pdf', title: 'Unicode', files: [{ path: 'u.pdf' }], packaging: 'auto' };
  const model = {
    title: 'Invoice — café Дом Ωmega',
    blocks: [
      { type: 'paragraph', text: 'Total: ₹1,24,500 — paid in full. Naïve café; Дом; Ωmega; “smart quotes”.' },
      { type: 'table', rows: [['Item', 'Amount'], ['Retainer', '₹99,000'], ['Éclair', '₹500']] },
    ],
  };
  const built = await p.build({ spec, helpers: { generateJson: async () => model } });
  const v = p.validate(built);
  assert.equal(v.valid, true, JSON.stringify(v.errors));

  const { files } = await p.export(built, { spec });
  assert.equal(files[0].buffer.subarray(0, 5).toString('ascii'), '%PDF-');
  const loaded = await PDFDocument.load(files[0].buffer);
  assert.ok(loaded.getPageCount() >= 1);

  // Prove a subset-embedded TrueType font is actually in the document.
  // pdf-lib compresses into object streams, so grep the parsed objects, not
  // the raw bytes: StandardFonts would carry no FontFile2 and no subset tag.
  let hasFontFile2 = false;
  const baseFonts = new Set();
  for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
    const s = String(obj);
    if (s.includes('FontFile2')) hasFontFile2 = true;
    const m = s.match(/BaseFont\s*\/([A-Za-z0-9+\-]+)/);
    if (m) baseFonts.add(m[1]);
  }
  assert.ok(hasFontFile2, 'TrueType font is embedded, not a standard font reference');
  assert.ok([...baseFonts].some(n => /DejaVuSans/.test(n)), `expected a DejaVu subset, got ${[...baseFonts]}`);
});

test('pdf: coverage set actually contains the code points we claim', () => {
  for (const ch of ['₹', 'Д', 'Ω', 'é', '—', '“', '•']) {
    assert.ok(PDF_FONT_COVERAGE.has(ch.codePointAt(0)), `missing ${ch}`);
  }
  // Devanagari deliberately excluded — shaping, not coverage.
  assert.equal(PDF_FONT_COVERAGE.has('र'.codePointAt(0)), false);
  const hindi = cleanForCoverage('राजस्व', PDF_FONT_COVERAGE);
  assert.equal(hindi.lossRatio, 1);
});

// ── GNU longname tar (P6 closes the P3 throw) ─────────────────────────────────

test('tar: unsplittable long path ships as a GNU longname and system tar reads it', () => {
  // Single segment >100 bytes → no valid ustar prefix split exists.
  const longSegment = 'a'.repeat(180) + '.txt';
  const files = [
    { path: `deep/${longSegment}`, buffer: Buffer.from('long name payload') },
    { path: 'ok.txt',              buffer: Buffer.from('normal') },
  ];
  const buf = createTarBuffer(files, { rootDir: 'proj' });
  const tp = path.join(TMP, 'long.tar');
  fs.writeFileSync(tp, buf);

  const listing = execFileSync('tar', ['-tf', tp], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(listing.some(l => l.includes(longSegment)), `long path missing from listing: ${listing.join(' | ')}`);
  assert.ok(listing.some(l => l === 'proj/ok.txt'));

  const out = path.join(TMP, 'x-long');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xf', tp, '-C', out]);
  assert.equal(fs.readFileSync(path.join(out, 'proj', 'deep', longSegment), 'utf8'), 'long name payload');
  assert.equal(fs.readFileSync(path.join(out, 'proj', 'ok.txt'), 'utf8'), 'normal');
});

test('tar: hostile paths still refused after the longname change', () => {
  assert.throws(() => createTarBuffer([{ path: '../evil', buffer: Buffer.from('a') }]));
  assert.throws(() => createTarBuffer([{ path: '/abs', buffer: Buffer.from('a') }]));
});

// ── Store hardening ───────────────────────────────────────────────────────────

const mkArt = (over = {}) => store.createArtifact({
  ownerId: 'user:u1', conversationId: 'c-p6', requestId: 'r-p6',
  format: 'md', title: 'Doc', packaging: 'raw',
  spec: { format: 'md', title: 'Doc', files: [{ path: 'a.md' }], packaging: 'raw' },
  files: [{ path: 'a.md', buffer: Buffer.from('v1'), mime: 'text/markdown' }],
  ...over,
});

test('store: version cap prunes middle versions, keeps v1 and the newest window', async () => {
  store._resetForTests();
  const art = await mkArt();
  for (let i = 2; i <= 24; i++) {
    await store.appendVersion(art.id, {
      files: [{ path: 'a.md', buffer: Buffer.from(`v${i}`), mime: 'text/markdown' }],
      reason: `edit ${i}`,
    });
  }
  const m = await store.getArtifact(art.id);
  assert.equal(m.version, 24);
  assert.equal(m.versions.length, 20, 'capped at MAX_VERSIONS');
  assert.equal(m.versions[0].v, 1, 'the original always survives');
  assert.equal(m.versions.at(-1).v, 24);

  // v1 and the newest window are on disk; pruned middles are gone.
  assert.ok(fs.existsSync(store.getFileAbsolutePath(m, 'a.md', 1)));
  assert.equal(fs.readFileSync(store.getFileAbsolutePath(m, 'a.md', 1), 'utf8'), 'v1');
  assert.equal(fs.readFileSync(store.getFileAbsolutePath(m, 'a.md', 24), 'utf8'), 'v24');
  // A pruned version is no longer addressable (routes 404 on this throw).
  assert.throws(() => store.getFileAbsolutePath(m, 'a.md', 3));
});

test('store: oversized content model is dropped with a warn, artifact still created', async () => {
  store._resetForTests();
  const huge = { blob: 'x'.repeat(500_000) };
  const art = await mkArt({ requestId: 'r-model', model: huge });
  assert.equal(art.model, undefined, 'model over the cap is not persisted');
  assert.equal(art.files.length, 1, 'artifact itself is unaffected');

  const small = { slides: [{ title: 'ok' }] };
  const art2 = await mkArt({ requestId: 'r-model2', model: small });
  assert.deepEqual(art2.model, small);
});

test('store: concurrent appendVersion calls serialize into v2 AND v3', async () => {
  store._resetForTests();
  const art = await mkArt();
  const [a, b] = await Promise.all([
    store.appendVersion(art.id, { files: [{ path: 'a.md', buffer: Buffer.from('A'), mime: 'text/markdown' }], reason: 'A' }),
    store.appendVersion(art.id, { files: [{ path: 'a.md', buffer: Buffer.from('B'), mime: 'text/markdown' }], reason: 'B' }),
  ]);
  const versions = [a.version, b.version].sort();
  assert.deepEqual(versions, [2, 3], 'no torn race on the version number');
  const m = await store.getArtifact(art.id);
  assert.equal(m.version, 3);
  assert.deepEqual(m.versions.map(v => v.v), [1, 2, 3]);
  assert.ok(fs.existsSync(store.getFileAbsolutePath(m, 'a.md', 2)));
});

test('edit: two concurrent edits both land as distinct versions', async () => {
  store._resetForTests();
  const art = await store.createArtifact({
    ownerId: 'user:u1', conversationId: 'c-p6', requestId: 'r-ce',
    format: 'md', title: 'Notes', packaging: 'raw',
    spec: { format: 'md', title: 'Notes', files: [{ path: 'notes.md', description: 'notes' }], packaging: 'raw' },
    files: [{ path: 'notes.md', buffer: Buffer.from('# original'), mime: 'text/markdown' }],
  });
  const mkGen = (tag) => async () => ({ text: `# ${tag}`, provider: 'stub' });
  const [r1, r2] = await Promise.all([
    editArtifact({ artifactId: art.id, instruction: 'edit notes.md one', requestId: 'e1', generate: mkGen('one') }),
    editArtifact({ artifactId: art.id, instruction: 'edit notes.md two', requestId: 'e2', generate: mkGen('two') }),
  ]);
  assert.deepEqual([r1.manifest.version, r2.manifest.version].sort(), [2, 3]);
  const m = await store.getArtifact(art.id);
  assert.equal(m.version, 3);
  assert.equal(store.getArtifactLite(art.id).version, 3, 'index agrees with the manifest');
});
