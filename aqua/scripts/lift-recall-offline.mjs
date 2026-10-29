#!/usr/bin/env node
/**
 * Episodic recall, measured at answer level on the stored held-out Lift v3 run
 * (2026-10-20).
 *
 * The stored run (eval/out/lift-heldout-v3.after.json) already holds, for every
 * (question, repeat): the World Model block production assembled, and graded
 * answers for stateless / memory (BM25) / fullHistory / worldModel. This script
 * adds two conditions WITHOUT re-extracting anything:
 *
 *   recall    the production episodic-recall block alone (memory/episodicRecall.js,
 *             the exact function chat.js calls), over the persona's sessions as
 *             separate, dated conversations
 *   wmRecall  the stored World Model block + that recall block, joined exactly as
 *             chat.js joins knowledgeContext and recallContext — what production
 *             now serves (minus the World Model's "since changed" notes, which
 *             need the run's database; so this is a conservative reading)
 *
 * Same answer template (liftCore.buildAnswerPrompt), same answerer
 * (nvidia openai/gpt-oss-20b, temperature 0, 4000 tokens), same judge
 * (nvidia nemotron-3-ultra) and rubric as the stored conditions. The World
 * Model block is held fixed, so wmRecall − worldModel is the recall lane's own
 * effect. Caveat recorded in the output: v3 is a DEVELOPMENT set by now (its
 * failures were read on 2026-10-11) and its histories are short.
 *
 *   node scripts/lift-recall-offline.mjs [--limit N] [--resume eval/out/lift-recall-v3.partial.json]
 */
import '../eval/core/isolateDataDir.mjs';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.DATABASE_URL;
{
  const envPath = path.join(ROOT, '..', '.env');
  if (existsSync(envPath)) createRequire(path.join(ROOT, 'package.json'))('dotenv').config({ path: envPath, quiet: true });
}
delete process.env.DATABASE_URL;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const LIMIT = Number(flag('--limit', Infinity));
const CONCURRENCY = Number(flag('--concurrency', 4));
const RESUME = flag('--resume', null);
const STORED = flag('--stored', 'eval/out/lift-heldout-v3.after.json');
const DATASET = flag('--dataset', 'eval/lift/world-model-lift-heldout.v3.json');
const OUT = flag('--out', 'eval/out/lift-recall-v3.json');
const PARTIAL = OUT.replace(/\.json$/, '.partial.json');

const L = await import('../eval/lift/liftCore.mjs');
const { recallForTurn } = await import('../src/memory/episodicRecall.js');
const { deriveTitle } = await import('../src/memory/conversationStore.js');
const { generateNvidia } = await import('../src/providers/nvidia.js');
const { makeJudge } = await import('../eval/lift/liftJudge.mjs');

const ANSWER_MODEL = 'openai/gpt-oss-20b';
const JUDGE_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
// recall/wmRecall: RANKED excerpts only (allUnderChars 0). adaptive/wmAdaptive: the
// production default — the whole history while it fits AQUA_RECALL_ALL_CHARS.
// wmAdaptiveFiles (2026-10-20, later): + the persona's uploaded document as a file
// in the conversation it followed — production default since files joined recall.
const DEFS = {
  recall:          { wm: false, opts: { allUnderChars: 0, includeFiles: false } },
  wmRecall:        { wm: true,  opts: { allUnderChars: 0, includeFiles: false } },
  adaptive:        { wm: false, opts: { includeFiles: false } },
  wmAdaptive:      { wm: true,  opts: { includeFiles: false } },
  wmAdaptiveFiles: { wm: true,  opts: { includeFiles: true } },
};
const NEW = String(flag('--conditions', 'recall,wmRecall')).split(',').map(s => s.trim()).filter(Boolean);
for (const c of NEW) if (!DEFS[c]) throw new Error(`unknown condition ${c}`);
const STORED_CONDS = ['stateless', 'memory', 'fullHistory', 'worldModel'];

const stored = JSON.parse(readFileSync(path.resolve(ROOT, STORED), 'utf8'));
const ds = JSON.parse(readFileSync(path.resolve(ROOT, DATASET), 'utf8'));
const personas = new Map(ds.personas.map(p => [p.id, { ...p, history: flat(p) }]));
/** = eval/lift/liftRuntime.mjs flatHistory (the judge's ground truth), without importing the job runtime. */
function flat(p) {
  const out = [];
  p.sessions.forEach((turns, s) => {
    out.push(...turns);
    for (const doc of (p.documents ?? []).filter(d => d.afterSession === s + 1)) {
      for (const line of String(doc.text).split('\n').map(l => l.trim()).filter(Boolean)) out.push(`[file ${doc.name}] ${line}`);
    }
  });
  return out;
}

