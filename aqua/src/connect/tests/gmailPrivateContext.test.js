/**
 * Gmail Phase 4 — private context layer and evidence-backed retrieval.
 *
 * Real ingest path (mock Gmail → connect service → sync → fileEngine knowledge
 * stages → restricted UKO) → emailContext.retrieveEmailEvidence → the
 * fake-model harness; plus the boundaries around it: prepareTurn (every chat
 * lane), the claim writer (document understanding), provider egress, owner
 * isolation, deletion, account purge, concurrency. No network, no provider.
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
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { principalForServerJob } = await import('../principal.js');
const { retrieveEmailEvidence, formatEmailEvidenceForPrompt, emailUnderstandingFor } = await import('../gmail/emailContext.js');
const { answerWithEmailEvidence } = await import('../testing/emailAnswerHarness.js');
const EG = await import('../../core/egressGuard.js');

const PRIYA = 'Priya Sharma <priya@acme.example>', RAJ = 'Raj Mehta <raj@acme.example>';
const NOW = Date.parse('2026-01-06T00:00:00Z');
const mail = (id, o) => F.buildMessage({ id, threadId: o.thread ?? 'thr-launch', date: o.date, headers: { From: o.from ?? PRIYA, To: o.to ?? RAJ, Subject: o.subject ?? 'Launch plan', 'Message-ID': `<${id}@acme.example>` }, text: o.text });
const MAILBOX = [
  ['18d0000000000001', { date: 'Mon, 5 Jan 2026 09:00:00 +0000', text: "I'll send the deck by Monday. We decided to use Postgres for storage. CANARY_P4_A" }],
  ['18d0000000000002', { date: 'Mon, 5 Jan 2026 12:00:00 +0000', from: RAJ, to: PRIYA, subject: 'Re: Launch plan', text: 'The launch is March 15. CANARY_P4_B' }],
  ['18d0000000000003', { date: 'Tue, 6 Jan 2026 09:00:00 +0000', text: "Update: I'll send it by Wednesday instead. Actually, we have decided to use MySQL instead. The launch is March 20. CANARY_P4_C" }],
  ['18d0000000000004', { date: 'Tue, 6 Jan 2026 10:00:00 +0000', thread: 'thr-atlas', subject: 'Atlas kickoff', text: 'Project Atlas kickoff call on Thursday at 10am. Raj, please review the budget by Friday. CANARY_P4_D' }],
];
// Words that occur ONLY in the email bodies/headers (never in the question asked in E4).
const CANARIES = ['CANARY_P4_A', 'CANARY_P4_B', 'CANARY_P4_C', 'CANARY_P4_D', 'Postgres', 'MySQL', 'March 20', 'Atlas', 'priya@acme.example', 'raj@acme.example'];

async function stack({ mailbox = MAILBOX } = {}) {
  const mock = createMockGmailService({ now: Date.now });
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  registry.register(createGmailConnector({ transport: mock.transport, pageSize: 10 }));
  const store = K.createMemoryConnectionStore();
  const service = K.createConnectService({ registry, store, vault: K.createCredentialVault({ key: K.TEST_KEY }), log: { log() {}, warn() {} }, retry: { sleep: async () => {}, baseMs: 0 } });
  const user = `p4-${crypto.randomBytes(5).toString('hex')}`;
  const principal = principalForServerJob(user);
  const acct = `${user}@example.test`;
  for (const [id, o] of mailbox) mock.addMessage(acct, mail(id, o));
  const conn = await service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode(acct) } });
  await service.sync({ principal, connectionId: conn.connectionId });
  return { mock, service, store, user, owner: `user:${user}`, principal, acct, conn };
}
const byStatement = (b, re) => b.evidence.find(e => re.test(e.statement ?? ''));

// ══════════════════════════════════════════════════════════════════════════════
describe('B/D · the private context layer (retrieveEmailEvidence)', () => {
  test('B1 · decisions current vs superseded; open commitments exclude superseded ones; contradictions grouped', async () => {
    const s = await stack();
    const b = retrieveEmailEvidence({ principal: s.principal, now: NOW, limit: 100 });
    const pg = byStatement(b, /Postgres/), my = byStatement(b, /MySQL/);
    assert.deepEqual(b.decisions.current, [my.ref]);
    assert.deepEqual(b.decisions.superseded, [{ ref: pg.ref, supersededBy: my.ref }]);
    const wed = byStatement(b, /by Wednesday instead/), mon = byStatement(b, /deck by Monday/);
    assert.deepEqual(b.openCommitments, [wed.ref]);
    assert.equal(mon.status, 'superseded');
    const l15 = byStatement(b, /March 15/), l20 = byStatement(b, /March 20/);
    assert.deepEqual(b.contradictions, [[l15.ref, l20.ref].sort()]);
    assert.ok([l15, l20].every(e => e.status === 'contradicted' && e.userConfirmed === false));
  });

  test('B2 · relationships: people ↔ threads, organisation (inferred from the domain), project, topics; tasks with assignees; upcoming dates', async () => {
    const s = await stack();
    const b = retrieveEmailEvidence({ principal: s.principal, now: NOW, limit: 100 });
    const priya = b.relationships.people.find(p => p.key === 'person:priya@acme.example');
    assert.deepEqual(priya.threads.sort(), ['thr-atlas', 'thr-launch']);
    assert.deepEqual(b.relationships.organizations.map(o => [o.domain, o.basis]), [['acme.example', 'inference']]);
    assert.deepEqual(b.relationships.projects.map(p => [p.name, p.threadId]), [['Atlas', 'thr-atlas']]);
    assert.deepEqual(b.relationships.topics.map(t => t.topic).sort(), ['atlas kickoff', 'launch plan']);
    const task = byStatement(b, /review the budget/);
    assert.deepEqual(b.openTasks, [task.ref]);
    assert.deepEqual(task.assignee, { status: 'resolved', person: 'person:raj@acme.example' });
    // Tue 6 Jan → Wednesday 7, Thursday (kickoff) 8, Friday (budget) 9; the superseded Monday promise is not upcoming.
    assert.deepEqual(b.upcoming.map(u => u.due), ['2026-01-07', '2026-01-08', '2026-01-09', '2026-03-15', '2026-03-20']);
  });

  test('B3 · evidence completeness: every item has message, thread, timestamps, field, span, quote, basis, certainty, classification', async () => {
    const s = await stack();
    const b = retrieveEmailEvidence({ principal: s.principal, now: NOW, limit: 100 });
    assert.ok(b.evidence.length >= 10);
    for (const e of b.evidence) {
      for (const k of ['gmailMessageId', 'threadId', 'sourceTimestamp', 'extractedAt', 'field', 'span', 'quote']) assert.ok(e.provenance[k] != null, `${e.ref} lacks ${k}`);
      assert.ok(['direct', 'inference'].includes(e.basis));
      assert.equal(e.basis === 'direct', e.explicit === true && e.certainty === 'stated');
      assert.equal(e.classification, 'external:gmail');
    }
    assert.equal(byStatement(b, /review the budget/).basis, 'direct', 'a named request is direct');
    assert.equal(byStatement(b, /kickoff call/).basis, 'inference', 'an unconfirmed meeting is inference');
  });

  test('B4 · relevance is local token overlap: "what did Priya commit to" puts her current commitment first-tier', async () => {
    const s = await stack();
    const b = retrieveEmailEvidence({ principal: s.principal, question: 'What did Priya promise about the deck?', now: NOW });
    assert.equal(b.evidence[0].type, 'commitment');
    assert.match(b.evidence[0].statement, /Wednesday/);
    assert.ok(!b.evidence.some(e => /review the budget/.test(e.statement)), 'unrelated items are not returned');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('D · authorisation and isolation', () => {
  test('D1 · cross-owner isolation; an ownerId in the request is ignored; a forged principal is refused', async () => {
    const a = await stack();
    const b = await stack({ mailbox: [['18d0000000000099', { date: 'Mon, 5 Jan 2026 09:00:00 +0000', text: 'We decided to hire. CANARY_P4_OTHER' }]] });
    const ra = retrieveEmailEvidence({ principal: a.principal, ownerId: b.owner, userId: b.user, now: NOW, limit: 100 });
    assert.ok(!JSON.stringify(ra).includes('decided to hire'), 'B\'s mail never appears for A');
    assert.ok(JSON.stringify(ra).includes('Postgres for storage'), 'A\'s own mail does');
    assert.throws(() => retrieveEmailEvidence({ principal: { userId: a.user } }), e => e.code === 'UNAUTHENTICATED');
    assert.deepEqual(retrieveEmailEvidence({ principal: principalForServerJob('nobody'), now: NOW }).evidence, []);
  });

  test('D2 · cache isolation: byte-identical mail at two owners stays two owners\' (deleting one never touches the other)', async () => {
    const a = await stack(), b = await stack();
    await a.service.disconnect({ principal: a.principal, connectionId: a.conn.connectionId });
    assert.deepEqual(retrieveEmailEvidence({ principal: a.principal, now: NOW }).evidence, []);
    assert.ok(retrieveEmailEvidence({ principal: b.principal, now: NOW, limit: 100 }).evidence.length >= 10);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('E/F · the provider boundary', () => {
  test('E1 · reading email evidence taints the request: every real provider is refused afterwards, in the same request', async () => {
    const s = await stack();
    await EG.runWithDataClass('user', async () => {
      assert.doesNotThrow(() => EG.assertEgress('groq', 'generate'));
      retrieveEmailEvidence({ principal: s.principal, now: NOW });
      for (const p of ['groq', 'gemini', 'nvidia', 'openrouter']) for (const op of ['generate', 'stream', 'embed']) {
        assert.throws(() => EG.assertEgress(p, op), e => e.code === 'EGRESS_BLOCKED', `${p}/${op}`);
      }
    });
  });

  test('E2 · the prompt formatter refuses outside a gmail-tainted request (it cannot be used to build a provider-bound prompt)', async () => {
    const s = await stack();
    const bundle = await EG.runWithDataClass('user', async () => retrieveEmailEvidence({ principal: s.principal, now: NOW }));
    await EG.runWithDataClass('user', async () => {
      assert.throws(() => formatEmailEvidenceForPrompt(bundle), e => e.code === 'EMAIL_SCOPE_REQUIRED');
    });
    assert.throws(() => formatEmailEvidenceForPrompt(bundle), e => e.code === 'EMAIL_SCOPE_REQUIRED', 'no scope at all');
  });

  test('E3 · isolated proof with a FAKE model: evidence → cited answer; real providers refused in that request; validation catches bad answers', async () => {
    const s = await stack();
    const seen = [];
    const fake = async ({ system, evidence }) => {
      seen.push(system);
      const c = evidence.find(e => e.type === 'commitment' && e.status === 'current');
      return `Priya said she will send the deck by Wednesday [${c.ref}].`;
    };
    const r = await answerWithEmailEvidence({ principal: s.principal, question: 'When will Priya send the deck?', model: fake, now: NOW });
    assert.equal(r.valid, true);
    assert.deepEqual(Object.values(r.providerRefusals), [true, true, true, true]);
    assert.match(seen[0], /^EMAIL EVIDENCE/);
    assert.match(seen[0], /\[E\d+\] commitment · direct · stated · 2026-01-06 · due 2026-01-07/);
    const bad = await answerWithEmailEvidence({ principal: s.principal, question: 'deck', model: async () => 'Priya will send it Monday [E99]. Also the budget is fine.', now: NOW });
    assert.equal(bad.valid, false);
    assert.deepEqual(bad.unknownCitations, ['E99']);
    assert.deepEqual(bad.uncitedSentences, ['Also the budget is fine.']);
    const stale = await answerWithEmailEvidence({ principal: s.principal, question: 'deck Monday', model: async ({ evidence }) => `Monday [${evidence.find(e => e.status === 'superseded').ref}].`, now: NOW });
    assert.equal(stale.citesSuperseded.length, 1, 'an answer resting on superseded evidence is flagged');
  });

  test('E4 · EVERY chat lane: prepareTurn for an owner with synced Gmail contains no email content, and the request stays class user', async () => {
    const s = await stack();
    const { prepareTurn } = await import('../../routes/chat.js');
    const { createContext } = await import('../../core/observability.js');
    const conv = `p4-${crypto.randomUUID()}`;
    const requestId = crypto.randomUUID();
    await EG.runWithDataClass('user', async () => {
      const prep = await prepareTurn({ userMessage: 'When will Priya send the deck, and when is the launch? What did we decide about storage?', conversationId: conv, userId: s.user, ctx: createContext({ conversationId: conv, requestId }), requestId, skipReasoningPass: true });
      const text = JSON.stringify(prep);
      for (const c of CANARIES) assert.ok(!text.includes(c), `the prepared turn contains "${c}"`);
      assert.ok(!text.includes('aqua.email-understanding'));
      assert.ok(typeof prep.systemPrompt === 'string' && prep.systemPrompt.length > 0, 'a real prompt was prepared');
      assert.deepEqual(EG.currentDataClasses(), ['user'], 'nothing in the chat path read Gmail content');
    });
  });

  test('E6 · ordinary readers (every non-restricted read of the UKO store) see no Gmail record; only an explicit restricted read does', async () => {
    const s = await stack();
    const U = await import('../../files/ukoStore.js');
    await EG.runWithDataClass('user', async () => {
      assert.deepEqual(U.listUKOs(s.owner, { limit: 1000 }).filter(u => u.dataClass === 'external:gmail'), [], 'listUKOs');
      const restricted = EG.runWithDataClass('external:gmail', () => U.listUKOs(s.owner, { limit: 1000, includeRestricted: true }).filter(u => u.dataClass === 'external:gmail'));
      assert.ok(restricted.length >= 4, 'the records exist');
      for (const u of restricted) {
        assert.equal(U.getUKO(s.owner, u.id), null, 'getUKO');
        assert.deepEqual(U.listUKOsByPrefix(s.owner, u.id.slice(0, 20)).filter(x => x.dataClass === 'external:gmail'), [], 'listUKOsByPrefix');
      }
    });
  });

  test('E5 · the claim writer refuses Gmail content: a document-understanding job for a Gmail UKO is skipped (no E6, no canonical claim)', async () => {
    const s = await stack();
    const { listUKOs } = await import('../../files/ukoStore.js');
    const gmailUko = EG.runWithDataClass('external:gmail', () => listUKOs(s.owner, { limit: 100, includeRestricted: true }).find(u => u.dataClass === 'external:gmail'));
    assert.ok(gmailUko);
    const W = await import('../../core/jobs/workerRuntime.js');
    // As the worker runs it: inside a job scope, with the chunk's text in the payload.
    const r = await EG.runWithDataClass('user', () => W.HANDLERS['understanding.document.v1']({ ownerId: s.owner, kind: 'understanding.document.v1', payload: { ukoId: gmailUko.id, chunk: 0, name: 'x.md', hash: 'h', text: 'We decided to use Postgres for storage.' }, createdAt: new Date().toISOString() }));
    assert.deepEqual(r, { skipped: 'data-class-restricted' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('G · deletion, account purge, concurrency, no resurrection', () => {
  test('G1 · revoke keeps the imported knowledge (by design); disconnect removes it; nothing returns on re-sync after disconnect', async () => {
    const s = await stack();
    await s.service.revokeCredentials({ principal: s.principal, connectionId: s.conn.connectionId });
    assert.ok(retrieveEmailEvidence({ principal: s.principal, now: NOW }).evidence.length > 0, 'revocation stops access to Gmail, not to what was imported');
    await s.service.disconnect({ principal: s.principal, connectionId: s.conn.connectionId });
    assert.deepEqual(retrieveEmailEvidence({ principal: s.principal, now: NOW }).evidence, []);
    await assert.rejects(s.service.sync({ principal: s.principal, connectionId: s.conn.connectionId }), e => e.code === 'NOT_FOUND');
    assert.deepEqual(retrieveEmailEvidence({ principal: s.principal, now: NOW }).evidence, []);
  });

  test('G2 · account deletion (the real purgeOwnerData) leaves no email understanding', async () => {
    const s = await stack();
    const { purgeOwnerData } = await import('../../account/accountPurge.js');
    await purgeOwnerData({ userId: s.user });
    assert.deepEqual(retrieveEmailEvidence({ principal: s.principal, now: NOW }).evidence, []);
    assert.deepEqual(emailUnderstandingFor({ principal: s.principal, includeHistory: true }).threads, []);
  });

  test('G3 · concurrent sync + sync + disconnect (owner lock): nothing survives, nothing duplicated before it', async () => {
    const s = await stack();
    const before = retrieveEmailEvidence({ principal: s.principal, now: NOW, limit: 200 }).evidence.length;
    await Promise.all([s.service.sync({ principal: s.principal, connectionId: s.conn.connectionId, mode: 'full' }), s.service.sync({ principal: s.principal, connectionId: s.conn.connectionId, mode: 'full' })]);
    assert.equal(retrieveEmailEvidence({ principal: s.principal, now: NOW, limit: 200 }).evidence.length, before, 'two concurrent full syncs duplicate nothing');
    const r = await Promise.allSettled([s.service.sync({ principal: s.principal, connectionId: s.conn.connectionId, mode: 'full' }), s.service.disconnect({ principal: s.principal, connectionId: s.conn.connectionId })]);
    assert.equal(r[1].status, 'fulfilled');
    assert.deepEqual(retrieveEmailEvidence({ principal: s.principal, now: NOW }).evidence, []);
  });

  test('G4 · a message deleted at Gmail drops out of retrieval on the next sync (its decision is no longer current)', async () => {
    const s = await stack();
    s.mock.deleteMessage(s.acct, '18d0000000000003');
    await s.service.sync({ principal: s.principal, connectionId: s.conn.connectionId });
    const b = retrieveEmailEvidence({ principal: s.principal, now: NOW, limit: 100 });
    assert.ok(!JSON.stringify(b).includes('CANARY_P4_C'));
    assert.deepEqual(b.decisions.current.map(r => b.evidence.find(e => e.ref === r).statement), ['We decided to use Postgres for storage.']);
  });

  test('G5 · no request left the machine', () => { assert.deepEqual(egress, []); });
});
