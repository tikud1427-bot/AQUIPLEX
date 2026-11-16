/**
 * Phase 4A — artifact storage audit + object migration plan.
 *
 * Artifacts are created by the REAL store (artifactStore.js) in a temporary
 * root, then damaged the ways a production disk can be (a file deleted, bytes
 * changed, a manifest lost, an orphan directory, a stray temp file). The audit
 * CLI must find each. The upload plan is then written to the Postgres object
 * store (the shared backend with the same write-once contract a GCS backend
 * would implement) and verified object by object.
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-art-audit-'));
process.env.AQUA_ARTIFACTS_DIR = ROOT;
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-art-data-'));
process.env.AQUA_STORE_PARTITIONS = '';          // the classic local-disk layout production has today
const RUN = Date.now().toString(36);
const LIVE = Boolean(process.env.DATABASE_URL);

let S;
const ids = {};
const file = (p, s, mime = 'text/plain') => ({ path: p, buffer: Buffer.from(s), mime });
const make = (title, owner, conv, files) => S.createArtifact({ ownerId: owner, conversationId: conv, requestId: `r-${title}`, format: 'text',
  title, spec: { title }, packaging: files.length > 1 ? 'zip' : 'raw', files });
const audit = (...extra) => {
  try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, [path.join(AQUA, 'scripts', 'artifact-storage-audit.mjs'), '--root', ROOT, ...extra]).toString()) }; }
  catch (e) { return { code: e.status, out: JSON.parse(String(e.stdout)) }; }
};

describe('Phase 4A — artifact storage audit', { concurrency: false }, () => {
  before(async () => {
    S = await import('../artifactStore.js');
    ids.ok = (await make('report', `user:a${RUN}`, `conv-a-${RUN}`, [file('report.md', '# Report\nall fine')])).id;
    ids.multi = (await make('site', `user:a${RUN}`, `conv-a-${RUN}`, [file('index.html', '<h1>x</h1>', 'text/html'), file('css/s.css', 'h1{}', 'text/css')])).id;
    await S.appendVersion(ids.multi, { files: [file('index.html', '<h1>v2</h1>', 'text/html'), file('css/s.css', 'h1{color:red}', 'text/css')], reason: 'edit' });
    ids.missingFile = (await make('lost', `user:b${RUN}`, `conv-b-${RUN}`, [file('a.txt', 'aaa'), file('b.txt', 'bbb')])).id;
    ids.tampered = (await make('tampered', `user:b${RUN}`, `conv-gone-${RUN}`, [file('t.txt', 'original')])).id;
    ids.noManifest = (await make('nomanifest', `user:c${RUN}`, `conv-c-${RUN}`, [file('n.txt', 'n')])).id;
    S._flushIndexForTests?.();
    await new Promise(r => setTimeout(r, 700));    // the index's debounced write
    // Damage, as a production disk can be damaged:
    fs.rmSync(path.join(ROOT, ids.missingFile, 'v1', 'b.txt'));
    fs.writeFileSync(path.join(ROOT, ids.tampered, 'v1', 't.txt'), 'changed!');
    fs.rmSync(path.join(ROOT, ids.noManifest, 'manifest.json'));
    fs.mkdirSync(path.join(ROOT, `orphan-${RUN}`, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, ids.ok, 'v1', `report.md.tmp.123.abc`), 'x');
  });
  after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

  test('inventory and every kind of damage is reported', () => {
    const history = path.join(ROOT, '..', `hist-${RUN}.json`);
    fs.writeFileSync(history, JSON.stringify({ __aqua: { schema: 1 }, data: { [`conv-a-${RUN}`]: {}, [`conv-b-${RUN}`]: {}, [`conv-c-${RUN}`]: {} } }));
    const deleted = path.join(ROOT, '..', `del-${RUN}.txt`); fs.writeFileSync(deleted, `user:b${RUN}\n`);
    const { code, out } = audit('--history', history, '--deleted', deleted);
    assert.equal(code, 1, 'damage must make the audit unclean');
    assert.equal(out.artifacts.indexed, 5);
    assert.equal(out.artifacts.withManifest, 4);
    assert.equal(out.artifacts.versions, 5, 'the multi-file artifact has 2 versions');
    assert.equal(out.versionLayout.classic, 5);
    assert.deepEqual(out.integrity.manifestUnreadable, [ids.noManifest]);
    assert.equal(out.integrity.missingFiles, 1);
    assert.equal(out.integrity.hashMismatch, 1);
    assert.equal(out.integrity.sizeMismatch, 0, 'same length, different bytes: only the hash catches it');
    assert.deepEqual(out.integrity.orphanDirectories, [`orphan-${RUN}`]);
    assert.equal(out.integrity.strayTempFiles, 1);
    assert.equal(out.references.conversationGone, 1);
    assert.equal(out.references.ownerDeleted, 2);
    assert.equal(out.owners.users, 2);
    assert.ok(!JSON.stringify(out).includes('all fine'), 'no file content in the report');
  });

  test('the object plan has one object per (artifact, version, file) under the object-store key scheme', () => {
    const planFile = path.join(ROOT, '..', `plan-${RUN}.json`);
    audit('--plan-out', planFile, '--force');
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const keys = plan.map(o => o.key);
    assert.ok(keys.includes(`artifacts/${ids.multi}/v1/index.html`) && keys.includes(`artifacts/${ids.multi}/v2/css/s.css`));
    assert.ok(plan.every(o => /^[0-9a-f]{64}$/.test(o.sha256) && o.size > 0));
    assert.equal(new Set(keys).size, keys.length, 'object keys are unique');
  });

  test('upload of the plan to the shared object store, then verification object by object', { skip: LIVE ? false : 'needs DATABASE_URL (the Postgres object store stands in for GCS)' }, async () => {
    const { migrate } = await import('../../core/db/migrate.js');
    await migrate();
    const { createPgObjectStore } = await import('../../core/storage/objectStore.js');
    const { auditArtifactRoot, verifyObjectPlan } = await import('../artifactAudit.js');
    const store = createPgObjectStore();
    const r = auditArtifactRoot(ROOT);
    // Owner per object: from the manifests (the plan carries only hashed owners).
    const ownerByArtifact = new Map();
    for (const id of Object.values(ids)) {
      const m = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, id, 'manifest.json'), 'utf8')); } catch { return null; } })();
      if (m) ownerByArtifact.set(id, m.ownerId);
    }
    const owner = o => ownerByArtifact.get(o.key.split('/')[1]);
    for (const o of r.plan) {
      const abs = path.join(ROOT, ...o.key.split('/').slice(1));
      await store.put(o.key, fs.readFileSync(abs), { ownerId: owner(o) });
    }
    const v = await verifyObjectPlan(r.plan, store, { ownerOf: owner });
    assert.equal(v.clean, true, JSON.stringify(v));
    // A re-run of the upload is idempotent (write-once, same bytes).
    const again = await store.put(r.plan[0].key, fs.readFileSync(path.join(ROOT, ...r.plan[0].key.split('/').slice(1))), { ownerId: owner(r.plan[0]) });
    assert.equal(again.created, false);
    // A lost object is detected.
    await store.deletePrefix(owner(r.plan[0]), r.plan[0].key);
    const v2 = await verifyObjectPlan(r.plan, store, { ownerOf: owner });
    assert.equal(v2.missing, 1);
    for (const id of Object.values(ids)) { const o = ownerByArtifact.get(id); if (o) await store.deletePrefix(o, `artifacts/${id}/`); }
    const { closePool } = await import('../../core/db/pool.js');
    await closePool();
  });
});
