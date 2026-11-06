#!/usr/bin/env node
/**
 * Lift, legacy production read only (2026-10-29) — answer-level, no database.
 *
 *   node scripts/lift-legacy-answers.mjs --datasets eval/lift/world-model-lift-heldout.v3.json
 *     [--personas h1-ravi,…] [--conditions legacyProd,recall] [--repeat 1]
 *     [--answer-provider groq] [--answer-model openai/gpt-oss-120b] [--judge-provider nvidia]
 *     [--json eval/out/legacy-answers.<label>.json]
 *   node scripts/lift-legacy-answers.mjs --compare before.json,after.json
 *
 * What a production turn carries today (eval/lift/liftLegacy.mjs + episodic
 * recall without "since changed" notes), answered and judged with the Lift
 * prompt, judge and grading (liftCore.mjs) — the `legacyProd` condition of
 * scripts/world-model-lift-live.mjs without the World Model ingest, so a
 * legacy-path change can be measured in minutes and without E6 quota.
 * `recall` is the recall block alone, a reference arm.
 *
 * --compare pairs two runs by (question, repeat) and reports the
 * question-clustered difference (second − first) per condition: correctness,
 * stale answers on questions with forbidden items, fabrication.
 *
 * DEVELOPMENT INSTRUMENT. Run it on development data only — never on a frozen
 * held-out or final set before its pre-registered run has completed.
 *
 * SAFETY: no database (DATABASE_URL blanked before .env is read), private
 * AQUA_DATA_DIR, Mongo mirror off.
 */
import '../eval/core/isolateDataDir.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const L = await import('../eval/lift/liftCore.mjs');

