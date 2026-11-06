#!/usr/bin/env node
/**
 * Model-independent answer evaluation harness (2026-11-04).
 *
 * Nothing here calls a model. It prepares exactly what an answerer would see,
 * and grades answers someone else produced, with a deterministic rubric.
 *
 *   contexts     replay each life through the REAL production prompt path
 *                (routes/chat.js prepareTurn, legacy read, flags as in
 *                production code defaults unless --profile dev-env), for the
 *                code at --code (default: this tree), and record the system
 *                prompt each question gets. Private data directory.
 *                  node scripts/answer-eval-harness.mjs contexts --code <aquaDir> --label after --out ctx.after.json
 *   prepare      one JSONL record per (question, condition) for any answerer
 *                  node scripts/answer-eval-harness.mjs prepare --contexts ctx.before.json,ctx.after.json --out prompts.jsonl
 *   sufficiency  model-free: does each context CONTAIN what a correct answer needs
 *                (current value as current, retired value only as history, the
 *                achieved goal marked done, the dependent record marked uncertain)?
 *   grade        score answers: JSONL {id, condition, answer} → per criterion, per
 *                condition, paired difference
 *   selftest     grade the dataset's example answers: every good one must pass,
 *                every bad one must fail — the rubric is checked before it is trusted
 *
 * Questions and criteria: eval/datasets/answer-lifecycle.dev.v1.json.
 */
import '../eval/core/isolateDataDir.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : d; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(fs.readFileSync(path.join(HERE, '../eval/datasets/answer-lifecycle.dev.v1.json'), 'utf8'));
const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);

