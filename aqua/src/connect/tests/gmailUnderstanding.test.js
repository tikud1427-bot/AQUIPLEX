/**
 * Gmail Phase 3 — deterministic email understanding.
 *
 * U · pure extraction over messages rendered by the REAL normaliser
 *     (buildMessage → parseGmailMessage → renderGmailDocument → understandEmail)
 * I · through the real ingest path: mock Gmail → connect service → syncEngine →
 *     externalSources → fileEngine knowledge stages (emailUnderstanding) → the
 *     restricted UKO → emailContext.emailUnderstandingFor
 * No network (tripwire), no provider, isolated data dir (testkit).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const K = await import('./testkit.js');
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const u = new URL(String(url)); if (u.hostname !== '127.0.0.1') { egress.push(u.host); throw new Error('network refused'); } return realFetch(url, init); };

const U = await import('../gmail/emailUnderstanding.js');
const { emailUnderstandingFor } = await import('../gmail/emailContext.js');
const N = await import('../gmail/gmailNormalize.js');
const F = await import('../testing/gmailFixtures.js');
const { createGmailConnector } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { principalForServerJob } = await import('../principal.js');
const EG = await import('../../core/egressGuard.js');

const PRIYA = 'Priya Sharma <priya@acme.example>', RAJ = 'Raj Mehta <raj@acme.example>', ALEX = 'Alex <alex.k@gmail.com>';
let n = 0;
const spec = (o) => ({ id: o.id ?? `18a${String(++n).padStart(13, '0')}`, threadId: o.thread ?? 'thr-launch', date: o.date ?? 'Mon, 5 Jan 2026 10:00:00 +0000',
  headers: { From: o.from ?? PRIYA, To: o.to ?? RAJ, Cc: o.cc, Subject: o.subject ?? 'Launch plan', 'Message-ID': o.rfc ?? `<m${n}@acme.example>`, 'In-Reply-To': o.inReplyTo },
  text: o.text, attachments: o.attachments, labels: o.labels });
const rendered = o => N.renderGmailDocument(N.parseGmailMessage(F.buildMessage(spec(o))));
const understand = (o, at = '2026-01-20T00:00:00.000Z') => U.understandEmail(rendered(o), { extractedAt: at });
const of = (rec, type) => rec.items.filter(i => i.type === type);
const find = (rec, type, re) => of(rec, type).find(i => re.test(i.statement ?? i.quote ?? i.evidence.quote));

// ══════════════════════════════════════════════════════════════════════════════
describe('U · deterministic extraction (pure)', () => {
  const r = understand({ cc: ALEX, attachments: [{ filename: 'plan.pdf', mimeType: 'application/pdf', size: 1234 }], text: [
    'Hi Raj,', 'We decided to ship the beta on Friday.', "Let's go with vendor B for hosting.", "I'll send the deck by Wednesday.",
    "I'll try to look at the budget.", 'Can you review the contract by Thursday?', 'Raj, please book the venue.',
    'We have not decided on pricing yet.', 'Docs: https://docs.acme.example/launch', 'Thanks!',
  ].join('\n') });

  test('U1 · explicit vs inferred: a stated decision is explicit; "let\'s go with" is an inferred, likely decision', () => {
    const d = find(r, 'decision', /We decided to ship/);
    assert.deepEqual([d.explicit, d.certainty], [true, 'stated']);
    const soft = find(r, 'decision', /vendor B/);
    assert.deepEqual([soft.explicit, soft.certainty], [false, 'likely']);
    assert.ok(!find(r, 'decision', /pricing/), 'a negated decision is not a decision');
  });

  test('U2 · commitments: who, what, when (resolved in the sender\'s calendar); a hedged promise is uncertain and inferred', () => {
    const c = find(r, 'commitment', /send the deck/);
    assert.equal(c.actor, 'person:priya@acme.example');
    assert.deepEqual([c.explicit, c.certainty, c.due.date, c.due.resolution], [true, 'stated', '2026-01-07', 'relative']);
    const h = find(r, 'commitment', /look at the budget/);
    assert.deepEqual([h.explicit, h.certainty], [false, 'uncertain']);
    assert.ok(h.confidence < c.confidence);
  });

  test('U3 · tasks: a question to the recipients is inferred (candidates); a named request is resolved and explicit', () => {
    const ask = find(r, 'task', /review the contract/);
    assert.deepEqual(ask.assignee, { status: 'inferred', candidates: ['person:raj@acme.example'] });
    assert.equal(ask.due.date, '2026-01-08');
    assert.equal(ask.explicit, false);
    const named = find(r, 'task', /book the venue/);
    assert.deepEqual(named.assignee, { status: 'resolved', person: 'person:raj@acme.example' });
    assert.equal(named.explicit, true);
  });

  test('U4 · people, organisations (domain-inferred, never from free-mail), documents (attachment metadata only), topic', () => {
    assert.deepEqual(r.people.map(p => p.key).sort(), ['person:alex.k@gmail.com', 'person:priya@acme.example', 'person:raj@acme.example']);
    assert.deepEqual(r.organizations.map(o => [o.domain, o.explicit]), [['acme.example', false]]);
    assert.ok(find(r, 'document', /docs\.acme\.example\/launch/));
    const att = of(r, 'document').find(i => i.reference === 'attachment');
    assert.deepEqual([att.filename, att.contentFetched], ['plan.pdf', false]);
    assert.equal(of(r, 'topic')[0].topic, 'launch plan');
  });

  test('U5 · provenance is complete on every item; the extractor confirms nothing; output is deterministic', () => {
    assert.deepEqual(U.validateUnderstanding(r), []);
    for (const it of r.items) {
      assert.equal(it.classification, 'external:gmail');
      assert.equal(it.userConfirmed, false);
      assert.equal(it.sourceTimestamp, '2026-01-05T10:00:00.000Z');
      assert.equal(it.extractedAt, '2026-01-20T00:00:00.000Z');
      if (it.evidence.field === 'body') assert.ok(it.evidence.quote.length <= 200);
    }
    assert.deepEqual(understand({ cc: ALEX, id: 'fixed1', rfc: '<fixed@x>', text: 'We decided to go.' }), understand({ cc: ALEX, id: 'fixed1', rfc: '<fixed@x>', text: 'We decided to go.' }));
    assert.equal(r.extractor.network, false);
  });

  test('U6 · quoted earlier messages are not attributed to the replier', () => {
    const reply = understand({ from: RAJ, to: PRIYA, subject: 'Re: Launch plan', text: [
      'Sounds good to me.', '', 'On Mon, Jan 5, 2026 at 10:00 AM Priya Sharma <priya@acme.example> wrote:', "> I'll send the deck by Wednesday.", '> We decided to ship the beta on Friday.',
    ].join('\n') });
    assert.deepEqual(of(reply, 'commitment'), []);
    assert.deepEqual(of(reply, 'decision'), []);
  });

  test('U7 · negation: a declined commitment or a cancelled meeting creates nothing', () => {
    const x = understand({ text: "I won't be able to attend the meeting on Friday. We will not ship this week." });
    assert.deepEqual([of(x, 'commitment').length, of(x, 'event').length], [0, 0]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('U · dates and time zones (the SENDER\'s calendar day)', () => {
  test('U8 · "tomorrow" late in the evening east of UTC: the sender\'s next day, not UTC\'s', () => {
    // Sat 10 Jan 00:30 at +05:45 = Fri 9 Jan 18:45 UTC → tomorrow is SUNDAY 11 Jan.
    const a = understand({ date: 'Sat, 10 Jan 2026 00:30:00 +0545', text: "I'll file the report by tomorrow." });
    assert.equal(of(a, 'commitment')[0].due.date, '2026-01-11');
    // Fri 9 Jan 20:00 at -08:00 = Sat 10 Jan 04:00 UTC → tomorrow is SATURDAY 10 Jan.
    const b = understand({ date: 'Fri, 9 Jan 2026 20:00:00 -0800', text: "I'll file the report by tomorrow." });
    assert.equal(of(b, 'commitment')[0].due.date, '2026-01-10');
  });

  test('U9 · a meeting with a weekday and a time carries the sender\'s zone', () => {
    const e = understand({ date: 'Sat, 10 Jan 2026 00:30:00 +0545', text: "Let's have a call on Monday at 3pm." });
    const ev = of(e, 'event')[0];
    assert.deepEqual([ev.kind, ev.when.date, ev.when.time, ev.when.zone], ['call', '2026-01-12', '15:00', 'UTC+05:45']);
  });

  test('U10 · an ambiguous numeric date is NOT resolved: both readings, uncertain', () => {
    const a = understand({ text: 'The release is 3/4.' });
    const d = of(a, 'date')[0];
    assert.deepEqual([d.value.resolution, d.value.date, d.value.alternatives], ['ambiguous', null, ['2026-03-04', '2026-04-03']]);
    const b = understand({ text: 'The release is 2026-02-01. The launch is March 15.' });
    assert.deepEqual(of(b, 'date').map(x => [x.about, x.value.date, x.value.resolution]), [['release', '2026-02-01', 'absolute'], ['launch', '2026-03-15', 'year-inferred']]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('U · threads: contradictions, changes, supersession, duplicates, similar names', () => {
  const T = '2026-01-20T00:00:00.000Z';
  const thread = msgs => U.reconcileThread(msgs.map(o => understand({ thread: 'thr-x', ...o }, T)));

  test('U11 · contradictory emails: the same date stated differently with NO change marker → both contradicted, neither confirmed', () => {
    const items = thread([{ text: 'The launch is March 15.' }, { from: RAJ, date: 'Tue, 6 Jan 2026 10:00:00 +0000', text: 'The launch is March 20.' }]).filter(i => i.type === 'date');
    assert.deepEqual(items.map(i => [i.value.date, i.status]), [['2026-03-15', 'contradicted'], ['2026-03-20', 'contradicted']]);
    assert.equal(items[0].conflictsWith[0], items[1].id);
    assert.ok(items.every(i => i.userConfirmed === false));
  });

  test('U12 · a changed commitment: the update supersedes the original (same sender, "instead")', () => {
    const items = thread([
      { text: "I'll send the deck by Monday." },
      { date: 'Wed, 7 Jan 2026 09:00:00 +0000', text: "Update: I'll send it by Wednesday instead." },
    ]).filter(i => i.type === 'commitment');
    assert.deepEqual(items.map(i => [i.due.date, i.status]), [['2026-01-12', 'superseded'], ['2026-01-14', 'current']]);
    assert.equal(items[0].supersededBy, items[1].id);
  });

  test('U13 · a superseded decision; a moved date is superseded, not contradicted', () => {
    const d = thread([{ text: 'We decided to use Postgres for storage.' }, { date: 'Wed, 7 Jan 2026 09:00:00 +0000', text: 'Actually, we have decided to use MySQL instead.' }]).filter(i => i.type === 'decision');
    assert.deepEqual(d.map(i => i.status), ['superseded', 'current']);
    const m = thread([{ text: 'The launch is March 15.' }, { from: RAJ, date: 'Tue, 6 Jan 2026 10:00:00 +0000', text: 'The launch has been moved to March 20.' }]).filter(i => i.type === 'date');
    assert.deepEqual(m.map(i => [i.value.date, i.status]), [['2026-03-15', 'superseded'], ['2026-03-20', 'current']]);
  });

  test('U14 · the same message delivered twice (same RFC Message-ID) → the copy\'s items are duplicates', () => {
    const items = thread([{ id: 'dupA', rfc: '<same@acme.example>', text: "I'll send the deck by Monday." }, { id: 'dupB', rfc: '<same@acme.example>', text: "I'll send the deck by Monday." }]).filter(i => i.type === 'commitment');
    assert.deepEqual(items.map(i => i.status), ['current', 'duplicate']);
  });

  test('U15 · people with similar names stay distinct; a bare first name shared by two is AMBIGUOUS, never guessed', () => {
    const r = understand({ from: RAJ, to: 'Priya Sharma <priya@acme.example>, Priya Shah <pshah@beta.example>', text: 'Priya, please send the invoice.' });
    assert.deepEqual(r.people.filter(p => p.names.some(x => x.startsWith('Priya'))).map(p => p.key).sort(), ['person:priya@acme.example', 'person:pshah@beta.example']);
    assert.deepEqual(of(r, 'task')[0].assignee, { status: 'ambiguous', candidates: ['person:priya@acme.example', 'person:pshah@beta.example'] });
    assert.equal(U.resolveMention('Priya Shah', r.people).person, 'person:pshah@beta.example');
    assert.equal(U.resolveMention('Priyanka', r.people).status, 'unresolved');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('I · through the real ingest path (mock Gmail → sync → restricted UKO → adapter)', () => {
  function setup() {
    const mock = createMockGmailService({ now: Date.now });
    const registry = K.createConnectorRegistry({ allowTestOnly: true });
    registry.register(createGmailConnector({ transport: mock.transport, pageSize: 5 }));
    const store = K.createMemoryConnectionStore();
    const service = K.createConnectService({ registry, store, vault: K.createCredentialVault({ key: K.TEST_KEY }), log: { log() {}, warn() {} }, retry: { sleep: async () => {}, baseMs: 0 } });
    const user = `p3-${crypto.randomBytes(5).toString('hex')}`;
    const principal = principalForServerJob(user);
    const acct = `${user}@example.test`;
    return { mock, service, principal, owner: `user:${user}`, acct, connect: () => service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode(acct) } }) };
  }
  const load = (s, list) => { for (const o of list) s.mock.addMessage(s.acct, F.buildMessage(spec(o))); };
  const MAIL = [
    { id: '18b0000000000001', thread: 'thr-i', text: "I'll send the deck by Monday. CANARY_P3_ONE", rfc: '<i1@acme.example>' },
    { id: '18b0000000000002', thread: 'thr-i', from: RAJ, to: PRIYA, date: 'Tue, 6 Jan 2026 10:00:00 +0000', subject: 'Re: Launch plan', rfc: '<i2@acme.example>', text: 'The launch is March 15.\n\nOn Mon, Jan 5, 2026 Priya wrote:\n> I\'ll send the deck by Monday. CANARY_P3_ONE' },
    { id: '18b0000000000003', thread: 'thr-i', date: 'Wed, 7 Jan 2026 09:00:00 +0000', rfc: '<i3@acme.example>', text: "Update: I'll send it by Wednesday instead. The launch has been moved to March 20." },
  ];

  test('I1 · a synced thread is understood on ingest; the adapter returns the reconciled, current view with full provenance', async () => {
    const s = setup(); load(s, MAIL);
    const c = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: c.connectionId });
    const { threads } = emailUnderstandingFor({ principal: s.principal });
    assert.equal(threads.length, 1);
    const t = threads[0];
    assert.deepEqual([t.threadId, t.messages, t.topic], ['thr-i', 3, 'launch plan']);
    const com = t.items.filter(i => i.type === 'commitment');
    assert.deepEqual(com.map(i => [i.gmailMessageId, i.due.date, i.status]), [['18b0000000000003', '2026-01-14', 'current']], 'only the CURRENT commitment by default; the quote in the reply is not one');
    assert.deepEqual(t.items.filter(i => i.type === 'date').map(i => [i.value.date, i.status]), [['2026-03-20', 'current']]);
    const all = emailUnderstandingFor({ principal: s.principal, includeHistory: true }).threads[0].items;
    assert.ok(all.some(i => i.status === 'superseded'));
    for (const it of all) for (const k of ['gmailMessageId', 'threadId', 'sourceTimestamp', 'extractedAt', 'evidence', 'certainty', 'confidence', 'classification']) assert.ok(it[k] != null, `${it.type} lacks ${k}`);
  });

  test('I2 · owner isolation: another principal sees nothing; a forged principal-like object is refused', async () => {
    const s = setup(); load(s, MAIL.slice(0, 1));
    const c = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: c.connectionId });
    assert.deepEqual(emailUnderstandingFor({ principal: principalForServerJob('someone-else') }).threads, []);
    assert.throws(() => emailUnderstandingFor({ principal: { userId: s.owner.slice(5) } }), e => e.code === 'UNAUTHENTICATED');
    assert.equal(emailUnderstandingFor({ principal: s.principal, connectionId: 'conn_00000000000000000000' }).threads.length, 0, 'another connection id narrows to nothing');
  });

  test('I3 · source deletion removes every derived record; a deleted message\'s items leave the thread view', async () => {
    const s = setup(); load(s, MAIL);
    const c = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: c.connectionId });
    s.mock.deleteMessage(s.acct, '18b0000000000003');
    await s.service.sync({ principal: s.principal, connectionId: c.connectionId });
    const items = emailUnderstandingFor({ principal: s.principal, includeHistory: true }).threads[0].items;
    assert.ok(!items.some(i => i.gmailMessageId === '18b0000000000003'));
    assert.equal(items.find(i => i.type === 'commitment').status, 'current', 'the earlier commitment is current again — its update is gone');
    await s.service.disconnect({ principal: s.principal, connectionId: c.connectionId });
    assert.deepEqual(emailUnderstandingFor({ principal: s.principal }).threads, []);
  });

  test('I4 · concurrent sync and disconnect: whatever the order, nothing derived survives', async () => {
    const s = setup(); load(s, MAIL);
    const c = await s.connect();
    const [r1, r2] = await Promise.allSettled([s.service.sync({ principal: s.principal, connectionId: c.connectionId }), s.service.disconnect({ principal: s.principal, connectionId: c.connectionId })]);
    assert.equal(r2.status, 'fulfilled');
    assert.ok(r1.status === 'fulfilled' || r1.reason?.code === 'NOT_FOUND');
    assert.deepEqual(emailUnderstandingFor({ principal: s.principal, includeHistory: true }).threads, []);
  });

  test('I5 · privacy: reading email understanding TAINTS the caller — no provider is reachable afterwards in that request', async () => {
    const s = setup(); load(s, MAIL.slice(0, 1));
    const c = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: c.connectionId });
    await EG.runWithDataClass('user', async () => {
      assert.doesNotThrow(() => EG.assertEgress('groq', 'generate'), 'a user request may call a provider…');
      const r = emailUnderstandingFor({ principal: s.principal });
      assert.equal(r.threads.length, 1);
      assert.deepEqual(EG.currentDataClasses().sort(), ['external:gmail', 'user']);
      for (const prov of ['groq', 'gemini', 'nvidia', 'openrouter']) assert.throws(() => EG.assertEgress(prov, 'generate'), e => e.code === 'EGRESS_BLOCKED', prov);
    });
  });

  test('I6 · understanding lives ONLY in the restricted UKO store: not in Memory, Mind, file index, evidence or caches', async () => {
    const s = setup(); load(s, MAIL.slice(0, 1));
    const c = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: c.connectionId });
    await new Promise(r => setTimeout(r, 1500));   // the stores' debounced writers (500 ms) reach disk
    const hits = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { let t = ''; try { t = fs.readFileSync(p, 'utf8'); } catch { /* binary */ } if (t.includes('"aqua.email-understanding/v1"') || t.includes('send the deck by Monday')) hits.push(path.relative(K.TMP, p)); } } };
    walk(K.TMP);
    assert.ok(hits.length > 0, 'the understanding is persisted');
    assert.deepEqual(hits.filter(h => !/uko/i.test(h)), [], `outside the UKO store: ${hits.join(', ')}`);
  });

  test('I7 · no request left the machine', () => { assert.deepEqual(egress, []); });
});
