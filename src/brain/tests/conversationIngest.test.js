/**
 * Brain V1 / B3 — Conversation ingest into the world model.
 *
 * The guarantees under test:
 *   STANDING     a conversation turn becomes a first-class source node, and
 *                entities named in it get provenance-bearing graph edges —
 *                the same standing files have had since Phase 3.
 *   CORROBORATION an entity named in chat and the same entity extracted from
 *                a document resolve to ONE node, so the two sources reinforce
 *                each other instead of living in parallel.
 *   PROVENANCE   every conversation edge carries evidence pointing back at the
 *                turn; the reasoning contract is never bypassed.
 *   HONEST TRUST conversational claims are capped below document-grade and
 *                stay graph-only — they never masquerade as document facts.
 *   OFF BY DEFAULT ingest requires AQUA_BRAIN_INGEST=on; the read-side
 *                AQUA_BRAIN=off switch also disables it.
 *   FAIL-OPEN    a broken graph returns { ok:false }, never throws into chat.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-b3-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_BRAIN_INGEST = 'on';   // most tests exercise the enabled path

const G = await import('../../reasoning/reasoningGraph.js');
const R = await import('../../reasoning/typeRegistry.js');
const { ingestConversationTurn, ingestEnabled } = await import('../knowledgeExtraction/conversationIngest.js');
const Brain = await import('../index.js');
const A = await import('../worldModel/annotationStore.js');

const O = 'owner-b3';
const deps = { graph: G };

beforeEach(() => { G._resetGraphForTests(); R._resetRegistryForTests(); });
afterEach(() => { process.env.AQUA_BRAIN_INGEST = 'on'; delete process.env.AQUA_BRAIN; });

// ── STANDING ─────────────────────────────────────────────────────────────────

test('STANDING: a conversation turn becomes a source node with mentions edges', () => {
  const out = ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c1', turn: 2,
    userMessage: 'Priya Sharma leads the Billing Service at Aquiplex.',
    assistantMessage: 'Got it — Priya Sharma owns Billing Service.',
  });
  assert.ok(out.ok);
  assert.ok(out.entities >= 2, `resolved ${out.entities} entities from the turn`);

  const conv = G.getNode(O, 'conv:c1');
  assert.equal(conv?.type, 'conversation', 'conversation is a first-class node type');

  const mentioned = G.neighbors(O, 'conv:c1', { type: 'entity', edgeType: 'mentions' });
  assert.ok(mentioned.length >= 2, 'entities are linked to the conversation');
  assert.ok(mentioned.every(({ edge }) => edge.sourceFiles.length > 0), 'every mention edge carries provenance');
});

test('conversation is registered as a node CLASS — deliberate, not by typo', () => {
  // Registry was just re-seeded by beforeEach; an ingest must restore it
  // itself rather than relying on import order.
  ingestConversationTurn(deps, { ownerId: O, conversationId: 'cReg', turn: 1, userMessage: 'Acme Corp shipped a product today.', assistantMessage: 'ok' });
  assert.ok(R.isKnownNodeType('conversation'));
});

// ── CORROBORATION ────────────────────────────────────────────────────────────

test('CORROBORATION: a chat entity and a document entity resolve to one node', () => {
  // A document already put "OpenAI" in the graph with file provenance.
  G.upsertNode(O, {
    id: 'ent:name:openai', type: 'entity', label: 'OpenAI', kind: 'derived',
    data: { entityType: 'name', aliases: [], resolutionConfidence: 1, fileCount: 1 },
    sourceFiles: ['uko-doc-1'],
  }, { fileId: 'uko-doc-1' });

  ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c1', turn: 1,
    userMessage: 'I had a call with OpenAI about the partnership today.',
    assistantMessage: 'Noted the OpenAI partnership call.',
  });

  const node = G.getNode(O, 'ent:name:openai');
  assert.ok(node, 'same resolved id — not a duplicate');
  assert.ok(node.sourceFiles.includes('uko-doc-1'), 'document provenance retained');
  assert.ok(node.sourceFiles.some(f => f.startsWith('conv:')), 'conversation provenance added to the SAME node');
  // The entity is now corroborated by two independent sources.
  assert.ok(node.sourceFiles.length >= 2);
});

test('CORROBORATION: importance rises when chat corroborates a document (via projection)', () => {
  G.upsertNode(O, {
    id: 'ent:name:aqua', type: 'entity', label: 'AQUA', kind: 'derived',
    data: { entityType: 'name', aliases: [], resolutionConfidence: 1, fileCount: 1 },
    sourceFiles: ['uko-1'],
  }, { fileId: 'uko-1' });
  const bdeps = { graph: G, peekMind: () => null, evidenceStore: null, annotations: A };
  const before = Brain.getEntity(O, 'ent:name:aqua', { deps: bdeps });

  ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c9', turn: 1,
    userMessage: 'We shipped AQUA to production and AQUA is performing well.',
    assistantMessage: 'Great — AQUA is live.',
  });
  const after = Brain.getEntity(O, 'ent:name:aqua', { deps: bdeps });

  assert.ok(after.signals.sourceCount > before.signals.sourceCount, 'more sources after chat corroboration');
  assert.ok(after.importance >= before.importance, 'and importance reflects it');
});

// ── RELATIONSHIPS ────────────────────────────────────────────────────────────

test('relationships stated in chat are typed and grounded (predicate engine reused)', () => {
  ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c2', turn: 1,
    userMessage: 'ServiceX depends on Redis for its cache layer.',
    assistantMessage: 'Understood — ServiceX depends on Redis.',
  });

  const stats = G.graphStats(O);
  // depends_on should be present as a real typed edge, not flattened.
  const typed = Object.keys(stats.byEdgeType).filter(t => t !== 'mentions');
  assert.ok(typed.length > 0, `conversation produced typed relationship(s): ${JSON.stringify(stats.byEdgeType)}`);
});

test('HONEST TRUST: conversational relationships are capped below document-grade', () => {
  ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c3', turn: 1,
    userMessage: 'Ananya leads AQUA. Ananya leads AQUA. Ananya leads AQUA across many files.',
    assistantMessage: 'Ananya leads AQUA.',
  });
  for (const e of Object.values(G.graphStats(O).byEdgeType)) { /* touch */ }
  const ananya = G.nodesByType(O, 'entity').find(n => n.label.toLowerCase().includes('ananya'));
  if (ananya) {
    for (const edge of G.edgesOf(O, ananya.id, { type: 'related_to' })) {
      assert.ok(edge.confidence <= 0.7, `conversational edge confidence ${edge.confidence} stays ≤ 0.7`);
    }
  }
});