// ── Rubric (deterministic; a proxy for a judge, stated as such) ─────────────
const low = s => String(s ?? '').toLowerCase();
const sentencesOf = s => String(s ?? '').split(/(?<=[.!?;])\s+|\n+/).filter(Boolean);
const PAST_MARK = /\b(?:previously|used to|before|formerly|former|was|were|had|no longer|left|moved|changed|until|old|earlier|back then|since)\b/i;
const DONE_MARK = /\b(?:completed?|done|passed|achieved|finished|ran|did it|you did|congrat\w*|already)\b/i;
const HEDGE = /\?|\b(?:may|might|not sure|uncertain|unclear|check|confirm|is that still|are you still|still yours|still on|does that still|if that'?s still)\b/i;
const ABSTAIN = /\b(?:i don'?t know|you haven'?t (?:told|shared|mentioned)|i don'?t have|not sure|no record|haven'?t mentioned|i'?m not aware|you didn'?t (?:tell|mention))\b/i;
const COMMON_CAPS = new Set(['I', 'You', 'Your', 'Yes', 'No', 'As', 'Before', 'After', 'Both', 'Learning', 'Focus', 'Congratulations', 'Not', 'The', 'It', 'That', 'This', 'If', 'Since', 'Keep', 'Good', 'Great', 'Well', 'Sure', 'Is', 'Are', 'Did', 'Do', 'What', 'When', 'Which', 'Who', 'How', 'There', 'Here', 'They', 'We', 'My', 'Our', 'Hi', 'Okay', 'Ok']);

/** Names (capitalised tokens) in the answer that appear neither in the context nor in the question. */
function unsupported(answer, context, question) {
  const known = low(`${context}\n${question}`);
  // Word by word: a sentence may open on an ordinary word before a name ("Before Northbeam…").
  const caps = String(answer).match(/\b[A-Z][a-zA-Z]+\b/g) ?? [];
  const numbers = String(answer).match(/\b\d[\d-]{4,}\b/g) ?? [];
  return [...new Set(caps.filter(w => !COMMON_CAPS.has(w) && !known.includes(low(w)))), ...numbers.filter(n => !known.includes(n))];
}

export function gradeAnswer(q, answer, context = '') {
  const a = String(answer ?? '');
  const r = { id: q.id, category: q.category, checks: {} };
  if (q.include) r.checks.include = q.include.every(group => group.some(t => low(a).includes(low(t))));
  if (q.notCurrent) r.checks.notCurrent = q.notCurrent.every(v => sentencesOf(a).filter(s => low(s).includes(low(v))).every(s => PAST_MARK.test(s)));
  if (q.notOpen) r.checks.notOpen = q.notOpen.every(v => sentencesOf(a).filter(s => low(s).includes(low(v))).every(s => DONE_MARK.test(s) && !/\b(?:still (?:training|preparing|working)|not yet|keep at it|are open|is open)\b/i.test(s)));
  if (q.hedge) r.checks.hedge = HEDGE.test(a);
  if (q.abstain) r.checks.abstain = ABSTAIN.test(a);
  const extra = unsupported(a, context || DS.lives[q.life].join(' '), q.ask);
  r.checks.supported = extra.length === 0;
  r.unsupported = extra;
  r.pass = Object.values(r.checks).every(Boolean);
  return r;
}

// ── contexts: the real production prompt for each question ──────────────────
async function buildContexts() {
  const code = path.resolve(flag('code', path.join(HERE, '..')));
  const label = flag('label', 'current');
  const out = flag('out');
  process.env.DATABASE_URL = ''; process.env.MONGO_URI = '';
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
    if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY|^GROQ|^NVIDIA|^OPENAI|^ANTHROPIC)/.test(k)) delete process.env[k];
  }
  if (flag('profile') === 'dev-env') Object.assign(process.env, { AQUA_BRAIN_INGEST: 'on', AQUA_BRAIN_INGEST_FACTS: 'on', AQUA_UUS: 'on' });
  for (const k of ['log', 'info', 'warn', 'debug']) console[k] = () => {};
  const imp = p => import(pathToFileURL(path.join(code, p)).href);
  const store = await imp('src/memory/conversationStore.js');
  const { prepareTurn } = await imp('src/routes/chat.js');
  const { createContext } = await imp('src/core/observability.js');
  const engine = await imp('src/memory/engine.js');
  const Brain = await imp('src/brain/index.js');
  let clock = Date.UTC(2026, 8, 1, 9);
  Date.now = () => clock;
  const contexts = {};
  let turn = 0;
  const ask = async (userId, conv, text) => {
    store.getOrCreateConversation(conv, { userId });
    const rid = `${conv}-${++turn}`;
    const prep = await prepareTurn({ userMessage: text, workspaceId: null, conversationId: conv, userId, ctx: createContext({ conversationId: conv, requestId: rid }), requestId: rid, skipReasoningPass: true });
    return prep;
  };
  // One fresh account per QUESTION, the life replayed into it, the question asked once:
  // asking a life's questions in sequence in one account let each earlier question
  // leak into the next prompt ("open question: What should I focus on…" in q06).
  for (const q of DS.questions) {
    const userId = `harness-${q.life}-${q.id}`;
    clock = Date.UTC(2026, 8, 1, 9);
    let s = 0;
    for (const line of DS.lives[q.life]) {
      if (line === '---') { s++; clock += 7 * 86_400_000; continue; }
      clock += 3_600_000;
      const conv = `${userId}-s${s}`;
      await ask(userId, conv, line);
      store.addMessage(conv, 'user', line);
      store.addMessage(conv, 'assistant', 'Got it.');
      const owner = engine.resolveOwner({ userId, conversationId: conv });
      engine.memoryAfterTurn(owner, {});
      await Brain.observeConversationTurn({ ownerId: owner, conversationId: conv, turn, userMessage: line, assistantMessage: 'Got it.' });
      await new Promise(r => setTimeout(r, 20));
    }
    clock += 2 * 86_400_000 + 600_000;
    const prep = await ask(userId, `${userId}-ask`, q.ask);
    contexts[q.id] = prep.systemPrompt;
  }
  const record = { label, code, profile: flag('profile') ?? 'code-defaults', at: new Date().toISOString(), dataset: DS.id, contexts };
  if (out) fs.writeFileSync(out, JSON.stringify(record, null, 2));
  say(`contexts ${label}: ${Object.keys(contexts).length} questions, mean ${Math.round(Object.values(contexts).reduce((n, c) => n + c.length, 0) / Object.keys(contexts).length)} chars${out ? ` → ${out}` : ''}`);
}

const loadContexts = () => (flag('contexts') ?? '').split(',').filter(Boolean).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));

