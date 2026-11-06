#!/usr/bin/env node
/**
 * Temporal resolution, retrieval level (2026-11-02) — deterministic, no
 * provider, no database.
 *
 *   node scripts/temporal-resolution-eval.mjs [--json eval/out/temporal-resolution.<label>.json] [--verbose]
 *
 * THE QUESTION IT ANSWERS. When the context of a current-state question holds
 * an older statement ("the opening is blocked by a zoning permit"), does it
 * also hold the later statement that resolved or changed it, in different
 * words ("the zoning permit came through")? Context = what a production turn
 * carries on the legacy read (eval/lift/liftLegacy.mjs + episodic recall with
 * the legacy "since changed" notes), per lane and combined.
 *
 * Metrics, over labelled questions (eval/datasets/temporal-resolution-labels.dev.v1.json):
 *   resolutionCoverage   P(current turn in context | stale turn in context)
 *   staleWithoutCurrent  share of change questions whose context has the stale turn and NOT the current one
 *   currentCoverage      share of current-state questions whose context has the current turn
 *   historicalCoverage   share of past-state questions whose context has the past turn
 *   unknownLines         mean evidence + recall lines on questions with no answer in memory (noise)
 *   tokens               mean combined context tokens (cost)
 *
 * Regimes: `short` — the history as written (recall quotes it whole);
 * `ranked` — same history, recall forced to rank (k=8), as on a long history;
 * `padded` — every user turn followed by --pad (6) neutral filler messages (generic
 * requests that state nothing about the user), production defaults.
 *
 * DEVELOPMENT INSTRUMENT: refuses frozen held-out / final sets.
 */
import '../eval/core/isolateDataDir.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

process.env.DATABASE_URL = '';
process.env.MONGO_URI = '';
// The flags legacyProd runs under (scripts/lift-legacy-answers.mjs: the repo
// .env's AQUA_* switches + its overrides), set here so no .env (and no key) is read.
// --profile code-defaults: every AQUA_* switch unset — what production runs if
// its environment sets none (its real values are not readable from here).
const PROFILE = flag('--profile', 'dev-env');
if (PROFILE === 'code-defaults') {
  for (const k of Object.keys(process.env)) if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR', 'AQUA_RECALL_ALL_CHARS'].includes(k)) delete process.env[k];
} else {
  Object.assign(process.env, { AQUA_STORE_PG: 'shadow', AQUA_BRAIN_INGEST: 'on', AQUA_BRAIN_INGEST_FACTS: 'on', AQUA_REFLECT_V2: 'on',
    AQUA_TWIN_V2: 'on', AQUA_CLAIMS_SHADOW: 'on', AQUA_CONSOLIDATE: 'on', AQUA_UUS: 'on',
    AQUA_E6: 'on', AQUA_CONTEXT_V2: 'on', AQUA_RETRIEVAL_V3: 'on', AQUA_SELF_ENTITY: 'on', AQUA_CROSS_ENCODER: 'off' });
}

const DATASETS = (flag('--datasets', 'eval/lift/world-model-lift-heldout.v3.json,eval/datasets/temporal-resolution.dev.v1.json'))
  .split(',').map(s => s.trim()).filter(Boolean);
