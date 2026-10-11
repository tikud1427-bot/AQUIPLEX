/**
 * artifacts.js — envelope migration, pinned by CHARACTERISATION.
 *
 * Statuses, `error` texts and success bodies were recorded from the route
 * BEFORE it was migrated to ok()/fail(). The migration may add `code` to the
 * failures that did not have one, and nothing else may move. Two endpoints
 * (edit, regenerate) ALREADY returned a `code` — a DOMAIN code such as
 * ARTIFACT_NOT_FOUND — and that value is kept verbatim (see the last block);
 * `__CODE(r, c)` marks an assertion on the taxonomy code, neutralised in the
 * pre-migration run of this file, which is how the old behaviour was proven.
 *
 * Binary responses (/download, /file) are pinned by their headers and bytes.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-artifacts-routes-'));
process.env.AQUA_ARTIFACTS_DIR = TMP;
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-artifacts-data-'));

const store = await import('../../artifacts/artifactStore.js');
const { ownerForUser } = await import('../../memory/ownerResolver.js');
const { default: route } = await import('../artifacts.js');
const { ErrorCodes } = await import('../envelope.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { const u = req.headers['x-test-user']; if (u) req.aquaUserId = String(u); next(); });
app.use('/artifacts', route);

let server, base;
before(() => { store._resetForTests(); server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); store._resetForTests(); fs.rmSync(TMP, { recursive: true, force: true }); });

const call = async (method, p, { user, body, raw } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
};
const __CODE = (r, code) => assert.equal(r.json.code, code, `code on ${JSON.stringify(r.json)}`);

const U = `u-art-${Math.random().toString(36).slice(2, 8)}`;
const OTHER = `u-art-other-${Math.random().toString(36).slice(2, 8)}`;
const mk = (userId, over = {}) => store.createArtifact({
  ownerId: ownerForUser(userId), conversationId: 'c1', workspaceId: null, requestId: `r-${Math.random()}`,
  format: 'md', title: 'Doc', packaging: 'zip',
  spec: { format: 'md', title: 'Doc', files: [{ path: 'README.md' }, { path: 'notes.bin' }], packaging: 'auto' },
  files: [
    { path: 'README.md', buffer: Buffer.from('# hello'), mime: 'text/markdown' },
    { path: 'notes.bin', buffer: Buffer.from([1, 2, 3, 4]), mime: 'application/octet-stream' },
  ],
  ...over,
});

let mine, theirs;
before(async () => { mine = await mk(U); theirs = await mk(OTHER); });

describe('ownership: another user\'s artifact is a uniform 404, never 403', () => {
  const NF = 'Artifact not found';
  for (const [m, suffix, body] of [
    ['GET', ''], ['GET', '/download'], ['GET', '/file?path=README.md'], ['GET', '/preview?path=README.md'],
    ['POST', '/edit', { instruction: 'x' }], ['POST', '/regenerate', {}], ['PATCH', '', { title: 'x' }], ['DELETE', ''],
  ]) {
    test(`${m} /:id${suffix}`, async () => {
      const r = await call(m, `/artifacts/${theirs.id}${suffix}`, { user: U, body });
      assert.equal(r.status, 404, JSON.stringify(r.json));
      assert.equal(r.json.success, false); assert.equal(r.json.error, NF);
      __CODE(r, ErrorCodes.NOT_FOUND);
    });
  }
  test('an unknown id is the same 404', async () => {
    const r = await call('GET', '/artifacts/does-not-exist', { user: U });
    assert.equal(r.status, 404); assert.equal(r.json.error, NF); __CODE(r, ErrorCodes.NOT_FOUND);
  });
  test('POSITIVE CONTROL: the owner is let through (so the 404s above prove ownership, not a broken fixture)', async () => {
    const r = await call('GET', `/artifacts/${mine.id}`, { user: U });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.success, true); assert.equal(r.json.artifact.id, mine.id);
    assert.ok('spec' in r.json.artifact && 'summary' in r.json.artifact);
  });
});

describe('list', () => {
  test('returns only the caller\'s artifacts, each with a downloadUrl', async () => {
    const r = await call('GET', '/artifacts', { user: U });
    assert.equal(r.status, 200); assert.equal(r.json.success, true);
    assert.ok(r.json.artifacts.some(a => a.id === mine.id));
    assert.ok(!r.json.artifacts.some(a => a.id === theirs.id), 'another user\'s artifact leaked into the list');
    for (const a of r.json.artifacts) assert.equal(a.downloadUrl, `/artifacts/${a.id}/download`);
  });
});

describe('validation failures', () => {
  test('file/preview without ?path → 400', async () => {
    for (const s of ['file', 'preview']) {
      const r = await call('GET', `/artifacts/${mine.id}/${s}`, { user: U });
      assert.equal(r.status, 400); assert.equal(r.json.error, 'Query param "path" is required'); __CODE(r, ErrorCodes.BAD_REQUEST);
    }
  });
  test('edit: missing and over-long instruction → 400 with their own messages', async () => {
    const a = await call('POST', `/artifacts/${mine.id}/edit`, { user: U, body: { instruction: '  ' } });
    assert.equal(a.status, 400); assert.equal(a.json.error, 'Body field "instruction" is required'); __CODE(a, ErrorCodes.BAD_REQUEST);
    const b = await call('POST', `/artifacts/${mine.id}/edit`, { user: U, body: { instruction: 'x'.repeat(4001) } });
    assert.equal(b.status, 400); assert.equal(b.json.error, '"instruction" exceeds 4000 chars'); __CODE(b, ErrorCodes.BAD_REQUEST);
  });
  test('rename without a title → 400', async () => {
    const r = await call('PATCH', `/artifacts/${mine.id}`, { user: U, body: { title: '' } });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'Body field "title" is required'); __CODE(r, ErrorCodes.BAD_REQUEST);
  });
  test('preview of a path that is not in the artifact is previewable:false (200), not a 404', async () => {
    const r = await call('GET', `/artifacts/${mine.id}/preview?path=nope.txt`, { user: U });
    assert.equal(r.status, 200, 'an unknown path previews as previewable:false, not 404');
    assert.deepEqual([r.json.success, r.json.previewable], [true, false]);
  });
});

describe('preview', () => {
  test('a text file previews with its content and metadata', async () => {
    const r = await call('GET', `/artifacts/${mine.id}/preview?path=README.md`, { user: U });
    assert.equal(r.status, 200); assert.equal(r.json.success, true); assert.equal(r.json.previewable, true);
    assert.equal(r.json.text, '# hello'); assert.equal(r.json.truncated, false);
    assert.equal(r.json.path, 'README.md'); assert.equal(r.json.mime, 'text/markdown');
  });
  test('a binary file is previewable:false', async () => {
    const r = await call('GET', `/artifacts/${mine.id}/preview?path=notes.bin`, { user: U });
    assert.equal(r.status, 200); assert.deepEqual([r.json.success, r.json.previewable], [true, false]);
  });
});

describe('binary responses are untouched', () => {
  test('/file streams the exact bytes with nosniff and an attachment disposition', async () => {
    const r = await call('GET', `/artifacts/${mine.id}/file?path=notes.bin`, { user: U, raw: true });
    assert.equal(r.status, 200);
    assert.deepEqual([...r.buf], [1, 2, 3, 4]);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-disposition'), /^attachment/);
  });
  test('/download of a multi-file artifact is an archive with nosniff', async () => {
    const r = await call('GET', `/artifacts/${mine.id}/download`, { user: U, raw: true });
    assert.equal(r.status, 200);
    assert.ok(r.buf.length > 0);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-disposition'), /^attachment/);
  });
});

describe('rename and delete', () => {
  test('rename returns the updated manifest', async () => {
    const a = await mk(U);
    const r = await call('PATCH', `/artifacts/${a.id}`, { user: U, body: { title: 'Renamed' } });
    assert.equal(r.status, 200); assert.equal(r.json.success, true); assert.equal(r.json.artifact.title, 'Renamed');
  });
  test('delete answers {success:true}, and the artifact is then a 404', async () => {
    const a = await mk(U);
    const d = await call('DELETE', `/artifacts/${a.id}`, { user: U });
    assert.equal(d.status, 200); assert.deepEqual(d.json, { success: true });
    assert.equal((await call('GET', `/artifacts/${a.id}`, { user: U })).status, 404);
  });
});

// ── Domain codes survive ─────────────────────────────────────────────────────
// edit and regenerate answered failures with a DOMAIN code (ARTIFACT_NOT_FOUND,
// ARTIFACT_EDIT_FAILED, ARTIFACT_REGEN_FAILED, or whatever the engine's
// ArtifactError carried) in the field every other route uses for the taxonomy.
// The migration keeps those values exactly — replacing them would silently
// change a field external /v1 clients may read — and takes only the STATUS from
// the taxonomy (404 / 422, the same numbers as before). Reconciling the two
// vocabularies is a decision for the API owner; it is pinned here so it cannot
// happen by accident.
describe('edit / regenerate keep their domain error codes', () => {
  test('regenerate of a path outside the artifact → 404 with code ARTIFACT_NOT_FOUND', async () => {
    const r = await call('POST', `/artifacts/${mine.id}/regenerate`, { user: U, body: { path: 'ghost.txt' } });
    assert.equal(r.status, 404, JSON.stringify(r.json));
    assert.equal(r.json.success, false);
    assert.equal(r.json.code, 'ARTIFACT_NOT_FOUND', 'the domain code was replaced by a taxonomy code');
    assert.equal(r.json.error, 'File "ghost.txt" is not part of this artifact');
  });
});

describe('structure', () => {
  const src = fs.readFileSync(new URL('../artifacts.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  test('no raw JSON response point is left; binary responses still set their own headers', () => {
    assert.doesNotMatch(src, /\.json\(/);
    assert.doesNotMatch(src, /res\.status\(/);
    assert.match(src, /res\.setHeader\('X-Content-Type-Options', 'nosniff'\)/);
  });
  // These fire only on a stream/engine error that a black-box test cannot cause
  // without sabotaging the filesystem or the model providers, so they are pinned
  // from the source and declared as such.
  test('stream failures keep their answers: a failed download is 500 "Download failed"; a failed /file read is the uniform 404', () => {
    assert.match(src, /if \(!res\.headersSent\) fail\(res, ErrorCodes\.INTERNAL, 'Download failed'\)/);
    assert.match(src, /\.on\('error', \(\) => \{ if \(!res\.headersSent\) notFound\(res\); \}\)/);
  });
  test('edit and regenerate both map ARTIFACT_NOT_FOUND to 404 and anything else to 422, and default their domain code', () => {
    assert.equal((src.match(/err\.code === 'ARTIFACT_NOT_FOUND' \? ErrorCodes\.NOT_FOUND : ErrorCodes\.UNPROCESSABLE/g) ?? []).length, 2);
    assert.match(src, /code: err\.code \?\? 'ARTIFACT_EDIT_FAILED'/);
    assert.match(src, /code: err\.code \?\? 'ARTIFACT_REGEN_FAILED'/);
  });
  test('the generic failure paths of edit/regenerate (no engine code) map to 422 unprocessable', () => {
    assert.match(src, /ARTIFACT_EDIT_FAILED/);
    assert.match(src, /ARTIFACT_REGEN_FAILED/);
    assert.equal((src.match(/ErrorCodes\.UNPROCESSABLE/g) ?? []).length, 2);
  });
});
