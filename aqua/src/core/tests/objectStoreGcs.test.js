/**
 * Phase 4B — the object-store backends against ONE contract, and artifacts
 * across instances on the GCS backend.
 *
 *   contract   pg (Postgres, real) · gcs over a local GCS emulator (fake-gcs-server,
 *              docker aqua-test-gcs) · gcs over an in-process fake transport that
 *              ENFORCES ifGenerationMatch (the emulator does not)
 *   gcs-only   write race (412) · interrupted upload recovery · metadata-server
 *              token (cached, sent as Bearer) · owner isolation on read and delete
 *   instances  two processes, each its own empty disk, artifacts on partitions,
 *              AQUA_OBJECT_STORE=gcs (emulator): created on one, streamed on the
 *              other without a local copy, new version on the other, deleted;
 *              a missing object is reported (ARTIFACT_OBJECT_MISSING), not served
 *
 * No real Google Cloud resource is used: the emulator runs locally, and the
 * fake never leaves the process.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const LIVE = Boolean(process.env.DATABASE_URL);
const EMULATOR = process.env.AQUA_TEST_GCS_ENDPOINT ?? 'http://127.0.0.1:54443';
const BUCKET = 'aqua-test-artifacts';
const RUN = Date.now().toString(36);
let emulatorUp = false;

/** An in-process GCS JSON API that enforces ifGenerationMatch=0, and can fail on demand. */
function fakeGcs() {
  const objects = new Map();      // name → { bytes, meta, generation }
  const state = { failNextUpload: false, raceOnNextUpload: null, tokenRequests: 0, authSeen: [] };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function transport(url, init = {}) {
    const u = new URL(url);
    if (u.hostname === 'metadata.google.internal') { state.tokenRequests++; return json(200, { access_token: `tok-${state.tokenRequests}`, expires_in: 3600 }); }
    state.authSeen.push(init.headers?.Authorization ?? null);
    const m = u.pathname.match(/\/storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/);
    if (u.pathname.startsWith('/upload/')) {
      if (state.failNextUpload) { state.failNextUpload = false; throw new TypeError('fetch failed (simulated connection reset mid-upload)'); }
      // multipart/related: part 1 = JSON metadata, part 2 = the bytes.
      const body = Buffer.from(init.body);
      const boundary = init.headers['Content-Type'].split('boundary=')[1];
      const sep = Buffer.from(`--${boundary}`, 'latin1');
      const p1 = body.indexOf(sep);
      const p2 = body.indexOf(sep, p1 + sep.length);
      const crlf2 = Buffer.from('\r\n\r\n', 'latin1');
      const metaStart = body.indexOf(crlf2, p1) + 4;
      const meta = JSON.parse(body.subarray(metaStart, p2 - 2).toString('utf8'));
      const start = body.indexOf(crlf2, p2) + 4;
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`, 'latin1'));
      const bytes = body.subarray(start, end);
      if (state.raceOnNextUpload) { const r = state.raceOnNextUpload; state.raceOnNextUpload = null; objects.set(meta.name, r(meta)); }
      if (u.searchParams.get('ifGenerationMatch') === '0' && objects.has(meta.name)) return json(412, { error: { code: 412 } });
      objects.set(meta.name, { bytes: Buffer.from(bytes), meta, generation: Date.now() });
      return json(200, { name: meta.name });
    }
    if (m && m[2] === undefined && (init.method ?? 'GET') === 'GET') {
      const prefix = u.searchParams.get('prefix') ?? '';
      return json(200, { items: [...objects].filter(([k]) => k.startsWith(prefix)).map(([name, o]) => ({ name, metadata: o.meta.metadata })) });
    }
    if (m) {
      const name = decodeURIComponent(m[2]);
      const o = objects.get(name);
      if ((init.method ?? 'GET') === 'DELETE') { objects.delete(name); return new Response(null, { status: o ? 204 : 404 }); }
      if (!o) return json(404, { error: { code: 404 } });
      if (u.searchParams.get('alt') === 'media') return new Response(o.bytes, { status: 200 });
      return json(200, { name, size: String(o.bytes.length), metadata: o.meta.metadata });
    }
    return json(400, {});
  }
  return { transport, objects, state };
}

async function contract(name, make) {
  const store = await make();
  const owner = `user:${name}-${RUN}`; const other = `user:${name}-other-${RUN}`;
  const key = `artifacts/c-${name}-${RUN}/v1/a.txt`;
  const bytes = Buffer.from(`hello ${name} ${RUN}`);
  const r1 = await store.put(key, bytes, { ownerId: owner });
  assert.equal(r1.created, true, `${name}: first put creates`);
  assert.equal((await store.put(key, bytes, { ownerId: owner })).created, false, `${name}: same bytes = idempotent retry`);
  await assert.rejects(store.put(key, Buffer.from('different'), { ownerId: owner }), /write-once/, `${name}: different bytes refused`);
  await assert.rejects(store.put(key, bytes, { ownerId: other }), /write-once/, `${name}: another owner refused`);
  assert.deepEqual(await store.get(key, { ownerId: owner }), bytes, `${name}: read back`);
  await assert.rejects(store.get(key, { ownerId: other }), /different owner/, `${name}: owner isolation on read`);
  assert.equal(await store.get(`artifacts/none-${RUN}/v1/x`, { ownerId: owner }), null, `${name}: missing = null`);
  const s = await store.getStream(key, { ownerId: owner });
  const chunks = []; for await (const c of s.stream) chunks.push(Buffer.from(c));
  assert.deepEqual(Buffer.concat(chunks), bytes, `${name}: stream`);
  // deletePrefix: exact prefix, owner's objects only.
  const otherKey = `artifacts/c-${name}-${RUN}/v1/b.txt`;
  await store.put(otherKey, Buffer.from('theirs'), { ownerId: other });
  const sibling = `artifacts/c-${name}-${RUN}x/v1/a.txt`;
  await store.put(sibling, Buffer.from('sibling'), { ownerId: owner });
  const n = await store.deletePrefix(owner, `artifacts/c-${name}-${RUN}/`);
  assert.equal(n, 1, `${name}: deleted the owner's one object under the exact prefix`);
  assert.equal(await store.get(key, { ownerId: owner }), null);
  assert.ok(await store.get(otherKey, { ownerId: other }), `${name}: another owner's object survived`);
  assert.ok(await store.get(sibling, { ownerId: owner }), `${name}: a longer prefix (…x/) survived`);
  await store.deletePrefix(other, `artifacts/c-${name}-${RUN}/`); await store.deletePrefix(owner, `artifacts/c-${name}-${RUN}x/`);
}

describe('Phase 4B — object store backends', { concurrency: false }, () => {
  let O;
  before(async () => {
    O = await import('../storage/objectStore.js');
    try {
      await fetch(`${EMULATOR}/storage/v1/b?project=test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: BUCKET }) });
      emulatorUp = (await fetch(`${EMULATOR}/storage/v1/b/${BUCKET}`)).ok;
    } catch { emulatorUp = false; }
  });
  after(async () => { if (LIVE) await (await import('../db/pool.js')).closePool(); });

  test('contract: pg backend (real Postgres)', { skip: LIVE ? false : 'needs DATABASE_URL' }, async () => {
    const { migrate } = await import('../db/migrate.js'); await migrate();
    await contract('pg', () => O.createPgObjectStore());
  });
  test('contract: gcs backend over the local GCS emulator', async t => {
    if (!emulatorUp) return t.skip(`no GCS emulator at ${EMULATOR} (docker aqua-test-gcs)`);
    await contract('gcsemu', () => O.createGcsObjectStore({ bucket: BUCKET, endpoint: EMULATOR }));
  });
  test('contract: gcs backend over an in-process fake that enforces preconditions', async () => {
    const f = fakeGcs();
    await contract('gcsfake', () => O.createGcsObjectStore({ bucket: BUCKET, endpoint: 'http://fake-gcs', transport: f.transport }));
  });

  test('gcs: two writers racing for one new key — same bytes is a retry, different bytes is refused (412 path)', async () => {
    const f = fakeGcs();
    const s = O.createGcsObjectStore({ bucket: BUCKET, endpoint: 'http://fake-gcs', transport: f.transport });
    const bytes = Buffer.from('race');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    f.state.raceOnNextUpload = meta => ({ bytes, meta: { ...meta, metadata: { owner: 'user:a', sha256: sha } }, generation: 1 });
    assert.equal((await s.put('k/race', bytes, { ownerId: 'user:a' })).created, false);
    f.state.raceOnNextUpload = meta => ({ bytes: Buffer.from('X'), meta: { ...meta, metadata: { owner: 'user:a', sha256: 'other' } }, generation: 1 });
    await assert.rejects(s.put('k/race2', bytes, { ownerId: 'user:a' }), /write-once/);
  });

  test('gcs: an upload interrupted mid-transfer is retried and lands once', async () => {
    const f = fakeGcs();
    const s = O.createGcsObjectStore({ bucket: BUCKET, endpoint: 'http://fake-gcs', transport: f.transport });
    f.state.failNextUpload = true;
    const r = await s.put('k/interrupted', Buffer.from('payload'), { ownerId: 'user:a' });
    assert.equal(r.created, true);
    assert.equal(f.objects.size, 1);
    assert.deepEqual(await s.get('k/interrupted', { ownerId: 'user:a' }), Buffer.from('payload'));
  });

  test('gcs: on Google endpoints the service account token comes from the metadata server, cached, sent as Bearer', async () => {
    const f = fakeGcs();
    const s = O.createGcsObjectStore({ bucket: BUCKET, transport: f.transport });   // default endpoint → metadata-server auth
    await s.put('k/auth', Buffer.from('a'), { ownerId: 'user:a' });
    await s.get('k/auth', { ownerId: 'user:a' });
    assert.equal(f.state.tokenRequests, 1, 'the token is cached');
    assert.ok(f.state.authSeen.every(h => h === 'Bearer tok-1'), JSON.stringify(f.state.authSeen));
  });

  test('gcs: AQUA_OBJECT_STORE=gcs without a bucket refuses (never a silent fallback)', () => {
    assert.throws(() => O.objectStoreFromEnv({ AQUA_OBJECT_STORE: 'gcs' }), /bucket/);
    assert.throws(() => O.objectStoreFromEnv({ AQUA_OBJECT_STORE: 's3' }), /not a known backend/);
  });
});

describe('Phase 4B — artifacts across instances on GCS (emulator + real Postgres)', { skip: LIVE ? false : 'needs DATABASE_URL', concurrency: false }, () => {
  let runProcess; let tempDir; let release;
  before(async () => {
    ({ runProcess, tempDir, acquireStoreKeyLock: release } = await import('./helpers/multiProcess.mjs'));
    release = await release();
  });
  after(async () => { await release?.(); });

  test('created on instance A, streamed on B (no local copy), edited on B, read on A, deleted', async t => {
    if (!emulatorUp) return t.skip('no GCS emulator');
    const env = { AQUA_OBJECT_STORE: 'gcs', AQUA_GCS_BUCKET: BUCKET, AQUA_GCS_ENDPOINT: EMULATOR };
    const P = 'artifacts:on';
    const O = `user:gcs-x-${RUN}`;
    const boot = { op: 'boot', stores: ['artifacts'] };
    const run = (dir, ops) => runProcess({ dataDir: dir, partitions: P, env }, [boot, { op: 'load', owner: O }, ...ops]);
    const dirA = tempDir('aq-gcsA-'); const dirB = tempDir('aq-gcsB-');
    const a = await run(dirA, [{ op: 'artifactCreate', owner: O, text: 'version one', title: 'X' }, { op: 'flush' }]);
    const id = a[2]?.id;
    assert.ok(id, JSON.stringify(a.slice(0, 3)).slice(0, 400) + a.stderr?.slice(-400));
    const b = await run(dirB, [{ op: 'artifactStream', id }, { op: 'artifactAppend', id, text: 'version two' }, { op: 'flush' }]);
    assert.deepEqual(b[2], { text: 'version one', localCopy: false }, 'B streamed from GCS without a local copy');
    assert.equal(b[3].version, 2);
    const a2 = await run(dirA, [{ op: 'artifactRead', id, version: 2 }, { op: 'artifactRead', id, version: 1 }]);
    assert.equal(a2[2].text, 'version two', 'A reads the version B wrote');
    assert.equal(a2[3].text, 'version one');
    // A missing object is reported as such, never served as something else.
    const list = await (await fetch(`${EMULATOR}/storage/v1/b/${BUCKET}/o?prefix=${encodeURIComponent(`artifacts/${id}/`)}`)).json();
    // Version directories are unique names (not v1/v2): find version 2's object by its bytes.
    let v2 = null;
    for (const i of list.items) {
      const txt = await (await fetch(`${EMULATOR}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(i.name)}?alt=media`)).text();
      if (txt === 'version two') v2 = i;
    }
    assert.ok(v2, 'version 2 object found in the bucket');
    await fetch(`${EMULATOR}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(v2.name)}`, { method: 'DELETE' });
    const c = await run(tempDir('aq-gcsC-'), [{ op: 'artifactStream', id, version: 2 }]);
    assert.equal(c[2].error, 'ARTIFACT_OBJECT_MISSING');
    // Delete on B removes the remaining objects.
    await run(dirB, [{ op: 'artifactDelete', id }, { op: 'flush' }]);
    const after = await (await fetch(`${EMULATOR}/storage/v1/b/${BUCKET}/o?prefix=${encodeURIComponent(`artifacts/${id}/`)}`)).json();
    assert.equal((after.items ?? []).length, 0, 'objects left after delete');
  });
});
