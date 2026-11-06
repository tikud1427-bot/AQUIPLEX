/**
 * One lifecycle for every change (memory/propagation.js, 2026-11-02).
 *
 * A Memory-page edit, an Understanding-page edit, a goal closed in either goal
 * store and a forgotten goal take the same transition path as a change said in
 * chat. Incomplete propagation is finished without another user message —
 * after a failure (backoff, dead letter), a crash (a real child process that
 * dies), or concurrently. Names reach dependents through aliases, acronyms and
 * an unambiguous pronoun; an ambiguous pronoun and a role reference do not.
 * Private data directory, no provider, no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-lifecycle-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
// Change propagation is OFF by default (2026-11-06: only AQUA_PROPAGATION=on enables it).
// These tests exercise behaviour that needs it, so they enable it explicitly.
process.env.AQUA_PROPAGATION = 'on';
process.env.AQUA_BRAIN_INGEST = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS = 'on';

const engine = await import('../engine.js');
const Brain = await import('../../brain/index.js');
const ES = await import('../../files/evidenceStore.js');
const P = await import('../propagation.js');
const Editor = await import('../memoryEditor.js');
const LTM = await import('../longTermMemory.js');
const G = await import('../../reasoning/reasoningGraph.js');
const { forgetGoal } = await import('../forget.js');
const { peekMind } = await import('../../mind/mindStore.js');
const { sensitivePolicy } = await import('../sensitivity.js');

let clock = Date.UTC(2026, 8, 1);
const realNow = Date.now;
Date.now = () => clock;
process.on('exit', () => { Date.now = realNow; });
const settle = () => new Promise(r => setTimeout(r, 30));

let turn = 0;
async function say(owner, text, conv = `${owner}-c`) {
  clock += 60_000; turn++;
  engine.memoryObserve(owner, { userMessage: text, conversationId: conv, userId: owner, requestId: `r${turn}`, extractMessage: text });
  engine.memoryAfterTurn(owner, {});
  await Brain.observeConversationTurn({ ownerId: owner, conversationId: conv, turn, userMessage: text, assistantMessage: '' });
  await settle();
}
let n = 0;
async function lived(lines) {
  const owner = `user:lifecycle-${++n}`;
  for (const t of lines) await say(owner, t);
  clock += 7 * 86_400_000;
  return owner;
}
const JOB = [
  "I'm a data analyst at Fintrail.",
  'My goal is to get promoted to senior analyst at Fintrail.',
  "I'm leading the Atlas migration at Fintrail; it's due on March 3.",
];
const items = v => [].concat(v ?? []);
const org = m => Object.values(m.beliefs).find(b => b.key === 'organization');
const edgeTo = (m, label) => Object.values(m.graph.edges).find(e => e.from === 'person:__self__' && m.graph.nodes[e.to]?.label?.toLowerCase() === label);
const goal = (m, re) => Object.values(m.goals).find(g => re.test(g.title));
const sentence = (owner, s) => ES.listFacts(owner, { limit: 1000 }).find(f => f.statement === s);
const block = owner => engine.memoryRetrieve(owner, { query: 'Where do I work and what am I working toward?', requestId: `q${++turn}`,
  legacyUserMemory: true, sensitive: sensitivePolicy({ rememberSensitive: false, message: 'x' }) }).block;
/** What every store says about the employer: one value, or a list of disagreements. */
function employerEverywhere(owner) {
  const m = peekMind(owner);
  return {
    fact: m.facts.workplace?.value ?? null,
    belief: org(m)?.status === 'archived' ? null : org(m)?.value ?? null,
    openEdges: Object.values(m.graph.edges).filter(e => e.from === 'person:__self__' && e.type === 'part_of' && !e.endedAt).map(e => m.graph.nodes[e.to]?.label),
    oldSentenceArchived: sentence(owner, "I'm a data analyst at Fintrail.")?.archived === true,
    goalFlagged: !!goal(m, /promoted/)?.review,
  };
}

// ── Priority 1: one lifecycle whichever way the user changed it ──────────────
test('a Memory-page correction reaches every store, exactly as a chat correction does', async () => {
  const chat = await lived(JOB);
  // The pipeline's correction phrasing: 'my company is X' is extracted as a project (see the report).
  await say(chat, 'Actually I work at Northbeam, not Fintrail.');
  const page = await lived(JOB);
  Editor.correctFact(page, 'workplace', 'Northbeam');
  await settle();
  const a = employerEverywhere(chat), b = employerEverywhere(page);
  assert.deepEqual(b, { fact: 'Northbeam', belief: 'Northbeam', openEdges: ['Northbeam'], oldSentenceArchived: true, goalFlagged: true });
  assert.deepEqual(a, b, 'the two paths define the same current reality');
  const t = peekMind(page).facts.workplace.transitions.find(x => x.id);
  assert.equal(t.kind, 'corrected');
  assert.equal(t.source, 'memory_page');
  assert.ok(peekMind(page).facts.workplace.history.some(h => h.value === 'Fintrail'), 'the old value is history');
});

