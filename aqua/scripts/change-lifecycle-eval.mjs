#!/usr/bin/env node
/**
 * Unified change lifecycle — end-to-end, isolated (2026-11-02).
 *
 *   node scripts/change-lifecycle-eval.mjs [--propagation on|off] [--json out.json]
 *
 * The real observation pipeline and the real Memory-page / Understanding-page
 * edit functions, private data directory, simulated clock, no provider, no DB.
 *
 *   1. Path parity      the same change made in chat, on the Memory page and on
 *                       the Understanding page: what each store says afterwards
 *   2. Goal lifecycle   a goal closed in each place: do both goal stores agree?
 *   3. Dependencies     labelled dependents (name, acronym, alias, pronoun) and
 *                       controls (past, someone else, role, ambiguous pronoun,
 *                       unrelated): flagged / not flagged
 *   4. Recovery         evidence step failing k times: attempts, simulated time
 *                       to repair by the sweep (no message), dead letter
 *   5. Crash            a real child process killed mid-propagation: data loss,
 *                       repair by the next process, duplicates
 */
import '../eval/core/isolateDataDir.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const PROPAGATION = arg('propagation', 'on');
const JSON_OUT = arg('json', null);
process.env.DATABASE_URL = ''; process.env.MONGO_URI = '';
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
Object.assign(process.env, { AQUA_BRAIN_INGEST: 'on', AQUA_BRAIN_INGEST_FACTS: 'on', AQUA_PROPAGATION: PROPAGATION });
const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);
for (const k of ['log', 'info', 'warn', 'debug']) console[k] = () => {};

const engine = await import('../src/memory/engine.js');
const Brain = await import('../src/brain/index.js');
const ES = await import('../src/files/evidenceStore.js');
const P = await import('../src/memory/propagation.js');
const Editor = await import('../src/memory/memoryEditor.js');
const { peekMind } = await import('../src/mind/mindStore.js');
const { default: mindRouter } = await import('../src/mind/mindRoutes.js');

let clock = Date.UTC(2026, 8, 1);
Date.now = () => clock;
const settle = () => new Promise(r => setTimeout(r, 30));
let turn = 0, n = 0;
async function told(owner, text, conv = `${owner}-c`) {
  clock += 60_000; turn++;
  engine.memoryObserve(owner, { userMessage: text, conversationId: conv, userId: owner, requestId: `r${turn}`, extractMessage: text });
  engine.memoryAfterTurn(owner, {});
  await Brain.observeConversationTurn({ ownerId: owner, conversationId: conv, turn, userMessage: text, assistantMessage: '' });
  await settle();
}
async function lived(lines, conv) { const o = `user:life-${++n}`; for (const l of lines) await told(o, l, conv ?? `${o}-c`); clock += 7 * 86_400_000; return o; }
const items = v => [].concat(v ?? []);
const result = { propagation: PROPAGATION };

// ── 1. Path parity ───────────────────────────────────────────────────────────
const JOB = ["I'm a data analyst at Fintrail.", 'My goal is to get promoted to senior analyst at Fintrail.', "I'm leading the Atlas migration at Fintrail; it's due on March 3."];
function employer(o) {
  const m = peekMind(o);
  const belief = Object.values(m.beliefs).find(b => b.key === 'organization');
  const edges = Object.values(m.graph.edges).filter(e => e.from === 'person:__self__' && e.type === 'part_of' && !e.endedAt).map(e => m.graph.nodes[e.to]?.label);
  const s = ES.listFacts(o, { limit: 1000 });
  const stores = {
    'legacy fact': m.facts.workplace?.value ?? null,
    'Mind belief': belief && belief.status !== 'archived' ? belief.value : null,
    'Mind graph': edges.length === 1 ? edges[0] : edges.join('+') || null,
    'evidence lane': s.find(x => x.statement === JOB[0] && !x.archived) ? 'Fintrail' : 'Northbeam',
  };
  const deps = [Object.values(m.goals).find(g => /promoted/.test(g.title))?.review, m.working.deadlines.find(d => /Atlas/.test(d.label))?.review,
    s.find(x => /promoted/.test(x.statement))?.review, s.find(x => /Atlas/.test(x.statement))?.review];
  return { stores, agree: Object.values(stores).filter(v => v === 'Northbeam').length, total: Object.keys(stores).length, dependentsFlagged: deps.filter(Boolean).length, dependents: deps.length };
}
const routeHandle = (method, p) => mindRouter.stack.find(l => l.route?.path === p && l.route.methods[method]).route.stack.at(-1).handle;
const res = { json() { return this; }, status() { return this; } };
const PATHS = {
  chat: async o => told(o, 'Actually I work at Northbeam, not Fintrail.'),
  'memory page (correct)': async o => { Editor.correctFact(o, 'workplace', 'Northbeam'); await settle(); },
  'memory page (replace)': async o => { Editor.replaceFact(o, 'workplace', 'Northbeam'); await settle(); },
  'understanding page': async o => { routeHandle('patch', '/beliefs/:dim/:key')({ params: { dim: 'identity', key: 'organization' }, body: { value: 'Northbeam' }, aquaUserId: o.replace('user:', ''), query: {} }, res); await settle(); },
};
result.parity = {};
for (const [name, act] of Object.entries(PATHS)) { const o = await lived(JOB); await act(o); result.parity[name] = employer(o); }

