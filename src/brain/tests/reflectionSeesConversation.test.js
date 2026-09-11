/**
 * Reflection sees conversation — verification, no new production code.
 *
 * The audit's M2 said reflectionV2 was structurally blind to chat:
 * `detectObsolescence` reads `ES.listFacts`, nothing conversational was ever
 * in that store, so AQUA could not notice that something said today
 * contradicts something said last week — or contradicts a document.
 *
 * Phase 4's claim was that writing conversational facts into evidenceStore
 * closes M2 "for free", with no reflection changes at all. This suite tests
 * that claim instead of assuming it.
 *
 * THE LOAD-BEARING TEST IS THE NEGATIVE CONTROL at the bottom: with fact
 * ingest disabled, the identical contradicting turns produce nothing. Without
 * it, the rest could pass for reasons unrelated to the change.
 *
 * ON TIMING — WHY EVERY TEST TICKS THE CLOCK
 * ------------------------------------------
 * The freshness gate is `newer.createdAt < since`, compared at MILLISECOND
 * resolution, where `since` is the previous reflection's snapshot time. On a
 * warm machine an ingest and a reflection complete inside the same
 * millisecond, so a first draft of this suite was flaky across runs — three
 * tests changed outcome depending on how the clock fell.
 *
 * A race is not a specification, so every ingest below is separated from every
 * reflection by a real tick. What that flakiness EXPOSED is worth recording,
 * because production hits it far more often than a test does: `runPostTurn`
 * ingests and reflects in the same tick, so on a cadence turn a freshly
 * written fact routinely shares a millisecond with the snapshot, and `<` then
 * re-reports its contradiction on the FOLLOWING reflection. One duplicate,
 * self-correcting, idempotent at the applier (archived → archived is a no-op
 * transition) — it inflates `metrics.obsoleted` and logs a line twice.
 *
 * It is also the right direction to be wrong in. `<=` would silence the
 * duplicate but permanently skip any fact written microseconds AFTER a
 * snapshot inside the same millisecond, because the reflection clock only
 * moves forward. For an understanding engine, noticing a contradiction twice
 * beats never noticing it.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-reflconv-'));

const Brain = await import('../index.js');
const ES    = await import('../../files/evidenceStore.js');
const LC    = await import('../../pic/knowledgeLifecycle.js');
const G     = await import('../../reasoning/reasoningGraph.js');
const PIC   = await import('../../pic/core.js');
const RV2   = await import('../reflectionV2/index.js');
const { createEvidence, createFact } = await import('../../files/evidence.js');

const O = 'user:ananya';

// A negation pair: same entities and nouns, one carries a NEG token. Six
// shared words of length ≥3 clears the detector's overlap ≥4 bar.
const CLAIM   = 'Priya Sharma owns the billing service at Aquiplex.';
const COUNTER = 'Priya Sharma does not own the billing service at Aquiplex.';

/** Guarantee the millisecond clock advances between phases. See header. */
const tick = () => new Promise(r => setTimeout(r, 2));

function onFlags({ facts = true } = {}) {
  process.env.AQUA_BRAIN_INGEST = 'on';
  if (facts) process.env.AQUA_BRAIN_INGEST_FACTS = 'on';
}

/** Distinct turns get distinct source ids — which is what "cross-file" means here. */
function ingest(n, userMessage, { expectFacts = true } = {}) {
  const r = Brain.observeConversationTurn({
    ownerId: O, conversationId: 'c-reflect', turn: n,
    userMessage, assistantMessage: 'Noted.',
  });
  if (expectFacts) assert.ok(r.facts > 0, `turn ${n} wrote a fact`);
  else assert.equal(r.facts, 0, `turn ${n} wrote no facts`);
  return r;
}

beforeEach(() => {
  G._resetGraphForTests();
  ES._resetEvidenceStoreForTests();
  PIC._resetPICForTests();
  RV2._resetReflectionV2ForTests();
});

afterEach(() => {
  delete process.env.AQUA_BRAIN_INGEST;
  delete process.env.AQUA_BRAIN_INGEST_FACTS;
  delete process.env.AQUA_REFLECT_V2;
});

// ── The core claim ──────────────────────────────────────────────────────────

test('a later turn contradicting an earlier one is detected as obsolescence', async () => {
  onFlags();

  ingest(1, CLAIM);
  await tick();
  Brain.reflectTurn(O);                       // baseline; sets `since`
  await tick();

  ingest(2, COUNTER);
  await tick();
  const { delta } = Brain.reflectTurn(O);

  assert.ok(delta, 'a delta was produced');
  assert.ok(delta.obsoleted.length > 0,
    'reflection noticed the contradiction — structurally impossible before Phase 4');

  const [o] = delta.obsoleted;
  assert.match(ES.getFact(O, o.factId).statement, /owns the billing/);
  assert.match(ES.getFact(O, o.supersededBy).statement, /does not own/);
  assert.match(o.reason, /negation conflict/);
});

