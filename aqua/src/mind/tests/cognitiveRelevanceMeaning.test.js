/**
 * C9 — the Mind's question-aware selection uses MEANING, through the scores the
 * turn already has (2026-11-07).
 *
 * memory/engine.js memoryRetrieve({ claimScores }) → mind/itemMeaning.js links
 * each goal / blocker / deadline to the owner's live statements that state it,
 * and keeps it when one of them is a TRUSTED meaning match under PIC Lane 6's
 * rule (pic/denseAdmission.js). Planning questions with a topic of their own
 * keep only what they are about.
 *
 * ⚠️ THE SCORES HERE ARE INJECTED, DETERMINISTIC TEST INPUTS — not model
 * embeddings, and no claim about any model's quality. They stand in for
 * Brain.canonicalSemanticScores so the selection logic, its trust rule, its
 * filters and its fallbacks can be tested offline. Whether a real model scores
 * "a 21 km race" near "run a half marathon" is the job of the recorded-vector
 * replay (eval/tests/c9SemanticFixture.test.js), currently UNAVAILABLE.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-c9-meaning-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI|^GOOGLE)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
process.env.AQUA_BRAIN_INGEST = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS = 'on';
process.env.AQUA_MIND_RELEVANCE = 'on';

const engine = await import('../../memory/engine.js');
const Brain = await import('../../brain/index.js');
const ES = await import('../../files/evidenceStore.js');
const { peekMind } = await import('../mindStore.js');
const { denseAdmission, DENSE_MIN_CORPUS, DENSE_MARGIN_FLOOR } = await import('../../pic/denseAdmission.js');

afterEach(() => { process.env.AQUA_MIND_RELEVANCE = 'on'; });

let clock = Date.UTC(2026, 9, 1), turn = 0, n = 0;
const realNow = Date.now;
Date.now = () => clock;
process.on('exit', () => { Date.now = realNow; });

async function say(owner, text) {
  clock += 60_000; turn++;
  engine.memoryObserve(owner, { userMessage: text, conversationId: `${owner}-c`, userId: owner, requestId: `r${turn}`, extractMessage: text });
  engine.memoryAfterTurn(owner, {});
  await Brain.observeConversationTurn({ ownerId: owner, conversationId: `${owner}-c`, turn, userMessage: text, assistantMessage: '' });
}
// Brain ingest stores a conversational statement only when it NAMES something
// (brain/knowledgeExtraction/conversationFacts.js; measured 2026-11-07: "My goal is to run a
// half marathon in October." stores nothing, "…the Larkfield Half Marathon…" is stored). Only
// stored statements are scored, so these items are stated with names; the unnamed case is
// pinned as a known limitation below.
const FIRST = ['Hattie', 'Wim', 'Zsofi', 'Bisi', 'Dot', 'Sigrid', 'Nell', 'Gethin', 'Bea', 'Kemi', 'Otto', 'Juno', 'Pip', 'Rolo', 'Moss', 'Nala'];
const TOWN = ['Oakmere', 'Duncliffe', 'Pennock', 'Holmvik'];
const FILLER = Array.from({ length: 64 }, (_, i) => `I met ${FIRST[i % 16]} at the ${TOWN[Math.floor(i / 16)]} market and we talked about stall ${i + 1}.`);
// The three goals are stated in ONE message. Stated one per message, each new goal
// archives the evidence-lane sentence of the goal before it (a defect on the default
// path, pinned as a todo below), and an archived statement carries no meaning.
// The trap names "Pellmore", not "Kestrel": "I fixed … in the Kestrel payment service"
// reads as a resolution of "blocked on the Kestrel deploy pipeline" and closes it
// (working-memory closure, a separate false positive — not C9's to fix).
const STATED = ['My goal is to run the Larkfield Half Marathon in October. My goal is to learn Spanish this year. My goal is to get promoted to senior analyst at Brindlewood.',
  "I'm blocked on the Kestrel deploy pipeline.", 'I fixed a race condition in the Pellmore payment service.', 'I made a Spanish omelette for Hattie.'];
const RACE = /Larkfield Half Marathon/;

async function person({ filler = FILLER.length, extra = [] } = {}) {
  const o = `user:c9-meaning-${++n}`;
  for (const t of [...STATED, ...extra]) await say(o, t);
  for (const t of FILLER.slice(0, filler)) await say(o, t);
  return o;
}
const statements = o => ES.listFacts(o, { limit: 5000 });
const idOf = (o, re) => statements(o).find(f => re.test(f.statement))?.id;

/** INJECTED TEST SCORES: `high` statements at `hi`, every other statement of the owner low and spread. */
function injected(o, highRes, { hi = 0.8, lo = 0.42, spread = 0.06 } = {}) {
  const m = new Map();
  statements(o).forEach((f, i) => m.set(f.id, highRes.some(re => re.test(f.statement)) ? hi : lo + ((i * 37) % 100) / 100 * spread));
  return m;
}
const retrieve = (o, query, claimScores = null) => engine.memoryRetrieve(o, { query, requestId: `q${++turn}`, legacyUserMemory: true, claimScores });
const cognitive = (o, q, s) => (retrieve(o, q, s).block.match(/--- COGNITIVE MODEL[\s\S]*?--- END COGNITIVE MODEL ---/) ?? [''])[0];
const goalsLine = (o, q, s) => cognitive(o, q, s).match(/Active goals: ([^\n]*)/)?.[1] ?? '';

