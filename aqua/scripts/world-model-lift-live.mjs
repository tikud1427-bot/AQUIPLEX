#!/usr/bin/env node
/**
 * World-Model Lift — LIVE (Blueprint V2 Part 14 §14.2, Part 15 Q3).
 *
 *   AQUA_TEST_DATABASE_URL=postgresql://…/aqua_test node scripts/world-model-lift-live.mjs
 *     [--personas p1-meera,p2-daniel] [--repeat 1] [--json eval/out/x.json] [--keep]
 *
 * "Does additional understanding of this user produce better assistance than
 * the system could provide without that understanding?"
 *
 * Condition C is the PRODUCTION path end to end, nothing scripted:
 *   each history turn is enqueued exactly as turnPostProcess enqueues it
 *   (`understanding.turn.v1`) → drained by the worker's own handler table
 *   (workerRuntime.js: real E6 extraction on Groq, canonical commit, outbox,
 *   embeddings, reflection, contradiction) → questions are answered from
 *   Brain.assembleContextAsync with the production classifier's taskType and
 *   the canonical dense scores, under the production .env gates.
 * Condition C uses an EMPTY legacy floor: it measures the canonical World
 * Model, not the legacy PIC store it is meant to replace.
 *
 * Same answering model (default: production primary, Groq openai/gpt-oss-120b,
 * temp 0; --answer-provider groq|gemini|openrouter|nvidia [--answer-model id],
 * or AQUA_LIFT_PROVIDER / AQUA_LIFT_MODEL) and the same prompt template for
 * every condition; only the context differs.
 * The judge is a different model family (Gemini) and never sees the condition.
 *
 * SAFETY. Writes go ONLY to AQUA_TEST_DATABASE_URL (the same rule the test
 * runner enforces); without it the script refuses. Owners are run-unique and
 * purged at the end unless --keep. AQUA_DATA_DIR is private to the run.
 */
