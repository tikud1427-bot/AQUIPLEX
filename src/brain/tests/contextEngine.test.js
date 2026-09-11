/**
 * Brain V1 / B4 — Context Engine V2.
 *
 * The guarantees under test:
 *   TEN DIMENSIONS  every candidate is scored on all ten brief dimensions,
 *                   each bounded and independently explainable.
 *   ASSEMBLED       selection spreads the budget across what the question is
 *                   about (diversity), instead of dumping the top-N about one
 *                   entity — the brief's "do NOT dump every memory" rule.
 *   BUDGET          the char budget is a real constraint, not a suffix cut.
 *   SUPERSET        the return shape is exactly the PIC contract plus extra
 *                   observability, so the chat seam is untouched.
 *   FAIL-SAFE FLOOR any failure returns the PIC floor — never a worse answer.
 *   OFF BY DEFAULT  AQUA_CONTEXT_V2=on selects V2; otherwise pure passthrough.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-b4-'));
process.env.AQUA_DATA_DIR = TMP;

const { scoreCandidate, rankedDimensions, DIMENSION_WEIGHTS } = await import('../contextEngine/scorer.js');
const { assembleContext } = await import('../contextEngine/assembler.js');
const CE = await import('../contextEngine/index.js');
const Brain = await import('../index.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function bag(over = {}) {
  return {
    queryTokens: new Set(['aqua', 'billing']),
    semanticScores: null,
    activeProjectTokens: new Set(),
    activeGoalTokens: new Set(),
    focusEntityIds: new Set(),
    priorEntityIds: new Set(),
    maxHops: 3,
    ...over,
  };
}

function fact(id, text, over = {}) {
  return { kind: 'fact', id, text, confidence: 0.8, sourceType: 'document', entityIds: [], hops: null, timestamp: Date.now(), semanticId: id, ...over };
}

beforeEach(() => { delete process.env.AQUA_CONTEXT_V2; delete process.env.AQUA_BRAIN; });
afterEach(() => { delete process.env.AQUA_CONTEXT_V2; delete process.env.AQUA_BRAIN; });

// ── TEN DIMENSIONS ───────────────────────────────────────────────────────────

test('TEN DIMENSIONS: every brief dimension is scored, bounded, and present', () => {
  const required = ['importance', 'recency', 'relationship_distance', 'active_project',
    'active_goal', 'confidence', 'source_reliability', 'conversation_continuity',
    'semantic_similarity', 'user_focus'];
  const { dimensions } = scoreCandidate(fact('f1', 'AQUA billing runs nightly'), bag());
  for (const dim of required) {
    assert.ok(dim in dimensions, `missing ${dim}`);
    assert.ok(dimensions[dim] >= 0 && dimensions[dim] <= 1, `${dim} out of range: ${dimensions[dim]}`);
  }
  assert.equal(Object.keys(DIMENSION_WEIGHTS).length, 10, 'exactly ten weighted dimensions');
});

test('weights sum to 1, so a total score is a clean 0..1', () => {
  const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
  const { score } = scoreCandidate(fact('f1', 'AQUA billing'), bag());
  assert.ok(score >= 0 && score <= 1);
});

test('user_focus rewards covering the query terms', () => {
  const onTopic = scoreCandidate(fact('f1', 'AQUA billing service invoice'), bag()).dimensions.user_focus;
  const offTopic = scoreCandidate(fact('f2', 'the weather today is mild'), bag()).dimensions.user_focus;
  assert.ok(onTopic > offTopic, `${onTopic} > ${offTopic}`);
});

test('semantic_similarity uses real vectors when present, lexical fallback when not', () => {
  const withVec = scoreCandidate(fact('f1', 'unrelated words entirely', { semanticId: 'f1' }),
    bag({ semanticScores: new Map([['f1', 0.95]]) })).dimensions.semantic_similarity;
  assert.ok(withVec > 0.9, 'vector score used directly');

  const noVec = scoreCandidate(fact('f2', 'aqua billing overlap', { semanticId: 'f2' }),
    bag({ semanticScores: null })).dimensions.semantic_similarity;
  assert.ok(noVec > 0, 'lexical fallback still contributes with embeddings off');
});

test('relationship_distance decays with hops; unknown gets a neutral floor', () => {
  const d0 = scoreCandidate(fact('f', 'x', { hops: 0 }), bag()).dimensions.relationship_distance;
  const d1 = scoreCandidate(fact('f', 'x', { hops: 1 }), bag()).dimensions.relationship_distance;
  const d2 = scoreCandidate(fact('f', 'x', { hops: 2 }), bag()).dimensions.relationship_distance;
  const dNull = scoreCandidate(fact('f', 'x', { hops: null }), bag()).dimensions.relationship_distance;
  assert.ok(d0 > d1 && d1 > d2, 'monotonic decay');
  assert.equal(d0, 1);
  assert.ok(dNull > 0 && dNull < 1, 'no path → neutral, not zero');
});

test('source_reliability: document > conversation > inferred', () => {
  const doc = scoreCandidate(fact('f', 'x', { sourceType: 'document' }), bag()).dimensions.source_reliability;
  const conv = scoreCandidate(fact('f', 'x', { sourceType: 'conversation' }), bag()).dimensions.source_reliability;
  const inf = scoreCandidate(fact('f', 'x', { sourceType: 'inferred' }), bag()).dimensions.source_reliability;
  assert.ok(doc > conv && conv > inf, `${doc} > ${conv} > ${inf}`);
});

test('active_project and active_goal fire on token touch', () => {
  const proj = scoreCandidate(fact('f', 'the billing migration is on track'),
    bag({ activeProjectTokens: new Set(['billing', 'migration']) })).dimensions.active_project;
  assert.equal(proj, 1);
  const goal = scoreCandidate(fact('f', 'ship the invoicing rewrite'),
    bag({ activeGoalTokens: new Set(['invoicing']) })).dimensions.active_goal;
  assert.equal(goal, 1);
});

test('conversation_continuity fires when an entity was already in play', () => {
  const cont = scoreCandidate(fact('f', 'x', { entityIds: ['ent:a'] }),
    bag({ priorEntityIds: new Set(['ent:a']) })).dimensions.conversation_continuity;
  assert.equal(cont, 1);
  const fresh = scoreCandidate(fact('f', 'x', { entityIds: ['ent:z'] }),
    bag({ priorEntityIds: new Set(['ent:a']) })).dimensions.conversation_continuity;
  assert.equal(fresh, 0);
});

test('scores are explainable — top contributions can be ranked', () => {
  const { dimensions } = scoreCandidate(fact('f1', 'AQUA billing invoice', { semanticId: 'f1' }),
    bag({ semanticScores: new Map([['f1', 0.9]]) }));
  const ranked = rankedDimensions(dimensions);
  assert.equal(ranked.length, 10);
  assert.ok(ranked[0].contribution >= ranked[9].contribution, 'sorted by contribution');
  assert.ok('weight' in ranked[0] && 'dim' in ranked[0]);
});

// ── ASSEMBLED, NOT DUMPED ────────────────────────────────────────────────────

test('ASSEMBLED: diversity stops one entity from starving the question', () => {
  // Five strong facts about entity A, one about entity B. A naive top-N would
  // take all five A-facts. The assembler should make room for B.
  const candidates = [
    fact('a1', 'aqua billing detail one', { entityIds: ['ent:a'], confidence: 0.9 }),
    fact('a2', 'aqua billing detail two', { entityIds: ['ent:a'], confidence: 0.9 }),
    fact('a3', 'aqua billing detail three', { entityIds: ['ent:a'], confidence: 0.9 }),
    fact('a4', 'aqua billing detail four', { entityIds: ['ent:a'], confidence: 0.9 }),
    fact('a5', 'aqua billing detail five', { entityIds: ['ent:a'], confidence: 0.9 }),
    fact('b1', 'aqua billing sibling topic', { entityIds: ['ent:b'], confidence: 0.7 }),
  ];
  const out = assembleContext(candidates, bag(), { limit: 4, perEntitySoftCap: 2, diversityPenalty: 0.4 });
  const entities = out.items.filter(i => i.kind === 'fact').map(i => i.id);
  const aCount = entities.filter(id => id.startsWith('a')).length;
  assert.ok(entities.includes('b1'), 'the second entity earns a slot');
  assert.ok(aCount <= 3, `entity A capped by diversity (${aCount} selected)`);
});

test('BUDGET: a tight char budget selects fewer, not a truncated dump', () => {
  const candidates = Array.from({ length: 10 }, (_, i) =>
    fact(`f${i}`, `aqua billing fact number ${i} with enough words to cost budget`, { confidence: 0.8, entityIds: [`ent:${i}`] }));
  const tight = assembleContext(candidates, bag(), { limit: 10, charBudget: 200 });
  const loose = assembleContext(candidates, bag(), { limit: 10, charBudget: 2000 });
  assert.ok(tight.items.length < loose.items.length, 'tight budget selects fewer items');
  assert.ok(tight.block.length <= 200 + 80, 'block respects budget (+header slack)');
  assert.ok(tight.stats.contextEngine.dropReasons.budget > 0 || tight.stats.contextEngine.selected < candidates.length);
});

test('THRESHOLD: items below the floor are left out entirely', () => {
  const candidates = [
    fact('good', 'aqua billing strong match', { confidence: 0.9 }),
    fact('junk', 'completely unrelated trivia about penguins', { confidence: 0.1, sourceType: 'inferred', timestamp: 0 }),
  ];
  const out = assembleContext(candidates, bag(), { limit: 8, minScore: 0.2 });
  const ids = out.items.map(i => i.id);
  assert.ok(ids.includes('good'));
  assert.ok(!ids.includes('junk'), 'weak item excluded, not just ranked last');
});

test('an empty candidate set yields an empty, safe assembly', () => {
  const out = assembleContext([], bag(), {});
  assert.deepEqual(out.items, []);
  assert.equal(out.block, '');
});

// ── SUPERSET SHAPE ───────────────────────────────────────────────────────────

test('SUPERSET: returns the PIC contract plus contextEngine observability', () => {
  const out = assembleContext([fact('f1', 'aqua billing', { confidence: 0.9 })], bag(), {});
  for (const k of ['items', 'block', 'stats']) assert.ok(k in out, `missing ${k}`);
  for (const k of ['facts', 'entities', 'timelineEvents', 'connectedFacts', 'reusedSignals', 'durationMs']) {
    assert.ok(k in out.stats, `PIC stat ${k} missing`);
  }
  const ce = out.stats.contextEngine;
  assert.equal(ce.version, 2);
  assert.ok('candidates' in ce && 'selected' in ce && 'dropReasons' in ce);
  // Items keep the PIC fact shape.
  const it = out.items[0];
  assert.equal(it.kind, 'fact');
  assert.ok('statement' in it && 'citations' in it && 'score' in it && 'dimensions' in it);
});

// ── ORCHESTRATOR: FLOOR + SWITCHES ───────────────────────────────────────────

test('OFF BY DEFAULT: without the switch, the PIC floor passes straight through', () => {
  const floor = { items: [{ kind: 'fact', id: 'x', statement: 'floor fact', confidence: 0.9, citations: [] }], block: 'FLOOR', stats: { facts: 1 } };
  const deps = { picRetrieve: () => floor, graph: stubGraph(), evidenceStore: null, peekMind: () => null };
  const out = CE.assembleTurnContext(deps, 'o', 'aqua billing', {});
  assert.equal(out.block, 'FLOOR', 'passthrough — V2 not engaged');
  assert.equal(CE.contextV2Enabled(), false);
});

test('FAIL-SAFE FLOOR: a broken graph returns the PIC floor, never worse', () => {
  process.env.AQUA_CONTEXT_V2 = 'on';
  const floor = { items: [{ kind: 'fact', id: 'x', statement: 'floor fact', confidence: 0.9, citations: [] }], block: 'FLOOR', stats: { facts: 1 } };
  const brokenDeps = {
    picRetrieve: () => floor,
    graph: { nodesByType: () => { throw new Error('boom'); } },
    evidenceStore: null, peekMind: () => null,
  };
  const out = CE.assembleTurnContext(brokenDeps, 'o', 'aqua billing', {});
  assert.equal(out.block, 'FLOOR', 'fell back to the floor on failure');
});

test('the read-side kill switch disables V2 assembly', () => {
  process.env.AQUA_CONTEXT_V2 = 'on';
  process.env.AQUA_BRAIN = 'off';
  assert.equal(CE.contextV2Enabled(), false);
});

test('V3 widens the PIC candidate pool but preserves the requested output limit', () => {
  process.env.AQUA_BRAIN = 'on';
  process.env.AQUA_CONTEXT_V2 = 'on';
  process.env.AQUA_RETRIEVAL_V3 = 'on';

  let requestedLimit = null;
  const floorItems = Array.from({ length: 40 }, (_, i) => ({
    kind: 'fact',
    id: `f${i}`,
    statement: `aqua billing fact ${i}`,
    confidence: 0.8,
    citations: [],
    via: i < 20 ? 'lexical' : `dense: 0.${90 - i}`,
  }));
  const deps = {
    picRetrieve: (_owner, _query, opts) => {
      requestedLimit = opts.limit;
      return { items: floorItems.slice(0, opts.limit), block: 'FLOOR', stats: { facts: opts.limit } };
    },
    graph: stubGraph(),
    evidenceStore: null,
    peekMind: () => null,
  };

  const out = CE.assembleTurnContext(deps, 'o', 'aqua billing', { limit: 8 });

  assert.equal(requestedLimit, 32, 'V3 asks the floor for a candidate pool, not only the final 8');
  assert.ok(out.items.length <= 8, `V3 output must remain bounded by requested limit: ${out.items.length}`);
});

test('V2 never regresses below the floor when it would select nothing', () => {
  process.env.AQUA_CONTEXT_V2 = 'on';
  // Floor has an item, but the graph is empty and the floor item scores below
  // threshold — V2 must still not return fewer items than the floor had.
  const floor = { items: [{ kind: 'fact', id: 'x', statement: 'zzz', confidence: 0.05, citations: [] }], block: 'FLOOR', stats: { facts: 1 } };
  const deps = { picRetrieve: () => floor, graph: stubGraph(), evidenceStore: null, peekMind: () => null };
  const out = CE.assembleTurnContext(deps, 'o', 'nomatch', { limit: 8 });
  assert.ok(out.items.length >= 1, 'floor preserved rather than an empty assembly');
});

test('facade: assembleContext is guarded and honours the switch', () => {
  const floor = { items: [], block: '', stats: {} };
  const out = Brain.assembleContext('o', 'q', () => floor, { deps: { graph: stubGraph(), evidenceStore: null, peekMind: () => null } });
  assert.ok('items' in out && 'block' in out && 'stats' in out);
});

// ── stubs ────────────────────────────────────────────────────────────────────

function stubGraph() {
  return {
    nodesByType: () => [],
    neighbors: () => [],
    edgesOf: () => [],
    getNode: () => null,
  };
}

// ── Graph reach must not undo the floor's relevance gate ─────────────────────
//
// The Context Engine's step (b) hopped every `about` edge from every focus
// entity and admitted whatever it found. That is the SAME defect the PIC
// relevance gate closes, reimplemented one layer up — and because CE sits
// ABOVE the floor, it silently undid it.
//
// Measured on the 32 silence-expecting queries of `retrieval-core.v1`:
//
//     PIC floor            16 noise lines
//     after Context Engine 23 noise lines     ← CE put 7 back
//
// And on the 168 answerable queries the ungated lane was not merely noisy, it
// was NET HARMFUL: recall fell 122 → 119, because the flood of irrelevant
// hopped facts crowded real answers out of the eight-item budget. It added
// zero answers of its own.
//
// BITE, MEASURED (revert the named change → count failures):
//   second-person pronouns excluded from self match  → 2 fail
//   relevance gate on CE graph reach                 → 2 fail

/** A world where the owner has many facts and only one answers the question. */
function reachWorld() {
  const facts = {
    f1: { id: 'f1', statement: 'I run product at Nummo.', entities: ['Nummo', 'You'], confidence: 0.6 },
    f2: { id: 'f2', statement: 'Our runway is fourteen months.', entities: ['You'], confidence: 0.9 },
    f3: { id: 'f3', statement: 'We raised a seed round in 2024.', entities: ['You'], confidence: 0.9 },
    f4: { id: 'f4', statement: 'I prefer TypeScript over Go.', entities: ['You'], confidence: 0.9 },
  };
  return {
    graph: {
      nodesByType: () => [{ id: 'entity:you', label: 'You', data: { entityType: 'self' } }],
      neighbors: (_o, id, { type } = {}) => (type === 'fact' && id === 'entity:you'
        ? Object.keys(facts).map(f => ({ node: { id: `fact:${f}` } })) : []),
    },
    evidenceStore: {
      getFact: (_o, id) => facts[id] ?? null,
      evidenceForFact: () => [{ confidence: 0.6, sourceType: 'conversation' }],
    },
    peekMind: () => null,
    formatCitation: () => 'Conversation c1',
  };
}