describe('the five C9 cases, with injected scores standing in for the turn\'s claim scores', () => {
  test('control: every owner corpus is above the trust floor, and each stated item exists', async () => {
    const o = await person();
    assert.ok(statements(o).length >= DENSE_MIN_CORPUS, `${statements(o).length} statements`);
    const m = peekMind(o);
    assert.equal(Object.values(m.goals).length, 3);
    assert.ok(m.working.blockers.some(b => /deploy pipeline/.test(b.text)));
  });

  test('C1 "How far is a 21 km race?" — lexically nothing; by meaning, the half-marathon goal only', async () => {
    const o = await person();
    const q = 'How far is a 21 km race?';
    assert.equal(goalsLine(o, q), '', 'without scores: the C7 lexical limit, unchanged');
    const g = goalsLine(o, q, injected(o, [RACE]));
    assert.match(g, /half marathon/i);
    assert.doesNotMatch(g, /Spanish|promoted/);
  });

  test('C2 "Is Duolingo worth it?" — the language goal, not the omelette and not the others', async () => {
    const o = await person();
    const g = goalsLine(o, 'Is Duolingo worth it?', injected(o, [/learn Spanish/]));
    assert.match(g, /learn Spanish/);
    assert.doesNotMatch(g, /half marathon|promoted/i);
  });

  test('C3 "Why is CI failing?" — the deploy-pipeline blocker, and no goal', async () => {
    const o = await person();
    const c = cognitive(o, 'Why is CI failing?', injected(o, [/Kestrel deploy pipeline/]));
    assert.match(c, /blocked on: [^\n]*deploy pipeline/);
    assert.doesNotMatch(c, /Active goals/);
  });

  test('C4 "How\'s my career?" — the promotion goal', async () => {
    const o = await person();
    const g = goalsLine(o, "How's my career?", injected(o, [/promoted to senior analyst/]));
    assert.match(g, /promoted/);
    assert.doesNotMatch(g, /half marathon|Spanish/i);
  });

  test('C5 "What shoes should I buy for my race?" — a planning cue with its own topic keeps only what it is about', async () => {
    const o = await person();
    const q = 'What shoes should I buy for my race?';
    assert.match(goalsLine(o, q), /Spanish/, 'without scores no item anchors: everything, as in C7 (stated fallback)');
    const c = cognitive(o, q, injected(o, [RACE]));
    assert.match(c, /Active goals: "run the Larkfield Half Marathon in October"\./);
    assert.doesNotMatch(c, /Spanish|promoted|deploy pipeline|open question/);
  });

  test('C5 controls: a planning question without a topic stays broad; a named pair is kept by its words', async () => {
    const o = await person();
    const broad = goalsLine(o, 'What should I focus on this week?', injected(o, [RACE]));
    for (const re of [/half marathon/i, /Spanish/, /promoted/]) assert.match(broad, re, 'no topic: every goal, even with a meaning match');
    assert.match(goalsLine(o, 'What should I plan for October?'), /Spanish/, 'a month is not a topic');
    const pair = goalsLine(o, 'Should I prioritise Spanish or the half marathon?');
    assert.match(pair, /Spanish/); assert.match(pair, /half marathon/i); assert.doesNotMatch(pair, /promoted/);
  });
});

