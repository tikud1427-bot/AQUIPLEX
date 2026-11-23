/**
 * Child process for writeCarriedFence.live.test.js — ONE instance, its own
 * scratch data dir, every store partition-backed (`on`), sharing state with the
 * other process ONLY through the database.
 *
 *   node wcfChild.mjs '<json>'   { mode, userId, dir, ttlMs?, newOp? }
 *
 *   syncer   connects and syncs a fake source through the REAL connect service.
 *            Work the sync STARTS and that finishes LATER:
 *              · the real fire-and-forget claim-vector indexing — its embeddings
 *                are held until the marker `go` appears;
 *              · a background TIMER created inside the operation (by the
 *                connector's fetch callback) that, once `go` appears, saves one
 *                more external UKO for the source.
 *            Writes `synced` when the sync returned, waits for `go`, lets the
 *            late work finish and flushes — inside a NEW connect operation of
 *            this same process when `newOp` (whose own write must land).
 *   deleter  waits for `synced`, deletes the source under the connect lease.
 *   locker   waits for `synced`, acquires and releases the owner's lease.
 *   verify   reads what the database holds for the source (raw, independent).
 * Prints one line `RESULT:{...}`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = JSON.parse(process.argv[2]);
const marker = name => path.join(args.dir, name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitForFile = async (name, ms = 60_000) => {
  const until = Date.now() + ms;
  while (!fs.existsSync(marker(name))) { if (Date.now() > until) throw new Error(`timed out waiting for ${name}`); await sleep(10); }
};
const out = r => { process.stdout.write(`RESULT:${JSON.stringify(r)}\n`); };
const text = t => `The ${t} launch is planned for June 12. Lena Hart owns the ${t} service and its 3 budgets.`;

const storage = await import('../../../core/storage/index.js');
await storage.configurePartitionBindings();
const OB = await import('../../../core/storage/ownerBinding.js');
const ownerId = `user:${args.userId}`;

try {
  if (args.mode === 'syncer') {
    const prov = await import('../../../embeddings/embeddingProvider.js');
    // Claim embeddings (one fact statement) wait for `go`; file chunks (the whole text) do not.
    prov.__setEmbedderForTests(async texts => {
      if (texts.length === 1 && !/June 12\. Lena/.test(texts[0])) await waitForFile('go');
      return texts.map((t, i) => [1, i, t.length]);
    });
    const { createConnectorRegistry } = await import('../../../connect/registry.js');
    const { createMemoryConnectionStore } = await import('../../../connect/connectionStore.js');
    const { createCredentialVault } = await import('../../../connect/credentialVault.js');
    const { createConnectService } = await import('../../../connect/connectService.js');
    const { createFakeWorld, createFakeConnector } = await import('../../../connect/testing/fakeConnector.js');
    const { withConnectLease } = await import('../../../connect/ownerLease.js');
    const U = await import('../../ukoStore.js');
    const world = createFakeWorld();
    const account = `acct-${args.userId}`;
    world.put(account, 'r1', { name: 'r1.md', content: text(`Quarry${args.userId.slice(-4)}`) });
    const base = createFakeConnector({ world });
    let timerResult = null; let timerStarted = false;
    const connector = { ...base, fetchResource: async (...a) => {
      if (!timerStarted) {
        timerStarted = true;
        // A background callback created INSIDE the operation: it fires long after the operation ended.
        const t = setInterval(() => {
          if (!fs.existsSync(marker('go'))) return;
          clearInterval(t);
          const tmpl = U.listUKOs(ownerId, { limit: 50, includeRestricted: true }).find(u => u.id.startsWith('ext_'));
          if (tmpl) { U.saveUKO({ ...structuredClone(tmpl), id: `${tmpl.id.slice(0, tmpl.id.lastIndexOf('_'))}_timerlate` }); timerResult = 'saved'; }
          else timerResult = 'no-template';
        }, 20);
      }
      return base.fetchResource(...a);
    } };
    const registry = createConnectorRegistry({ allowTestOnly: true });
    registry.register(connector);
    const service = createConnectService({ registry, store: createMemoryConnectionStore(), vault: createCredentialVault({ key: crypto.randomBytes(32) }),
      retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, singleInstance: true, lease: { ttlMs: args.ttlMs ?? 1000 } });
    await OB.ensureOwnerLoaded(ownerId);
    const conn = await service.connect({ userId: args.userId, connectorId: 'fake', input: { account, code: 'ok' } });
    await OB.ensureOwnerLoaded(ownerId);
    const r = await service.sync({ userId: args.userId, connectionId: conn.connectionId, mode: 'full' });
    const sourceId = `fake:${conn.connectionId}`;
    fs.writeFileSync(marker('source.json'), JSON.stringify({ sourceId }));
    fs.writeFileSync(marker('synced'), String(Date.now()));
    await waitForFile('go');
    const syncedAt = Number(fs.readFileSync(marker('synced'), 'utf8'));
    const finish = async () => {
      for (let i = 0; i < 100 && timerResult === null; i++) await sleep(20);
      await sleep(300);                                   // the held embeddings resume and upsert
      try { await OB.flushOwnerStrict(ownerId); return 'flushed'; } catch (err) { return err.code ?? 'error'; }
    };
    let lateFlush, ownWrite = null;
    if (args.newOp) {
      // A NEW connect operation of THIS process: a new fence. The old work completes inside it.
      lateFlush = await withConnectLease(ownerId, async () => {
        const f = await finish();
        await OB.ensureOwnerLoaded(ownerId);              // the new unit of work reloads what the database holds
        const tmpl = U.listUKOs(ownerId, { limit: 50, includeRestricted: true }).find(u => u.id.startsWith('ext_'));
        if (tmpl) { U.saveUKO({ ...structuredClone(tmpl), id: `${tmpl.id.slice(0, tmpl.id.lastIndexOf('_'))}_newop` }); ownWrite = 'saved'; }
        return f;
      }, { ttlMs: 10_000 });
    } else {
      lateFlush = await finish();
    }
    // Refusals counted by the fence module (a background debounced flush may refuse the late
    // work before the explicit flush runs — then that flush finds nothing pending).
    const { writeFenceStats } = await import('../../../core/storage/writeFence.js');
    out({ ok: r.lastSync?.state === 'succeeded', sourceId, lateFlush, timerResult, ownWrite, lateAfterMs: Date.now() - syncedAt, fenceRefused: writeFenceStats().refused, fencesLost: writeFenceStats().lost });
  } else if (args.mode === 'deleter') {
    await waitForFile('synced');
    const { sourceId } = JSON.parse(fs.readFileSync(marker('source.json'), 'utf8'));
    const X = await import('../../externalSources.js');
    const { withConnectLease } = await import('../../../connect/ownerLease.js');
    const r = await withConnectLease(ownerId, async () => {
      await OB.ensureOwnerLoaded(ownerId);
      return X.deleteExternalSource(ownerId, sourceId);
    }, { ttlMs: 10_000, waitMs: 15_000 });
    fs.writeFileSync(marker('deleted'), String(Date.now()));
    out({ ok: true, complete: r.complete, errors: r.errors });
  } else if (args.mode === 'locker') {
    await waitForFile('synced');
    const { createOwnerLease } = await import('../../../connect/ownerLease.js');
    const l = createOwnerLease(ownerId, { ttlMs: 5000 });
    await l.acquire({ waitMs: 15_000 });
    const released = await l.release();
    fs.writeFileSync(marker('locked'), String(Date.now()));
    out({ ok: true, released });
  } else if (args.mode === 'verify') {
    const { sourceId } = JSON.parse(fs.readFileSync(marker('source.json'), 'utf8'));
    const ident = await import('../../externalIdentity.js');
    const { canonicalClaimNamespace } = await import('../../../brain/contextEngine/canonicalSemantic.js');
    const { getPool } = await import('../../../core/db/pool.js');
    const p = await getPool();
    const prefix = ident.sourcePrefixes(sourceId).ukoPrefix;
    const read = async (store, pk) => JSON.parse((await p.query('SELECT data FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2 AND deleted_at IS NULL', [store, pk])).rows[0]?.data ?? 'null');
    const ukoRow = (await p.query(`SELECT data FROM aqua_store_partitions WHERE store_key = '.aqua-uko.json' AND owner_id = $1 AND deleted_at IS NULL`, [ownerId])).rows[0];
    const ukos = Object.keys(JSON.parse(ukoRow?.data ?? '{}') ?? {}).filter(k => k.startsWith(prefix));
    const evRow = (await p.query(`SELECT data FROM aqua_store_partitions WHERE store_key = '.aqua-evidence.json' AND owner_id = $1 AND deleted_at IS NULL`, [ownerId])).rows[0];
    const ev = JSON.parse(evRow?.data ?? 'null');
    const extFacts = Object.values(ev?.facts ?? {}).filter(f => (f.evidence ?? []).some(e => String(ev.evidence?.[e]?.sourceFileId ?? '').startsWith(prefix))).map(f => String(f.id));
    const claimsRow = (await p.query(`SELECT data FROM aqua_store_partitions WHERE store_key = '.aqua-vectors.json' AND owner_id = $1 AND partition_key LIKE $2 AND deleted_at IS NULL`, [ownerId, `%${canonicalClaimNamespace(ownerId)}`])).rows[0];
    const claims = Object.entries(JSON.parse(claimsRow?.data ?? '{}') ?? {});
    out({ ok: true, prefix, ukos, extFacts, claimVectors: claims.length, externalClaimVectors: claims.filter(([, r]) => r?.meta?.external).length });
  } else {
    throw new Error(`unknown mode ${args.mode}`);
  }
} catch (err) {
  out({ ok: false, code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 300) });
}
await (await import('../../../core/db/pool.js')).closePool?.();
process.exit(0);
