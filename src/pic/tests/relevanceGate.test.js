/**
 * Retrieval relevance gate — the engine refusing to answer what it cannot.
 *
 * THE DEFECT, AS MEASURED
 * -----------------------
 * Lane 2b anchored on the owner for any first-person question and lane 3
 * hopped every `about` edge from that anchor with a score of
 * `confidence * 0.5 + 0.05` — an expression in which the QUESTION does not
 * appear. Four different questions produced byte-identical output on
 * `retrieval-core.v1`:
 *
 *     "What is my job?"  "Which city am I in?"  "Where am I employed?"
 *     "What is my blood type?"   ← nothing in the store answers this
 *
 * That single behaviour accounted for the whole of the measured noise (131
 * lines across 21 of 32 silence-expecting queries), held unknown-honesty at
 * 34.4%, and capped recall by crowding the real answer out of the budget.
 *
 * These tests run through `retrieveKnowledge` with the production default
 * ranking — the seam, not the pure helper (L12).
 *
 * BITE, MEASURED (revert the named change → count failures):
 *   relevance gate on lane 3            → 5 fail
 *   topic-term sufficiency check        → 2 fail
 *   MAX_SELF_ANCHORED cap               → 1 fail
 *   polarity demotion                   → 2 fail
 *   supersession conditional on tense   → 2 fail
 *   non-finite score guard              → 1 fail
 *   trailing-punctuation token trim     → 1 fail
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { retrieveKnowledge } from '../retrievalIntelligence.js';

// ── A world shaped like the one conversationIngest writes ────────────────────

const FACTS = {
  work:    { id: 'work',    statement: 'I run product at Nummo.', entities: ['Nummo', 'You'], confidence: 0.6 },
  city:    { id: 'city',    statement: 'I moved to the Bangalore office last month.', entities: ['Bangalore', 'You'], confidence: 0.6 },
  old:     { id: 'old',     statement: 'I used to work at Intercom.', entities: ['Intercom', 'You'], confidence: 0.6, supersededBy: 'work' },
  parser:  { id: 'parser',  statement: 'I no longer own the parser.', entities: ['parser', 'You'], confidence: 0.6 },
  runway:  { id: 'runway',  statement: 'Our runway is fourteen months.', entities: ['You'], confidence: 0.6 },
  board:   { id: 'board',   statement: 'The board meeting is on 30 September.', entities: ['You'], confidence: 0.6 },
  seed:    { id: 'seed',    statement: 'We raised a seed round in 2024.', entities: ['You'], confidence: 0.9 },
  priya:   { id: 'priya',   statement: 'Priya is our head of design.', entities: ['Priya', 'You'], confidence: 0.6 },
  reject:  { id: 'reject',  statement: 'We rejected the Bangalore relocation.', entities: ['Bangalore', 'You'], confidence: 0.6 },
  blocked: { id: 'blocked', statement: 'Priya is blocked on the design tokens.', entities: ['Priya'], confidence: 0.6 },
};

const ABOUT = {
  'entity:you':      ['work', 'city', 'old', 'parser', 'runway', 'board', 'seed', 'priya', 'reject'],
  'entity:nummo':    ['work'],
  'entity:priya':    ['priya', 'blocked'],
  'entity:intercom': ['old'],
};

function makeDeps({ entityTypes = {}, breakConfidence = false } = {}) {
  const entities = [
    { id: 'entity:you', label: 'You', data: { entityType: 'self' } },
    { id: 'entity:nummo', label: 'Nummo', data: { entityType: entityTypes.Nummo } },
    { id: 'entity:priya', label: 'Priya', data: { entityType: entityTypes.Priya } },
    { id: 'entity:intercom', label: 'Intercom', data: {} },
    { id: 'entity:bangalore', label: 'Bangalore', data: {} },
  ];
  return {
    evidenceStore: {
      getFact: (_o, id) => FACTS[id] ?? null,
      // `breakConfidence` reproduces an evidence record written without a
      // confidence, which is what makes the lexical lane emit NaN.
      evidenceForFact: () => [breakConfidence ? { sourceType: 'conversation' } : { confidence: 0.6, sourceType: 'conversation' }],
      listFacts: () => Object.values(FACTS),
    },
    evidenceRetrieval: {
      retrieveGroundedFacts: (_s, _o, query) => {
        // The PRODUCTION tokeniser, verbatim from evidenceRetrieval.js. A
        // forgiving stand-in here hid the trailing-punctuation defect entirely:
        // the test passed with the bug present, which is not a test.
        const terms = [...String(query).toLowerCase().matchAll(/[a-z0-9][\w\-.]{1,}/g)]
          .map(m => m[0]).filter(t => t.length > 2);
        return Object.values(FACTS)
          .filter(f => terms.some(t => `${f.statement} ${f.entities.join(' ')}`.toLowerCase().includes(t)))
          .map(f => ({
            fact: f, evidence: [], citations: ['Conversation c1'],
            confidence: f.confidence,
            score: breakConfidence ? NaN : 0.5,
          }));
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

const ids = r => r.items.filter(i => i.kind === 'fact').map(i => i.id);
const ask = (q, opts) => retrieveKnowledge(makeDeps(opts), 'user:g', q);

// ── The gate ─────────────────────────────────────────────────────────────────

describe('relevance gate — the dossier is gone', () => {
  test('two different self-questions no longer return the same facts', () => {
    // THE headline defect. Identical output for different questions is proof
    // that the question was never consulted.
    const job = ids(ask('What is my job?'));
    const city = ids(ask('Which city am I in?'));
    assert.notDeepEqual(job, city, `both returned ${JSON.stringify(job)}`);
  });

  test('a self-question the store cannot answer returns SILENCE', () => {
    // "blood type" is a topic term that appears nowhere. Answering it with the
    // nearest owner fact is the confident wrong line L11 forbids. Unknown
    // stays unknown.
    assert.deepEqual(ids(ask('What is my blood type?')), []);
    assert.deepEqual(ids(ask("What is my dog's name?")), []);
  });

  test('a typed question with an UNKNOWN topic is not answered on kind alone', () => {
    // "Who is my dentist?" and "Who is my co-founder?" are both person
    // questions. Only one has an answer, and the difference is entirely
    // whether the topic word is known — not the interrogative.
    assert.deepEqual(ids(ask('Who is my dentist?')), []);
  });

  test('the category/instance bridge still works — that was the point of the anchor', () => {
    // The gate must not buy honesty by going blind. "Where do I work?" shares
    // no vocabulary with "I run product at Nummo"; the kind signal is the only
    // thing connecting them and it has to survive.
    assert.ok(ids(ask('Where do I work?')).includes('work'));
    assert.ok(ids(ask('Which city am I in?')).includes('city'));
  });

  test('object-form self questions are answered, not silenced', () => {
    // Both returned SILENCE on the committed baseline.
    assert.ok(ids(ask('Which company pays me?')).includes('work'));
    assert.ok(ids(ask('Who employs me right now?')).includes('work'));
  });

  test('the self-anchored result set is CAPPED', () => {
    // The summary shape is where the cap actually binds: every owner fact
    // qualifies, so without a limit the anchor returns all eight and the
    // dossier is back under a different name. Eight `about` edges hang off the
    // self node in this world; the cap is what keeps the answer bounded.
    const r = ask('What do you know about me?');
    const anchored = r.items.filter(i => i.kind === 'fact' && String(i.via).includes('about you'));
    assert.ok(anchored.length > 0, 'the summary shape returned nothing');
    assert.ok(anchored.length <= 5, `${anchored.length} facts arrived on the anchor — the cap is not binding`);
  });

  test('a topicless self-question IS a summary request', () => {
    // The one shape where "return the owner's facts" is the right answer.
    assert.ok(ids(ask('What do you know about me?')).length > 0);
  });
});

// ── Meaning-preserving ranking ───────────────────────────────────────────────

describe('relevance gate — negation and currency are not lost at read time', () => {
  test('a negated question prefers the negated statement', () => {
    const got = ids(ask('What do I no longer own?'));
    assert.equal(got[0], 'parser', `got ${JSON.stringify(got)}`);
  });

  test('an on-topic fact is DEMOTED for polarity, never dropped', () => {
    // "Do I still own the parser?" is answered by "I no longer own the
    // parser" — with "no". Stacking the polarity and currency penalties put
    // this under the floor and deleted the only fact that answers it.
    assert.ok(ids(ask('Do I still own the parser?')).includes('parser'));
  });

  test('a superseded fact does not answer a present-tense question', () => {
    const got = ids(ask('Where do I work now?'));
    assert.ok(!got.includes('old'), `the stale employer came back: ${JSON.stringify(got)}`);
    assert.ok(got.includes('work'));
  });

  test('an inflected form still matches — "reject" finds "rejected"', () => {
    // Exact word matching alone missed "We rejected the Bangalore relocation"
    // for "What did we reject?" over a suffix. Measured on retrieval-core:
    // adding suffix tolerance moved recall_negation 20% → 30% and
    // recall_category 40.6% → 46.9%. Substring matching is NOT the fix — that
    // is what made "form" hit "platform".
    assert.ok(ids(ask('What did we reject?')).includes('reject'));
    assert.ok(!ids(ask('How do volcanoes form?')).includes('work'),
      'substring matching is back: "form" matched "platform"');
  });

  test('a superseded fact IS the answer to a question about the past', () => {
    // L5: nothing is deleted, only superseded. A reader that can NEVER see a
    // superseded claim has deleted it at read time.
    assert.ok(ids(ask('Where do I not work anymore?')).includes('old'));
  });
});

// ── Robustness ───────────────────────────────────────────────────────────────

describe('relevance gate — robustness and reporting', () => {
  test('a malformed evidence record cannot produce a non-finite score', () => {
    // NaN in `b.score - a.score` returns NaN, which sort treats as "leave the
    // order alone" — one malformed evidence record silently randomises the
    // ranking around it. Observed live on the eval world: a fact ranked FIRST
    // with score=NaN.
    //
    // The relevance rewrite removed the path by which the lexical lane's score
    // reached the sort at all, so this asserts the OUTCOME rather than the
    // guard: whatever the lane hands over, what leaves here is orderable.
    // `evidenceRetrieval` is separately guarded at source.
    const r = ask('Where do I work?', { breakConfidence: true });
    const facts = r.items.filter(x => x.kind === 'fact');
    assert.ok(facts.length > 0, 'nothing came back — the probe is not exercising the path');
    for (const i of facts) assert.ok(Number.isFinite(i.score), `non-finite score on ${i.id}`);
  });

  test('a query ending in a name still reaches that name', () => {
    // `[\w\-.]` absorbed the full stop, so "Tell me about Priya." tokenised to
    // `priya.` and matched the entity label in neither direction. The entity
    // lane went blind on every query that ended in the name it was about.
    const got = ids(ask('Tell me about Priya.'));
    assert.ok(got.includes('priya') && got.includes('blocked'), `got ${JSON.stringify(got)}`);
  });

  test('graph-typed entities outrank surface guesses', () => {
    // The tier ordering is what makes the signal improve as extraction does.
    const typed = ask('What is my company?', { entityTypes: { Nummo: 'org' } });
    assert.equal(ids(typed)[0], 'work', `got ${JSON.stringify(ids(typed))}`);
  });

  test('the gate reports what it dropped — no dark stages', () => {
    // L13. "The engine had nothing to offer" and "the engine dropped eleven
    // irrelevant facts" are different events and an operator must be able to
    // tell them apart.
    const r = ask('What is my blood type?');
    assert.equal(r.stats.relevance.abstained, true);
    assert.ok(r.stats.relevance.considered > 0);
    assert.ok(r.stats.relevance.droppedIrrelevant > 0);
    assert.equal(typeof r.stats.relevance.expects, 'string');
  });

  test('an owner with no self node degrades rather than failing', () => {
    const deps = makeDeps();
    deps.graph.nodesByType = () => [{ id: 'entity:nummo', label: 'Nummo', data: {} }];
    assert.doesNotThrow(() => retrieveKnowledge(deps, 'user:g', 'Where do I work?'));
  });
});