import '../eval/core/isolateDataDir.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── database: test URL only, BEFORE dotenv can fill DATABASE_URL from .env ──
const testUrl = String(process.env.AQUA_TEST_DATABASE_URL ?? '').trim();
if (!testUrl) {
  console.error('\n✗ AQUA_TEST_DATABASE_URL is not set. This experiment writes claims and jobs;');
  console.error('  it will not touch DATABASE_URL from .env. Point it at a migrated test database.\n');
  process.exit(2);
}
process.env.DATABASE_URL = testUrl;
{
  const envPath = path.join(ROOT, '..', '.env');
  if (existsSync(envPath)) createRequire(path.join(ROOT, 'package.json'))('dotenv').config({ path: envPath, quiet: true });
}
// The production gate configuration (root .env, 2026-10-04) for the paths C exercises.
Object.assign(process.env, {
  AQUA_E6: 'on', AQUA_CONTEXT_V2: 'on', AQUA_RETRIEVAL_V3: 'on', AQUA_SELF_ENTITY: 'on', AQUA_CROSS_ENCODER: 'off',
});

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const REPEAT = Math.max(1, Number(flag('--repeat', 1)));
const ONLY = flag('--personas', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const KEEP = argv.includes('--keep');
// One answerer for EVERY condition — the paired control. --answer-provider /
// --answer-model win; AQUA_LIFT_PROVIDER / AQUA_LIFT_MODEL are the env spelling
// (same names the paired-answer adapter reads).
const ANSWER_PROVIDERS = ['groq', 'gemini', 'openrouter', 'nvidia', 'gemini-direct'];
const ANSWER_PROVIDER = String(flag('--answer-provider', process.env.AQUA_LIFT_PROVIDER || 'groq')).toLowerCase();
if (!ANSWER_PROVIDERS.includes(ANSWER_PROVIDER)) {
  console.error(`
✗ Unknown answer provider "${ANSWER_PROVIDER}" — expected one of ${ANSWER_PROVIDERS.join(', ')}.
`);
  process.exit(2);
}
const DEFAULT_ANSWER_MODEL = {
  gemini: 'gemini-2.5-flash', 'gemini-direct': 'gemini-2.5-flash',
  nvidia: process.env.NVIDIA_DEFAULT_MODEL || 'openai/gpt-oss-20b',
};
const ANSWER_MODEL = flag('--answer-model', process.env.AQUA_LIFT_MODEL || (DEFAULT_ANSWER_MODEL[ANSWER_PROVIDER] ?? 'openai/gpt-oss-120b'));
// E6 transport for condition C: production default is groq/openai/gpt-oss-120b.
// AQUA_E6_PROVIDER / AQUA_E6_MODEL are the registered settings; recorded in the output.
if (flag('--e6-provider')) process.env.AQUA_E6_PROVIDER = flag('--e6-provider');
if (flag('--e6-model')) process.env.AQUA_E6_MODEL = flag('--e6-model');
const JUDGE_PROVIDER = flag('--judge-provider', 'nvidia');
const JUDGE_MODEL = flag('--judge-model', JUDGE_PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'nvidia/nemotron-3-ultra-550b-a55b');
const MEMORY_K = Number(flag('--memory-k', 8));
// Bounded parallelism over (question, repeat) units; every unit is paired —
// all conditions of one unit are answered and judged together.
const CONCURRENCY = Math.max(1, Math.min(16, Number(flag('--concurrency', 4))));
// --ablate-rendering adds condition worldModelSentences (same claims, pre-2026-10-06 rendering).
const ABLATE = argv.includes('--ablate-rendering');
const INGEST_CONCURRENCY = Math.max(1, Math.min(8, Number(flag('--ingest-concurrency', 1))));
// One or more dataset files (personas merged; ids must be unique).
const DATASETS = (flag('--datasets', 'eval/lift/world-model-lift-live.v1.json')).split(',').map(s => s.trim()).filter(Boolean);

const L = await import('../eval/lift/liftCore.mjs');
// --conditions (Pass 2, 2026-10-11): pick the compared conditions. Beyond the
// original four: `history` = the PRODUCTION conversation window over the
// persona's history (full history when it fits in --history-tokens, else the
// newest turns that do — tokenManager.buildContextWindow), and
// `memoryMatched` = BM25 at the World Model's context size for that question.
const CONDS = flag('--conditions')
  ? flag('--conditions').split(',').map(s => s.trim()).filter(Boolean)
  : [...L.CONDITIONS, ...(ABLATE ? ['worldModelSentences'] : [])];
const HISTORY_TOKENS = Number(flag('--history-tokens', 12_000));
// --prereg <file>: the pre-registration this run answers to; its hash is
// recorded in the output, and the run refuses to start if the file is absent.
const PREREG = flag('--prereg', null);
if (PREREG && !existsSync(path.resolve(ROOT, PREREG))) { console.error(`✗ --prereg ${PREREG} not found`); process.exit(2); }
const sha256File = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const R = await import('../eval/lift/liftRuntime.mjs');
const { getPool, closePool, isConfigured } = await import('../src/core/db/pool.js');
const Brain = await import('../src/brain/index.js');
const { generateGroq } = await import('../src/providers/groq.js');
const { generateGemini } = await import('../src/providers/gemini.js');
const { generateOpenRouter } = await import('../src/providers/openrouter.js');
const { generateNvidia } = await import('../src/providers/nvidia.js');
const ANSWER_FNS = { groq: generateGroq, gemini: generateGemini, openrouter: generateOpenRouter, nvidia: generateNvidia };
const { purgeOwnerData } = await import('../src/account/accountPurge.js');

if (!isConfigured()) { console.error('✗ database not configured'); process.exit(2); }

const DS = (() => {
  const files = DATASETS.map(f => JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')));
  // Multi-session personas (held-out v3) get the flat history the baselines and
  // the judge read; condition C ingests their sessions and documents separately.
  const personas = files.flatMap(d => d.personas).map(p => (Array.isArray(p.sessions) ? { ...p, history: R.flatHistory(p) } : p));
  const ids = personas.map(p => p.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate persona ids across datasets');
  return { id: files.map(d => d.id).join('+'), version: files.map(d => d.version).join('+'), personas };
})();
// RESUMABLE (2026-10-04): long runs were lost to session/process restarts.
// --resume <partial.json> continues the SAME run: same owner ids (so the
// already-built World Models in the test DB are reused, not re-extracted),
// completed answers kept, only the missing questions asked.
const RESUME = flag('--resume', null);
const PRIOR = RESUME ? JSON.parse(readFileSync(path.resolve(ROOT, RESUME), 'utf8')) : null;
const RUN = PRIOR?.run ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Provider quotas, not code, are the binding constraint on a free tier: a
// cooldown ("All … keys on cooldown", 429, 503) is a WAIT, not a failure.
// Up to ~12 minutes of waiting per call before giving up.
async function withRetry(fn, label, tries = 9) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      const msg = String(err?.message ?? err);
      const quota = /cooldown|429|rate limit|503|high demand|unavailable/i.test(msg);
      await sleep(quota ? Math.min(150_000, 20_000 * (i + 1)) : 1500 * (i + 1));
    }
  }
  throw new Error(`${label}: ${last?.message ?? last}`);
}

