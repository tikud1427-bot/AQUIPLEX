/**
 * Phase 1b.2 — mass-deletion confirmation policy, one test per rule.
 *
 *   1  only complete FULL listings can confirm a mass deletion
 *   2  a change feed can never confirm (even after a full sighting)
 *   3  the first complete listing records the exact set and the time
 *   4  the same set, from a complete listing ≥ 1 hour later, confirms; earlier does not
 *   5  a failed, aborted or incomplete run resets the sequence
 *   6  a different set restarts the sequence
 *   7  explicit user confirmation (=== true) is an alternative
 *   8  never delete from a partial listing (even with confirmation)
 *   9  individual (non-mass) deletions apply immediately, as before
 *
 * Deterministic: an injected clock; the engine-level tests use a stateful
 * stand-in for the Phase 1a.2 store (no ingest), the service-level tests the
 * fake connector world (testkit isolation, no network, no real account).
 */
import { stack, freshUser, ownerOf, doc, external, createFakeWorld, createFakeConnector } from './testkit.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runSync, SYNC_LIMITS, MASS_DELETION } from '../syncEngine.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-18T09:00:00Z');
const noRetry = { sleep: () => Promise.resolve(), baseMs: 0 };
const id = i => `r${String(i).padStart(3, '0')}`;

// ── engine harness (stateful stand-in for files/externalSources.js) ─────────
function engine({ total = 6, pageSize = 100 } = {}) {
  let t = T0;
  const now = () => t;
  const world = createFakeWorld({ now, pageSize, tokenTtlMs: 365 * 24 * HOUR });   // hours pass in these tests; tokens must not expire
  for (let i = 0; i < total; i++) world.put('acct', id(i), { name: `${id(i)}.md`, content: `body ${i}` });
  const items = new Map([...world.accountOf('acct').resources.values()].map(r => [r.externalId, { externalId: r.externalId, version: r.version }]));
  const deleted = [];
  const ext = {
    EXTERNAL_LIMITS: { resourcesPerSync: 100 },
    listExternalResources: () => [...items.values()].map(r => ({ ...r })),
    async syncExternalResources({ resources }) {
      return { results: resources.map(r => { const st = items.has(r.externalId) ? 'updated' : 'created'; items.set(r.externalId, { externalId: r.externalId, version: r.version }); return { externalId: r.externalId, status: st }; }) };
    },
    async deleteExternalResource(_o, _s, x) { items.delete(x); deleted.push(x); return { complete: true }; },
  };
  const connector = createFakeConnector({ world });
  const token = world.issue('acct').accessToken;
  let conn = { connectionId: 'conn_' + 'e'.repeat(20), sourceId: 'fake:conn_' + 'e'.repeat(20), checkpoint: null, fullSync: null, pendingDeletion: null };
  const ctx = { connectionId: conn.connectionId, credentials: () => ({ accessToken: token }) };
  const run = async (opts = {}) => {
    const out = await runSync({ ownerId: 'user:md', conn, connector, ctx, external: ext, retry: noRetry, now, mode: 'full', ...opts });
    conn = { ...conn, checkpoint: out.checkpoint, fullSync: out.fullSync, pendingDeletion: out.pendingDeletion };
    return out;
  };
  return {
    world, items, deleted, run, conn: () => conn,
    advance: ms => { t += ms; }, time: () => t,
    removeAtSource: (...xs) => xs.forEach(x => world.remove('acct', x)),
  };
}

