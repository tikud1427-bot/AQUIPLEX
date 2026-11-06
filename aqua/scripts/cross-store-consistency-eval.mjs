#!/usr/bin/env node
/**
 * Cross-store consistency — end-to-end, isolated (2026-11-02).
 *
 * One simulated user through every production legacy writer (memoryObserve,
 * memoryAfterTurn, Brain.observeConversationTurn, Brain.observeTwin), then
 * every store inspected after each change: legacy facts, Mind beliefs, Mind
 * graph, Mind goals, working memory, the conversation evidence lane, and the
 * prompt's memory block. No provider, no database, private data directory.
 *
 *   node scripts/cross-store-consistency-eval.mjs [--profile dev-env|code-defaults] [--propagation on|off] [--json out.json]
 *
 * dev-env       the flags of the developer environment (conversation facts
 *               reach the evidence lane)
 * code-defaults every AQUA_* switch unset — what production runs if its
 *               environment sets none (the evidence lane then holds no
 *               conversational facts)
 * --propagation off measures the code before memory/propagation.js (kill switch).
 */
import '../eval/core/isolateDataDir.mjs';
import fs from 'node:fs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const PROFILE = arg('profile', 'dev-env');
const PROPAGATION = arg('propagation', 'on');
const JSON_OUT = arg('json', null);

process.env.DATABASE_URL = ''; process.env.MONGO_URI = '';
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
if (PROFILE === 'dev-env') Object.assign(process.env, { AQUA_STORE_PG: 'shadow', AQUA_BRAIN_INGEST: 'on', AQUA_BRAIN_INGEST_FACTS: 'on', AQUA_REFLECT_V2: 'on',
  AQUA_TWIN_V2: 'on', AQUA_CLAIMS_SHADOW: 'on', AQUA_CONSOLIDATE: 'on', AQUA_UUS: 'on', AQUA_E6: 'on', AQUA_CONTEXT_V2: 'on', AQUA_RETRIEVAL_V3: 'on', AQUA_SELF_ENTITY: 'on' });
process.env.AQUA_PROPAGATION = PROPAGATION;
const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);
for (const k of ['log', 'info', 'warn', 'debug']) console[k] = () => {};

const engine = await import('../src/memory/engine.js');
const Brain = await import('../src/brain/index.js');
const LTM = await import('../src/memory/longTermMemory.js');
const ES = await import('../src/files/evidenceStore.js');
const P = await import('../src/memory/propagation.js');
const { peekMind } = await import('../src/mind/mindStore.js');
const { classifyTask } = await import('../src/core/classifier.js');
const { sensitivePolicy } = await import('../src/memory/sensitivity.js');

const DAY = 86_400_000;
let clock = Date.UTC(2026, 8, 1);
Date.now = () => clock;
const settle = () => new Promise(r => setTimeout(r, 40));

