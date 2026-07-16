/**
 * Artifact store — disk layout, index persistence, owner scoping, quota
 * eviction, hostile path refusal. AQUA_ARTIFACTS_DIR is pointed at a temp
 * dir BEFORE the store module loads, so the real filesystem is untouched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-artifact-store-'));
process.env.AQUA_ARTIFACTS_DIR = TMP;

const store = await import('../artifactStore.js');

function mkFiles() {
  return [
    { path: 'README.md',    buffer: Buffer.from('# readme'),        mime: 'text/markdown' },
    { path: 'src/app.js',   buffer: Buffer.from('console.log(1)'),  mime: 'text/javascript' },
  ];
}

const baseInput = (over = {}) => ({
  ownerId: 'user:u1', conversationId: 'c1', workspaceId: null,
  requestId: 'req-1', format: 'md', title: 'Test Artifact',
  spec: { format: 'md', title: 'Test Artifact', files: [{ path: 'README.md' }, { path: 'src/app.js' }], packaging: 'auto' },
  packaging: 'zip', files: mkFiles(),
  ...over,
});

before(() => store._resetForTests());
after(() => {
  store._resetForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('createArtifact writes v1 tree + manifest, returns full manifest', async () => {
  const m = await store.createArtifact(baseInput());
  assert.ok(m.id);
  assert.equal(m.version, 1);
  assert.equal(m.files.length, 2);
  assert.ok(m.files[0].sha256.length === 64);
  assert.equal(m.totalBytes, Buffer.from('# readme').length + Buffer.from('console.log(1)').length);

  // Disk layout
  assert.ok(fs.existsSync(path.join(TMP, m.id, 'v1', 'README.md')));
  assert.ok(fs.existsSync(path.join(TMP, m.id, 'v1', 'src', 'app.js')));
  assert.ok(fs.existsSync(path.join(TMP, m.id, 'manifest.json')));

  // Reads
  assert.equal(store.getArtifactLite(m.id).title, 'Test Artifact');
  const full = await store.getArtifact(m.id);
  assert.equal(full.spec.format, 'md');
});

test('getFileAbsolutePath guards version, listing, and containment', async () => {
  const m = await store.createArtifact(baseInput({ requestId: 'req-2' }));
  const abs = store.getFileAbsolutePath(m, 'src/app.js');
  assert.equal(fs.readFileSync(abs, 'utf8'), 'console.log(1)');

  assert.throws(() => store.getFileAbsolutePath(m, 'not-listed.md'));
  assert.throws(() => store.getFileAbsolutePath(m, '../escape.md'));
  assert.throws(() => store.getFileAbsolutePath(m, 'README.md', 99));
});

test('listArtifacts scopes by owner + conversation, newest first', async () => {
  store._resetForTests();
  const a = await store.createArtifact(baseInput({ ownerId: 'user:alice', conversationId: 'ca', requestId: 'r-a' }));
  await new Promise(r => setTimeout(r, 5));
  const b = await store.createArtifact(baseInput({ ownerId: 'user:bob',   conversationId: 'cb', requestId: 'r-b' }));

  assert.deepEqual(store.listArtifacts({ ownerId: 'user:alice' }).map(e => e.id), [a.id]);
  assert.deepEqual(store.listArtifacts({ conversationId: 'cb' }).map(e => e.id), [b.id]);
  const all = store.listArtifacts();
  assert.equal(all[0].id, b.id, 'newest first');
});

test('rename + delete update index and disk', async () => {
  const m = await store.createArtifact(baseInput({ requestId: 'req-3' }));
  await store.renameArtifact(m.id, 'Renamed');
  assert.equal(store.getArtifactLite(m.id).title, 'Renamed');
  assert.equal((await store.getArtifact(m.id)).title, 'Renamed');

  assert.equal(await store.deleteArtifact(m.id), true);
  assert.equal(store.getArtifactLite(m.id), null);
  assert.ok(!fs.existsSync(path.join(TMP, m.id)));
});

test('index survives a reload (flush → re-read)', async () => {
  store._resetForTests();
  const m = await store.createArtifact(baseInput({ requestId: 'req-4' }));
  store._flushIndexForTests();
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, '.index.json'), 'utf8'));
  assert.ok(raw[m.id]);
  assert.equal(raw[m.id].title, 'Test Artifact');
});

test('owner quota evicts oldest, never the just-created artifact', async () => {
  store._resetForTests();
  // Three artifacts at ~200MB each against the 500MB cap → creating the
  // third must evict the first. Buffers are sparse-allocated zeros; only
  // totalBytes accounting matters (writes are real but the FS handles it).
  const big = () => [{ path: 'big.bin.txt', buffer: Buffer.alloc(200 * 1024 * 1024, 0x61), mime: 'text/plain' }];
  const one   = await store.createArtifact(baseInput({ requestId: 'q1', files: big(), title: 'one' }));
  await new Promise(r => setTimeout(r, 5));
  const two   = await store.createArtifact(baseInput({ requestId: 'q2', files: big(), title: 'two' }));
  await new Promise(r => setTimeout(r, 5));
  const three = await store.createArtifact(baseInput({ requestId: 'q3', files: big(), title: 'three' }));

  const ids = store.listArtifacts({ ownerId: 'user:u1' }).map(e => e.id);
  assert.ok(!ids.includes(one.id), 'oldest evicted');
  assert.ok(ids.includes(two.id));
  assert.ok(ids.includes(three.id), 'new artifact survives');
});

test('hostile file path at create is refused and leaves no directory', async () => {
  store._resetForTests();
  const before = new Set(fs.readdirSync(TMP));
  await assert.rejects(() => store.createArtifact(baseInput({
    requestId: 'req-h',
    files: [{ path: '../../evil.txt', buffer: Buffer.from('x'), mime: 'text/plain' }],
  })));
  // The failed create must not leave a new artifact directory behind.
  const added = fs.readdirSync(TMP).filter(n => !before.has(n));
  assert.deepEqual(added, []);
});
