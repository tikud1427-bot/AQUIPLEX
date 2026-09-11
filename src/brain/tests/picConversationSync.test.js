/**
 * Conversational entity resolution reaches PIC (integration gap found in the
 * post-M2 audit).
 *
 * `onKnowledgeIngested` requires ukoIds and reads evidenceStore, so a turn
 * cannot use it without pretending to be a document — the exact thing
 * conversationIngest avoids when it keeps chat-derived facts out of the
 * evidence store. `onEntitiesResolved` is the narrow path for the part that
 * does apply: the resolver merged surface forms, and that merge is a revision.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-picsync-'));

const PIC = await import('../../pic/core.js');
const CI = await import('../knowledgeExtraction/conversationIngest.js');
const G = await import('../../reasoning/reasoningGraph.js');

const O = 'user:ananya';
beforeEach(() => { G._resetGraphForTests(); process.env.AQUA_BRAIN_INGEST = 'on'; });
afterEach(() => { delete process.env.AQUA_BRAIN_INGEST; });

test('a conversation turn notifies PIC of resolved entities', () => {
  const seen = [];
  CI.ingestConversationTurn(
    { graph: G, pic: { onEntitiesResolved: (a) => seen.push(a) } },
    { ownerId: O, conversationId: 'c1', turn: 1,
      userMessage: 'Aquiplex Inc. and Aquiplex are building AQUA with Priya Sharma.',
      assistantMessage: 'Noted.' });

  assert.equal(seen.length, 1, 'PIC is told exactly once per turn');
  assert.equal(seen[0].ownerId, O);
  assert.equal(seen[0].source, 'c1', 'provenance names the conversation');
  assert.ok(Array.isArray(seen[0].entities) && seen[0].entities.length > 0);
});

test('a throwing PIC never costs the turn', () => {
  assert.doesNotThrow(() => CI.ingestConversationTurn(
    { graph: G, pic: { onEntitiesResolved: () => { throw new Error('pic down'); } } },
    { ownerId: O, conversationId: 'c1', turn: 1,
      userMessage: 'Aquiplex and Priya Sharma are shipping AQUA.', assistantMessage: 'ok' }));
});

test('a missing pic dep is simply the previous behaviour', () => {
  assert.doesNotThrow(() => CI.ingestConversationTurn(
    { graph: G },
    { ownerId: O, conversationId: 'c1', turn: 1,
      userMessage: 'Aquiplex and Priya Sharma are shipping AQUA.', assistantMessage: 'ok' }));
});

test('onEntitiesResolved records a merge revision and never touches lifecycle', () => {
  const r = PIC.onEntitiesResolved({
    ownerId: O, source: 'c1',
    entities: [{ id: 'ent:name:aquiplex', canonical: 'Aquiplex Inc.', aliases: ['Aquiplex'], confidence: 0.9 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.entityMerges, 1);
});

test('an entity with no aliases is not a merge and records nothing', () => {
  const r = PIC.onEntitiesResolved({
    ownerId: O, source: 'c1',
    entities: [{ id: 'ent:name:solo', canonical: 'Solo', aliases: [], confidence: 1 }],
  });
  assert.equal(r.entityMerges, 0, 'no surface forms were merged, so there is no revision to record');
});

test('empty input is a no-op, not an error', () => {
  assert.equal(PIC.onEntitiesResolved({ ownerId: O, entities: [] }).skipped, true);
  assert.equal(PIC.onEntitiesResolved({}).skipped, true);
});