describe('known limitation, pinned: an item stated without a name has no stored statement', () => {
  // Brain ingest stores no statement for a sentence that names nothing ("My goal is to run a
  // half marathon in October." — measured), so there is nothing for a claim score to attach to.
  test('an unnamed goal ("read twenty books this year") has no statement, so meaning cannot reach it — lexical only', async () => {
    // Its own owner: the Mind keeps a bounded number of active goals, and person() already states three.
    const o = `user:c9-meaning-unnamed-${++n}`;
    await say(o, 'My goal is to read twenty books this year.');
    for (const t of FILLER) await say(o, t);
    const titles = Object.values(peekMind(o).goals).map(g => `${g.status}:${g.title}`);
    assert.ok(titles.some(t => /^active:.*twenty books/.test(t)), `control: the Mind holds the goal — ${JSON.stringify(titles)}`);
    assert.equal(statements(o).some(f => /twenty books/.test(f.statement)), false, 'no evidence-store statement states it');
    // Every stored statement scored high: still nothing attaches to the unnamed goal.
    const everything = new Map(statements(o).map((f, i) => [f.id, i === 0 ? 0.95 : 0.3 + (i % 9) / 100]));
    // A targeted question (no planning cue, no shared word): only meaning could keep it, and meaning has nothing to attach to.
    assert.doesNotMatch(goalsLine(o, 'Which novels are worth finishing?', everything), /twenty books/);
    assert.ok(everything.size >= DENSE_MIN_CORPUS);
  });
});

describe('several goals keep their statements, so meaning can reach each of them', () => {
  // memory/engine.js step 4b (propagation off, the default): a collection fact's value changes
  // when an item is ADDED, and retireSupersededInBackground archives the sentence of the previous
  // source message (brain/index.js retireSupersededStatement) — so "learn Spanish" archives the
  // statement of the half-marathon goal, which is still current.
  // Was a defect found by C9, fixed in memory/engine.js step 4b: a collection now retires
  // only the items it no longer holds (memory/tests/collectionSupersession.test.js).
  test('adding a second goal does not archive the first goal\'s statement', async () => {
    const o = `user:c9-meaning-merge-${++n}`;
    await say(o, 'My goal is to run the Larkfield Half Marathon in October.');
    await say(o, 'My goal is to learn Spanish this year.');
    await new Promise(r => setTimeout(r, 50));
    const s = statements(o).find(f => /Larkfield Half Marathon/.test(f.statement));
    assert.ok(s && !s.archived, `archived: ${s?.archived} (${s?.archivedReason})`);
  });

  test('goals stated one per message are each reachable by meaning', async () => {
    const o = `user:c9-meaning-separate-${++n}`;
    for (const t of ['My goal is to run the Larkfield Half Marathon in October.', 'My goal is to learn Spanish this year.', 'My goal is to get promoted to senior analyst at Brindlewood.']) await say(o, t);
    for (const t of FILLER) await say(o, t);
    assert.match(goalsLine(o, 'How far is a 21 km race?', injected(o, [RACE])), /Larkfield/);
    assert.match(goalsLine(o, 'Is Duolingo worth it?', injected(o, [/learn Spanish/])), /learn Spanish/);
  });
});

