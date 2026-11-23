/**
 * Child process for connectFencing.live.test.js — ONE connect operation in its
 * own Node process, its own scratch AQUA_DATA_DIR, every store partition-backed
 * (`on`), sharing state with the other process ONLY through the database.
 *
 *   node fencingChild.mjs '<json>'
 *     { mode: 'sync'|'delete'|'hold', userId, dir, ttlMs, renewEveryMs, waitMs,
 *       fetchDelayMs, tokens: [..] }
 *
 * Coordination through marker files in `dir`:
 *   sync:   writes source.json (its sourceId) after connect, `in-sync` once it
 *           holds the lease and is fetching; then sleeps fetchDelayMs per fetch.
 *   delete: waits for `in-sync`, then deletes the source under the connect
 *           lease (the same primitive connectService uses).
 *   hold:   waits for `in-sync`, takes the lease (waits for expiry), writes
 *           `holding`, holds until `release` appears, then checks it still owns
 *           the row and releases.
 * Prints one line `RESULT:{...}` on stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = JSON.parse(process.argv[2]);
const marker = name => path.join(args.dir, name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitForFile = async (name, ms = 20_000) => {
  const until = Date.now() + ms;
  while (!fs.existsSync(marker(name))) { if (Date.now() > until) throw new Error(`timed out waiting for ${name}`); await sleep(20); }
};
const out = r => { process.stdout.write(`RESULT:${JSON.stringify(r)}\n`); };

const storage = await import('../../../core/storage/index.js');
await storage.configurePartitionBindings();
const { ensureOwnerLoaded } = await import('../../../core/storage/ownerBinding.js');
const { withConnectLease, createOwnerLease, connectLeaseName } = await import('../../ownerLease.js');
const external = await import('../../../files/externalSources.js');
const ownerId = `user:${args.userId}`;
const lease = { ttlMs: args.ttlMs ?? 5000, renewEveryMs: args.renewEveryMs ?? null, waitMs: args.waitMs ?? 15_000 };

try {
  if (args.mode === 'sync') {
    const { createConnectorRegistry } = await import('../../registry.js');
    const { createMemoryConnectionStore } = await import('../../connectionStore.js');
    const { createCredentialVault } = await import('../../credentialVault.js');
    const { createConnectService } = await import('../../connectService.js');
    const { createFakeWorld, createFakeConnector } = await import('../../testing/fakeConnector.js');
    const world = createFakeWorld();
    const account = `acct-${args.userId}`;
    for (const [i, t] of (args.tokens ?? ['Aldermoor', 'Brindlewick']).entries()) {
      world.put(account, `r${i + 1}`, { name: `r${i + 1}.md`, content: `The ${t} launch is planned for June. Lena owns the ${t} service.` });
    }
    const base = createFakeConnector({ world });
    let signalled = false;
    let lateTask = null;
    const connector = { ...base, fetchResource: async (...a) => {
      if (!signalled) { signalled = true; fs.writeFileSync(marker('in-sync'), String(Date.now())); }
      if (args.lateWrites && !lateTask) {
        // Fire-and-forget derived work STARTED INSIDE the operation (Safety Fix 3: it
        // carries the operation's fence) that finishes AFTER the operation released its
        // lease: one more external UKO for this owner, twice.
        lateTask = (async () => {
          const ukoStore = await import('../../../files/ukoStore.js');
          const { flushOwnerStrict } = await import('../../../core/storage/ownerBinding.js');
          const { writeFenceStats } = await import('../../../core/storage/writeFence.js');
          const late = async tag => {
            const template = ukoStore.listUKOs(ownerId, { limit: 50 }).find(u => u.id.startsWith('ext_'));
            if (!template) return 'no-template';
            const refusedBefore = writeFenceStats().refused;
            ukoStore.saveUKO({ ...structuredClone(template), id: `${template.id.slice(0, template.id.lastIndexOf('_'))}_${tag}` });
            try { await flushOwnerStrict(ownerId); } catch (err) { return err.code ?? 'error'; }
            await sleep(400);                              // a background flush may have refused it first
            return writeFenceStats().refused > refusedBefore ? 'WRITE_FENCE_LOST' : 'written';
          };
          await waitForFile('synced', 30_000);
          const late1 = await late('late1');               // nobody has taken over yet → lands
          fs.writeFileSync(marker('late1-done'), String(Date.now()));
          await waitForFile('deleted', 30_000);            // another instance took over and disconnected
          const late2 = await late('late2');               // must be refused
          return { late1, late2 };
        })();
      }
      if (args.fetchDelayMs) await sleep(args.fetchDelayMs);
      return base.fetchResource(...a);
    } };
    const registry = createConnectorRegistry({ allowTestOnly: true });
    registry.register(connector);
    const service = createConnectService({ registry, store: createMemoryConnectionStore(), vault: createCredentialVault({ key: crypto.randomBytes(32) }),
      retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, singleInstance: true, lease });
    await ensureOwnerLoaded(ownerId);
    const conn = await service.connect({ userId: args.userId, connectorId: 'fake', input: { account, code: 'ok' } });
    const sourceId = `fake:${conn.connectionId}`;
    fs.writeFileSync(marker('source.json'), JSON.stringify({ sourceId }));
    await ensureOwnerLoaded(ownerId);
    let result;
    try {
      const r = await service.sync({ userId: args.userId, connectionId: conn.connectionId, mode: 'full' });
      result = { ok: true, sourceId, state: r.lastSync?.state, counts: r.lastSync?.counts ?? null, aborted: Boolean(r.aborted) };
    } catch (err) {
      result = { ok: false, sourceId, code: err.code ?? null, message: String(err.message).slice(0, 200) };
    }
    if (args.lateWrites) {
      fs.writeFileSync(marker('synced'), String(Date.now()));
      Object.assign(result, await lateTask);
    }
    out(result);
  } else if (args.mode === 'delete') {
    await waitForFile(args.waitFor ?? 'in-sync', 30_000);
    const { sourceId } = JSON.parse(fs.readFileSync(marker('source.json'), 'utf8'));
    const t0 = Date.now();
    const r = await withConnectLease(ownerId, async () => {
      const waitedMs = Date.now() - t0;
      await ensureOwnerLoaded(ownerId);                 // the unit of work loads what the previous holder wrote
      const d = await external.deleteExternalSource(ownerId, sourceId);
      return { waitedMs, complete: d.complete, removedUkos: d.removed?.ukos ?? null };
    }, lease);
    fs.writeFileSync(marker('deleted'), String(Date.now()));
    out({ ok: true, ...r });
  } else if (args.mode === 'hold') {
    await waitForFile('in-sync');
    const l = createOwnerLease(ownerId, { ttlMs: 20_000 });
    const t0 = Date.now();
    await l.acquire({ waitMs: 20_000 });
    fs.writeFileSync(marker('holding'), String(Date.now()));
    await waitForFile('release', 30_000);
    const pg = (await import('../../../core/db/pool.js'));
    const p = await pg.getPool();
    const { rows } = await p.query('SELECT holder FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(ownerId)]);
    const stillMine = rows[0]?.holder === l.token;
    await l.release();
    out({ ok: true, waitedMs: fs.statSync(marker('holding')).mtimeMs - t0, stillMineAtEnd: stillMine });
  } else {
    throw new Error(`unknown mode ${args.mode}`);
  }
} catch (err) {
  out({ ok: false, code: err.code ?? null, message: String(err?.message ?? err).slice(0, 200) });
}
await (await import('../../../core/db/pool.js')).closePool?.();
process.exit(0);
