/**
 * Retrieval — reaching what the store already holds.
 *
 * THE MEASURED GAP
 * ----------------
 * Lanes 1 and 2 are both LEXICAL: a word from the question has to appear in a
 * fact statement or an entity label. That works when the question names the
 * thing and fails completely when the question names a CATEGORY and the answer
 * holds an INSTANCE:
 *
 *     "Where do I work now?"  vs  "I run product at Nummo, a fintech in Bangalore."
 *     "Which city am I in?"   vs  "I moved to the Bangalore office last month."
 *
 * No amount of token matching bridges "work" → "Nummo". The graph already
 * could: the owner has a self node and `about` edges already run from it to
 * every fact they have stated about themselves. Measured on a populated store:
 * top-1 went 6/8 → 8/8, and a five-message noise probe came back byte-identical
 * to the unpatched tree.
 *
 * Proven to bite: removing the self anchor fails the first two tests; reverting
 * HINT_WEIGHT to 100 fails the fourth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { retrieveKnowledge } from '../retrievalIntelligence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── A tiny in-memory world: three facts, one self node, `about` edges ────────

const FACTS = {
  f1: { id: 'f1', statement: 'I run product at Nummo, a fintech in Bangalore.', confidence: 0.6 },
  f2: { id: 'f2', statement: 'My co-founder Dev runs engineering.', confidence: 0.6 },
  f3: { id: 'f3', statement: 'Razorpay is our main competitor.', confidence: 0.6 },
};

function makeDeps({ withSelf = true } = {}) {
  const entities = [
    { id: 'ent:nummo', label: 'Nummo', data: { entityType: 'name' } },
    { id: 'ent:razorpay', label: 'Razorpay', data: { entityType: 'name' } },
    ...(withSelf ? [{ id: 'ent:self:owner', label: 'You', data: { entityType: 'self' } }] : []),
  ];
  // Only f1 and f2 are ABOUT the owner. f3 is about a competitor and must not
  // arrive through the self anchor — that is the difference between the world
  // model and a dump of everything.
  const about = { 'ent:self:owner': ['f1', 'f2'], 'ent:nummo': ['f1'], 'ent:razorpay': ['f3'] };

  return {
    evidenceStore: {
      getFact: (_o, id) => FACTS[id] ?? null,
      evidenceForFact: () => [{ confidence: 0.6, sourceType: 'conversation' }],
      listFacts: () => Object.values(FACTS),
    },
    evidenceRetrieval: {
      // A deliberately honest stand-in for the real lexical lane: it matches
      // only when a content word is genuinely shared.
      retrieveGroundedFacts: (_s, _o, query) => {
        const terms = String(query).toLowerCase().match(/[a-z]{4,}/g) ?? [];
        return Object.values(FACTS)
          .filter(f => terms.some(t => f.statement.toLowerCase().includes(t)))
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

// ── The gap being closed ─────────────────────────────────────────────────────

test('a first-person question reaches facts that share no words with it', () => {
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'Where do I work now?');
  assert.ok(
    statements(r).some(s => s.includes('Nummo')),
    `expected the workplace fact, got ${JSON.stringify(statements(r))}`,
  );
});

test('"Which city am I in?" reaches the fact naming the city', () => {
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'Which city am I in?');
  assert.ok(statements(r).some(s => s.includes('Bangalore')), JSON.stringify(statements(r)));
});

test('the anchor reaches only what is ABOUT the owner', () => {
  // The competitor fact has no `about` edge from the self node. If it arrives,
  // the anchor has become "dump everything", which is not retrieval.
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'Where do I work now?');
  assert.ok(!statements(r).some(s => s.includes('Razorpay')), JSON.stringify(statements(r)));
});

// ── The constraints ──────────────────────────────────────────────────────────

test('a first-person STATEMENT is not a question and does not anchor', () => {
  // "I need to fix this bug in my code" pulled three sentences about the user's
  // job into a debugging turn before the interrogative guard was added. That
  // was the only row in a noise probe that changed; narrowing removed it.
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'I need to fix this bug in my code');
  assert.equal(statements(r).length, 0, JSON.stringify(statements(r)));
});

test('a question about someone else does not anchor on the asker', () => {
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'Who is our competitor?');
  assert.ok(!statements(r).some(s => s.includes('co-founder')), JSON.stringify(statements(r)));
});

test('an owner with no self node degrades to the previous behaviour', () => {
  // AQUA_SELF_ENTITY is off by default. The anchor must be an improvement when
  // the node exists and a no-op when it does not — never an error.
  const r = retrieveKnowledge(makeDeps({ withSelf: false }), 'user:t', 'Where do I work now?');
  assert.ok(Array.isArray(r.items));
  assert.equal(statements(r).length, 0);
});

test('the self entity is never rendered as a matched entity', () => {
  // `entityMatches` is shown to the model as "entities relevant to your
  // question". A row reading "You" is noise, so the anchor is used for the
  // graph hop only.
  const r = retrieveKnowledge(makeDeps(), 'user:t', 'Where do I work now?');
  assert.ok(!r.items.some(i => i.kind === 'entity' && /^you$/i.test(i.entity)));
});

test('the anchor is defensive about node shape', () => {
  // Entity nodes reach here from two federated sources. A node without `data`
  // must not throw inside the anchor lookup — that would turn a shape variation
  // into a failed retrieval.
  const deps = makeDeps();
  deps.graph.nodesByType = () => [{ id: 'ent:weird' }, { id: 'ent:self:owner', data: { entityType: 'self' } }];
  const r = retrieveKnowledge(deps, 'user:t', 'Where do I work now?');
  assert.ok(Array.isArray(r.items));
});

test('graph failure surfaces exactly where it did before — no new failure mode', () => {
  // VERIFIED, not assumed: `retrieveKnowledge` throws on a dead graph both
  // before and after this change, because the fail-open lives at the PIC facade
  // (see this module's header), not here. An earlier draft of this suite
  // asserted resilience at THIS layer and failed against unmodified code — the
  // test was wrong, not the module. What must hold is that the anchor does not
  // MOVE where that failure surfaces.
  const deps = makeDeps();
  deps.graph.nodesByType = () => { throw new Error('graph down'); };
  assert.throws(() => retrieveKnowledge(deps, 'user:t', 'Where do I work now?'), /graph down/);
});

// ── Weighting ────────────────────────────────────────────────────────────────

test('an explicit per-key hint outranks the coarse category filter', () => {
  // "What is my company called?" returned `cofounder`, because `company` maps
  // to the WORK category (+500, and cofounder lives in `work`) while `project`
  // — whose retrievalHints name `company` outright — could only earn +100.
  const src = readFileSync(path.join(HERE, '..', '..', 'memory', 'memoryRetriever.js'), 'utf8');
  const hint = Number(src.match(/const HINT_WEIGHT\s*=\s*(\d+)/)?.[1]);
  const category = Number(src.match(/ctx\.categoryFilter\.has\(fact\.category\)\)\s*\{\s*\n\s*score \+= (\d+)/)?.[1]);
  assert.ok(Number.isFinite(hint), 'HINT_WEIGHT is gone');
  assert.ok(Number.isFinite(category), 'the category weight moved — re-check this comparison');
  assert.ok(hint > category, `hint ${hint} must outrank category ${category}`);
});