// ── The lives ────────────────────────────────────────────────────────────────
// Life A was used while building memory/propagation.js (development). Life B
// was written afterwards with other names, attributes and phrasings, and run
// without changing the code for it (a check, not a held-out benchmark).
// key: which legacy fact key holds the attribute.
const LIVES = {
  a: {
    setup: [
      "I'm a data analyst at Fintrail.",
      'My goal is to get promoted to senior analyst at Fintrail.',
      "I'm leading the Atlas migration at Fintrail; it's due on March 3.",
      'My bank contact for the loan is Derek Shaw at Lone Star Bank.',
      'I need to send Derek Shaw the bank statements by June 5.',
      'I prefer long, detailed answers with lots of background.',
      // controls: must not change, must not be flagged
      'My manager is Priya Rao.',
      'I learned SQL at Fintrail.',
      'My friend Sam works at Fintrail.',
      'My goal is to run a half marathon in October.',
    ],
    changes: [
      { id: 'employer', text: 'I now work at Northbeam as a senior analyst.',
        retired: [{ attr: 'workplace', key: /^workplace$/, old: 'fintrail' }, { attr: 'profession', key: /^profession$/, old: 'data analyst' }],
        oldSentences: ["I'm a data analyst at Fintrail."],
        dependents: [/promoted to senior analyst at fintrail/i, /atlas migration/i] },
      { id: 'loan-officer', text: 'Derek Shaw moved to another branch; our new loan officer is Kim Alvarez.',
        retired: [{ attr: 'loan officer', key: /loan|contact|officer/, old: 'derek shaw' }],
        oldSentences: ['My bank contact for the loan is Derek Shaw at Lone Star Bank.'],
        dependents: [/bank statements/i] },
      { id: 'preference', text: 'Actually, I now prefer short bullet-point answers.',
        retired: [{ attr: 'preference', key: /^preference$/, old: 'long, detailed' }],
        oldSentences: ['I prefer long, detailed answers with lots of background.'],
        dependents: [] },
    ],
    controls: [/learned sql/i, /friend sam/i, /half marathon/i, /priya rao/i],
    query: 'Where do I work, what am I working toward, who is our loan officer, and how do I like answers?',
    revert: 'I now work at Fintrail again.', revertKey: 'workplace', revertValue: 'fintrail', forget: 'Forget my workplace.', forgetValue: 'northbeam',
  },
  b: {
    setup: [
      'I live in Austin.',
      'My goal is to open a bakery in Austin.',
      'The Austin studio lease renewal is due on April 9.',
      'My manager is Priya Rao.',
      'I need to send Priya Rao the quarterly report by May 2.',
      'I prefer email over phone calls.',
      // controls
      'My sister lives in Austin.',
      'I grew up in Austin.',
      'My goal is to read twelve books this year.',
      'My accountant is Lena Ortiz.',
    ],
    changes: [
      { id: 'city', text: 'We moved to Denver last month.',
        retired: [{ attr: 'city', key: /^(?:city|location)$/, old: 'austin' }],
        oldSentences: ['I live in Austin.'],
        dependents: [/bakery in austin/i, /lease renewal/i] },
      { id: 'manager', text: 'My manager is now Tom Ellis.',
        retired: [{ attr: 'manager', key: /manager/, old: 'priya rao' }],
        oldSentences: ['My manager is Priya Rao.'],
        dependents: [/quarterly report/i] },
      { id: 'preference', text: 'Actually, I now prefer phone calls.',
        retired: [{ attr: 'preference', key: /^preference$/, old: 'email over' }],
        oldSentences: ['I prefer email over phone calls.'],
        dependents: [] },
    ],
    controls: [/sister lives/i, /grew up/i, /twelve books/i, /lena ortiz/i],
    query: 'Where do I live, what am I working toward, who is my manager, and how do I like to be contacted?',
    revert: 'We moved back to Austin.', revertKey: 'city', revertValue: 'austin', forget: 'Forget my city.', forgetValue: 'denver',
  },
};
const LIFE = LIVES[arg('life', 'a')];
const SETUP = LIFE.setup, CHANGES = LIFE.changes, CONTROLS = LIFE.controls;
const QUERY = LIFE.query;

let turn = 0;
async function say1(ownerId, text, conv) {
  clock += 60_000; turn++;
  const { task } = classifyTask(text);
  engine.memoryObserve(ownerId, { userMessage: text, taskType: task, conversationId: conv, userId: ownerId, requestId: `r${turn}`, extractMessage: text, rememberSensitive: false });
  engine.memoryAfterTurn(ownerId, { taskType: task });
  await Brain.observeConversationTurn({ ownerId, conversationId: conv, turn, userMessage: text, assistantMessage: '' });
  Brain.observeTwin({ ownerId, userMessage: text, conversationId: conv });
  await settle();
}
async function setup(ownerId) {
  for (const t of SETUP) await say1(ownerId, t, `${ownerId}-s0`);
  clock += 7 * DAY;
}

// ── Inspection ───────────────────────────────────────────────────────────────
const low = v => JSON.stringify(v ?? '').toLowerCase();
const has = (v, s) => low(v).includes(s);
const isCurrentText = (v, s) => typeof v === 'string' ? v.toLowerCase().includes(s) : Array.isArray(v) ? v.some(x => low(x).includes(s)) : has(v, s);

