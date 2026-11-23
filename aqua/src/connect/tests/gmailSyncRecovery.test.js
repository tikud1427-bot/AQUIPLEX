/**
 * 2026-11-23 — sync recovery after the first real-mailbox test (every 403 was read as
 * "reconnect"; nothing was kept from a run that failed part-way).
 *
 *   R1 · Google error classification (real transport over a fake fetch with Google-shaped bodies)
 *   R2 · bounded retry: Retry-After, exponential backoff with jitter, attempt and time limits, stop
 *   R3 · batches persisted as they go (real service + engine + import pipeline over MOCK Gmail):
 *        order, later failures, restart without duplicates, disk / connection-store failures,
 *        rate limits, pause / disconnect during a retry, no stale resurrection
 *
 * MOCK GOOGLE ONLY.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const K = await import('./testkit.js');
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const u = new URL(String(url)); if (u.hostname !== '127.0.0.1') { egress.push(u.host); throw new Error('network refused'); } return realFetch(url, init); };

const F = await import('../testing/gmailFixtures.js');
const { createGmailConnector } = await import('../gmail/gmailConnector.js');
const { createGoogleGmailTransport, googleErrorOf } = await import('../gmail/googleGmailTransport.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { principalForServerJob } = await import('../principal.js');
const { withRetry, runSync, SyncStopped, RETRY } = await import('../syncEngine.js');
const { ConnectorError } = await import('../contract.js');
const EG = await import('../../core/egressGuard.js');
const ukoStore = await import('../../files/ukoStore.js');

const quiet = { log() {}, warn() {} };

// ══════════════════════════════════════════════════════════════════════════════
describe('R1 · Google error classification', () => {
  const body = (status, reason, extra = {}) => JSON.stringify({ error: { code: status, message: 'TOPSECRET provider text', ...(reason ? { errors: [{ domain: 'x', reason }] } : {}), status: 'PERMISSION_DENIED', ...extra } });
  const gmailWith = (status, payload, headers = {}) => {
    const t = createGoogleGmailTransport({ clientId: 'x.apps.googleusercontent.com', clientSecret: 'secret-xyz-123', redirectUri: 'https://a.test/api/aqua/connect/gmail/callback', fetch: async () => new Response(payload, { status, headers }) });
    return createGmailConnector({ transport: t });
  };
  const ctx = { connectionId: 'conn_x', credentials: () => ({ accessToken: 'a' }) };
  const errOf = async (status, payload, headers) => { try { await gmailWith(status, payload, headers).fetchResource(ctx, { externalId: 'msg:18d0000000000001' }); } catch (e) { return e; } assert.fail('expected a failure'); };

  const cases = [
    ['429 (no reason)', 429, '{}', 'TRANSIENT', true, null],
    ['429 rateLimitExceeded', 429, body(429, 'rateLimitExceeded'), 'TRANSIENT', true, 'rateLimitExceeded'],
    ['403 rateLimitExceeded', 403, body(403, 'rateLimitExceeded'), 'TRANSIENT', true, 'rateLimitExceeded'],
    ['403 userRateLimitExceeded', 403, body(403, 'userRateLimitExceeded'), 'TRANSIENT', true, 'userRateLimitExceeded'],
    ['403 insufficientPermissions', 403, body(403, 'insufficientPermissions'), 'AUTH', false, 'insufficientPermissions'],
    ['403 ACCESS_TOKEN_SCOPE_INSUFFICIENT (ErrorInfo detail)', 403, JSON.stringify({ error: { code: 403, message: 'x', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }), 'AUTH', false, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
    ['401', 401, body(401, 'authError'), 'AUTH', false, 'authError'],
    ['401 (no body)', 401, '', 'AUTH', false, null],
    ['403 unknown reason', 403, body(403, 'somethingBrandNew'), 'REFUSED', false, 'somethingBrandNew'],
    ['403 no reason at all', 403, '{}', 'REFUSED', false, null],
    ['403 dailyLimitExceeded', 403, body(403, 'dailyLimitExceeded'), 'REFUSED', false, 'dailyLimitExceeded'],
    ['403 reason with illegal characters', 403, body(403, '<script>alert(1)</script>'), 'REFUSED', false, null],
  ];
  for (const [label, status, payload, kind, rateLimited, reason] of cases) {
    test(label, async () => {
      const e = await errOf(status, payload);
      assert.equal(e.kind, kind);
      assert.equal(e.rateLimited === true, rateLimited);
      assert.equal(e.reason ?? null, reason, 'the structured reason survives');
      assert.equal(e.status, status);
      assert.doesNotMatch(e.message, /TOPSECRET|script/, 'never the provider\'s free text');
      if (kind === 'REFUSED') assert.match(e.message, reason === 'dailyLimitExceeded' ? /quota/ : /unrecognised reason/);
    });
  }

  test('an unknown 403 is never a rate limit, and never retried', async () => {
    let calls = 0;
    const t = createGoogleGmailTransport({ clientId: 'x.apps.googleusercontent.com', clientSecret: 'secret-xyz-123', redirectUri: 'https://a.test/api/aqua/connect/gmail/callback', fetch: async () => { calls++; return new Response(body(403, 'mystery'), { status: 403 }); } });
    const c = createGmailConnector({ transport: t });
    await assert.rejects(withRetry(() => c.fetchResource(ctx, { externalId: 'msg:18d0000000000001' }), { sleep: async () => {} }), e => e.kind === 'REFUSED' && !e.rateLimited);
    assert.equal(calls, 1);
  });

  test('Retry-After on a 403 rate limit travels to the engine', async () => {
    const e = await errOf(403, body(403, 'userRateLimitExceeded'), { 'retry-after': '3' });
    assert.equal(e.retryAfterMs, 3000);
  });

  test('googleErrorOf keeps only identifier-shaped codes', () => {
    assert.deepEqual(googleErrorOf({ error: { errors: [{ reason: 'rateLimitExceeded' }], status: 'RESOURCE_EXHAUSTED' } }), { reason: 'rateLimitExceeded', googleStatus: 'RESOURCE_EXHAUSTED' });
    assert.deepEqual(googleErrorOf({ error: { errors: [{ reason: 'a b c' }], status: 'x y' } }), { reason: null, googleStatus: null });
    assert.deepEqual(googleErrorOf('<html>'), { reason: null, googleStatus: null });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('R2 · bounded retry', () => {
  const rl = (extra = {}) => Object.assign(new ConnectorError('TRANSIENT', 'Gmail rate limit (403 userRateLimitExceeded)', { status: 403, reason: 'userRateLimitExceeded', rateLimited: true }), extra);
  const failing = (mk, n = Infinity) => { let calls = 0; return { fn: async () => { calls++; if (calls <= n) throw mk(); return 'ok'; }, calls: () => calls }; };

  test('Retry-After is honoured exactly', async () => {
    const f = failing(() => rl({ retryAfterMs: 1500 }), 1);
    const slept = [];
    assert.equal(await withRetry(f.fn, { sleep: async ms => { slept.push(ms); } }), 'ok');
    assert.deepEqual(slept, [1500]);
  });

  test('a Retry-After longer than the bound ends the attempt at once (no sleep)', async () => {
    const f = failing(() => rl({ retryAfterMs: 120_000 }));
    const slept = [];
    await assert.rejects(withRetry(f.fn, { sleep: async ms => { slept.push(ms); } }), e => e.rateLimited);
    assert.deepEqual([slept, f.calls()], [[], 1]);
  });

  test('rate limits: exponential backoff with equal jitter, at most RETRY.rateLimitAttempts tries', async () => {
    for (const [r, expected] of [[() => 1, [1000, 2000, 4000, 8000]], [() => 0, [500, 1000, 2000, 4000]]]) {
      const f = failing(() => rl());
      const slept = [];
      await assert.rejects(withRetry(f.fn, { sleep: async ms => { slept.push(ms); }, random: r }), e => e.rateLimited);
      assert.deepEqual(slept, expected);
      assert.equal(f.calls(), RETRY.rateLimitAttempts);
    }
  });

  test('each delay is capped (maxDelayMs) and the total wait is bounded (maxElapsedMs)', async () => {
    const f = failing(() => rl());
    const slept = [];
    await assert.rejects(withRetry(f.fn, { sleep: async ms => { slept.push(ms); }, random: () => 1, rateLimitBaseMs: 20_000, maxElapsedMs: 60_000 }));
    assert.deepEqual(slept, [20_000, 32_000], 'third wait would pass 60 s in total');
    assert.equal(f.calls(), 3);
  });

  test('other transient failures keep the shorter budget (3 tries)', async () => {
    const f = failing(() => new ConnectorError('TRANSIENT', 'Gmail is unavailable (503)'));
    await assert.rejects(withRetry(f.fn, { sleep: async () => {} }));
    assert.equal(f.calls(), 3);
  });

  test('authorisation and refused failures are never retried', async () => {
    for (const kind of ['AUTH', 'REFUSED', 'PERMANENT']) {
      const f = failing(() => new ConnectorError(kind, kind));
      await assert.rejects(withRetry(f.fn, { sleep: async () => { assert.fail('slept'); } }), e => e.kind === kind);
      assert.equal(f.calls(), 1);
    }
  });

  test('a stopped connection ends the retry before any wait (SyncStopped)', async () => {
    const f = failing(() => rl());
    await assert.rejects(withRetry(f.fn, { sleep: async () => { assert.fail('slept'); }, shouldContinue: async () => false }), e => e instanceof SyncStopped && e.stopped === true);
    assert.equal(f.calls(), 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
const T0 = Date.parse('2025-03-01T00:00:00Z');
const gid = i => `18e${i.toString(16).padStart(13, '0')}`;
const message = i => F.buildMessage({
  id: gid(i), threadId: `t${i}`, date: new Date(T0 + i * 60_000).toUTCString(),
  headers: { From: 'Priya Sharma <priya@acme.example>', To: 'Raj Mehta <raj@acme.example>', Subject: `Item ${i}`, 'Message-ID': `<r${i}@acme.example>` },
  text: `I'll send item number ${i} by Monday.`,
});
const gErr = (status, reason, extra = {}) => Object.assign(new Error(`Google request failed (${status})`), { status, ...(reason ? { reason } : {}), ...extra });

/**
 * A mailbox of n messages behind the real Gmail connector, with:
 *   inject(fetchNo) → an error to throw for the n-th getMessage(format full) call (or null);
 *   a log of fetch / import / flush / persist events; switchable flush and store failures.
 */
