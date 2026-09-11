/**
 * Artifact routes — object-level authorization (IDOR) + download semantics.
 * Same harness as authScoping.test.js: real router in-process, header-driven
 * req.aquaUserId, node:test runner. Store isolated to a temp dir via
 * AQUA_ARTIFACTS_DIR set before the module graph loads.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import AdmZip from 'adm-zip';
import { gunzipSync } from 'zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-artifact-routes-'));
process.env.AQUA_ARTIFACTS_DIR = TMP;

const store = await import('../../artifacts/artifactStore.js');
const { default: artifactsRoute } = await import('../artifacts.js');

// Simulate the platform mount: x-test-user header → req.aquaUserId.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers['x-test-user'];
  if (u) req.aquaUserId = String(u);
  next();
});
app.use('/artifacts', artifactsRoute);

let server, base;

const req = async (method, p, { user, body, raw = false } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return res;
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
};

let aliceSingle, aliceMulti, aliceTar, bobArt;

before(async () => {
  store._resetForTests();
  server = app.listen(0);
  base   = `http://127.0.0.1:${server.address().port}`;

  aliceSingle = await store.createArtifact({
    ownerId: 'user:alice', conversationId: 'ca', requestId: 'r1',
    format: 'md', title: 'Alice Notes', packaging: 'raw',
    spec: { format: 'md', title: 'Alice Notes', files: [{ path: 'notes.md' }], packaging: 'raw' },
    files: [{ path: 'notes.md', buffer: Buffer.from('# alice notes'), mime: 'text/markdown' }],
  });
  aliceMulti = await store.createArtifact({
    ownerId: 'user:alice', conversationId: 'ca', requestId: 'r2',
    format: 'md', title: 'Alice Docs', packaging: 'zip',
    spec: { format: 'md', title: 'Alice Docs', files: [{ path: 'a.md' }, { path: 'sub/b.md' }], packaging: 'zip' },
    files: [
      { path: 'a.md',     buffer: Buffer.from('# a'), mime: 'text/markdown' },
      { path: 'sub/b.md', buffer: Buffer.from('# b'), mime: 'text/markdown' },
    ],
  });
  aliceTar = await store.createArtifact({
    ownerId: 'user:alice', conversationId: 'ca', requestId: 'r2t',
    format: 'project', title: 'Alice Project', packaging: 'tar.gz',
    spec: { format: 'project', title: 'Alice Project', files: [{ path: 'a.js' }, { path: 'lib/b.js' }], packaging: 'tar.gz' },
    files: [
      { path: 'a.js',     buffer: Buffer.from('let a=1'), mime: 'text/javascript' },
      { path: 'lib/b.js', buffer: Buffer.from('let b=2'), mime: 'text/javascript' },
    ],
  });
  bobArt = await store.createArtifact({
    ownerId: 'user:bob', conversationId: 'cb', requestId: 'r3',
    format: 'md', title: 'Bob Secret', packaging: 'raw',
    spec: { format: 'md', title: 'Bob Secret', files: [{ path: 's.md' }], packaging: 'raw' },
    files: [{ path: 's.md', buffer: Buffer.from('# bob'), mime: 'text/markdown' }],
  });
});

after(() => {
  server?.close();
  store._resetForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── List scoping ──────────────────────────────────────────────────────────────

test('list: each user sees only their own artifacts', async () => {
  const a = await req('GET', '/artifacts', { user: 'alice' });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.artifacts.map(e => e.id).sort(), [aliceSingle.id, aliceMulti.id, aliceTar.id].sort());

  const b = await req('GET', '/artifacts', { user: 'bob' });
  assert.deepEqual(b.body.artifacts.map(e => e.id), [bobArt.id]);
});

test('list: conversation filter applies within the owner scope', async () => {
  const a = await req('GET', '/artifacts?conversationId=ca', { user: 'alice' });
  assert.equal(a.body.artifacts.length, 3);
  const cross = await req('GET', '/artifacts?conversationId=cb', { user: 'alice' });
  assert.equal(cross.body.artifacts.length, 0, 'filtering to another user\'s conversation exposes nothing');
});

// ── IDOR — 404-uniform on every object route ──────────────────────────────────

test("IDOR: bob cannot read/download/rename/delete alice's artifact — uniform 404", async () => {
  for (const p of [
    `/artifacts/${aliceSingle.id}`,
    `/artifacts/${aliceSingle.id}/download`,
    `/artifacts/${aliceSingle.id}/file?path=notes.md`,
    `/artifacts/${aliceSingle.id}/preview?path=notes.md`,
  ]) {
    const r = await req('GET', p, { user: 'bob' });
    assert.equal(r.status, 404, p);
  }
  assert.equal((await req('PATCH',  `/artifacts/${aliceSingle.id}`, { user: 'bob', body: { title: 'pwn' } })).status, 404);
  assert.equal((await req('DELETE', `/artifacts/${aliceSingle.id}`, { user: 'bob' })).status, 404);
  // Unknown id looks identical to a foreign id — no existence oracle.
  assert.equal((await req('GET', '/artifacts/does-not-exist', { user: 'bob' })).status, 404);
  // Nothing changed.
  assert.equal(store.getArtifactLite(aliceSingle.id).title, 'Alice Notes');
});

// ── Download semantics ────────────────────────────────────────────────────────

test('download: single-file artifact streams raw with attachment headers', async () => {
  const res = await req('GET', `/artifacts/${aliceSingle.id}/download`, { user: 'alice', raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/markdown/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.match(res.headers.get('content-disposition'), /notes\.md/);
  assert.equal(await res.text(), '# alice notes');
});

test('download: multi-file artifact arrives as a real zip', async () => {
  const res = await req('GET', `/artifacts/${aliceMulti.id}/download`, { user: 'alice', raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const zip = new AdmZip(buf);
  const names = zip.getEntries().map(e => e.entryName).sort();
  assert.deepEqual(names, ['Alice-Docs/a.md', 'Alice-Docs/sub/b.md']);
});

test('file route: serves one file; hostile/unlisted paths are 404', async () => {
  const ok = await req('GET', `/artifacts/${aliceMulti.id}/file?path=${encodeURIComponent('sub/b.md')}`, { user: 'alice', raw: true });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '# b');

  assert.equal((await req('GET', `/artifacts/${aliceMulti.id}/file?path=${encodeURIComponent('../escape.md')}`, { user: 'alice' })).status, 404);
  assert.equal((await req('GET', `/artifacts/${aliceMulti.id}/file?path=nope.md`, { user: 'alice' })).status, 404);
  assert.equal((await req('GET', `/artifacts/${aliceMulti.id}/file`, { user: 'alice' })).status, 400);
});

test('download: tar.gz-packaged artifact arrives as a gzipped ustar (P3)', async () => {
  const res = await req('GET', `/artifacts/${aliceTar.id}/download`, { user: 'alice', raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('content-disposition'), /Alice-Project-v1\.tar\.gz/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 2)], [0x1f, 0x8b]); // gzip magic
  const tar = gunzipSync(buf);
  assert.equal(tar.subarray(257, 262).toString('ascii'), 'ustar'); // ustar magic in first header
  assert.ok(tar.includes(Buffer.from('lib/b.js')), 'nested path present in archive');
});

test('P5 edit/regenerate: IDOR 404 + validation 400 (no LLM spend on either)', async () => {
  assert.equal((await req('POST', `/artifacts/${aliceSingle.id}/edit`, { user: 'bob', body: { instruction: 'x' } })).status, 404);
  assert.equal((await req('POST', `/artifacts/${aliceSingle.id}/regenerate`, { user: 'bob' })).status, 404);
  assert.equal((await req('POST', `/artifacts/${aliceSingle.id}/edit`, { user: 'alice', body: {} })).status, 400);
  assert.equal((await req('POST', '/artifacts/nope/edit', { user: 'alice', body: { instruction: 'x' } })).status, 404);
});

test('preview: bounded text preview for text mimes', async () => {
  const r = await req('GET', `/artifacts/${aliceSingle.id}/preview?path=notes.md`, { user: 'alice' });
  assert.equal(r.status, 200);
  assert.equal(r.body.previewable, true);
  assert.equal(r.body.text, '# alice notes');
  assert.equal(r.body.truncated, false);
});

test('P6: preview reaches an old version with that version\'s content', async () => {
  // Append a v2 so the artifact has history, then prove ?version= parity
  // across preview/file/download.
  await store.appendVersion(aliceMulti.id, {
    files: [
      { path: 'a.md',     buffer: Buffer.from('# a v2'), mime: 'text/markdown' },
      { path: 'sub/b.md', buffer: Buffer.from('# b v2'), mime: 'text/markdown' },
    ],
    reason: 'test edit',
  });

  const latest = await req('GET', `/artifacts/${aliceMulti.id}/preview?path=a.md`, { user: 'alice' });
  assert.equal(latest.body.text, '# a v2');
  assert.equal(latest.body.version, 2);

  const old = await req('GET', `/artifacts/${aliceMulti.id}/preview?path=a.md&version=1`, { user: 'alice' });
  assert.equal(old.body.text, '# a', 'v1 content still served');
  assert.equal(old.body.version, 1);

  const oldFile = await req('GET', `/artifacts/${aliceMulti.id}/file?path=a.md&version=1`, { user: 'alice', raw: true });
  assert.equal(await oldFile.text(), '# a');
});

test('rename + delete work for the owner', async () => {
  const r = await req('PATCH', `/artifacts/${aliceSingle.id}`, { user: 'alice', body: { title: 'Renamed Notes' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.artifact.title, 'Renamed Notes');

  const d = await req('DELETE', `/artifacts/${aliceSingle.id}`, { user: 'alice' });
  assert.equal(d.status, 200);
  assert.equal((await req('GET', `/artifacts/${aliceSingle.id}`, { user: 'alice' })).status, 404);
});

test('dev/standalone mode (no session) is unscoped — same as every other route', async () => {
  const r = await req('GET', '/artifacts');
  assert.equal(r.status, 200);
  assert.ok(r.body.artifacts.length >= 2); // aliceMulti + bob remain
});
