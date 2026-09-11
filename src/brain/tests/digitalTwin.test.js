/**
 * Brain V1 / B6 — Digital Twin extension.
 *
 * The guarantees under test:
 *   SIX PATTERNS    writing style, coding style, working hours, learning
 *                   preference, product philosophy, engineering philosophy —
 *                   the ones the Mind did not already infer.
 *   NEVER FABRICATED no textual trigger ⇒ no signal. No priors, no inference
 *                   from absence, and one phrase can never establish a claim.
 *   THREE REQUIRED  every reported inference carries confidence, supporting
 *                   evidence, and lastVerified. The brief's hard requirement.
 *   LAST VERIFIED   distinct from lastEvidenceAt — a belief argued against has
 *                   a fresh lastEvidenceAt and a STALE lastVerified.
 *   TRENDS          confidence direction is read from the evidence window.
 *   ONE WRITER      signals route through beliefEngine.observeSignal; the new
 *                   patterns decay/contradict/version like the existing seven.
 *   OFF BY DEFAULT  AQUA_TWIN_V2=on; the read side works regardless.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-b6-'));
process.env.AQUA_DATA_DIR = TMP;

const { inferTwinSignals } = await import('../digitalTwin/patternInferrer.js');
const TS = await import('../digitalTwin/twinSchema.js');
const DT = await import('../digitalTwin/index.js');
const { createBelief, beliefKey, DIMENSIONS } = await import('../../mind/mindSchema.js');
const { observeSignal, observeSignals } = await import('../../mind/beliefEngine.js');

/** A bare Mind, shaped as mindStore holds it — enough for the belief writer. */
function makeMind(ownerId = 'o') {
  return { ownerId, beliefs: {}, goals: {}, graph: { nodes: {}, edges: {} }, timeline: [], turnCount: 0, updatedAt: Date.now() };
}

beforeEach(() => { process.env.AQUA_TWIN_V2 = 'on'; delete process.env.AQUA_BRAIN; });
afterEach(() => { delete process.env.AQUA_TWIN_V2; delete process.env.AQUA_BRAIN; });

// ── SIX PATTERNS ─────────────────────────────────────────────────────────────

test('SIX PATTERNS: every pattern the brief names that the Mind lacked is defined', () => {
  for (const p of ['writing_style', 'coding_style', 'working_hours', 'learning_preference',
    'product_philosophy', 'engineering_philosophy']) {
    assert.ok(TS.TWIN_PATTERNS[p], `missing pattern ${p}`);
    assert.ok(TS.TWIN_PATTERNS[p].dimension, `${p} must map onto an existing Mind dimension`);
  }
  assert.equal(TS.TWIN_PATTERN_KEYS.length, 6);
});

test('patterns map onto EXISTING Mind dimensions — no schema change required', () => {
  const valid = new Set(Object.values(DIMENSIONS));
  for (const spec of Object.values(TS.TWIN_PATTERNS)) {
    assert.ok(valid.has(spec.dimension), `${spec.dimension} is not an existing dimension`);
  }
});

test('each pattern is inferable from a matching turn', () => {
  const cases = {
    coding_style:           'I always write the tests first, red-green-refactor',
    learning_preference:    'can you show me an example first before the theory',
    product_philosophy:     "let's ship it fast, we can iterate later",
    engineering_philosophy: 'keep it simple, avoid the extra abstraction here',
    writing_style:          '- first point here\n- second point here\n- third point',
  };
  for (const [pattern, text] of Object.entries(cases)) {
    const sigs = inferTwinSignals({ userMessage: text });
    assert.ok(sigs.some(s => s.key === pattern), `${pattern} not inferred from: ${text}`);
  }
});

test('working_hours is inferred from turn time, bucketed rather than overfitted', () => {
  const at = new Date(2026, 0, 15, 2, 14).getTime();  // 02:14 local
  const sigs = inferTwinSignals({ userMessage: 'here is a reasonably substantial question about the architecture', at });
  const wh = sigs.find(s => s.key === 'working_hours');
  assert.ok(wh, 'working_hours emitted');
  assert.equal(wh.value, 'night', 'bucketed, not an exact schedule claim');
  assert.match(wh.note, /02:00/, 'the observation itself is recorded as evidence');
});

// ── NEVER FABRICATED ─────────────────────────────────────────────────────────

