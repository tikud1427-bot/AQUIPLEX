#!/usr/bin/env node
/**
 * PWI benchmark — one stage in one process (2026-11-15).
 *
 *   node eval/pwi/stage.mjs --dataset <file> --stage A|B|C --mode run|verify --out <file>
 *
 * The parent (run-pwi.mjs) sets AQUA_DATA_DIR (shared by every stage of an
 * arm, so later stages see what earlier ones stored — across real process
 * restarts) and the arm's flags. Nothing here talks to a model or the network:
 * no generation is ever called, and every non-loopback request is refused and
 * counted (the same guard as the ACIB adapter).
 *
 * run:    apply the stage's events for ALL users, interleaved by date (one shared
 *         server), through the production write path; then ask the stage's probes;
 *         then snapshot each user's stores.
 * verify: no events — a fresh process over the same data dir asks the same probes
 *         and snapshots again (persistence across restarts).
 *
 * Writes: prepareTurn → persist user message → commit the turn's memory →
 * persist a stub assistant reply → runPostTurn (as eval/adapters/acibPipeline.mjs).
 * Uploads: the real POST /upload route on loopback. Memory-page actions: the
 * functions routes/memory.js calls (correctFact + correctFactEverywhere; forgetFact).
 * Probes: prepareTurn in a NEW conversation, then rolled back (not persisted).
 * The process ends through the production SIGTERM handler (core/atomicStore.js:
 * flush every store, drain jobs), which is what a deploy restart does.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
for (const k of ['dataset', 'stage', 'mode', 'out']) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
if (!process.env.AQUA_DATA_DIR) { console.error('AQUA_DATA_DIR must be set by the runner'); process.exit(2); }
if (process.env.DATABASE_URL) { console.error('refusing: DATABASE_URL is set (the benchmark measures the production configuration without a database)'); process.exit(2); }

// ── Scenario clock: events happen on their dates ─────────────────────────────
const RealDate = Date;
let NOW = RealDate.parse('2026-01-01T00:00:00Z');
class ScenarioDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
globalThis.Date = ScenarioDate;
const setClock = iso => { NOW = RealDate.parse(iso); };

// ── Network guard (loopback only) ────────────────────────────────────────────
const network = { blocked: 0, hosts: [] };
const isLoopback = h => /^(127\.|localhost$|::1$|\[::1\])/.test(String(h ?? ''));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!isLoopback(url.hostname)) { network.blocked++; network.hosts.push(url.hostname); throw new Error(`PWI network guard: ${url.hostname} refused`); }
  return realFetch(input, init);
};
for (const mod of [http, https]) {
  const orig = mod.request;
  mod.request = function guarded(opts, ...rest) {
    const host = typeof opts === 'string' ? new URL(opts).hostname : (opts instanceof URL ? opts.hostname : (opts?.hostname ?? opts?.host ?? 'localhost'));
    if (!isLoopback(host)) { network.blocked++; network.hosts.push(String(host)); throw new Error(`PWI network guard: ${host} refused`); }
    return orig.call(this, opts, ...rest);
  };
}

// ── Console: kept out of the result, saved beside it for diagnosis ───────────
const logLines = [];
for (const k of ['log', 'warn', 'info', 'debug', 'error']) console[k] = (...a) => { if (logLines.length < 20000) logLines.push(`${k}: ${a.map(String).join(' ')}`); };

const { loadDataset } = await import('./truth.mjs');
const { dataset, sha256 } = loadDataset(args.dataset);
const imp = p => import(new URL(`../../src/${p}`, import.meta.url).href);
const chat = await imp('routes/chat.js');
const obs = await imp('core/observability.js');
const cost = await imp('core/costAccounting.js');
const conv = await imp('memory/conversationStore.js');
const txn = await imp('memory/turnCommit.js');
const post = await imp('routes/turnPostProcess.js');
const jobs = await imp('core/jobs/jobRegistry.js');
const uploadRoute = (await imp('routes/upload.js')).default;
const { getFacts } = await imp('memory/longTermMemory.js');
const { correctFact } = await imp('memory/memoryEditor.js');
const { correctFactEverywhere, forgetFact } = await imp('memory/forget.js');
const { peekMind } = await imp('mind/mindStore.js');
const { listFacts } = await imp('files/evidenceStore.js');
const { mentions } = await import('./truth.mjs');
const express = (await import('express')).default;

const infra = [];   // failures of the harness or the platform, kept apart from benchmark misses
const ownerOf = new Map();   // persona id → memory owner, as the product resolves it

async function prepare(userId, conversationId, text) {
  const { id } = conv.getOrCreateConversation(conversationId, { userId });
  const ctx = obs.createContext({ conversationId: id, requestId: `pwi-${Math.random().toString(36).slice(2)}` });
  ctx.costLedger = cost.createTurnLedger();
  const prep = await chat.prepareTurn({ userMessage: text, workspaceId: null, conversationId: id, userId, ctx, requestId: ctx.requestId, skipReasoningPass: true });
  return { prep, ctx, id };
}

async function say(persona, ev) {
  const { prep, ctx, id } = await prepare(persona.userId, `${persona.userId}-${ev.conv}`, ev.say);
  ownerOf.set(persona.id, prep.memoryOwner);
  conv.addMessage(id, 'user', ev.say);
  txn.commitTurnMemory(ctx.memoryTxn);
  const answer = 'Noted.';
  conv.addMessage(id, 'assistant', answer);
  post.runPostTurn({ ownerId: prep.memoryOwner, conversationId: id, ...chat.memoryWriteTurn(prep, answer), taskType: prep.taskType, workspaceId: null });
}

let uploadBase = null;
async function upload(persona, ev) {
  if (!uploadBase) {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use((req, _res, next) => { req.aquaUserId = req.headers['x-pwi-user']; next(); });
    app.use('/upload', uploadRoute);
    const server = app.listen(0); server.unref();
    await new Promise(r => server.once('listening', r));
    uploadBase = `http://127.0.0.1:${server.address().port}`;
  }
  const r = await realFetch(`${uploadBase}/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pwi-user': persona.userId },
    body: JSON.stringify({ conversationId: `${persona.userId}-docs-${ev.stage}`, files: [{ name: ev.upload.name, content: Buffer.from(ev.upload.content).toString('base64') }] }),
  });
  if (!r.ok) throw new Error(`upload ${ev.upload.name} failed (${r.status})`);
}

/** The Memory page acts on a fact it can SHOW: find the stored fact holding the value. */
function factHolding(owner, value) {
  return getFacts(owner).find(f => [].concat(f.value).some(v => mentions(String(v?.name ?? v?.value ?? v ?? ''), value)));
}
async function pageAction(persona, ev) {
  const owner = ownerOf.get(persona.id) ?? `user:${persona.userId}`;
  const a = ev.action;
  if (a.kind === 'pageCorrect') {
    const f = factHolding(owner, a.from);
    if (!f) return { kind: a.kind, slot: a.slot, applied: false, reason: 'not-captured: no stored fact shows this value, so the Memory page cannot correct it' };
    const old = f.value;
    const r = correctFact(owner, f.key, a.to, {});
    if (r?.ok) await correctFactEverywhere(owner, f.key, old, a.to);
    return { kind: a.kind, slot: a.slot, applied: !!r?.ok, key: f.key };
  }
  if (a.kind === 'pageForget') {
    const f = factHolding(owner, a.value);
    if (!f) return { kind: a.kind, slot: a.slot, applied: false, reason: 'not-captured: no stored fact shows this value, so the Memory page cannot delete it' };
    await forgetFact(owner, f.key);
    return { kind: a.kind, slot: a.slot, applied: true, key: f.key };
  }
  throw new Error(`unknown action ${a.kind}`);
}