describe('1b.2 mass-deletion policy (engine)', () => {
  test('rule 3: the first complete listing records the exact set and the time; nothing is deleted', async () => {
    const e = engine();
    e.removeAtSource(id(4), id(1), id(3), id(0));
    const out = await e.run();
    assert.equal(out.lastSync.counts.withheldRemovals, 4);
    assert.equal(out.lastSync.state, 'partial');
    assert.deepEqual(out.pendingDeletion.ids, [id(0), id(1), id(3), id(4)], 'exact, sorted set recorded');
    assert.equal(out.pendingDeletion.origin, 'full');
    assert.equal(out.pendingDeletion.firstSeenAt, new Date(T0).toISOString());
    assert.match(out.lastSync.note, /at or after 2026-11-18T10:00:00\.000Z/);
    assert.deepEqual(e.deleted, []);
    assert.equal(out.checkpoint, null, 'checkpoint must not advance while a deletion is withheld');
  });

  test('rule 4: the same set before one hour is still withheld (time kept); at one hour it is applied', async () => {
    const e = engine();
    e.removeAtSource(id(0), id(1), id(2), id(3));
    await e.run();
    e.advance(HOUR - 1);
    const early = await e.run();
    assert.equal(early.lastSync.counts.withheldRemovals, 4);
    assert.equal(early.pendingDeletion.firstSeenAt, new Date(T0).toISOString(), 'a too-early repeat must keep the original time');
    assert.deepEqual(e.deleted, []);
    e.advance(1);
    const ok = await e.run();
    assert.equal(ok.lastSync.counts.removed, 4);
    assert.equal(ok.lastSync.state, 'succeeded');
    assert.equal(ok.pendingDeletion, null);
    assert.deepEqual(e.deleted.sort(), [id(0), id(1), id(2), id(3)]);
  });

  test('rules 1 + 2: a change feed never confirms — not by repetition, not after a full sighting', async () => {
    const e = engine();
    await e.run();                                   // clean full: checkpoint set
    await e.run({ mode: 'incremental' });            // feed checkpoint
    e.removeAtSource(id(0), id(1), id(2), id(3));
    const f1 = await e.run({ mode: 'incremental' });
    assert.equal(f1.lastSync.counts.withheldRemovals, 4);
    assert.equal(f1.pendingDeletion.origin, 'feed');
    assert.equal(f1.pendingDeletion.ids, null, 'a feed must not record a confirmable sighting');
    e.advance(3 * HOUR);
    const f2 = await e.run({ mode: 'incremental' });
    assert.equal(f2.lastSync.counts.withheldRemovals, 4, 'a repeated feed confirmed');
    const full = await e.run();                      // first complete listing = first sighting
    assert.equal(full.lastSync.counts.withheldRemovals, 4);
    assert.equal(full.pendingDeletion.origin, 'full');
    e.advance(2 * HOUR);
    const f3 = await e.run({ mode: 'incremental' });  // a feed after a valid sighting still cannot confirm
    assert.equal(f3.lastSync.counts.removed, 0);
    assert.deepEqual(e.deleted, []);
  });

  test('rule 5a: a failed listing between the two resets the sequence', async () => {
    const e = engine();
    e.removeAtSource(id(0), id(1), id(2), id(3));
    await e.run();
    e.advance(30 * 60 * 1000);
    e.world.failList(5, { transient: false });
    const failed = await e.run();
    assert.equal(failed.lastSync.state, 'failed');
    assert.equal(failed.pendingDeletion, null, 'a failed listing must reset');
    e.world.failures.list = 0;
    e.advance(2 * HOUR);
    const next = await e.run();
    assert.equal(next.lastSync.counts.withheldRemovals, 4, 'the old sighting was used after a failure');
    assert.equal(next.pendingDeletion.firstSeenAt, new Date(e.time()).toISOString(), 'a new sighting starts');
    assert.deepEqual(e.deleted, []);
  });

  test('rule 5b: an incomplete (page-limited) listing between the two resets the sequence', async () => {
    const e = engine({ total: 8, pageSize: 2 });
    e.removeAtSource(id(0), id(1), id(2), id(3), id(4));
    await e.run();                                            // complete (2 pages of 2 for the 3 left)
    assert.equal(e.conn().pendingDeletion.origin, 'full');
    e.advance(2 * HOUR);
    const partial = await e.run({ limits: { ...SYNC_LIMITS, maxPages: 1 } });
    assert.equal(partial.lastSync.complete, false);
    assert.equal(partial.pendingDeletion, null, 'an incomplete listing must reset');
    assert.deepEqual(e.deleted, []);
  });

  test('rule 5c: an aborted run resets the sequence', async () => {
    const e = engine();
    e.removeAtSource(id(0), id(1), id(2), id(3));
    await e.run();
    e.world.put('acct', id(5), { name: `${id(5)}.md`, content: 'changed' });   // forces an import batch
    e.advance(2 * HOUR);
    const aborted = await e.run({ guard: async () => false });
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.pendingDeletion, null);
    assert.deepEqual(e.deleted, []);
  });

  test('rule 6: a different set restarts the sequence with a new time', async () => {
    const e = engine();
    e.removeAtSource(id(0), id(1), id(2), id(3));
    await e.run();
    e.advance(2 * HOUR);
    e.removeAtSource(id(4));
    const diff = await e.run();
    assert.equal(diff.lastSync.counts.withheldRemovals, 5);
    assert.equal(diff.pendingDeletion.firstSeenAt, new Date(e.time()).toISOString());
    assert.deepEqual(e.deleted, []);
  });

  test('rule 7: explicit confirmation (=== true) applies at once; a truthy non-boolean does not', async () => {
    const e = engine();
    e.removeAtSource(id(0), id(1), id(2), id(3));
    const no = await e.run({ confirmMassDeletion: 'yes' });
    assert.equal(no.lastSync.counts.withheldRemovals, 4);
    const yes = await e.run({ confirmMassDeletion: true });
    assert.equal(yes.lastSync.counts.removed, 4);
    assert.equal(yes.pendingDeletion, null);
  });

  test('rule 8: never delete from a partial listing, even with confirmation', async () => {
    const e = engine({ total: 8, pageSize: 2 });
    e.removeAtSource(id(0), id(1), id(2), id(3), id(4));
    const out = await e.run({ limits: { ...SYNC_LIMITS, maxPages: 1 }, confirmMassDeletion: true });
    assert.equal(out.lastSync.complete, false);
    assert.equal(out.lastSync.counts.removed, 0);
    assert.deepEqual(e.deleted, []);
  });

  test('rule 9: individual deletions apply immediately in full and incremental mode', async () => {
    const e = engine();
    await e.run();
    e.removeAtSource(id(2));
    const full = await e.run();
    assert.equal(full.lastSync.counts.removed, 1);
    await e.run({ mode: 'incremental' });
    e.removeAtSource(id(3), id(4));
    const inc = await e.run({ mode: 'incremental' });
    assert.equal(inc.lastSync.counts.removed, 2, `2 of 5 is not more than ${MASS_DELETION.maxFraction}`);
    assert.equal(inc.pendingDeletion, null);
  });

  test('a pending record written by the 1b.1 policy (no ids) is never treated as a confirmable sighting', async () => {
    const e = engine();
    e.removeAtSource(id(0), id(1), id(2), id(3));
    const legacy = { key: 'x'.repeat(32), origin: 'incremental', count: 4, held: 6, firstSeenAt: new Date(T0 - 10 * HOUR).toISOString() };
    const out = await runSync({
      ownerId: 'user:md', conn: { ...e.conn(), pendingDeletion: legacy }, connector: createFakeConnector({ world: e.world }),
      ctx: { connectionId: e.conn().connectionId, credentials: () => ({ accessToken: e.world.issue('acct').accessToken }) },
      external: { EXTERNAL_LIMITS: { resourcesPerSync: 100 }, listExternalResources: () => [...e.items.values()], syncExternalResources: async () => ({ results: [] }), deleteExternalResource: async () => ({ complete: true }) },
      retry: noRetry, now: e.time, mode: 'auto',
    });
    assert.equal(out.lastSync.mode, 'full', 'any pending deletion forces a full listing');
    assert.equal(out.lastSync.counts.removed, 0);
    assert.equal(out.pendingDeletion.origin, 'full');
  });
});