describe('false positives: the meaning path does not connect what is not connected', () => {
  test('a look-alike scored high ("race condition") connects nothing to the race goal', async () => {
    const o = await person();
    const c = cognitive(o, 'How do I debug a race condition?', injected(o, [/race condition/]));
    assert.doesNotMatch(c, /half marathon/i);
    assert.doesNotMatch(c, /Active goals/);
  });

  test('"Spanish omelette" scored high keeps no language goal', async () => {
    const o = await person();
    assert.doesNotMatch(cognitive(o, 'What is a good omelette recipe?', injected(o, [/omelette/])), /learn Spanish/);
  });

  test('untrusted signal (margin below the floor) is ignored: lexical only', async () => {
    const o = await person();
    const flat = injected(o, [RACE], { hi: 0.55, lo: 0.47, spread: 0.02 });
    assert.ok(denseAdmission(flat).margin < DENSE_MARGIN_FLOOR, 'control: the margin is below the floor');
    assert.equal(goalsLine(o, 'How far is a 21 km race?', flat), '');
  });

  test('a match below the proposal floor (cosine < 0.55) is ignored even when the margin is wide', async () => {
    const o = await person();
    const low = injected(o, [RACE], { hi: 0.54, lo: 0.2, spread: 0.05 });
    assert.ok(denseAdmission(low).trusted, 'control: trusted');
    assert.equal(goalsLine(o, 'How far is a 21 km race?', low), '');
  });

  test('a small store (< 60 statements) never trusts meaning', async () => {
    const o = await person({ filler: 10 });
    assert.ok(statements(o).length < DENSE_MIN_CORPUS);
    assert.equal(goalsLine(o, 'How far is a 21 km race?', injected(o, [RACE])), '');
  });
});

