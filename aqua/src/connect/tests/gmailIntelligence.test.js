/**
 * Gmail Phase 5 — model-free Gmail intelligence.
 *
 *   Q · extraction quality: adversarial and misleading mail (conditions, questions,
 *       automated senders, auto-replies, unsupported languages, states vs actions)
 *   A · the authenticated API (routes/connect.js /gmail/intelligence/*) over the
 *       real ingest path: views, evidence, deterministic answers, pagination,
 *       isolation, forged principals, deletion, no egress, no leakage.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const K = await import('./testkit.js');
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const u = new URL(String(url)); if (u.hostname !== '127.0.0.1') { egress.push(u.host); throw new Error('network refused'); } return realFetch(url, init); };

const express = (await import('express')).default;
const U = await import('../gmail/emailUnderstanding.js');
const N = await import('../gmail/gmailNormalize.js');
const F = await import('../testing/gmailFixtures.js');
const { createGmailConnector } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { principalForServerJob } = await import('../principal.js');
const { createConnectRouter } = await import('../../routes/connect.js');
const { buildGmailOAuth } = await import('../gmail/gmailOAuthConfig.js');
const EG = await import('../../core/egressGuard.js');

const PRIYA = 'Priya Sharma <priya@acme.example>', RAJ = 'Raj Mehta <raj@acme.example>';
let n = 0;
const rendered = o => N.renderGmailDocument(N.parseGmailMessage(F.buildMessage({ id: o.id ?? `18f${String(++n).padStart(13, '0')}`, threadId: o.thread ?? 't', date: o.date ?? 'Mon, 5 Jan 2026 10:00:00 +0000', headers: { From: o.from ?? PRIYA, To: o.to ?? RAJ, Subject: o.subject ?? 'Plan', 'Message-ID': `<q${n}@x>` }, text: o.text })));
const und = o => U.understandEmail(rendered(o), { extractedAt: '2026-01-20T00:00:00.000Z' });
const types = r => r.items.filter(i => i.type !== 'topic').map(i => i.type);

// ══════════════════════════════════════════════════════════════════════════════
describe('Q · extraction quality on adversarial and misleading mail', () => {
  test('Q1 · a conditional promise is uncertain and inferred, never stated', () => {
    const c = und({ text: "If the budget is approved, I'll hire two engineers." }).items.find(i => i.type === 'commitment');
    assert.deepEqual([c.certainty, c.explicit, c.conditional], ['uncertain', false, true]);
    const c2 = und({ text: "I'll send the contract, assuming legal signs off." }).items.find(i => i.type === 'commitment');
    assert.deepEqual([c2.certainty, c2.explicit], ['uncertain', false]);
  });

  test('Q2 · questions decide and promise nothing', () => {
    assert.deepEqual(types(und({ text: 'Have we decided on pricing? Will you send it by Friday? Did they agree to the terms?' })), []);
  });

  test('Q3 · automated mail (no-reply senders, notifications, auto-replies) yields no statements', () => {
    const shop = und({ from: 'Shop <no-reply@shop.example>', text: "We'll ship your order by Friday. We have decided to upgrade your account. Project Freebie starts March 3." });
    assert.equal(shop.automated, true);
    assert.deepEqual(types(shop), []);
    const ooo = und({ subject: 'Automatic reply: Plan', text: "I'll be out of the office until Monday and will reply when I'm back." });
    assert.equal(ooo.automated, true);
    assert.deepEqual(types(ooo), []);
    assert.deepEqual(types(und({ from: 'GitHub <notifications@github.example>', text: 'The release is March 3. We decided to merge.' })), []);
  });

  test('Q4 · unsupported languages are detected and yield no statements (never an English regex over Spanish or Hindi)', () => {
    const es = und({ text: 'Hola Raj, enviaré el informe el lunes. Decidimos usar Postgres para el almacenamiento. La reunión es el 15 de marzo.' });
    assert.deepEqual(es.language, { detected: 'es', supported: false });
    assert.deepEqual(types(es), []);
    // Non-English mail with an English-looking fragment (a product name) — where an English rule WOULD misfire.
    const esMixed = und({ text: 'Hola equipo, el Project Atlas empieza el lunes. Por favor revisen el presupuesto antes del viernes. Gracias a todos por el trabajo de esta semana.' });
    assert.equal(esMixed.language.supported, false);
    assert.deepEqual(types(esMixed), [], 'no "Project Atlas" item from Spanish mail');
    const hi = und({ text: 'नमस्ते राज, मैं सोमवार तक रिपोर्ट भेज दूँगी। हमने पोस्टग्रेस इस्तेमाल करने का फैसला किया है।' });
    assert.deepEqual(hi.language, { detected: 'non-latin-script', supported: false });
    assert.deepEqual(types(hi), []);
    const mixed = und({ text: "Thanks for the update. I'll send the deck by Monday, as we discussed in the meeting — merci beaucoup!" });
    assert.equal(mixed.language.supported, true);
    assert.ok(types(mixed).includes('commitment'), 'English mail with a foreign phrase is still understood');
  });

  test('Q5 · a state is not a promise; reported speech is not the sender\'s promise; negated promises create nothing', () => {
    const s = und({ text: "I'll be at the office all week." }).items.find(i => i.type === 'commitment');
    assert.deepEqual([s.certainty, s.explicit, s.stateNotAction], ['likely', false, true]);
    assert.deepEqual(types(und({ text: 'Raj said he will send it on Friday.' })), []);
    assert.deepEqual(types(und({ text: "I won't be sending the deck after all." })), []);
  });

  test('Q6 · misleading "decision" phrasing: hypothetical or asked decisions are not decisions', () => {
    assert.deepEqual(types(und({ text: 'If we decided to use MySQL, the migration would take a month.' })).filter(t => t === 'decision').length, 1, 'recorded…');
    assert.equal(und({ text: 'If we decided to use MySQL, the migration would take a month.' }).items.find(i => i.type === 'decision').certainty, 'uncertain', '…but only as uncertain');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('A · the authenticated Gmail intelligence API', () => {
  const OAUTH = buildGmailOAuth({ AQUA_GMAIL_CLIENT_ID: '1-a.apps.googleusercontent.com', AQUA_GMAIL_CLIENT_SECRET: 'secret-xyz-123', AQUA_GMAIL_REDIRECT_URI: 'https://a.test/api/aqua/connect/gmail/callback', APP_URL: 'https://a.test' });
  const NOW = Date.parse('2026-01-06T00:00:00Z');
  const MAIL = [
    ['18e0000000000001', { date: 'Mon, 5 Jan 2026 09:00:00 +0000', text: "I'll send the deck by Monday. We decided to use Postgres for storage." }],
    ['18e0000000000002', { date: 'Mon, 5 Jan 2026 12:00:00 +0000', from: RAJ, to: PRIYA, subject: 'Re: Launch plan', text: 'The launch is March 15.' }],
    ['18e0000000000003', { date: 'Tue, 6 Jan 2026 09:00:00 +0000', text: "Update: I'll send it by Wednesday instead. Actually, we have decided to use MySQL instead. The launch is March 20." }],
    ['18e0000000000004', { date: 'Tue, 6 Jan 2026 10:00:00 +0000', thread: 'thr-atlas', subject: 'Atlas kickoff', to: `${RAJ}, Priya Shah <pshah@beta.example>`, text: 'Project Atlas kickoff call on Thursday at 10am. Raj, please review the budget by Friday.' }],
  ];
  const mail = (id, o) => F.buildMessage({ id, threadId: o.thread ?? 'thr-launch', date: o.date, headers: { From: o.from ?? PRIYA, To: o.to ?? RAJ, Subject: o.subject ?? 'Launch plan', 'Message-ID': `<${id}@acme.example>` }, text: o.text });
  let srv, base, s, other, sessions;
  async function owner(mailbox) {
    const mock = createMockGmailService({ now: Date.now });
    const registry = K.createConnectorRegistry({ allowTestOnly: true });
    registry.register(createGmailConnector({ transport: mock.transport, pageSize: 10 }));
    const service = K.createConnectService({ registry, store: K.createMemoryConnectionStore(), vault: K.createCredentialVault({ key: K.TEST_KEY }), log: { log() {}, warn() {} }, retry: { sleep: async () => {}, baseMs: 0 } });
    const user = `p5-${crypto.randomBytes(5).toString('hex')}`;
    const principal = principalForServerJob(user);
    const acct = `${user}@example.test`;
    for (const [id, o] of mailbox) mock.addMessage(acct, mail(id, o));
    const conn = await service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode(acct) } });
    await service.sync({ principal, connectionId: conn.connectionId });
    return { service, principal, user, conn, mock, acct };
  }
  before(async () => {
    s = await owner(MAIL);
    other = await owner([['18e0000000000099', { date: 'Mon, 5 Jan 2026 09:00:00 +0000', text: "I'll hire a designer by Friday." }]]);
    sessions = new Map([['a', { userId: s.user }], ['b', { userId: other.user }]]);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const sid = req.get('x-sid') ?? 'none';
      const sess = sessions.get(sid);
      if (!sess?.userId) return res.status(401).json({ error: 'Login required' });
      req.session = sess;
      req.aquaUserId = req.get('x-forge-aqua-user') ?? String(sess.userId);   // test seam: a mismatching bound id
      EG.runWithDataClass('user', () => next());                                  // like aqua/router.js
    });
    app.use('/api/aqua/connect', createConnectRouter({ getDeps: async () => ({ gmail: OAUTH.config, service: s.service, vault: {} }), now: () => NOW, log: { log() {}, warn() {} } }));
    srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    base = `http://127.0.0.1:${srv.address().port}/api/aqua/connect/gmail/intelligence`;
  });
  after(() => new Promise(r => srv.close(r)));
  const get = async (p, sid = 'a', headers = {}) => { const r = await fetch(base + p, { headers: { 'x-sid': sid, ...headers } }); return { status: r.status, body: await r.json() }; };
  const ask = async (question, sid = 'a', extra = {}) => { const r = await fetch(`${base}/ask`, { method: 'POST', headers: { 'x-sid': sid, 'content-type': 'application/json' }, body: JSON.stringify({ question, ...extra }) }); return { status: r.status, body: await r.json() }; };
  const checkItem = i => {
    assert.match(i.id, /^[0-9a-f]{16}$/);
    assert.ok(i.evidenceIds.includes(i.id), 'every item cites itself');
    assert.equal(i.userConfirmed, false);
    assert.ok(['direct', 'inference'].includes(i.basis));
    for (const k of ['gmailMessageId', 'threadId', 'sentAt', 'extractedAt']) assert.ok(i.source[k], k);
  };

  test('A1 · overview: counts and the important items, each with evidence ids; deterministic', async () => {
    const r = await get('/overview');
    assert.equal(r.status, 200);
    assert.equal(r.body.generatedBy, 'deterministic');
    assert.deepEqual([r.body.counts.openCommitments, r.body.counts.openTasks, r.body.counts.currentDecisions, r.body.counts.supersededDecisions, r.body.counts.contradictions], [1, 1, 1, 1, 1]);
    for (const i of [...r.body.upcoming, ...r.body.openCommitments, ...r.body.openTasks]) checkItem(i);
  });

  test('A2 · views: open commitments exclude superseded; decisions current/superseded linked; contradictions grouped; people and projects', async () => {
    const c = (await get('/view/commitments')).body;
    assert.deepEqual(c.items.map(i => [i.statement, i.status, i.due]), [["Update: I'll send it by Wednesday instead.", 'current', '2026-01-07']]);
    const sup = (await get('/view/superseded')).body.items[0];
    const cur = (await get('/view/decisions')).body.items[0];
    assert.equal(sup.supersededBy, cur.id);
    assert.ok(sup.evidenceIds.includes(cur.id));
    const k = (await get('/view/contradictions')).body;
    assert.equal(k.total, 1);
    assert.deepEqual(k.items[0].items.map(i => i.statement).sort(), ['The launch is March 15.', 'The launch is March 20.']);
    const d = (await get('/view/deadlines')).body;
    assert.deepEqual(d.items.map(i => i.due), ['2026-01-07', '2026-01-08', '2026-01-09', '2026-03-15', '2026-03-20']);
    assert.ok(d.contradictions.length === 1, 'contradictions touching the page are never omitted');
    const p = (await get('/view/people')).body;
    assert.deepEqual(p.organizations.map(o => [o.domain, o.basis]).sort(), [['acme.example', 'inference'], ['beta.example', 'inference']]);
    assert.ok(p.items.find(x => x.key === 'person:raj@acme.example').openItems >= 1);
    const pr = (await get('/view/projects')).body;
    assert.deepEqual(pr.projects.map(x => x.name), ['Atlas']);
  });

  test('A3 · pagination is bounded and validated; unknown fields and views are refused', async () => {
    const p1 = (await get('/view/deadlines?limit=2')).body;
    assert.deepEqual([p1.items.length, p1.total, p1.nextCursor], [2, 5, 2]);
    const p3 = (await get('/view/deadlines?limit=2&cursor=4')).body;
    assert.deepEqual([p3.items.length, p3.nextCursor], [1, null]);
    for (const q of ['?limit=0', '?limit=51', '?limit=abc', '?limit=-1', '?cursor=5001', '?limit=1e3', '?limit=10&limit=20', '?ownerId=user:x', '?userId=x']) {
      assert.equal((await get(`/view/commitments${q}`)).status, 400, q);
    }
    assert.equal((await get('/view/everything')).status, 404);
    assert.equal((await get('/overview?userId=x')).status, 400);
    assert.equal((await ask('x'.repeat(501))).status, 400);
    assert.equal((await ask('open commitments', 'a', { userId: other.user })).status, 400, 'a body may carry only the question');
    assert.equal((await ask(42)).status, 400);
  });

  test('A4 · owner isolation, evidence authorisation, forged principal, unauthenticated', async () => {
    const mine = (await get('/view/commitments')).body.items[0].id;
    assert.equal((await get(`/evidence/${mine}`, 'b')).status, 404, 'another owner\'s evidence id is not found');
    assert.equal((await get('/overview', 'b')).body.counts.openCommitments, 1, 'B sees only B\'s');
    assert.ok(!JSON.stringify((await get('/view/commitments', 'b')).body).includes('deck'));
    assert.equal((await get('/overview', 'nobody')).status, 401);
    assert.equal((await get('/overview', 'a', { 'x-forge-aqua-user': other.user })).status, 401, 'a session/bound-id mismatch is no principal');
    assert.equal((await get('/evidence/NOT-AN-ID')).status, 404);
    assert.equal((await get('/evidence/0123456789abcdef')).status, 404, 'a well-formed id nobody owns');
  });

  test('A5 · evidence detail: quote, span, field, timestamps, and the related items', async () => {
    const sup = (await get('/view/superseded')).body.items[0];
    const d = (await get(`/evidence/${sup.id}`)).body;
    assert.equal(d.evidence.quote, 'We decided to use Postgres for storage.');
    assert.equal(d.evidence.field, 'body');
    assert.equal(d.evidence.classification, 'external:gmail');
    assert.equal(d.supersededBy[0].statement, 'Actually, we have decided to use MySQL instead.');
    assert.ok(Array.isArray(d.evidence.span) && d.evidence.sentAt && d.evidence.extractedAt);
  });

  test('A6 · deterministic answers for every supported intent; honest "not supported" otherwise', async () => {
    const oc = (await ask('What are my open commitments?')).body;
    assert.deepEqual([oc.supported, oc.intent, oc.modelUsed], [true, 'open_commitments', false]);
    assert.ok(oc.items.every(i => i.status !== 'superseded'), 'never relies on superseded evidence');
    assert.match(oc.summary, /None has been verified or completed/);
    const dl = (await ask('Any upcoming deadlines?')).body;
    assert.equal(dl.intent, 'upcoming_deadlines');
    assert.equal(dl.contradictions.length, 1, 'the conflicting launch dates are surfaced, not omitted');
    const dec = (await ask('What did we decide about storage?')).body;
    assert.deepEqual([dec.intent, dec.items.map(i => i.statement), dec.superseded.map(i => i.statement)], ['decisions_about', ['Actually, we have decided to use MySQL instead.'], ['We decided to use Postgres for storage.']]);
    assert.equal((await ask('Which decisions were changed?')).body.intent, 'superseded_decisions');
    assert.equal((await ask('Is there anything contradictory?')).body.intent, 'contradictions');
    const raj = (await ask('What did Raj promise?')).body;
    assert.deepEqual([raj.intent, raj.person.key], ['person', 'person:raj@acme.example']);
    const priya = (await ask('What did Priya promise?')).body;
    assert.equal(priya.ambiguous.length, 2, 'two Priyas: no guess');
    assert.deepEqual(priya.items, []);
    assert.equal((await ask('What did Zelda promise?')).body.summary, 'Nobody named "Zelda" appears in your email.');
    const atlas = (await ask('What is happening with project Atlas?')).body;
    assert.deepEqual([atlas.intent, atlas.threadIds], ['project', ['thr-atlas']]);
    const ev = (await ask(`Show the evidence for ${oc.items[0].id}`)).body;
    assert.equal(ev.intent, 'evidence');
    assert.equal(ev.detail.item.id, oc.items[0].id);
    const no = (await ask("What's the weather like in Paris?")).body;
    assert.deepEqual([no.supported, no.intent, no.items], [false, null, []]);
    assert.match(no.summary, /not supported yet/);
    for (const a of [oc, dl, dec, raj, atlas]) for (const i of a.items) checkItem(i);
  });

  test('A7 · after disconnect: nothing remains; old evidence ids are not found', async () => {
    const t = await owner(MAIL.slice(0, 1));
    sessions.set('t', { userId: t.user });
    const app2 = express(); app2.use(express.json());
    app2.use((req, res, next) => { req.session = sessions.get('t'); req.aquaUserId = t.user; EG.runWithDataClass('user', () => next()); });
    app2.use('/c', createConnectRouter({ getDeps: async () => ({ gmail: OAUTH.config, service: t.service, vault: {} }), now: () => NOW, log: { log() {}, warn() {} } }));
    const x = await new Promise(r => { const y = app2.listen(0, '127.0.0.1', () => r(y)); });
    const b2 = `http://127.0.0.1:${x.address().port}/c/gmail/intelligence`;
    try {
      const id = (await (await fetch(`${b2}/view/commitments`)).json()).items[0].id;
      await t.service.disconnect({ principal: t.principal, connectionId: t.conn.connectionId });
      assert.equal((await (await fetch(`${b2}/overview`)).json()).counts.items, 0);
      assert.equal((await fetch(`${b2}/evidence/${id}`)).status, 404);
    } finally { await new Promise(r => x.close(r)); }
  });

  test('A8 · the feature gate: Connect off → every intelligence route is 404', async () => {
    const app3 = express(); app3.use(express.json());
    app3.use((req, res, next) => { req.session = { userId: s.user }; req.aquaUserId = s.user; next(); });
    app3.use('/c', createConnectRouter({ getDeps: async () => ({ gmail: null }), log: { log() {}, warn() {} } }));
    const x = await new Promise(r => { const y = app3.listen(0, '127.0.0.1', () => r(y)); });
    try {
      for (const p of ['/overview', '/view/commitments', '/evidence/0123456789abcdef']) assert.equal((await fetch(`http://127.0.0.1:${x.address().port}/c/gmail/intelligence${p}`)).status, 404, p);
    } finally { await new Promise(r => x.close(r)); }
  });

  test('A9 · no egress: no network, no provider/embedding/rerank attempt; email content only in the restricted UKO store', async () => {
    assert.deepEqual(egress, []);
    const stats = EG.egressStats();
    assert.equal(JSON.stringify(stats).includes('external:gmail') ? 'attempted' : 'none', 'none', 'no provider call was even attempted with Gmail in scope');
    await new Promise(r => setTimeout(r, 1500));
    const hits = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { let t = ''; try { t = fs.readFileSync(p, 'utf8'); } catch { /* binary */ } if (t.includes('Postgres for storage') || t.includes('review the budget')) hits.push(path.relative(K.TMP, p)); } } };
    walk(K.TMP);
    assert.ok(hits.length > 0);
    assert.deepEqual(hits.filter(h => !/uko/i.test(h)), [], `Gmail content outside the restricted UKO store (legacy memory, Mind, index, evidence…): ${hits.join(', ')}`);
  });
});