const answer = (system, user) => withRetry(async () => {
  // 'gemini-direct': a model outside the product registry (quota fallback).
  // Same answerer for every condition, so the paired comparison is unaffected;
  // the model is recorded per row.
  if (ANSWER_PROVIDER === 'gemini-direct') return directGemini(ANSWER_MODEL, system, user);
  const gen = ANSWER_FNS[ANSWER_PROVIDER];
  // gemini / nvidia spend output tokens on hidden reasoning first (nvidia
  // gpt-oss-20b exhausted 1024 on E6 prompts, measured 2026-10), so they get
  // the larger budget; Groq keeps its measured 900.
  const budget = ANSWER_PROVIDER === 'gemini' || ANSWER_PROVIDER === 'nvidia' ? 4000 : 900;
  const t0 = Date.now();
  const r = await gen(system, [{ role: 'user', content: user }], undefined, budget, { model: ANSWER_MODEL, temperature: 0 });
  return { text: r.text, model: r.model ?? ANSWER_MODEL, ms: Date.now() - t0, usage: r.usage ?? null };
}, 'answer');

// The JUDGE is measurement instrumentation, not a product path (liftJudge.mjs):
// it must be free to differ from the answerer. Default since 2026-10-06:
// NVIDIA Nemotron-3 Ultra — Gemini's ~150 judgements/day stopped every earlier
// run; calibrated against those Gemini judgements first
// (scripts/lift-judge-calibration.mjs: 98.0% agreement on `correct`, κ 0.96, n 51).
const { makeJudge } = await import('../eval/lift/liftJudge.mjs');
const directGemini = (model, system, user) => makeJudge({ provider: 'gemini', model, maxTokens: 4000 })(system, user);
const judgeCall = makeJudge({ provider: JUDGE_PROVIDER, model: JUDGE_MODEL });

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

const ingest = (ownerId, persona) => R.ingestPersona(ownerId, persona, { runId: RUN });
const worldModelContext = (ownerId, q) => R.worldModelContext(ownerId, q);

