/**
 * Question shape — the deterministic half of query understanding.
 *
 * WHAT THESE PIN, AND WHY EACH ONE EXISTS
 * ---------------------------------------
 * Every assertion here corresponds to a behaviour that was measured wrong on
 * `retrieval-core.v1` before the module existed, or to a defect introduced
 * while building it and caught by the eval. They are not a description of the
 * code; they are the list of ways it has actually been wrong.
 *
 * BITE, MEASURED (revert the named line → count failures):
 *   collect ALL typing cues → first-match-wins          → 3 fail
 *   strip grammar before terms                           → 2 fail
 *   graded kind strengths → boolean set                  → 4 fail
 *   PLACE_PREP digit guard ("in 2024" is not a place)    → 1 fail
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyseQuestion, offeredKinds, statementPolarity, statementIsPast, contentTerms,
} from '../questionShape.js';

const fact = (statement, entities = []) => ({ statement, entities });

describe('question shape — what the question asks FOR', () => {
  test('a category noun types the answer more specifically than the interrogative', () => {
    // "what is my company" is an ORG question, not a generic `thing` question.
    // Without this the category/instance gap stays unbridged and the engine
    // falls back to lexical matching against a question that shares no words
    // with its answer.
    assert.equal(analyseQuestion('What is my company?').expects, 'org');
    assert.equal(analyseQuestion('Which city am I in?').expects, 'place');
    assert.equal(analyseQuestion('What is my job?').expects, 'role');
  });

  test('a wh-word types the answer when no category noun does', () => {
    assert.equal(analyseQuestion('Where did the meeting happen?').expects, 'place');
    assert.equal(analyseQuestion('Who signed it?').expects, 'person');
    assert.equal(analyseQuestion('When does it ship?').expects, 'time');
  });

  test('an untyped question stays untyped rather than guessing', () => {
    // `thing` + typed:false is the state in which kind credit is refused
    // outright. A question the module cannot type must not be given a type,
    // because the type is what licenses answering without lexical overlap.
    const s = analyseQuestion('What is my blood type?');
    assert.equal(s.typed, false);
    assert.equal(s.expects, 'thing');
  });

  test('EVERY typing cue is collected, not just the winning one', () => {
    // FIRST-MATCH-WINS WAS A REAL DEFECT. "Where do I work now?" typed on
    // `where`, which left `work` classified as an unmatched TOPIC word — the
    // question then looked like it was about a subject the store had never
    // heard of, and the engine went SILENT on the single question the
    // self-anchor exists to answer. Measured: recall@8 fell 71.4% → 63.1%.
    const s = analyseQuestion('Where do I work now?');
    assert.ok(s.cues.includes('where'), `cues ${JSON.stringify(s.cues)}`);
    assert.ok(s.cues.includes('work'), `cues ${JSON.stringify(s.cues)}`);
    assert.deepEqual(s.topicTerms, [], 'a typing cue must never also be a topic');
  });

  test('grammar is stripped before topic terms are taken', () => {
    // "right" came from "right now" and landed in the TOPIC of "Who employs me
    // right now?", vetoing every candidate and silencing an answerable
    // question. A word that says WHEN is never what the question is ABOUT.
    const s = analyseQuestion('Who employs me right now?');
    assert.deepEqual(s.topicTerms, [], `topic ${JSON.stringify(s.topicTerms)}`);
    assert.equal(s.currency, 'current');
  });

  test('an unknown topic noun survives as a topic term', () => {
    // The other half of the same rule: "dentist" is not a cue, so it stays,
    // and the gate will refuse to answer on kind alone. This is what keeps
    // "Who is my dentist?" from being answered with "Priya is our head of
    // design" — both are person questions and only one has an answer.
    const s = analyseQuestion('Who is my dentist?');
    assert.deepEqual(s.topicTerms, ['dentist']);
    assert.equal(s.typed, true);
  });
});

describe('question shape — polarity, currency and self-scope', () => {
  test('negation is detected as a property of the QUESTION', () => {
    assert.equal(analyseQuestion('What do I no longer own?').polarity, 'negated');
    assert.equal(analyseQuestion('What did we decide against?').polarity, 'negated');
    assert.equal(analyseQuestion('What do I own?').polarity, 'affirmed');
  });

  test('past beats present when both cues fire', () => {
    // "no longer" matches both. It is unambiguously about what STOPPED being
    // true, and reading it as a present-tense question inverts the answer.
    assert.equal(analyseQuestion('Where do I no longer work?').currency, 'past');
    assert.equal(analyseQuestion('Where do I work now?').currency, 'current');
    assert.equal(analyseQuestion('Where do I work?').currency, 'any');
  });

  test('object-form first person counts as self-scope', () => {
    // "Which company pays me?" and "Who employs me right now?" both returned
    // SILENCE on the committed baseline: neither has a first-person SUBJECT,
    // and the old predicate excluded bare "me" because nothing downstream
    // could gate what the anchor reached. Something can now.
    assert.equal(analyseQuestion('Which company pays me?').selfScoped, true);
    assert.equal(analyseQuestion('Who employs me right now?').selfScoped, true);
  });

  test('a first-person STATEMENT is not a question', () => {
    // "I need to fix this bug in my code" pulled three sentences about the
    // user's job into a debugging turn before the interrogative guard existed.
    assert.equal(analyseQuestion('I need to fix this bug in my code').isQuestion, false);
  });

  test('group first-person is NOT self-scope', () => {
    // "we"/"our" is a group claim. Anchoring it to the individual is the quiet
    // inference that puts a wrong line in front of the model.
    assert.equal(analyseQuestion('What are our deadlines?').selfScoped, false);
  });
});

describe('offered kinds — what a statement can answer, and how strongly', () => {
  test('kinds are GRADED, not boolean', () => {
    // A boolean set gave every kind-matching fact an identical score, so ties
    // were broken by insertion order: "Which city am I in?" ranked "I run
    // product at Nummo" above "I moved to the Bangalore office". Both offer a
    // place; only one is mostly about one.
    const k = offeredKinds(fact('I moved to the Bangalore office last month.', ['Bangalore']));
    assert.ok(k.get('place') > 0, 'no place offered');
    assert.ok(k.get('place') > k.get('thing'), 'a real signal must outrank the universal one');
  });

  test('the world model outranks the regex', () => {
    // The whole point of the tier ordering: the signal improves as extraction
    // improves. A graph-typed entity scores 1.0 and demotes every guess.
    const types = new Map([['nummo', 'org']]);
    const k = offeredKinds(fact('I run product at Nummo.', ['Nummo']), types);
    assert.equal(k.get('org'), 1);
  });

  test('an untyped named entity offers org AND person, both weakly', () => {
    // The engine cannot tell which. The honest representation of "it is one of
    // these two" is two weak signals, not one confident wrong one — and weak
    // enough that the guess alone cannot admit a fact through the gate.
    const k = offeredKinds(fact('Chhanda approved it.', ['Chhanda']));
    assert.ok(k.get('org') < 0.5 && k.get('person') < 0.5, 'a guess must stay weak');
  });

  test('"in 2024" is a time, not a place', () => {
    // PLACE_PREP matches "in <Proper>". Without the digit guard every year in
    // the corpus became a location and "Which city am I in?" was answerable by
    // "We raised a seed round in 2024".
    const k = offeredKinds(fact('We raised a seed round in 2024.', []));
    assert.ok(k.get('time') > 0, 'no time offered');
    assert.ok(!k.has('place'), 'a year was read as a place');
  });

  test('a COPULAR role statement offers a role — "I\'m the CTO"', () => {
    // The role patterns were verb-only at first ("I run", "head of") and missed
    // the way people actually state a role, which is copular. "What is my
    // role?" was unanswerable against "I'm the CTO at Halcyon Labs" — a
    // statement that answers it in five words.
    //
    // Caught by capture-core, NOT by retrieval-core. That is why the whole gate
    // is run and not the one suite the work was aimed at: the relevance gate
    // cost capture-core 89.5% -> 78.9% retrievability and the suite it was
    // tuned against reported nothing.
    const k = offeredKinds(fact("I'm the CTO at Halcyon Labs.", ['Halcyon Labs']));
    assert.ok(k.get('role') > 0, 'a copular role statement offered no role');
    assert.ok(offeredKinds(fact('I am a designer.')).get('role') > 0);
  });

  test('a GOAL statement offers a goal', () => {
    // "What is my target?" and "I want to hit 10,000 active merchants by
    // December" share no vocabulary. Goals are named in the canonical world
    // model alongside facts and preferences; without a kind of their own they
    // are reachable only by luck.
    const k = offeredKinds(fact('I want to hit 10,000 active merchants by December.'));
    assert.ok(k.get('goal') > 0, 'a goal statement offered no goal');
    assert.ok(!offeredKinds(fact('I run product at Nummo.')).has('goal'),
      'a present-tense fact was read as a goal');
  });

  test('goal vocabulary types the question', () => {
    for (const q of ['What is my target?', 'What is my goal?', 'What is my quota?']) {
      const sh = analyseQuestion(q);
      assert.equal(sh.expects, 'goal', `${q} -> ${sh.expects}`);
      assert.deepEqual(sh.topicTerms, [], `${q} left an unmatched topic`);
    }
  });

  test('every statement offers `thing`, and it discriminates nothing', () => {
    const k = offeredKinds(fact('The parser rewrite is on hold.', ['parser']));
    assert.ok(k.get('thing') > 0);
    assert.ok(k.get('thing') <= 0.3, '`thing` must never outrank a real signal');
  });
});

describe('statement polarity and tense', () => {
  test('a negated statement is recognised as negated', () => {
    assert.equal(statementPolarity(fact('I no longer own the parser.')), 'negated');
    assert.equal(statementPolarity(fact('We rejected the Bangalore relocation.')), 'negated');
    assert.equal(statementPolarity(fact('I own the parser.')), 'affirmed');
  });

  test('a past statement is recognised as past', () => {
    assert.equal(statementIsPast(fact('I used to work at Intercom.')), true);
    assert.equal(statementIsPast(fact('I run product at Nummo.')), false);
  });

  test('empty and malformed input never throws', () => {
    // These run on every turn on the request thread. A shape variation must
    // degrade the signal, not sink the turn.
    for (const bad of [null, undefined, '', {}, { statement: null }]) {
      assert.doesNotThrow(() => offeredKinds(bad));
      assert.doesNotThrow(() => statementPolarity(bad));
    }
    assert.deepEqual(contentTerms(null), []);
    assert.equal(analyseQuestion(null).isQuestion, false);
  });
});