describe('current versus historical, forgotten and other owners', () => {
  test('meaning never revives a completed goal', async () => {
    const o = await person({ extra: ['I got promoted to senior analyst at Brindlewood!'] });
    assert.ok(Object.values(peekMind(o).goals).some(g => /promoted/.test(g.title) && g.status === 'completed'), 'control: completed');
    assert.doesNotMatch(cognitive(o, "How's my career?", injected(o, [/promoted to senior analyst/])), /Active goals: [^\n]*promoted/);
  });

  test('meaning never revives an abandoned goal', async () => {
    const o = await person({ extra: ['I gave up on the Larkfield Half Marathon.'] });
    const race = Object.values(peekMind(o).goals).find(g => /Larkfield/.test(g.title));
    assert.equal(race?.status, 'abandoned', `control: abandoned (${race?.status})`);
    assert.doesNotMatch(cognitive(o, 'How far is a 21 km race?', injected(o, [RACE])), /Active goals: [^\n]*Larkfield/);
  });

  test('a changed (superseded) goal reached by meaning carries the user\'s later words, never shown as plain current', async () => {
    // The change names the goal and is stated, not planned ("want to" reads as speculative), so the
    // Mind records it (goalTracker changedBy).
    const o = await person({ extra: ['I switched my goal: instead of getting promoted to senior analyst at Brindlewood, I am moving into product management.'] });
    const old = Object.values(peekMind(o).goals).find(g => /promoted to senior analyst/.test(g.title));
    assert.ok(old?.changedBy?.text, `control: the change is recorded on the earlier goal (${JSON.stringify(old && { status: old.status, changedBy: old.changedBy })})`);
    const line = goalsLine(o, "How's my career?", injected(o, [/promoted to senior analyst/]));
    assert.match(line, /"get promoted to senior analyst at Brindlewood"[^;]*since changed — they said: "I switched my goal/, line);
  });

  // KNOWN LIMITATION, pinned (upstream Mind change detection, not C9's selection): a change said
  // in other words ("my career goal has changed … instead of the promotion") is not linked to
  // "get promoted…", so the old goal stays active with no note — and the meaning path, which
  // only decides ABOUT, then shows it as current. Flag-off production shows it unconditionally.
  test('a change said in other words is recorded on the goal it changes', { todo: 'goalTracker links a change only through shared words (no meaning at write time)' }, async () => {
    const o = await person({ extra: ['My career goal has changed: I want to move into product management instead of the promotion.'] });
    const old = Object.values(peekMind(o).goals).find(g => /promoted to senior analyst/.test(g.title));
    assert.ok(old?.changedBy?.text || old?.status !== 'active');
    assert.doesNotMatch(goalsLine(o, "How's my career?", injected(o, [/promoted to senior analyst/])), /"get promoted to senior analyst at Brindlewood"\.?$|"get promoted to senior analyst at Brindlewood";/);
  });

  test('a forgotten (archived) statement no longer carries meaning for the item it stated', async () => {
    const o = await person();
    const id = idOf(o, RACE);
    ES.updateFact(o, id, { archived: true, archivedReason: 'user-forget', archivedAt: Date.now() });
    assert.equal(goalsLine(o, 'How far is a 21 km race?', injected(o, [RACE])), '');
  });

  test('scores for another owner\'s statements attach to nothing here, and the other owner\'s goals never appear', async () => {
    const a = await person();
    const b = `user:c9-meaning-other-${++n}`;
    await say(b, 'My goal is to swim across Lake Varen in August.');
    for (const t of FILLER) await say(b, t);
    const onlyB = injected(b, [/swim across/]);   // ids that are b's, not a's
    const c = cognitive(a, 'How far is a 21 km race?', onlyB);
    assert.doesNotMatch(c, /swim|Lake Varen/);
    assert.doesNotMatch(c, /Active goals/);
  });
});

describe('explanation, defaults and compatibility', () => {
  test('the trace records why each item was kept or dropped; the prompt never carries it', async () => {
    const o = await person();
    const r = retrieve(o, 'How far is a 21 km race?', injected(o, [RACE]));
    assert.equal(r.trace.cognitiveSelection.mode, 'targeted');
    const kept = r.trace.cognitiveSelection.items.filter(i => i.kept);
    assert.deepEqual(kept.map(i => [i.kind, i.by]), [['goal', 'meaning']]);
    assert.equal(kept[0].statementId, idOf(o, RACE));
    assert.equal(kept[0].cosine, 0.8);
    assert.equal(r.trace.meaning.reason, 'trusted');
    assert.doesNotMatch(r.block, /statementId|cosine|meaning/);
  });

  test('AQUA_MIND_RELEVANCE unset (the default): claim scores change nothing at all', async () => {
    const o = await person();
    delete process.env.AQUA_MIND_RELEVANCE;
    for (const q of ['How far is a 21 km race?', 'What shoes should I buy for my race?', 'Where do I work?']) {
      const without = retrieve(o, q);
      const withScores = retrieve(o, q, injected(o, [RACE]));
      assert.equal(withScores.block, without.block, q);
      assert.equal(withScores.trace.meaning, undefined);
      assert.equal(withScores.trace.cognitiveSelection, undefined);
    }
  });

  test('flag on, no scores (no embeddings): exactly the C7 lexical selection', async () => {
    const o = await person();
    assert.match(goalsLine(o, "How's my marathon training?"), /half marathon/i);
    assert.equal(goalsLine(o, 'Where do I work?'), '');
  });
});

describe('the Mind trusts meaning under Lane 6\'s rule, and cannot drift from it', () => {
  test('the constants equal the ones in PIC Lane 6\'s source', async () => {
    const src = fs.readFileSync(new URL('../../pic/retrievalIntelligence.js', import.meta.url), 'utf8');
    const D = await import('../../pic/denseAdmission.js');
    for (const name of ['DENSE_LANE_FLOOR', 'DENSE_LANE_MAX', 'DENSE_MARGIN_FLOOR', 'DENSE_MIN_CORPUS']) {
      const v = Number(src.match(new RegExp(`const ${name} = ([0-9.]+);`))?.[1]);
      assert.equal(D[name], v, name);
    }
  });
  // Lane 6's inline decision (retrievalIntelligence.js), reproduced to check the Mind's copy against it.
  function lane6Before(raw) {
    let trusted = null, margin = null;
    if (raw && raw.size > 0 && raw.size < 60) { /* nothing */ } else if (raw?.size) {
      const sorted = [...raw.values()].sort((a, b) => b - a);
      margin = sorted[0] - sorted[Math.floor(sorted.length / 2)];
      if (margin >= 0.15) trusted = raw;
    }
    return { trusted, margin };
  }
  test('identical decisions on deterministic score maps of every size class', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const size of [0, 1, 20, 59, 60, 61, 200]) for (let k = 0; k < 25; k++) {
      const m = new Map(Array.from({ length: size }, (_, i) => [`f${i}`, 0.3 + rnd() * (k % 2 ? 0.6 : 0.2)]));
      const a = lane6Before(m), b = denseAdmission(m);
      assert.equal(b.trusted, a.trusted, `size ${size} #${k}`);
      assert.equal(b.margin, a.margin, `size ${size} #${k}`);
    }
    assert.equal(denseAdmission(null).trusted, null);
  });
});
