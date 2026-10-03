/**
 * `work` AS A VERB MUST NOT BE MATCHED AS A WORD.
 *
 * "Where do I work?" ranked "I usually do deep work in the mornings" and "Neha
 * owns the retrieval work" (both lexical score 1.0) ABOVE "I run product at
 * Nummo" — the answer — with or without the Sep 29 currency cues. `work` was
 * already a typing cue and so excluded from `topicTerms`, but it stayed in
 * `shape.terms`, which the lexical score reads: the principle "a word that
 * types the answer is never also a topic" held for the honesty check and not
 * for the ranking. Measured on retrieval-core: q001 rr 0.25, q096 0.25, q139 0.33.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyseQuestion, factAffinity } from '../questionShape.js';

const aff = (q, statement, entities = []) =>
  factAffinity(analyseQuestion(q), { statement, entities }, null, false, null);

describe('verb-sense `work` types the answer and is not a search word', () => {
  for (const q of [
    'Where do I work?', 'Where do I work now?', 'Can you remind me where I work?',
    'Who do you work for?', 'Where does she work?', 'Do I still work at Intercom?',
    'How many people work at Aquiplex?',
    // The three forms are not redundant: each needs a question the other two miss.
    'Which team does Priya work for?',      // named subject — only `work for` sees it
    'Does Neha work at Nummo?',             // named subject — only `work at` sees it
    'Who works at Nummo?',                  // no auxiliary — only the bare-pronoun form
    'Tell me where she works.',             // bare pronoun + verb, no auxiliary
  ]) {
    test(`"${q}" drops \`work\` from the matched terms`, () => {
      const t = analyseQuestion(q).terms;
      assert.ok(!t.some(x => /^work(s|ed|ing)?$/.test(x)), `terms=${JSON.stringify(t)}`);
    });
  }

  test('a NOUN `work` in the store no longer scores as a perfect answer', () => {
    for (const f of ['I usually do deep work in the mornings.', 'Neha owns the retrieval work.']) {
      assert.equal(aff('Where do I work?', f).lexical, 0, `lexical match on a noun: ${f}`);
      assert.ok(aff('Where do I work?', f).score < 0.5, `still scores ${aff('Where do I work?', f).score}: ${f}`);
    }
  });

  test('the answer — employer fact with no shared word — outranks the noun', () => {
    const answer = aff('Where do I work?', 'I run product at Nummo.', ['Nummo', 'You']);
    const noun = aff('Where do I work?', 'I usually do deep work in the mornings.', ['You']);
    assert.ok(answer.score > noun.score, `answer ${answer.score} <= noun ${noun.score}`);
  });
});

describe('the rule is narrow: the NOUN sense keeps `work`', () => {
  for (const q of ['Who owns the retrieval work?', 'How do I get to work?', 'What work did I do last year?', 'Is the work done?']) {
    test(`"${q}" keeps \`work\` as an ordinary term`, () => {
      assert.ok(analyseQuestion(q).terms.includes('work'), `terms=${JSON.stringify(analyseQuestion(q).terms)}`);
    });
  }
  test('"Who owns the retrieval work?" still matches the retrieval-work fact lexically', () => {
    assert.ok(aff('Who owns the retrieval work?', 'Neha owns the retrieval work.').lexical >= 0.9);
  });
});
