/**
 * Conversational facts REACH the retrievers.
 *
 * `conversationFacts.test.js` proves the builder produces correct objects.
 * `ingestWiring.test.js` proves the production deps path is wired. Neither
 * proves the thing the audit actually cared about: that a claim made in chat
 * is retrievable afterwards.
 *
 * So these tests assert through the REAL readers rather than re-checking the
 * store — PIC retrieval, the `about` hop, and reflection's fact scan. If a
 * future change puts facts somewhere the retrievers do not look, the store
 * assertions would still pass and these would not.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-factingest-'));

const Brain = await import('../index.js');
const ES    = await import('../../files/evidenceStore.js');
const ER    = await import('../../files/evidenceRetrieval.js');
const G     = await import('../../reasoning/reasoningGraph.js');
const { createEvidence, createFact } = await import('../../files/evidence.js');

const O = 'user:ananya';

const TURN = {
  ownerId: O,
  conversationId: 'c-facts',
  turn: 1,
  userMessage: 'Priya Sharma owns the billing service at Aquiplex and it is blocking the Q4 launch.',
  assistantMessage: 'Understood — Priya owns billing at Aquiplex.',
};

function onFlags({ facts = true } = {}) {
  process.env.AQUA_BRAIN_INGEST = 'on';
  if (facts) process.env.AQUA_BRAIN_INGEST_FACTS = 'on';
}

beforeEach(() => {
  G._resetGraphForTests();
  ES._resetEvidenceStoreForTests();
});

afterEach(() => {
  delete process.env.AQUA_BRAIN_INGEST;
  delete process.env.AQUA_BRAIN_INGEST_FACTS;
});

// ── Reachability — the whole point of the phase ──────────────────────────────

test('a claim made in chat is retrievable afterwards by PIC lane 1', () => {
  onFlags();
  const result = Brain.observeConversationTurn(TURN);
  assert.ok(result.facts > 0, `facts were written (got ${result.facts})`);

  const hits = ER.retrieveGroundedFacts(ES, O, 'who owns billing', { limit: 10 });
  assert.ok(hits.length > 0, 'the lexical grounded-fact lane finds it');
  assert.match(hits[0].fact.statement, /billing/i);
});

test('the retrieved claim is labelled conversational, not document-grade', () => {
  onFlags();
  Brain.observeConversationTurn(TURN);

  const [hit] = ER.retrieveGroundedFacts(ES, O, 'billing', { limit: 5 });
  assert.ok(hit, 'a fact came back');
  assert.ok(hit.fact.confidence <= 0.6, 'capped below document grade');

  const evidence = ES.evidenceForFact(O, hit.fact.id);
  assert.ok(evidence.length > 0, 'provenance survived the write');
  assert.equal(evidence[0].sourceType, 'conversation');
  assert.equal(evidence[0].extractionMethod, 'heuristic');
  assert.match(evidence[0].sourceFileId, /^conv:c-facts:1$/,
    'provenance points at the exact turn');
});

test('the fact is on the graph paths the Context Engine hops across', () => {
  onFlags();
  Brain.observeConversationTurn(TURN);

  const factNodes = G.nodesByType(O, 'fact');
  assert.ok(factNodes.length > 0, 'fact nodes exist');

  // The `about` hop is what PIC lane 3 and contextEngine traverse. A fact in
  // the store but off this path is only half-reachable.
  const entities = G.nodesByType(O, 'entity');
  const reachable = entities.some(e =>
    G.neighbors(O, e.id, { type: 'fact', edgeType: 'about' }).length > 0);
  assert.ok(reachable, 'at least one entity reaches a fact over an `about` edge');

  // And the conversation asserts it, mirroring file → fact.
  const asserted = G.neighbors(O, `conv:${TURN.conversationId}`, { type: 'fact', edgeType: 'asserts' });
  assert.ok(asserted.length > 0, 'the conversation node asserts its facts');
});

test('reflection can now see conversational claims', () => {
  onFlags();
  Brain.observeConversationTurn(TURN);

  // detectObsolescence reads ES.listFacts — this was empty for chat before.
  const facts = ES.listFacts(O, { limit: 100 });
  assert.ok(facts.length > 0, 'reflection\'s fact scan is no longer blind to chat');
});

// ── Idempotence ─────────────────────────────────────────────────────────────

test('re-ingesting the same turn does not duplicate', () => {
  onFlags();
  Brain.observeConversationTurn(TURN);
  const after1 = ES.getEvidenceStats(O);

  Brain.observeConversationTurn(TURN);
  const after2 = ES.getEvidenceStats(O);

  assert.equal(after2.facts, after1.facts, 'fact count is stable (derived ids upsert)');
  assert.equal(after2.evidence, after1.evidence, 'evidence deduped on checksum');
});

// ── The flag ────────────────────────────────────────────────────────────────

test('entity ingest without the facts flag writes no facts', () => {
  onFlags({ facts: false });
  const result = Brain.observeConversationTurn(TURN);

  assert.ok(result.entities > 0, 'entities still ingest');
  assert.equal(result.facts, 0, 'claims do not');
  assert.equal(ES.getEvidenceStats(O).facts, 0, 'the evidence store is untouched');
});

test('the facts flag cannot enable itself without its parent', () => {
  // AQUA_BRAIN_INGEST_FACTS set, AQUA_BRAIN_INGEST not.
  process.env.AQUA_BRAIN_INGEST_FACTS = 'on';
  const result = Brain.observeConversationTurn(TURN);

  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'disabled');
  assert.equal(ES.getEvidenceStats(O).facts, 0);
  assert.equal(Brain.factIngestEnabled(), false, 'the predicate is subordinate too');
});

// ── Isolation ───────────────────────────────────────────────────────────────

test('a failing fact write still leaves entities and relationships intact', () => {
  onFlags();
  const brokenStore = {
    saveEvidence: () => { throw new Error('disk full'); },
    saveFact: () => { throw new Error('disk full'); },
  };

  const result = Brain.observeConversationTurn(TURN, {
    deps: { graph: G, evidenceStore: brokenStore },
  });

  assert.equal(result.ok, true, 'the turn survives');
  assert.ok(result.entities > 0, 'entity work already done is not rolled back');
  assert.equal(result.facts, 0);
});

// ── Eviction policy — documents must outlive chat ────────────────────────────

test('eviction spends the conversational budget before touching documents', () => {
  // A document fact, written FIRST so it is the globally oldest — the exact
  // victim the old createdAt-only eviction would have taken.
  const docEv = createEvidence({
    sourceFileId: 'uko:report', sourceFileName: 'report.pdf',
    sourceType: 'document', extractionMethod: 'text-layer',
    confidence: 0.9, snippet: 'Revenue grew 40% in Q3 2026.',
  });
  ES.saveEvidence(O, docEv);
  const docFact = createFact({
    statement: 'Revenue grew 40% in Q3 2026.',
    entities: ['Q3 2026'], evidence: [docEv], confidence: 0.9,
  });
  ES.saveFact(O, docFact, { sourceFileId: 'uko:report' });

  const stats = ES.getEvidenceStats(O);
  assert.equal(stats.documentFacts, 1);
  assert.equal(stats.conversationFacts, 0);

  onFlags();
  Brain.observeConversationTurn(TURN);

  const after = ES.getEvidenceStats(O);
  assert.ok(after.conversationFacts > 0, 'chat facts landed');
  assert.equal(after.documentFacts, 1, 'the document fact is still counted');
  assert.ok(ES.getFact(O, docFact.id), 'and still present');
});

test('under real cap pressure the oldest DOCUMENT fact survives and chat is spent', () => {
  // This is the test that matters. The coexistence test above never reaches
  // MAX_FACTS_PER_OWNER, so it would pass under the old createdAt-only
  // eviction too. This one fills the store past the cap.
  const docEv = createEvidence({
    sourceFileId: 'uko:contract', sourceFileName: 'contract.pdf',
    sourceType: 'document', extractionMethod: 'text-layer',
    confidence: 0.95, snippet: 'The agreement terminates on 31 December 2027.',
  });
  ES.saveEvidence(O, docEv);
  const docFact = createFact({
    statement: 'The agreement terminates on 31 December 2027.',
    entities: ['31 December 2027'], evidence: [docEv], confidence: 0.95,
  });
  ES.saveFact(O, docFact, { sourceFileId: 'uko:contract' });

  // Written first ⇒ globally oldest ⇒ the victim the old policy would take.
  const OVER_CAP = 5100;
  for (let i = 0; i < OVER_CAP; i++) {
    const ev = createEvidence({
      sourceFileId: `conv:flood:${i}`, sourceType: 'conversation',
      extractionMethod: 'heuristic', confidence: 0.6,
      snippet: `chat claim number ${i} about something`,
    });
    ES.saveEvidence(O, ev);
    ES.saveFact(O, createFact({
      statement: `chat claim number ${i} about something`,
      entities: ['Something'], evidence: [ev], confidence: 0.6,
    }), { sourceFileId: `conv:flood:${i}` });
  }

  const stats = ES.getEvidenceStats(O);
  assert.ok(stats.facts <= 5000, 'the cap held');
  assert.ok(ES.getFact(O, docFact.id),
    'the oldest fact in the store is a DOCUMENT fact and it was not evicted');
  assert.equal(stats.documentFacts, 1, 'document knowledge is intact');
  assert.ok(stats.conversationFacts > 4000, 'the conversational budget absorbed the pressure');
});

test('with no conversational facts, eviction is unchanged from before', () => {
  // The fallback path: an all-document store must behave exactly as it did.
  const ids = [];
  for (let i = 0; i < 5010; i++) {
    const ev = createEvidence({
      sourceFileId: `uko:doc${i}`, sourceType: 'document',
      extractionMethod: 'text-layer', confidence: 0.9,
      snippet: `document statement number ${i} here`,
    });
    ES.saveEvidence(O, ev);
    const f = createFact({
      statement: `document statement number ${i} here`,
      entities: ['Doc'], evidence: [ev], confidence: 0.9,
    });
    ES.saveFact(O, f, { sourceFileId: `uko:doc${i}` });
    ids.push(f.id);
  }

  assert.ok(ES.getEvidenceStats(O).facts <= 5000, 'the cap held');
  assert.equal(ES.getFact(O, ids[0]), null, 'the oldest document fact was evicted, as before');
  assert.ok(ES.getFact(O, ids[ids.length - 1]), 'the newest survived');
});

test('the document/conversation split is observable for the rollout', () => {
  onFlags();
  Brain.observeConversationTurn(TURN);

  const stats = ES.getEvidenceStats(O);
  assert.equal(stats.conversationFacts + stats.documentFacts, stats.facts,
    'the split accounts for every fact');
  assert.ok(stats.conversationFacts > 0);
});

test('ingest metrics report the facts switch and the write count', () => {
  onFlags();
  Brain.observeConversationTurn(TURN);

  const m = Brain.brainMetrics().ingest;
  assert.equal(m.factsEnabled, true);
  assert.ok(m.factsWritten > 0, 'writes are counted for the rollout');
});

// ── Prompt provenance ───────────────────────────────────────────────────────

test('the context block does not tell the model a chat claim came from files', async () => {
  const PIC = await import('../../pic/core.js');
  onFlags();
  Brain.observeConversationTurn(TURN);

  const { block } = PIC.retrieveKnowledge(O, 'who owns billing', { limit: 5 });
  assert.ok(block.length, 'a block was produced');
  assert.doesNotMatch(block, /verified across your files/,
    'a conversation-only block must not claim file provenance');
  assert.match(block, /conversations/, 'it names the real source');
  assert.match(block, /\[Conversation c-facts · ¶1\]/, 'and cites the exact turn');
});
