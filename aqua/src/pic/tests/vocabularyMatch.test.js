/**
 * The same word in another form, and acronyms as written (2026-11-02) —
 * through the shared relevance scorer the PIC floor and the Context Engine
 * both gate with. Every positive has a look-alike control from
 * eval/datasets/vocabulary-continuity.dev.v1.json that must stay unmatched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyseQuestion, factAffinity } from '../questionShape.js';

const lexical = (q, statement) => factAffinity(analyseQuestion(q), { statement, entities: [] }).lexical;

test('blocking meets blocker; blockchain stays out', () => {
  assert.ok(lexical("What's blocking the round now?", 'Now the main blocker is that the lead investor wants a board seat.') > 0);
  assert.equal(lexical('What is blocking our launch?', 'I read an article about blockchain voting.'), 0);
});

test('managing meets manager', () => {
  assert.ok(lexical('Who is managing the contracts?', 'Omar is the new contracts manager.') > 0);
});

test('ship never meets relationship; late never meets later', () => {
  assert.equal(lexical('When do we ship orders?', 'My relationship coach is Ana.'), 0);
  assert.equal(lexical('Was I late?', 'The contractor said he would call later.'), 0);
});

test('an acronym matches as written', () => {
  assert.ok(lexical('Am I still working as a TA?', 'I stopped the TA job to focus on applications.') > 0);
  assert.equal(lexical('Am I still working as a TA?', 'I take the train to work.'), 0);
});

test('an acronym is never matched by case-folding or expansion', () => {
  assert.equal(lexical('Are we expanding to the US?', 'Our friends visited us in Lisbon.'), 0, 'us ≠ US');
  assert.equal(lexical('Who is my TA?', 'Our tax advisor is Ruth.'), 0, 'not expanded on the question side');
  assert.equal(lexical('Who is our PM?', 'The standup is at 3 PM.'), 0, 'a clock time is not the acronym');
  assert.ok(lexical('Who is our PM?', 'Our PM is Laila.') > 0, 'control');
});
