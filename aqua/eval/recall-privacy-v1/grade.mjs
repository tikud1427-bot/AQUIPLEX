#!/usr/bin/env node
/**
 * Frozen grader for recall-privacy.v1 (written 2026-11-06, before the code it
 * grades). Fully offline: the embedding provider is a FAKE transport on the
 * dedicated embedder (deterministic hashed-word vectors) behind a placeholder
 * key; fetch, http(s) and sockets are tripwires; private data dir; no Mongo, no
 * database. Every text handed to the provider is recorded, so "never sent" is
 * checked exactly.
 *
 *   node eval/recall-privacy-v1/grade.mjs [--json <file>] [--verbose]
 *
 * Refuses when dataset.v1.json, grade.mjs or README.md differ from MANIFEST.sha256
 * (--unfrozen-ok only while authoring). Exit 0 = all pass; 1 = a failure; 2 = refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.resolve(HERE, '../..');
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const jsonOut = (() => { const i = argv.indexOf('--json'); return i >= 0 ? argv[i + 1] : null; })();
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
{
  const man = path.join(HERE, 'MANIFEST.sha256');
  const bad = !fs.existsSync(man) ? ['MANIFEST.sha256 missing'] : fs.readFileSync(man, 'utf8').split('\n').filter(Boolean)
    .map(l => l.match(/^([0-9a-f]{64}) [ *](.+)$/)).filter(Boolean)
    .filter(([, h, f]) => !fs.existsSync(path.join(HERE, f)) || sha(path.join(HERE, f)) !== h).map(([, , f]) => f);
  if (bad.length && !argv.includes('--unfrozen-ok')) { console.error(`refused: frozen files changed: ${bad.join(', ')}`); process.exit(2); }
  if (bad.length) console.log(`UNFROZEN (authoring only): ${bad.join(', ')}`);
}

// ── isolation ────────────────────────────────────────────────────────────────
let netAttempts = 0;
const trip = () => { netAttempts++; throw new Error('recall-privacy grader: network is blocked'); };
globalThis.fetch = async () => trip();
for (const m of [https, http]) { m.request = trip; m.get = trip; }
net.connect = net.createConnection = trip; tls.connect = trip;
for (const k of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|MONGO|DATABASE|^GEMINI|^Gemini|^AQUA_SEMANTIC_RECALL$|^AQUA_RECALL_FOLLOWUP_V2$|^AQUA_EMBEDDINGS$|^AQUA_EPISODIC_RECALL$/i.test(k)) delete process.env[k];
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-recall-privacy-v1-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.AQUA_RECALL_ALL_CHARS = '200';          // ranked (and semantic) on these short histories

const imp = p => import(pathToFileURL(path.join(AQUA, p)).href);
const R = await imp('src/memory/episodicRecall.js');
const SR = await imp('src/memory/semanticRecall.js');
const RR = await imp('src/memory/recallRedactions.js');
const DE = await imp('src/embeddings/dedicatedEmbedder.js');
const VS = await imp('src/embeddings/vectorStore.js');
const { EMBED_DIM } = await imp('src/embeddings/embeddingModel.js');
const { deleteMind } = await imp('src/mind/mindStore.js');
const { sensitivePolicy } = await imp('src/memory/sensitivity.js');
const DS = JSON.parse(fs.readFileSync(path.join(HERE, 'dataset.v1.json'), 'utf8'));

const DAY = 86_400_000, T0 = Date.UTC(2026, 5, 1);
const FILLERS = ['The cat slept on the sofa all afternoon.', 'I watered the tomatoes on the balcony.', 'We watched a documentary about owls.',
  'The kettle whistles very loudly.', 'My neighbour plays the cello in the evenings.', 'I bought green apples at the market.',
  'The bus was crowded this morning.', 'I read a short story about a lighthouse keeper.', 'The library closes early on Sundays.', 'We painted the fence white.'];

// Deterministic fake vectors: hashed bag of words plus a small shared component.
const fakeVec = t => { const v = new Array(EMBED_DIM).fill(0); v[0] = 0.2; for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) v[1 + [...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % (EMBED_DIM - 1), 7)] += 1; return v; };
let sent = [];
const transports = {
  ok: async (key, texts) => { sent.push(...texts); return { embeddings: texts.map(t => ({ values: fakeVec(t) })) }; },
  500: async (key, texts) => { sent.push(...texts); const e = new Error('server'); e.status = 500; throw e; },
  timeout: (key, texts) => { sent.push(...texts); return new Promise(() => {}); },
};
let transportName = 'ok';
const useTransport = name => { transportName = name; DE.__resetDedicatedForTests(); DE.__setDedicatedTransportForTests(transports[name]); };
const settle = () => new Promise(r => setTimeout(r, 40));   // fire-and-forget indexing

function build(c, deleted) {
  const userId = `u-${c.id}`;
  const conversations = new Map();
  const items = [...c.history, ...FILLERS.map((text, i) => ({ id: `f${i}`, day: 40 + i, text }))];
  for (const it of items) {
    if (deleted.has(it.id)) continue;
    conversations.set(`${c.id}-${it.id}`, { meta: { userId: it.owner ?? userId, title: `${c.id} ${it.id}` }, messages: [{ role: 'user', content: it.text, ts: T0 + it.day * DAY }] });
  }
  return { userId, ownerId: `user:${userId}`, conversations };
}

async function ask(c, deleted, step, { early = false, semantic = true } = {}) {
  const { userId, ownerId, conversations } = build(c, deleted);
  R.__clearCacheForTests();
  if (semantic && c.mode === 'hybrid') process.env.AQUA_SEMANTIC_RECALL = 'on'; else delete process.env.AQUA_SEMANTIC_RECALL;
  const sensitive = sensitivePolicy({ rememberSensitive: step.rememberSensitive === true, message: step.question });
  const queryVector = early ? R.startRecallQueryVector({ userId, conversationId: 'none', query: step.question, conversations }) : undefined;
  const r = await R.recallForTurn({ ownerId, userId, conversationId: 'none', query: step.question, conversations, includeFiles: false,
    sensitive, semanticTimeoutMs: 250, ...(queryVector ? { queryVector } : {}) });
  await settle();
  return r;
}

const report = { dataset: DS.id, datasetSha256: sha(path.join(HERE, 'dataset.v1.json')), graderSha256: sha(path.join(HERE, 'grade.mjs')), at: new Date().toISOString(), cases: [] };
let failed = 0;

for (const c of DS.cases) {
  const problems = [];
  const log = [];
  for (const flag of c.flags ?? ['off']) {
    if (flag === 'v2') process.env.AQUA_RECALL_FOLLOWUP_V2 = 'on'; else delete process.env.AQUA_RECALL_FOLLOWUP_V2;
    VS.__resetForTests(); RR.__resetForTests(); R.__clearCacheForTests();
    process.env.AQUA_EMBEDDING_API_KEY = 'offline-grader-placeholder-not-a-key';
    useTransport('ok');
    const deleted = new Set();
    for (const [si, step] of c.steps.entries()) {
      const tag = `[${flag}] step ${si + 1} ${step.do}`;
      const mark = sent.length;
      const { userId, ownerId, conversations } = build(c, deleted);
      let r = null;
      try {
        if (step.do === 'index') {
          process.env.AQUA_SEMANTIC_RECALL = 'on';
          R.__clearCacheForTests();
          await SR.indexRecallUnits(ownerId, R.collectUnits({ userId, conversationId: 'none', conversations }));
        } else if (step.do === 'forget') RR.redactPhrases(ownerId, step.phrases);
        else if (step.do === 'plantVector') {
          const it = c.history.find(h => h.id === step.id);
          R.__clearCacheForTests();
          const u = R.collectUnits({ userId, conversationId: 'none', conversations }).find(x => x.text === it.text);
          VS.upsert(SR.recallNamespace(ownerId), u.key, fakeVec(u.text), DE.dedicatedContentHash(u.text));
        } else if (step.do === 'transport') useTransport(step.fail ?? 'ok');
        else if (step.do === 'deleteMind') deleteMind(ownerId);
        else if (step.do === 'deleteConversation') deleted.add(step.id);
        else if (step.do === 'ask' || step.do === 'askEarly') r = await ask(c, deleted, step, { early: step.do === 'askEarly' });
        else problems.push(`${tag}: unknown step`);
      } catch (err) { problems.push(`${tag}: threw ${err?.message ?? err}`); }
      const stepSent = sent.slice(mark);
      const e = step.expect ?? {};
      const quoted = r ? r.excerpts.map(x => x.text).join(' ‖ ') : '';
      for (const s of e.quotedIncludes ?? []) if (!quoted.includes(s)) problems.push(`${tag} "${step.question}": expected quote containing "${s}" — got: ${quoted || '(nothing)'}`);
      for (const s of e.quotedExcludes ?? []) if (quoted.includes(s)) problems.push(`${tag} "${step.question}": quoted "${s}" — got: ${quoted}`);
      for (const s of e.sentIncludes ?? []) if (!stepSent.some(t => t.includes(s))) problems.push(`${tag}: expected the provider to receive "${s}" — sent: ${JSON.stringify(stepSent)}`);
      for (const s of e.sentExcludes ?? []) if (stepSent.some(t => t.includes(s))) problems.push(`${tag}: the provider received "${s}" — sent: ${JSON.stringify(stepSent.filter(t => t.includes(s)))}`);
      for (const [k, min] of Object.entries(e.statsMin ?? {})) if (!(Number(r?.stats?.[k]) >= min)) problems.push(`${tag}: stats.${k}=${r?.stats?.[k]}, expected >= ${min}`);
      if (e.modeNot && r?.stats?.mode === e.modeNot) problems.push(`${tag}: mode ${r.stats.mode}, expected not ${e.modeNot}`);
      if (e.sameAsKeywordOnly && r) {
        const was = transportName;
        const k = await ask(c, deleted, step, { semantic: false });
        useTransport(was);
        if (JSON.stringify(k.excerpts.map(x => x.text)) !== JSON.stringify(r.excerpts.map(x => x.text))) problems.push(`${tag}: differs from keyword-only — semantic: ${quoted} | keyword: ${k.excerpts.map(x => x.text).join(' ‖ ')}`);
      }
      if (r) {
        const ts = r.excerpts.map(x => x.ts ?? 0);
        if (ts.some((t, i) => i && t < ts[i - 1])) problems.push(`${tag}: excerpts not in date order`);
        log.push(`${flag}#${si + 1} ${r.stats?.mode ?? '-'} f${r.stats?.forgottenSentences ?? '?'}/w${r.stats?.withheldSentences ?? '?'} → ${quoted.slice(0, 120) || '(nothing)'}`);
      }
    }
  }
  delete process.env.AQUA_RECALL_FOLLOWUP_V2; delete process.env.AQUA_SEMANTIC_RECALL;
  const pass = problems.length === 0;
  if (!pass) failed++;
  report.cases.push({ id: c.id, group: c.group, mode: c.mode, pass, problems, log });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(3)} ${c.group.padEnd(10)} ${c.mode.padEnd(7)} ${c.note}`);
  if (!pass || VERBOSE) { for (const p of problems) console.log(`       ✗ ${p.slice(0, 400)}`); if (VERBOSE) for (const l of log) console.log(`       · ${l}`); }
}
const groups = {};
for (const r of report.cases) { groups[r.group] ??= { pass: 0, total: 0 }; groups[r.group].total++; if (r.pass) groups[r.group].pass++; }
report.summary = { pass: report.cases.length - failed, total: report.cases.length, groups, networkAttempts: netAttempts };
console.log(`\n${report.summary.pass}/${report.summary.total} cases pass · ${Object.entries(groups).map(([g, v]) => `${g} ${v.pass}/${v.total}`).join(' · ')} · network attempts ${netAttempts}`);
if (jsonOut) { fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true }); fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`); }
process.exit(failed || netAttempts ? 1 : 0);