// --merge original.json,recovered.json --datasets <set> --json out.json: add a
// recovery run's answers for units the original run LOST (no row) — never in
// place of an answer it has. Refuses on any overlap, any duplicate, a different
// answerer, judge or condition set, or a unit of the dataset still missing.
// Recovered rows carry `recoveredFrom`; both inputs are left untouched.
const MERGE = flag('--merge', null);
if (MERGE) {
  const [origFile, recFile] = MERGE.split(',');
  const [orig, rec] = [origFile, recFile].map(f => JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')));
  const fail = msg => { console.error(`✗ merge: ${msg}`); process.exit(2); };
  for (const k of ['answerProvider', 'answerModel', 'judgeProvider', 'judgeModel', 'repeat']) {
    if (JSON.stringify(orig[k]) !== JSON.stringify(rec[k])) fail(`${k} differs (${orig[k]} vs ${rec[k]})`);
  }
  if (JSON.stringify(orig.conditions) !== JSON.stringify(rec.conditions)) fail('condition sets differ');
  const key = r => `${r.id}#${r.rep}`;
  const have = new Set(orig.results.map(key));
  if (have.size !== orig.results.length) fail('duplicate units in the original run');
  const overlap = rec.results.filter(r => have.has(key(r)));
  if (overlap.length) fail(`recovery answers units the original already has: ${overlap.map(key).join(', ')}`);
  const results = [...orig.results, ...rec.results.map(r => ({ ...r, recoveredFrom: recFile }))]
    .sort((a, b) => `${a.persona}|${a.id}|${a.rep}`.localeCompare(`${b.persona}|${b.id}|${b.rep}`));
  const ds = (flag('--datasets') ?? '').split(',').filter(Boolean).flatMap(f => JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')).personas);
  const expected = ds.flatMap(p => p.questions.flatMap(q => Array.from({ length: orig.repeat }, (_, rep) => `${q.id}#${rep}`)));
  const got = results.map(key);
  if (new Set(got).size !== got.length) fail('duplicate units after merge');
  const missing = expected.filter(k => !got.includes(k)), extra = got.filter(k => !expected.includes(k));
  if (missing.length || extra.length) fail(`missing ${missing.join(', ') || '—'}; unexpected ${extra.join(', ') || '—'}`);
  const graded = results.filter(r => orig.conditions.every(c => r.conditions[c].grade));
  const metrics = Object.fromEntries(orig.conditions.map(c => [c, L.conditionMetrics(graded.map(r => ({ cat: r.cat, expectUnknown: r.expectUnknown,
    hasForbidden: r.hasForbidden, grade: r.conditions[c].grade })))]));
  const out = { ...orig, label: `${orig.label ?? ''} + recovery`, mergedFrom: { original: origFile, recovery: recFile, recoveredUnits: rec.results.map(key) },
    questions: results.length, graded: graded.length, judgeErrors: results.length - graded.length, metrics, results };
  writeFileSync(path.resolve(ROOT, flag('--json')), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`merged ${orig.results.length} + ${rec.results.length} recovered = ${results.length}/${expected.length} expected units, ${graded.length} graded → ${flag('--json')}`);
  process.exit(0);
}

const COMPARE = flag('--compare', null);
if (COMPARE) {
  const [a, b] = COMPARE.split(',').map(f => JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')));
  const conds = a.conditions.filter(c => b.conditions.includes(c));
  const key = r => `${r.id}#${r.rep}`;
  const before = new Map(a.results.map(r => [key(r), r]));
  const pct = v => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  for (const c of conds) {
    // One row per (question, repeat) both runs graded: condition `x` = first run, `y` = second.
    const rows = b.results.flatMap(r => {
      const x = before.get(key(r))?.conditions?.[c]?.grade, y = r.conditions?.[c]?.grade;
      return x && y ? [{ id: r.id, cat: r.cat, hasForbidden: r.hasForbidden, expectUnknown: r.expectUnknown, conditions: { x: { grade: x }, y: { grade: y } } }] : [];
    });
    const m = k => L.conditionMetrics(rows.map(r => ({ ...r, grade: r.conditions[k].grade })));
    const [mx, my] = [m('x'), m('y')];
    console.log(`\n${c}: ${rows.length} paired answers (${a.label ?? 'first'} → ${b.label ?? 'second'})`);
    for (const k of ['correctness', 'answerable_correctness', 'stale_rate', 'unknown_honesty', 'fabrication_rate']) {
      console.log(`  ${k.padEnd(24)} ${pct(mx[k]).padStart(7)} → ${pct(my[k]).padStart(7)}`);
    }
    const show = (label, cmp) => console.log(`  ${label.padEnd(24)} Δ ${(cmp.meanDiff * 100).toFixed(1)} pts [${(cmp.ci95[0] * 100).toFixed(1)}, ${(cmp.ci95[1] * 100).toFixed(1)}]  q wins/losses/ties ${cmp.wins}/${cmp.losses}/${cmp.ties}  p=${cmp.sign_test_p}`);
    show('correct (clustered)', L.clusteredComparison(rows, 'y', 'x'));
    const stale = rows.filter(r => r.hasForbidden);
    if (stale.length) show('stale (clustered)', L.clusteredComparison(stale, 'y', 'x', g => g.stale));
    show('fabricated (clustered)', L.clusteredComparison(rows, 'y', 'x', g => g.fabricated));
    const cats = [...new Set(rows.map(r => r.cat))].sort();
    for (const cat of cats) console.log(`    cat:${cat.padEnd(18)} ${pct(mx.by_category[cat]).padStart(7)} → ${pct(my.by_category[cat]).padStart(7)}`);
  }
  process.exit(0);
}

// No database: production's legacy read has none, and this script never writes one.
process.env.DATABASE_URL = '';
process.env.MONGO_URI = '';
{
  const envPath = path.join(ROOT, '..', '.env');
  if (existsSync(envPath)) createRequire(path.join(ROOT, 'package.json'))('dotenv').config({ path: envPath, quiet: true });
}
// The same gate configuration world-model-lift-live.mjs runs legacyProd under.
Object.assign(process.env, { AQUA_E6: 'on', AQUA_CONTEXT_V2: 'on', AQUA_RETRIEVAL_V3: 'on', AQUA_SELF_ENTITY: 'on', AQUA_CROSS_ENCODER: 'off' });

const REPEAT = Math.max(1, Number(flag('--repeat', 1)));
const ONLY = flag('--personas', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const CONDS = (flag('--conditions', 'legacyProd')).split(',').map(s => s.trim()).filter(Boolean);
const ANSWER_PROVIDER = String(flag('--answer-provider', 'groq')).toLowerCase();
const ANSWER_MODEL = flag('--answer-model', ANSWER_PROVIDER === 'nvidia' ? 'openai/gpt-oss-20b' : 'openai/gpt-oss-120b');
const JUDGE_PROVIDER = flag('--judge-provider', 'nvidia');
const JUDGE_MODEL = flag('--judge-model', JUDGE_PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'nvidia/nemotron-3-ultra-550b-a55b');
const CONCURRENCY = Math.max(1, Math.min(8, Number(flag('--concurrency', 2))));
const DATASETS = (flag('--datasets', 'eval/lift/world-model-lift-heldout.v3.json')).split(',').map(s => s.trim()).filter(Boolean);
const LABEL = flag('--label', null);
// --questions id,id: ASK only these (recovering units a run lost to provider
// quota). Every persona's history is still replayed whole, so each context is
// built exactly as in a full run; only which questions are answered changes.
const QUESTIONS = flag('--questions', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
for (const f of DATASETS) {
  if (/heldout\.v4|final\.v1/.test(f)) { console.error(`✗ ${f} is a frozen evaluation set — this development instrument must not read it`); process.exit(2); }
}

const R = await import('../eval/lift/liftRuntime.mjs');
const LR = await import('../eval/lift/liftRecall.mjs');
const { legacyContexts } = await import('../eval/lift/liftLegacy.mjs');
const { recallForTurn } = await import('../src/memory/episodicRecall.js');
const { legacySupersessionNotes } = await import('../src/memory/engine.js');
const { makeJudge } = await import('../eval/lift/liftJudge.mjs');
const { generateGroq } = await import('../src/providers/groq.js');
const { generateNvidia } = await import('../src/providers/nvidia.js');
const ANSWER_FNS = { groq: generateGroq, nvidia: generateNvidia };
if (!ANSWER_FNS[ANSWER_PROVIDER]) { console.error(`✗ --answer-provider must be one of ${Object.keys(ANSWER_FNS).join(', ')}`); process.exit(2); }

const personas = DATASETS.flatMap(f => JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')).personas)
  .filter(p => !ONLY || ONLY.includes(p.id))
  .map(p => ({ ...p, history: R.flatHistory(p) }));
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Same wait-on-quota policy as world-model-lift-live.mjs.
async function withRetry(fn, label, tries = 9) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      const quota = /cooldown|429|rate limit|503|high demand|unavailable/i.test(String(err?.message ?? err));
      await sleep(quota ? Math.min(150_000, 20_000 * (i + 1)) : 1500 * (i + 1));
    }
  }
  throw new Error(`${label}: ${last?.message ?? last}`);
}
const answer = (system, user) => withRetry(async () => {
  const budget = ANSWER_PROVIDER === 'nvidia' ? 4000 : 900;
  const t0 = Date.now();
  const r = await ANSWER_FNS[ANSWER_PROVIDER](system, [{ role: 'user', content: user }], undefined, budget, { model: ANSWER_MODEL, temperature: 0 });
  return { text: r.text, model: r.model ?? ANSWER_MODEL, ms: Date.now() - t0 };
}, 'answer');
const judgeCall = makeJudge({ provider: JUDGE_PROVIDER, model: JUDGE_MODEL });
async function judge(persona, question, text) {
  const p = L.buildJudgePrompt({ history: persona.history, question }, text);
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { const r = await withRetry(() => judgeCall(p.system, p.user), 'judge'); return { ...L.parseJudgement(r.text, question), model: r.model }; }
    catch (err) { lastErr = err; }
  }
  return { error: String(lastErr?.message ?? lastErr) };
}

// --rejudge <run.json>: grade a run's stored answers again with this judge (no new
// answers), so two runs judged by different models can still be paired.
const REJUDGE = flag('--rejudge', null);
if (REJUDGE) {
  const prior = JSON.parse(readFileSync(path.resolve(ROOT, REJUDGE), 'utf8'));
  const byId = new Map(personas.flatMap(p => p.questions.map(q => [q.id, { persona: p, question: q }])));
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < prior.results.length) {
      const row = prior.results[i++];
      // With --questions, only those units are graded again; every other grade stays as it was.
      if (QUESTIONS && !QUESTIONS.includes(row.id)) continue;
      const { persona, question } = byId.get(row.id);
      for (const c of Object.keys(row.conditions)) {
        const j = await judge(persona, question, row.conditions[c].answer);
        row.conditions[c].judgement = j;
        row.conditions[c].grade = j.error ? null : L.gradeAnswer(question, j);
      }
      console.log(`  rejudged ${row.id}#${row.rep}`);
    }
  }));
  const graded = prior.results.filter(r => prior.conditions.every(c => r.conditions[c].grade));
  const metrics = Object.fromEntries(prior.conditions.map(c => [c, L.conditionMetrics(graded.map(r => ({ cat: r.cat, expectUnknown: r.expectUnknown,
    hasForbidden: r.hasForbidden, grade: r.conditions[c].grade })))]));
  const file = flag('--json', REJUDGE.replace(/\.json$/, `.rejudged-${JUDGE_PROVIDER}.json`));
  writeFileSync(path.resolve(ROOT, file), `${JSON.stringify({ ...prior, label: `${prior.label ?? ''} (rejudged)`, judgeProvider: JUDGE_PROVIDER, judgeModel: JUDGE_MODEL,
    rejudgedFrom: REJUDGE, graded: graded.length, judgeErrors: prior.results.length - graded.length, metrics }, null, 2)}\n`);
  console.log(`rejudged ${graded.length}/${prior.results.length} → ${file}`);
  process.exit(0);
}

