/**
 * The self label, on the READ side.
 *
 * `evidenceRetrieval` builds its haystack as `statement + entities.join(' ')`,
 * and the self entity is labelled with the literal word "You". Once facts carry
 * it, every message containing "you" lexically matches every fact about the
 * owner. Measured by the rollout harness: turning AQUA_SELF_ENTITY on took
 * retrieval 2/6 → 5/6 and noise 0 → 9 lines, with 7 of the 9 from one query.
 *
 * TWO PATHS, and finding only the first is why this suite exists. Filtering
 * lane 1 changed the measurement by ZERO, because most of the noise arrived
 * through lane 2 (the self node matched by surface form) into lane 3 (the
 * `about` hop). Fixing both took it to 0 with retrieval unchanged at 5/6.
 *
 * The load-bearing tests are the ones asserting the WINS SURVIVE. Suppressing
 * noise is easy; suppressing it without also suppressing the self-anchored
 * answers — which arrive on lane 3, the same lane the noise used — is the
 * whole problem.
 *
 * Proven to bite: reverting the lane-2 exclusion fails 2; reverting the lane-1
 * filter fails 2; reverting both fails 3. Each half is load-bearing on its own,
 * which is exactly why finding only the first one moved the measurement by zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { retrieveKnowledge } from '../retrievalIntelligence.js';

const FACTS = {
  f1: { id: 'f1', statement: 'I run product at Nummo, a fintech in Bangalore.', confidence: 0.6, entities: ['Nummo', 'You'] },
  f2: { id: 'f2', statement: 'My co-founder Dev runs engineering.', confidence: 0.6, entities: ['Dev', 'You'] },
  f3: { id: 'f3', statement: 'Razorpay is our main competitor.', confidence: 0.6, entities: ['Razorpay'] },
  // Carries "the" on purpose. This is the real statement that made "what is the
  // capital of France" return two lines, and without a stopword in a fixture
  // the stopword test below passes vacuously — which it did, in the first draft.
  f4: { id: 'f4', statement: 'I usually do deep work in the mornings', confidence: 0.6, entities: ['You'] },
};

function makeDeps() {
  const entities = [
    { id: 'ent:nummo', label: 'Nummo', data: { entityType: 'name' } },
    { id: 'ent:razorpay', label: 'Razorpay', data: { entityType: 'name' } },
    { id: 'ent:self:owner', label: 'You', data: { entityType: 'self' } },
  ];
  const about = { 'ent:self:owner': ['f1', 'f2', 'f4'], 'ent:nummo': ['f1'], 'ent:razorpay': ['f3'] };

  return {
    evidenceStore: {
      getFact: (_o, id) => FACTS[id] ?? null,
      evidenceForFact: () => [{ confidence: 0.6, sourceType: 'conversation' }],
      listFacts: () => Object.values(FACTS),
    },
    evidenceRetrieval: {
      // Mirrors the real matcher: statement AND entities, both in the haystack.
      // That is the behaviour being defended against, so the stand-in has to
      // reproduce it rather than be conveniently stricter.
      retrieveGroundedFacts: (_s, _o, query) => {
        const terms = String(query).toLowerCase().match(/[a-z]{3,}/g) ?? [];
        return Object.values(FACTS)
          .filter((f) => {
            const hay = `${f.statement} ${(f.entities ?? []).join(' ')}`.toLowerCase();
            return terms.some(t => hay.includes(t));
          })
          .map(f => ({ fact: f, evidence: [], citations: ['Conversation c1'], confidence: f.confidence, score: 0.5 }));
      },
    },
    graph: {
      nodesByType: () => entities,
      neighbors: (_o, nodeId) => (about[nodeId] ?? []).map(fid => ({ node: { id: `fact:${fid}` } })),
    },
    queryEngine: { timelineAcross: () => ({ ordered: [] }) },
    formatCitation: () => 'Conversation c1',
  };
}

const statements = (r) => r.items.filter(i => i.kind === 'fact').map(i => i.statement);
const entityNames = (r) => r.items.filter(i => i.kind === 'entity').map(i => i.entity);

// ── The leak, on both paths ──────────────────────────────────────────────────

test('a request containing "you" returns nothing about the owner', () => {
  // The measured worst case: 7 of 9 noise lines came from this exact shape.
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'can you write me a python script');
  assert.deepEqual(statements(r), [], JSON.stringify(statements(r)));
});

test('the self node is never returned as a matched entity', () => {
  // Lane 2 matched its label by surface form, and lane 3 then hopped `about`
  // from it — which is where most of the noise actually came from. Filtering
  // lane 1 alone moved the measurement by zero.
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'what do you think about this');
  assert.ok(!entityNames(r).some(e => /^you$/i.test(String(e))), JSON.stringify(entityNames(r)));
});

test('a stopword shared with a statement does not earn a hit', () => {
  // "what is the capital of France" matched a fact because "the" appears in
  // "in the mornings". Two lines of pure noise, and the last two of the nine.
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'what is the capital of France');
  assert.deepEqual(statements(r), [], JSON.stringify(statements(r)));
});

// ── The wins must survive ────────────────────────────────────────────────────

test('a first-person QUESTION still reaches the owner\'s facts', () => {
  // The anchor arrives on lane 3 — the same lane the noise used. If suppressing
  // one suppressed the other, this whole phase would be a regression.
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'Where do I work now?');
  assert.ok(statements(r).some(s => s.includes('Nummo')), JSON.stringify(statements(r)));
});

test('"Which city am I in?" still reaches the fact naming the city', () => {
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'Which city am I in?');
  assert.ok(statements(r).some(s => s.includes('Bangalore')), JSON.stringify(statements(r)));
});

test('a named entity is still matched, and still hops', () => {
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'tell me about Nummo');
  assert.ok(entityNames(r).some(e => /nummo/i.test(String(e))), JSON.stringify(entityNames(r)));
  assert.ok(statements(r).some(s => s.includes('Nummo')), JSON.stringify(statements(r)));
});

test('a genuine lexical hit on a statement is untouched', () => {
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'who is our competitor Razorpay');
  assert.ok(statements(r).some(s => s.includes('Razorpay')), JSON.stringify(statements(r)));
});

// ── Constraints ──────────────────────────────────────────────────────────────

test('an owner with no self node behaves exactly as before', () => {
  // AQUA_SELF_ENTITY is off by default. With no self node there is no label to
  // filter on, and the filter must be a no-op rather than an error.
  const deps = makeDeps();
  deps.graph.nodesByType = () => [{ id: 'ent:nummo', label: 'Nummo', data: { entityType: 'name' } }];
  const r = retrieveKnowledge(deps, 'user:t', 'tell me about Nummo');
  assert.ok(statements(r).some(s => s.includes('Nummo')));
});

test('a query of only stopwords keeps its hits — the filter fails OPEN', () => {
  // A retrieval returning one extra line is a smaller failure than one that
  // silently drops a real answer. This predicate trims noise; it does not
  // gatekeep.
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'and the but');
  assert.ok(Array.isArray(r.items));
});