test('a Memory-page edit is shown as an edit, never as something the user said', async () => {
  const owner = await lived(JOB);
  Editor.replaceFact(owner, 'workplace', 'Northbeam');
  await settle();
  const b = block(owner);
  assert.match(b, /promoted to senior analyst at Fintrail" \(uncertain whether still current — they changed it on the Memory page: workplace "Fintrail" → "Northbeam"\)/);
  assert.doesNotMatch(b, /they said: "edited:/);
  assert.match(b, /workplace: Northbeam \(previously: Fintrail\)/, 'a replace is a change: what it replaced is shown');
});

test('a Memory-page correction shows no "previously" — the old value was wrong, as with a chat correction', async () => {
  const owner = await lived(JOB);
  Editor.correctFact(owner, 'workplace', 'Northbeam');
  assert.doesNotMatch(block(owner), /previously: Fintrail/);
});

test('archive takes the value out of every store without flagging anything; restore brings it all back', async () => {
  const owner = await lived(JOB);
  Editor.archiveFact(owner, 'workplace');
  await settle();
  let m = peekMind(owner);
  assert.equal(org(m).status, 'archived');
  assert.ok(edgeTo(m, 'fintrail').endedAt);
  assert.equal(sentence(owner, "I'm a data analyst at Fintrail.")?.archived, true);
  assert.equal(goal(m, /promoted/).review, undefined, 'an archive is not a change in the world');
  Editor.restoreFact(owner, 'workplace');
  await settle();
  m = peekMind(owner);
  assert.equal(org(m).status, 'active');
  assert.equal(org(m).value, 'Fintrail');
  assert.ok(!edgeTo(m, 'fintrail').endedAt);
  assert.equal(sentence(owner, "I'm a data analyst at Fintrail.")?.archived, false, 'the sentence the archive retired is back');
});

test('an Understanding-page edit of a bridged belief is a fact correction', async () => {
  const owner = await lived(JOB);
  const { default: router } = await import('../../mind/mindRoutes.js');
  const layer = router.stack.find(l => l.route?.path === '/beliefs/:dim/:key' && l.route.methods.patch);
  const res = { json() { return this; }, status() { return this; } };
  layer.route.stack.at(-1).handle({ params: { dim: 'identity', key: 'organization' }, body: { value: 'Northbeam' }, aquaUserId: owner.replace('user:', ''), query: {}, headers: {} }, res);
  await settle();
  const m = peekMind(owner);
  assert.equal(m.facts.workplace.value, 'Northbeam', 'the fact the belief is a copy of changed');
  assert.equal(m.facts.workplace.transitions.find(t => t.id)?.source, 'understanding_card');
  assert.equal(org(m).value, 'Northbeam');
  assert.ok(goal(m, /promoted/).review);
});

// ── Priority 3: goals ────────────────────────────────────────────────────────
test('a goal closed on the Understanding page closes in the profile too, with history', async () => {
  const owner = await lived(['My goal is to run a half marathon in October.']);
  const m = peekMind(owner);
  const g = goal(m, /half marathon/);
  g.history.push({ status: g.status, at: clock, reason: 'user edit' });
  g.status = 'completed';
  P.reconcileMind(owner);
  const f = m.facts.goal;
  assert.ok(f.ended || !items(f.value).some(v => /half marathon/.test(v)), 'no longer a current goal in the profile');
  // One goal is a scalar fact (closes as `ended`); several are a collection (a retired item).
  const closed = f.ended ? { kind: f.ended.kind, item: f.value } : f.retiredItems?.find(r => /half marathon/.test(r.item));
  assert.equal(closed?.kind, 'resolved', 'kept as completed, not deleted');
  assert.match(String(closed.item), /half marathon/);
  assert.equal(f.transitions.find(t => t.id)?.source, 'understanding_card');
  assert.deepEqual(P.reconcileMind(owner), { beliefs: 0, edges: 0, goals: 0, flagged: 0, cleared: 0 }, 'once');
});

test('a goal the profile closed from the user\'s words closes in the Mind', async () => {
  const owner = await lived(['My goal is to run a half marathon in October.']);
  LTM.applyCurrentState(owner, 'goal', { action: 'end' }, { text: 'I ran the half marathon last weekend!', kind: 'resolved', item: items(peekMind(owner).facts.goal.value).find(v => /half marathon/.test(v)), at: clock });
  P.reconcileMind(owner);
  const g = goal(peekMind(owner), /half marathon/);
  assert.equal(g.status, 'completed');
  assert.match(g.history.at(-1).reason, /resolved by the user: I ran the half marathon/);
});

test('a related fact changing never completes or drops a goal', async () => {
  const owner = await lived(JOB);
  await say(owner, 'I now work at Northbeam as a senior analyst.');
  const m = peekMind(owner);
  assert.equal(goal(m, /promoted/).status, 'active');
  assert.ok(items(m.facts.goal.value).some(v => /promoted/.test(v)));
});

test('forgetting a goal removes it from both goal stores, its history and the graph', async () => {
  const owner = await lived(['My goal is to get promoted to senior analyst at Fintrail.', 'My goal is to run a half marathon in October.']);
  const m = peekMind(owner);
  await forgetGoal(owner, goal(m, /promoted/).id);
  assert.equal(goal(m, /promoted/), undefined);
  assert.ok(!JSON.stringify(m.facts.goal ?? {}).includes('promoted'), 'no copy in value, history or transitions');
  assert.ok(!Object.values(m.graph.nodes).some(x => /promoted/.test(x.label)));
  assert.ok(items(m.facts.goal.value).some(v => /half marathon/.test(v)), 'the other goal stays');
});

// ── Priority 2: recovery without another message ─────────────────────────────
test('a failed evidence step backs off, is retried by the sweep (no message), and dead-letters after the last attempt', async () => {
  const owner = await lived(JOB);
  P._failOnceAt('evidence');
  await say(owner, 'I now work at Northbeam as a senior analyst.');
  const failed = () => Object.values(peekMind(owner).facts).flatMap(f => f.transitions ?? []).find(t => t.picAttempts);
  const t = failed();
  assert.equal(t.picAttempts, 1);
  assert.ok(t.picNextAt > clock, 'backing off');
  await P.sweepOnce({ owners: [owner], now: clock });
  assert.equal(t.picAttempts, 1, 'not retried before its time');
  assert.ok(!t.pic);
  clock = t.picNextAt + 1;
  await P.sweepOnce({ owners: [owner] });
  assert.ok(t.pic, 'retried by the sweep and done — no user message');
  assert.equal(sentence(owner, "I'm a data analyst at Fintrail.")?.archived, true);

  // A step that keeps failing stops, kept and reported.
  const other = await lived(JOB);
  await say(other, 'I now work at Northbeam as a senior analyst.');
  const t2 = Object.values(peekMind(other).facts).flatMap(f => f.transitions ?? []).find(x => x.id);
  delete t2.pic;
  for (let i = 0; i < 12; i++) { P._failOnceAt('evidence'); await P.propagateToEvidence(other, { now: (t2.picNextAt ?? clock) + 1 }); }
  P._failOnceAt(null);
  assert.equal(t2.picAttempts, 8, 'bounded');
  assert.ok(t2.picDead?.error);
  const status = P.propagationStatus(other);
  assert.ok(status.evidenceDead.some(r => r.id === t2.id && /injected failure/.test(r.error)), 'exposed for diagnostics');
});

test('concurrent sweeps and chat-path steps do the work once', async () => {
  const owner = await lived(JOB);
  P._failOnceAt('evidence');
  await say(owner, 'I now work at Northbeam as a senior analyst.');
  for (const t of Object.values(peekMind(owner).facts).flatMap(f => f.transitions ?? [])) { delete t.picNextAt; delete t.pic; }
  await Promise.all([P.sweepOnce({ owners: [owner] }), P.propagateToEvidence(owner), P.sweepOnce({ owners: [owner] })]);
  await P.sweepOnce({ owners: [owner] });
  const reviews = ES.listFacts(owner, { limit: 1000 }).filter(s => s.review);
  assert.equal(new Set(reviews.map(s => s.id)).size, reviews.length);
  assert.equal(peekMind(owner).facts.workplace.history.filter(h => h.value === 'Fintrail').length, 1, 'no duplicate history');
});

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'changeLifecycleChild.mjs');
const child = (...args) => {
  const r = spawnSync(process.execPath, [CHILD, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: (r.stdout ?? '').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).at(-1) ?? null, err: r.stderr };
};

for (const point of ['after-mind-flush', 'after-evidence-flush']) {
  test(`a process that dies ${point.replace(/-/g, ' ')} is finished by the next process, once`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-lifecycle-crash-'));
    const crashed = child(dir, 'crash', 'user:crash', point);
    assert.equal(crashed.code, 70, `the child died at ${point}: ${crashed.err?.slice(0, 300)}`);
    const r = child(dir, 'recover', 'user:crash');
    assert.ok(r.out, r.err?.slice(0, 500));
    assert.equal(r.out.before.workplace, 'Northbeam', 'the change survived: it was durable before anything acted on it');
    assert.ok(r.out.before.stamped < r.out.before.transitions, 'not marked done');
    assert.equal(r.out.after.pending, 0, 'finished by the sweep, without a message');
    assert.equal(r.out.after.oldArchived, true);
    assert.equal(r.out.after.stamped, r.out.after.transitions);
    assert.equal(new Set(r.out.after.reviewed).size, r.out.after.reviewed.length, 'each sentence flagged once');
    assert.ok(r.out.after.reviewed.length >= 2, 'the goal and the Atlas sentences');
    assert.equal(r.out.after.history, r.out.before.history, 'no duplicate history');
  });
}