const userIdFor = p => `lift-${RUN}-${p.id}`;
console.log(`[LEGACY-LIFT] run=${RUN} personas=${personas.length} conditions=${CONDS} repeat=${REPEAT} answer=${ANSWER_PROVIDER}/${ANSWER_MODEL} judge=${JUDGE_MODEL}`);
const t0 = Date.now();
const legacy = await legacyContexts(personas, { userIdFor: p => `${userIdFor(p)}-legacy`, traceId: `lift-legacy-${RUN}` });
console.log(`[LEGACY-LIFT] legacy read replayed in ${Date.now() - t0} ms`);

// --contexts-from <file> --regime <short|ranked|padded>: answer from contexts
// recorded by scripts/temporal-resolution-eval.mjs --emit-contexts instead of
// rebuilding them — the answer-level pair is then graded on exactly the
// contexts the retrieval metric measured (incl. long, ranked-recall
// histories this script's own replay cannot produce). Condition: legacyProd.
const CONTEXTS_FROM = flag('--contexts-from', null);
const REGIME = flag('--regime', 'padded');
const recorded = CONTEXTS_FROM ? JSON.parse(readFileSync(path.resolve(ROOT, CONTEXTS_FROM), 'utf8')) : null;
if (recorded && !recorded.contexts?.[REGIME]) { console.error(`✗ ${CONTEXTS_FROM} has no regime "${REGIME}"`); process.exit(2); }
const contextsFor = recorded ? async (persona, question) => {
  const c = recorded.contexts[REGIME][question.id];
  if (typeof c !== 'string') throw new Error(`no recorded context for ${question.id}`);
  return { legacyProd: c };
} : async (persona, question) => {
  const userId = userIdFor(persona);
  // Notes as chat.js reads them on a legacy read (engine.legacySupersessionNotes).
  const rec = await recallForTurn({ ownerId: `user:${userId}-legacy`, userId, conversationId: `${persona.id}-ask`, query: question.q,
    notesFor: legacySupersessionNotes, conversations: LR.conversationsFor(persona, userId), attachmentsFor: LR.attachmentsFor(persona) });
  const leg = legacy.get(question.id);
  return {
    legacyProd: [leg.memoryBlock, leg.knowledgeBlock, rec.block].filter(s => s && s.trim()).join('\n\n'),
    recall: rec.block,
  };
};

