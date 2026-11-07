#!/usr/bin/env node
/**
 * C9 offline measurement — the Mind's question-aware selection over the C9 dataset
 * (eval/datasets/c9-semantic-relevance.dev.v1.json), 2026-11-07.
 *
 *   node scripts/c9-mind-relevance-measure.mjs [--timeline dataset|compressed] [--out <file.json>]
 *
 * --timeline dataset (default) replays each statement on its labelled day (the set spans 54
 * days; a goal unmentioned for 21 days goes stale — mind/reflectionEngine.js); compressed
 * replays the same statements, same order, one minute apart, which isolates selection from
 * staleness.
 *
 * Replays each fictional owner's statements, in day order, through the real write
 * path (memory/engine.js memoryObserve + Brain ingest) in an isolated data dir,
 * then reads the cognitive block for every labelled query in three modes:
 *
 *   default   AQUA_MIND_RELEVANCE unset — what production does
 *   lexical   flag on, no claim scores — what a deployment without embeddings gets
 *   oracle    flag on, ORACLE INJECTED SCORES: each query's labelled relevant
 *             statements at 0.80, every other statement 0.40–0.50. Perfect by
 *             construction — it measures the selection plumbing and its coverage,
 *             NEVER a model's quality. No vectors exist offline (C9 fixture
 *             UNAVAILABLE); no embedding, no network.
 *
 * Metrics (Mind cognitive block only):
 *   relevantKept        targeted/anchored queries whose labelled item appears
 *   irrelevantPerQuery  labelled-forbidden goal/blocker/deadline items shown, per query
 *   falsePositive       hard-negative + unrelated queries showing a forbidden item
 *   historicalAsCurrent historical items (changed career goal, stopped language goal) shown with no change note
 *   coverage            items the Mind holds; items with a LIVE evidence-store statement (what meaning can use)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-c9-measure-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI|^GOOGLE|^GROQ|^OPENAI)/.test(k)) delete process.env[k];
}
Object.assign(process.env, { AQUA_DISABLE_MONGO_MIRROR: '1', MONGO_URI: '', AQUA_BRAIN_INGEST: 'on', AQUA_BRAIN_INGEST_FACTS: 'on' });
delete process.env.DATABASE_URL;
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const timeline = process.argv.includes('--timeline') ? process.argv[process.argv.indexOf('--timeline') + 1] : 'dataset';
if (!['dataset', 'compressed'].includes(timeline)) throw new Error(`--timeline ${timeline}: dataset | compressed`);
const say = console.log;
console.log = () => {}; console.warn = () => {}; console.debug = () => {}; console.info = () => {};

const imp = p => import(pathToFileURL(path.join(AQUA, p)).href);
// ISOLATION GUARD: stores read their files the moment they are imported, from core/dataDir.js
// DATA_DIR (default ~/.aquiplex — a real store). Resolve it FIRST and refuse anything outside
// the system temp directory, before any store module is loaded.
const { DATA_DIR } = await imp('src/core/dataDir.js');
const tmpRoot = fs.realpathSync(os.tmpdir());
if (!fs.realpathSync(DATA_DIR).startsWith(tmpRoot) || /[\\/]\.aquiplex(?:[\\/]|$)/.test(DATA_DIR)) {
  say(`REFUSED: data dir ${DATA_DIR} is not an isolated temporary store`);
  process.exit(2);
}
const engine = await imp('src/memory/engine.js');
const Brain = await imp('src/brain/index.js');
const ES = await imp('src/files/evidenceStore.js');
const { peekMind } = await imp('src/mind/mindStore.js');
const D = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/datasets/c9-semantic-relevance.dev.v1.json'), 'utf8'));

const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
let clock = Date.UTC(2026, 6, 1), turn = 0;
const realNow = Date.now;
Date.now = () => clock;

const owners = [...new Set(D.statements.map(s => s.owner))];
const perOwner = {};
for (const o of owners) {
  const ss = D.statements.filter(s => s.owner === o).sort((a, b) => a.day - b.day || a.conversation - b.conversation);
  for (const s of ss) {
    clock = Date.UTC(2026, 6, 1) + (timeline === 'dataset' ? s.day * 86_400_000 : 0) + (turn++) * 60_000;
    engine.memoryObserve(o, { userMessage: s.text, conversationId: `${o}-c${s.conversation}`, userId: o, requestId: `w${turn}`, extractMessage: s.text });
    engine.memoryAfterTurn(o, {});
    await Brain.observeConversationTurn({ ownerId: o, conversationId: `${o}-c${s.conversation}`, turn, userMessage: s.text, assistantMessage: '' });
  }
  await new Promise(r => setTimeout(r, 30));
  const m = peekMind(o);
  const facts = ES.listFacts(o, { limit: 5000 });
  // Which Mind item states each labelled anchor? (goal title / blocker text / deadline label inside the anchor sentence)
  const items = [
    ...Object.values(m.goals).map(g => ({ kind: 'goal', text: g.title, status: g.status, changed: !!g.changedBy?.text })),
    ...m.working.blockers.map(b => ({ kind: 'blocker', text: b.text, status: 'active' })),
    ...m.working.deadlines.map(d => ({ kind: 'deadline', text: d.label, status: 'active' })),
  ];
  const itemOf = {};
  for (const s of ss.filter(x => x.role === 'anchor')) {
    const it = items.find(i => norm(i.text).length >= 4 && norm(s.text).includes(norm(i.text)));
    const stated = facts.find(f => norm(f.statement) === norm(s.text));
    itemOf[s.id] = { anchor: s, item: it ?? null, statement: stated ? { id: stated.id, live: !stated.archived && !stated.supersededBy && !stated.disputed, archivedReason: stated.archivedReason ?? null } : null };
  }
  perOwner[o] = { itemOf, facts };
}

function oracleScores(o, q) {
  const { facts } = perOwner[o];
  const relevantText = new Set(q.relevant.map(id => norm(D.statements.find(s => s.id === id).text)));
  return new Map(facts.map((f, i) => [f.id, relevantText.has(norm(f.statement)) ? 0.8 : 0.4 + ((i * 37) % 100) / 1000]));
}
const cognitiveOf = (o, q, claimScores) => (engine.memoryRetrieve(o, { query: q.text, requestId: `q${++turn}`, legacyUserMemory: true, claimScores }).block.match(/--- COGNITIVE MODEL[\s\S]*?--- END COGNITIVE MODEL ---/) ?? [''])[0];
const shown = (block, it) => !!it && norm(block).includes(norm(it.text));

const MODES = {
  default: { flag: false, scores: () => null },
  lexical: { flag: true, scores: () => null },
  oracle: { flag: true, scores: oracleScores },
};
const result = { dataset: D.id, timeline, note: 'oracle = injected, perfect-by-construction scores; measures plumbing and coverage, not any model', modes: {} };
for (const [mode, cfg] of Object.entries(MODES)) {
  if (cfg.flag) process.env.AQUA_MIND_RELEVANCE = 'on'; else delete process.env.AQUA_MIND_RELEVANCE;
  const acc = { relevant: [0, 0], irrelevantShown: 0, queries: 0, fp: [0, 0], hist: [0, 0], byCategory: {} };
  for (const q of D.queries) {
    const { itemOf } = perOwner[q.owner];
    const block = cognitiveOf(q.owner, q, cfg.scores(q.owner, q));
    const anchorsIn = ids => ids.map(id => itemOf[id]).filter(Boolean);
    const rel = anchorsIn(q.relevant).filter(x => x.item);
    const forb = anchorsIn(q.forbidden).filter(x => x.item);
    const forbShown = forb.filter(x => shown(block, x.item)).length;
    acc.queries++; acc.irrelevantShown += forbShown;
    const cat = (acc.byCategory[q.category] ??= { n: 0, relevantKept: 0, relevantN: 0, forbiddenShown: 0 });
    cat.n++; cat.forbiddenShown += forbShown;
    if (['paraphrase', 'planning_anchored'].includes(q.category) && rel.length) {
      const kept = rel.some(x => shown(block, x.item));
      acc.relevant[1]++; if (kept) acc.relevant[0]++;
      cat.relevantN++; if (kept) cat.relevantKept++;
    }
    if (['hard_negative', 'unrelated'].includes(q.category)) { acc.fp[1]++; if (forbShown) acc.fp[0]++; }
    for (const x of anchorsIn(q.relevant.concat(q.forbidden))) {
      if (x.anchor.status !== 'historical' || !x.item) continue;
      acc.hist[1]++;
      if (shown(block, x.item) && x.item.kind === 'goal' && x.item.status === 'active' && !x.item.changed && !/since changed/.test(block)) acc.hist[0]++;
    }
  }
  result.modes[mode] = {
    relevantKept: +(acc.relevant[0] / acc.relevant[1]).toFixed(3), relevantN: acc.relevant[1],
    irrelevantPerQuery: +(acc.irrelevantShown / acc.queries).toFixed(3),
    falsePositive: +(acc.fp[0] / acc.fp[1]).toFixed(3), falsePositiveN: acc.fp[1],
    historicalAsCurrent: acc.hist[0], historicalChecks: acc.hist[1],
    byCategory: Object.fromEntries(Object.entries(acc.byCategory).map(([k, v]) => [k, { n: v.n, relevantKept: v.relevantN ? +(v.relevantKept / v.relevantN).toFixed(3) : null, forbiddenPerQuery: +(v.forbiddenShown / v.n).toFixed(3) }])),
  };
}
const anchors = Object.values(perOwner).flatMap(p => Object.values(p.itemOf));
const byItem = k => anchors.filter(a => a.anchor.item === k);
result.coverage = Object.fromEntries(['run', 'lang', 'career', 'ci', 'deadline'].map(k => [k, {
  anchors: byItem(k).length,
  heldByMind: byItem(k).filter(a => a.item).length,
  statementStored: byItem(k).filter(a => a.statement).length,
  statementLive: byItem(k).filter(a => a.statement?.live).length,
  archivedReasons: [...new Set(byItem(k).filter(a => a.statement && !a.statement.live).map(a => a.statement.archivedReason))],
}]));
Date.now = realNow;
say(JSON.stringify(result, null, 1));
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
process.exit(0);