// Each session is its own conversation, a week apart, a minute per turn.
const T0 = Date.UTC(2026, 8, 1);
function conversationsFor(p) {
  const m = new Map();
  p.sessions.forEach((turns, s) => {
    m.set(`${p.id}-s${s + 1}`, {
      meta: { userId: p.id, title: deriveTitle(turns[0]), createdAt: T0 + s * 7 * 86_400_000 },
      messages: turns.map((content, i) => ({ role: 'user', content, ts: T0 + s * 7 * 86_400_000 + i * 60_000 })),
    });
  });
  return m;
}
const convCache = new Map();
/** The persona's documents, attached to the conversation (session) they followed, uploaded just after it. */
function attachmentsFor(p) {
  const by = new Map();
  for (const d of p.documents ?? []) {
    const id = `${p.id}-s${d.afterSession}`;
    const ts = T0 + (d.afterSession - 1) * 7 * 86_400_000 + 23 * 3_600_000;
    by.set(id, [...(by.get(id) ?? []), { id: d.name, name: d.name, content: d.text, uploadedAt: ts }]);
  }
  return id => by.get(id) ?? [];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, tries = 9) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      const quota = /cooldown|429|rate limit|503|high demand|unavailable|timeout/i.test(String(err?.message ?? err));
      await sleep(quota ? Math.min(150_000, 20_000 * (i + 1)) : 1500 * (i + 1));
    }
  }
  throw new Error(`${label}: ${last?.message ?? last}`);
}
const answer = (system, user) => withRetry(async () => {
  const t0 = Date.now();
  const r = await generateNvidia(system, [{ role: 'user', content: user }], undefined, 4000, { model: ANSWER_MODEL, temperature: 0 });
  return { text: r.text, model: r.model ?? ANSWER_MODEL, ms: Date.now() - t0, usage: r.usage ?? null };
}, 'answer');
const judgeCall = makeJudge({ provider: 'nvidia', model: JUDGE_MODEL });
async function judge(persona, question, text) {
  const p = L.buildJudgePrompt({ history: persona.history, question }, text);
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await withRetry(() => judgeCall(p.system, p.user), 'judge');
      return { ...L.parseJudgement(r.text, question), model: r.model };
    } catch (err) { lastErr = err; }
  }
  return { error: String(lastErr?.message ?? lastErr) };
}

const prior = RESUME ? JSON.parse(readFileSync(path.resolve(ROOT, RESUME), 'utf8')) : null;
const done = new Map((prior?.rows ?? []).map(r => [`${r.id}#${r.rep}`, r]));
const base = stored.results.filter(r => STORED_CONDS.every(c => r.conditions?.[c]?.grade)).slice(0, LIMIT);
const rows = [];
const checkpoint = () => {
  mkdirSync(path.dirname(path.resolve(ROOT, PARTIAL)), { recursive: true });
  writeFileSync(path.resolve(ROOT, PARTIAL), JSON.stringify({ rows: [...done.values()] }, null, 2));
};

async function runRow(r) {
  const key = `${r.id}#${r.rep}`;
  if (done.has(key)) return done.get(key);
  const persona = personas.get(r.persona);
  const question = persona.questions.find(q => q.id === r.id);
  if (!convCache.has(persona.id)) convCache.set(persona.id, conversationsFor(persona));
  const wm = r.worldModelDiag?.block ?? '';
  const contexts = {};
  const recallStats = {};
  for (const c of NEW) {
    const rec = await recallForTurn({
      ownerId: `user:${persona.id}`, userId: persona.id, conversationId: `${persona.id}-ask`,
      query: question.q, conversations: convCache.get(persona.id), attachmentsFor: attachmentsFor(persona), ...DEFS[c].opts,
    });
    contexts[c] = DEFS[c].wm ? [wm, rec.block].filter(s => s && s.trim()).join('\n\n') : rec.block;
    recallStats[c] = rec.stats;
  }
  const out = { persona: r.persona, id: r.id, cat: r.cat, q: r.q, rep: r.rep, expectUnknown: r.expectUnknown, hasForbidden: r.hasForbidden,
    recallStats, conditions: {} };
  for (const c of NEW) {
    const p = L.buildAnswerPrompt(question.q, contexts[c]);
    const a = await answer(p.system, p.user);
    const j = await judge(persona, question, a.text);
    out.conditions[c] = { context: contexts[c], contextTokens: L.estimateTokens(contexts[c]), answer: a.text, answerMs: a.ms, judgement: j,
      grade: j.error ? null : L.gradeAnswer(question, j) };
  }
  done.set(key, out);
  checkpoint();
  const g = c => (out.conditions[c].grade?.correct ? '✓' : out.conditions[c].grade ? '✗' : '?');
  const s = c => (r.conditions[c].grade.correct ? '✓' : '✗');
  console.log(`  ${key} [${r.cat}] wm${s('worldModel')} full${s('fullHistory')} mem${s('memory')} | ${NEW.map(c => `${c}${g(c)}`).join(' ')}  ${r.q}`);
  return out;
}