// --contexts-only [ids]: print each question's context and stop (no provider calls).
if (argv.includes('--contexts-only')) {
  const ids = flag('--contexts-only', '')?.startsWith('--') ? null : flag('--contexts-only', '')?.split(',').filter(Boolean);
  for (const persona of personas) {
    for (const question of persona.questions) {
      if (ids?.length && !ids.includes(question.id)) continue;
      const c = await contextsFor(persona, question);
      console.log(`\n════ ${question.id} [${question.cat}] ${question.q}\n${CONDS.map(k => `── ${k} (${L.estimateTokens(c[k])} tok)\n${c[k]}`).join('\n')}`);
      if (argv.includes('--items')) for (const it of legacy.get(question.id).knowledgeItems) console.log(`ITEM ${JSON.stringify(it)}`);
    }
  }
  process.exit(0);
}

const units = personas.flatMap(persona => persona.questions.filter(q => !QUESTIONS || QUESTIONS.includes(q.id)).flatMap(question =>
  Array.from({ length: REPEAT }, (_, rep) => ({ persona, question, rep }))));
if (QUESTIONS) {
  const known = new Set(units.map(u => u.question.id));
  const unknown = QUESTIONS.filter(id => !known.has(id));
  if (unknown.length) { console.error(`✗ --questions: no such question ${unknown.join(', ')}`); process.exit(2); }
}
const results = [];
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < units.length) {
    const { persona, question, rep } = units[next++];
    try {
      const contexts = await contextsFor(persona, question);
      const row = { persona: persona.id, id: question.id, cat: question.cat, q: question.q, rep,
        expectUnknown: Boolean(question.expectUnknown), hasForbidden: (question.forbidden ?? []).length > 0, conditions: {} };
      for (const cond of CONDS) {
        const p = L.buildAnswerPrompt(question.q, contexts[cond]);
        const a = await answer(p.system, p.user);
        const j = await judge(persona, question, a.text);
        row.conditions[cond] = { context: contexts[cond], contextTokens: L.estimateTokens(contexts[cond]), answer: a.text, answerModel: a.model,
          judgement: j, grade: j.error ? null : L.gradeAnswer(question, j) };
      }
      results.push(row);
      const g = c => (row.conditions[c]?.grade?.correct ? '✓' : row.conditions[c]?.grade ? '✗' : '?');
      console.log(`  ${question.id}#${rep} [${question.cat}] ${CONDS.map(c => `${c}${g(c)}`).join(' ')}  ${question.q}`);
    } catch (err) { console.warn(`[LEGACY-LIFT] ${question.id}#${rep} failed: ${err?.message ?? err}`); }
  }
}));
results.sort((a, b) => `${a.persona}|${a.id}|${a.rep}`.localeCompare(`${b.persona}|${b.id}|${b.rep}`));

