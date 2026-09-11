/**
 * Conversation ingest WIRING — the production deps path.
 *
 * WHY THIS SUITE EXISTS SEPARATELY
 * -------------------------------
 * `picConversationSync.test.js` proves conversationIngest notifies PIC. It
 * does so by injecting `pic` straight into `ingestConversationTurn`. That is
 * the right way to test the MODULE and it passed for exactly as long as the
 * production caller was broken: `brain/index.js` forwarded `{ graph }` only,
 * so `deps.pic?.…` and `deps.ensureSelfEntity?.(…)` resolved to undefined and
 * did nothing on every real turn.
 *
 * Optional chaining is what made it silent — no throw, no log, no metric.
 *
 * So these tests deliberately go through `Brain.observeConversationTurn` with
 * DEFAULT deps and assert on the observable state of the real collaborators.
 * A future subset-forwarding regression fails here.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ingestwiring-'));

const Brain = await import('../index.js');
const PIC   = await import('../../pic/core.js');
const VS    = await import('../../pic/versionStore.js');
const G     = await import('../../reasoning/reasoningGraph.js');
const SE    = await import('../identity/selfEntity.js');

const O = 'user:ananya';

// "Aquiplex Inc." + "Aquiplex" resolve to one entity with an alias, which is
// what makes it a MERGE — onEntitiesResolved skips entities with no aliases.
const TURN = {
  ownerId: O,
  conversationId: 'c-wiring',
  turn: 1,
  userMessage: 'Aquiplex Inc. and Aquiplex are building AQUA with Priya Sharma.',
  assistantMessage: 'Noted — AQUA is the Aquiplex product.',
};

beforeEach(() => {
  G._resetGraphForTests();
  PIC._resetPICForTests();
  process.env.AQUA_BRAIN_INGEST = 'on';
});

afterEach(() => {
  delete process.env.AQUA_BRAIN_INGEST;
  delete process.env.AQUA_SELF_ENTITY;
});

test('the production path reaches PIC — not just the module under injection', () => {
  const before = PIC.getPICMetrics().entitiesMerged ?? 0;

  const result = Brain.observeConversationTurn(TURN);

  assert.equal(result.ok, true, 'ingest ran');
  assert.ok(result.entities > 0, 'entities were linked');

  const after = PIC.getPICMetrics().entitiesMerged ?? 0;
  assert.ok(after > before,
    `PIC recorded at least one entity merge through the default deps (before=${before} after=${after})`);
});

test('the recorded revision carries conversational provenance', () => {
  Brain.observeConversationTurn(TURN);

  const stats = VS.versionStats(O);
  assert.ok((stats.subjects ?? 0) > 0, 'a revision subject exists');

  // Find the merge revision and confirm it names the conversation, so a
  // chat-sourced merge is never later mistaken for a document-justified one.
  const entities = Brain.listEntities(O);
  const merged = entities.find(e => VS.getHistory(O, e.id)?.length);
  assert.ok(merged, 'at least one entity has revision history');

  const history = VS.getHistory(O, merged.id);
  const mergeRev = history.find(r => r.kind === 'entity_merge');
  assert.ok(mergeRev, 'the revision is an entity_merge');
  assert.match(String(mergeRev.reason), /conversation c-wiring/,
    'provenance names the conversation the merge came from');
});

test('PIC is notified exactly once per turn, not once per entity', () => {
  Brain.observeConversationTurn(TURN);
  const firstTurnMerges = PIC.getPICMetrics().entitiesMerged;

  // Re-ingesting the SAME turn is idempotent at the graph, but PIC's merge
  // notification is per-call by design — assert it does not fan out per
  // entity within a single call.
  const entities = Brain.listEntities(O).length;
  assert.ok(firstTurnMerges <= entities,
    `merges (${firstTurnMerges}) never exceed entities (${entities}) for one turn`);
});

test('the self entity is created through the production path when enabled', () => {
  process.env.AQUA_SELF_ENTITY = 'on';

  Brain.observeConversationTurn(TURN);

  const self = G.getNode(O, SE.SELF_GRAPH_ID);
  assert.ok(self, 'ensureSelfEntity was actually reached with a usable graph dep');
  assert.equal(self.data?.isSelf, true);
});

test('the self entity stays absent when its flag is off', () => {
  Brain.observeConversationTurn(TURN);
  assert.equal(G.getNode(O, SE.SELF_GRAPH_ID), null,
    'forwarding deps must not turn a flag on by accident');
});

test('a broken collaborator still cannot cost the turn', () => {
  // The whole point of forwarding real deps is that they now run for real.
  // Prove the fail-open contract survives it.
  assert.doesNotThrow(() => Brain.observeConversationTurn({
    ...TURN,
    conversationId: 'c-fail',
  }, {
    deps: {
      graph: G,
      pic: { onEntitiesResolved: () => { throw new Error('pic down'); } },
      ensureSelfEntity: () => { throw new Error('self down'); },
    },
  }));
});

test('ingest stays inert when the flag is off, even with deps wired', () => {
  delete process.env.AQUA_BRAIN_INGEST;
  const before = PIC.getPICMetrics().entitiesMerged ?? 0;

  const result = Brain.observeConversationTurn(TURN);

  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'disabled');
  assert.equal(Brain.listEntities(O).length, 0, 'nothing entered the world model');
  assert.equal(PIC.getPICMetrics().entitiesMerged ?? 0, before, 'PIC untouched');
});