test('REACH GATE: "you" addresses AQUA and does not hop the USER\'s facts', () => {
  // "Can you run your tests?" is a question about the ASSISTANT. The user's
  // self entity is labelled "You" — from AQUA's point of view, writing about
  // the user — so a literal token match read "you" as naming the user and
  // hopped their entire fact set into the prompt. The PIC floor correctly
  // returned nothing for this; only this lane put facts back.
  process.env.AQUA_BRAIN = 'on';
  process.env.AQUA_CONTEXT_V2 = 'on';
  const w = reachWorld();
  const deps = { picRetrieve: () => ({ items: [], block: '', stats: {} }), ...w };
  // "Are you able to open your settings?" — a real query from the dataset, and
  // one with no lexical collision against the fixture, so anything that comes
  // back arrived purely because "you" was read as naming the user.
  const out = CE.assembleTurnContext(deps, 'o', 'Are you able to open your settings?', { limit: 8 });
  assert.equal(out.items.filter(i => i.kind === 'fact').length, 0,
    'the assistant was asked about itself and the user\'s dossier came back');
});

test('REACH GATE: an irrelevant owner fact is not hopped into the prompt', () => {
  // Reach is not licence. A fact reached through the graph still has to be
  // about the question — the same test the floor applies, using the same
  // scorer so the two cannot drift apart.
  process.env.AQUA_BRAIN = 'on';
  process.env.AQUA_CONTEXT_V2 = 'on';
  const w = reachWorld();
  const deps = { picRetrieve: () => ({ items: [], block: '', stats: {} }), ...w };
  const out = CE.assembleTurnContext(deps, 'o', 'Where do I work?', { limit: 8 });
  const got = out.items.filter(i => i.kind === 'fact').map(i => i.id);
  assert.ok(got.includes('f1'), `the answer was gated out: ${JSON.stringify(got)}`);
  assert.ok(!got.includes('f4'), `an unrelated preference was hopped in: ${JSON.stringify(got)}`);
});

