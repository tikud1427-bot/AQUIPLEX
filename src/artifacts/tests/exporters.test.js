/**
 * Spec schema, text exporter family, packager — regression tests.
 * Zip output re-opened via adm-zip (round-trip) + magic-byte assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import '../exporters/textExporter.js'; // side-effect: registers all text formats
import { validateSpec } from '../specSchema.js';
import { listExporters, getExporter, resolveByExtension } from '../exporters/registry.js';
import { validateArtifactFiles } from '../validator.js';
import { resolvePackaging, buildZipBuffer } from '../packager.js';
import { QUOTAS } from '../security.js';

const knownFormats = listExporters();

// ── specSchema ────────────────────────────────────────────────────────────────

test('accepts a valid spec and normalizes it', () => {
  const r = validateSpec({
    format: 'MD',
    title: '  My Notes  ',
    files: [{ path: 'notes.md', role: 'primary', description: 'the notes' }],
    packaging: 'auto',
    structure: { sections: ['a', 'b'] },
  }, { knownFormats });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.spec.format, 'md');
  assert.equal(r.spec.title, 'My Notes');
  assert.equal(r.spec.files[0].path, 'notes.md');
  assert.equal(r.spec.packaging, 'auto');
});

test('rejects unknown formats, missing fields, empty files', () => {
  assert.equal(validateSpec({ format: 'exe', title: 'x', files: [{ path: 'a' }] }, { knownFormats }).valid, false);
  assert.equal(validateSpec({ title: 'x', files: [{ path: 'a.md' }] }, { knownFormats }).valid, false);
  assert.equal(validateSpec({ format: 'md', files: [{ path: 'a.md' }] }, { knownFormats }).valid, false);
  assert.equal(validateSpec({ format: 'md', title: 'x', files: [] }, { knownFormats }).valid, false);
  assert.equal(validateSpec(null, { knownFormats }).valid, false);
  assert.equal(validateSpec([], { knownFormats }).valid, false);
});

test('rejects hostile paths and duplicates; collects ALL errors', () => {
  const r = validateSpec({
    format: 'md', title: 'x',
    files: [
      { path: '../escape.md' },
      { path: '/abs.md' },
      { path: 'ok.md' },
      { path: 'OK.md' },          // case-insensitive duplicate
      { path: 'CON.md' },
    ],
  }, { knownFormats });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length >= 4, `expected ≥4 errors, got: ${JSON.stringify(r.errors)}`);
});

test('drops prototype-pollution keys', () => {
  const raw = JSON.parse('{"format":"md","title":"x","files":[{"path":"a.md"}],"structure":{"__proto__":{"polluted":true},"ok":1}}');
  const r = validateSpec(raw, { knownFormats });
  assert.equal(r.valid, true);
  assert.equal(({}).polluted, undefined);
  assert.equal(r.spec.structure.ok, 1);
  assert.equal(Object.getPrototypeOf(r.spec), null);
});

test('caps oversized structure blobs', () => {
  // Single oversized string → truncated to STRUCTURE_STRING_MAX, spec stays valid.
  const truncated = validateSpec({
    format: 'md', title: 'x', files: [{ path: 'a.md' }],
    structure: { big: 'y'.repeat(300_000) },
  }, { knownFormats });
  assert.equal(truncated.valid, true);
  assert.ok(truncated.spec.structure.big.length <= 20_000);

  // Aggregate over the serialized cap (many maxed strings) → rejected.
  const huge = {};
  for (let i = 0; i < 15; i++) huge[`k${i}`] = 'y'.repeat(19_000);
  const rejected = validateSpec({
    format: 'md', title: 'x', files: [{ path: 'a.md' }],
    structure: huge,
  }, { knownFormats });
  assert.equal(rejected.valid, false);
});

// ── text exporter family ──────────────────────────────────────────────────────

test('registry: formats registered, extension resolution works', () => {
  assert.ok(knownFormats.includes('md'));
  assert.ok(knownFormats.includes('dockerfile'));
  assert.equal(resolveByExtension('.md').id, 'md');
  assert.equal(resolveByExtension('.yml').id, 'yaml');
});

test('text exporter build→validate→export round trip with stub generator', async () => {
  const md = getExporter('md');
  const spec = { format: 'md', title: 'T', files: [{ path: 'a.md' }, { path: 'docs/b.md' }] };
  const helpers = {
    generateFile: async ({ file }) => `# ${file.path}\ncontent`,
    mapConcurrent: (items, fn) => Promise.all(items.map(fn)),
  };
  const model = await md.build({ spec, ctx: {}, helpers });
  assert.equal(md.validate(model).valid, true);
  const { files } = md.export(model);
  assert.equal(files.length, 2);
  assert.ok(Buffer.isBuffer(files[0].buffer));
  assert.equal(files[0].mime, 'text/markdown');
  assert.equal(files[1].path, 'docs/b.md');

  const v = validateArtifactFiles(files, spec, md);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.totalBytes, files[0].buffer.length + files[1].buffer.length);
});

test('exporter validate rejects empty content', async () => {
  const md = getExporter('md');
  assert.equal(md.validate({ files: [{ path: 'a.md', text: '   ' }] }).valid, false);
  assert.equal(md.validate({ files: [] }).valid, false);
});

// ── global validator ──────────────────────────────────────────────────────────

test('validator: quotas, executables, mime consistency, utf8', () => {
  const md = getExporter('md');
  const spec = { format: 'md', title: 'x', files: [{ path: 'a.md' }] };

  const tooBig = validateArtifactFiles(
    [{ path: 'a.md', buffer: Buffer.alloc(QUOTAS.MAX_FILE_BYTES + 1), mime: 'text/markdown' }], spec, md);
  assert.equal(tooBig.valid, false);

  const exe = validateArtifactFiles(
    [{ path: 'x.exe', buffer: Buffer.from('MZ..'), mime: 'text/markdown' }], spec, md);
  assert.equal(exe.valid, false);

  const badMime = validateArtifactFiles(
    [{ path: 'a.md', buffer: Buffer.from('# hi'), mime: 'application/pdf' }], spec, md);
  assert.equal(badMime.valid, false);

  const badUtf8 = validateArtifactFiles(
    [{ path: 'a.md', buffer: Buffer.from([0xff, 0xfe, 0x00, 0xc0]), mime: 'text/markdown' }], spec, md);
  assert.equal(badUtf8.valid, false);

  const dupe = validateArtifactFiles(
    [{ path: 'a.md', buffer: Buffer.from('x'), mime: 'text/markdown' },
     { path: 'A.md', buffer: Buffer.from('y'), mime: 'text/markdown' }], spec, md);
  assert.equal(dupe.valid, false);
});

// ── packager ──────────────────────────────────────────────────────────────────

test('resolvePackaging: auto/raw/zip semantics', () => {
  assert.equal(resolvePackaging({ packaging: 'auto' }, 1), 'raw');
  assert.equal(resolvePackaging({ packaging: 'auto' }, 3), 'zip');
  assert.equal(resolvePackaging({ packaging: 'raw' }, 1), 'raw');
  assert.equal(resolvePackaging({ packaging: 'raw' }, 2), 'zip'); // raw impossible >1
  assert.equal(resolvePackaging({ packaging: 'zip' }, 1), 'zip');
});

test('buildZipBuffer: real zip, magic bytes, nested dirs round-trip', () => {
  const files = [
    { path: 'README.md',      buffer: Buffer.from('# hi') },
    { path: 'src/index.js',   buffer: Buffer.from('console.log(1)') },
    { path: 'src/lib/u.js',   buffer: Buffer.from('export {}') },
  ];
  const buf = buildZipBuffer(files, { rootDir: 'my-project' });
  // PK\x03\x04
  assert.deepEqual([...buf.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

  const zip = new AdmZip(buf);
  const names = zip.getEntries().map(e => e.entryName).sort();
  assert.deepEqual(names, ['my-project/README.md', 'my-project/src/index.js', 'my-project/src/lib/u.js']);
  assert.equal(zip.readAsText('my-project/src/index.js'), 'console.log(1)');
});

test('buildZipBuffer refuses hostile entry paths', () => {
  assert.throws(() => buildZipBuffer([{ path: '../x', buffer: Buffer.from('a') }]));
});
