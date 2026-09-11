/**
 * Conversational facts get lifecycle standing — and only the standing they earn.
 *
 * Phase 4 made chat claims retrievable. This suite pins the two halves of the
 * Phase 5 decision:
 *
 *   • they ARE born and linked, so the lifecycle records the graph work that
 *     step 3c actually performed rather than skipping to `retrieved`;
 *   • they are NOT born verified, because `verified` means evidence-grounded
 *     and a chat claim is not. Promotion stays reachable through consolidation,
 *     which is the only honest route to it.
 *
 * The second half matters more than the first. Granting `verified` at birth
 * would be invisible in every green test that only checks a record exists.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-factlc-'));

const Brain = await import('../index.js');
const PIC   = await import('../../pic/core.js');
const LC    = await import('../../pic/knowledgeLifecycle.js');
const ES    = await import('../../files/evidenceStore.js');
const G     = await import('../../reasoning/reasoningGraph.js');

const O = 'user:ananya';
const TURN = {
  ownerId: O, conversationId: 'c-lc', turn: 1,
  userMessage: 'Priya Sharma owns the billing service at Aquiplex and it blocks the Q4 launch.',
  assistantMessage: 'Understood.',
};

beforeEach(() => {
  G._resetGraphForTests();
  ES._resetEvidenceStoreForTests();
  PIC._resetPICForTests();
  process.env.AQUA_BRAIN_INGEST = 'on';
  process.env.AQUA_BRAIN_INGEST_FACTS = 'on';
});

afterEach(() => {
  delete process.env.AQUA_BRAIN_INGEST;
  delete process.env.AQUA_BRAIN_INGEST_FACTS;
});

test('a conversational fact is born and linked at ingest', () => {
  const r = Brain.observeConversationTurn(TURN);
  assert.ok(r.facts > 0);

  const [fact] = ES.listFacts(O, { limit: 5 });
  const lc = LC.getLifecycle(O, `fact:${fact.id}`);

  assert.ok(lc, 'a lifecycle record exists at ingest, not only after first retrieval');
  assert.equal(lc.state, 'linked', 'it reflects the graph linking that actually happened');
});

test('it is NOT born verified — that state has to be earned', () => {
  Brain.observeConversationTurn(TURN);
  const [fact] = ES.listFacts(O, { limit: 5 });
  const lc = LC.getLifecycle(O, `fact:${fact.id}`);

  assert.notEqual(lc.state, 'verified', 'chat claims are not evidence-grounded at birth');
  assert.equal(fact.trusted ?? false, false, 'and carry no trusted flag');

  const states = lc.transitions.map(t => t.to);
  assert.deepEqual(states, ['created', 'linked'],
    'no parsed/enriched either — those processing stages never ran');
});

test('the history names the conversation it came from', () => {
  Brain.observeConversationTurn(TURN);
  const [fact] = ES.listFacts(O, { limit: 5 });
  const lc = LC.getLifecycle(O, `fact:${fact.id}`);

  assert.match(String(lc.transitions.at(-1).reason), /conversation c-lc/);
});

test('promotion to verified stays reachable, just not granted', () => {
  Brain.observeConversationTurn(TURN);
  const [fact] = ES.listFacts(O, { limit: 5 });

  // linked → verified is legal; consolidation performs it once a fact is
  // multi-evidence AND repeatedly retrieved. Birth must not have closed it.
  assert.equal(LC.canTransition('linked', 'verified'), true);
});

test('re-ingesting the same turn does not inflate the history', () => {
  Brain.observeConversationTurn(TURN);
  Brain.observeConversationTurn(TURN);

  const [fact] = ES.listFacts(O, { limit: 5 });
  const lc = LC.getLifecycle(O, `fact:${fact.id}`);
  assert.deepEqual(lc.transitions.map(t => t.to), ['created', 'linked'],
    'advanceThrough is idempotent — a replay adds no transitions');
});

test('retrieval now refreshes a record that already existed', () => {
  Brain.observeConversationTurn(TURN);
  const [fact] = ES.listFacts(O, { limit: 5 });
  const before = LC.getLifecycle(O, `fact:${fact.id}`).state;

  PIC.retrieveKnowledge(O, 'who owns billing', { limit: 5 });

  const after = LC.getLifecycle(O, `fact:${fact.id}`);
  assert.equal(before, 'linked');
  assert.equal(after.state, 'retrieved');
  assert.ok(after.meta.retrievals >= 1, 'the retrieval counter promotion depends on now moves');
});

test('lifecycle stats stop under-reporting the conversational corpus', () => {
  Brain.observeConversationTurn(TURN);
  const stats = LC.lifecycleStats(O);
  assert.ok((stats.byState?.linked ?? 0) > 0, 'chat facts appear as linked');
});

test('a failing PIC cannot undo facts already committed', () => {
  const r = Brain.observeConversationTurn(TURN, {
    deps: {
      graph: G,
      evidenceStore: ES,
      pic: { onConversationFactsWritten: () => { throw new Error('pic down'); } },
    },
  });

  assert.equal(r.ok, true);
  assert.ok(r.facts > 0, 'the facts are still written');
  assert.ok(ES.listFacts(O, { limit: 5 }).length > 0, 'and still in the store');
});

test('the entry point refuses input it cannot honestly act on', () => {
  assert.equal(PIC.onConversationFactsWritten({ ownerId: O, factIds: [] }).skipped, true);
  assert.equal(PIC.onConversationFactsWritten({}).skipped, true);
});
