/**
 * Lane 5 — retrieval on a CLAIM ATTRIBUTE rather than on surface words.
 *
 * THE DEFECT, AS MEASURED
 * -----------------------
 * `recall_negation` was the worst metric on `retrieval-core.v1`: 3/10. Read
 * case by case, seven of the ten misses were NOT gate failures — the gate
 * would have admitted the right fact and never saw it. Every lane before this
 * one proposes candidates on one of two bases:
 *
 *   lane 1        a word from the question appears in the statement
 *   lane 2/2b/3   an entity the question NAMES has an `about` edge to it
 *
 * "What did we turn down?" names no entity, and once the negation cue is
 * stripped it has NO content words at all. Nothing in the engine could propose
 * "We rejected the Bangalore relocation", and nothing did. The question's
 * polarity was understood, the store knew which facts were negated, and the
 * two were never connected.
 *
 * These run through `retrieveKnowledge` — the facade the chat spine calls, not
 * a hand-wired inner function (L12).
 *
 * BITE, MEASURED (revert the named change → count failures):
 *   lane 5 candidate generation                → 3 fail
 *   cessation vocabulary in NEGATION_CUE       → 3 fail
 *   currency penalty skipped on negated asks   → 2 fail
 *   lane runs only on negated questions        → 1 fail
 *
 * Every line above was COUNTED by reverting that change and re-running, not
 * asserted. Two further pins were written for a self-anchor-cap exemption,
 * measured at ZERO bite against both this fixture and retrieval-core.v1, and
 * deleted along with the code they were written for. A test whose stated bite
 * is zero is the assertion AQUA_INDEXED_NOT_SCAN.md was written about.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { retrieveKnowledge } from '../retrievalIntelligence.js';
import { statementPolarity } from '../questionShape.js';

// ── A world shaped like the one conversationIngest writes ────────────────────
//
// Deliberately the SAME fixture shape as relevanceGate.test.js. Two worlds
// that drift apart are two engines being tested, and only one of them ships.

const FACTS = {
  work:    { id: 'work',    statement: 'I run product at Nummo.', entities: ['Nummo', 'You'], confidence: 0.6 },
  city:    { id: 'city',    statement: 'I moved to the Bangalore office last month.', entities: ['Bangalore', 'You'], confidence: 0.6 },
  old:     { id: 'old',     statement: 'I used to work at Intercom.', entities: ['Intercom', 'You'], confidence: 0.6, supersededBy: 'work' },
  parser:  { id: 'parser',  statement: 'I no longer own the parser.', entities: ['parser', 'You'], confidence: 0.6 },
  runway:  { id: 'runway',  statement: 'Our runway is fourteen months.', entities: ['You'], confidence: 0.6 },
  seed:    { id: 'seed',    statement: 'We raised a seed round in 2024.', entities: ['You'], confidence: 0.9 },
  priya:   { id: 'priya',   statement: 'Priya is our head of design.', entities: ['Priya', 'You'], confidence: 0.6 },
  reject:  { id: 'reject',  statement: 'We rejected the Bangalore relocation.', entities: ['Bangalore', 'You'], confidence: 0.6 },
  onhold:  { id: 'onhold',  statement: 'The parser rewrite is on hold.', entities: ['parser'], confidence: 0.6 },
  blocked: { id: 'blocked', statement: 'Priya is blocked on the design tokens.', entities: ['Priya'], confidence: 0.6 },
};

const ABOUT = {
  'entity:you':      ['work', 'city', 'old', 'parser', 'runway', 'seed', 'priya', 'reject'],
  'entity:nummo':    ['work'],
  'entity:priya':    ['priya', 'blocked'],
  'entity:intercom': ['old'],
  'entity:parser':   ['parser', 'onhold'],
};

function makeDeps({ facts = FACTS, countScan = null } = {}) {
  const entities = [
    { id: 'entity:you', label: 'You', data: { entityType: 'self' } },
    { id: 'entity:nummo', label: 'Nummo', data: {} },
    { id: 'entity:priya', label: 'Priya', data: {} },
    { id: 'entity:intercom', label: 'Intercom', data: {} },
    { id: 'entity:bangalore', label: 'Bangalore', data: {} },
    { id: 'entity:parser', label: 'parser', data: {} },
  ];
  return {
    evidenceStore: {
      getFact: (_o, id) => facts[id] ?? null,
      evidenceForFact: () => [{ confidence: 0.6, sourceType: 'conversation' }],
      listFacts: (_o, opts) => { countScan?.push(opts); return Object.values(facts); },
    },
    evidenceRetrieval: {
      // The PRODUCTION tokeniser, verbatim from evidenceRetrieval.js.
      retrieveGroundedFacts: (_s, _o, query) => {
        const terms = [...String(query).toLowerCase().matchAll(/[a-z0-9][\w\-.]{1,}/g)]
          .map(m => m[0]).filter(t => t.length > 2);
        return Object.values(facts)
          .filter(f => terms.some(t => `${f.statement} ${f.entities.join(' ')}`.toLowerCase().includes(t)))
          .map(f => ({ fact: f, evidence: [], citations: ['Conversation c1'], confidence: f.confidence, score: 0.5 }));
      },
    },
    graph: {
      nodesByType: () => entities,
      neighbors: (_o, nodeId, { type } = {}) =>
        (type === 'fact' ? (ABOUT[nodeId] ?? []) : []).map(fid => ({ node: { id: `fact:${fid}` } })),
    },
    queryEngine: { timelineAcross: () => ({ ordered: [] }) },
    formatCitation: () => 'Conversation c1',
  };
}

const ask = (q, opts) => retrieveKnowledge(makeDeps(opts), 'user:p', q);
const ids = r => r.items.filter(i => i.kind === 'fact').map(i => i.id);

// ── Candidate generation ─────────────────────────────────────────────────────

describe('lane 5 — the claim-attribute lane', () => {
  test('a question with NO content words at all still reaches the negated claim', () => {
    // "What did we turn down?" — `turn down` is the negation cue and is
    // stripped as grammar; `what`/`did`/`we` are stopwords. Zero terms remain.
    // Every lexical lane is definitionally blind here, and the entity lanes
    // have no name to match. This case cannot be rescued by better scoring:
    // if no lane proposes the fact, no gate can admit it.
    assert.ok(ids(ask('What did we turn down?')).includes('reject'));
  });

  test('a negated question with an unshared vocabulary finds the fact anyway', () => {
    // "decide against" and "rejected" share no word. Lexical overlap is zero
    // in both directions; the only thing connecting them is that both are
    // negative, which is exactly what the lane retrieves on.
    assert.ok(ids(ask('What did we decide against?')).includes('reject'));
  });

  test('the lane does NOT fire on an affirmative question', () => {
    // The honesty property. A lane that proposed negated claims on every turn
    // would be a second dossier — this one keyed on polarity instead of on
    // the word "my". Measured on the 32 silence-expecting queries of
    // retrieval-core.v1: ZERO read as negated, and that is why the lane is
    // safe to add at all.
    const r = ask('What did we ship?');
    assert.equal(r.stats.polarityScanned, 0);
    assert.equal(r.stats.polarityFacts, 0);
  });

  test('nothing arrives via the polarity lane on an affirmative question', () => {
    // Asserting the negated fact is ABSENT would have been the wrong test, and
    // the first version of it failed for the right reason: "We rejected the
    // Bangalore relocation" is a real lexical hit for "Where is the Bangalore
    // office?" — it names Bangalore. The engine demotes it 0.3× for polarity
    // conflict and deliberately does not exclude it, because a demotion is not
    // an exclusion and the statement renders with its negation intact.
    //
    // What must be true is narrower and is the actual property: no item was
    // proposed BECAUSE it was negated.
    for (const q of ['Where is the Bangalore office?', 'What did we ship?', 'Who is our head of design?']) {
      const viaLanes = ask(q).items.filter(i => i.kind === 'fact').map(i => i.via ?? '');
      assert.ok(!viaLanes.some(v => v.startsWith('polarity:')), q);
    }
  });
});

// ── The scan, counted rather than timed ──────────────────────────────────────

describe('lane 5 — cost is reported, not hidden', () => {
  test('the scan is bounded and the bound is passed to the store', () => {
    // AQUA_INDEXED_NOT_SCAN.md's finding: a timing assertion on a fast path
    // reads `0 < 200` and cannot fail. So the instrument is a COUNT. There is
    // no polarity index — building one to serve two facts in sixty would be an
    // index built for a benchmark — so the lane admits it scans and says how
    // far.
    const countScan = [];
    ask('What is paused?', { countScan });
    assert.equal(countScan.length, 1);
    assert.equal(typeof countScan[0].limit, 'number');
  });

  test('polarityScanned counts every fact inspected, not every fact returned', () => {
    const r = ask('What did we turn down?');
    assert.equal(r.stats.polarityScanned, Object.keys(FACTS).length);
    assert.ok(r.stats.polarityFacts < r.stats.polarityScanned);
  });
});

// ── The cessation class ──────────────────────────────────────────────────────

describe('negation vocabulary — a completed class, not a fitted list', () => {
  test('"on hold" is a negated claim', () => {
    // `stopped`, `dropped`, `gave up` and `no more` were already cues. `on
    // hold` is the same predicate in different words; its absence was why
    // "What is paused?" could not reach "The parser rewrite is on hold."
    assert.equal(statementPolarity(FACTS.onhold), 'negated');
  });

  test('"paused" asks for it, across a shared-nothing vocabulary', () => {
    assert.ok(ids(ask('What is paused?')).includes('onhold'));
  });

  test('"blocked" is a STATUS REPORT and stays affirmative', () => {
    // Deliberately excluded. Adding it flips "Priya is blocked on the design
    // tokens" to negated, which puts it in polarity conflict with the
    // affirmative question that asks for it and demotes the one right answer
    // by 0.3×. A cessation word and an obstacle word are not the same word.
    assert.equal(statementPolarity(FACTS.blocked), 'affirmed');
    assert.ok(ids(ask('What is blocking design?')).includes('blocked'));
  });
});

// ── The two interactions the lane exposed ────────────────────────────────────

describe('lane 5 — interactions with gates written for affirmative asks', () => {
  test('a present-tense NEGATED question is not denied its past-tense answer', () => {
    // "What is not my responsibility now?" is present-tense AND negated, and
    // the fact that answers it — "I no longer own the parser" — is BOTH. The
    // current-vs-past penalty (×0.5) applied on top of a score the polarity
    // bonus had lifted to 0.2 landed it at 0.1, under the floor. Under a
    // negation the two signals are one property and charging twice for it
    // drops the only fact that answers the question.
    assert.ok(ids(ask('What is not my responsibility now?')).includes('parser'));
  });

  test('a negated question does NOT promote the owner\'s unrelated past facts', () => {
    // The first version of the fix above granted the past fact the same +0.2
    // an explicit past-tense ask grants. Every past fact the owner has then
    // scored on ANY negated question — "I moved to the Bangalore office", "I
    // used to work at Intercom" — and crowded the real answer out of the cap.
    // Removing a penalty is the correction; adding a reward is a new defect.
    const got = ids(ask('What did we turn down?'));
    assert.ok(!got.includes('city'));
    assert.ok(!got.includes('old'));
  });

  test('a superseded fact is still reachable by a negated question', () => {
    // Pre-existing behaviour, re-pinned here because lane 5 now proposes
    // candidates that lane 3 used to be the only source of, and the
    // supersession conditional sits between them.
    assert.ok(ids(ask('Where do I not work anymore?')).includes('old'));
  });
});
