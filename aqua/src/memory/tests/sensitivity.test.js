/**
 * Sensitive categories classifier (2026-10-28). Positive cases are the three
 * production facts that were injected into almost every reply, plus the
 * vocabulary the spec names; negative cases are work language that shares a
 * word with that vocabulary. Deterministic: no model, no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySensitivity, classifyText, sensitivePolicy, withheld,
  redactSensitiveSentences, scrubSensitiveLines,
} from '../sensitivity.js';

test('the three production facts classify (key + value as the custom_ fallback stored them)', () => {
  assert.equal(classifySensitivity({ key: 'custom_unable_to_enjoy_anything', value: 'unable to enjoy anything', category: 'custom' }), 'mood');
  assert.equal(classifySensitivity({ key: 'custom_very_bored', value: 'very bored', category: 'custom' }), 'mood');
  assert.equal(classifySensitivity({ key: 'custom_right_eye', value: 'moving automatically', category: 'custom' }), 'health');
});

test('health: symptoms, body part + abnormal behaviour, conditions, medication', () => {
  for (const s of [
    'I have had a headache for three days',
    'my left knee hurts when I run',
    'there is a sharp pain in my chest',
    'my right eye keeps twitching',
    'I was diagnosed with ADHD last year',
    'I take sertraline every morning',
    'I am on medication for my blood pressure',
    'my sister has diabetes',
    'I can’t sleep at night',
  ]) assert.equal(classifyText(s), 'health', s);
});

test('mood: felt states and the inability to enjoy', () => {
  for (const s of [
    "I'm very bored", 'I am so sad today', "I've been feeling lonely", 'I feel anxious all the time',
    'I am stressed out', "I can't enjoy anything anymore", 'I have depression', 'very bored', 'I feel completely numb',
  ]) assert.equal(classifyText(s), 'mood', s);
});

test('NOT sensitive: opinions about a topic, and work language that shares a word', () => {
  for (const s of [
    "I'm bored of React",                       // decision: an opinion about a tool, not a mood
    "I'm tired of meetings",
    'we are shipping an eye-tracking feature',
    'my back end is broken again',
    'my head of sales quit',
    'run a stress test on the API',
    'what are the pain points of our customers',
    'help me diagnose the bug in checkout',
    'we build an app for diabetes patients',
    "I'm building a tool for people with anxiety",
    'make the pill button smaller',
    'help me write a cold email',
    "I'm a founder in Pune",
    "I'm vegetarian",
    "I'm down for that",
    "I'm afraid I can't make Friday",
  ]) assert.equal(classifyText(s), null, s);
  assert.equal(classifySensitivity({ key: 'favorite_language', value: 'Rust', category: 'programming' }), null);
  assert.equal(classifySensitivity({ key: 'custom_student_with_almost_zero_networth', value: 'student with almost zero networth' }), null);
});

test('an explicit tag wins over the text', () => {
  assert.equal(classifySensitivity({ key: 'x', value: 'y', sensitivity: 'mood' }), 'mood');
});

test('read policy: hidden unless opted in AND the current message is on that topic', () => {
  const bored = { key: 'custom_very_bored', value: 'very bored' };
  assert.equal(withheld(bored, sensitivePolicy({ rememberSensitive: false, message: "I've been feeling bored lately, what should I do" })), true);
  assert.equal(withheld(bored, sensitivePolicy({ rememberSensitive: true, message: 'help me write a cold email' })), true);
  assert.equal(withheld(bored, sensitivePolicy({ rememberSensitive: true, message: "I've been feeling bored lately, what should I do" })), false);
  // opted in, but the message is about health, not mood
  assert.equal(withheld(bored, sensitivePolicy({ rememberSensitive: true, message: 'my right eye keeps twitching, is that bad?' })), true);
  assert.equal(withheld({ key: 'city', value: 'Pune' }, sensitivePolicy({})), false);
});

test('write redaction keeps the rest of the turn', () => {
  const r = redactSensitiveSentences("I'm very bored. Help me write a cold email to Acme about our pilot.");
  assert.deepEqual(r.removed, ['mood']);
  assert.equal(r.text, 'Help me write a cold email to Acme about our pilot.');
  assert.equal(redactSensitiveSentences('We launch on May 2.').text, 'We launch on May 2.');
});

test('line scrub drops only content lines', () => {
  const block = ['--- USER PROFILE & MEMORY ---', '### Other Details', '- very bored: very bored', '- city: Pune', '--- END PROFILE ---'].join('\n');
  const out = scrubSensitiveLines(block, sensitivePolicy({}));
  assert.equal(out.removed, 1);
  assert.ok(!out.block.includes('very bored'));
  assert.ok(out.block.includes('- city: Pune') && out.block.includes('--- END PROFILE ---'));
});