// ── sufficiency: does the context hold what a correct answer needs? ─────────
function sufficiency() {
  const rows = [];
  for (const c of loadContexts()) {
    for (const q of DS.questions) {
      const ctx = c.contexts[q.id] ?? '';
      const lines = ctx.split('\n');
      const r = { label: c.label, id: q.id, category: q.category, checks: {} };
      if (q.include && q.category !== 'goal_status') r.checks.hasCurrent = q.include.every(g => g.some(t => low(ctx).includes(low(t))));
      // A retired value appears only marked as past (history markers or "No longer current").
      if (q.notCurrent) {
        let history = false;
        r.checks.retiredMarked = q.notCurrent.every(v => lines.every(l => {
          if (/^#{2,3} |^--- /.test(l)) history = /no longer current/i.test(l);
          return !low(l).includes(low(v)) || history || /previously|since changed|uncertain whether|they said|they later said|no longer current/i.test(l) || /^\[\d{4}-\d\d-\d\d/.test(l) || /^\s*↳/.test(l);
        }));
      }
      if (q.notOpen) r.checks.goalMarkedDone = q.notOpen.every(v => !lines.some(l => /active goals|goals?:/i.test(l) && low(l).includes(low(v)) && !/completed|done|achieved/i.test(l)));
      if (q.hedge) r.checks.dependencyFlagged = lines.some(l => q.include.flat().some(t => low(l).includes(low(t))) && /uncertain whether|since changed|may be affected/i.test(l));
      r.pass = Object.values(r.checks).every(Boolean);
      rows.push(r);
    }
  }
  const labels = [...new Set(rows.map(r => r.label))];
  say('\n== context sufficiency (model-free)');
  for (const q of DS.questions) say(`   ${q.id} ${q.category.padEnd(21)} ${labels.map(l => { const r = rows.find(x => x.label === l && x.id === q.id); return `${l}: ${r.pass ? 'ok ' : 'GAP'} ${Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(',')}`.padEnd(40); }).join(' ')}`);
  for (const l of labels) { const rs = rows.filter(r => r.label === l); say(`   ${l}: ${rs.filter(r => r.pass).length}/${rs.length} contexts sufficient`); }
  return rows;
}

// ── prepare / grade / selftest ──────────────────────────────────────────────
function prepare() {
  const out = flag('out');
  const recs = loadContexts().flatMap(c => DS.questions.map(q => ({ id: q.id, condition: c.label, category: q.category, system: c.contexts[q.id], user: q.ask })));
  fs.writeFileSync(out, recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  say(`prepared ${recs.length} prompts (${DS.questions.length} questions × ${recs.length / DS.questions.length} conditions) → ${out}. Answer each with any model; write {id, condition, answer} per line; then \`grade\`.`);
}

function report(results) {
  const conds = [...new Set(results.map(r => r.condition))];
  say('\n== answers by category (pass rate)');
  const cats = [...new Set(DS.questions.map(q => q.category))];
  for (const cat of cats) say(`   ${cat.padEnd(21)} ${conds.map(c => { const rs = results.filter(r => r.condition === c && r.category === cat); return `${c}: ${rs.filter(r => r.pass).length}/${rs.length}`; }).join('   ')}`);
  for (const c of conds) { const rs = results.filter(r => r.condition === c); say(`   ${c}: overall ${rs.filter(r => r.pass).length}/${rs.length}; unsupported names ${rs.reduce((n, r) => n + r.unsupported.length, 0)}`); }
  if (conds.length === 2) {
    const [a, b] = conds;
    const pairs = DS.questions.map(q => [results.find(r => r.condition === a && r.id === q.id), results.find(r => r.condition === b && r.id === q.id)]).filter(([x, y]) => x && y);
    say(`   paired: ${b} better on ${pairs.filter(([x, y]) => !x.pass && y.pass).length}, worse on ${pairs.filter(([x, y]) => x.pass && !y.pass).length}, same on ${pairs.filter(([x, y]) => x.pass === y.pass).length}`);
  }
}

function grade() {
  const ctx = Object.fromEntries(loadContexts().map(c => [c.label, c.contexts]));
  const answers = fs.readFileSync(flag('answers'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const results = answers.map(x => ({ ...gradeAnswer(DS.questions.find(q => q.id === x.id), x.answer, ctx[x.condition]?.[x.id] ?? ''), condition: x.condition }));
  report(results);
  const out = flag('json');
  if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
}

function selftest() {
  const results = DS.questions.flatMap(q => ['good', 'bad'].map(kind => ({ ...gradeAnswer(q, q.examples[kind]), condition: kind, kind })));
  let ok = 0;
  say('\n== rubric self-test: good examples must pass, bad ones must fail');
  for (const q of DS.questions) {
    const g = results.find(r => r.id === q.id && r.kind === 'good'), b = results.find(r => r.id === q.id && r.kind === 'bad');
    const right = g.pass && !b.pass;
    if (right) ok++;
    say(`   ${right ? 'ok ' : 'BAD'} ${q.id} ${q.category.padEnd(21)} good=${g.pass ? 'pass' : `FAIL ${Object.entries(g.checks).filter(([, v]) => !v).map(([k]) => k)}${g.unsupported.length ? ` ${g.unsupported}` : ''}`} bad=${b.pass ? 'PASS (should fail)' : `fail(${Object.entries(b.checks).filter(([, v]) => !v).map(([k]) => k)})`}`);
  }
  say(`   ${ok}/${DS.questions.length} questions: the rubric separates the good answer from the bad one`);
  process.exitCode = ok === DS.questions.length ? 0 : 1;
}

// Run as a command only when executed directly; imported (validate-heldout.mjs), it only lends gradeAnswer.
const MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!MAIN) { /* library use */ }
else if (cmd === 'contexts') await buildContexts();
else if (cmd === 'prepare') prepare();
else if (cmd === 'sufficiency') sufficiency();
else if (cmd === 'grade') grade();
else if (cmd === 'selftest') selftest();
else { say('usage: answer-eval-harness.mjs contexts|prepare|sufficiency|grade|selftest …'); process.exitCode = 2; }
if (MAIN && cmd === 'contexts') process.exit(0);