test('HONEST TRUST: conversation entities are tagged so a query can tell the source', () => {
  ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c4', turn: 1,
    userMessage: 'Meridian Corp announced a new funding round this week.',
    assistantMessage: 'Noted Meridian Corp funding.',
  });
  const ent = G.nodesByType(O, 'entity').find(n => n.label.toLowerCase().includes('meridian'));
  assert.ok(ent?.data.fromConversation, 'entity carries a conversational-origin flag');
});

// ── PROVENANCE ───────────────────────────────────────────────────────────────

test('PROVENANCE: every conversation edge points back at the exact turn', () => {
  ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c5', turn: 7,
    userMessage: 'Zeta Industries partnered with Acme Corporation on the project.',
    assistantMessage: 'Zeta and Acme are partnered.',
  });
  const edges = G.neighbors(O, 'conv:c5', { type: 'entity', edgeType: 'mentions' }).map(x => x.edge);
  assert.ok(edges.length >= 2);
  for (const e of edges) {
    assert.ok(e.sourceFiles.some(f => f === 'conv:c5:7'), 'provenance is the specific turn source id');
    assert.ok(e.evidence.length > 0, 'and carries an evidence reference');
  }
});

test('idempotent: re-ingesting the same turn merges, never duplicates', () => {
  const args = {
    ownerId: O, conversationId: 'c6', turn: 1,
    userMessage: 'Nimbus Systems uses Kubernetes in production.',
    assistantMessage: 'Nimbus uses Kubernetes.',
  };
  ingestConversationTurn(deps, args);
  const first = G.graphStats(O);
  ingestConversationTurn(deps, args);
  const second = G.graphStats(O);
  assert.deepEqual(second, first, 'second ingest of the identical turn changes nothing');
});

// ── BOUNDS + EDGE CASES ──────────────────────────────────────────────────────

test('a turn with no entities produces a conversation node but no edges', () => {
  const out = ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c7', turn: 1,
    userMessage: 'thanks, that works',
    assistantMessage: 'glad to help',
  });
  assert.ok(out.ok);
  assert.equal(out.entities, 0);
});

test('trivially short turns are skipped entirely', () => {
  const out = ingestConversationTurn(deps, { ownerId: O, conversationId: 'c8', turn: 1, userMessage: 'ok', assistantMessage: '' });
  assert.equal(out.skipped, 'too-short');
});

test('missing owner or conversation id is skipped, not thrown', () => {
  assert.equal(ingestConversationTurn(deps, { conversationId: 'x', userMessage: 'hello world here' }).skipped, 'missing-owner');
  assert.equal(ingestConversationTurn(deps, { ownerId: O, userMessage: 'hello world here' }).skipped, 'missing-owner');
});

// ── SWITCHES ─────────────────────────────────────────────────────────────────

test('OFF BY DEFAULT: without AQUA_BRAIN_INGEST=on, ingest is inert', () => {
  delete process.env.AQUA_BRAIN_INGEST;
  assert.equal(ingestEnabled(), false);
  const out = ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c1', turn: 1,
    userMessage: 'Priya leads Billing at Aquiplex.', assistantMessage: 'ok',
  });
  assert.equal(out.skipped, 'disabled');
  assert.equal(G.getNode(O, 'conv:c1'), null, 'nothing written when disabled');
});

test('the read-side kill switch also disables ingest', () => {
  process.env.AQUA_BRAIN = 'off';
  assert.equal(ingestEnabled(), false);
  assert.equal(ingestConversationTurn(deps, {
    ownerId: O, conversationId: 'c1', turn: 1, userMessage: 'hello world here', assistantMessage: 'ok',
  }).skipped, 'disabled');
});

// ── FAIL-OPEN ────────────────────────────────────────────────────────────────

test('FAIL-OPEN: a broken graph returns { ok:false } instead of throwing', () => {
  const broken = { graph: { upsertNode: () => { throw new Error('boom'); } } };
  const out = ingestConversationTurn(broken, {
    ownerId: O, conversationId: 'c1', turn: 1, userMessage: 'Acme Corp did a thing today.', assistantMessage: 'ok',
  });
  assert.equal(out.ok, false);
  assert.ok(out.error, 'error captured, not propagated');
});

test('facade: observeConversationTurn is guarded and honours the switch', () => {
  delete process.env.AQUA_BRAIN_INGEST;
  assert.deepEqual(Brain.observeConversationTurn({ ownerId: O, conversationId: 'c1', userMessage: 'hi there world', assistantMessage: 'ok' }, { deps: { graph: G } }), { ok: false, skipped: 'disabled' });
});
