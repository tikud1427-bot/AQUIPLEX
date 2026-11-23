/**
 * Child process for ownerDeletionBarrier.live.test.js — ONE writer or ONE
 * account deletion, in its own Node process, sharing state with the other
 * process ONLY through the database (the REAL partition repository).
 *
 *   node barrierChild.mjs '<json>'   { mode, owner, other?, dir, lease? }
 *
 *   slow-writer  one INSERT through repository.put; the transaction is HELD
 *                (barrier already taken) until `marking` appears + 800 ms.
 *   marker       waits for `in-tx`, marks the owner deleted (timed), purges.
 *   stress       writes INSERTs + UPDATEs for `owner` (and `other`) in a tight
 *                loop until `purged` + 800 ms. lease: true → inside a held
 *                connect lease (an ACTIVE write fence).
 *   purger       waits for `writing`, marks deleted, purges.
 *   late         after `purged`: every write path, and a lease acquisition.
 *   trailing     a finished connect operation (TRAILING fence), then a write
 *                after `purged`.
 * Prints one line `RESULT:{...}`.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = JSON.parse(process.argv[2]);
const marker = name => path.join(args.dir, name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitForFile = async (name, ms = 30_000) => {
  const until = Date.now() + ms;
  while (!fs.existsSync(marker(name))) { if (Date.now() > until) throw new Error(`timed out waiting for ${name}`); await sleep(10); }
};
const out = r => { process.stdout.write(`RESULT:${JSON.stringify(r)}\n`); };
const S = '.aqua-barrier-live.json';

const { getPool, closePool } = await import('../../db/pool.js');
const { createPartitionRepository } = await import('../../storage/partitionRepository.js');
const D = await import('../../storage/deletedOwners.js');
const pool = await getPool();
const code = err => err?.code ?? `error:${String(err?.message ?? err).slice(0, 80)}`;

try {
  if (args.mode === 'slow-writer') {
    // The real repository, on a pool whose INSERT into the partition table
    // pauses — the write transaction is open and holds the barrier.
    const slowPool = {
      query: (...a) => pool.query(...a),
      connect: async () => {
        const c = await pool.connect();
        return {
          release: (...a) => c.release(...a),
          query: async (text, params) => {
            if (typeof text === 'string' && text.includes('INSERT INTO aqua_store_partitions')) {
              fs.writeFileSync(marker('in-tx'), String(Date.now()));
              await waitForFile('marking');
              await sleep(800);
            }
            return c.query(text, params);
          },
        };
      },
    };
    const repo = createPartitionRepository({ pool: slowPool });
    let result;
    try { await repo.put(S, `slow:${args.owner}`, '{"written":"before the deletion"}', { ownerId: args.owner, expectedVersion: 0 }); result = 'written'; }
    catch (err) { result = code(err); }
    fs.writeFileSync(marker('written'), String(Date.now()));
    out({ ok: true, result, committedAt: Date.now() });
  } else if (args.mode === 'marker' || args.mode === 'purger') {
    await waitForFile(args.mode === 'marker' ? 'in-tx' : 'writing');
    if (args.mode === 'purger') await sleep(300);
    fs.writeFileSync(marker('marking'), String(Date.now()));
    const repo = createPartitionRepository({ pool });
    const t0 = Date.now();
    await D.markOwnerDeleted(args.owner, { pool });
    const markedAt = Date.now();
    const purged = await repo.purgeOwner(args.owner);
    fs.writeFileSync(marker('purged'), String(Date.now()));
    out({ ok: true, waitedMs: markedAt - t0, markedAt, tombstoned: purged.tombstoned });
  } else if (args.mode === 'stress') {
    const repo = createPartitionRepository({ pool });
    await D.isOwnerDeleted(args.owner);              // a negative answer cached in this process (stale soon)
    let lease = null;
    if (args.lease) {
      const WF = await import('../../storage/writeFence.js');
      const L = await import('../../../connect/ownerLease.js');
      lease = L.createOwnerLease(args.owner, { pool, ttlMs: 60_000 });
      await lease.acquire({ waitMs: 5_000 });
      WF.setOwnerFence(args.owner, { name: lease.name, token: lease.token });
    }
    const c = { inserted: 0, updated: 0, refused: 0, other: 0, otherOwnerWrites: 0, otherErrors: [] };
    const u = await repo.put(S, `u:${args.owner}`, '{"n":0}', { ownerId: args.owner, expectedVersion: 0 });
    let uVersion = u.version;
    fs.writeFileSync(marker('writing'), String(Date.now()));
    let stopAt = Infinity;
    for (let i = 0; Date.now() < stopAt; i++) {
      if (stopAt === Infinity && fs.existsSync(marker('purged'))) stopAt = Date.now() + 800;
      try { await repo.put(S, `k:${args.owner}:${i}`, `{"i":${i}}`, { ownerId: args.owner, expectedVersion: 0 }); c.inserted++; }
      catch (err) { if (code(err) === 'OWNER_DELETED') c.refused++; else { c.other++; c.otherErrors.push(code(err)); } }
      try { uVersion = (await repo.put(S, `u:${args.owner}`, `{"n":${i}}`, { ownerId: args.owner, expectedVersion: uVersion })).version; c.updated++; }
      catch (err) {
        if (code(err) === 'OWNER_DELETED') c.refused++;
        else if (err?.name === 'PartitionConflictError') { uVersion = Number((await pool.query(`SELECT version FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2`, [S, `u:${args.owner}`])).rows[0]?.version ?? 0); }
        else { c.other++; c.otherErrors.push(code(err)); }
      }
      if (args.other && i % 10 === 0) {
        await repo.put(S, `k:${args.other}:${i}`, `{"i":${i}}`, { ownerId: args.other, expectedVersion: 0 });
        c.otherOwnerWrites++;
      }
    }
    c.otherErrors = [...new Set(c.otherErrors)].slice(0, 5);
    if (lease) await lease.release();
    out({ ok: true, ...c });
  } else if (args.mode === 'late') {
    await waitForFile('purged');
    const repo = createPartitionRepository({ pool });
    const L = await import('../../../connect/ownerLease.js');
    const r = {};
    try { await repo.put(S, `late:${args.owner}`, '{"late":1}', { ownerId: args.owner, expectedVersion: 0 }); r.insert = 'written'; } catch (err) { r.insert = code(err); }
    const cur = (await pool.query(`SELECT version FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2`, [S, `u:${args.owner}`])).rows[0];
    try { await repo.put(S, `u:${args.owner}`, '{"late":2}', { ownerId: args.owner, expectedVersion: Number(cur?.version ?? 0) }); r.update = 'written'; } catch (err) { r.update = code(err); }
    try { await repo.update(S, `u:${args.owner}`, (_t, meta) => (meta.deleted ? '{"recreated":true}' : undefined), { ownerId: args.owner }); r.recreate = 'written'; } catch (err) { r.recreate = code(err); }
    try { await repo.insertChild({ storeKey: S, parentKey: `u:${args.owner}`, partitionKey: `child:${args.owner}`, data: '{"c":1}', ownerId: args.owner }); r.child = 'written'; } catch (err) { r.child = code(err); }
    try { await L.createOwnerLease(args.owner, { pool }).acquire({ waitMs: 0 }); r.lease = 'acquired'; } catch (err) { r.lease = code(err); }
    // Deletions still land (real left()/length()): prefix and group tombstones.
    r.prefixTombstones = await repo.tombstonePrefix({ storeKey: S, ownerId: args.owner, prefix: `k:${args.owner}:` });
    r.group = await repo.tombstoneGroup({ storeKey: S, parentKey: `g:${args.owner}`, childPrefix: `gm:${args.owner}:`, ownerId: args.owner });
    out({ ok: true, ...r });
  } else if (args.mode === 'trailing') {
    const L = await import('../../../connect/ownerLease.js');
    const repo = createPartitionRepository({ pool });
    let fence, lateWork;
    await L.withConnectLease(args.owner, async ({ fence: f }) => {
      fence = f;
      await repo.put(S, `tr:${args.owner}`, '{"during":1}', { ownerId: args.owner, expectedVersion: 0 });
      // Detached work STARTED INSIDE the operation (Safety Fix 3: it carries the
      // operation's fence), finishing after the account was deleted.
      lateWork = (async () => {
        await waitForFile('purged');
        try { await repo.put(S, `tr2:${args.owner}`, '{"after":1}', { ownerId: args.owner, expectedVersion: 0 }); return 'written'; } catch (err) { return code(err); }
      })();
    }, { pool, ttlMs: 20_000 });
    const trailing = fence.ended === true && fence.lost === null;   // the operation ENDED (its fence still valid)
    fs.writeFileSync(marker('writing'), String(Date.now()));
    const late = await lateWork;
    out({ ok: true, trailing, late });
  } else {
    throw new Error(`unknown mode ${args.mode}`);
  }
} catch (err) {
  out({ ok: false, code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 200) });
}
await closePool?.();
process.exit(0);