function memoryBlock(ownerId) {
  return engine.memoryRetrieve(ownerId, { query: QUERY, taskType: 'conversation', factLimit: 12, requestId: `q${turn}`, semanticScores: null, fileChunks: [],
    legacyUserMemory: true, legacyVeto: null, sensitive: sensitivePolicy({ rememberSensitive: false, message: 'x' }) }).block;
}

/** Lines of the memory block that name `s` as current: not under "No longer current", no history/uncertainty marker. */
function promptAsCurrent(block, s) {
  let history = false; const out = [];
  for (const line of block.split('\n')) {
    if (/^#{2,3} /.test(line) || /^--- /.test(line)) history = /no longer current/i.test(line);
    if (history || !line.toLowerCase().includes(s)) continue;
    if (/^(?:use this memory|values listed|if asked|do not narrate)/i.test(line.replace(/^[-\s]+/, ''))) continue;
    // Marked as changed or uncertain, or named only as what a value replaced.
    if (/uncertain whether|since changed/i.test(line)) continue;
    if (!line.split(/\(previously:/i)[0].toLowerCase().includes(s)) continue;
    out.push(line.trim().slice(0, 160));
  }
  return out;
}

const HELD = new Map();   // change id → what each store held as current just before it
function inspectChange(ownerId, change) {
  const mind = peekMind(ownerId);
  const facts = LTM.getFacts(ownerId, { includeArchived: true });
  const pic = ES.listFacts(ownerId, { limit: 100_000 });
  const block = memoryBlock(ownerId);
  const r = { id: change.id, outdated: {}, history: {}, dependents: [], prompt: [] };
  for (const { attr, key, old } of change.retired) {
    const legacy = facts.filter(f => !f.ended && key.test(f.key) && isCurrentText(f.value, old));
    const beliefs = Object.values(mind.beliefs ?? {}).filter(b => b.status !== 'archived' && isCurrentText(b.value, old));
    const edges = Object.values(mind.graph?.edges ?? {}).filter(e => e.from === 'person:__self__' && !e.endedAt && (mind.graph.nodes[e.to]?.label ?? '').toLowerCase() === old);
    const sentences = pic.filter(s => !s.archived && change.oldSentences.some(o => s.statement?.trim() === o));
    r.outdated[attr] = { legacy: legacy.length, belief: beliefs.length, graph: edges.length, evidence: sentences.length, prompt: promptAsCurrent(block, old).length };
    r.prompt.push(...promptAsCurrent(block, old));
    const factHist = facts.some(f => (f.history ?? []).some(h => has(h.value, old)) || (f.transitions ?? []).some(t => has(t.from, old)) || (f.retiredItems ?? []).some(x => has(x.item, old)) || (f.ended && has(f.value, old)));
    const beliefHist = Object.values(mind.beliefs ?? {}).filter(b => (b.history ?? []).some(h => has(h.value, old)) || (b.status === 'archived' && has(b.value, old)));
    const edgeHist = Object.values(mind.graph?.edges ?? {}).filter(e => (mind.graph.nodes[e.to]?.label ?? '').toLowerCase() === old);
    const sentenceHist = pic.filter(s => change.oldSentences.some(o => s.statement?.trim() === o));
    // Only stores that held the old value as current before the change can preserve it as history.
    const hist = { legacy: factHist, belief: beliefHist.length > 0, graph: edgeHist.length > 0, evidence: sentenceHist.length > 0 };
    const held = HELD.get(change.id)?.[attr];
    r.history[attr] = held ? Object.fromEntries(Object.entries(hist).filter(([k]) => held[k] > 0)) : hist;
  }
  for (const pat of change.dependents) {
    const recs = [
      ...Object.values(mind.goals ?? {}).filter(g => pat.test(g.title)).map(g => ({ store: 'mind goal', flagged: !!g.review, changed: g.status !== 'active' ? g.status : null })),
      ...[...(mind.working?.deadlines ?? []), ...(mind.working?.blockers ?? [])].filter(d => pat.test(d.label ?? d.text ?? '')).map(d => ({ store: 'working memory', flagged: !!d.review })),
      ...facts.filter(f => !f.ended && (Array.isArray(f.value) ? f.value : [f.value]).some(v => pat.test(String(v?.name ?? v)))).map(f => ({ store: `legacy ${f.key}`, flagged: (f.reviews ?? []).length > 0 })),
      ...pic.filter(s => pat.test(s.statement ?? '')).map(s => ({ store: 'evidence', flagged: !!s.review, changed: s.archived ? 'archived' : null })),
    ];
    const lines = block.split('\n').filter(l => pat.test(l));
    r.dependents.push({ pattern: String(pat), records: recs, renderedUncertain: lines.filter(l => /uncertain whether/i.test(l)).length, rendered: lines.length });
  }
  return r;
}

function controls(ownerId) {
  const mind = peekMind(ownerId);
  const facts = LTM.getFacts(ownerId, { includeArchived: true });
  const pic = ES.listFacts(ownerId, { limit: 100_000 });
  let flagged = 0, changed = 0, total = 0; const which = [];
  for (const pat of CONTROLS) {
    for (const g of Object.values(mind.goals ?? {}).filter(g => pat.test(g.title))) { total++; if (g.review) { flagged++; which.push('goal: ' + g.title); } if (g.status !== 'active') changed++; }
    for (const f of facts.filter(f => (Array.isArray(f.value) ? f.value : [f.value]).some(v => pat.test(String(v?.name ?? v))))) { total++; if ((f.reviews ?? []).some(r => r.item == null || pat.test(String(r.item)))) { flagged++; which.push('fact ' + f.key); } if (f.ended || f.transitions?.length) changed++; }
    for (const s of pic.filter(s => pat.test(s.statement ?? ''))) { total++; if (s.review) { flagged++; which.push('evidence: ' + s.statement); } if (s.archived) changed++; }
  }
  const manager = facts.find(f => /manager/.test(f.key));
  return { records: total, falseFlags: flagged, falseFlagged: which, unintendedChanges: changed, managerStill: manager ? String(manager.value) : null };
}

function snapshotCounts(ownerId) {
  const mind = peekMind(ownerId);
  const facts = Object.values(mind.facts ?? {});
  const ids = facts.flatMap(f => (f.transitions ?? []).map(t => t.id).filter(Boolean));
  return {
    history: facts.reduce((n, f) => n + (f.history?.length ?? 0), 0),
    transitions: facts.reduce((n, f) => n + (f.transitions?.length ?? 0), 0),
    duplicateTransitionIds: ids.length - new Set(ids).size,
    beliefHistory: Object.values(mind.beliefs ?? {}).reduce((n, b) => n + (b.history?.length ?? 0), 0),
    reviews: Object.values(mind.goals ?? {}).filter(g => g.review).length + facts.reduce((n, f) => n + (f.reviews?.length ?? 0), 0)
      + [...(mind.working?.deadlines ?? []), ...(mind.working?.blockers ?? [])].filter(d => d.review).length,
    evidenceReviews: ES.listFacts(ownerId, { limit: 100_000 }).filter(s => s.review).length,
    edges: Object.keys(mind.graph?.edges ?? {}).length,
  };
}

const sumOutdated = r => Object.values(r.outdated).reduce((n, o) => n + o.legacy + o.belief + o.graph + o.evidence + o.prompt, 0);
const consistent = r => Object.values(r.outdated).every(o => !o.legacy && !o.belief && !o.graph && !o.evidence && !o.prompt);

// ── Main run ─────────────────────────────────────────────────────────────────
const result = { life: arg('life', 'a'), profile: PROFILE, propagation: PROPAGATION, checkpoints: [], replay: null, controls: null, failure: {} };
const owner = `user:xstore-${Date.now()}`;
await setup(owner);
const done = [];
for (const c of CHANGES) {
  HELD.set(c.id, inspectChange(owner, c).outdated);
  await say1(owner, c.text, `${owner}-${c.id}`);
  clock += 2 * DAY;
  done.push(c);
  result.checkpoints.push({ after: c.id, changes: done.map(x => inspectChange(owner, x)) });
}
// The same message delivered again (client retry / duplicate event).
const before = snapshotCounts(owner);
await say1(owner, CHANGES[0].text, `${owner}-employer`);
const after = snapshotCounts(owner);
result.replay = { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) };
result.controls = controls(owner);
result.final = CHANGES.map(c => inspectChange(owner, c));
result.memoryBlock = memoryBlock(owner);

// Account isolation: the same first week, no change — nothing propagated.
const other = `user:xstore-other-${Date.now()}`;
await setup(other);
const iso = snapshotCounts(other);
result.isolation = { transitions: iso.transitions, reviews: iso.reviews, evidenceReviews: iso.evidenceReviews,
  endedEdges: Object.values(peekMind(other).graph?.edges ?? {}).filter(e => e.endedAt).length };

if (PROPAGATION === 'on') {
  const fresh = async (name) => { const o = `user:xstore-${name}-${Date.now()}`; await setup(o); return o; };
  const employer = CHANGES[0];
  // F1 — a Mind stage fails during the change turn; the next turn repairs it.
  { const o = await fresh('f1'); P._failOnceAt('graph');
    await say1(o, employer.text, `${o}-c`); const a = inspectChange(o, employer);
    await say1(o, 'What is a good way to learn Rust?', `${o}-n`); const b = inspectChange(o, employer);
    result.failure.mindStage = { afterFailure: sumOutdated(a), afterNextTurn: sumOutdated(b), consistentAfterNextTurn: consistent(b) }; }
  // F2 — the evidence lane step fails; retried on the next turn.
  { const o = await fresh('f2'); P._failOnceAt('evidence');
    await say1(o, employer.text, `${o}-c`); const a = inspectChange(o, employer);
    const attempts = Object.values(peekMind(o).facts).flatMap(f => f.transitions ?? []).map(t => t.picAttempts ?? 0);
    await say1(o, 'What is a good way to learn Rust?', `${o}-n`); const b = inspectChange(o, employer);
    result.failure.evidenceStage = { afterFailure: sumOutdated(a), maxAttempts: Math.max(0, ...attempts), afterNextTurn: sumOutdated(b), consistentAfterNextTurn: consistent(b) }; }
  // F3 — an older copy comes back (what the two-process merge can do): the belief and edge revert.
  { const o = await fresh('f3');
    await say1(o, employer.text, `${o}-c`);
    const m = peekMind(o);
    for (const b of Object.values(m.beliefs)) if (b.supersededBy || b.endedBy) { b.value = b.history.at(-1).value; b.status = 'active'; delete b.supersededBy; delete b.endedBy; }
    for (const e of Object.values(m.graph.edges)) if (e.endedAt) { delete e.endedAt; delete e.endedBy; }
    for (const g of Object.values(m.goals)) delete g.review;
    const a = inspectChange(o, employer);
    await say1(o, 'What is a good way to learn Rust?', `${o}-n`); const b = inspectChange(o, employer);
    result.failure.staleCopy = { afterRevert: sumOutdated(a), afterNextTurn: sumOutdated(b), consistentAfterNextTurn: consistent(b),
      dependentsReflagged: b.dependents.every(d => d.records.filter(x => x.store !== 'evidence' || !x.changed).every(x => x.flagged)) }; }
  // F4 — "forget my workplace": nothing the change set may keep quoting the user.
  { const o = await fresh('f4');
    await say1(o, employer.text, `${o}-c`);
    const quoted = () => {
      const m = peekMind(o);
      const q = x => has(x?.review?.text, LIFE.forgetValue) || (x?.reviews ?? []).some(r => has(r.text, LIFE.forgetValue));
      return Object.values(m.goals).filter(q).length + Object.values(m.facts).filter(q).length
        + [...m.working.deadlines, ...m.working.blockers].filter(q).length + ES.listFacts(o, { limit: 100_000 }).filter(q).length;
    };
    const a = quoted();
    await say1(o, LIFE.forget, `${o}-f`);
    await settle();
    const m = peekMind(o);
    result.failure.forget = { reviewsQuotingBefore: a, reviewsQuotingAfter: quoted(),
      forgottenFactPresent: !!m.facts[LIFE.revertKey],
      beliefStillHoldingForgottenValue: Object.values(m.beliefs).filter(b => b.status !== 'archived' && has(b.value, LIFE.forgetValue)).length,
      edgeStillToForgottenValue: Object.values(m.graph.edges).filter(e => !e.endedAt && has(m.graph.nodes[e.to]?.label, LIFE.forgetValue)).length }; }
  // F5 — back to the old value: everything the change set is released.
  { const o = await fresh('f5');
    await say1(o, employer.text, `${o}-c`);
    clock += 30 * DAY;
    await say1(o, LIFE.revert, `${o}-back`);
    const m = peekMind(o);
    result.failure.revert = { value: m.facts[LIFE.revertKey]?.value ?? null,
      reviewsLeft: Object.values(m.goals).filter(g => g.review).length + Object.values(m.facts).reduce((n, f) => n + (f.reviews?.length ?? 0), 0),
      evidenceReviewsLeft: ES.listFacts(o, { limit: 100_000 }).filter(s => s.review).length,
      oldEdgeOpen: Object.values(m.graph.edges).some(e => !e.endedAt && m.graph.nodes[e.to]?.label?.toLowerCase() === LIFE.revertValue),
      beliefsHoldingOld: Object.values(m.beliefs).filter(b => b.status !== 'archived' && has(b.value, LIFE.revertValue)).length }; }
}

// ── Report ───────────────────────────────────────────────────────────────────
say(`\n== cross-store consistency  life=${result.life}  profile=${PROFILE}  propagation=${PROPAGATION}`);
for (const cp of result.checkpoints) {
  const latest = cp.changes.at(-1);
  say(`\n-- after ${cp.after}`);
  for (const [attr, o] of Object.entries(latest.outdated)) {
    say(`   ${attr.padEnd(14)} outdated-as-current: legacy=${o.legacy} belief=${o.belief} graph=${o.graph} evidence=${o.evidence} prompt=${o.prompt}   history: ${Object.entries(latest.history[attr]).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join(' ')}`);
  }
  for (const d of latest.dependents) {
    say(`   dependent ${d.pattern}: ${d.records.map(x => `${x.store}${x.flagged ? '✓' : '✗'}${x.changed ? `[${x.changed}]` : ''}`).join(', ') || '(no records)'}; rendered ${d.renderedUncertain}/${d.rendered} uncertain`);
  }
  for (const l of latest.prompt) say(`     prompt as current: ${l}`);
}
const fin = result.final;
const outdatedTotal = fin.reduce((n, r) => n + sumOutdated(r), 0);
const deps = fin.flatMap(r => r.dependents.flatMap(d => d.records.filter(x => !x.changed)));
say(`\n== final (all three changes)`);
say(`   outdated-as-current records (all stores + prompt): ${outdatedTotal}`);
say(`   changes consistent across every store:              ${fin.filter(consistent).length}/${fin.length}`);
say(`   history preserved (attr×store where held):          ${fin.flatMap(r => Object.values(r.history).flatMap(h => Object.values(h))).filter(Boolean).length}/${fin.flatMap(r => Object.values(r.history).flatMap(h => Object.values(h))).length}`);
say(`   dependent records flagged:                         ${deps.filter(x => x.flagged).length}/${deps.length}`);
say(`   dependents closed/deleted by the change:           ${fin.flatMap(r => r.dependents.flatMap(d => d.records.filter(x => x.changed && x.changed !== 'archived'))).length}`);
say(`   controls: records=${result.controls.records} falseFlags=${result.controls.falseFlags} ${JSON.stringify(result.controls.falseFlagged)} unintendedChanges=${result.controls.unintendedChanges} manager=${result.controls.managerStill}`);
say(`   replay of the same message: unchanged=${result.replay.unchanged} ${result.replay.unchanged ? '' : JSON.stringify(result.replay)}`);
say(`   duplicate transition ids: ${result.replay.after.duplicateTransitionIds}`);
say(`   isolation (other account, no change): ${JSON.stringify(result.isolation)}`);
for (const [k, v] of Object.entries(result.failure)) say(`   failure ${k}: ${JSON.stringify(v)}`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
process.exit(0);
