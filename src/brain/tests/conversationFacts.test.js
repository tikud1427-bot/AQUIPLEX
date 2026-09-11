/**
 * Conversational Facts — the pure builder.
 *
 * The guarantees under test:
 *   PURE          no store, no graph, no flag; same input → same output.
 *   HONEST TRUST  every fact is labelled conversational and capped below
 *                 document-grade confidence — reachable, never masquerading.
 *   PROVENANCE    every fact carries evidence pointing at the exact sentence
 *                 of the exact turn; the reasoning contract is never bypassed.
 *   IDEMPOTENT    re-building the same turn yields the same fact ids and the
 *                 same evidence checksums, so a re-ingest upserts.
 *   NO SELF-FEED  the assistant's own words are excluded by default, so AQUA
 *                 cannot manufacture its own corroboration.
 *   BOUNDED       a runaway turn cannot produce unbounded facts.
 *   SAFE          unusable input returns empty, never throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConversationFacts,
  turnSourceId,
  CONVERSATION_FACT_CONFIDENCE,
  MAX_FACTS_PER_TURN,
} from '../knowledgeExtraction/conversationFacts.js';
import { validateFact, validateEvidence } from '../../files/evidence.js';

// Shaped exactly like entityResolver output: canonical + aliases.
const ENTITIES = [
  { id: 'ent:priya',    canonical: 'Priya',    aliases: ['Priya Sharma'], type: 'name' },
  { id: 'ent:aquiplex', canonical: 'Aquiplex', aliases: ['Aquiplex Inc.'], type: 'name' },
  { id: 'ent:aqua',     canonical: 'AQUA',     aliases: [],               type: 'name' },
];

const TURN = {
  conversationId: 'c1',
  turn: 3,
  userMessage: 'Priya owns the billing service at Aquiplex. AQUA ships in October. Thanks!',
  assistantMessage: 'Understood — Priya owns billing and AQUA ships in October.',
  entities: ENTITIES,
};

test('extracts one fact per entity-bearing sentence of the USER message', () => {
  const { facts, evidence, sourceId } = buildConversationFacts(TURN);

  assert.equal(sourceId, 'conv:c1:3');
  assert.equal(facts.length, 2, 'two qualifying sentences; "Thanks!" is below the length floor');
  assert.equal(evidence.length, 2, 'one evidence per fact');

  const statements = facts.map(f => f.statement);
  assert.ok(statements.some(s => s.startsWith('Priya owns the billing service')));
  assert.ok(statements.some(s => s.startsWith('AQUA ships in October')));
});

test('a single-entity sentence still becomes knowledge (minEntities defaults to 1)', () => {
  const { facts } = buildConversationFacts(TURN);
  const shipping = facts.find(f => f.statement.includes('ships in October'));
  assert.ok(shipping, 'one named entity is enough for a fact');
  assert.deepEqual(shipping.entities, ['AQUA']);
});

test('minEntities:2 reproduces the relationship-building bar', () => {
  const { facts } = buildConversationFacts(TURN, { minEntities: 2 });
  assert.equal(facts.length, 1);
  assert.ok(facts[0].statement.startsWith('Priya owns'));
});

test('entities are matched through aliases, resolved to canonical names', () => {
  const { facts } = buildConversationFacts({
    ...TURN,
    userMessage: 'Priya Sharma joined Aquiplex Inc. last spring.',
    assistantMessage: '',
  });
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].entities.sort(), ['Aquiplex', 'Priya'],
    'alias hits resolve to canonical, not to the surface form');
});

test('the assistant message is excluded by default — no self-manufactured evidence', () => {
  const userOnly = buildConversationFacts(TURN);
  const both     = buildConversationFacts(TURN, { includeAssistant: true });

  assert.ok(both.facts.length > userOnly.facts.length,
    'opting in genuinely adds the assistant sentences');
  assert.ok(!userOnly.facts.some(f => f.statement.startsWith('Understood')),
    'the default must never ingest AQUA\'s own claims');
});

test('confidence is capped below document-grade and labelled conversational', () => {
  const { facts, evidence } = buildConversationFacts(TURN);

  for (const f of facts) {
    assert.equal(f.confidence, CONVERSATION_FACT_CONFIDENCE);
    assert.ok(f.confidence < 0.9, 'never document-grade');
  }
  for (const ev of evidence) {
    assert.equal(ev.sourceType, 'conversation', 'a reader can always tell chat from document');
    assert.equal(ev.extractionMethod, 'heuristic');
    assert.equal(ev.confidence, CONVERSATION_FACT_CONFIDENCE);
  }
});

test('every fact and evidence object passes the canonical validators', () => {
  const { facts, evidence } = buildConversationFacts(TURN);

  for (const ev of evidence) {
    const { valid, problems } = validateEvidence(ev);
    assert.ok(valid, `evidence invalid: ${problems.join('; ')}`);
  }
  for (const f of facts) {
    const { valid, problems } = validateFact(f);
    assert.ok(valid, `fact invalid: ${problems.join('; ')}`);
  }
});

test('provenance points at the exact sentence of the exact turn', () => {
  const { facts, evidence } = buildConversationFacts(TURN);

  for (const ev of evidence) {
    assert.equal(ev.sourceFileId, turnSourceId('c1', 3));
    assert.equal(typeof ev.location.paragraph, 'number', 'sentence index is recorded');
    assert.equal(ev.location.page, null, 'a conversation has no page — never invented');
    assert.equal(ev.location.frame, null);
  }
  // Each fact references the evidence built from its own sentence.
  for (const f of facts) {
    const ev = evidence.find(e => e.id === f.evidence[0]);
    assert.ok(ev, 'fact references real evidence');
    assert.equal(ev.snippet, f.statement, 'the snippet IS the claim\'s source text');
  }
});

test('re-building the same turn is idempotent — stable ids, stable checksums', () => {
  const a = buildConversationFacts(TURN);
  const b = buildConversationFacts(TURN);

  assert.deepEqual(a.facts.map(f => f.id), b.facts.map(f => f.id),
    'fact ids derive from turn coordinates, not uuids');
  assert.deepEqual(a.evidence.map(e => e.checksum), b.evidence.map(e => e.checksum),
    'evidence dedupes at the store by content checksum');
  for (const f of a.facts) {
    assert.match(f.id, /^conv:c1:3:fact:\d+$/);
  }
});

test('a different turn of the same conversation produces different ids', () => {
  const t3 = buildConversationFacts(TURN);
  const t4 = buildConversationFacts({ ...TURN, turn: 4 });
  const overlap = t3.facts.map(f => f.id).filter(id => t4.facts.some(f => f.id === id));
  assert.equal(overlap.length, 0);
});

test('facts per turn are bounded', () => {
  const long = Array.from({ length: 200 }, (_, i) => `Priya reviewed change ${i} at Aquiplex.`).join(' ');
  const { facts } = buildConversationFacts({ ...TURN, userMessage: long, assistantMessage: '' });
  assert.equal(facts.length, MAX_FACTS_PER_TURN);
});

test('unusable input returns empty with a reason, never throws', () => {
  assert.equal(buildConversationFacts({}).skipped, 'missing-conversation');
  assert.equal(buildConversationFacts({ conversationId: 'c1', entities: [] }).skipped, 'no-entities');
  assert.equal(
    buildConversationFacts({ conversationId: 'c1', entities: ENTITIES, userMessage: 'hi' }).skipped,
    'no-sentences');
  assert.equal(
    buildConversationFacts({ conversationId: 'c1', entities: ENTITIES, userMessage: 'The weather is fine today.' }).skipped,
    'no-qualifying-sentences');

  for (const bad of [undefined, null, {}, { conversationId: 'c1' }]) {
    assert.doesNotThrow(() => buildConversationFacts(bad));
  }
});

test('the builder writes nothing — it is pure', async () => {
  // No store is REACHABLE from the unit under test, so a build cannot touch
  // persistence. Proven structurally rather than by observing behaviour.
  //
  // This used to assert `imports.length === 1`. The count was a proxy for
  // purity and it fired correctly when U1 added a second import — but the
  // right generalisation is not "allow two", it is "nothing reachable from
  // here is a store". A one-level check is not enough either: the actual U1
  // hazard was conversationEntities → selfEntity → idStore, which looks clean
  // until the third hop. So this walks the whole relative-import graph.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const STORE = /(?:evidenceStore|reasoningGraph|mindStore|idStore|ukoStore|picStore|longTermMemory|conversationStore|atomicStore|vectorStore|fileSearchIndex|pic\/core)\.js$/;
  const ROOT = fileURLToPath(new URL('../knowledgeExtraction/conversationFacts.js', import.meta.url));

  const seen = new Set();
  const trail = new Map();          // file → how we got here
  const queue = [ROOT];
  const reachedStores = [];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file !== ROOT && STORE.test(file)) { reachedStores.push(file); continue; }

    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/^(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/gm)) {
      const next = path.resolve(path.dirname(file), m[1]);
      if (!trail.has(next)) trail.set(next, file);
      queue.push(next);
    }
  }

  const explain = (f) => {
    const chain = [f];
    while (trail.has(chain[0]) && chain[0] !== ROOT) chain.unshift(trail.get(chain[0]));
    return chain.map(x => path.basename(x)).join(' → ');
  };

  assert.equal(
    reachedStores.length, 0,
    `the pure builder must not be able to reach a store:\n  ${reachedStores.map(explain).join('\n  ')}`,
  );
  assert.ok(seen.size > 1, 'sanity: the walk actually traversed imports');
});