test('NEVER FABRICATED: no textual trigger produces no signal', () => {
  assert.deepEqual(inferTwinSignals({ userMessage: '' }), []);
  assert.deepEqual(inferTwinSignals({ userMessage: '   ' }), []);
  // A substantive but pattern-free message yields only the time observation,
  // which is a fact about the turn — never a style or philosophy claim.
  const sigs = inferTwinSignals({ userMessage: 'What is the capital city of France, and when was it founded?' });
  assert.ok(sigs.every(s => s.key === 'working_hours'), `unexpected inference: ${JSON.stringify(sigs.map(s => s.key))}`);
});

test('NEVER FABRICATED: short chatter does not vote on the user\'s routine', () => {
  assert.deepEqual(inferTwinSignals({ userMessage: 'ok thanks' }), []);
  assert.deepEqual(inferTwinSignals({ userMessage: 'yep' }), []);
});

test('NEVER FABRICATED: every signal carries the observation that triggered it', () => {
  const sigs = inferTwinSignals({ userMessage: 'I write the tests first and keep it simple' });
  assert.ok(sigs.length >= 2);
  for (const s of sigs) {
    assert.ok(s.note && s.note.length > 0, `signal ${s.key} has no traceable evidence`);
    assert.ok(s.strength <= 0.6, `signal ${s.key} strength ${s.strength} too strong for one observation`);
  }
});

test('NEVER FABRICATED: one observation cannot establish a claim about the user', () => {
  const mind = makeMind();
  observeSignals(mind, inferTwinSignals({ userMessage: "let's ship it fast and iterate later" }));
  const view = DT.twinView({ peekMind: () => mind }, 'o');
  assert.equal(view.inferences.length, 0, 'nothing reported from a single phrase');
  assert.ok(view.tentative > 0, 'but the evidence IS being accumulated');
});

test('competing evidence is emitted as competing signals, not resolved here', () => {
  const sigs = inferTwinSignals({ userMessage: "ship it fast, but let's get this right and polish it" });
  const values = sigs.filter(s => s.key === 'product_philosophy').map(s => s.value);
  assert.ok(values.includes('ship_fast') && values.includes('polish_first'),
    'both signals emitted — the Mind\'s contradiction handling settles it');
});

// ── THE THREE REQUIRED FIELDS ────────────────────────────────────────────────

test('THREE REQUIRED: a reported inference carries confidence, evidence, lastVerified', () => {
  const mind = makeMind();
  // Three independent observations clear the bar.
  for (let i = 0; i < 4; i++) {
    observeSignals(mind, inferTwinSignals({ userMessage: 'I always write the tests first here', conversationId: `c${i}` }));
  }
  const view = DT.twinView({ peekMind: () => mind }, 'o');
  const coding = view.inferences.find(i => i.pattern === 'coding_style');
  assert.ok(coding, 'pattern now reported');
  assert.ok(coding.confidence > 0, 'confidence present');
  assert.ok(Array.isArray(coding.evidence) && coding.evidence.length > 0, 'supporting evidence present');
  assert.ok(coding.evidence[0].observed, 'and traceable to a concrete observation');
  assert.ok(coding.lastVerified, 'lastVerified present');
  assert.ok('trend' in coding, 'confidence trend present');
});

test('the inference bar requires BOTH evidence count and confidence', () => {
  const weak = createBelief({ dimension: DIMENSIONS.BEHAVIOR, key: 'coding_style', value: 'x', confidence: 0.9 });
  weak.evidenceCount = 1;
  assert.equal(TS.meetsInferenceBar(weak), false, 'high confidence alone is not enough');

  const shallow = createBelief({ dimension: DIMENSIONS.BEHAVIOR, key: 'coding_style', value: 'x', confidence: 0.2 });
  shallow.evidenceCount = 10;
  assert.equal(TS.meetsInferenceBar(shallow), false, 'volume alone is not enough');

  const good = createBelief({ dimension: DIMENSIONS.BEHAVIOR, key: 'coding_style', value: 'x', confidence: 0.6 });
  good.evidenceCount = 4;
  assert.equal(TS.meetsInferenceBar(good), true);
});

// ── LAST VERIFIED ────────────────────────────────────────────────────────────

