/**
 * B2 — THE THREE INERT CONTEXT-ENGINE DIMENSIONS. PINNED, NOT FIXED.
 *
 * Measured in the STEP 0 audit and re-verified against this tree:
 *
 *   active_project          weight 0.10   always 0 in production
 *   conversation_continuity weight 0.05   always 0 in production
 *   source_reliability      weight 0.08   constant 1.0 for every PIC fact
 *
 * WHY THESE ARE NOT BEING FIXED HERE
 * ----------------------------------
 * The post-PR-1 re-audit measured the assembler selecting 100% of its
 * candidate pool at every session length tested — 3/3, 9/9, 18/18 — with
 * `dropReasons` empty and the char budget at 31% of its ceiling. Ranking
 * changes the ORDER of a list; a list that is emitted whole has no order worth
 * changing. Repairing 0.23 of the weight vector cannot change what reaches the
 * model until the pool is large enough that `limit`, `minScore` or the budget
 * actually bind.
 *
 * There is also no context-selection eval. FINDING-1, FINDING-2 and EVAL-2 all
 * made the same call for the same reason: a repair to a ranking rule with no
 * instrument to measure it is a guess, and "it looks better in the case I was
 * staring at" is what L14 exists to replace.
 *
 * So these are recorded as INVERTING assertions, the mechanism E1's ratio
 * ceiling, E3/PR-10's write shape, FINDING-1 and FINDING-2 all use: each test
 * asserts the CURRENT broken behaviour and FAILS when someone fixes it. That
 * turns a future repair into a deliberate, noticed event with a test to update,
 * rather than a change that quietly lands and is never measured.
 *
 * Run: node --test src/brain/tests/contextDimensionPins.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { scoreCandidate, DIMENSION_WEIGHTS, tokensOf } =
  await import('../contextEngine/scorer.js');

const CANDIDATE = Object.freeze({
  id: 'f1',
  text: 'Ananya is rebuilding the AQUIPLEX landing page this week.',
  confidence: 0.8, timestamp: Date.now(),
  sourceType: 'conversation',
  entityIds: ['e:aquiplex'], hops: 0, importance: 0.6,
});

/** The signal bag exactly as chat.js:588 causes it to be built. */
const productionBag = (activeProjectId = null) => ({
  queryTokens: new Set(['aquiplex']),
  semanticScores: null,
  activeProjectTokens: activeProjectId ? tokensOf(activeProjectId) : new Set(),
  activeGoalTokens: new Set(),
  focusEntityIds: new Set(),
  // chat.js never passes priorEntityIds; contextEngine/index.js:204 defaults it.
  priorEntityIds: new Set(),
  maxHops: 2,
});

test('B2a — active_project cannot fire on a workspace id, and the TOKENIZER is why', () => {
  // The obvious reading is "the id is opaque". It is worse than that: the
  // tokenizer's character class `/[a-z0-9][\w\-.]{1,}/g` treats hyphens and
  // dots as INTERNAL characters, so even a human-readable project slug comes
  // back as one unsplit token and can never match candidate text.
  assert.deepEqual([...tokensOf('ws-aquiplex-landing')], ['ws-aquiplex-landing'],
    'a descriptive slug does not split — so handing the engine a real project NAME instead of an id fixes only half of this');

  for (const workspaceId of ['ws_8f3c1a92-4d61-4b0e-9a77', 'ws-aquiplex-landing', 'workspace.aquiplex.landing']) {
    const { dimensions } = scoreCandidate(CANDIDATE, productionBag(workspaceId));
    assert.equal(dimensions.active_project, 0,
      `active_project is inert for workspaceId=${workspaceId} — INVERT THIS TEST when the signal is fixed`);
  }

  // The dimension itself is not broken. Given a bare label it works, which is
  // what makes this a WIRING defect rather than a scoring one.
  assert.equal(scoreCandidate(CANDIDATE, productionBag('aquiplex')).dimensions.active_project, 1,
    'the scorer is correct when handed a term that appears in the text');
});

test('B2b — conversation_continuity is plumbed end to end and never supplied', () => {
  const { dimensions } = scoreCandidate(CANDIDATE, productionBag());
  assert.equal(dimensions.conversation_continuity, 0,
    'continuity is 0 because chat.js:588 never passes priorEntityIds — INVERT THIS TEST when it does');

  // Prove the dimension works, so a future reader does not "fix" the scorer.
  const withPrior = { ...productionBag(), priorEntityIds: new Set(['e:aquiplex']) };
  assert.equal(scoreCandidate(CANDIDATE, withPrior).dimensions.conversation_continuity, 1,
    'the scorer computes continuity correctly the moment a caller supplies the signal');
});

test('B2c — PIC facts are labelled `document`, so source_reliability is a constant', () => {
  // contextEngine/index.js:121 hardcodes sourceType:'document' for every PIC
  // fact, and normFact defaults the same way. Conversational evidence
  // therefore scores 1.0 — the top of the scale — which is what blueprint §12
  // and D2 forbid. It is not mis-ranked; it carries no ordering information
  // at all, which is the more useful way to state it.
  const seen = new Set();
  for (const sourceType of ['document', 'conversation', 'inferred', 'derived', undefined]) {
    seen.add(scoreCandidate({ ...CANDIDATE, sourceType }, productionBag()).dimensions.source_reliability);
  }
  assert.ok(seen.size > 1,
    'the scorer DOES distinguish source types — so the defect is upstream, at the label, not here');

  assert.equal(scoreCandidate({ ...CANDIDATE, sourceType: 'document' }, productionBag()).dimensions.source_reliability, 1,
    'and everything PIC produces arrives wearing this label — INVERT THIS TEST when provenance survives into the candidate');
});

test('B2 — the inert weight is 0.15, and a further 0.08 carries no signal', () => {
  const dead = DIMENSION_WEIGHTS.active_project + DIMENSION_WEIGHTS.conversation_continuity;
  const constant = DIMENSION_WEIGHTS.source_reliability;
  assert.equal(Number(dead.toFixed(2)), 0.15, 'structurally dead weight');
  assert.equal(Number(constant.toFixed(2)), 0.08, 'non-discriminating weight');
  assert.equal(Number((dead + constant).toFixed(2)), 0.23,
    'just under a quarter of the weight vector — recorded so a future rebalancing cannot quietly change the arithmetic this finding rests on');

  const total = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Number(total.toFixed(4)), 1,
    'weights still sum to 1 — if this fails the percentages above stop meaning what they say');
});
