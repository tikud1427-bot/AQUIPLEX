/**
 * Child process for externalDeletionWins.live.test.js — ONE instance, its own
 * scratch data dir, every store partition-backed (`on`), sharing state with the
 * other process ONLY through the database.
 *
 *   node xdwChild.mjs '<json>'   { mode, userId, dir, tokens?, phase? }
 *
 *   sync     connect a fake source (fenced, through the real connect service)
 *            and sync its resources; writes source.json.
 *   editor   edits the source's EXTERNAL facts the way propagation and PIC
 *            consolidation do (evidenceStore.updateFact + consolidateOwner)
 *            and flushes, as a plain (unfenced) instance:
 *              phase 'around' — edit+commit, `edited`; wait `deleted`; edit the
 *                               STALE copy again (no reload) and commit;
 *              phase 'loop'   — edit+commit in a tight loop (reloading every few
 *                               rounds) until `deleted` + 800 ms.
 *   deleter  waits for `edited`/`editing`, deletes the source under the connect
 *            lease (the primitive connectService.disconnect uses), `deleted`.
 *   verify   what the database still holds under the prefix (the production
 *            verification, remainingInDatabase).
 * Prints one line `RESULT:{...}`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = JSON.parse(process.argv[2]);
const marker = name => path.join(args.dir, name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitForFile = async (name, ms = 30_000) => {
  const until = Date.now() + ms;
  while (!fs.existsSync(marker(name))) { if (Date.now() > until) throw new Error(`timed out waiting for ${name}`); await sleep(10); }
};
const out = r => { process.stdout.write(`RESULT:${JSON.stringify(r)}\n`); };

const storage = await import('../../../core/storage/index.js');
await storage.configurePartitionBindings();
const OB = await import('../../../core/storage/ownerBinding.js');
const ES = await import('../../evidenceStore.js');
const X = await import('../../externalSources.js');
const ident = await import('../../externalIdentity.js');
const ownerId = `user:${args.userId}`;
const text = t => `The ${t} launch is planned for June 12. Lena Hart owns the ${t} service and its 3 budgets.`;

try {
  if (args.mode === 'sync') {
    const { createConnectorRegistry } = await import('../../../connect/registry.js');
    const { createMemoryConnectionStore } = await import('../../../connect/connectionStore.js');
    const { createCredentialVault } = await import('../../../connect/credentialVault.js');
    const { createConnectService } = await import('../../../connect/connectService.js');
    const { createFakeWorld, createFakeConnector } = await import('../../../connect/testing/fakeConnector.js');
    const world = createFakeWorld();
    const account = `acct-${args.userId}`;
    for (const [i, t] of (args.tokens ?? ['Aldermoor', 'Brindlewick']).entries()) world.put(account, `r${i + 1}`, { name: `r${i + 1}.md`, content: text(t) });
    const registry = createConnectorRegistry({ allowTestOnly: true });
    registry.register(createFakeConnector({ world }));
    const service = createConnectService({ registry, store: createMemoryConnectionStore(), vault: createCredentialVault({ key: crypto.randomBytes(32) }),
      retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, singleInstance: true, lease: { ttlMs: 10_000 } });
    await OB.ensureOwnerLoaded(ownerId);
    const conn = await service.connect({ userId: args.userId, connectorId: 'fake', input: { account, code: 'ok' } });
    await OB.ensureOwnerLoaded(ownerId);
    const r = await service.sync({ userId: args.userId, connectionId: conn.connectionId, mode: 'full' });
    const sourceId = `fake:${conn.connectionId}`;
    fs.writeFileSync(marker('source.json'), JSON.stringify({ sourceId }));
    out({ ok: r.lastSync?.state === 'succeeded', sourceId, counts: r.lastSync?.counts ?? null });
  } else if (args.mode === 'editor') {
    const { sourceId } = JSON.parse(fs.readFileSync(marker('source.json'), 'utf8'));
    const { consolidateOwner } = await import('../../../pic/consolidationEngine.js');
    const graph = await import('../../../reasoning/reasoningGraph.js');
    const prefix = ident.sourcePrefixes(sourceId).ukoPrefix;
    let edits = 0, rounds = 0, flushErrors = 0;
    const edit = () => {
      const ext = ES.listFacts(ownerId, { limit: 5000 }).filter(f => ES.isExternalFactOf(ownerId, f));
      for (const f of ext) { ES.updateFact(ownerId, f.id, { review: { text: `editor-${rounds}`, at: Date.now(), transitionId: `t${rounds}` } }); edits++; }
      // PIC consolidation as the scheduler runs it, with a clock far ahead: marks facts stale/adjusts confidence.
      consolidateOwner({ evidenceStore: ES, graph }, ownerId, { now: Date.now() + 40 * 24 * 3600 * 1000 });
      rounds++;
      return ext.length;
    };
    const commit = async () => { try { await OB.flushOwnerStrict(ownerId); } catch { flushErrors++; } };
    await OB.ensureOwnerLoaded(ownerId);
    if (args.phase === 'around') {
      const seen = edit();
      await commit();
      fs.writeFileSync(marker('edited'), String(Date.now()));         // committed immediately BEFORE the deletion
      await waitForFile('deleted');
      edit();                                                           // the STALE copy (no reload), immediately AFTER
      await commit();
      out({ ok: true, externalFactsSeen: seen, edits, rounds, flushErrors, prefix });
    } else {
      fs.writeFileSync(marker('editing'), String(Date.now()));
      let stopAt = Infinity;
      while (Date.now() < stopAt) {
        if (stopAt === Infinity && fs.existsSync(marker('deleted'))) stopAt = Date.now() + 800;
        if (rounds % 4 === 3) await OB.ensureOwnerLoaded(ownerId);    // a request's unit of work reloads now and then
        edit();
        await commit();
      }
      out({ ok: true, edits, rounds, flushErrors, prefix });
    }
  } else if (args.mode === 'deleter') {
    await waitForFile(args.waitFor);
    const { sourceId } = JSON.parse(fs.readFileSync(marker('source.json'), 'utf8'));
    const { withConnectLease } = await import('../../../connect/ownerLease.js');
    const r = await withConnectLease(ownerId, async () => {
      await OB.ensureOwnerLoaded(ownerId);
      return X.deleteExternalSource(ownerId, sourceId);
    }, { ttlMs: 10_000, waitMs: 15_000 });
    fs.writeFileSync(marker('swept.json'), JSON.stringify({ factIds: r.removedFactIds ?? [] }));
    fs.writeFileSync(marker('deleted'), String(Date.now()));
    out({ ok: true, complete: r.complete, remaining: r.remaining, errors: r.errors, removedFacts: r.removed?.facts ?? null });
  } else if (args.mode === 'verify') {
    const { sourceId } = JSON.parse(fs.readFileSync(marker('source.json'), 'utf8'));
    const p = ident.sourcePrefixes(sourceId);
    // Like for like with the deleter: the facts it removed count too (PIC fact subjects, claim vectors).
    const swept = fs.existsSync(marker('swept.json')) ? JSON.parse(fs.readFileSync(marker('swept.json'), 'utf8')).factIds : [];
    const remaining = await X.remainingInDatabase(ownerId, { ukoPrefix: p.ukoPrefix, keyPrefix: p.keyPrefix }, swept);
    out({ ok: remaining != null, remaining, ukoPrefix: p.ukoPrefix, keyPrefix: p.keyPrefix });
  } else {
    throw new Error(`unknown mode ${args.mode}`);
  }
} catch (err) {
  out({ ok: false, code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 300) });
}
await (await import('../../../core/db/pool.js')).closePool?.();
process.exit(0);