test('REACH GATE: what the floor already admitted is never re-judged here', () => {
  // The assembler selects from the pool; it does not re-litigate the floor.
  // Gating floor items here would mean two gates disagreeing about the same
  // fact, and the floor's is the one with the eval behind it.
  process.env.AQUA_BRAIN = 'on';
  process.env.AQUA_CONTEXT_V2 = 'on';
  const w = reachWorld();
  const floor = { items: [{ kind: 'fact', id: 'f4', statement: 'I prefer TypeScript over Go.', confidence: 0.9, citations: [] }], block: 'F', stats: { facts: 1 } };
  const deps = { picRetrieve: () => floor, ...w };
  const out = CE.assembleTurnContext(deps, 'o', 'Where do I work?', { limit: 8 });
  assert.ok(out.items.some(i => i.id === 'f4'), 'a floor item was dropped by the reach gate');
});

test('REACH GATE: gated facts are counted, not silently discarded', () => {
  // L13. A gate that drops without counting is indistinguishable from a lane
  // that never ran.
  process.env.AQUA_BRAIN = 'on';
  process.env.AQUA_CONTEXT_V2 = 'on';
  const before = CE.contextEngineMetrics().reachGated;
  const w = reachWorld();
  const deps = { picRetrieve: () => ({ items: [], block: '', stats: {} }), ...w };
  CE.assembleTurnContext(deps, 'o', 'Where do I work?', { limit: 8 });
  assert.ok(CE.contextEngineMetrics().reachGated > before, 'reachGated never moved');
});