test('two processes sweeping the same store at once converge, without duplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-lifecycle-dual-'));
  assert.equal(child(dir, 'crash', 'user:dual', 'after-mind-flush').code, 70);
  const { spawn } = await import('node:child_process');
  const run = () => new Promise(res => { const p = spawn(process.execPath, [CHILD, dir, 'sweep', 'user:dual']); let o = ''; p.stdout.on('data', d => { o += d; }); p.on('close', () => res(JSON.parse(o.trim().split('\n').at(-1)))); });
  await Promise.all([run(), run()]);
  const final = child(dir, 'recover', 'user:dual').out;
  assert.equal(final.after.oldArchived, true);
  assert.equal(final.after.pending, 0);
  assert.equal(new Set(final.after.reviewed).size, final.after.reviewed.length);
});

// ── Priority 4: names, aliases, acronyms, pronouns ──────────────────────────
test('a three-word name reaches its acronym; two-letter initials do not', async () => {
  const owner = await lived(["I'm a data analyst at Lone Star Capital.", 'My goal is to make partner at LSC by 2028.', 'I need to send DS the deck by Friday.']);
  await say(owner, 'I now work at Northbeam as a senior analyst.');
  const m = peekMind(owner);
  assert.equal(m.facts.workplace.value, 'Northbeam');
  assert.ok(goal(m, /partner at LSC/)?.review, 'LSC = Lone Star Capital');
  assert.equal(P.anchorsFor(owner, { from: 'Derek Shaw' }, { value: 'Kim Alvarez' }).includes('DS'), false);
});