test('the revised assumption records what changed, in the user\'s own words', async () => {
  onFlags();
  ingest(1, CLAIM);
  await tick();
  Brain.reflectTurn(O);
  await tick();
  ingest(2, COUNTER);
  await tick();

  const { delta } = Brain.reflectTurn(O);
  assert.ok(delta.assumptionsRevised.length > 0);

  const [a] = delta.assumptionsRevised;
  assert.match(a.from, /owns the billing/);
  assert.match(a.to, /does not own/);
});

// ── The cross-source case — the actual prize ────────────────────────────────

test('a chat claim can contradict a DOCUMENT, not just another turn', async () => {
  onFlags();

  const ev = createEvidence({
    sourceFileId: 'uko:handbook', sourceFileName: 'handbook.pdf',
    sourceType: 'document', extractionMethod: 'text-layer',
    confidence: 0.9, snippet: CLAIM,
  });
  ES.saveEvidence(O, ev);
  ES.saveFact(O, createFact({
    statement: CLAIM, entities: ['Priya Sharma', 'Aquiplex'],
    evidence: [ev], confidence: 0.9,
  }), { sourceFileId: 'uko:handbook' });

  await tick();
  Brain.reflectTurn(O);                       // baseline
  await tick();

  ingest(1, COUNTER);                         // the user says otherwise
  await tick();
  const { delta } = Brain.reflectTurn(O);

  assert.ok(delta.obsoleted.length > 0,
    'chat can contradict a document — corroborate/contradict on one node');
  assert.match(ES.getFact(O, delta.obsoleted[0].supersededBy).statement, /does not own/,
    'the conversational claim is the newer one');
});

// ── Application is reversible, as reflectionV2 promised ─────────────────────

test('applying the delta archives reversibly and destroys nothing', async () => {
  onFlags();
  process.env.AQUA_REFLECT_V2 = 'on';

  ingest(1, CLAIM);
  await tick();
  Brain.reflectTurn(O);
  await tick();
  ingest(2, COUNTER);
  await tick();

  const { delta, applied } = Brain.reflectTurn(O);
  assert.equal(applied, true, 'applied, not dry-run');

  const obsoletedId = delta.obsoleted[0].factId;
  assert.ok(ES.getFact(O, obsoletedId),
    'the superseded fact is still in the store — archived, not deleted');
  assert.equal(LC.getLifecycle(O, `fact:${obsoletedId}`).state, 'archived');
});

test('with the flag off the delta is still computed as a dry-run', async () => {
  onFlags();
  ingest(1, CLAIM);
  await tick();
  Brain.reflectTurn(O);
  await tick();
  ingest(2, COUNTER);
  await tick();

  const { delta, applied } = Brain.reflectTurn(O);
  assert.equal(applied, false, 'nothing applied');
  assert.ok(delta.obsoleted.length > 0, 'but the observation is still available');
  assert.notEqual(LC.getLifecycle(O, `fact:${delta.obsoleted[0].factId}`)?.state, 'archived');
});

// ── Conservatism ────────────────────────────────────────────────────────────

test('a standing contradiction stops being reported once time has moved on', async () => {
  onFlags();
  ingest(1, CLAIM);
  ingest(2, COUNTER);
  await tick();
  Brain.reflectTurn(O);                       // first sight — `since` was 0
  await tick();

  const { delta } = Brain.reflectTurn(O);
  assert.equal(delta.obsoleted.length, 0,
    'nothing NEW arrived, so it is a standing disagreement, not fresh obsolescence');
});

// ── NEGATIVE CONTROL — the test that gives the others meaning ───────────────

test('without conversational fact ingest, reflection is blind again', async () => {
  onFlags({ facts: false });                  // entity ingest on, fact ingest OFF

  ingest(1, CLAIM, { expectFacts: false });
  await tick();
  Brain.reflectTurn(O);
  await tick();
  ingest(2, COUNTER, { expectFacts: false });
  await tick();

  const { delta } = Brain.reflectTurn(O);
  assert.equal(ES.listFacts(O, { limit: 10 }).length, 0, 'no conversational facts exist');
  assert.equal(delta.obsoleted.length, 0,
    'exactly the M2 blindness the audit described — the fact writes are what closed it');
});
