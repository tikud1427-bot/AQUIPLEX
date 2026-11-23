/**
 * Gmail Phase 6 — regression tests for every defect the evaluation demonstrated
 * (eval/gmail/dataset.v1.json baseline, and the held-out set's first run).
 * Each test names the defect id used in audit/aqua-connect-engine/gmail-phase6.
 *
 * Pure extraction over messages rendered by the REAL normaliser, plus one path
 * through the real ingest (mock Gmail → connect service → restricted UKO →
 * emailContext / emailIntelligence). No network (tripwire), no provider.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const K = await import('./testkit.js');
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const u = new URL(String(url)); if (u.hostname !== '127.0.0.1') { egress.push(u.host); throw new Error('network refused'); } return realFetch(url, init); };

const U = await import('../gmail/emailUnderstanding.js');
const N = await import('../gmail/gmailNormalize.js');
const F = await import('../testing/gmailFixtures.js');
const { createGmailConnector } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { principalForServerJob } = await import('../principal.js');
const { retrieveEmailEvidence } = await import('../gmail/emailContext.js');
const I = await import('../gmail/emailIntelligence.js');
const EG = await import('../../core/egressGuard.js');

const PRIYA = 'Priya Sharma <priya@acme.example>', RAJ = 'Raj Mehta <raj@acme.example>', SHAH = 'Priya Shah <pshah@beta.example>', ALEX = 'Alex <alex.k@gmail.com>';
let n = 0;
// Every message gets its own RFC Message-ID (a shared one would make it a duplicate delivery).
const msg = o => (++n, F.buildMessage({ id: o.id ?? `18e${String(n).padStart(13, '0')}`, threadId: o.thread ?? 'thr-eval', date: o.date ?? 'Mon, 5 Jan 2026 10:00:00 +0000',
  headers: { From: o.from ?? PRIYA, To: o.to ?? RAJ, Cc: o.cc, Subject: o.subject ?? 'Plan', 'Message-ID': o.rfc ?? `<e${n}@acme.example>` }, text: o.text }));
const und = o => U.understandEmail(N.renderGmailDocument(N.parseGmailMessage(msg(o))), { extractedAt: '2026-01-20T00:00:00.000Z' });
const of = (r, type) => r.items.filter(i => i.type === type);
const find = (items, type, re) => items.find(i => i.type === type && re.test(i.statement ?? ''));
const thread = (...os) => U.reconcileThread(os.map(und));

describe('E · defects found by the Phase 6 evaluation', () => {
  test('E1 (D1) · a sentence-initial "Please …" is a request (task), not a bare deadline; courtesy formulas are not requests', () => {
    const r = und({ text: 'Thanks. Please also send the vendor quotes by Friday.\nPlease find attached the notes.\nPlease let me know if anything is missing.' });
    const t = find(r.items, 'task', /vendor quotes/);
    assert.ok(t, 'task extracted');
    assert.equal(t.due.date, '2026-01-09');
    assert.ok(!find(r.items, 'deadline', /vendor quotes/), 'not a deadline-only item');
    assert.equal(of(r, 'task').length, 1, '"Please find attached" / "Please let me know" are not tasks');
  });

  test('E2 (D8) · the addressee of a request: full name, ambiguous first name (still a stated request), only recipient; a greeting is not a name', () => {
    const r = und({ from: RAJ, to: `${PRIYA}, ${SHAH}`, text: 'Priya Shah, please confirm the delivery address.\nPriya, please send the signed NDA.' });
    const full = find(r.items, 'task', /delivery address/);
    assert.deepEqual(full.assignee, { status: 'resolved', person: 'person:pshah@beta.example' });
    assert.deepEqual([full.explicit, full.certainty], [true, 'stated']);
    const amb = find(r.items, 'task', /signed NDA/);
    assert.equal(amb.assignee.status, 'ambiguous');
    assert.deepEqual([amb.explicit, amb.certainty], [true, 'stated'], 'the request is stated; only WHO is ambiguous');
    const sole = find(und({ from: RAJ, to: PRIYA, text: 'Could you share the onboarding checklist?' }).items, 'task', /onboarding checklist/);
    assert.deepEqual(sole.assignee, { status: 'resolved', person: 'person:priya@acme.example', basis: 'sole-recipient' });
    assert.equal(sole.explicit, true);
    const copied = find(und({ from: RAJ, to: PRIYA, cc: ALEX, text: 'Could you share the onboarding checklist?' }).items, 'task', /onboarding checklist/);
    assert.deepEqual([copied.assignee.status, copied.explicit], ['inferred', false], 'with someone copied it stays inferred');
    const greet = find(und({ from: PRIYA, to: RAJ, cc: ALEX, text: 'Hi Raj, please book the venue.' }).items, 'task', /book the venue/);
    assert.deepEqual(greet.assignee, { status: 'resolved', person: 'person:raj@acme.example' });
  });

  test('E3 (D4) · an explicit acceptance ("Sure, I can …") is a commitment; agreeing with a point is not; a bare "I can …" stays unextracted', () => {
    const c = find(und({ text: 'Sure, I can share it tomorrow.' }).items, 'commitment', /share it tomorrow/);
    assert.deepEqual([c.explicit, c.certainty, c.due.date, c.actor], [true, 'stated', '2026-01-06', 'person:priya@acme.example']);
    assert.deepEqual(of(und({ text: 'Sure, I can see why the pricing is confusing.' }), 'commitment'), []);
    assert.deepEqual(of(und({ text: 'I can share it tomorrow if needed, I guess.' }), 'commitment'), []);
  });

  test('E4 (D5) · a promise\'s own date ("we\'ll start the pilot on Monday") is its due date; the condition keeps it inferred', () => {
    const c = find(und({ date: 'Tue, 6 Jan 2026 09:00:00 +0000', text: "If the contract is signed this week, we'll start the pilot on Monday." }).items, 'commitment', /start the pilot/);
    assert.equal(c.due.date, '2026-01-12');
    assert.deepEqual([c.explicit, c.certainty], [false, 'uncertain']);
  });

  test('E5 (D7) · remarks about past events are not events', () => {
    assert.deepEqual(of(und({ date: 'Tue, 6 Jan 2026 18:00:00 +0000', text: 'Lunch on Tuesday was great, thanks everyone.' }), 'event'), []);
    assert.deepEqual(of(und({ text: 'Thanks for the call today.' }), 'event'), []);
    assert.equal(of(und({ text: 'The review call is scheduled for Friday at 3pm.' }), 'event').length, 1);
  });

  test('E6 (D9) · a scheduled/booked event is stated (direct); an unmarked one stays likely (inference)', () => {
    const e = of(und({ text: 'Project Falcon kickoff is scheduled for Thursday at 2pm.' }), 'event')[0];
    assert.deepEqual([e.explicit, e.certainty, e.when.date, e.when.time], [true, 'stated', '2026-01-08', '14:00']);
    const l = of(und({ text: 'Team lunch on Friday.' }), 'event')[0];
    assert.deepEqual([l.explicit, l.certainty], [false, 'likely']);
  });

  test('E7 (held-out) · an event word used as a verb, or a deadline-only date, is not an event', () => {
    assert.deepEqual(of(und({ text: "I'll call the supplier tomorrow." }), 'event'), []);
    assert.deepEqual(of(und({ text: "I'll also send the offsite budget by Friday." }), 'event'), []);
    assert.equal(of(und({ text: 'The offsite is on Friday.' }), 'event').length, 1);
  });

  test('E8 (D2, D3) · a later completion by the promiser/assignee, or a cancellation by the requester, closes the matching item only', () => {
    const t1 = thread(
      { date: 'Mon, 5 Jan 2026 09:00:00 +0000', text: "I'll send the revised budget by Wednesday. I'll send the hiring plan by Friday." },
      { date: 'Wed, 7 Jan 2026 10:00:00 +0000', text: "I've sent the revised budget; it's attached." },
    );
    const done = find(t1, 'commitment', /revised budget/);
    assert.equal(done.status, 'completed');
    assert.deepEqual([done.closedBy.kind, done.closedBy.by], ['completed', 'person:priya@acme.example']);
    assert.match(done.closedBy.evidence.quote, /I've sent the revised budget/);
    assert.equal(find(t1, 'commitment', /hiring plan/).status, 'current', 'a different object stays open');
    // Somebody else saying it was sent does not close Priya's promise.
    const t2 = thread({ text: "I'll send the revised budget by Wednesday." }, { from: RAJ, to: PRIYA, date: 'Tue, 6 Jan 2026 10:00:00 +0000', text: "I've sent the revised budget." });
    assert.equal(find(t2, 'commitment', /revised budget/).status, 'current');
    // Cancellation: only the requester calls a request off.
    const ask = { from: RAJ, to: PRIYA, text: 'Please prepare the investor memo by Friday.' };
    const t3 = thread(ask, { from: RAJ, to: PRIYA, date: 'Wed, 7 Jan 2026 15:00:00 +0000', text: 'Never mind the investor memo.' });
    assert.equal(find(t3, 'task', /investor memo/).status, 'cancelled');
    const t4 = thread(ask, { from: PRIYA, to: `${RAJ}, ${ALEX}`, date: 'Wed, 7 Jan 2026 15:00:00 +0000', text: 'I think there is no need to prepare the investor memo.' });
    assert.equal(find(t4, 'task', /investor memo/).status, 'current', 'the assignee\'s opinion does not cancel the request');
    // Completion by the assignee; a status QUESTION closes nothing.
    const label = { text: 'Action items: Raj to update the pricing page by Thursday.' };
    assert.equal(find(thread(label, { from: RAJ, to: PRIYA, date: 'Tue, 6 Jan 2026 09:00:00 +0000', text: 'So the pricing page is updated now?' }), 'task', /pricing page/).status, 'current');
    assert.equal(find(thread(label, { from: RAJ, to: PRIYA, date: 'Tue, 6 Jan 2026 09:00:00 +0000', text: 'Done, the pricing page is updated.' }), 'task', /pricing page/).status, 'completed');
  });

  test('E9 (D6) · a changed date supersedes an earlier deadline of the same subject across item kinds; a different subject does not', () => {
    const items = thread(
      { from: 'Meera Rao <meera@acme.example>', date: 'Sat, 10 Jan 2026 00:15:00 +0545', text: 'Team, the final report is due tomorrow.' },
      { from: 'Meera Rao <meera@acme.example>', date: 'Sat, 10 Jan 2026 09:00:00 +0545', text: 'Update: the vendor contract deadline has moved to March 2.' },
      { from: 'Meera Rao <meera@acme.example>', date: 'Mon, 12 Jan 2026 09:00:00 +0545', text: 'Update: the final report deadline has moved to Wednesday.' },
    );
    const early = items.find(i => /due tomorrow/.test(i.statement ?? ''));
    const later = items.find(i => /final report deadline has moved/.test(i.statement ?? ''));
    assert.equal(early.status, 'superseded');
    assert.equal(early.supersededBy, later.id);
    assert.equal(items.find(i => /vendor contract/.test(i.statement ?? '')).supersedes, undefined);
  });
});

describe('E · closures and dates through the real ingest path', () => {
  test('E10 · completed/cancelled items leave open, upcoming and person answers, keep their closing evidence; "When is the … kickoff?" is answered', async () => {
    const mock = createMockGmailService({ now: Date.now });
    const registry = K.createConnectorRegistry({ allowTestOnly: true });
    registry.register(createGmailConnector({ transport: mock.transport, pageSize: 50 }));
    const service = K.createConnectService({ registry, store: K.createMemoryConnectionStore(), vault: K.createCredentialVault({ key: K.TEST_KEY }), log: { log() {}, warn() {} }, retry: { sleep: async () => {}, baseMs: 0 } });
    const principal = principalForServerJob('gmail-e10-owner');
    const add = o => mock.addMessage('e10@example.test', msg(o));
    add({ id: '18e1000000000001', thread: 'b', date: 'Mon, 5 Jan 2026 09:00:00 +0000', subject: 'Budget', text: "I'll send the revised budget by Friday." });
    add({ id: '18e1000000000002', thread: 'b', date: 'Tue, 6 Jan 2026 09:00:00 +0000', subject: 'Re: Budget', text: "I've sent the revised budget." });
    add({ id: '18e1000000000003', thread: 'm', from: RAJ, to: PRIYA, date: 'Mon, 5 Jan 2026 10:00:00 +0000', subject: 'Memo', text: 'Please prepare the investor memo by Friday.' });
    add({ id: '18e1000000000004', thread: 'm', from: RAJ, to: PRIYA, date: 'Tue, 6 Jan 2026 15:00:00 +0000', subject: 'Re: Memo', text: 'Never mind the investor memo.' });
    add({ id: '18e1000000000005', thread: 'k', from: RAJ, to: PRIYA, date: 'Mon, 5 Jan 2026 11:00:00 +0000', subject: 'Falcon', text: 'Project Falcon kickoff is scheduled for Thursday at 2pm.' });
    add({ id: '18e1000000000006', thread: 'o', from: RAJ, to: PRIYA, date: 'Mon, 5 Jan 2026 12:00:00 +0000', subject: 'Orion', text: "Project Orion is on track. I'll send the launch checklist by Friday." });
    add({ id: '18e1000000000007', thread: 'o', from: RAJ, to: PRIYA, date: 'Tue, 6 Jan 2026 12:00:00 +0000', subject: 'Re: Orion', text: "I've sent the launch checklist." });
    const conn = await service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode('e10@example.test') } });
    await service.sync({ principal, connectionId: conn.connectionId, mode: 'full' });
    const NOW = Date.parse('2026-01-07T12:00:00Z');
    await EG.runWithDataClass('user', async () => {
      const b = retrieveEmailEvidence({ principal, now: NOW, limit: 200, includeHistory: true });
      const budget = b.evidence.find(e => /revised budget by Friday/.test(e.statement ?? ''));
      const memo = b.evidence.find(e => /investor memo by Friday/.test(e.statement ?? ''));
      assert.deepEqual([budget.status, memo.status], ['completed', 'cancelled']);
      assert.deepEqual([...b.openCommitments, ...b.openTasks], []);
      assert.ok(!b.upcoming.some(u => [budget.ref, memo.ref].includes(u.ref)), 'closed items are not upcoming');
      const open = I.ask({ principal, question: 'What are my open commitments?', now: NOW });
      assert.deepEqual(open.items, []);
      const person = I.ask({ principal, question: 'What did Priya Sharma promise?', now: NOW });
      assert.ok(!person.items.some(i => /revised budget/.test(i.statement)));
      const detail = I.evidenceDetail({ principal, id: budget.id, now: NOW });
      assert.equal(detail.item.closedBy.kind, 'completed');
      assert.match(detail.item.closedBy.quote, /I've sent the revised budget/);
      assert.equal(detail.item.userConfirmed, false, 'closed per the email, never user-confirmed');
      const project = I.ask({ principal, question: 'What is happening with project Orion?', now: NOW });
      assert.equal(project.intent, 'project');
      assert.ok(!project.items.some(i => /launch checklist/.test(i.statement)), 'a completed promise is not presented as project work in progress');
      const people = I.view({ principal, view: 'people', limit: 50, now: NOW });
      assert.deepEqual(people.items.map(p => p.openItems), people.items.map(() => 0), 'no one has open items: every promise/request was closed');
      const when = I.ask({ principal, question: 'When is the Falcon kickoff?', now: NOW });
      assert.equal(when.intent, 'upcoming_deadlines');
      assert.ok(when.items.some(i => /kickoff is scheduled/.test(i.statement)));
    });
    assert.deepEqual(egress, []);
  });
});
