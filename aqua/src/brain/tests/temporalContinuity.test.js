/**
 * A later word on an earlier statement reaches the answer beside it
 * (2026-11-02).
 *
 * Monday "the San Antonio opening is blocked by a zoning permit", Wednesday
 * "the zoning permit came through", Friday "is anything still blocking the San
 * Antonio opening?". Before: the resolution names no entity, so the
 * conversational fact lane never stored it; the evidence lane showed the
 * blocker alone under "EVIDENCE STATUS: SUFFICIENT".
 *
 * Through the real readers: Brain.observeConversationTurn (write),
 * PIC.retrieveKnowledge (the floor) and Brain.assembleContextAsync (the
 * Context Engine the legacy production read renders). Each negative has a
 * positive control in the same world.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-continuity-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;

const Brain = await import('../index.js');
const PIC = await import('../../pic/core.js');
const ES = await import('../../files/evidenceStore.js');
const G = await import('../../reasoning/reasoningGraph.js');
const { formatCitation } = await import('../../files/evidence.js');
const { cognitiveKnowledgeRetrieve } = await import('../../cognition/index.js');

const A = 'user:camila';
const B = 'user:someone-else';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const realNow = Date.now;
let clock = T0;

/** One user turn on day `d` (each turn is its own conversation turn, as in chat). */
let turnNo = 0;
function say(ownerId, text, d) {
  clock = T0 + d * DAY + (turnNo++) * 60_000;
  return Brain.observeConversationTurn({ ownerId, conversationId: `${ownerId}-c${d}`, turn: turnNo, userMessage: text, assistantMessage: '' });
}
const ask = (ownerId, q) => { clock = T0 + 30 * DAY; return PIC.retrieveKnowledge(ownerId, q, { limit: 8 }); };
const facts = ownerId => ES.listFacts(ownerId, { limit: 1000 });
const factFor = (ownerId, re) => facts(ownerId).find(f => re.test(f.statement));
const lineIndex = (block, re) => block.split('\n').findIndex(l => re.test(l));

beforeEach(() => {
  G._resetGraphForTests();
  ES._resetEvidenceStoreForTests();
  Object.assign(process.env, { AQUA_BRAIN_INGEST: 'on', AQUA_BRAIN_INGEST_FACTS: 'on', AQUA_CONTEXT_V2: 'on' });
  Date.now = () => clock;
  turnNo = 0;
});
afterEach(() => {
  Date.now = realNow;
  for (const k of ['AQUA_BRAIN_INGEST', 'AQUA_BRAIN_INGEST_FACTS', 'AQUA_CONTEXT_V2', 'AQUA_SELF_ENTITY', 'AQUA_UUS']) delete process.env[k];
});

function zoningWorld(ownerId = A) {
  say(ownerId, "I'm planning to open a second shop in San Antonio next summer.", 0);
  say(ownerId, 'Now the San Antonio opening is blocked by a zoning permit.', 7);
  say(ownerId, 'The zoning permit came through.', 14);
}

// ── write: entity continuity ────────────────────────────────────────────────

test('a resolution that names no entity is stored, continuing the blocker it resolves', () => {
  zoningWorld();
  const blocker = factFor(A, /blocked by a zoning permit/);
  const resolution = factFor(A, /zoning permit came through/);
  assert.ok(blocker, 'control: the blocker (names San Antonio) is stored');
  assert.ok(resolution, 'the resolution is stored');
  assert.equal(resolution.continues, blocker.id, 'with a link to what it continues');
  assert.deepEqual(resolution.entities, blocker.entities, 'about what the blocker was about');
  assert.equal(resolution.confidence, blocker.confidence, 'at the same capped conversational confidence');
  assert.equal(resolution.statement, 'The zoning permit came through.', "the user's own sentence, verbatim");
  assert.equal(blocker.supersededBy ?? null, null, 'the blocker is NOT superseded or hidden');
  assert.equal(blocker.archived ?? false, false);

  const blockerEntities = G.neighbors(A, `fact:${blocker.id}`, { type: 'entity', edgeType: 'about' }).map(n => n.node.id).sort();
  const resolutionEntities = G.neighbors(A, `fact:${resolution.id}`, { type: 'entity', edgeType: 'about' }).map(n => n.node.id).sort();
  assert.ok(blockerEntities.length, 'control: the blocker has about edges');
  assert.deepEqual(resolutionEntities, blockerEntities, 'the resolution is on the same graph paths');
});

test('an entity-less sentence without a transition is not stored, however much it shares', () => {
  zoningWorld();
  say(A, 'the zoning permit paperwork was a pain to read.', 15);
  say(A, 'lol the oven alarm again', 15);
  assert.ok(factFor(A, /came through/), 'control: a transition in the same world is stored');
  assert.equal(factFor(A, /paperwork/), undefined);
  assert.equal(factFor(A, /oven alarm/), undefined);
});

test('a plain change sharing one word with an open state does not continue it', () => {
  say(A, 'The San Antonio opening depends on getting an SBA loan.', 0);
  say(A, 'Our new loan officer moved to another branch.', 7);
  assert.ok(factFor(A, /SBA loan/), 'control');
  assert.equal(factFor(A, /loan officer/), undefined);
});

test('continuity never crosses owners', () => {
  zoningWorld(A);
  say(B, 'The zoning permit came through.', 20);
  assert.equal(facts(B).length, 0, "B never said what the permit was blocking; A's facts are not B's prior");
  assert.ok(factFor(A, /came through/), "control: A's own resolution is stored");
});