async function main() {
  const personas = DS.personas.filter(p => !ONLY || ONLY.includes(p.id));
  const results = PRIOR?.results ?? [];
  const pipeline = PRIOR?.pipeline ?? {};
  const done = new Set(results.map(r => `${r.id}#${r.rep}`));
  console.log(`[LIFT] run=${RUN} personas=${personas.length} repeat=${REPEAT} answer=${ANSWER_PROVIDER}/${ANSWER_MODEL} judge=${JUDGE_MODEL}`);

  // Ingest personas concurrently: the job claim is SKIP LOCKED with one running
  // job per owner, so drainers parallelise ACROSS owners while each persona's
  // turns still run in order.
  let nextPersona = 0;
  await Promise.all(Array.from({ length: INGEST_CONCURRENCY }, async () => {
  while (nextPersona < personas.length) {
    const persona = personas[nextPersona++];
    const userId = `lift-${RUN}-${persona.id}`;
    const ownerId = `user:${userId}`;
    const t0 = Date.now();
    if (pipeline[persona.id] && !pipeline[persona.id].degraded) {
      console.log(`[LIFT] ${persona.id}: resumed — World Model from the earlier ingest of this run`);
    } else {
    const ing = await ingest(ownerId, persona);
    pipeline[persona.id] = {
      ownerId, userId, ms: Date.now() - t0,
      claims: ing.claims.length,
      claimStates: ing.claims.reduce((m, c) => (m[c.state] = (m[c.state] ?? 0) + 1, m), {}),
      negated: ing.claims.filter(c => c.polarity === 'negated').length,
      jobs: ing.jobs,
      ...(ing.uploads ? { uploads: ing.uploads.map(u => ({ name: u.name, status: u.status, error: u.error ?? null })) } : {}),
      claimTexts: ing.claims.map(c => `${c.state}|${c.polarity}|${c.predicate}|${c.statement_text}`),
      // A persona whose turns could not all be understood (provider quota) is
      // flagged; its condition-C scores describe the infrastructure, not the model.
      degraded: ing.jobs.some(j => j.kind === 'understanding.turn.v1' && j.state === 'dead'),
    };
    console.log(`[LIFT] ${persona.id}: ${ing.claims.length} claims, jobs ${JSON.stringify(ing.jobs)}`);
    }
  }
  }));

  // ── answer + judge: a bounded pool over (question, repeat) units ──
  const units = [];
  for (const persona of personas) {
    const ownerId = pipeline[persona.id].ownerId;
    for (const question of persona.questions) {
      for (let rep = 0; rep < REPEAT; rep++) {
        if (!done.has(`${question.id}#${rep}`)) units.push({ persona, ownerId, question, rep });
      }
    }
  }
  const wmCache = new Map();   // one World-Model context per question, shared by its repeats
  const checkpoint = () => {
    try {
      mkdirSync(path.join(ROOT, 'eval', 'out'), { recursive: true });
      writeFileSync(path.join(ROOT, 'eval', 'out', `world-model-lift-live.${RUN}.partial.json`),
        JSON.stringify({ run: RUN, pipeline, results }, null, 2));
    } catch { /* checkpoint is best-effort */ }
  };
  let nextUnit = 0;
  async function runUnit({ persona, ownerId, question, rep }) {
    if (!wmCache.has(question.id)) wmCache.set(question.id, worldModelContext(ownerId, question.q));
    const wm = await wmCache.get(question.id);
    const contexts = {
      stateless: '',
      memory: L.formatTurns(L.bm25Retrieve(persona.history, question.q, MEMORY_K)),
      fullHistory: L.formatTurns(persona.history.map((text, i) => ({ turn: i + 1, text }))),
      worldModel: wm.block,
      worldModelSentences: wm.sentenceBlock,
    };
    const win = L.historyWindow(persona.history, HISTORY_TOKENS);
    contexts.history = L.formatTurns(win.turns);
    contexts.memoryMatched = L.formatTurns(L.bm25WithinChars(persona.history, question.q, Math.max(300, wm.block.length)));
    contexts.hybrid = L.hybridContext(wm.block, contexts.memoryMatched);
    const row = { persona: persona.id, length: persona.length ?? 'short', historyTokens: win.totalTokens, historyTruncated: win.truncated,
      id: question.id, cat: question.cat, q: question.q, rep,
      expectUnknown: Boolean(question.expectUnknown), hasForbidden: (question.forbidden ?? []).length > 0,
      worldModelDiag: wm, conditions: {} };
    for (const cond of CONDS) {
      const p = L.buildAnswerPrompt(question.q, contexts[cond]);
      const a = await answer(p.system, p.user);
      const j = await judge(persona, question, a.text);
      row.conditions[cond] = {
        context: contexts[cond], contextTokens: L.estimateTokens(contexts[cond]), answerMs: a.ms ?? null, usage: a.usage ?? null,
        ...(cond === 'worldModel' ? { contextMs: wm.ms ?? null } : {}),
        answer: a.text, answerModel: a.model, judgement: j,
        grade: j.error ? null : L.gradeAnswer(question, j),
      };
    }
    results.push(row);
    checkpoint();   // a crash or quota exhaustion never loses completed answers
    // Progress line over the conditions actually run (--conditions may omit any of them).
    const g = c => (row.conditions[c]?.grade?.correct ? '✓' : row.conditions[c]?.grade ? '✗' : '?');
    console.log(`  ${question.id}#${rep} [${question.cat}] ${CONDS.map(c => `${c}${g(c)}`).join(' ')}  ${question.q}`);
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (nextUnit < units.length) {
      const u = units[nextUnit++];
      try { await runUnit(u); } catch (err) { console.warn(`[LIFT] ${u.question.id}#${u.rep} failed: ${err?.message ?? err}`); }
    }
  }));
  results.sort((a, b) => `${a.persona}|${a.id}|${a.rep}`.localeCompare(`${b.persona}|${b.id}|${b.rep}`));

  // ── aggregate ──
  const graded = results.filter(r => CONDS.every(c => r.conditions[c].grade));
  const judgeErrors = results.length - graded.length;
  const metrics = {};
  for (const c of CONDS) {
    metrics[c] = L.conditionMetrics(graded.map(r => ({ cat: r.cat, expectUnknown: r.expectUnknown,
      hasForbidden: r.hasForbidden, grade: r.conditions[c].grade })));
  }
  const vec = c => graded.map(r => r.conditions[c].grade.correct);
  // Conditions under test: the World Model, and (when run) the pre-registered
  // hybrid. Each is compared with every other condition.
  const SUBJECTS = ['worldModel', 'hybrid'].filter(s => CONDS.includes(s));
  const othersOf = s => CONDS.filter(c => c !== s);
  const paired = Object.fromEntries(SUBJECTS.flatMap(s => othersOf(s).map(c => [`${s}_vs_${c}`, L.pairedComparison(vec(s), vec(c))])));
  // PRIMARY STATISTIC (question-clustered): repeats of one question are not
  // independent, so the unit of inference is the QUESTION — per-question mean
  // correctness, paired across conditions, sign test over questions that
  // differ, and a seeded bootstrap CI over questions. Pass 2: per history
  // length group (short / long) as well as overall, and for fabrication and
  // stale answers, not only correctness.
  const groups = { all: graded, short: graded.filter(r => (r.length ?? 'short') === 'short'), long: graded.filter(r => r.length === 'long') };
  const clustered = {};
  for (const [g, rows] of Object.entries(groups)) {
    if (!rows.length) continue;
    for (const s of SUBJECTS) {
      for (const c of othersOf(s)) {
        clustered[`${g}:${s}_vs_${c}`] = L.clusteredComparison(rows, s, c);
        clustered[`${g}:fabrication_${s}_vs_${c}`] = L.clusteredComparison(rows, s, c, x => x.fabricated);
        const stale = rows.filter(r => r.hasForbidden);
        if (stale.length) clustered[`${g}:stale_${s}_vs_${c}`] = L.clusteredComparison(stale, s, c, x => x.stale);
      }
    }
  }
  const metricsByLength = {};
  for (const [g, rows] of Object.entries(groups)) {
    if (!rows.length || g === 'all') continue;
    metricsByLength[g] = Object.fromEntries(CONDS.map(c => [c, L.conditionMetrics(rows.map(r => ({ cat: r.cat, expectUnknown: r.expectUnknown,
      hasForbidden: r.hasForbidden, grade: r.conditions[c].grade })))]));
  }
  const cost = Object.fromEntries(CONDS.map(c => {
    const xs = graded.map(r => r.conditions[c]);
    const mean = f => Number((xs.reduce((n, x) => n + (Number(f(x)) || 0), 0) / (xs.length || 1)).toFixed(1));
    return [c, { contextTokens: mean(x => x.contextTokens), answerMs: mean(x => x.answerMs),
      promptTokens: mean(x => x.usage?.inputTokens ?? x.usage?.prompt_tokens), outputTokens: mean(x => x.usage?.outputTokens ?? x.usage?.completion_tokens),
      ...(c === 'worldModel' ? { contextAssemblyMs: mean(x => x.contextMs) } : {}) }];
  }));
  const wmDiag = {
    contextsWithUndefinedLine: results.filter(r => r.worldModelDiag.undefinedLine).length,
    emptyContexts: results.filter(r => !r.worldModelDiag.block.trim()).length,
    meanItems: Number((results.reduce((n, r) => n + r.worldModelDiag.items, 0) / (results.length || 1)).toFixed(2)),
    provenanceCoverage: (() => {
      const items = results.reduce((n, r) => n + r.worldModelDiag.items, 0);
      return items ? Number((results.reduce((n, r) => n + r.worldModelDiag.withProvenance, 0) / items).toFixed(4)) : null;
    })(),
  };

  const out = {
    experiment: 'world-model-lift-live', dataset: `${DS.id}.v${DS.version}`, run: RUN, ranAt: new Date().toISOString(),
    answerProvider: ANSWER_PROVIDER, answerModel: ANSWER_MODEL, judgeProvider: JUDGE_PROVIDER, judgeModel: JUDGE_MODEL, datasets: DATASETS,
    e6Transport: await Brain.e6TransportConfig(), memoryK: MEMORY_K, repeat: REPEAT,
    gates: Object.fromEntries(['AQUA_E6', 'AQUA_CONTEXT_V2', 'AQUA_RETRIEVAL_V3', 'AQUA_SELF_ENTITY', 'AQUA_CROSS_ENCODER',
      'AQUA_E6_SINGLE_VALUED'].map(k => [k, process.env[k] ?? null])),
    questions: results.length, graded: graded.length, judgeErrors,
    historyTokensBudget: HISTORY_TOKENS, conditions: CONDS,
    // Provenance: exactly which frozen data and which pre-registered plan this run answers to.
    datasetSha256: Object.fromEntries(DATASETS.map(f => [f, sha256File(path.resolve(ROOT, f))])),
    preregistration: PREREG ? { file: PREREG, sha256: sha256File(path.resolve(ROOT, PREREG)) } : null,
    metrics, metricsByLength, paired, clustered, cost, worldModelDiagnostics: wmDiag, pipeline, results,
  };
  const file = flag('--json', path.join('eval', 'out', `world-model-lift-live.${RUN}.json`));
  mkdirSync(path.dirname(path.resolve(ROOT, file)), { recursive: true });
  writeFileSync(path.resolve(ROOT, file), `${JSON.stringify(out, null, 2)}\n`);

  // ── report ──
  const keys = ['correctness', 'answerable_correctness', 'required_fact_recall', 'personalization', 'temporal_accuracy',
    'unknown_honesty', 'fabrication_rate', 'asked_for_known_info_rate'];
  const fmt = v => (v === null || v === undefined ? '  n/a ' : `${(v * 100).toFixed(1).padStart(5)}%`);
  console.log(`\nWORLD-MODEL LIFT (live) · ${graded.length} graded answers per condition · judge errors ${judgeErrors}`);
  console.log(`${'metric'.padEnd(28)} ${CONDS.map(c => c.padStart(12)).join(' ')}`);
  for (const k of keys) console.log(`${k.padEnd(28)} ${CONDS.map(c => fmt(metrics[c][k]).padStart(12)).join(' ')}`);
  const cats = [...new Set(graded.map(r => r.cat))].sort();
  for (const cat of cats) console.log(`  cat:${cat.padEnd(23)} ${CONDS.map(c => fmt(metrics[c].by_category[cat]).padStart(12)).join(' ')}`);
  console.log('\nPAIRED (strict correctness): wins/losses/ties, two-sided sign test');
  for (const [k, v] of Object.entries(paired)) console.log(`  ${k.padEnd(28)} ${v.wins}/${v.losses}/${v.ties}  p=${v.sign_test_p}`);
  console.log('\nQUESTION-CLUSTERED (primary): questions, mean diff [95% bootstrap CI], question wins/losses/ties, sign test');
  for (const [g, m] of Object.entries(metricsByLength)) {
    console.log(`  ${`[${g}] correctness`.padEnd(28)} ${CONDS.map(c => fmt(m[c].correctness).padStart(12)).join(' ')}`);
    console.log(`  ${`[${g}] fabrication`.padEnd(28)} ${CONDS.map(c => fmt(m[c].fabrication_rate).padStart(12)).join(' ')}`);
    console.log(`  ${`[${g}] stale`.padEnd(28)} ${CONDS.map(c => fmt(m[c].stale_rate).padStart(12)).join(' ')}`);
  }
  console.log(`cost: ${JSON.stringify(cost)}`);
  for (const [k, v] of Object.entries(clustered)) {
    console.log(`  ${k.padEnd(36)} n=${v.questions} Δ=${v.meanDiff} [${v.ci95.join(', ')}] ${v.wins}/${v.losses}/${v.ties} p=${v.sign_test_p}`);
  }
  console.log(`\nworld-model context: ${JSON.stringify(wmDiag)}`);
  console.log(`→ ${file}`);

  // Account deletion through the production purge, then a residue scan over
  // every owner-scoped table (G4): the experiment doubles as a live purge test.
  if (!KEEP) {
    const pool = await getPool();
    const tables = (await pool.query(
      `SELECT table_name FROM information_schema.columns WHERE column_name='owner_id' AND table_schema='public'
         AND table_name LIKE 'aqua_%' ORDER BY table_name`)).rows.map(r => r.table_name);
    const residue = {};
    for (const p of Object.values(pipeline)) {
      const rep = await purgeOwnerData({ userId: p.userId });
      if (rep.errors?.length) residue[`${p.ownerId}:errors`] = rep.errors;
      for (const t of tables) {
        // Quoted: migration 0013 names hash partitions "aqua_embeddings_p 0".."p 9" (with a space).
        const n = (await pool.query(`SELECT count(*)::int AS n FROM "${t.replace(/"/g, '""')}" WHERE owner_id=$1`, [p.ownerId])).rows[0].n;
        if (n) residue[`${p.ownerId}:${t}`] = n;
      }
    }
    out.purge = { tablesScanned: tables.length, residue };
    writeFileSync(path.resolve(ROOT, file), `${JSON.stringify(out, null, 2)}
`);
    console.log(`purge: scanned ${tables.length} owner-scoped tables · residue ${JSON.stringify(residue)}`);
  }
  await closePool();
}

main().catch(async err => { console.error(err); try { await closePool(); } catch {} process.exit(1); });
