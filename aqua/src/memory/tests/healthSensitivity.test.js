/**
 * Health privacy and medical classification — audit D-10 / D-11 (2026-11-16).
 * A personal disclosure is health data (stored only with opt-in); a general
 * medical question is not the user's health; both share one condition list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyText, redactSensitiveSentences, classifyHealthContext } from '../sensitivity.js';
import { classifyMultiLabel } from '../../orchestrator/multiLabelClassifier.js';

test('personal disclosures of common conditions are health (previously missed)', () => {
  for (const s of ['I have pneumonia.', 'I was diagnosed with diabetes.', "I've got the flu.", 'I had a stroke last year.', 'My son has tuberculosis.', 'I have high cholesterol.', "I'm on antibiotics."]) {
    assert.equal(classifyText(s), 'health', s);
    assert.deepEqual(redactSensitiveSentences(s).removed, ['health'], s);
  }
});

test('general medical questions and product talk are NOT the user\'s health', () => {
  for (const s of ['Is pneumonia curable?', 'What are the symptoms of tuberculosis?', 'Tell me about pneumonia.', 'Is it curable?', 'We build an app for pneumonia patients.', 'Write a blog post about influenza.']) {
    assert.equal(classifyText(s), null, s);
  }
});

test('health context labels: disclosure / general / follow-up to a disclosure / emergency', () => {
  assert.equal(classifyHealthContext('I have pneumonia.'), 'personal_disclosure');
  assert.equal(classifyHealthContext('Is pneumonia curable?'), 'general_medical');
  assert.equal(classifyHealthContext('What are the symptoms of tuberculosis?'), 'general_medical');
  assert.equal(classifyHealthContext('Can this medication cause side effects?'), 'general_medical');
  assert.equal(classifyHealthContext('Is it curable?', { previousUserMessages: ['I have pneumonia.'] }), 'personal_followup');
  assert.equal(classifyHealthContext('Is it curable?'), null, 'no medical subject, no disclosure → not medical');
  assert.equal(classifyHealthContext('I have crushing chest pain and can\'t breathe'), 'emergency');
  assert.equal(classifyHealthContext('Is it serious?'), null);
  assert.equal(classifyHealthContext('How do I deploy to Render?'), null);
});

test('medical tag (D-11) recognises disease/treatment questions without over-tagging', () => {
  const tags = (m) => classifyMultiLabel(m).tags;
  for (const m of ['Is pneumonia curable?', 'What are the symptoms of tuberculosis?', 'Can this medication cause side effects?', 'How is malaria treated?']) {
    assert.ok(tags(m).includes('medical'), m);
  }
  for (const m of ['Explain photosynthesis.', 'Compare MongoDB and PostgreSQL.', 'What are the side quests in this game design?', 'Tell me about cloud storage.']) {
    assert.ok(!tags(m).includes('medical'), m);
  }
});
