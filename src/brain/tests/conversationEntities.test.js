/**
 * Lowercase conversational input produces entities — and documents are untouched.
 *
 * This suite exists because of a production finding, not a hypothetical. With
 * ingest live, a message dense with durable facts ("my brother's name is
 * ananya prabal das. he is the co-founder of aquiplex…") produced
 * `entities=0 facts=0`, because the shared extractor looks for capital
 * letters and chat has none. The only reason ANY facts were captured that day
 * is that AQUA's reply happened to echo the names back in title case.
 *
 * So the tests below are written around the real message, and the assistant
 * reply is deliberately generic — if a test passes only because the reply
 * repeated the names, it is testing the wrong thing.
 *
 * The second half guards the constraint that came with the fix: the shared
 * document extractor must not be loosened. A test that only proved chat got
 * better would let a future change buy that improvement with document
 * precision.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-convent-'));

const Brain = await import('../index.js');
const ES    = await import('../../files/evidenceStore.js');
const G     = await import('../../reasoning/reasoningGraph.js');
const PIC   = await import('../../pic/core.js');
const { extractConversationEntities, knownEntitiesFor } =
  await import('../knowledgeExtraction/conversationEntities.js');
const { extractEntities } = await import('../../files/extractors.js');

const O = 'user:ananya';

// The actual production message, verbatim, lowercase and all.
const REAL_MESSAGE =
  "my brother's name is ananya prabal das. he is the co-founder of aquiplex. " +
  'he was also former CEO of aquiplex. he is studying in class 11. ' +
  'he also wants to become a billionaire';

// Generic on purpose — see the header.
const GENERIC_REPLY = 'Got it, noted.';

function onFlags() {
  process.env.AQUA_BRAIN_INGEST = 'on';
  process.env.AQUA_BRAIN_INGEST_FACTS = 'on';
}

beforeEach(() => {
  G._resetGraphForTests();
  ES._resetEvidenceStoreForTests();
  PIC._resetPICForTests();
  onFlags();
});

afterEach(() => {
  delete process.env.AQUA_BRAIN_INGEST;
  delete process.env.AQUA_BRAIN_INGEST_FACTS;
});

// ── The regression itself ───────────────────────────────────────────────────

test('the real lowercase message yields entities without the reply echoing names', () => {
  const r = Brain.observeConversationTurn({
    ownerId: O, conversationId: 'c1', turn: 1,
    userMessage: REAL_MESSAGE, assistantMessage: GENERIC_REPLY,
  });

  assert.ok(r.entities > 0,
    'lowercase input used to yield zero entities and exit before fact writing');
  assert.ok(r.facts > 0, 'and therefore zero facts');
});

test('the facts captured are the user\'s own sentences', () => {
  Brain.observeConversationTurn({
    ownerId: O, conversationId: 'c1', turn: 1,
    userMessage: REAL_MESSAGE, assistantMessage: GENERIC_REPLY,
  });

  const statements = ES.listFacts(O, { limit: 20 }).map(f => f.statement);
  assert.ok(statements.some(s => /name is ananya prabal das/i.test(s)));
  assert.ok(statements.some(s => /co-founder of aquiplex/i.test(s)));
  assert.ok(statements.every(s => !/Got it, noted/i.test(s)),
    'the assistant\'s words are never stored as the user\'s claims');
});

test('a later bare lowercase mention resolves onto the known entity', () => {
  Brain.observeConversationTurn({
    ownerId: O, conversationId: 'c1', turn: 1,
    userMessage: REAL_MESSAGE, assistantMessage: GENERIC_REPLY,
  });
  const before = G.nodesByType(O, 'entity').length;

  // No declaration cue at all — this can only work via the known-entity pass.
  const r = Brain.observeConversationTurn({
    ownerId: O, conversationId: 'c1', turn: 2,
    userMessage: "we've got into a fight. ananya prabal das is being difficult about aquiplex.",
    assistantMessage: 'That sounds hard.',
  });

  assert.ok(r.entities > 0, 'the second mention was recognised');
  assert.equal(G.nodesByType(O, 'entity').length, before,
    'and merged onto the existing nodes rather than forking new ones');
});

// ── The extractor in isolation ──────────────────────────────────────────────

test('declaration cues introduce a new lowercase name', () => {
  const out = extractConversationEntities('his name is ravi kulkarni', {});
  assert.ok(out.some(e => /ravi kulkarni/i.test(e.value)));
});

test('role and employment cues introduce an organisation', () => {
  const roles = extractConversationEntities('she is the ceo of northwind labs', {});
  assert.ok(roles.some(e => /northwind labs/i.test(e.value)));

  const works = extractConversationEntities('he works at zephyr systems', {});
  assert.ok(works.some(e => /zephyr systems/i.test(e.value)));
});

test('cue-shaped sentences about feelings do not become entities', () => {
  // The failure mode the blocklist exists to prevent.
  for (const text of [
    'i am tired',
    'he is the founder of this',
    'his name is my brother',
    'she works at home',
    'they are called the good ones',
  ]) {
    const out = extractConversationEntities(text, { knownEntities: [] })
      .filter(e => e.source === 'declared');
    assert.equal(out.length, 0, `"${text}" must not declare an entity, got ${JSON.stringify(out)}`);
  }
});

test('known entities are matched case-insensitively and returned canonically', () => {
  const known = [{ value: 'Ananya Prabal Das', type: 'name' }];
  const out = extractConversationEntities('ananya prabal das said hello', { knownEntities: known });

  const hit = out.find(e => e.source === 'known');
  assert.ok(hit, 'the lowercase mention matched');
  assert.equal(hit.value, 'Ananya Prabal Das',
    'canonical casing is emitted so the resolver merges rather than forks');
});

test('a known short name does not fire inside a longer word', () => {
  const known = [{ value: 'ana', type: 'name' }];
  const out = extractConversationEntities('the banana was ripe', { knownEntities: known });
  assert.equal(out.filter(e => e.source === 'known').length, 0);
});

test('capitalised input keeps working exactly as before', () => {
  const text = 'Ananya Prabal Das co-founded Aquiplex in Mumbai.';
  const shared = extractEntities(text, { limit: 40 }).map(e => e.value).sort();
  const convo  = extractConversationEntities(text, {})
    .filter(e => e.source === 'shared').map(e => e.value).sort();

  assert.deepEqual(convo, shared,
    'pass A is the shared extractor unmodified — same input, same output');
});

test('typed patterns that never needed capitalisation still resolve', () => {
  const out = extractConversationEntities('email me at ravi@northwind.io before 2026-08-01', {});
  assert.ok(out.some(e => e.type === 'email'));
  assert.ok(out.some(e => e.type === 'date'));
});

// ── The document pipeline must not have moved ───────────────────────────────

test('the shared document extractor still ignores lowercase prose', () => {
  // This is the constraint, stated as a test. If someone "fixes" chat by
  // loosening the shared extractor, every uploaded document starts inventing
  // entities from ordinary sentences — and this fails.
  const out = extractEntities(REAL_MESSAGE, { limit: 40 });
  const names = out.filter(e => e.type === 'name');
  assert.equal(names.length, 0,
    'documents are capitalised; the document heuristic must stay strict');
});

test('knownEntitiesFor reads labels and aliases, and survives a broken graph', () => {
  Brain.observeConversationTurn({
    ownerId: O, conversationId: 'c1', turn: 1,
    userMessage: REAL_MESSAGE, assistantMessage: GENERIC_REPLY,
  });

  const known = knownEntitiesFor(G, O);
  assert.ok(known.length > 0, 'entities from the world model are offered back');
  assert.ok(known.every(k => typeof k.value === 'string' && k.value.length >= 3));

  assert.deepEqual(knownEntitiesFor(null, O), [], 'no graph is a degraded pass, not a throw');
  assert.deepEqual(knownEntitiesFor({ nodesByType() { throw new Error('boom'); } }, O), []);
});

test('an empty or junk turn still produces nothing', () => {
  assert.deepEqual(extractConversationEntities('', {}), []);
  assert.deepEqual(extractConversationEntities(null, {}), []);

  const r = Brain.observeConversationTurn({
    ownerId: O, conversationId: 'c2', turn: 1,
    userMessage: 'heyy', assistantMessage: 'Hey! How can I help?',
  });
  assert.equal(r.facts ?? 0, 0, '"heyy" carries no durable knowledge');
});