test('LAST VERIFIED is distinct from lastEvidenceAt when a belief is contradicted', () => {
  const belief = createBelief({ dimension: DIMENSIONS.DECISION, key: 'product_philosophy', value: 'ship_fast', confidence: 0.5 });
  belief.evidence = [
    { ts: 1000, signal: 'favoured shipping speed', delta: 0.1,  support: true },   // confirmed
    { ts: 5000, signal: 'favoured polish',         delta: -0.1, support: false },  // contradicted
    { ts: 9000, signal: 'favoured polish',         delta: -0.1, support: false },  // contradicted again
  ];
  const verified = TS.lastVerifiedAt(belief);
  assert.equal(verified, 1000, 'lastVerified stays at the last CONFIRMATION');
  assert.notEqual(verified, 9000, 'not the last time anything touched the belief');
});

test('a supporting signal at the confidence ceiling still counts as verification', () => {
  const belief = createBelief({ dimension: DIMENSIONS.BEHAVIOR, key: 'coding_style', value: 'tests_first' });
  belief.evidence = [{ ts: 1000, delta: 0.2, support: true }, { ts: 7000, delta: 0, support: true }];
  assert.equal(TS.lastVerifiedAt(belief), 7000, 'delta 0 with support is still confirmation, not staleness');
});

test('lastVerified is null when nothing in the window ever confirmed the belief', () => {
  const belief = createBelief({ dimension: DIMENSIONS.DECISION, key: 'product_philosophy', value: 'x' });
  belief.evidence = [{ ts: 1000, delta: -0.1, support: false }];
  assert.equal(TS.lastVerifiedAt(belief), null);
  assert.equal(TS.daysSinceVerified(belief), null);
});

// ── CONFIDENCE TRENDS ────────────────────────────────────────────────────────

test('TRENDS: rising, falling and stable are read from the evidence window', () => {
  const mk = (deltas) => {
    const b = createBelief({ dimension: DIMENSIONS.BEHAVIOR, key: 'coding_style', value: 'x' });
    b.evidence = deltas.map((d, i) => ({ ts: 1000 * (i + 1), delta: d, support: d >= 0 }));
    return b;
  };
  assert.equal(TS.confidenceTrend(mk([0.1, 0.1, 0.05])).direction, 'rising');
  assert.equal(TS.confidenceTrend(mk([-0.1, -0.1, -0.05])).direction, 'falling');
  assert.equal(TS.confidenceTrend(mk([0.1, -0.1])).direction, 'stable');
  assert.equal(TS.confidenceTrend(mk([0.1])).direction, 'stable', 'one sample is not a trend');
});

test('TRENDS: a belief being argued against trends falling even while still confident', () => {
  const b = createBelief({ dimension: DIMENSIONS.DECISION, key: 'product_philosophy', value: 'ship_fast', confidence: 0.8 });
  b.evidence = [{ ts: 1, delta: -0.05, support: false }, { ts: 2, delta: -0.05, support: false }];
  const trend = TS.confidenceTrend(b);
  assert.equal(trend.direction, 'falling', 'the early warning the brief asks for');
  assert.ok(b.confidence > 0.5, 'even though absolute confidence is still high');
});

// ── ONE WRITER ───────────────────────────────────────────────────────────────

test('ONE WRITER: patterns contradict and version exactly like existing dimensions', () => {
  const mind = makeMind();
  // Establish ship_fast.
  for (let i = 0; i < 5; i++) observeSignal(mind, { dimension: DIMENSIONS.DECISION, key: 'product_philosophy', value: 'ship_fast', strength: 0.5, note: 'favoured shipping speed' });
  const bk = beliefKey(DIMENSIONS.DECISION, 'product_philosophy');
  assert.equal(mind.beliefs[bk].value, 'ship_fast');

  // Now argue the other way, repeatedly — the Mind's own contradiction path
  // must take over. B6 wrote no bespoke logic for this.
  for (let i = 0; i < 8; i++) observeSignal(mind, { dimension: DIMENSIONS.DECISION, key: 'product_philosophy', value: 'polish_first', strength: 0.6, note: 'favoured polish' });
  assert.ok(mind.beliefs[bk].contradictions > 0, 'contradictions tracked by the existing engine');
  assert.ok(mind.beliefs[bk].history.length > 0 || mind.beliefs[bk].value === 'polish_first', 'value versioned or superseded by the existing engine');
});

test('ONE WRITER: observeTwinTurn routes through the injected writer, never direct mutation', () => {
  const mind = makeMind();
  const calls = [];
  const out = DT.observeTwinTurn(
    { getMind: () => mind, observeSignals: (m, sigs) => { calls.push(sigs); return sigs.map(() => ({})); } },
    { ownerId: 'o', userMessage: 'I write the tests first and keep it simple', conversationId: 'c1' },
  );
  assert.ok(out.ok);
  assert.equal(calls.length, 1, 'exactly one batched call to the belief writer');
  assert.ok(calls[0].length > 0);
  assert.deepEqual(mind.beliefs, {}, 'the twin layer itself mutated nothing');
});