test('a forgotten (archived) statement is never continued', () => {
  say(A, 'Now the San Antonio opening is blocked by a zoning permit.', 7);
  const blocker = factFor(A, /blocked by a zoning permit/);
  ES.updateFact(A, blocker.id, { archived: true, archivedReason: 'user-forget:test' });
  say(A, 'The zoning permit came through.', 14);
  assert.equal(factFor(A, /came through/), undefined);
});

test('re-ingesting the resolving turn does not make it continue itself', () => {
  zoningWorld();
  const first = factFor(A, /came through/);
  clock = T0 + 14 * DAY;
  Brain.observeConversationTurn({ ownerId: A, conversationId: `${A}-c14`, turn: 3, userMessage: 'The zoning permit came through.', assistantMessage: '' });
  const again = facts(A).filter(f => /came through/.test(f.statement));
  assert.equal(again.length, 1, 'still one fact');
  assert.equal(again[0].continues, first.continues);
});

// ── read: PIC floor (Lane 7) ────────────────────────────────────────────────

test('the floor shows the blocker AND its resolution, oldest first, under the order note', () => {
  zoningWorld();
  const { block, items } = ask(A, 'Is anything still blocking the San Antonio opening?');
  const b = lineIndex(block, /blocked by a zoning permit/);
  const r = lineIndex(block, /zoning permit came through/);
  assert.ok(b >= 0, 'control: the blocker is there');
  assert.ok(r > b, 'the resolution is there, after it');
  assert.match(block, /oldest → newest/);
  const res = items.find(i => /came through/.test(i.statement ?? ''));
  assert.ok(Array.isArray(res.continuationOf) && res.continuationOf.length, 'tagged as the later word, for the Context Engine');
});

test('a later fact with its OWN entity is followed too (Lane 7), and only a bounded number', () => {
  say(A, 'Our Kickstarter campaign is stuck waiting on FCC certification.', 0);
  say(A, 'Good news, FCC signed off on the lamp last night.', 7);
  const { block, stats } = ask(A, 'Is anything holding up the Kickstarter?');
  assert.ok(lineIndex(block, /stuck waiting on FCC/) >= 0, 'control');
  assert.ok(lineIndex(block, /FCC signed off/) > lineIndex(block, /stuck waiting on FCC/));
  assert.ok(stats.continuationFacts <= 2);
  assert.ok(stats.continuationScanned > 0, 'the scan is counted');
});

// Same day, so the floor renders in RANK order (no order note): what leads is
// what the ranker believes is the answer (capture-core supersede-priority).
const priorityWorld = () => {
  // First-person statements reach the lane through the self entity (U1).
  Object.assign(process.env, { AQUA_SELF_ENTITY: 'on', AQUA_UUS: 'on' });
  say(A, 'Growth is my top priority this quarter.', 0);
  clock += 60_000;
  Brain.observeConversationTurn({ ownerId: A, conversationId: `${A}-c0`, turn: ++turnNo, userMessage: 'Growth is no longer the priority — retention is.', assistantMessage: '' });
};
const firstFact = block => block.split('\n').find(l => l.startsWith('•') && !/Entity:/.test(l)) ?? '';

test('the later word ranks above the statement it replaces for a question about now', () => {
  priorityWorld();
  const { block } = ask(A, 'What is my top priority?');
  assert.ok(lineIndex(block, /my top priority this quarter/) >= 0, 'control: the replaced statement is still shown');
  assert.match(firstFact(block), /retention/);
});

test('for a question about the past, the replaced statement keeps its rank', () => {
  priorityWorld();
  const { block } = ask(A, 'What was my top priority before?');
  assert.match(firstFact(block), /my top priority this quarter/);
});

test('history stays answerable: a past-tense question still gets the old blocker', () => {
  zoningWorld();
  const { block } = ask(A, 'What was blocking the San Antonio opening before?');
  assert.ok(lineIndex(block, /blocked by a zoning permit/) >= 0);
});

test('an unanswerable question gets no continuation', () => {
  zoningWorld();
  const { stats } = ask(A, "What is my dentist's name?");
  assert.equal(stats.continuationFacts, 0);
  assert.equal(stats.facts, 0, 'and nothing else');
});

// ── read: the Context Engine the legacy production read renders ─────────────

test('the Context Engine keeps the resolution the floor found', async () => {
  zoningWorld();
  // Facts that also match the question, so the resolution has competition.
  say(A, 'The San Antonio opening depends on getting an SBA loan.', 1);
  say(A, 'We started opening on Tuesdays too, so we are open every day now.', 8);
  say(A, 'The San Antonio opening date is set for July 12.', 15);
  clock = T0 + 30 * DAY;
  const q = 'Is anything still blocking the San Antonio opening?';
  const floorRetrieve = (oid, qq, o) => cognitiveKnowledgeRetrieve(oid, qq, { ...o, plan: null });
  const out = await Brain.assembleContextAsync(A, q, floorRetrieve, { limit: 8, plan: null, taskType: 'general', formatCitation,
    conversationId: 'ask', canonicalOnly: false, semanticScores: null, activeProjectId: null });
  const b = lineIndex(out.block, /blocked by a zoning permit/);
  const r = lineIndex(out.block, /zoning permit came through/);
  assert.ok(b >= 0, 'control: the blocker is in the block');
  assert.ok(r > b, 'the resolution is rendered after it');
});
