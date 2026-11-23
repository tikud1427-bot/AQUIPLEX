/**
 * Child process for connectionFencing.live.test.js — ONE instance. Processes
 * share state ONLY through PostgreSQL (aqua_test) and ONE connection store:
 * the REAL Mongo adapter (connect/connectionStore.js, its real conditional
 * filters) over a file-backed fake mongoose (atomic per operation across
 * processes) — no MongoDB deployment.
 *
 *   node connFenceChild.mjs '<json>'   { mode, owner, userId, dir, keyHex, ... }
 *
 *   slowWriter     acquires (TTL 1 s, no renewal), stamps, writes `writing`, then
 *                  ONE connection write whose store call takes 2 s (the lease
 *                  expires meanwhile) — ordering 1.
 *   acquirer       waits for `writing` + 1.2 s (the old lease has expired),
 *                  acquires (timed: it must wait for the write in progress),
 *                  stamps, reads.
 *   staleWriter    acquires (TTL 1 s), stamps, writes `acquired`, stalls until
 *                  `b-done`, then writes — and replays the write straight to the
 *                  store (a request delivered late) — ordering 2.
 *   newWriter      waits for `acquired` + 1.2 s, acquires, stamps, writes, `b-done`.
 *   connect        connects through the REAL connect service (seed).
 *   refresher      syncs through the REAL service; the token refresh waits for
 *                  `revoked` (the lease expires meanwhile).
 *   revoker        waits for `refreshing` + 1.2 s, revokes through the REAL service.
 *   syncer         syncs through the REAL service (live lease); the fetch waits
 *                  for `purged`.
 *   exchanger      connects through the REAL service; the credential exchange
 *                  waits for `purged`.
 *   purger         waits for `waitFor`, marks the account deleted, purges the
 *                  connector state (connect/connectPurge.js).
 *   lateAcquire    a new process: lease acquisition and connect for the owner.
 *   delayedInserter  acquires, stamps, starts a CREATE whose request reaches the
 *                  store only after `purged` (+300 ms): its bounded connection
 *                  write times out first (the serialisation is released), the
 *                  request stays in flight, the purge runs to completion
 *                  (records deleted, verified, lease row deleted), THEN the
 *                  insert is delivered — and must write nothing.
 *   slowInserter   acquires, stamps, writes `inserting`, then a CREATE whose
 *                  store call takes 1.5 s while it holds the serialisation —
 *                  the purge must wait for it (reverse ordering).
 * Prints one line `RESULT:{...}`.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = JSON.parse(process.argv[2]);
const marker = name => path.join(args.dir, name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitForFile = async (name, ms = 60_000) => {
  const until = Date.now() + ms;
  while (!fs.existsSync(marker(name))) { if (Date.now() > until) throw new Error(`timed out waiting for ${name}`); await sleep(10); }
};
const out = r => { process.stdout.write(`RESULT:${JSON.stringify(r)}\n`); };
const code = err => err?.code ?? `error:${String(err?.message ?? err).slice(0, 120)}`;

const { getPool, closePool } = await import('../../../core/db/pool.js');
const pool = await getPool();
const { createFakeMongoose } = await import('../helpers/fakeMongoose.mjs');
const CS = await import('../../connectionStore.js');
const L = await import('../../ownerLease.js');
const WF = await import('../../../core/storage/writeFence.js');
const mongoose = createFakeMongoose({ file: path.join(args.dir, 'aqua_connections.json') });
const store = CS.createMongoConnectionStore({ mongoose });
const owner = args.owner;

async function lease(ttlMs, waitMs = 10_000) {
  const l = L.createOwnerLease(owner, { pool, ttlMs });
  const t0 = Date.now();
  await l.acquire({ waitMs });
  const fence = WF.setOwnerFence(owner, { name: l.name, token: l.token, epoch: l.epoch, previousEpoch: l.previousEpoch });
  return { l, fence, waitedMs: Date.now() - t0 };
}
const cw = (fence, fn) => L.serializeConnectionWrite(fence, owner, fn, { pool });

async function service(connectorPatch = c => c, { ttlMs = 10_000, renewEveryMs = null, world = null } = {}) {
  const { createConnectorRegistry } = await import('../../registry.js');
  const { createCredentialVault } = await import('../../credentialVault.js');
  const { createConnectService } = await import('../../connectService.js');
  const { createFakeWorld, createFakeConnector } = await import('../../testing/fakeConnector.js');
  const w = world ?? createFakeWorld();
  const registry = createConnectorRegistry({ allowTestOnly: true });
  registry.register(connectorPatch(createFakeConnector({ world: w })));
  return { world: w, svc: createConnectService({ registry, store, vault: createCredentialVault({ key: Buffer.from(args.keyHex, 'hex') }),
    retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, lease: { ttlMs, renewEveryMs } }) };
}

try {
  if (args.mode === 'slowWriter') {
    const A = await lease(1000);
    await cw(A.fence, f => store.stamp(owner, f));
    fs.writeFileSync(marker('writing'), String(Date.now()));
    const t0 = Date.now();
    await cw(A.fence, f => { mongoose.delayNextWrite(2000); return store.update(owner, args.connectionId, { checkpoint: { by: 'A' } }, { fence: f }); });
    out({ ok: true, wroteAt: Date.now(), writeMs: Date.now() - t0, epoch: A.fence.epoch });
  } else if (args.mode === 'acquirer') {
    await waitForFile('writing');
    await sleep(1200);                                     // the slow writer's lease has expired by now
    const B = await lease(10_000);
    const acquiredAt = Date.now();
    await cw(B.fence, f => store.stamp(owner, f));
    const doc = await store.get(owner, args.connectionId);
    await B.l.release();
    out({ ok: true, acquiredAt, waitedMs: B.waitedMs, epoch: B.fence.epoch, checkpoint: doc?.checkpoint ?? null, docEpoch: doc?.fenceEpoch ?? null });
  } else if (args.mode === 'staleWriter') {
    const A = await lease(1000);
    await cw(A.fence, f => store.stamp(owner, f));
    fs.writeFileSync(marker('acquired'), String(Date.now()));
    await waitForFile('b-done');
    let viaService, late;
    try { await cw(A.fence, f => store.update(owner, args.connectionId, { checkpoint: { by: 'A-stale' }, pendingDeletion: null }, { fence: f })); viaService = 'written'; } catch (err) { viaService = code(err); }
    try { await store.update(owner, args.connectionId, { checkpoint: { by: 'A-late' } }, { fence: { epoch: A.fence.epoch, token: A.fence.token } }); late = 'written'; } catch (err) { late = code(err); }
    out({ ok: true, viaService, late, epoch: A.fence.epoch });
  } else if (args.mode === 'newWriter') {
    await waitForFile('acquired');
    await sleep(1200);
    const B = await lease(10_000);
    await cw(B.fence, f => store.stamp(owner, f));
    await cw(B.fence, f => store.update(owner, args.connectionId, { checkpoint: { by: 'B' }, pendingDeletion: { count: 3, origin: 'B' } }, { fence: f }));
    await B.l.release();
    fs.writeFileSync(marker('b-done'), String(Date.now()));
    out({ ok: true, epoch: B.fence.epoch });
  } else if (args.mode === 'connect') {
    const { svc, world } = await service();
    world.put('acct', 'r1', { name: 'r1.md', content: 'The Ashby plan is due on June 12.' });
    const c = await svc.connect({ userId: args.userId, connectorId: 'fake', input: { account: 'acct', code: 'ok' } });
    fs.writeFileSync(marker('connection.json'), JSON.stringify({ connectionId: c.connectionId }));
    out({ ok: true, connectionId: c.connectionId });
  } else if (args.mode === 'refresher') {
    const { createFakeWorld } = await import('../../testing/fakeConnector.js');
    const world = createFakeWorld({ tokenTtlMs: 1000 });   // every sync must refresh
    world.put('acct', 'r1', { name: 'r1.md', content: 'The Ashby plan is due on June 12.' });
    const { svc } = await service(c => ({ ...c, refresh: async creds => { fs.writeFileSync(marker('refreshing'), String(Date.now())); await waitForFile('revoked'); return c.refresh(creds); } }), { world, ttlMs: 1000, renewEveryMs: 0 });
    const conn = await svc.connect({ userId: args.userId, connectorId: 'fake', input: { account: 'acct', code: 'ok' } });
    fs.writeFileSync(marker('connection.json'), JSON.stringify({ connectionId: conn.connectionId }));
    let result;
    try { await svc.sync({ userId: args.userId, connectionId: conn.connectionId, mode: 'full' }); result = 'synced'; } catch (err) { result = code(err); }
    out({ ok: true, result, connectionId: conn.connectionId });
  } else if (args.mode === 'revoker') {
    await waitForFile('refreshing');
    await sleep(1200);
    const { connectionId } = JSON.parse(fs.readFileSync(marker('connection.json'), 'utf8'));
    const { svc } = await service();
    const r = await svc.revokeCredentials({ userId: args.userId, connectionId });
    fs.writeFileSync(marker('revoked'), String(Date.now()));
    out({ ok: true, status: r.connection?.status, hasCredentials: r.connection?.hasCredentials });
  } else if (args.mode === 'syncer') {
    const { svc, world } = await service(c => ({ ...c, fetchResource: async (...a) => { fs.writeFileSync(marker('in-sync'), String(Date.now())); await waitForFile('purged'); return c.fetchResource(...a); } }));
    world.put('acct', 'r1', { name: 'r1.md', content: 'The Ashby plan is due on June 12.' });
    const conn = await svc.connect({ userId: args.userId, connectorId: 'fake', input: { account: 'acct', code: 'ok' } });
    let result;
    try { await svc.sync({ userId: args.userId, connectionId: conn.connectionId, mode: 'full' }); result = 'synced'; } catch (err) { result = code(err); }
    out({ ok: true, result });
  } else if (args.mode === 'exchanger') {
    const { svc } = await service(c => ({ ...c, connect: async input => { fs.writeFileSync(marker('exchanging'), String(Date.now())); await waitForFile('purged'); return c.connect(input); } }));
    let result;
    try { await svc.connect({ userId: args.userId, connectorId: 'fake', input: { account: 'acct', code: 'ok' } }); result = 'connected'; } catch (err) { result = code(err); }
    out({ ok: true, result });
  } else if (args.mode === 'purger') {
    if (args.waitFor) await waitForFile(args.waitFor);
    const D = await import('../../../core/storage/deletedOwners.js');
    const { purgeConnectorState } = await import('../../connectPurge.js');
    await D.markOwnerDeleted(owner, { pool });
    const t0 = Date.now();
    const r = await purgeConnectorState(owner, { stores: [store], pool, waitMs: 15_000 });
    const purgedAt = Date.now();
    fs.writeFileSync(marker('purged'), String(purgedAt));
    out({ ok: true, ...r, purgeMs: purgedAt - t0, purgedAt });
  } else if (args.mode === 'delayedInserter') {
    const A = await lease(30_000);
    await cw(A.fence, f => store.stamp(owner, f));
    const doc = { connectionId: 'conn_' + 'd'.repeat(20), ownerId: owner, connectorId: 'fake', sourceId: 'fake:conn_' + 'd'.repeat(20), status: 'active', credentials: { v: 1, alg: 'aes-256-gcm', keyId: 'k', iv: 'i', tag: 't', ct: 'SEALED-CREDENTIALS' } };
    let inFlight = null;
    let serialised;
    try {
      await L.serializeConnectionWrite(A.fence, owner, f => {
        // The request leaves now; the store receives it only after the purge completed.
        inFlight = (async () => { await waitForFile('purged'); await sleep(300); return store.create(doc, { fence: f }); })();
        return inFlight;
      }, { pool, boundMs: 400, graceMs: 200 });
      serialised = 'written';
    } catch (err) { serialised = code(err); }
    fs.writeFileSync(marker('insert-in-flight'), String(Date.now()));
    let delivered;
    try { await inFlight; delivered = 'written'; } catch (err) { delivered = code(err); }
    out({ ok: true, serialised, delivered, deliveredAt: Date.now() });
  } else if (args.mode === 'slowInserter') {
    const A = await lease(30_000);
    await cw(A.fence, f => store.stamp(owner, f));
    const doc = { connectionId: 'conn_' + 'e'.repeat(20), ownerId: owner, connectorId: 'fake', sourceId: 'fake:conn_' + 'e'.repeat(20), status: 'active', credentials: { v: 1, alg: 'aes-256-gcm', keyId: 'k', iv: 'i', tag: 't', ct: 'SEALED-CREDENTIALS' } };
    fs.writeFileSync(marker('inserting'), String(Date.now()));
    let created;
    try { await cw(A.fence, f => { mongoose.delayNextWrite(1500); return store.create(doc, { fence: f }); }); created = 'created'; } catch (err) { created = code(err); }
    out({ ok: true, created, committedAt: Date.now() });
  } else if (args.mode === 'lateAcquire') {
    let acquire, connect;
    try { await L.createOwnerLease(owner, { pool }).acquire({ waitMs: 0 }); acquire = 'acquired'; } catch (err) { acquire = code(err); }
    const { svc } = await service();
    try { await svc.connect({ userId: args.userId, connectorId: 'fake', input: { account: 'acct', code: 'ok' } }); connect = 'connected'; } catch (err) { connect = code(err); }
    out({ ok: true, acquire, connect });
  } else {
    throw new Error(`unknown mode ${args.mode}`);
  }
} catch (err) {
  out({ ok: false, code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 300) });
}
await closePool?.();
process.exit(0);
