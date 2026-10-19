/**
 * Memory-page correction rewrites the claim's sentence (2026-10-18). A plain
 * replace printed retyped context twice: "…is that clinics clinics not
 * finishing onboarding" (live founder journey run 5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
const { substituteValue } = await import('../index.js');

test('the live case: words the new value repeats are not printed twice', () => {
  assert.equal(
    substituteValue('Our biggest risk right now is that clinics churn after the first month.', 'churn after the first month', 'clinics not finishing onboarding'),
    'Our biggest risk right now is that clinics not finishing onboarding.');
});

test('a plain value is replaced in place', () => {
  assert.equal(substituteValue('The Pro plan is $49 per month.', '$49 per month', '$39 per month'), 'The Pro plan is $39 per month.');
});

test('several retyped words are dropped once', () => {
  assert.equal(substituteValue('We launch on May 1.', 'May 1', 'launch on May 2'), 'We launch on May 2.');
});

test('a word that only LOOKS like the start is kept (whole words only)', () => {
  assert.equal(substituteValue('Our host is Render.', 'Render', 'Heroku'), 'Our host is Heroku.');
  assert.equal(substituteValue('The cost is $10.', '$10', 'isolation $12'), 'The cost is isolation $12.');
});

test('matching ignores case; the old value is found case-insensitively', () => {
  assert.equal(substituteValue('We use render for hosting.', 'Render', 'Fly.io'), 'We use Fly.io for hosting.');
  assert.equal(substituteValue('Clinics churn fast.', 'churn fast', 'clinics stall'), 'clinics stall.');
});

test('the old value absent: the sentence is returned unchanged', () => {
  assert.equal(substituteValue('Nothing here.', 'Render', 'Fly.io'), 'Nothing here.');
});