for (const f of DATASETS) {
  if (/heldout\.v4|final\.v1/.test(f)) { console.error(`✗ ${f} is a frozen evaluation set`); process.exit(2); }
}
// --labels a.json,b.json: merged (question ids are unique across the dev sets).
const LABELS = Object.assign({}, ...flag('--labels', 'eval/datasets/temporal-resolution-labels.dev.v1.json').split(',').filter(Boolean)
  .map(f => JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')).labels));
const VERBOSE = argv.includes('--verbose');
const PAD = Math.max(1, Number(flag('--pad', 6)));
// --emit-contexts file: every question's combined context per regime, for the
// answer-level pair (scripts/lift-legacy-answers.mjs --contexts-from), so the
// answers are graded on exactly the contexts measured here.
const EMIT = flag('--emit-contexts', null);
const emitted = {};
// --dump id,id: print those questions' combined context in every regime.
const DUMP = (flag('--dump', '') ?? '').split(',').filter(Boolean);

// The app logs every write; this instrument's output is its table.
const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);
for (const k of ['log', 'info', 'warn', 'debug']) console[k] = () => {};

const LR = await import('../eval/lift/liftRecall.mjs');
const { legacyContexts } = await import('../eval/lift/liftLegacy.mjs');
const { recallForTurn } = await import('../src/memory/episodicRecall.js');
const { legacySupersessionNotes } = await import('../src/memory/engine.js');
const { estimateTokens } = await import('../eval/lift/liftCore.mjs');

// Generic requests and chatter: no fact about the user, no name, no date.
// Fixed and written before any change it measures.
const FILLER = [
  'How do I convert a CSV file to JSON?', 'What is the capital of Australia?', 'Can you explain compound interest simply?',
  'Give me a quick recipe for banana bread.', 'What does HTTP 404 mean?', 'How long should I boil an egg for a soft yolk?',
  'Write a haiku about autumn rain.', 'What is the difference between affect and effect?', 'Explain how a heat pump works.',
  'Suggest a name for a houseplant.', 'How do I center a div in CSS?', 'What are some good stretches after running?',
  'Translate "good morning" into Portuguese.', 'What is a Gantt chart used for?', 'How do vaccines train the immune system?',
  'Recommend a podcast about history.', 'How do I remove a coffee stain from a shirt?', 'What is the Pythagorean theorem?',
  'Give me three icebreaker questions for a workshop.', 'Why is the sky blue?', 'How do I write a polite follow-up email?',
  'What is the difference between a virus and bacteria?', 'Summarize the plot of Hamlet in two sentences.', 'How many cups are in a litre?',
  'What is a good way to learn touch typing?', 'Explain what an API rate limit is.', 'What are the rules of chess castling?',
  'How do I keep basil alive indoors?', 'What does a product roadmap usually contain?', 'Tell me a fun fact about octopuses.',
  'How do I make a pivot table in Google Sheets?', 'What is inflation, in simple terms?', 'Suggest a weekend hiking checklist.',
  'How do noise-cancelling headphones work?', 'What is the difference between RAM and storage?', 'Give me a tongue twister.',
  'How should I structure a one-page resume?', 'What is a leap year?', 'How do I sharpen a kitchen knife?',
  'Explain the offside rule in football.', 'What is a good daily routine for focus?', 'How do I calculate a percentage increase?',
  'What causes jet lag?', 'Write a short limerick about a cat.', 'How does a mortgage amortization schedule work?',
  'What is the tallest mountain in Africa?', 'How do I back up my phone photos?', 'What is the difference between weather and climate?',
  'lol sorry, wrong window', 'ok', 'hmm interesting', 'thanks!', 'brb', 'nice one', 'haha', 'got it',
];
const pad = (p, k = PAD) => {
  let n = 0;
  return { ...p, id: `${p.id}`, sessions: p.sessions.map(turns => turns.flatMap(t => [t, ...Array.from({ length: k }, () => FILLER[(n++) % FILLER.length])])) };
};

const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');
const has = (ctx, subs) => (subs ?? []).some(s => ctx.includes(norm(s)));
// Lines that carry evidence: recall excerpts ("[2026-…") and evidence bullets.
const evidenceLines = ctx => ctx.split('\n').filter(l => /^\[\d{4}-\d{2}-\d{2}|^\[undated|^• (?!Entity:)|^- /.test(l.trim())).length;

const personasOf = f => JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')).personas;
const base = DATASETS.flatMap(f => personasOf(f).map(p => ({ ...p, dataset: path.basename(f) })));

const LANES = ['recall', 'knowledge', 'memory', 'combined'];
async function regime(name, personas, recallOpts) {
  const run = `${name}-${Date.now().toString(36)}`;
  const userIdFor = p => `tr-${run}-${p.id}`;
  const legacy = await legacyContexts(personas, { userIdFor: p => `${userIdFor(p)}-legacy`, traceId: `tr-${run}` });
  const rows = [];
  for (const persona of personas) {
    for (const question of persona.questions) {
      const userId = userIdFor(persona);
      const rec = await recallForTurn({ ownerId: `user:${userId}-legacy`, userId, conversationId: `${persona.id}-ask`, query: question.q,
        notesFor: legacySupersessionNotes, conversations: LR.conversationsFor(persona, userId), attachmentsFor: LR.attachmentsFor(persona), ...recallOpts });
      const leg = legacy.get(question.id);
      const raw = { recall: rec.block, knowledge: leg.knowledgeBlock, memory: leg.memoryBlock };
      raw.combined = [raw.memory, raw.knowledge, raw.recall].filter(s => s && s.trim()).join('\n\n');
      const ctx = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, norm(v)]));
      if (DUMP.includes(question.id)) {
        say(`\n▼ ${name} ${question.id} ${question.q}\n${raw.combined}`);
        say(`recall ${JSON.stringify(rec.stats)}\n${rec.excerpts.map(e => `  ${e.why} · ${e.text}`).join('\n')}\n▲`);
      }
      if (EMIT) (emitted[name] ??= {})[question.id] = raw.combined;
      rows.push({ id: question.id, cat: question.cat, unknown: !!question.expectUnknown, label: LABELS[question.id] ?? null, rawMemory: raw.memory ?? '',
        ctx, tokens: estimateTokens(raw.combined), lines: evidenceLines(raw.combined), recallMode: rec.stats?.mode, followUps: rec.stats?.followUps ?? 0,
        // What the temporal-continuation rules themselves added (attribution of noise).
        continuationLines: (leg.knowledgeItems ?? []).filter(it => String(it.provenance?.via ?? it.via ?? '').startsWith('continuation')).length,
        followUpTexts: (rec.excerpts ?? []).filter(e => e.why === 'follow-up').map(e => e.text) });
    }
  }
  return rows;
}

