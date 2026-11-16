/**
 * Phase 4B — migrating EXISTING (classic, local-disk) artifacts to the shared
 * object store + partition rows, end to end, then reading them from another
 * instance with an empty disk. Real Postgres; GCS = the local emulator.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.resolve(HERE, '..', '..', '..');
const CLI = path.join(AQUA, 'scripts', 'artifact-migration.mjs');
const EMULATOR = process.env.AQUA_TEST_GCS_ENDPOINT ?? 'http://127.0.0.1:54443';
const BUCKET = 'aqua-test-artifacts';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-artmig-'));
process.env.AQUA_ARTIFACTS_DIR = ROOT;
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-artmig-data-'));
process.env.AQUA_STORE_PARTITIONS = '';      // the classic layout production has today
const RUN = Date.now().toString(36);
const OWNER = `user:artmig-${RUN}`;
const LIVE = Boolean(process.env.DATABASE_URL);
let emulatorUp = false;
const ids = {};

const cli = (...args) => {
  try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: AQUA, env: { ...process.env, DATABASE_URL: '' } }).toString()) }; }
  catch (e) { return { code: e.status, out: (() => { try { return JSON.parse(String(e.stdout)); } catch { return { raw: String(e.stdout) + String(e.stderr) }; } })() }; }
};
const gcsArgs = ['--store', 'gcs', '--gcs-bucket', BUCKET, '--gcs-endpoint', EMULATOR];

describe('Phase 4B — artifact migration (classic → object store + rows)', { skip: LIVE ? false : 'needs DATABASE_URL', concurrency: false }, () => {
  before(async () => {
    try {
      await fetch(`${EMULATOR}/storage/v1/b?project=test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: BUCKET }) });
      emulatorUp = (await fetch(`${EMULATOR}/storage/v1/b/${BUCKET}`)).ok;
    } catch { emulatorUp = false; }
    const S = await import('../artifactStore.js');
    const file = (p, s) => ({ path: p, buffer: Buffer.from(s), mime: 'text/plain' });
    ids.one = (await S.createArtifact({ ownerId: OWNER, conversationId: 'c', requestId: 'r', format: 'txt', title: 'one', spec: {}, packaging: 'raw', files: [file('a.txt', 'classic v1')] })).id;
    await S.appendVersion(ids.one, { files: [file('a.txt', 'classic v2')], reason: 'edit' });
    ids.damaged = (await S.createArtifact({ ownerId: OWNER, conversationId: 'c', requestId: 'r', format: 'txt', title: 'dmg', spec: {}, packaging: 'raw', files: [file('a.txt', 'will be lost')] })).id;
    ids.ownerless = (await S.createArtifact({ ownerId: null, conversationId: 'c', requestId: 'r', format: 'txt', title: 'no owner', spec: {}, packaging: 'raw', files: [file('a.txt', 'nobody')] })).id;
    S._flushIndexForTests?.();
    await new Promise(r => setTimeout(r, 800));
    fs.rmSync(path.join(ROOT, ids.damaged, 'v1', 'a.txt'));
  });
  after(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    await (await import('../../core/db/pool.js')).closePool().catch(() => {});
  });

  test('plan → upload (idempotent) → rows → verify → export; damaged and ownerless are reported, not migrated', async t => {
    if (!emulatorUp) return t.skip(`no GCS emulator at ${EMULATOR}`);
    const plan = cli('plan', '--root', ROOT);
    assert.equal(plan.code, 1, 'a damaged root is reported unclean');
    assert.equal(plan.out.audit.integrity.missingFiles, 1);
    const up = cli('upload', '--root', ROOT, '--db', process.env.DATABASE_URL, ...gcsArgs);
    assert.equal(up.code, 0, JSON.stringify(up.out).slice(0, 500));
    assert.equal(up.out.upload.uploaded, 2, 'v1 and v2 of the healthy artifact');
    assert.equal(up.out.upload.skippedNoOwner, 1);
    const again = cli('upload', '--root', ROOT, '--db', process.env.DATABASE_URL, ...gcsArgs);
    assert.deepEqual([again.out.upload.uploaded, again.out.upload.alreadyPresent], [0, 2], 'a re-run (after an interruption) uploads nothing twice');
    const dry = cli('rows', '--root', ROOT, '--db', process.env.DATABASE_URL);
    assert.equal(dry.out.rows.inserted, 0, 'rows: dry run by default');
    const rows = cli('rows', '--root', ROOT, '--db', process.env.DATABASE_URL, '--apply');
    assert.equal(rows.code, 0, JSON.stringify(rows.out).slice(0, 500));
    // Two owned artifacts → two `a:` rows (the damaged one too: its row is honest, its object
    // missing), plus the store's one "rest" row every migrated store gets.
    assert.ok(rows.out.rows.inserted >= 2, `inserted ${rows.out.rows.inserted}`);   // the rest row exists after a first run
    const { getPool } = await import('../../core/db/pool.js');
    const r = await (await getPool()).query(`SELECT partition_key, owner_id FROM aqua_store_partitions WHERE store_key = '.aqua-artifacts.json' AND partition_key = ANY($1)`,
      [[`a:${ids.one}`, `a:${ids.damaged}`, `a:${ids.ownerless}`]]);
    assert.deepEqual(r.rows.map(x => x.partition_key).sort(), [`a:${ids.damaged}`, `a:${ids.one}`].sort());
    assert.ok(r.rows.every(x => x.owner_id === OWNER), 'rows are owned by the artifact owner');
    assert.deepEqual(rows.out.skipped.map(s => s.reason), ['no-owner']);
    const v = cli('verify', '--root', ROOT, '--db', process.env.DATABASE_URL, ...gcsArgs);
    assert.equal(v.out.objects.missing, 0);
    assert.equal(v.out.rows.missing, 0);
    const out = path.join(os.tmpdir(), `artmig-rollback-${RUN}.json`);
    const ex = cli('export', '--db', process.env.DATABASE_URL, '--out', out, '--force');
    assert.equal(ex.code, 0);
    const exported = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(exported[ids.one]?.manifest, 'the rollback export carries the index entry and manifest');
  });

  test('another instance with an EMPTY disk reads the migrated classic artifact (both versions) through GCS', async t => {
    if (!emulatorUp) return t.skip('no GCS emulator');
    const { runProcess, tempDir } = await import('../../core/tests/helpers/multiProcess.mjs');
    const env = { AQUA_OBJECT_STORE: 'gcs', AQUA_GCS_BUCKET: BUCKET, AQUA_GCS_ENDPOINT: EMULATOR, AQUA_ARTIFACTS_DIR: tempDir('aq-artmig-B-') };
    const r = await runProcess({ dataDir: tempDir('aq-artmig-Bd-'), partitions: 'artifacts:on', env }, [
      { op: 'boot', stores: ['artifacts'] }, { op: 'load', owner: OWNER },
      { op: 'artifactStream', id: ids.one, version: 2 }, { op: 'artifactStream', id: ids.one, version: 1 },
      { op: 'artifactStream', id: ids.damaged }]);
    assert.deepEqual(r[2], { text: 'classic v2', localCopy: false });
    assert.deepEqual(r[3], { text: 'classic v1', localCopy: false });
    assert.equal(r[4].error, 'ARTIFACT_OBJECT_MISSING', 'the damaged artifact says so, it is not served');
  });
});
