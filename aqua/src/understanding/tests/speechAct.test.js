/**
 * Capture Integrity V1 (2026-11-10) — speech-act classification.
 * What a sentence DOES decides whether memory may read it (understanding/speechAct.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySpeechAct, assertedPart, assertedText, isQuestion } from '../speechAct.js';

const act = s => classifySpeechAct(s).act;

test('questions are questions — wh-, inverted auxiliaries, and a question mark', () => {
  for (const s of ['Where does my sister work?', "What's my dog called?", 'Is my sister called Ana?', 'Do I have any siblings?',
    'Should I take the Brightmoor offer?', 'Can we afford the van?', 'How much is my rent', 'Which school should we pick'])
    assert.equal(act(s), 'question', s);
  assert.equal(act('I wonder if I should move.'), 'question', 'an indirect question');
});

test('requests are requests — including bare imperatives of task verbs', () => {
  for (const s of ['Plan a dinner for my partner and me on Saturday.', 'Help me learn Spanish.', 'Tell me about volcanoes.',
    'Find me a cheap flight.', 'Remember to call mum.', 'Please summarise my notes.'])
    assert.equal(act(s), 'request', s);
});

test('hypotheticals are hypotheticals', () => {
  for (const s of ['If I moved to Lisbon, would I be happier?', 'What if I quit?', 'Suppose I earned 80k, what then?', "Let's say we hire two engineers."])
    assert.equal(act(s), 'hypothetical', s);
});

test('statements keep their kind: assertion, negation, correction, preference, goal, intention, prediction', () => {
  assert.equal(act('I teach chemistry at a secondary school in Leicester.'), 'assertion');
  assert.equal(act("I don't have a car."), 'negation');
  assert.equal(act('Sorry, typo earlier, my sister is Josie not Jodie.'), 'correction');
  assert.equal(act('I hate coriander, it tastes like soap to me.'), 'preference');
  assert.equal(act('My goal is to learn Italian.'), 'goal');
  assert.equal(act("I'm going to repaint the kitchen."), 'intention');
  assert.deepEqual(classifySpeechAct("I'll probably get the promotion."), { act: 'prediction', hedged: true });
  assert.deepEqual(classifySpeechAct("I'm thinking about going freelance as a designer."), { act: 'intention', hedged: true });
});

test('sentence-initial nouns and statement wh-clauses are not questions or requests', () => {
  for (const s of ['Book club is on Tuesdays.', "Name's Rosalind.", 'Plan B is to move to Leeds.', 'Design is my passion.',
    'What I really want is to travel.', 'When I write emails, I prefer a warm tone.', 'Will Smith is my favourite actor.'])
    assert.ok(!['question', 'request', 'hypothetical'].includes(act(s)), `${s} → ${act(s)}`);
  assert.equal(isQuestion('How I met my wife was funny.'), false);
});

test('assertedPart: a leading statement before a question is kept; the question is not', () => {
  assert.deepEqual(assertedPart('I live in Leeds, can you recommend a gym?'), { text: 'I live in Leeds', act: 'assertion' });
  assert.equal(assertedPart('We have 3 engineers — should we hire?').text, 'We have 3 engineers');
  assert.equal(assertedPart('Where does my sister work?'), null);
  assert.equal(assertedPart('Can you help me plan my training this week?'), null);
  assert.equal(assertedPart('If I moved to Lisbon, would I be happier?'), null);
});

test('assertedPart: "remember that…" yields the embedded statement only', () => {
  assert.deepEqual(assertedPart('Remember that my locker is 217.'), { text: 'my locker is 217.', act: 'remember' });
  assert.equal(assertedPart('Remember to call mum.'), null, 'a reminder is a request');
});

test('assertedPart: an aspiration said as a request is the user aim; a task is not', () => {
  assert.equal(assertedPart('Help me become a billionaire within a year').act, 'goal');
  assert.equal(assertedPart('Can you help me plan my wedding?'), null);
  assert.equal(assertedPart('Help me write an email to my landlord.'), null);
});

test('assertedText drops non-assertions from a message, keeping order', () => {
  assert.equal(assertedText(['My goal is to run a marathon.', 'Can you plan my training?', 'I need to ship the beta, can you help?']),
    'My goal is to run a marathon. I need to ship the beta.');
});