// ── 2. Goal lifecycle ───────────────────────────────────────────────────────
function goalAgreement(o, re) {
  const m = peekMind(o);
  const g = Object.values(m.goals).find(x => re.test(x.title));
  const f = m.facts.goal;
  const legacyOpen = !!f && !f.ended && items(f.value).some(v => re.test(v));
  const mindOpen = !!g && ['active', 'blocked', 'stale'].includes(g.status);
  return { mind: g?.status ?? 'absent', legacyOpen, agree: legacyOpen === mindOpen };
}
const GOALS = ['My goal is to run a half marathon in October.', 'My goal is to learn Spanish this year.'];
const GOAL_PATHS = {
  'chat: finished': async o => told(o, 'I finished the half marathon.'),
  'chat: gave up': async o => told(o, 'I gave up on the half marathon.'),
  'chat: achievement, no closure verb': async o => told(o, 'I finally ran the half marathon last weekend!'),
  'understanding page (done)': async o => { const g = Object.values(peekMind(o).goals).find(x => /half marathon/.test(x.title)); routeHandle('patch', '/goals/:id')({ params: { id: g.id }, body: { status: 'completed' }, aquaUserId: o.replace('user:', ''), query: {} }, res); await settle(); },
  'related fact changed (must stay open)': async o => told(o, 'I now work at Northbeam as a senior analyst.'),
};
result.goals = {};
for (const [name, act] of Object.entries(GOAL_PATHS)) {
  const o = await lived(GOALS);
  await act(o);
  result.goals[name] = { target: goalAgreement(o, /half marathon/), other: goalAgreement(o, /Spanish/) };
}

// ── 3. Dependencies: labelled positives and controls ────────────────────────
const conv = 'deps';
const DEP_LIFE = [
  "I'm a data analyst at Lone Star Capital.",
  'My goal is to make partner at LSC by 2028.',                         // + acronym
  'I need to finish the Lone Star Capital audit by May 30.',            // + name
  'I learned SQL at Lone Star Capital.',                                // − past
  'My friend Sam works at Lone Star Capital.',                          // − someone else
  'My bank contact for the loan is Derek Shaw at Lone Star Bank.',
  'I need to send her the bank statements by June 5.',                  // + pronoun, one referent
  'My manager is Priya Rao. My accountant is Lena Ortiz.',
  'I need to send them the quarterly report by May 2.',                 // − pronoun, two referents
  'I need to send my manager the slide deck by May 9.',                 // − role
  'I need to renew my passport by July 1.',                             // − unrelated
];
const LABELS = [
  { re: /partner at LSC/, flag: true, why: 'acronym' }, { re: /Lone Star Capital audit/, flag: true, why: 'name' },
  { re: /bank statements/, flag: true, why: 'pronoun, one referent' }, { re: /learned SQL/, flag: false, why: 'past' },
  { re: /friend Sam/, flag: false, why: 'someone else' }, { re: /quarterly report/, flag: false, why: 'pronoun, two referents' },
  { re: /slide deck/, flag: false, why: 'role reference' }, { re: /passport/, flag: false, why: 'unrelated' },
];
{
  const o = `user:deps-${++n}`;
  for (const l of DEP_LIFE) await told(o, l, conv);
  clock += 7 * 86_400_000;
  await told(o, 'I now work at Northbeam as a senior analyst.', conv);
  await told(o, 'Derek Shaw moved to another branch; our new loan officer is Kim Alvarez.', conv);
  await told(o, 'My manager is now Tom Ellis.', conv);
  const m = peekMind(o);
  const s = ES.listFacts(o, { limit: 1000 });
  const recs = [...Object.values(m.goals).map(g => ({ text: g.title, flagged: !!g.review, store: 'goal' })),
    ...[...m.working.deadlines, ...m.working.blockers].map(d => ({ text: d.label ?? d.text, flagged: !!d.review, store: 'deadline' })),
    ...s.filter(x => !x.archived).map(x => ({ text: x.statement, flagged: !!x.review, store: 'evidence' }))];
  result.dependencies = LABELS.map(l => {
    const hits = recs.filter(r => l.re.test(r.text));
    return { why: l.why, expect: l.flag, records: hits.length, flagged: hits.filter(r => r.flagged).length, stores: hits.map(r => `${r.store}${r.flagged ? '✓' : '✗'}`).join(' ') };
  });
}