function snapshot(persona) {
  const owner = ownerOf.get(persona.id) ?? `user:${persona.userId}`;
  const safe = (where, fn, dflt) => { try { return fn(); } catch (err) { infra.push({ where: `snapshot:${where}:${persona.id}`, error: String(err?.message ?? err) }); return dflt; } };
  const facts = safe('facts', () => getFacts(owner, { includeArchived: true }), []);
  const mind = safe('mind', () => peekMind(owner), null);
  const evidence = safe('evidence', () => listFacts(owner, { limit: 100_000 }), []);
  return {
    owner,
    facts: facts.map(f => ({ key: f.key, value: f.value, ended: !!f.ended, archived: !!f.archived, status: f.status ?? null,
      history: f.history ?? [], transitions: f.transitions ?? [], laterWord: f.laterWord ?? null, retiredItems: f.retiredItems ?? [], sourceText: f.sourceText ?? null })),
    mind: mind ? { beliefs: mind.beliefs ?? {}, goals: mind.goals ?? {}, working: mind.working ?? {}, graph: mind.graph ?? { nodes: {}, edges: {} }, episodes: mind.episodes ?? {} } : null,
    evidence: evidence.map(f => ({ statement: f.statement ?? f.text ?? '', archived: !!f.archived })),
  };
}

const stage = args.stage;
args.regime ??= 'short';

