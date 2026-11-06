/**
 * Limits of question-aware selection (mind/mindRetriever.js questionScope), pinned
 * 2026-11-05 — preparation for the A–D answer run; the implementation is unchanged.
 *
 * Selection on a targeted question is lexical: a goal, deadline or blocker is kept
 * when it shares a stemmed content word with the question. Planning cues ("should
 * I", "recommend", "focus"…) make a question broad and keep everything.
 *
 *   plain tests  what works today and must keep working
 *   todo tests   known gaps, stated as the behaviour wanted. node --test reports
 *                them as todo, not failures; one that starts passing is a signal
 *                to promote it to a plain test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyMind } from '../mindSchema.js';
import { trackGoals } from '../goalTracker.js';
import { updateWorkingMemory } from '../workingMemory.js';
// Question-aware selection is OFF by default (2026-11-06); these cases describe it ON.
process.env.AQUA_MIND_RELEVANCE = 'on';
import { retrieveCognitiveContext } from '../mindRetriever.js';

function mind() {
  const m = createEmptyMind('user:relevance-synonyms');
  for (const t of ['My goal is to run a half marathon in October.', 'My goal is to learn Spanish this year.', 'My goal is to get promoted to senior analyst.']) trackGoals(m, { userMessage: t });
  updateWorkingMemory(m, { userMessage: 'The Atlas migration is due on March 3.', taskType: 'conversation', hints: { deadlines: [{ label: 'Atlas migration due on March 3', ts: null }] } });
  updateWorkingMemory(m, { userMessage: 'blocked on the deploy pipeline', taskType: 'debugging', hints: {} });
  return m;
}
const ctx = q => retrieveCognitiveContext(mind(), { query: q }).block;
const goals = q => ctx(q).match(/Active goals: ([^\n]*)/)?.[1] ?? '';

// ── Works today ─────────────────────────────────────────────────────────────
test('a shared word keeps the goal ("marathon training")', () => {
  assert.match(goals("How's my marathon training?"), /half marathon/);
  assert.doesNotMatch(goals("How's my marathon training?"), /Spanish|promoted/);
});
test('a shared word keeps the deadline ("my project due", "Atlas")', () => {
  assert.match(ctx('When is my project due?'), /deadline: Atlas migration/);
  assert.match(ctx('Any update on Atlas?'), /deadline: Atlas migration/);
});
test('a shared verb stem keeps the goal ("learning languages" → learn Spanish)', () => {
  assert.match(goals('Any tips for learning languages?'), /learn Spanish/);
});
test('an unrelated targeted question keeps nothing', () => {
  assert.equal(goals('Where do I work?'), '');
  assert.doesNotMatch(ctx('Where do I work?'), /deadline:|blocked on:/);
});

// ── Word forms (promoted from todo, 2026-11-06) and known gaps (todo) ─────────
// Promoted from todo (2026-11-06): mindRetriever root() folds a noun's -ion onto its verb.
test('morphology: "promotion" reaches "get promoted…"', () => {
  assert.match(goals('Will my promotion happen?'), /promoted/);
});
test('morphology: "migrating" reaches the Atlas migration deadline', () => {
  assert.match(ctx("How's the migrating going?"), /deadline: Atlas migration/);
});
test('related phrase: a "21 km race" is the half marathon', { todo: 'no synonym/related-concept matching' }, () => {
  assert.match(goals('How far is a 21 km race?'), /half marathon/);
});
test('related phrase: Duolingo is about learning Spanish', { todo: 'no synonym/related-concept matching' }, () => {
  assert.match(goals('Is Duolingo worth it?'), /Spanish/);
});
test('related phrase: "career" is about the promotion goal', { todo: 'no synonym/related-concept matching' }, () => {
  assert.match(goals("How's my career?"), /promoted/);
});
test('related phrase: "CI failing" is about the deploy-pipeline blocker', { todo: 'no synonym/related-concept matching' }, () => {
  assert.match(ctx('Why is CI failing?'), /blocked on: [^\n]*deploy pipeline/);
});
test('over-inclusion: a planning cue about one thing should not pull in every goal', { todo: 'broad mode keeps everything, as before C' }, () => {
  assert.doesNotMatch(goals('What shoes should I buy for my race?'), /Spanish|promoted/);
});