function metrics(rows) {
  const out = {};
  for (const lane of LANES) {
    const change = rows.filter(r => r.label?.stale && !r.label.historical);
    const shown = change.filter(r => has(r.ctx[lane], r.label.stale));
    const resolved = shown.filter(r => has(r.ctx[lane], r.label.current));
    const cur = rows.filter(r => r.label?.current && !r.label.historical);
    const hist = rows.filter(r => r.label?.historical);
    out[lane] = {
      changeQuestions: change.length,
      staleShown: shown.length,
      resolutionCoverage: shown.length ? resolved.length / shown.length : null,
      staleWithoutCurrent: change.length ? (shown.length - resolved.length) / change.length : null,
      staleWithoutCurrentIds: shown.filter(r => !has(r.ctx[lane], r.label.current)).map(r => r.id),
      currentCoverage: cur.length ? cur.filter(r => has(r.ctx[lane], r.label.current)).length / cur.length : null,
      currentMissingIds: cur.filter(r => !has(r.ctx[lane], r.label.current)).map(r => r.id),
      historicalCoverage: hist.length ? hist.filter(r => has(r.ctx[lane], r.label.current)).length / hist.length : null,
      // Look-alike statements that must NOT be pulled in (vocabulary controls).
      falseMatchIds: rows.filter(r => r.label?.mustNot && has(r.ctx[lane], r.label.mustNot)).map(r => r.id),
      controls: rows.filter(r => r.label?.mustNot).length,
    };
  }
  const unk = rows.filter(r => r.unknown);
  out.unknownLines = unk.length ? unk.reduce((n, r) => n + r.lines, 0) / unk.length : null;
  out.unknownDetail = unk.map(r => ({ id: r.id, lines: r.lines, continuationLines: r.continuationLines, followUps: r.followUpTexts }));
  out.tokens = rows.reduce((n, r) => n + r.tokens, 0) / rows.length;
  out.followUps = rows.reduce((n, r) => n + r.followUps, 0);
  out.modes = rows.reduce((o, r) => ({ ...o, [r.recallMode]: (o[r.recallMode] ?? 0) + 1 }), {});
  // STALE PRESENTED AS CURRENT (2026-11-02): the outdated value inside the
  // memory block — identity ("authoritative"), profile ("rely on this
  // profile"), cognitive model ("Current state", "Active goals") — while the
  // history holds its update. Section, not presence: the evidence and recall
  // lanes may show an old statement, ordered, beside its update.
  const changeRows = rows.filter(r => r.label?.stale && !r.label.historical);
  // A line that carries its own "since changed" note presents the value AS
  // changed (the recall lane's notes, the goal line's), not as current. Read
  // from the RAW block, line by line: `ctx` is whitespace-normalised to one
  // line, and filtering that dropped the whole block whenever any line had a
  // note (bug found and fixed 2026-11-02, before this metric's numbers were reported).
  const asCurrentText = r => r.rawMemory.split('\n').filter(l => !l.includes('since changed')).map(norm).join('\n');
  const asCurrent = changeRows.filter(r => has(asCurrentText(r), [...(r.label.staleValue ?? []), ...r.label.stale]));
  out.staleAsCurrent = changeRows.length ? asCurrent.length / changeRows.length : null;
  out.staleAsCurrentIds = asCurrent.map(r => r.id);
  // FALSE UPDATE (controls): a value the user did NOT change (negated,
  // speculative, future) must stay in the memory block as current — on a line
  // without a "since changed" note. Missing counts too: destroyed is worse.
  const keepRows = rows.filter(r => r.label?.stillCurrent);
  const falseUpdate = keepRows.filter(r => r.label.stillCurrent.some(v => {
    const lines = r.rawMemory.split('\n').map(norm).filter(l => l.includes(norm(v)));
    return !lines.length || lines.every(l => l.includes('since changed'));
  }));
  out.falseUpdates = falseUpdate.length;
  out.falseUpdateIds = falseUpdate.map(r => r.id);
  out.controlsKept = keepRows.length;
  // Context relevance: same-subject statements that do not answer the question.
  const relRows = rows.filter(r => r.label?.irrelevant);
  out.irrelevantShown = Object.fromEntries(LANES.map(l => [l, relRows.reduce((n, r) => n + r.label.irrelevant.filter(x => r.ctx[l].includes(norm(x))).length, 0)]));
  out.irrelevantPossible = relRows.reduce((n, r) => n + r.label.irrelevant.length, 0);
  // A "deadline" in the cognitive model's Current state that names no date
  // ("before 6", "before dec", "launch on November"): a fragment, not a deadline.
  const dl = rows.map(r => (r.rawMemory.toLowerCase().match(/current state:[^\n]*?deadline: ([^|\n]*)/) ?? [])[1]).filter(Boolean);
  const DATED = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(?:today|tomorrow|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
  out.deadlines = dl.length;
  out.undatedDeadlines = dl.filter(x => !DATED.test(x)).length;
  // Per question category, combined context: current answer present / stale without it.
  out.byCat = {};
  for (const r of rows.filter(x => x.label?.current)) {
    const c = (out.byCat[r.label.historical ? 'historical' : r.cat] ??= { n: 0, current: 0, staleOnly: 0 });
    c.n++;
    if (has(r.ctx.combined, r.label.current)) c.current++;
    else if (r.label.stale && has(r.ctx.combined, r.label.stale)) c.staleOnly++;
  }
  return out;
}

const pct = v => (v == null ? '   —  ' : `${(v * 100).toFixed(1).padStart(5)}%`);
const t0 = Date.now();
const regimes = {
  short: await regime('short', base, {}),
  ranked: await regime('ranked', base, { allUnderChars: 0 }),
  padded: await regime('padded', base.map(p => pad(p)), {}),
};
const report = { at: new Date().toISOString(), profile: PROFILE, datasets: DATASETS, ms: Date.now() - t0, regimes: {} };
say(`profile ${PROFILE}`);
for (const [name, rows] of Object.entries(regimes)) {
  for (const ds of [...new Set(base.map(p => p.dataset)), 'ALL']) {
    const ids = new Set(base.filter(p => ds === 'ALL' || p.dataset === ds).flatMap(p => p.questions.map(q => q.id)));
    const m = metrics(rows.filter(r => ids.has(r.id)));
    report.regimes[`${name}|${ds}`] = m;
    say(`\n── ${name} · ${ds}   recall modes ${JSON.stringify(m.modes)}   tokens ${m.tokens.toFixed(0)}   unknown-question lines ${m.unknownLines?.toFixed(2)}   recall follow-ups ${m.followUps}`);
    if (m.controlsKept) say(`   false updates on no-change controls (memory block): ${m.falseUpdates}/${m.controlsKept}${m.falseUpdateIds.length ? ` (${m.falseUpdateIds.join(', ')})` : ''}`);
    say(`   stale presented as current (memory block): ${pct(m.staleAsCurrent)}${m.staleAsCurrentIds.length ? ` (${m.staleAsCurrentIds.join(', ')})` : ''}   undated "deadlines" in Current state: ${m.undatedDeadlines}/${m.deadlines} questions${m.irrelevantPossible ? `   irrelevant shown (combined): ${m.irrelevantShown.combined}/${m.irrelevantPossible}` : ''}`);
    say(`   lane        stale shown  resolution cov  stale w/o current  current cov  historical cov`);
    for (const lane of LANES) {
      const x = m[lane];
      say(`   ${lane.padEnd(10)}  ${String(x.staleShown).padStart(3)}/${String(x.changeQuestions).padEnd(4)}     ${pct(x.resolutionCoverage)}         ${pct(x.staleWithoutCurrent)}        ${pct(x.currentCoverage)}       ${pct(x.historicalCoverage)}`);
      if (x.controls) say(`      false matches: ${x.falseMatchIds.length}/${x.controls}${x.falseMatchIds.length ? ` (${x.falseMatchIds.join(', ')})` : ''}`);
      if (VERBOSE && x.staleWithoutCurrentIds.length) say(`      stale w/o current: ${x.staleWithoutCurrentIds.join(', ')}`);
      if (VERBOSE && x.currentMissingIds.length) say(`      current missing:   ${x.currentMissingIds.join(', ')}`);
    }
  }
}
if (EMIT) {
  // Which code produced these contexts: the source files the temporal path runs through.
  const { createHash } = await import('node:crypto');
  const SOURCES = ['src/understanding/stateTransition.js', 'src/memory/episodicRecall.js', 'src/pic/retrievalIntelligence.js', 'src/pic/questionShape.js',
    'src/brain/contextEngine/assembler.js', 'src/brain/contextEngine/index.js', 'src/brain/knowledgeExtraction/conversationFacts.js',
    'src/brain/knowledgeExtraction/conversationIngest.js', 'src/memory/engine.js', 'src/memory/factChange.js'];
  const code = Object.fromEntries(SOURCES.map(f => {
    try { return [f, createHash('sha256').update(readFileSync(path.resolve(ROOT, f))).digest('hex').slice(0, 16)]; } catch { return [f, null]; }
  }));
  mkdirSync(path.dirname(path.resolve(ROOT, EMIT)), { recursive: true });
  writeFileSync(path.resolve(ROOT, EMIT), `${JSON.stringify({ at: report.at, profile: PROFILE, pad: PAD, datasets: DATASETS, code, contexts: emitted }, null, 2)}\n`);
  say(`→ contexts ${EMIT}`);
}
const file = flag('--json', null);
if (file) {
  mkdirSync(path.dirname(path.resolve(ROOT, file)), { recursive: true });
  writeFileSync(path.resolve(ROOT, file), `${JSON.stringify(report, null, 2)}\n`);
  say(`\n→ ${file}`);
}
process.exit(0);
