/**
 * Gmail Phase 6 — evaluation of the deterministic email understanding and the
 * model-free question answering against the FROZEN ground truth
 * (dataset.v1.json; hash in FROZEN.sha256, recorded before the first run).
 *
 *   node eval/gmail/evaluate.mjs <label>
 *
 * Isolation: imports the connect testkit FIRST (temporary data dir, provider
 * keys and DATABASE_URL stripped, no Mongo); refuses any non-loopback fetch.
 * The ground truth is never derived from the system: this file only reads it.
 * Output: eval/gmail/out/report.<label>.json + a summary on stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const K = await import('../../src/connect/tests/testkit.js');
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => { const x = new URL(String(u)); if (x.hostname !== '127.0.0.1') { egress.push(x.host); throw new Error('network refused'); } return realFetch(u, i); };

const U = await import('../../src/connect/gmail/emailUnderstanding.js');
const N = await import('../../src/connect/gmail/gmailNormalize.js');
const F = await import('../../src/connect/testing/gmailFixtures.js');
const { createGmailConnector } = await import('../../src/connect/gmail/gmailConnector.js');
const { createMockGmailService } = await import('../../src/connect/testing/mockGmailTransport.js');
const { principalForServerJob } = await import('../../src/connect/principal.js');
const { retrieveEmailEvidence } = await import('../../src/connect/gmail/emailContext.js');
const I = await import('../../src/connect/gmail/emailIntelligence.js');
const EG = await import('../../src/core/egressGuard.js');

const label = process.argv[2] ?? 'run';
// argv[3]: 'v1' (default; FROZEN.sha256) or 'heldout' (dataset.heldout.v1.json; FROZEN.heldout.sha256)
const set = process.argv[3] ?? 'v1';
const [dataFile, frozenFile] = set === 'heldout' ? ['dataset.heldout.v1.json', 'FROZEN.heldout.sha256'] : ['dataset.v1.json', 'FROZEN.sha256'];
const raw = fs.readFileSync(path.join(HERE, dataFile), 'utf8');
const datasetSha = crypto.createHash('sha256').update(raw).digest('hex');
const frozen = fs.readFileSync(path.join(HERE, frozenFile), 'utf8').split(/\s+/)[0];
if (frozen !== datasetSha) throw new Error(`dataset hash ${datasetSha} differs from the frozen hash ${frozen}: the ground truth changed after freezing`);
const D = JSON.parse(raw);
const NOW = Date.parse(D.now);
const EXTRACTED_AT = '2026-01-20T00:00:00.000Z';

const CATEGORY = { commitment: 'commitments', task: 'tasks', deadline: 'deadlines', date: 'deadlines', event: 'events', decision: 'decisions' };
const ITEM_CATS = ['commitments', 'tasks', 'deadlines', 'events', 'decisions'];
const lc = s => String(s ?? '').toLowerCase();
const basisOf = it => (it.explicit === true && it.certainty === 'stated' ? 'direct' : 'inference');
const dueOf = it => it.due?.date ?? it.when?.date ?? it.value?.date ?? null;
const textOf = it => lc(it.statement ?? it.evidence?.quote ?? '');
const prf = c => { const p = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null; const r = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null; return { ...c, precision: p, recall: r, f1: p != null && r != null && p + r > 0 ? (2 * p * r) / (p + r) : null }; };
const counter = () => ({ tp: 0, fp: 0, fn: 0 });

const build = (t, m) => F.buildMessage({ id: m.id, threadId: t.id, date: m.date, labels: m.labels, headers: { From: m.from, To: m.to, Cc: m.cc, Subject: m.subject, 'Message-ID': m.rfc, 'In-Reply-To': m.inReplyTo }, text: m.text });

// ── per message / per thread (pure path) ──────────────────────────────────────
const cats = Object.fromEntries([...ITEM_CATS, 'people', 'organizations', 'projects', 'topics', 'conversationRelationships'].map(c => [c, counter()]));
const attr = { basis: { correct: 0, overClaimed: 0, underClaimed: 0 }, due: { correct: 0, wrong: 0 }, time: { correct: 0, wrong: 0 }, actor: { correct: 0, wrong: 0 }, assignee: { correct: 0, wrong: 0 }, status: { correct: 0, wrong: 0 } };
const rejections = { correctlyRejected: 0, incorrectlyAccepted: 0, byCategory: {} };
const inference = { correctlyRejectedOrLabelled: 0, incorrectlyAcceptedAsDirect: 0 };
const supersession = { all: counter(), decisions: counter() };
const contradiction = counter();
const language = { messages: 0, detectedUnsupported: 0, statementsExtracted: 0, humanItemsOutOfScope: 0 };
const fps = [], fns = [], wrongAttrs = [];

for (const t of D.threads) {
  const recs = t.messages.map(m => ({ m, rec: U.understandEmail(N.renderGmailDocument(N.parseGmailMessage(build(t, m))), { extractedAt: EXTRACTED_AT }) }));
  const reconciled = U.reconcileThread(recs.map(r => r.rec));
  const byMsg = id => reconciled.filter(i => i.gmailMessageId === id);
  const rfcToId = new Map(t.messages.map(m => [m.rfc, m.id]));
  const anchorItem = ([mid, anchor], types) => byMsg(mid).find(i => types.includes(i.type) && textOf(i).includes(anchor));

  for (const { m, rec } of recs) {
    const e = m.expect;
    // set-level categories
    const setScore = (cat, expected, got, where) => {
      const E = new Set(expected.map(lc)), G = new Set(got.map(lc));
      for (const x of G) { if (E.has(x)) cats[cat].tp++; else { cats[cat].fp++; fps.push({ cat, where, got: x }); } }
      for (const x of E) if (!G.has(x)) { cats[cat].fn++; fns.push({ cat, where, expected: x }); }
    };
    setScore('people', e.people, rec.people.map(p => p.address), m.id);
    setScore('organizations', e.organizations, rec.organizations.map(o => o.domain), m.id);
    setScore('projects', e.projects, rec.items.filter(i => i.type === 'project').map(i => i.name), m.id);
    setScore('topics', [e.topic], [rec.conversation.topic], m.id);
    const parent = rec.conversation.inReplyTo ? rfcToId.get(rec.conversation.inReplyTo) ?? null : null;
    setScore('conversationRelationships', e.parent ? [`${m.id}->${e.parent}`] : [], parent ? [`${m.id}->${parent}`] : [], m.id);

    if (e.languageSupported === false) {
      language.messages++;
      if (rec.language?.supported === false) language.detectedUnsupported++;
      language.statementsExtracted += rec.items.filter(i => CATEGORY[i.type] || i.type === 'project').length;
      language.humanItemsOutOfScope += (e.outOfScope ?? []).length;
      continue;
    }

    // item-level categories
    const got = byMsg(m.id).filter(i => CATEGORY[i.type]);
    const used = new Set();
    for (const x of e.items.filter(i => !i.optional)) {
      const cat = CATEGORY[x.type];
      const hit = got.find(i => !used.has(i.id) && CATEGORY[i.type] === cat && textOf(i).includes(x.anchor));
      if (!hit) { cats[cat].fn++; fns.push({ cat, where: m.id, expected: x.anchor }); continue; }
      used.add(hit.id); cats[cat].tp++;
      const b = basisOf(hit);
      if (b === x.basis) attr.basis.correct++; else if (x.basis === 'inference') { attr.basis.overClaimed++; wrongAttrs.push({ where: m.id, anchor: x.anchor, attr: 'basis', expected: 'inference', got: 'direct' }); } else { attr.basis.underClaimed++; wrongAttrs.push({ where: m.id, anchor: x.anchor, attr: 'basis', expected: 'direct', got: 'inference' }); }
      if (x.basis === 'inference') (b === 'inference' ? inference.correctlyRejectedOrLabelled++ : inference.incorrectlyAcceptedAsDirect++);
      if ('due' in x) { const d = dueOf(hit); if (d === x.due) attr.due.correct++; else { attr.due.wrong++; wrongAttrs.push({ where: m.id, anchor: x.anchor, attr: 'due', expected: x.due, got: d }); } }
      if (x.time) { if (hit.when?.time === x.time) attr.time.correct++; else { attr.time.wrong++; wrongAttrs.push({ where: m.id, anchor: x.anchor, attr: 'time', expected: x.time, got: hit.when?.time ?? null }); } }
      if (x.actor) { if (hit.actor === `person:${x.actor}`) attr.actor.correct++; else { attr.actor.wrong++; wrongAttrs.push({ where: m.id, anchor: x.anchor, attr: 'actor', expected: x.actor, got: hit.actor }); } }
      if (x.assignee) {
        const a = hit.assignee ?? {};
        const ok = x.assignee === 'ambiguous' ? a.status === 'ambiguous' : (a.status === 'resolved' && a.person === `person:${x.assignee}`);
        if (ok) attr.assignee.correct++; else { attr.assignee.wrong++; wrongAttrs.push({ where: m.id, anchor: x.anchor, attr: 'assignee', expected: x.assignee, got: a.status === 'resolved' ? a.person : `${a.status}:${(a.candidates ?? []).join('|')}` }); }
      }
      if (x.status) {
        const ok = x.status === 'closed' ? !['current', 'contradicted'].includes(hit.status) : hit.status === x.status;
        if (ok) attr.status.correct++; else { attr.status.wrong++; wrongAttrs.push({ where: m.id, anchor: x.anchor, attr: 'status', expected: x.status, got: hit.status }); }
      }
    }
    for (const x of e.items.filter(i => i.optional)) {
      const hit = got.find(i => !used.has(i.id) && CATEGORY[i.type] === CATEGORY[x.type] && textOf(i).includes(x.anchor));
      if (!hit) continue;
      used.add(hit.id);
      if (basisOf(hit) === 'inference') inference.correctlyRejectedOrLabelled++; else { inference.incorrectlyAcceptedAsDirect++; wrongAttrs.push({ where: m.id, anchor: x.anchor, attr: 'basis(optional)', expected: 'inference', got: 'direct' }); }
    }
    for (const r of e.reject) {
      const cat = CATEGORY[r.type] ?? 'projects';
      const bad = r.type === 'project'
        ? rec.items.some(i => i.type === 'project' && lc(i.name).includes(r.anchor))
        : got.some(i => CATEGORY[i.type] === cat && textOf(i).includes(r.anchor));
      rejections.byCategory[cat] ??= { correctlyRejected: 0, incorrectlyAccepted: 0 };
      if (bad) { rejections.incorrectlyAccepted++; rejections.byCategory[cat].incorrectlyAccepted++; } else { rejections.correctlyRejected++; rejections.byCategory[cat].correctlyRejected++; }
    }
    for (const i of got) if (!used.has(i.id)) { cats[CATEGORY[i.type]].fp++; fps.push({ cat: CATEGORY[i.type], where: m.id, got: textOf(i), status: i.status, basis: basisOf(i) }); }
  }

  // thread-level: supersession and contradiction pairs
  const expSup = (t.threadExpect.superseded ?? []).map(s => ({ a: anchorItem(s.earlier, ['deadline', 'date', 'decision', 'commitment', 'task', 'event']), b: anchorItem(s.later, ['deadline', 'date', 'decision', 'commitment', 'task', 'event']), kind: s.kind, s }));
  const predSup = reconciled.filter(i => i.status === 'superseded' && i.supersededBy).map(i => ({ a: i.id, b: i.supersededBy, kind: i.type }));
  for (const x of expSup) {
    const ok = x.a && x.b && predSup.some(p => p.a === x.a.id && p.b === x.b.id);
    for (const bucket of x.kind === 'decision' ? [supersession.all, supersession.decisions] : [supersession.all]) ok ? bucket.tp++ : bucket.fn++;
    if (!ok) fns.push({ cat: x.kind === 'decision' ? 'supersededDecisions' : 'supersession', where: t.id, expected: `${x.s.earlier[1]} → ${x.s.later[1]}` });
  }
  for (const p of predSup) {
    if (expSup.some(x => x.a?.id === p.a && x.b?.id === p.b)) continue;
    for (const bucket of p.kind === 'decision' ? [supersession.all, supersession.decisions] : [supersession.all]) bucket.fp++;
    fps.push({ cat: p.kind === 'decision' ? 'supersededDecisions' : 'supersession', where: t.id, got: `${textOf(reconciled.find(i => i.id === p.a))} → ${textOf(reconciled.find(i => i.id === p.b))}` });
  }
  const expCon = (t.threadExpect.contradictions ?? []).map(c => [anchorItem(c.a, ['date', 'deadline', 'event', 'commitment', 'task']), anchorItem(c.b, ['date', 'deadline', 'event', 'commitment', 'task'])]);
  const key = (x, y) => [x, y].sort().join('|');
  const predCon = new Set(reconciled.filter(i => i.status === 'contradicted').flatMap(i => (i.conflictsWith ?? []).map(o => key(i.id, o))));
  for (const [a, b] of expCon) { if (a && b && predCon.has(key(a.id, b.id))) contradiction.tp++; else { contradiction.fn++; fns.push({ cat: 'contradictions', where: t.id }); } }
  for (const k of predCon) if (!expCon.some(([a, b]) => a && b && key(a.id, b.id) === k)) { contradiction.fp++; fps.push({ cat: 'contradictions', where: t.id, got: k }); }
}

// ── the whole corpus, ingested for one owner: temporal views + question answering ─
const mock = createMockGmailService({ now: Date.now });
const registry = K.createConnectorRegistry({ allowTestOnly: true });
registry.register(createGmailConnector({ transport: mock.transport, pageSize: 50 }));
const service = K.createConnectService({ registry, store: K.createMemoryConnectionStore(), vault: K.createCredentialVault({ key: K.TEST_KEY }), log: { log() {}, warn() {} }, retry: { sleep: async () => {}, baseMs: 0 } });
const principal = principalForServerJob('gmail-eval-owner');
for (const t of D.threads) for (const m of t.messages) mock.addMessage('eval@example.test', build(t, m));
const conn = await service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode('eval@example.test') } });
const syncResult = await service.sync({ principal, connectionId: conn.connectionId, mode: 'full' });

const temporal = [];
const check = (name, ok, detail) => temporal.push({ name, ok, ...(detail ? { detail } : {}) });
await EG.runWithDataClass('user', async () => {
  const b = retrieveEmailEvidence({ principal, now: NOW, limit: 2000 });
  const st = ref => lc(b.evidence.find(e => e.ref === ref)?.statement);
  const open = [...b.openCommitments, ...b.openTasks].map(st);
  const upcoming = b.upcoming.map(u => st(u.ref));
  for (const t of D.threads) {
    const x = t.threadExpect;
    for (const a of x.open ?? []) check(`${t.id} open: ${a}`, open.some(s => s.includes(a)));
    for (const a of x.notOpen ?? []) check(`${t.id} NOT open: ${a}`, !open.some(s => s.includes(a)));
    for (const a of x.upcoming ?? []) check(`${t.id} upcoming: ${a}`, upcoming.some(s => s.includes(a)));
    for (const a of x.notUpcoming ?? []) check(`${t.id} NOT upcoming: ${a}`, !upcoming.some(s => s.includes(a)));
    for (const [a, nExp] of Object.entries(x.openCount ?? {})) { const n = open.filter(s => s.includes(a)).length; check(`${t.id} counted once: ${a}`, n === nExp, `counted ${n}`); }
  }
  check('inferred items are never presented as direct (open/upcoming views)', b.evidence.filter(e => e.basis === 'direct').every(e => e.explicit === true && e.certainty === 'stated'));
  check('no item is user-confirmed', b.evidence.every(e => e.userConfirmed === false));
});

// question answering
const qa = [];
await EG.runWithDataClass('user', async () => {
  const b = retrieveEmailEvidence({ principal, now: NOW, limit: 2000 });
  for (const q of D.questions) {
    const question = q.question.replace(/\{id:([^}]+)\}/, (_, a) => b.evidence.find(e => lc(e.statement).includes(a))?.id ?? '0000000000000000');
    const a = I.ask({ principal, question, now: NOW });
    const st = (a.items ?? []).map(i => lc(i.statement));
    const sup = (a.superseded ?? []).map(i => lc(i.statement));
    const r = {
      id: q.id, question: q.question, intent: a.intent, supported: a.supported,
      intentCorrect: q.intent.includes(a.intent),
      missing: q.mustInclude.filter(x => !st.some(s => s.includes(x))),
      wronglyIncluded: q.mustExclude.filter(x => st.some(s => s.includes(x))),
      unsupportedCorrect: q.unsupported ? a.supported === false : null,
      ambiguityCorrect: q.ambiguous ? Array.isArray(a.ambiguous) && a.ambiguous.length > 1 && st.length === 0 : null,
      contradictionsDisclosed: q.contradictionsMustBeDisclosed ? (a.contradictions ?? []).length > 0 : null,
      supersededListed: q.supersededMustList ? q.supersededMustList.every(x => sup.some(s => s.includes(x))) : null,
      inferenceLabelled: q.inferenceMustBeLabelled ? q.inferenceMustBeLabelled.every(x => (a.items ?? []).filter(i => lc(i.statement).includes(x)).every(i => i.basis === 'inference')) : null,
      countedOnce: q.countOnce ? q.countOnce.every(x => st.filter(s => s.includes(x)).length === 1) : null,
      evidenceBacked: (a.items ?? []).every(i => Array.isArray(i.evidenceIds) && i.evidenceIds.includes(i.id)),
      relevantRetrieved: q.mustInclude.length - q.mustInclude.filter(x => !st.some(s => s.includes(x))).length, relevantExpected: q.mustInclude.length,
      returned: st.length,
    };
    r.pass = r.intentCorrect && !r.missing.length && !r.wronglyIncluded.length && r.evidenceBacked && [r.unsupportedCorrect, r.ambiguityCorrect, r.contradictionsDisclosed, r.supersededListed, r.inferenceLabelled, r.countedOnce].every(v => v !== false);
    qa.push(r);
  }
});

const report = {
  label, datasetSha, generatedAt: new Date().toISOString(), now: D.now,
  dataset: { threads: D.threads.length, messages: D.threads.reduce((n, t) => n + t.messages.length, 0), expectedItems: D.threads.flatMap(t => t.messages).reduce((n, m) => n + m.expect.items.length, 0), rejectCases: D.threads.flatMap(t => t.messages).reduce((n, m) => n + m.expect.reject.length, 0), questions: D.questions.length },
  categories: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, prf(v)])),
  supersession: { all: prf(supersession.all), decisions: prf(supersession.decisions) },
  contradictions: prf(contradiction),
  attributes: attr, inference, rejections, language,
  temporal: { passed: temporal.filter(x => x.ok).length, total: temporal.length, failed: temporal.filter(x => !x.ok) },
  qa: { passed: qa.filter(x => x.pass).length, total: qa.length, intentCorrect: qa.filter(x => x.intentCorrect).length, results: qa },
  falsePositives: fps, falseNegatives: fns, wrongAttributes: wrongAttrs,
  sync: { state: syncResult.lastSync.state, counts: syncResult.lastSync.counts },
  egress,
};
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, "out", `report.${set}.${label}.json`), JSON.stringify(report, null, 2));

const pct = v => (v == null ? '  n/a' : `${(v * 100).toFixed(0).padStart(4)}%`);
console.log(`dataset ${datasetSha.slice(0, 12)} · ${report.dataset.threads} threads · ${report.dataset.messages} messages · sync ${report.sync.state}`);
console.log('category                     tp  fp  fn   prec  recall    f1');
for (const [k, v] of [...Object.entries(report.categories), ['superseded (all)', report.supersession.all], ['superseded decisions', report.supersession.decisions], ['contradictions', report.contradictions]]) {
  console.log(`${k.padEnd(27)}${String(v.tp).padStart(4)}${String(v.fp).padStart(4)}${String(v.fn).padStart(4)}  ${pct(v.precision)}  ${pct(v.recall)}  ${pct(v.f1)}`);
}
console.log(`attributes: ${JSON.stringify(attr)}`);
console.log(`inference: ${JSON.stringify(inference)} · rejections: ${rejections.correctlyRejected}/${rejections.correctlyRejected + rejections.incorrectlyAccepted} correctly rejected`);
console.log(`language: ${JSON.stringify(language)}`);
console.log(`temporal: ${report.temporal.passed}/${report.temporal.total}${report.temporal.failed.length ? ' — FAILED: ' + report.temporal.failed.map(x => x.name + (x.detail ? ` (${x.detail})` : '')).join('; ') : ''}`);
console.log(`qa: ${report.qa.passed}/${report.qa.total} pass, intent ${report.qa.intentCorrect}/${report.qa.total}`);
for (const r of qa.filter(x => !x.pass)) console.log(`  ✗ ${r.id} intent=${r.intent} missing=${JSON.stringify(r.missing)} wrong=${JSON.stringify(r.wronglyIncluded)} ${['unsupportedCorrect', 'ambiguityCorrect', 'contradictionsDisclosed', 'supersededListed', 'inferenceLabelled', 'countedOnce'].filter(k => r[k] === false).join(',')}`);
console.log(`false positives (${fps.length}): ${fps.map(f => `[${f.cat}] ${f.where}: ${f.got}`).join(' | ')}`);
console.log(`false negatives (${fns.length}): ${fns.map(f => `[${f.cat}] ${f.where}: ${f.expected ?? ''}`).join(' | ')}`);
console.log(`wrong attributes (${wrongAttrs.length}): ${wrongAttrs.map(w => `${w.where} ${w.anchor} ${w.attr}: want ${w.expected} got ${w.got}`).join(' | ')}`);
console.log(`egress: ${JSON.stringify(egress)}`);