async function mailbox(n, { pageSize = 50 } = {}) {
  const mock = createMockGmailService({ now: Date.now });
  const acct = `rc-${crypto.randomBytes(4).toString('hex')}@example.test`;
  for (let i = 0; i < n; i++) mock.addMessage(acct, message(i));
  const log = [];
  const h = { inject: () => null, failFlush: () => false, failProgress: () => false, onSleep: null, fetchNo: 0 };
  const transport = {
    ...mock.transport,
    async getMessage(token, id, opts = {}) {
      if (opts.format === 'full') {
        h.fetchNo++;
        const e = h.inject(h.fetchNo, id);
        if (e) { log.push('fetch-fail'); throw e; }
        log.push('fetch');
      }
      return mock.transport.getMessage(token, id, opts);
    },
  };
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  registry.register(createGmailConnector({ transport, pageSize }));
  const store = K.createMemoryConnectionStore();
  const realUpdate = store.update.bind(store);
  store.update = async (o, i, patch, opts) => {
    if (patch && Object.keys(patch).length === 1 && patch.fullSync?.cursor) {
      if (h.failProgress()) { log.push('persist-fail'); throw new Error('mongo write failed'); }
      log.push('persist');
    }
    return realUpdate(o, i, patch, opts);
  };
  const external = {
    ...K.external,
    async syncExternalResources(a) { log.push(`import:${a.resources.length}`); return K.external.syncExternalResources(a); },
    async flushImports() { if (h.failFlush()) { log.push('flush-fail'); throw new Error('disk full'); } log.push('flush'); return K.external.flushImports(); },
  };
  const slept = [];
  const vault = K.createCredentialVault({ key: K.TEST_KEY });
  const mk = () => K.createConnectService({
    registry, store, vault, external, log: quiet,
    retry: { baseMs: 0, random: () => 1, sleep: async ms => { slept.push(ms); if (h.onSleep) await h.onSleep(ms); } },
  });
  const service = mk();
  const user = `rc-${crypto.randomBytes(5).toString('hex')}`;
  const principal = principalForServerJob(user);
  const owner = `user:${user}`;
  const conn = await service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode(acct) } });
  const id = conn.connectionId;
  const sourceId = (await store.get(owner, id)).sourceId;
  return {
    mock, acct, h, log, slept, service, mk, store, registry, external, principal, owner, id, sourceId, n,
    sync: (svc = service) => svc.sync({ principal, connectionId: id }),
    record: () => store.get(owner, id),
    held: () => EG.runWithDataClass('user', () => K.external.listExternalResources(owner, sourceId).map(x => x.externalId).sort()),
    ukoCount: () => EG.runWithDataClass('user', () => ukoStore.listUKOs(owner, { limit: 1e6, includeRestricted: true }).filter(u => u.id.startsWith('ext_')).length),
    expected: () => mock.messageIds(acct).map(m => `msg:${m}`).sort(),
  };
}
const exactlyOnce = s => {
  const held = s.held();
  assert.equal(new Set(held).size, held.length);
  assert.deepEqual(held, s.expected());
  assert.equal(s.ukoCount(), held.length, 'one stored version per message');
};
const syncUntilDone = async (s, max = 20) => { let r; for (let i = 0; i < max; i++) { r = await s.sync(); if (!r.lastSync?.more) break; } return r; };