test('an alias the entity resolver merged into the same entity is a name for it', async () => {
  const owner = await lived(JOB);
  // An alias that does not contain the name itself, so only the resolver's merge can link them.
  G.upsertNode(owner, { id: 'ent:fintrail', type: 'entity', label: 'Fintrail', data: { entityType: 'organization', aliases: ['FTL Group'] } });
  const m = peekMind(owner);
  m.working.deadlines.push({ label: 'Hand over the FTL Group laptop by May 1', ts: null, source: 'message', addedAt: clock - 1000 });
  await say(owner, 'I now work at Northbeam as a senior analyst.');
  assert.ok(m.working.deadlines.find(d => /FTL Group laptop/.test(d.label)).review);
});

test('a pronoun with one referent reaches the person; with two it reaches no one; a role is not a name', async () => {
  const owner = await lived([]);
  const conv = `${owner}-loan`;
  await say(owner, 'My bank contact for the loan is Derek Shaw at Lone Star Bank.', conv);
  await say(owner, 'I need to send her the bank statements by June 5.', conv);
  await say(owner, 'My manager is Priya Rao. My accountant is Lena Ortiz.', conv);
  await say(owner, 'I need to send them the quarterly report by May 2.', conv);
  await say(owner, 'I need to send my manager the slide deck by May 9.', conv);
  clock += 7 * 86_400_000;
  await say(owner, 'Derek Shaw moved to another branch; our new loan officer is Kim Alvarez.', conv);
  await say(owner, 'My manager is now Tom Ellis.', conv);
  const w = peekMind(owner).working;
  const d = re => w.deadlines.find(x => re.test(x.label));
  assert.deepEqual(d(/bank statements/)?.refersTo, ['Derek Shaw']);
  assert.ok(d(/bank statements/)?.review, 'her = Derek Shaw, the one person the previous message named');
  assert.equal(d(/quarterly report/)?.refersTo, undefined, 'two candidates: ambiguous, untouched');
  assert.equal(d(/quarterly report/)?.review, undefined);
  assert.equal(d(/slide deck/)?.review, undefined, '"my manager" is whoever holds the role now');
});

test('another account is untouched by every path', async () => {
  const a = await lived(JOB);
  const b = await lived(JOB);
  Editor.correctFact(a, 'workplace', 'Northbeam');
  await P.sweepOnce();
  const m = peekMind(b);
  assert.equal(m.facts.workplace.value, 'Fintrail');
  assert.equal(org(m).value, 'Fintrail');
  assert.ok(!(m.facts.workplace.transitions ?? []).some(t => t.id));
  assert.equal(goal(m, /promoted/).review, undefined);
});