// ── service level (real ingest, fake connector world) ───────────────────────
describe('1b.2 mass-deletion policy (service)', () => {
  test('view: shows count, time and when it becomes confirmable — never ids or key; a credential failure resets', async () => {
    let t = T0;
    const now = () => t;
    const s = stack({ world: createFakeWorld({ now }), now });
    const userId = freshUser('md');
    const conn = await s.service.connect({ userId, connectorId: 'fake', input: { account: 'acct-1', code: 'ok' } });
    for (let i = 0; i < 4; i++) s.world.put('acct-1', id(i), { name: `${id(i)}.md`, content: doc(`Massdel${i}x`) });
    await s.service.sync({ userId, connectionId: conn.connectionId, mode: 'full' });
    for (let i = 0; i < 4; i++) s.world.remove('acct-1', id(i));
    await s.service.sync({ userId, connectionId: conn.connectionId, mode: 'full' });
    const v = await s.service.getConnection({ userId, connectionId: conn.connectionId });
    assert.deepEqual([v.pendingDeletion.count, v.pendingDeletion.origin], [4, 'full']);
    assert.equal(v.pendingDeletion.firstSeenAt, new Date(T0).toISOString());
    assert.equal(v.pendingDeletion.confirmableAt, new Date(T0 + HOUR).toISOString());
    assert.ok(!('ids' in v.pendingDeletion) && !('key' in v.pendingDeletion), 'ids or key exposed');
    assert.equal(external.listExternalResources(ownerOf(userId), `fake:${conn.connectionId}`).length, 4);

    // the refresh is refused → needs_reauth: a failed run resets the sequence
    t += 2 * HOUR;
    s.world.failures.refresh = true;
    await assert.rejects(() => s.service.sync({ userId, connectionId: conn.connectionId }), e => e.code === 'NEEDS_REAUTH');
    assert.equal(s.store._rawForTests()[0].pendingDeletion, null);
    assert.equal(external.listExternalResources(ownerOf(userId), `fake:${conn.connectionId}`).length, 4);
  });
});