// ── 4. Recovery: failures, backoff, dead letter (sweep, no message) ─────────
if (PROPAGATION === 'on') {
  result.recovery = [];
  for (const k of [1, 3, 7, 8, 12]) {
    const o = await lived(JOB);
    let failures = 0;
    const t0 = clock;
    P._failOnceAt('evidence'); failures++;
    await told(o, 'I now work at Northbeam as a senior analyst.');
    const tr = () => Object.values(peekMind(o).facts).flatMap(f => f.transitions ?? []).filter(t => t.id);
    let sweeps = 0;
    while (sweeps < 40 && tr().some(t => !t.pic && !t.picDead)) {
      const next = Math.min(...tr().filter(t => !t.pic && !t.picDead).map(t => t.picNextAt ?? clock));
      clock = Math.max(clock + 60_000, next + 1);                 // the sweeper runs every 60 s
      if (failures < k) { P._failOnceAt('evidence'); failures++; }
      await P.sweepOnce({ owners: [o] });
      sweeps++;
    }
    P._failOnceAt(null);
    const ts = tr();
    result.recovery.push({ failuresInjected: k, attempts: Math.max(...ts.map(t => t.picAttempts ?? 0)), sweeps,
      repaired: ts.every(t => t.pic), deadLettered: ts.filter(t => t.picDead).length, simulatedSecondsToRepair: ts.every(t => t.pic) ? Math.round((clock - t0) / 1000) : null,
      reportedDead: P.propagationStatus(o).evidenceDead.length });
  }

  // ── 5. Crash: a real child process dies mid-propagation ────────────────────
  const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/memory/tests/fixtures/changeLifecycleChild.mjs');
  const child = (...a) => { const r = spawnSync(process.execPath, [CHILD, ...a], { encoding: 'utf8', timeout: 60_000 }); const json = (r.stdout ?? '').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(x => x && typeof x === 'object'); return { code: r.status, out: json.at(-1) ?? null }; };
  result.crash = {};
  for (const point of ['after-mind-flush', 'after-evidence-flush']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-lifecycle-eval-'));
    const t0 = performance.now();
    const c = child(dir, 'crash', 'user:c', point);
    const r = child(dir, 'recover', 'user:c');
    result.crash[point] = { exitCode: c.code, changeSurvived: r.out?.before.workplace === 'Northbeam', pendingAfterRestart: r.out?.before.pending,
      pendingAfterSweep: r.out?.after.pending, oldSentenceRetired: r.out?.after.oldArchived, duplicateFlags: (r.out?.after.reviewed.length ?? 0) - new Set(r.out?.after.reviewed ?? []).size,
      historyBefore: r.out?.before.history, historyAfter: r.out?.after.history, wallMs: Math.round(performance.now() - t0) };
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
say(`\n== change lifecycle  propagation=${PROPAGATION}`);
say('\n-- 1. path parity: what each store says the employer is after the change');
for (const [p, r] of Object.entries(result.parity)) say(`   ${p.padEnd(24)} stores at Northbeam ${r.agree}/${r.total}  ${JSON.stringify(r.stores)}  dependents flagged ${r.dependentsFlagged}/${r.dependents}`);
say('\n-- 2. goal lifecycle: do the Mind goal and the profile goal list agree?');
for (const [p, r] of Object.entries(result.goals)) say(`   ${p.padEnd(38)} target: mind=${r.target.mind} profileOpen=${r.target.legacyOpen} agree=${r.target.agree}   other goal agree=${r.other.agree} (${r.other.mind})`);
say('\n-- 3. dependencies (labelled)');
for (const d of result.dependencies) say(`   ${(d.expect ? '+' : '−')} ${d.why.padEnd(24)} flagged ${d.flagged}/${d.records}  ${d.stores}`);
const pos = result.dependencies.filter(d => d.expect), neg = result.dependencies.filter(d => !d.expect);
say(`   positives fully flagged ${pos.filter(d => d.records && d.flagged === d.records).length}/${pos.length}; controls with any false flag ${neg.filter(d => d.flagged).length}/${neg.length}`);
if (result.recovery) {
  say('\n-- 4. recovery by the sweep (no user message)');
  for (const r of result.recovery) say(`   failures ${String(r.failuresInjected).padStart(2)}: attempts ${r.attempts}, sweeps ${r.sweeps}, repaired ${r.repaired}, dead-lettered ${r.deadLettered} (reported ${r.reportedDead}), simulated time to repair ${r.simulatedSecondsToRepair ?? '—'} s`);
  say('\n-- 5. crash (real child process)');
  for (const [p, r] of Object.entries(result.crash)) say(`   ${p.padEnd(22)} ${JSON.stringify(r)}`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
process.exit(0);
