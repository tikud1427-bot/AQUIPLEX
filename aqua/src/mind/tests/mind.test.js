/**
 * Mind layer tests (node:test).
 * Run: node --test src/mind/tests/mind.test.js
 *
 * Uses in-memory minds via _clearAllForTests(); disk writes are debounced
 * and harmless in CI, but tests never depend on them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyMind, DIMENSIONS, GOAL_STATUS, STATUS, beliefKey } from '../mindSchema.js';
import { reinforce, contradict, decay, isEstablished, clamp01 } from '../confidence.js';
import { _clearAllForTests, getMind, resolveMindOwner, exportMind, deleteMind } from '../mindStore.js';
import { observeSignal, observeSignals, correctBelief, lockBelief, deleteBelief, explainBelief, getBeliefs } from '../beliefEngine.js';
import { observeTurn, observeReaction } from '../observers.js';
import { trackGoals, getActiveGoals, goalSimilarity } from '../goalTracker.js';
import { updateWorkingMemory, currentFocus, decayWorkingMemory } from '../workingMemory.js';
import { trackEpisode, closeStaleEpisodes } from '../episodeTracker.js';
import { updateGraph, neighborhood, SELF_KEY, organizationView } from '../relationshipGraph.js';
import { rebuildPredictions } from '../predictionEngine.js';
import { reflect, shouldReflect, REFLECT_EVERY_TURNS } from '../reflectionEngine.js';
import { retrieveCognitiveContext } from '../mindRetriever.js';
import { mindObserve, mindContext, mindAfterTurn } from '../index.js';

function freshMind(owner = 'user:test') {
  _clearAllForTests();
  return getMind(owner);
}

// ── Confidence math (Layer 11) ────────────────────────────────────────────────

test('confidence: reinforce is asymptotic, never reaches 1', () => {
  let c = 0.3;
  for (let i = 0; i < 200; i++) c = reinforce(c, 0.1, 1);
  assert.ok(c > 0.95 && c < 1, `expected asymptote below 1, got ${c}`);
});

test('confidence: contradiction lowers but never zeroes', () => {
  let c = 0.9;
  for (let i = 0; i < 50; i++) c = contradict(c, 1);
  assert.ok(c >= 0.05, `floor violated: ${c}`);
});

test('confidence: decay respects established floor', () => {
  const month = 30 * 24 * 3600 * 1000;
  const decayed = decay(0.9, 0.004, 12 * month, { established: true });
  assert.ok(decayed >= 0.4, 'established beliefs must keep a floor');
  const gone = decay(0.5, 0.02, 12 * month, { established: false });
  assert.equal(gone, 0);
});

test('confidence: clamp handles NaN/Infinity', () => {
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01(Infinity), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(-1), 0);
});

// ── Belief engine (Layers 1–4, 17, 18) ────────────────────────────────────────

test('beliefs: repeated same-value signals raise confidence, count evidence', () => {
  const mind = freshMind();
  let b;
  for (let i = 0; i < 5; i++) {
    b = observeSignal(mind, { dimension: DIMENSIONS.PREFERENCES, key: 'design_style', value: 'minimal', strength: 0.7, note: 'rejected flashy layout' });
  }
  assert.equal(b.value, 'minimal');
  assert.equal(b.evidenceCount, 5);
  assert.ok(b.confidence > 0.5, `confidence grew: ${b.confidence}`);
});

test('beliefs: contradiction lowers confidence, preserves history, can flip value', () => {
  const mind = freshMind();
  for (let i = 0; i < 6; i++) {
    observeSignal(mind, { dimension: DIMENSIONS.PREFERENCES, key: 'editor', value: 'vim', strength: 0.8 });
  }
  const before = mind.beliefs[beliefKey(DIMENSIONS.PREFERENCES, 'editor')];
  const confBefore = before.confidence;

  // Strong repeated evidence for a different value
  let b;
  for (let i = 0; i < 8; i++) {
    b = observeSignal(mind, { dimension: DIMENSIONS.PREFERENCES, key: 'editor', value: 'cursor', strength: 0.9 });
  }
  assert.equal(b.value, 'cursor', 'value flips when challenger overtakes');
  assert.ok(b.history.length >= 1, 'old value versioned into history — never silently overwritten');
  assert.equal(b.history[0].value, 'vim');
  assert.ok(b.contradictions > 0);
  assert.ok(confBefore > 0.4, 'sanity: original had real confidence');
});

test('beliefs: pure contradiction (support=false) cannot create a belief', () => {
  const mind = freshMind();
  const b = observeSignal(mind, { dimension: DIMENSIONS.COMMUNICATION, key: 'assistant_fit', value: 'aligned', support: false });
  assert.equal(b, null);
});

test('beliefs: locked beliefs immune to inference (Layer 18)', () => {
  const mind = freshMind();
  observeSignal(mind, { dimension: DIMENSIONS.PREFERENCES, key: 'os', value: 'linux', strength: 0.9 });
  lockBelief(mind, DIMENSIONS.PREFERENCES, 'os', true);
  const locked = mind.beliefs[beliefKey(DIMENSIONS.PREFERENCES, 'os')];
  const conf = locked.confidence;
  for (let i = 0; i < 10; i++) {
    observeSignal(mind, { dimension: DIMENSIONS.PREFERENCES, key: 'os', value: 'windows', strength: 1 });
  }
  assert.equal(locked.value, 'linux');
  assert.equal(locked.confidence, conf);
});

test('beliefs: user correction dominates and is audited (Layers 17+18)', () => {
  const mind = freshMind();
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'designer', strength: 0.5 });
  const b = correctBelief(mind, DIMENSIONS.IDENTITY, 'profession', 'founder');
  assert.equal(b.value, 'founder');
  assert.ok(b.confidence >= 0.9);
  assert.equal(b.privacy.source, 'correction');
  assert.equal(b.history[0].value, 'designer');

  const ex = explainBelief(b);
  assert.match(ex.explanation, /Set explicitly by the user/);
  assert.match(ex.explanation, /Previously believed/);
});

test('beliefs: explainability cites evidence counts and conversations (Layer 17)', () => {
  const mind = freshMind();
  for (let i = 0; i < 4; i++) {
    observeSignal(mind, { dimension: DIMENSIONS.PREFERENCES, key: 'design_style', value: 'minimal', strength: 0.7, note: 'rejected flashy option', conversationId: `conv-${i}` });
  }
  const ex = explainBelief(mind.beliefs[beliefKey(DIMENSIONS.PREFERENCES, 'design_style')]);
  assert.match(ex.explanation, /4 observations across 4 conversations/);
  assert.match(ex.explanation, /rejected flashy option/);
});

test('beliefs: deleteBelief removes entirely (user owns model)', () => {
  const mind = freshMind();
  observeSignal(mind, { dimension: DIMENSIONS.KNOWLEDGE, key: 'tech:react', value: 'working_knowledge' });
  assert.ok(deleteBelief(mind, DIMENSIONS.KNOWLEDGE, 'tech:react'));
  assert.equal(mind.beliefs[beliefKey(DIMENSIONS.KNOWLEDGE, 'tech:react')], undefined);
});

// ── Observers (Observe → Infer) ───────────────────────────────────────────────

test('observers: task types map to identity traits', () => {
  const { signals } = observeTurn({ userMessage: 'design the module boundaries', taskType: 'architecture' });
  const keys = signals.map(s => `${s.dimension}:${s.key}`);
  assert.ok(keys.includes('identity:systems_thinker'));
});

test('observers: founder language + minimal-design rejection + tech mentions', () => {
  const { signals, hints } = observeTurn({
    userMessage: "Our investors want the demo simpler — it's too flashy. Keep it minimal. The React + Postgres stack stays.",
    taskType: 'planning',
  });
  const byKey = Object.fromEntries(signals.map(s => [`${s.dimension}:${s.key}`, s]));
  assert.ok(byKey['identity:founder'], 'founder hint detected');
  assert.equal(byKey['preferences:design_style'].value, 'minimal');
  assert.ok(hints.tech.includes('react') && hints.tech.includes('postgres'));
});

test('observers: fact bridge lifts extractor facts into belief signals', () => {
  const { signals } = observeTurn({
    userMessage: 'x',
    taskType: 'conversation',
    extractedFacts: [{ key: 'favorite_editor', value: 'cursor' }, { key: 'profession', value: 'engineer' }],
  });
  const bridge = signals.filter(s => s.source === 'fact_bridge');
  assert.equal(bridge.length, 2);
  assert.ok(bridge.some(s => s.dimension === DIMENSIONS.PREFERENCES && s.key === 'editor' && s.value === 'cursor'));
  assert.ok(bridge.some(s => s.dimension === DIMENSIONS.IDENTITY && s.key === 'profession'));
});

test('observers: pushback produces contradiction signal', () => {
  const signals = observeReaction({ userMessage: "No, that's not what I asked. Too verbose." });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].support, false);
});

// ── Goals (Layer 5) ───────────────────────────────────────────────────────────

test('goals: detect, re-mention strengthens instead of duplicating', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'My goal is to ship the investor demo by Friday.' });
  trackGoals(mind, { userMessage: "I'm working to ship the investor demo, almost there." });
  const goals = Object.values(mind.goals);
  assert.equal(goals.length, 1, 'fuzzy match prevented duplicate');
  assert.equal(goals[0].mentions, 2);
  assert.ok(goals[0].progress > 0, 'progress cue applied');
});

test('goals: completion + blocked cues update status with history', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'We plan to launch the billing migration this month.' });
  trackGoals(mind, { userMessage: 'Blocked on the Razorpay webhook approval for the billing migration.' });
  let g = Object.values(mind.goals)[0];
  assert.equal(g.status, GOAL_STATUS.BLOCKED);
  assert.ok(g.blockers.length >= 1);

  trackGoals(mind, { userMessage: 'Finally shipped the billing migration!' });
  g = Object.values(mind.goals)[0];
  assert.equal(g.status, GOAL_STATUS.COMPLETED);
  assert.equal(g.progress, 1);
  assert.ok(g.history.length >= 2);
});

test('goals: similarity metric sane', () => {
  assert.ok(goalSimilarity('ship the investor demo', 'ship investor demo by friday') >= 0.5);
  assert.ok(goalSimilarity('ship the investor demo', 'learn spanish cooking') < 0.5);
});

// ── Working memory (Layer 9) ──────────────────────────────────────────────────

test('working memory: focus accumulates and ranks; blockers/deadlines captured', () => {
  const mind = freshMind();
  updateWorkingMemory(mind, { userMessage: 'debugging the react hydration issue', taskType: 'debugging', hints: { tech: ['react'], deadlines: [] } });
  updateWorkingMemory(mind, { userMessage: 'still on react — stuck on the suspense boundary. Ship by Friday.', taskType: 'debugging', hints: { tech: ['react'], deadlines: [{ label: 'ship by Friday', ts: null, source: 'message' }] } });
  const focus = currentFocus(mind, 3);
  assert.equal(focus[0].topic === 'react' || focus[0].topic === 'debugging', true);
  assert.ok(mind.working.blockers.length >= 1);
  assert.equal(mind.working.deadlines.length, 1);
});

test('working memory: decay expires stale items', () => {
  const mind = freshMind();
  updateWorkingMemory(mind, { userMessage: 'stuck on cors', taskType: 'debugging', hints: {} });
  // Age everything by 8 days
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  mind.working.blockers.forEach(b => { b.lastSeenAt = old; b.addedAt = old; });
  mind.working.focus.forEach(f => { f.lastSeenAt = old; });
  decayWorkingMemory(mind);
  assert.equal(mind.working.blockers.length, 0);
  assert.equal(mind.working.focus.length, 0);
});

// ── Episodes (Layer 8) ────────────────────────────────────────────────────────

test('episodes: open on theme, accumulate conversations, close on outcome', () => {
  const mind = freshMind();
  updateWorkingMemory(mind, { userMessage: 'x', taskType: 'debugging', hints: { tech: ['docker'] } });
  const ep1 = trackEpisode(mind, { taskType: 'debugging', conversationId: 'c1', userMessage: 'container keeps crashing' });
  assert.equal(ep1.status, STATUS.ACTIVE);
  const ep2 = trackEpisode(mind, { taskType: 'debugging', conversationId: 'c2', userMessage: 'fixed it — solved, it works now' });
  assert.equal(ep1.id, ep2.id, 'same arc continued');
  assert.equal(ep2.status, STATUS.ARCHIVED);
  assert.ok(ep2.outcome);
  assert.deepEqual(ep2.conversationIds, ['c1', 'c2']);
});

test('episodes: stale episodes close at reflection', () => {
  const mind = freshMind();
  updateWorkingMemory(mind, { userMessage: 'x', taskType: 'coding', hints: { tech: ['rust'] } });
  const ep = trackEpisode(mind, { taskType: 'coding', conversationId: 'c1', userMessage: 'porting to rust' });
  ep.lastActivityAt = Date.now() - 6 * 24 * 3600 * 1000;
  const closed = closeStaleEpisodes(mind);
  assert.equal(closed, 1);
  assert.equal(ep.status, STATUS.ARCHIVED);
});

// ── Graph (Layers 7 + 16) ─────────────────────────────────────────────────────

test('graph: facts/tech/goals/workspace form a connected neighborhood', () => {
  const mind = freshMind();
  const goalsTouched = trackGoals(mind, { userMessage: 'My goal is to close the seed round.' });
  updateGraph(mind, {
    extractedFacts: [{ key: 'workplace', value: 'Aquiplex' }],
    hints: { tech: ['react'] },
    goalsTouched,
    workspaceId: 'ws-aqua',
  });
  const nb = neighborhood(mind, SELF_KEY, 2, 20);
  const labels = nb.nodes.map(n => n.label);
  assert.ok(labels.includes('Aquiplex'));
  assert.ok(labels.includes('react'));
  assert.ok(labels.includes('ws-aqua'));
  assert.ok(labels.some(l => l.includes('seed round')));

  const org = organizationView(mind, 'Aquiplex');
  assert.ok(org && org.nodes.length >= 2, 'org memory = org node neighborhood');
});

// ── Predictions (Layer 12) ────────────────────────────────────────────────────

test('predictions: deadline + blocker + goal produce ranked ephemeral forecasts', () => {
  const mind = freshMind();
  trackGoals(mind, { userMessage: 'My goal is to ship the investor demo.' });
  updateWorkingMemory(mind, { userMessage: 'stuck on the deploy pipeline. Demo due by Friday.', taskType: 'debugging', hints: { tech: [], deadlines: [{ label: 'due by Friday', ts: null, source: 'message' }] } });
  const preds = rebuildPredictions(mind, { taskType: 'debugging' });
  assert.ok(preds.length >= 3);
  assert.ok(preds.every(p => p.probability > 0 && p.probability <= 0.97));
  const sorted = [...preds].sort((a, b) => b.probability - a.probability);
  assert.deepEqual(preds.map(p => p.label), sorted.map(p => p.label), 'ranked by probability');
});

// ── Reflection + decay (Layers 13 + 14) ───────────────────────────────────────

test('reflection: promotes established, archives decayed (never deletes), respects locks', () => {
  const mind = freshMind();
  // Establishment candidate: strong repeated evidence
  for (let i = 0; i < 10; i++) {
    observeSignal(mind, { dimension: DIMENSIONS.PREFERENCES, key: 'design_style', value: 'minimal', strength: 0.9 });
  }
  // Weak stale belief → decays to archive
  observeSignal(mind, { dimension: DIMENSIONS.KNOWLEDGE, key: 'tech:php', value: 'working_knowledge', strength: 0.3 });
  const weak = mind.beliefs[beliefKey(DIMENSIONS.KNOWLEDGE, 'tech:php')];
  weak.confidence = 0.12;
  weak.lastEvidenceAt = Date.now() - 60 * 24 * 3600 * 1000;
  // Locked stale belief → untouched
  observeSignal(mind, { dimension: DIMENSIONS.PREFERENCES, key: 'os', value: 'linux', strength: 0.4 });
  lockBelief(mind, DIMENSIONS.PREFERENCES, 'os', true);
  const locked = mind.beliefs[beliefKey(DIMENSIONS.PREFERENCES, 'os')];
  locked.lastEvidenceAt = Date.now() - 300 * 24 * 3600 * 1000;
  const lockedConf = locked.confidence;

  const report = reflect(mind);

  assert.ok(report.promoted.includes(beliefKey(DIMENSIONS.PREFERENCES, 'design_style')));
  assert.equal(weak.status, STATUS.ARCHIVED, 'archived, not deleted');
  assert.ok(mind.beliefs[beliefKey(DIMENSIONS.KNOWLEDGE, 'tech:php')], 'belief object still exists');
  assert.equal(locked.confidence, lockedConf, 'locked exempt from decay');
  assert.equal(mind.reflections.length, 1);
});

test('reflection: hard TTL deletes expired beliefs (privacy retention)', () => {
  const mind = freshMind();
  const b = observeSignal(mind, { dimension: DIMENSIONS.PREFERENCES, key: 'ephemeral', value: 'x', strength: 0.9 });
  b.privacy.retentionDays = 1;
  b.createdAt = Date.now() - 3 * 24 * 3600 * 1000;
  const report = reflect(mind);
  assert.ok(report.expired.includes(beliefKey(DIMENSIONS.PREFERENCES, 'ephemeral')));
  assert.equal(mind.beliefs[beliefKey(DIMENSIONS.PREFERENCES, 'ephemeral')], undefined);
});

test('reflection: cadence gate', () => {
  const mind = freshMind();
  mind.turnCount = REFLECT_EVERY_TURNS - 1;
  assert.equal(shouldReflect(mind), false);
  mind.turnCount = REFLECT_EVERY_TURNS;
  assert.equal(shouldReflect(mind), true);
});

// ── Retrieval (Layer 15) ──────────────────────────────────────────────────────

test('retrieval: empty mind → empty block (quality over quantity)', () => {
  const mind = createEmptyMind('user:empty');
  const { block } = retrieveCognitiveContext(mind, { query: 'hello', taskType: 'conversation' });
  assert.equal(block, '');
});

test('retrieval: rich mind → compact block with identity/goals/state/prediction', () => {
  const mind = freshMind();
  for (let i = 0; i < 8; i++) {
    observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'founder', value: true, strength: 0.6 });
    observeSignal(mind, { dimension: DIMENSIONS.COMMUNICATION, key: 'response_length', value: 'brief', strength: 0.7 });
  }
  trackGoals(mind, { userMessage: 'My goal is to ship the investor demo.' });
  updateWorkingMemory(mind, { userMessage: 'blocked on deploy pipeline', taskType: 'debugging', hints: { tech: ['docker'] } });
  rebuildPredictions(mind, { taskType: 'debugging' });

  const { block, used } = retrieveCognitiveContext(mind, { query: 'help me fix the docker deploy', taskType: 'debugging' });
  assert.match(block, /COGNITIVE MODEL/);
  assert.match(block, /founder/);
  assert.match(block, /investor demo/);
  assert.match(block, /blocked on/i);
  assert.ok(used.identity > 0 && used.goals > 0 && used.working > 0);
  assert.match(block, /treat as a hunch/, 'uncertainty guidance present');
});

test('retrieval: budget enforcement trims tail sections', () => {
  const mind = freshMind();
  for (let i = 0; i < 8; i++) observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'engineer', value: true, strength: 0.6 });
  trackGoals(mind, { userMessage: 'My goal is to ship the very long ambitious platform rewrite of everything.' });
  updateWorkingMemory(mind, { userMessage: 'x', taskType: 'coding', hints: { tech: ['react', 'postgres', 'docker'] } });
  rebuildPredictions(mind, { taskType: 'coding' });

  const full = retrieveCognitiveContext(mind, { query: 'x', taskType: 'coding', budgetTokens: 5000 });
  const tight = retrieveCognitiveContext(mind, { query: 'x', taskType: 'coding', budgetTokens: 60 });
  assert.ok(tight.block.length < full.block.length, 'tight budget produces smaller block');
  assert.match(tight.block, /Identity/, 'highest-priority section survives');
});

// ── Facade + store (isolation, ownership, fail-safety) ────────────────────────

test('facade: full turn cycle via mindObserve/mindContext/mindAfterTurn', () => {
  _clearAllForTests();
  const owner = resolveMindOwner({ userId: 'u42', conversationId: 'c1' });
  assert.equal(owner, 'user:u42', 'user identity wins over conversation');

  const diag = mindObserve(owner, {
    userMessage: "I'm working to ship the investor demo. Keep the UI minimal — too flashy right now. React side is fine.",
    taskType: 'planning',
    extractedFacts: [{ key: 'workplace', value: 'Aquiplex' }],
    workspaceId: 'ws1',
    conversationId: 'c1',
  });
  assert.ok(diag.signals > 0 && diag.goalsTouched > 0);

  const { reflected } = mindAfterTurn(owner, { taskType: 'planning', workspaceId: 'ws1' });
  assert.equal(typeof reflected, 'boolean');

  const { block } = mindContext(owner, { query: 'what should the demo cover?', taskType: 'planning' });
  assert.match(block, /investor demo/);
});

test('facade: null owner disables everything silently', () => {
  assert.equal(resolveMindOwner({}), null);
  assert.deepEqual(mindObserve(null, { userMessage: 'x' }), { signals: 0, goalsTouched: 0 });
  assert.equal(mindContext(null, {}).block, '');
  assert.equal(mindAfterTurn(null).reflected, false);
});

test('store: minds are isolated per owner; export + delete (Layer 19)', () => {
  _clearAllForTests();
  const a = getMind('user:a');
  const b = getMind('user:b');
  observeSignal(a, { dimension: DIMENSIONS.IDENTITY, key: 'founder', value: true, strength: 0.9 });
  assert.equal(Object.keys(b.beliefs).length, 0, 'no cross-owner leakage');

  const dump = exportMind('user:a');
  assert.equal(dump.ownerId, 'user:a');
  assert.ok(Object.keys(dump.beliefs).length === 1);
  dump.beliefs = {}; // mutating export must not touch live mind
  assert.equal(Object.keys(getMind('user:a').beliefs).length, 1);

  assert.equal(deleteMind('user:a'), true);
  assert.equal(exportMind('user:a'), null);
});

test('facade: mindContext never creates minds (peek semantics)', () => {
  _clearAllForTests();
  const { block } = mindContext('user:ghost', { query: 'x' });
  assert.equal(block, '');
  assert.equal(exportMind('user:ghost'), null, 'no mind materialized by a read');
});