// ── SWITCHES + FAIL-OPEN ─────────────────────────────────────────────────────

test('OFF BY DEFAULT: without AQUA_TWIN_V2 observation is inert', () => {
  delete process.env.AQUA_TWIN_V2;
  assert.equal(DT.twinV2Enabled(), false);
  const out = DT.observeTwinTurn({ getMind: () => makeMind(), observeSignals: () => [] },
    { ownerId: 'o', userMessage: 'I write the tests first' });
  assert.equal(out.skipped, 'disabled');
});

test('the read-side kill switch also disables twin observation', () => {
  process.env.AQUA_BRAIN = 'off';
  assert.equal(DT.twinV2Enabled(), false);
});

test('the twin VIEW works regardless of the observation switch — it only reads', () => {
  delete process.env.AQUA_TWIN_V2;
  const mind = makeMind();
  const b = createBelief({ dimension: DIMENSIONS.BEHAVIOR, key: 'coding_style', value: 'tests_first', confidence: 0.7 });
  b.evidenceCount = 5;
  b.evidence = [{ ts: 1000, signal: 'described test-first workflow', delta: 0.1, support: true }];
  mind.beliefs[beliefKey(DIMENSIONS.BEHAVIOR, 'coding_style')] = b;

  const view = DT.twinView({ peekMind: () => mind }, 'o');
  assert.equal(view.inferences.length, 1);
  assert.equal(view.inferences[0].value, 'tests_first');
});

test('FAIL-OPEN: a broken Mind returns ok:false instead of throwing', () => {
  const out = DT.observeTwinTurn({ getMind: () => { throw new Error('boom'); }, observeSignals: () => [] },
    { ownerId: 'o', userMessage: 'I write the tests first and keep it simple' });
  assert.equal(out.ok, false);
  assert.ok(out.error);
});

test('twinView on an owner with no Mind is empty, not an error', () => {
  assert.deepEqual(DT.twinView({ peekMind: () => null }, 'nobody'),
    { inferences: [], tentative: 0, patternsCovered: 0 });
});

test('includeTentative surfaces below-bar patterns, flagged as tentative', () => {
  const mind = makeMind();
  observeSignals(mind, inferTwinSignals({ userMessage: "let's ship it fast" }));
  const view = DT.twinView({ peekMind: () => mind }, 'o', { includeTentative: true });
  assert.ok(view.inferences.length > 0);
  assert.ok(view.inferences.every(i => i.tentative), 'all flagged — none presented as established knowledge');
});

test('writing style needs actual writing — a terse acknowledgment is turn-taking, not prose', () => {
  assert.deepEqual(inferTwinSignals({ userMessage: 'yep' }), [], 'a protocol token votes on nothing');
  // But a real casual message IS observable.
  const sigs = inferTwinSignals({ userMessage: 'yeah I reckon that approach is gonna work fine for what we need here' });
  assert.ok(sigs.some(s => s.key === 'writing_style' && s.value === 'casual'));
});

test('content-bearing patterns are exempt from the length gate — a brief position is still a position', () => {
  const sigs = inferTwinSignals({ userMessage: 'ship it fast' });
  assert.ok(sigs.some(s => s.key === 'product_philosophy' && s.value === 'ship_fast'));
  assert.ok(!sigs.some(s => s.key === 'working_hours'), 'but it does not vote on the routine');
});

test('test-first is recognised across plural and gerund phrasings (recall gap found in demo)', () => {
  for (const phrasing of [
    'I always write the tests first before implementing',
    'writing the tests first again on this module today',
    'tests first on the parser too, same as usual here',
    'doing test-first on this one as well, keeps me honest',
    'going with TDD for the whole serializer rewrite here',
  ]) {
    const sigs = inferTwinSignals({ userMessage: phrasing });
    assert.ok(sigs.some(s => s.key === 'coding_style' && s.value === 'tests_first'),
      `missed test-first in: ${phrasing}`);
  }
  // And it must not fire on the opposite posture.
  const after = inferTwinSignals({ userMessage: 'I will backfill tests later once the shape settles down' });
  assert.ok(after.some(s => s.value === 'tests_after'));
  assert.ok(!after.some(s => s.value === 'tests_first'), 'tests-after must not read as tests-first');
});