const graded = results.filter(r => CONDS.every(c => r.conditions[c].grade));
const metrics = Object.fromEntries(CONDS.map(c => [c, L.conditionMetrics(graded.map(r => ({ cat: r.cat, expectUnknown: r.expectUnknown,
  hasForbidden: r.hasForbidden, grade: r.conditions[c].grade })))]));
const out = { experiment: 'lift-legacy-answers', label: LABEL, run: RUN, ranAt: new Date().toISOString(), datasets: DATASETS,
  answerProvider: ANSWER_PROVIDER, answerModel: ANSWER_MODEL, judgeProvider: JUDGE_PROVIDER, judgeModel: JUDGE_MODEL,
  repeat: REPEAT, conditions: CONDS, questions: results.length, graded: graded.length, judgeErrors: results.length - graded.length,
  metrics, results };
const file = flag('--json', path.join('eval', 'out', `lift-legacy-answers.${RUN}.json`));
mkdirSync(path.dirname(path.resolve(ROOT, file)), { recursive: true });
writeFileSync(path.resolve(ROOT, file), `${JSON.stringify(out, null, 2)}\n`);
const pct = v => (v == null ? '  n/a' : `${(v * 100).toFixed(1)}%`);
console.log(`\nLEGACY LIFT · ${graded.length}/${results.length} graded`);
for (const k of ['correctness', 'answerable_correctness', 'stale_rate', 'unknown_honesty', 'fabrication_rate']) {
  console.log(`${k.padEnd(24)} ${CONDS.map(c => `${c} ${pct(metrics[c][k])}`).join('   ')}`);
}
console.log(`→ ${file}`);
process.exit(0);