console.log(`[RECALL-LIFT] rows=${base.length} resumed=${done.size} answer=nvidia/${ANSWER_MODEL} judge=${JUDGE_MODEL}`);
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < base.length) {
    const r = base[next++];
    try { rows.push({ stored: r, fresh: await runRow(r) }); }
    catch (err) { console.warn(`[RECALL-LIFT] ${r.id}#${r.rep} failed: ${err?.message ?? err}`); }
  }
}));

// ── aggregate over rows graded in EVERY condition ──
const merged = rows
  .filter(({ fresh }) => NEW.every(c => fresh.conditions[c].grade))
  .map(({ stored: s, fresh: f }) => ({ id: s.id, cat: s.cat, expectUnknown: s.expectUnknown, hasForbidden: s.hasForbidden,
    conditions: { ...Object.fromEntries(STORED_CONDS.map(c => [c, { grade: s.conditions[c].grade,
      contextTokens: s.conditions[c].contextTokens ?? L.estimateTokens(s.conditions[c].context ?? (c === 'worldModel' ? s.worldModelDiag?.block : '')) }])),
      ...Object.fromEntries(NEW.map(c => [c, { grade: f.conditions[c].grade, contextTokens: f.conditions[c].contextTokens }])) } }));
const CONDS = [...STORED_CONDS, ...NEW];
const metrics = Object.fromEntries(CONDS.map(c => [c, L.conditionMetrics(merged.map(r => ({ cat: r.cat, expectUnknown: r.expectUnknown, hasForbidden: r.hasForbidden, grade: r.conditions[c].grade })))]));
const pairs = [['wmRecall', 'worldModel'], ['wmRecall', 'memory'], ['wmRecall', 'fullHistory'], ['recall', 'memory'], ['wmRecall', 'recall'],
  ['wmAdaptive', 'worldModel'], ['wmAdaptive', 'fullHistory'], ['wmAdaptive', 'memory'], ['adaptive', 'fullHistory'],
  ['wmAdaptiveFiles', 'worldModel'], ['wmAdaptiveFiles', 'fullHistory'], ['wmAdaptiveFiles', 'memory']]
  .filter(([a, b]) => CONDS.includes(a) && CONDS.includes(b));
const clustered = {};
for (const [a, b] of pairs) {
  clustered[`${a}_vs_${b}`] = L.clusteredComparison(merged, a, b);
  clustered[`fabrication_${a}_vs_${b}`] = L.clusteredComparison(merged, a, b, g => g.fabricated);
  clustered[`stale_${a}_vs_${b}`] = L.clusteredComparison(merged.filter(r => r.hasForbidden), a, b, g => g.stale);
}
const tokens = Object.fromEntries(CONDS.map(c => [c, Number((merged.reduce((n, r) => n + (r.conditions[c].contextTokens ?? 0), 0) / (merged.length || 1)).toFixed(1))]));
const result = {
  experiment: 'episodic-recall-offline-lift', ranAt: new Date().toISOString(), stored: STORED, dataset: DATASET,
  answerModel: ANSWER_MODEL, judgeModel: JUDGE_MODEL, rows: rows.length, graded: merged.length,
  caveats: [
    'v3 is a development set by now (its failures were read 2026-10-11); not a held-out claim.',
    'Histories are short (~2.3k chars); full history fits the window, so fullHistory is the ceiling here.',
    'Stored conditions were answered 2026-10-11; recall/wmRecall today. Same model ids, temperature 0; provider-side drift is possible.',
    'World Model "since changed" notes are absent (they need the run database): wmRecall is a conservative reading of production.',
  ],
  metrics, clustered, meanContextTokens: tokens,
  perRow: rows.map(({ fresh }) => fresh),
};
writeFileSync(path.resolve(ROOT, OUT), JSON.stringify(result, null, 2));
const pct = v => (v == null ? '  —  ' : `${(v * 100).toFixed(1)}%`.padStart(6));
console.log(`\n[RECALL-LIFT] graded ${merged.length}/${rows.length} → ${OUT}`);
console.log('condition      correct  stale   fabric  unknown-honest  ctx-tokens');
for (const c of CONDS) {
  const m = metrics[c];
  console.log(`${c.padEnd(13)} ${pct(m.correctness)} ${pct(m.stale_rate)} ${pct(m.fabrication_rate)} ${pct(m.unknown_honesty)}        ${tokens[c]}`);
}
for (const [k, v] of Object.entries(clustered)) console.log(`${k.padEnd(34)} Δ=${v.meanDiff} CI[${v.ci95.join(', ')}] W/L/T ${v.wins}/${v.losses}/${v.ties} p=${v.sign_test_p}`);
