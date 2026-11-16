/**
 * Sprint 4 — the deterministic answer grader (eval/answer/answerGrader.mjs).
 * Hand-written answers against hand-written scenarios (not the frozen eval set).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeAnswer, aggregateGrades, questionsAsked } from '../answer/answerGrader.mjs';

const job = {
  question: 'Where do I work now?',
  history: [{ text: 'I work at Pellow.' }, { text: 'I left Pellow and joined Grayfield.' }],
  needs: [{ id: 'now', required: true, match: ['grayfield'] }],
  temporal: { current: ['grayfield'], stale: ['pellow'] },
};

test('factual correctness and temporal accuracy: the current value, the old one only as history', () => {
  assert.deepEqual(
    [gradeAnswer(job, 'You work at Grayfield.').factual_correctness, gradeAnswer(job, 'You work at Grayfield.').temporal_accuracy],
    [1, 1]);
  assert.equal(gradeAnswer(job, 'You work at Grayfield; you previously worked at Pellow.').temporal_accuracy, 1);
  const stale = gradeAnswer(job, 'You work at Pellow.');
  assert.equal(stale.temporal_accuracy, 0); assert.equal(stale.stale_asserted, 1); assert.equal(stale.factual_correctness, 0);
});

test('contradiction handling: naming the conflict beats listing both values', () => {
  const s = { question: 'When is it?', needs: [], contradiction: { a: ['tuesday'], b: ['wednesday'] } };
  assert.equal(gradeAnswer(s, 'You said Tuesday and also Wednesday — these conflict; which is right?').contradiction_handling, 1);
  assert.equal(gradeAnswer(s, 'It is on Tuesday or Wednesday.').contradiction_handling, 0.5);
  assert.equal(gradeAnswer(s, 'It is on Tuesday.').contradiction_handling, 0);
});

test('uncertainty: an unknown is handled when the answer declines to assert it or asks', () => {
  const s = { question: 'Can I afford it?', needs: [{ id: 'p', required: true, match: ['18,?000'] }], unknowns: [{ id: 'inc', match: ['income'] }] };
  assert.equal(gradeAnswer(s, 'It costs 18,000. I don\'t know your income — what is your monthly income?').uncertainty_handling, 1);
  assert.equal(gradeAnswer(s, 'It costs 18,000 and your income of 3,000 covers it.').uncertainty_handling, 0);
});

test('ungrounded figures: a number found nowhere in what the user said is counted', () => {
  const s = { question: 'Can I afford it?', needs: [] };
  assert.equal(gradeAnswer(s, 'With 4,500 a month you can.', { sources: 'The car costs 18,000.' }).ungrounded_figures, 1);
  assert.equal(gradeAnswer(s, 'The car costs 18,000.', { sources: 'The car costs 18,000.' }).ungrounded_figures, 0);
});

test('clarification: one question when information is missing, none when it is not', () => {
  const missing = { question: 'Q', needs: [{ id: 'x', required: true, match: ['x'] }], unknowns: [{ id: 'u', match: ['u'] }] };
  assert.equal(gradeAnswer(missing, 'x. What is u?').clarification_quality, 1);
  assert.equal(gradeAnswer(missing, 'x. What is u? And what is v?').clarification_quality, 0);
  assert.equal(gradeAnswer(job, 'You work at Grayfield.').clarification_quality, 1);
  assert.equal(gradeAnswer(job, 'You work at Grayfield. Anything else?').clarification_quality, 0.5);
  assert.equal(questionsAsked('One? Two. Three?'), 2);
});

test('personal leaks on impersonal questions', () => {
  const s = { question: 'What is the capital of Canada?', needs: [], distractors: [{ id: 'p', match: ['florist'] }] };
  assert.equal(gradeAnswer(s, 'Ottawa.').personal_leaks, 0);
  assert.equal(gradeAnswer(s, 'Ottawa — great for a florist like your wife!').personal_leaks, 1);
});

test('aggregate: means over applicable scenarios, sums for counts', () => {
  const a = aggregateGrades([{ factual_correctness: 1, ungrounded_figures: 1 }, { factual_correctness: 0, ungrounded_figures: 2 }, { factual_correctness: null }]);
  assert.equal(a.factual_correctness, 0.5); assert.equal(a.factual_correctness_n, 2); assert.equal(a.ungrounded_figures, 3);
});
