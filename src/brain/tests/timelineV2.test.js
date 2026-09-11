/**
 * Brain V1 / B7 — Timeline V2.
 *
 * The guarantees under test:
 *   CHAINS        events about one subject advancing through the lifecycle are
 *                 recognised as ONE arc (idea → build → ship → outcome), not
 *                 isolated entries.
 *   SHARED SUBJECT two things progressing in parallel are two chains, not one.
 *   NO REGRESSION  stages never go backwards; events that break the
 *                 progression are REPORTED as off-sequence, never reordered
 *                 or silently dropped to force a tidy story.
 *   NOT CAUSATION  a chain is temporal + stage-ordered evidence; confidence
 *                 reflects observed coverage and time-anchoring, and is capped.
 *   LINKED         every event carries links to projects, people, goals,
 *                 documents and conversations — the brief's requirement.
 *   FEDERATED      person-vs-project typing comes from B2; without it the file
 *                 side types every proper noun `name`.
 *   FAIL-OPEN      a broken store returns an empty timeline, never throws.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-b7-'));
process.env.AQUA_DATA_DIR = TMP;

const CB = await import('../timelineV2/chainBuilder.js');
const TV = await import('../timelineV2/timelineView.js');
const Brain = await import('../index.js');
const A = await import('../worldModel/annotationStore.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ev = (id, type, statement, entities, ts = null) => ({
  id, type, statement, entities,
  timestampSeconds: ts, sourceFiles: ['f1'], origin: 'reasoning',
});

beforeEach(() => { A._resetAnnotationsForTests(); });

// ── STAGE ASSIGNMENT ─────────────────────────────────────────────────────────

test('the lifecycle is ordered and stage assignment reuses existing event types', () => {
  const orders = Object.values(CB.LIFECYCLE_STAGES).map(s => s.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'stages are monotonically ordered');
  assert.equal(CB.stageOf({ type: 'funding', statement: 'raised a seed round' }), 'outcome');
  assert.equal(CB.stageOf({ type: 'deployment', statement: 'shipped v1' }), 'ship');
  assert.equal(CB.stageOf({ kind: 'goal_created', subject: 'launch AQUA' }), 'idea');
});

test('textual cues REFINE a coarse type but never invent a stage', () => {
  // `creation` matches both "had the idea" and "built" — opposite ends.
  assert.equal(CB.stageOf({ type: 'creation', statement: 'had the idea for AQUA' }), 'idea');
  assert.equal(CB.stageOf({ type: 'creation', statement: 'started building AQUA' }), 'build');
  // An event with no lifecycle type gets no stage, however suggestive the text.
  assert.equal(CB.stageOf({ type: null, statement: 'we launched into a long discussion' }), null);
  assert.equal(CB.stageOf({ statement: 'shipped and launched and funded' }), null);
});

// ── CHAINS ───────────────────────────────────────────────────────────────────

test('CHAINS: the brief\'s example arc is recognised as one story', () => {
  const events = [
    ev('e1', 'creation',        'had the idea for AQUA',                ['AQUA'], 1000),
    ev('e2', 'creation',        'started building the AQUA prototype',  ['AQUA'], 2000),
    ev('e3', 'repo_update',     'pushed the AQUA repository',           ['AQUA'], 3000),
    ev('e4', 'deployment',      'launched AQUA to production',          ['AQUA'], 4000),
    ev('e5', 'meeting',         'pitched AQUA to investors',            ['AQUA'], 5000),
    ev('e6', 'funding',         'raised a seed round for AQUA',         ['AQUA'], 6000),
  ];
  const [chain] = CB.buildChains(events);
  assert.ok(chain, 'a chain was found');
  assert.equal(chain.subject, 'aqua');
  assert.ok(chain.stages.length >= 4, `${chain.stages.length} stages: ${chain.stages.join(' → ')}`);
  assert.equal(chain.progression[0].stage, 'idea', 'starts at the idea');
  assert.equal(chain.progression.at(-1).stage, 'outcome', 'ends at the outcome');
  assert.ok(chain.completeness > 0.5, 'most of the lifecycle observed');
});

test('SHARED SUBJECT: two things progressing in parallel are two chains', () => {
  const events = [
    ev('a1', 'creation',   'started building Alpha', ['Alpha'], 1000),
    ev('a2', 'deployment', 'launched Alpha',         ['Alpha'], 2000),
    ev('b1', 'creation',   'started building Beta',  ['Beta'],  1500),
    ev('b2', 'deployment', 'launched Beta',          ['Beta'],  2500),
  ];
  const chains = CB.buildChains(events);
  assert.equal(chains.length, 2);
  assert.deepEqual(chains.map(c => c.subject).sort(), ['alpha', 'beta']);
});

test('an event about two entities belongs to both arcs', () => {
  const events = [
    ev('e1', 'creation',   'started building AQUA at Aquiplex', ['AQUA', 'Aquiplex'], 1000),
    ev('e2', 'deployment', 'launched AQUA at Aquiplex',         ['AQUA', 'Aquiplex'], 2000),
  ];
  const chains = CB.buildChains(events);
  assert.deepEqual(chains.map(c => c.subject).sort(), ['aqua', 'aquiplex']);
});

test('a single event is not an arc', () => {
  assert.deepEqual(CB.buildChains([ev('e1', 'deployment', 'launched AQUA', ['AQUA'], 1000)]), []);
});

test('events with no lifecycle stage produce no chains', () => {
  const events = [
    ev('e1', null, 'AQUA has three modules', ['AQUA'], 1000),
    ev('e2', null, 'AQUA is written in JS',  ['AQUA'], 2000),
  ];
  assert.deepEqual(CB.buildChains(events), []);
});

// ── NO REGRESSION ────────────────────────────────────────────────────────────

test('NO REGRESSION: a backwards step is reported off-sequence, not reordered', () => {
  const events = [
    ev('e1', 'creation',   'had the idea for AQUA',        ['AQUA'], 1000),
    ev('e2', 'deployment', 'launched AQUA',                ['AQUA'], 2000),
    ev('e3', 'creation',   'started building AQUA again',  ['AQUA'], 3000), // back to `build`
    ev('e4', 'funding',    'raised a round for AQUA',      ['AQUA'], 4000),
  ];
  const [chain] = CB.buildChains(events);
  const progressionIds = chain.progression.map(p => p.id);
  const offIds = chain.offSequence.map(o => o.id);

  // The arc must be non-regressing…
  const orders = chain.progression.map(p => CB.LIFECYCLE_STAGES[p.stage].order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'stages never go backwards');
  // …and the regressing event must still be on the record.
  assert.ok(offIds.length > 0, 'the backwards step is reported');
  assert.ok(!progressionIds.includes(offIds[0]), 'and excluded from the arc');
  assert.equal(progressionIds.length + offIds.length, 4, 'nothing was silently dropped');
});

test('undated events sort after dated ones rather than claiming a position', () => {
  const events = [
    ev('e1', 'creation',   'had the idea for AQUA', ['AQUA'], 1000),
    ev('e2', 'deployment', 'launched AQUA',         ['AQUA'], null),
    ev('e3', 'funding',    'raised for AQUA',       ['AQUA'], 2000),
  ];
  const [chain] = CB.buildChains(events);
  assert.ok(chain, 'a chain still forms with partial dating');
  assert.ok(chain.confidence < 0.9, 'but confidence reflects the weaker anchoring');
});

// ── NOT CAUSATION ────────────────────────────────────────────────────────────

test('NOT CAUSATION: confidence rises with coverage and time-anchoring, and is capped', () => {
  const thin = CB.buildChains([
    ev('e1', 'creation',   'started building Thin', ['Thin'], null),
    ev('e2', 'deployment', 'launched Thin',         ['Thin'], null),
  ])[0];
  const thick = CB.buildChains([
    ev('f1', 'creation',    'had the idea for Thick',      ['Thick'], 1000),
    ev('f2', 'creation',    'started building Thick',      ['Thick'], 2000),
    ev('f3', 'repo_update', 'pushed the Thick repository', ['Thick'], 3000),
    ev('f4', 'deployment',  'launched Thick',              ['Thick'], 4000),
    ev('f5', 'funding',     'raised a round for Thick',    ['Thick'], 5000),
  ])[0];

  assert.ok(thick.confidence > thin.confidence, `${thick.confidence} > ${thin.confidence}`);
  assert.ok(thick.confidence <= 0.9, 'never certainty — a chain is inferred structure');
  // The field is named for what it is.
  assert.ok('progression' in thick && !('causation' in thick));
});

test('a chain reports its time span only when it has two dated events', () => {
  const dated = CB.buildChains([
    ev('e1', 'creation',   'started building Dated', ['Dated'], 1000),
    ev('e2', 'deployment', 'launched Dated',         ['Dated'], 5000),
  ])[0];
  assert.deepEqual(dated.span, { from: 1000, to: 5000 });

  const undated = CB.buildChains([
    ev('e1', 'creation',   'started building Undated', ['Undated'], null),
    ev('e2', 'deployment', 'launched Undated',         ['Undated'], null),
  ])[0];
  assert.equal(undated.span, null, 'no span invented from undated events');
});

// ── FEDERATED LINKING ────────────────────────────────────────────────────────

function stubDeps({ eventNodes = [], entities = [], mind = null, involves = {} } = {}) {
  const nodeById = new Map([...eventNodes, ...entities].map(n => [n.id, n]));
  return {
    graph: {
      nodesByType: (_o, type) => (type === 'event' ? eventNodes : type === 'entity' ? entities : []),
      neighbors: (_o, id, { type, edgeType } = {}) => {
        if (edgeType === 'involves' && type === 'entity') {
          return (involves[id] ?? []).map(eid => ({ node: nodeById.get(eid) })).filter(x => x.node);
        }
        return [];
      },
      edgesOf: () => [],
      getNode: (_o, id) => nodeById.get(id) ?? null,
    },
    peekMind: () => mind,
    evidenceStore: null,
    annotations: A,
  };
}

const entityNode = (id, label, entityType = 'name') => ({
  id, type: 'entity', label, sourceFiles: ['f1'], data: { entityType, aliases: [] },
});
const eventNode = (id, label, eventType, ts, sourceFiles = ['f1']) => ({
  id, type: 'event', label, sourceFiles, data: { eventType, timestampSeconds: ts, certainty: 'exact' },
});

test('LINKED: every event carries the five link categories the brief names', () => {
  const deps = stubDeps({
    eventNodes: [eventNode('evt:1', 'launched AQUA', 'deployment', 5000, ['uko-1', 'conv:c9:3'])],
    entities: [entityNode('ent:aqua', 'AQUA')],
    involves: { 'evt:1': ['ent:aqua'] },
  });
  const { events } = TV.buildUnifiedTimeline(deps, 'o');
  assert.equal(events.length, 1);
  for (const k of ['people', 'projects', 'goals', 'documents', 'conversations']) {
    assert.ok(k in events[0].links, `missing link category ${k}`);
  }
  assert.deepEqual(events[0].links.documents, ['uko-1'], 'file provenance becomes a document link');
  assert.deepEqual(events[0].links.conversations, ['conv:c9'], 'turn provenance rolls up to the conversation');
});

test('FEDERATED: person-vs-project typing comes from B2, not the file side', () => {
  const eventNodes = [eventNode('evt:1', 'Priya launched AQUA', 'deployment', 5000)];
  const entities = [entityNode('ent:priya', 'Priya'), entityNode('ent:aqua', 'AQUA')];
  const involves = { 'evt:1': ['ent:priya', 'ent:aqua'] };

  // Without the Mind, the file side types both as `name` — neither is
  // classifiable as person or project.
  const bare = TV.buildUnifiedTimeline(stubDeps({ eventNodes, entities, involves }), 'o');
  assert.equal(bare.events[0].links.people.length, 0);
  assert.equal(bare.events[0].links.projects.length, 0);

  // With the Mind federated in, the semantic types arrive.
  const mind = { graph: { nodes: {
    'person:priya': { type: 'person', label: 'Priya', weight: 4 },
    'project:aqua': { type: 'project', label: 'AQUA', weight: 6 },
  }, edges: {} }, timeline: [], goals: {} };
  const fed = TV.buildUnifiedTimeline(stubDeps({ eventNodes, entities, involves, mind }), 'o');
  assert.deepEqual(fed.events[0].links.people.map(p => p.title), ['Priya']);
  assert.deepEqual(fed.events[0].links.projects.map(p => p.title), ['AQUA']);
});

test('LINKED: an event advancing a goal is linked to it', () => {
  const mind = {
    graph: { nodes: {}, edges: {} }, timeline: [],
    goals: { g1: { title: 'launch the billing service', status: 'active' } },
  };
  const deps = stubDeps({
    eventNodes: [eventNode('evt:1', 'shipped work toward launch the billing service', 'deployment', 5000)],
    mind,
  });
  const { events } = TV.buildUnifiedTimeline(deps, 'o');
  assert.deepEqual(events[0].links.goals, [{ title: 'launch the billing service', status: 'active' }]);
});

test('events are gathered from all three sources and stay distinguishable', () => {
  const mind = {
    graph: { nodes: {}, edges: {} }, goals: {},
    timeline: [{ id: 'tl1', ts: 7_000_000, kind: 'goal_created', subject: 'ship AQUA', importance: 6 }],
  };
  const deps = stubDeps({
    eventNodes: [
      eventNode('evt:1', 'launched AQUA', 'deployment', 5000, ['uko-1']),
      eventNode('evt:2', 'discussed AQUA', 'meeting', 6000, ['conv:c1:2']),
    ],
    mind,
  });
  const { stats } = TV.buildUnifiedTimeline(deps, 'o');
  assert.deepEqual(stats.byOrigin, { reasoning: 1, conversation: 1, mind: 1 });
  assert.equal(stats.events, 3);
});

test('timeline orders dated events ascending, undated last', () => {
  const deps = stubDeps({
    eventNodes: [
      eventNode('evt:late',  'launched AQUA',  'deployment', 9000),
      eventNode('evt:none',  'AQUA milestone', 'approval',   null),
      eventNode('evt:early', 'idea for AQUA',  'creation',   1000),
    ],
  });
  const { events } = TV.buildUnifiedTimeline(deps, 'o');
  assert.deepEqual(events.map(e => e.id), ['evt:early', 'evt:late', 'evt:none']);
});

// ── FACADE + FAIL-OPEN ───────────────────────────────────────────────────────

test('facade: getTimeline and getChains return the expected shapes', () => {
  const deps = stubDeps({
    eventNodes: [
      eventNode('evt:1', 'had the idea for AQUA',   'creation',   1000),
      eventNode('evt:2', 'started building AQUA',   'creation',   2000),
      eventNode('evt:3', 'launched AQUA',           'deployment', 3000),
    ],
    entities: [entityNode('ent:aqua', 'AQUA')],
    involves: { 'evt:1': ['ent:aqua'], 'evt:2': ['ent:aqua'], 'evt:3': ['ent:aqua'] },
  });
  const out = Brain.getTimeline('o', { deps });
  assert.ok(out.events.length === 3 && Array.isArray(out.chains));
  assert.ok(out.stats.chains >= 1, 'a chain was detected through the facade');

  const chains = Brain.getChains('o', { deps });
  assert.ok(chains.length >= 1);
  assert.equal(chains[0].subject, 'aqua');
});

test('subject filter narrows both events and chains', () => {
  const deps = stubDeps({
    eventNodes: [
      eventNode('evt:1', 'started building Alpha', 'creation', 1000),
      eventNode('evt:2', 'launched Alpha',         'deployment', 2000),
      eventNode('evt:3', 'launched Beta',          'deployment', 3000),
    ],
    entities: [entityNode('ent:alpha', 'Alpha'), entityNode('ent:beta', 'Beta')],
    involves: { 'evt:1': ['ent:alpha'], 'evt:2': ['ent:alpha'], 'evt:3': ['ent:beta'] },
  });
  const out = Brain.getTimeline('o', { deps, subject: 'Alpha' });
  assert.ok(out.events.every(e => e.entities.includes('Alpha')));
  assert.ok(out.chains.every(c => c.subject === 'alpha'));
});

test('FAIL-OPEN: a broken graph returns an empty timeline, never throws', () => {
  const broken = { graph: { nodesByType: () => { throw new Error('boom'); } }, peekMind: () => null, evidenceStore: null, annotations: A };
  const out = Brain.getTimeline('o', { deps: broken });
  assert.deepEqual(out.events, []);
  assert.deepEqual(out.chains, []);
});

test('an owner with no events yields an empty timeline, not an error', () => {
  const out = TV.buildUnifiedTimeline(stubDeps({}), 'nobody');
  assert.deepEqual(out.events, []);
  assert.equal(out.stats.events, 0);
});

test('the kill switch takes the timeline out', () => {
  process.env.AQUA_BRAIN = 'off';
  try {
    const deps = stubDeps({ eventNodes: [eventNode('evt:1', 'launched AQUA', 'deployment', 5000)] });
    assert.deepEqual(Brain.getTimeline('o', { deps }).events, []);
  } finally {
    delete process.env.AQUA_BRAIN;
  }
});

test('a goal TITLE is not a description — intentions are never read as accomplishments', () => {
  // A goal named "launch AQUA" means a goal was created, not that AQUA shipped.
  assert.equal(CB.stageOf({ kind: 'goal_created', subject: 'launch AQUA' }), 'idea');
  assert.equal(CB.stageOf({ kind: 'goal_created', subject: 'raise a seed round' }), 'idea');
  assert.equal(CB.stageOf({ kind: 'goal_completed', subject: 'launch AQUA' }), 'outcome');
  // Whereas a reasoning event whose STATEMENT describes a launch is a ship.
  assert.equal(CB.stageOf({ type: 'creation', statement: 'launched AQUA to production' }), 'ship');
});

test('single-character entity names are treated as noise, not subjects', () => {
  assert.deepEqual(CB.buildChains([
    ev('e1', 'creation',   'started building X', ['X'], 1000),
    ev('e2', 'deployment', 'launched X',         ['X'], 2000),
  ]), [], 'no arc invented from a one-character name');
});

test('sortable time is derived from the DISPLAY timestamp graphBuilder actually stores', () => {
  // graphBuilder persists data.timestamp (an ISO date slice), not
  // data.timestampSeconds — reading the latter alone made every graph event
  // sort as undated and penalised every chain's anchoring.
  const deps = stubDeps({
    eventNodes: [
      { id: 'evt:1', type: 'event', label: 'launched AQUA', sourceFiles: ['f1'],
        data: { eventType: 'deployment', timestamp: '2025-08-20', certainty: 'exact' } },
      { id: 'evt:2', type: 'event', label: 'clip of AQUA demo', sourceFiles: ['f1'],
        data: { eventType: 'capture', timestamp: '00:12:34', certainty: 'exact' } },
    ],
  });
  const { events, stats } = TV.buildUnifiedTimeline(deps, 'o');
  const dated = events.find(e => e.id === 'evt:1');
  const media = events.find(e => e.id === 'evt:2');
  assert.equal(dated.timestampSeconds, Math.floor(Date.parse('2025-08-20T00:00:00Z') / 1000), 'ISO date parsed');
  assert.equal(media.timestampSeconds, null, 'a media offset is a position in a file, not a point in history');
  assert.equal(stats.anchored, 1);
  assert.equal(stats.unanchored, 1);
});