describe('R3 · batches persisted as they go', () => {
  test('each batch is imported, flushed and its position saved BEFORE the next batch is fetched', async () => {
    const s = await mailbox(250);
    const r = await s.sync();
    assert.equal(r.lastSync.state, 'succeeded');
    exactlyOnce(s);
    const i101 = s.log.findIndex((e, i) => e === 'fetch' && s.log.slice(0, i + 1).filter(x => x === 'fetch').length === 101);
    const before = s.log.slice(0, i101);
    assert.deepEqual(before.filter(e => e !== 'fetch'), ['import:100', 'flush', 'persist'], 'batch 1 imported, durable and its position saved first');
    assert.equal(before.filter(e => e === 'fetch').length, 100);
  });

  test('a later batch fails (401): the earlier batch stays imported and durable; its position is saved; status needs_reauth', async () => {
    const s = await mailbox(250);
    s.h.inject = n => (n === 150 ? gErr(401, 'authError') : null);
    const r = await s.sync();
    assert.equal(r.status, 'needs_reauth');
    assert.match(r.lastSync.error, /401 authError/);
    assert.equal(s.held().length, 100, 'batch 1 kept');
    const rec = await s.record();
    assert.ok(rec.fullSync?.cursor, 'position saved after batch 1');
    assert.equal(rec.checkpoint, null, 'initial sync not complete');
  });

  test('a later batch hits an UNKNOWN 403: status unchanged, explicit error, batch 1 kept; the next run resumes without re-importing', async () => {
    const s = await mailbox(250);
    s.h.inject = n => (n === 150 ? gErr(403, 'somethingBrandNew') : null);
    const r1 = await s.sync();
    assert.equal(r1.status, 'active', 'no reconnect demanded for an unknown 403');
    assert.match(r1.lastSync.error, /unrecognised reason \(403 somethingBrandNew\)/);
    assert.equal(s.held().length, 100);
    s.h.inject = () => null;
    const fetchesBefore = s.h.fetchNo;
    const r2 = await syncUntilDone(s);
    assert.equal(r2.lastSync.state, 'succeeded');
    exactlyOnce(s);
    assert.equal(s.h.fetchNo - fetchesBefore, 150, 'resumed after batch 1: the 100 imported are not fetched again');
    assert.equal(r2.lastSync.counts.unchanged ?? 0, 0);
  });

  test('a restart (new service = new process) resumes from the saved position without duplicates', async () => {
    const s = await mailbox(330);
    s.h.inject = n => (n === 260 ? gErr(403, 'mystery') : null);
    await s.sync();
    assert.equal(s.held().length, 200);
    s.h.inject = () => null;
    const svc2 = s.mk();
    let r;
    for (let i = 0; i < 10; i++) { r = await s.sync(svc2); if (!r.lastSync.more) break; }
    assert.equal(r.lastSync.state, 'succeeded');
    exactlyOnce(s);
  });

  test('a transient rate limit (403 userRateLimitExceeded) is retried with backoff, pacing widens, and the sync succeeds', async () => {
    const s = await mailbox(120);
    let hits = 0, target = null;
    s.h.inject = (n, id) => { if (n === 40) target = id; return id === target && hits++ < 2 ? gErr(403, 'userRateLimitExceeded') : null; };
    const r = await s.sync();
    assert.equal(r.lastSync.state, 'succeeded');
    exactlyOnce(s);
    assert.ok(s.slept.includes(1000) && s.slept.includes(2000), `backoff waits: ${[...new Set(s.slept)]}`);
    assert.ok(s.slept.some(ms => ms >= 250 && ms < 1000), 'the fetch pace widened after the rate limit');
    // Phase 4B: recovered retries are recorded — status and Google's reason code only.
    assert.deepEqual(r.lastSync.retries, { total: 2, rateLimited: 2, byStatus: { 403: 2 }, byReason: { userRateLimitExceeded: 2 } });
    const stored = JSON.stringify((await s.record()).lastSync.retries);
    assert.doesNotMatch(stored, /Bearer|token|item number/i, 'no token or content in the record');
  });

  test('a persistent rate limit stops the run cleanly: bounded tries, status unchanged, earlier batch kept', async () => {
    const s = await mailbox(250);
    s.h.inject = n => (n >= 150 ? gErr(429, 'rateLimitExceeded') : null);
    const r = await s.sync();
    assert.equal(r.status, 'active');
    assert.match(r.lastSync.error, /kept rate-limiting/);
    assert.equal(s.held().length, 100);
    assert.equal(s.h.fetchNo, 149 + RETRY.rateLimitAttempts, 'exactly the bounded number of tries on the failing message');
  });

  test('a disk write failure prevents the position from advancing', async () => {
    const s = await mailbox(250);
    let flushes = 0;
    s.h.failFlush = () => ++flushes === 2;   // batch 2's flush fails
    const r = await s.sync();
    assert.equal(r.lastSync.state, 'failed');
    assert.match(r.lastSync.error, /could not be made durable/);
    const persisted = s.log.filter(e => e === 'persist').length;
    assert.equal(persisted, 1, 'only batch 1\'s position was saved');
    const cursorAfterBatch1 = (await s.record()).fullSync.cursor;
    assert.ok(cursorAfterBatch1);
    s.h.failFlush = () => false;
    const r2 = await syncUntilDone(s);
    assert.equal(r2.lastSync.state, 'succeeded');
    exactlyOnce(s);
  });

  test('a connection-store (MongoDB) failure while saving the position: run stops safely, nothing lost, no duplicates', async () => {
    const s = await mailbox(250);
    let saves = 0;
    s.h.failProgress = () => ++saves === 2;
    const r = await s.sync();
    assert.equal(r.lastSync.state, 'failed');
    assert.match(r.lastSync.error, /position could not be saved/);
    assert.equal(s.held().length, 200, 'both imported batches are kept (idempotent on retry)');
    s.h.failProgress = () => false;
    const r2 = await syncUntilDone(s);
    assert.equal(r2.lastSync.state, 'succeeded');
    exactlyOnce(s);
  });

  test('disconnect DURING a rate-limit retry: the retry stops, nothing more is imported, everything is deleted', async () => {
    const s = await mailbox(250);
    s.h.inject = n => (n >= 150 ? gErr(403, 'rateLimitExceeded') : null);
    let disconnecting = null;
    s.h.onSleep = async ms => { if (ms >= 500 && !disconnecting) disconnecting = s.service.disconnect({ principal: s.principal, connectionId: s.id }); };
    const r = await s.sync();
    assert.equal(r.aborted, true, 'the run stopped at the retry');
    const importsBefore = s.log.filter(e => e.startsWith('import:')).length;
    await disconnecting;
    assert.equal(s.log.filter(e => e.startsWith('import:')).length, importsBefore, 'nothing imported after the request');
    assert.equal(s.ukoCount(), 0);
    assert.equal(await s.record(), null);
    assert.ok(s.h.fetchNo < 149 + RETRY.rateLimitAttempts, 'the retry did not run to exhaustion');
  });

  test('pause DURING a sync: the run stops at the next request; resume + sync completes exactly once', async () => {
    const s = await mailbox(250);
    let pausing = null;
    s.h.inject = n => { if (n === 120 && !pausing) pausing = s.service.pauseSync({ principal: s.principal, connectionId: s.id }); return null; };
    const r = await s.sync();
    assert.equal(r.aborted, true);
    assert.equal(s.h.fetchNo, 120, 'no Gmail request after the pause was requested');
    await pausing;
    assert.equal((await s.record()).syncPaused, true);
    assert.equal(s.held().length, 100, 'batch 1 kept; nothing after the pause request');
    await assert.rejects(s.sync(), e => e.code === 'PAUSED');
    await s.service.resumeSync({ principal: s.principal, connectionId: s.id });
    const r2 = await syncUntilDone(s);
    assert.equal(r2.lastSync.state, 'succeeded');
    exactlyOnce(s);
  });

  test('a pause written by ANOTHER instance (only the stored flag changes) stops the run before its next import', async () => {
    const s = await mailbox(250);
    s.h.inject = n => { if (n === 120) s.store.update(s.owner, s.id, { syncPaused: true }); return null; };
    const r = await s.sync();
    assert.equal(r.aborted, true);
    assert.equal(s.held().length, 100, 'batch 2 was not imported after the pause');
  });

  test('no stale process can resurrect deleted records', async () => {
    const s = await mailbox(150);
    const rec = await s.record();
    const token = (await s.mock.transport.exchangeCode({ code: s.mock.authorizeCode(s.acct) })).accessToken;
    await s.sync();
    assert.equal(s.held().length, 150);
    await s.service.disconnect({ principal: s.principal, connectionId: s.id });
    assert.equal(s.ukoCount(), 0);
    // A second process that missed the disconnect: the service finds nothing…
    await assert.rejects(s.sync(s.mk()), e => e.code === 'NOT_FOUND');
    // …and a stale engine run holding the old record and a live token is stopped by the guard before any import.
    const connector = s.registry.get('gmail');
    const out = await runSync({
      ownerId: s.owner, conn: rec, connector, ctx: { connectionId: s.id, credentials: () => ({ accessToken: token }) },
      external: s.external, retry: { sleep: async () => {} },
      guard: async () => Boolean(await s.store.get(s.owner, s.id)),
      persistProgress: async () => { throw new SyncStopped(); },
    });
    assert.equal(out.aborted, true);
    assert.equal(s.ukoCount(), 0, 'nothing came back');
  });
});

describe('isolation', () => {
  test('no request left the machine; no provider attempt with Gmail in scope', () => {
    assert.deepEqual(egress, []);
    assert.equal(JSON.stringify(EG.egressStats()).includes('external:gmail'), false);
  });
});
