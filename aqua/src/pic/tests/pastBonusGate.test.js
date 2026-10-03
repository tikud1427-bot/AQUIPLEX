/**
 * THE PAST-TENSE BONUS MUST NOT ADMIT A DOSSIER.
 *
 * Found by `npm run eval:gate` on the Sep 29 tree, identical on the uploaded
 * upload: retrieval-core `noise_lines` 16 -> 31, context-core 18 -> 34. Nine
 * unanswerable queries, nine of them past-tense or "did I" shaped:
 *
 *   "Where did I go to primary school?"   6 lines   (nothing about school)
 *   "What was my first job?"              6 lines
 *   "Where did I holiday last summer?"    7 lines
 *
 * Cause, in `factAffinity`: a past-tense ASK adds +0.2 to every PAST fact —
 * `else if (past && shape.currency === 'past') score += 0.2`. MIN_AFFINITY is
 * 0.18. So a fact with ZERO lexical overlap and ZERO kind support — "I used to
 * work at Intercom", "I moved to the Bangalore office" — scored 0.0 + 0.2 and
 * walked through the relevance gate on tense alone. A bonus that can lift a
 * fact from nothing to admitted is not a ranking term, it is an admission rule.
 *
 * THE FIX IS THE RULE KIND CREDIT ALREADY FOLLOWS: tense may RANK a fact whose
 * topic the question has accounted for; it may not ADMIT one the store has
 * nothing on. "primary school" with no school fact stays silence.
 *
 * Two companions, because gating the bonus took away two real answers that had
 * been getting in on the bonus alone and neither deserved to be lost:
 *   - `study` could not see `studied` (suffixes were only ever APPENDED);
 *   - `happened` was read as a topic word, so "What happened last month?"
 *     looked like a question about the word "happened".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyseQuestion, factAffinity, MIN_AFFINITY } from '../questionShape.js';

const score = (q, statement, entities = []) =>
  factAffinity(analyseQuestion(q), { statement, entities }, null, false, null);

describe('a past-tense ask ranks; it does not admit', () => {
  const PAST_FACTS = [
    'I used to work at Intercom.',
    'I moved to the Bangalore office last month.',
    'I switched from Python to Go last year.',
    'I no longer own the parser.',
  ];

  test('an unaccounted-for topic admits NO past fact on tense alone', () => {
    // NOT "Where did I holiday last summer?": its topic words include `last`,
    // which "…last month" satisfies, so it was already admitted at the Aug 30
    // baseline and is part of the 16 noise lines that baseline records. That is
    // a separate, older defect (a temporal modifier counted as a topic) and is
    // left visible rather than tuned around here.
    for (const q of ['Where did I go to primary school?', 'What was my first job?']) {
      for (const f of PAST_FACTS) {
        assert.ok(score(q, f).score < MIN_AFFINITY,
          `"${q}" admitted "${f}" (${score(q, f).score}) with no topic support — tense alone let it in`);
      }
    }
  });

  test('a topic-free past ask still ranks past facts: "What did I do last year?"', () => {
    const s = analyseQuestion('What did I do last year?');
    assert.deepEqual(s.topicTerms, []);
    assert.ok(score('What did I do last year?', 'I switched from Python to Go last year.').score >= MIN_AFFINITY,
      'a question with no topic must still be answerable from the past');
  });

  test('a past ask whose topic IS supported keeps the bonus', () => {
    const withBonus = score('What did I study before this?', 'I studied physics before this.');
    assert.ok(withBonus.score >= 0.4, `the supported-topic past bonus is gone: ${withBonus.score}`);
  });
});

describe('the two answers the gate must not cost', () => {
  test('`study` sees `studied` and `studies`; consonant+y inflects by replacing the y', () => {
    for (const f of ['I studied physics before this.', 'She studies law.', 'We are studying it.']) {
      assert.ok(score('What did I study?', f).lexical > 0, `"study" did not match: ${f}`);
    }
  });

  test('…and the rule is not a free pass: it needs a consonant before the y', () => {
    // `play` + y→ied would invent "plaied". `play` still takes its ordinary suffixes.
    assert.ok(score('What did I play?', 'I played chess.').lexical > 0);
    assert.equal(score('What did I play?', 'I plaied chess.').lexical, 0);
    // and an unrelated word that merely starts the same is not a match
    assert.equal(score('What did I study?', 'I studio-recorded it.').lexical, 0);
  });

  test('`happened` is not a topic word — "What happened last month?" is about TIME', () => {
    const s = analyseQuestion('What happened last month?');
    assert.deepEqual(s.topicTerms, [], `topicTerms=${JSON.stringify(s.topicTerms)} — the event verb became the topic`);
    assert.ok(score('What happened last month?', 'I moved to the Bangalore office last month.').score >= MIN_AFFINITY);
  });

  test('…but a real topic after it still binds: "What happened with the migration?"', () => {
    const s = analyseQuestion('What happened with the migration?');
    assert.deepEqual(s.topicTerms, ['migration']);
    assert.ok(score('What happened with the migration?', 'I used to work at Intercom.').score < MIN_AFFINITY);
  });
});