// ACIB v1's filler (frozen; checked against its recorded hash before use).
const FILLER_TARGET = 9000;
let FILLER = [];
if (args.regime === 'long') {
  const f = new URL('../datasets/acib.v1.json', import.meta.url);
  const raw = fs.readFileSync(f);
  const want = fs.readFileSync(new URL('../datasets/acib.v1.FROZEN.sha256', import.meta.url), 'utf8').split(/\s+/)[0];
  const got = (await import('node:crypto')).createHash('sha256').update(raw).digest('hex');
  if (got !== want) { console.error('acib.v1.json does not match its frozen hash'); process.exit(2); }
  FILLER = JSON.parse(raw.toString('utf8')).filler;
}
/** Filler lines this stage adds for a persona: deterministic, continuing the cycle across stages. */
function fillerForStage(persona, st) {
  const idx = ['A', 'B', 'C'].indexOf(st);
  const cumulative = upTo => {
    const said = persona.events.filter(e => e.say && ['A', 'B', 'C'].indexOf(e.stage) <= upTo).reduce((n, e) => n + e.say.length, 0);
    let chars = said, n = 0;
    while (chars <= FILLER_TARGET * (upTo + 1)) { chars += FILLER[n % FILLER.length].length; n++; }
    return n;
  };
  const before = idx > 0 ? cumulative(idx - 1) : 0;
  const now = cumulative(idx);
  return Array.from({ length: Math.max(0, now - before) }, (_, k) => FILLER[(before + k) % FILLER.length]);
}

const result = { dataset: { version: dataset.version, sha256 }, stage, mode: args.mode, regime: args.regime, startedAt: new RealDate().toISOString(), events: [], filler: {}, probes: [], stores: {}, infra, network };

// ── 1. Events (run mode) ─────────────────────────────────────────────────────
if (args.mode === 'run') {
  const queue = dataset.personas.flatMap(p => p.events.filter(e => e.stage === stage).map(e => ({ p, e }))).sort((a, b) => a.e.date.localeCompare(b.e.date));
  for (const { p, e } of queue) {
    setClock(e.date);
    const rec = { persona: p.id, date: e.date, kind: e.say ? 'say' : e.upload ? 'upload' : 'action' };
    try {
      if (e.say) await say(p, e);
      else if (e.upload) await upload(p, e);
      else rec.action = await pageAction(p, e);
      rec.ok = true;
    } catch (err) {
      rec.ok = false; rec.error = String(err?.message ?? err);
      infra.push({ where: `event:${p.id}:${e.date}`, error: rec.error });
    }
    result.events.push(rec);
  }
  // Long regime: after the stage's events, unrelated conversations (ACIB v1's frozen,
  // label-free filler) until the user's own words pass 9,000 × stage-number characters,
  // so recall must RANK instead of quoting everything (AQUA_RECALL_ALL_CHARS = 8,000).
  if (args.regime === 'long') {
    const stageLast = queue.map(q => q.e.date).sort().at(-1);
    setClock(new RealDate(RealDate.parse(stageLast) + 3_600_000).toISOString());   // an hour after the stage's last event
    for (const p of dataset.personas) {
      const plan = fillerForStage(p, stage);
      for (const [i, t] of plan.entries()) {
        try { await say(p, { conv: `filler-${stage}-${Math.floor(i / 5)}`, say: t }); }
        catch (err) { infra.push({ where: `filler:${p.id}:${stage}:${i}`, error: String(err?.message ?? err) }); }
      }
      result.filler[p.id] = plan.length;
    }
  }
  try { await jobs.drainJobs(15_000); } catch (err) { infra.push({ where: 'drainJobs', error: String(err?.message ?? err) }); }
}

// ── 2. Probes ────────────────────────────────────────────────────────────────
const lastDate = dataset.personas.flatMap(p => p.events.filter(e => e.stage === stage).map(e => e.date)).sort().at(-1);
setClock(new RealDate(RealDate.parse(lastDate) + 86_400_000).toISOString());   // the day after the stage's last event
for (const p of dataset.personas) {
  for (const q of p.probes.filter(q => q.stages.includes(stage))) {
    const rec = { persona: p.id, probe: q.id, stage };
    try {
      const { prep, ctx } = await prepare(p.userId, `${p.userId}-probe-${q.id}-${stage}-${args.mode}`, q.q);
      ownerOf.set(p.id, prep.memoryOwner);
      txn.rollbackTurnMemory(ctx.memoryTxn, { reason: 'pwi-probe' });
      rec.readMode = prep.readState?.mode ?? null;
      rec.taskType = prep.taskType;
      rec.promptTokens = prep.promptTokens;
      rec.systemPrompt = prep.systemPrompt ?? '';
      rec.ok = true;
    } catch (err) {
      rec.ok = false; rec.error = String(err?.message ?? err);
      infra.push({ where: `probe:${q.id}:${stage}`, error: rec.error });
    }
    result.probes.push(rec);
  }
}
try { await jobs.drainJobs(15_000); } catch { /* recorded below if it matters */ }

// ── 3. Stores ────────────────────────────────────────────────────────────────
for (const p of dataset.personas) result.stores[p.id] = snapshot(p);
result.finishedAt = new RealDate().toISOString();

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(result));
fs.writeFileSync(`${args.out}.log`, logLines.join('\n'));

// ── 4. Exit through the production shutdown path (flush every store, drain jobs) ──
if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM', 'SIGTERM');
else process.exit(0);
