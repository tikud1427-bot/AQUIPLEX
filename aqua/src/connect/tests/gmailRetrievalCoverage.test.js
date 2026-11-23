/**
 * Phase 4B (2026-11-23) — category-aware retrieval.
 *
 * On the first real mailbox, 6,648 document links filled the single 2,000-item window and the
 * Email views showed 41 of 180 commitments. This reproduces that shape through the REAL sync +
 * ingest + understanding path (mock Gmail): many NEWER link-heavy newsletters above OLDER
 * messages that hold the real knowledge. Proves: the old global window is crowded; the
 * per-category budgets show everything; pagination reaches every item; every item opens its
 * evidence; states (current / superseded / contradicted) and basis survive; owner isolation.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const K = await import('./testkit.js');
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const u = new URL(String(url)); if (u.hostname !== '127.0.0.1') { egress.push(u.host); throw new Error('network refused'); } return realFetch(url, init); };

const F = await import('../testing/gmailFixtures.js');
const { createGmailConnector } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { principalForServerJob } = await import('../principal.js');
const C = await import('../gmail/emailContext.js');
const I = await import('../gmail/emailIntelligence.js');
const EG = await import('../../core/egressGuard.js');

const T0 = Date.parse('2025-06-02T09:00:00Z');
const gid = i => `18c${i.toString(16).padStart(13, '0')}`;
const PRIYA = 'Priya Sharma <priya@acme.example>', RAJ = 'Raj Mehta <raj@acme.example>';
const msg = (i, o) => F.buildMessage({ id: gid(i), threadId: o.thread ?? `t${i}`, date: new Date(T0 + i * 60_000).toUTCString(), headers: { From: o.from ?? PRIYA, To: o.to ?? RAJ, Subject: o.subject ?? `Item ${i}`, 'Message-ID': `<c${i}@acme.example>` }, text: o.text });
const links = i => Array.from({ length: 10 }, (_, k) => `https://news.example.com/story/${i}/${k}?utm_source=digest`).join('\n');

let world;
before(async () => {
  const build = async (mailbox) => {
    const mock = createMockGmailService({ now: Date.now });
    const acct = `rc-${crypto.randomBytes(4).toString('hex')}@example.test`;
    for (const [i, o] of mailbox) mock.addMessage(acct, msg(i, o));
    const registry = K.createConnectorRegistry({ allowTestOnly: true });
    registry.register(createGmailConnector({ transport: mock.transport }));
    const service = K.createConnectService({ registry, store: K.createMemoryConnectionStore(), vault: K.createCredentialVault({ key: K.TEST_KEY }), log: { log() {}, warn() {} }, retry: { sleep: async () => {}, baseMs: 0 } });
    const user = `rc-${crypto.randomBytes(5).toString('hex')}`;
    const principal = principalForServerJob(user);
    const conn = await service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode(acct) } });
    for (let r = 0; r < 10; r++) { const out = await service.sync({ principal, connectionId: conn.connectionId }); if (!out.lastSync.more) break; }
    return { principal };
  };
  const mailbox = [];
  // OLDER: 300 messages with a commitment and a request each, plus a decision that is later changed
  // and two contradicting statements of the same launch date.
  for (let i = 0; i < 300; i++) mailbox.push([i, { text: `Hi Raj, I'll send report number ${i} to the board. Could you review section ${i} of the plan?` }]);
  mailbox.push([300, { thread: 'thr-storage', subject: 'Storage', text: 'We decided to use Postgres for storage.' }]);
  mailbox.push([301, { thread: 'thr-storage', subject: 'Re: Storage', text: 'Actually, we have decided to use MySQL instead.' }]);
  mailbox.push([302, { thread: 'thr-launch', subject: 'Launch', text: 'The launch is March 15.' }]);
  mailbox.push([303, { thread: 'thr-launch', subject: 'Re: Launch', from: RAJ, to: PRIYA, text: 'The launch is March 20.' }]);
  // The same project named in two different threads (and twice in one): ONE project in the list.
  mailbox.push([304, { thread: 'thr-atlas-1', subject: 'Atlas', text: 'Project Atlas kicks off next week.' }]);
  mailbox.push([305, { thread: 'thr-atlas-1', subject: 'Re: Atlas', text: 'Project Atlas budget is approved by finance.' }]);
  mailbox.push([306, { thread: 'thr-atlas-2', subject: 'Atlas hiring', text: 'Project Atlas needs two more engineers.' }]);
  // NEWER: 260 link-heavy newsletters (2,600 document links) from a person, no statements.
  for (let i = 400; i < 660; i++) mailbox.push([i, { subject: `Digest ${i}`, text: `Weekly reading list.\n${links(i)}` }]);
  const a = await build(mailbox);
  const b = await build([[9000, { text: "I'll send the other owner's report by Friday." }]]);
  world = { a, b };
});

const asUser = fn => EG.runWithDataClass('user', fn);

describe('B · category-aware retrieval', () => {
  test('B1 · the OLD single window is crowded by links; the category budgets show every commitment and request', () => {
    const old = asUser(() => C.retrieveEmailEvidence({ principal: world.a.principal, limit: C.MAX_EVIDENCE }));
    const ov = asUser(() => I.overview({ principal: world.a.principal, now: T0 }));
    assert.ok(old.openCommitments.length < 300, `old window showed ${old.openCommitments.length} of 300 (reproduces the defect)`);
    assert.equal(ov.counts.openCommitments, 300);
    assert.equal(ov.counts.openTasks, 300);
    assert.deepEqual(ov.coverage.commitment, { found: 300, shown: 300, truncated: false });
    assert.equal(ov.coverage.document.truncated, true, 'links are bounded separately — and that truncation is reported');
    assert.ok(ov.coverage.document.found >= 2600);
  });

  test('B2 · pagination reaches every item exactly once; every item opens its evidence with provenance', () => {
    for (const v of ['commitments', 'tasks']) {
      const seen = new Set();
      for (let c = 0; ; c += 50) {
        const p = asUser(() => I.view({ principal: world.a.principal, view: v, limit: 50, cursor: c, now: T0 }));
        for (const it of p.items) {
          assert.ok(!seen.has(it.id), 'no item twice');
          seen.add(it.id);
          assert.ok(it.source.gmailMessageId && it.source.sentAt && it.source.extractedAt && it.evidenceIds.includes(it.id));
        }
        if (p.nextCursor == null) break;
      }
      assert.equal(seen.size, 300, v);
      for (const id of [...seen].slice(0, 300)) {
        const d = asUser(() => I.evidenceDetail({ principal: world.a.principal, id, now: T0 }));
        assert.ok(d && d.evidence.quote && d.evidence.span.length === 2 && d.evidence.gmailMessageId, `evidence for ${id}`);
      }
    }
  });

  test('B3 · states and basis survive category selection (current / superseded / contradicted; direct vs inference)', () => {
    const sup = asUser(() => I.view({ principal: world.a.principal, view: 'superseded', limit: 50, cursor: 0, now: T0 }));
    assert.deepEqual(sup.items.map(i => [i.status, i.statement]), [['superseded', 'We decided to use Postgres for storage.']]);
    const dec = asUser(() => I.view({ principal: world.a.principal, view: 'decisions', limit: 50, cursor: 0, now: T0 }));
    assert.deepEqual(dec.items.map(i => i.statement), ['Actually, we have decided to use MySQL instead.']);
    const con = asUser(() => I.view({ principal: world.a.principal, view: 'contradictions', limit: 50, cursor: 0, now: T0 }));
    assert.equal(con.total, 1);
    assert.ok(con.items[0].items.every(i => i.status === 'contradicted' && i.userConfirmed === false));
    const c = asUser(() => I.view({ principal: world.a.principal, view: 'commitments', limit: 5, cursor: 0, now: T0 }));
    assert.ok(c.items.every(i => i.basis === 'direct' && i.explicit === true && i.userConfirmed === false));
  });

  test('B3b · one project per name across threads, with every thread it appears in', () => {
    const p = asUser(() => I.view({ principal: world.a.principal, view: 'projects', limit: 50, cursor: 0, now: T0 }));
    const atlas = p.projects.filter(x => /atlas/i.test(x.name));
    assert.equal(atlas.length, 1, JSON.stringify(p.projects.map(x => x.name)));
    const b = asUser(() => C.retrieveEmailEvidence({ principal: world.a.principal, perType: I.CATEGORY_LIMITS }));
    const rel = b.relationships.projects.find(x => /atlas/i.test(x.name));
    assert.deepEqual([rel.threadIds.length, rel.mentions], [2, 2], 'corroborating repeat in thread 1 is not a new mention');
  });

  test('B4 · owner isolation: the other owner sees only their own item; ids of A are not found for B', () => {
    const ovB = asUser(() => I.overview({ principal: world.b.principal, now: T0 }));
    assert.equal(ovB.counts.openCommitments, 1);
    const idA = asUser(() => I.view({ principal: world.a.principal, view: 'commitments', limit: 1, cursor: 0, now: T0 })).items[0].id;
    assert.equal(asUser(() => I.evidenceDetail({ principal: world.b.principal, id: idA, now: T0 })), null);
  });

  test('B5 · no egress; no provider attempt with Gmail in scope', () => {
    assert.deepEqual(egress, []);
    assert.equal(JSON.stringify(EG.egressStats()).includes('external:gmail'), false);
  });
});
