/**
 * P3 — ustar writer, archive packaging, code project exporter.
 * The tar writer is verified against the SYSTEM `tar` binary (list +
 * extract + content compare) — an independent reader, same philosophy as
 * re-opening xlsx/docx/pptx with independent libs.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-artifact-p3-'));
process.env.AQUA_ARTIFACTS_DIR = path.join(TMP, 'store');

const store  = await import('../artifactStore.js');
const engine = await import('../engine.js');
const { getExporter } = await import('../exporters/registry.js');
const { metaForPath } = await import('../exporters/codeProjectExporter.js');
const { createTarBuffer, createTarGzBuffer } = await import('../tarWriter.js');
const { resolvePackaging, buildArchiveBuffer, ARCHIVE_META } = await import('../packager.js');
const { validateSpec } = await import('../specSchema.js');
const { listExporters } = await import('../exporters/registry.js');

before(() => store._resetForTests());
after(() => {
  store._resetForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const FILES = [
  { path: 'README.md',        buffer: Buffer.from('# proj\n') },
  { path: 'src/index.js',     buffer: Buffer.from('console.log("hi")\n') },
  { path: 'src/lib/util.js',  buffer: Buffer.from('x'.repeat(513)) },  // crosses a block boundary
  { path: 'tiny.txt',         buffer: Buffer.from('1') },              // 1-byte pad math
];

// ── tarWriter vs system tar ───────────────────────────────────────────────────

test('tar: system tar lists and extracts our archive byte-for-byte', () => {
  const buf = createTarBuffer(FILES, { rootDir: 'proj' });
  const tarPath = path.join(TMP, 'a.tar');
  fs.writeFileSync(tarPath, buf);

  const listing = execFileSync('tar', ['-tf', tarPath], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(listing, ['proj/README.md', 'proj/src/index.js', 'proj/src/lib/util.js', 'proj/tiny.txt']);

  const out = path.join(TMP, 'x1');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xf', tarPath, '-C', out]);
  for (const f of FILES) {
    assert.deepEqual(fs.readFileSync(path.join(out, 'proj', f.path)), f.buffer, f.path);
  }
});

test('tar.gz: gzip magic + system tar -tzf reads it', () => {
  const buf = createTarGzBuffer(FILES, { rootDir: 'proj' });
  assert.deepEqual([...buf.subarray(0, 2)], [0x1f, 0x8b]);
  const p = path.join(TMP, 'a.tar.gz');
  fs.writeFileSync(p, buf);
  const listing = execFileSync('tar', ['-tzf', p], { encoding: 'utf8' });
  assert.ok(listing.includes('proj/src/lib/util.js'));
});

test('tar: >100-char paths split into ustar prefix and survive extraction', () => {
  const deep = 'a-very/deeply/nested/directory/structure/that/goes/on/and/on/for/quite/a/while/longer/than/one/hundred/characters/file.txt';
  assert.ok(deep.length > 100 && deep.length < 255);
  const buf = createTarBuffer([{ path: deep, buffer: Buffer.from('deep') }], { rootDir: 'p' });
  const tp = path.join(TMP, 'deep.tar');
  fs.writeFileSync(tp, buf);
  const out = path.join(TMP, 'x2');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xf', tp, '-C', out]);
  assert.equal(fs.readFileSync(path.join(out, 'p', deep), 'utf8'), 'deep');
});

test('tar: hostile paths refused (long paths handled via GNU longnames since P6)', () => {
  // P3 threw on unsplittable long paths; P6 emits a GNU 'L' longname record
  // instead — the round-trip is proven in hardening.test.js. Path SAFETY is
  // unchanged and still enforced here.
  const noSlashName = 'x'.repeat(160);
  assert.doesNotThrow(() => createTarBuffer([{ path: noSlashName, buffer: Buffer.from('a') }]));
  assert.throws(() => createTarBuffer([{ path: '../evil', buffer: Buffer.from('a') }]));
  assert.throws(() => createTarBuffer([{ path: '/etc/passwd', buffer: Buffer.from('a') }]));
});

// ── Packaging semantics ───────────────────────────────────────────────────────

test('resolvePackaging honors tar variants; specSchema accepts them', () => {
  assert.equal(resolvePackaging({ packaging: 'tar' }, 3), 'tar');
  assert.equal(resolvePackaging({ packaging: 'tar.gz' }, 1), 'tar.gz');
  assert.equal(resolvePackaging({ packaging: 'auto' }, 3), 'zip');

  const r = validateSpec({
    format: 'project', title: 'P', packaging: 'tar.gz',
    files: [{ path: 'a.js' }, { path: 'b.js' }],
  }, { knownFormats: listExporters() });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.spec.packaging, 'tar.gz');
});

test('buildArchiveBuffer dispatches all three archive kinds', () => {
  assert.deepEqual([...buildArchiveBuffer('zip', FILES).subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(buildArchiveBuffer('tar', FILES).length % 512, 0);
  assert.deepEqual([...buildArchiveBuffer('tar.gz', FILES).subarray(0, 2)], [0x1f, 0x8b]);
  assert.throws(() => buildArchiveBuffer('rar', FILES));
});

// ── Project exporter ──────────────────────────────────────────────────────────

test('project: registered; per-path mimes and language hints resolve', () => {
  assert.ok(listExporters().includes('project'));
  assert.equal(metaForPath('src/app.js').mime, 'text/javascript');
  assert.equal(metaForPath('api/openapi.yaml').mime, 'application/yaml');
  assert.equal(metaForPath('Dockerfile').mime, 'text/plain');
  assert.match(metaForPath('Dockerfile').hint, /Dockerfile/);
  assert.match(metaForPath('.env.example').hint, /NEVER real secrets/);
  assert.equal(metaForPath('schema.prisma').mime, 'text/plain');
  assert.equal(metaForPath('unknown.xyz').mime, 'text/plain');
});

test('project: build→validate→export with stub generator; mimes vary per file', async () => {
  const p = getExporter('project');
  const spec = {
    format: 'project', title: 'API Starter', packaging: 'auto',
    files: [
      { path: 'package.json', description: 'manifest' },
      { path: 'src/index.js', description: 'entry' },
      { path: 'README.md',    description: 'docs' },
    ],
  };
  const helpers = {
    generateFile: async ({ file }) => file.path.endsWith('.json') ? '{"name":"api-starter"}' : `content of ${file.path}`,
    mapConcurrent: (items, fn) => Promise.all(items.map(fn)),
  };
  const model = await p.build({ spec, ctx: {}, helpers });
  assert.equal(p.validate(model).valid, true);
  const { files } = p.export(model);
  assert.equal(files.find(f => f.path === 'package.json').mime, 'application/json');
  assert.equal(files.find(f => f.path === 'src/index.js').mime, 'text/javascript');
  assert.equal(files.find(f => f.path === 'README.md').mime, 'text/markdown');
});

// ── Engine e2e: project turn → stored tree → archive download shape ───────────

const PROJECT_PLAN = {
  format: 'project', title: 'Todo API', packaging: 'tar.gz',
  files: [
    { path: 'package.json',   role: 'config',  description: 'npm manifest' },
    { path: 'src/index.js',   role: 'primary', description: 'express entry' },
    { path: 'src/routes.js',  role: 'source',  description: 'routes' },
    { path: 'README.md',      role: 'doc',     description: 'readme' },
  ],
};

test('engine e2e: project turn stores the tree with tar.gz packaging', async () => {
  const res = await engine.execute({
    userMessage: 'Build me a node backend, packaged as tar.gz',
    prep: {}, intent: { wants: true, format: 'project', confidence: 0.8 },
    ownerId: 'user:u1', conversationId: 'c-p3', requestId: 'req-p3',
    generate: async (_u, systemPrompt) => {
      if (systemPrompt.includes('Artifact Planner')) return { text: JSON.stringify(PROJECT_PLAN), provider: 'stub' };
      const m = systemPrompt.match(/ONE file: "([^"]+)"/);
      return { text: `// ${m?.[1]}\nmodule.exports = {}\n`, provider: 'stub-builder' };
    },
  });
  assert.equal(res.manifest.format, 'project');
  assert.equal(res.manifest.packaging, 'tar.gz');
  assert.equal(res.manifest.files.length, 4);
  assert.match(res.summaryText, /\.tar\.gz|Download/);

  // The stored sources + ARCHIVE_META are exactly what the download route
  // uses — assemble the same archive and prove the system tar reads it.
  const onDisk = await store.getArtifact(res.manifest.id);
  const files = onDisk.files.map(f => ({
    path: f.path,
    buffer: fs.readFileSync(store.getFileAbsolutePath(onDisk, f.path)),
  }));
  const archive = buildArchiveBuffer(onDisk.packaging, files, { rootDir: 'todo-api' });
  assert.equal(ARCHIVE_META[onDisk.packaging].mime, 'application/gzip');
  const ap = path.join(TMP, 'dl.tar.gz');
  fs.writeFileSync(ap, archive);
  const listing = execFileSync('tar', ['-tzf', ap], { encoding: 'utf8' });
  assert.ok(listing.includes('todo-api/src/index.js'));
});
