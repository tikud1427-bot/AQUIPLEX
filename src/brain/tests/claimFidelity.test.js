/**
 * Claim fidelity — negation, modality and time survive the WRITE.
 *
 * WHAT WAS WRONG
 * --------------
 * The conversation lane stored a verbatim sentence and an entity list, and
 * nothing else. Measured on `extraction-core.v1` (200 cases, 167 claims):
 *
 *     fidelity_accuracy   0.0%
 *     negation detection  45.0%   ...and every one captured was stored POSITIVE
 *
 * So the store held "I don't use Kubernetes" as an ASSERTED fact. The text kept
 * the "don't", so a careful reader might survive it — but nothing in the DATA
 * said the claim was negative, and every consumer had to re-derive it from
 * prose. Two derivations of the same thing can disagree, and the one that
 * disagrees silently is the one that reaches the model.
 *
 * AFTER:  fidelity_accuracy 55.1%,  silence_on_negatives 75.0% → 80.0%,
 *         detection_recall UNCHANGED at 61.3% — the request gate removed only
 *         noise and cost no real claims.
 *
 * `predicate_accuracy` stays 0.0% on purpose and a test below pins that it is
 * not being faked.
 *
 * BITE, MEASURED (revert the named change → count failures):
 *   polarity written onto the fact        → 3 fail
 *   modality precedence (question>quote>hypothetical>intent) → 4 fail
 *   time expression captured              → 2 fail
 *   request gate                          → 3 fail
 *   stored field preferred over prose     → 2 fail
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFidelity, isRequest } from '../knowledgeExtraction/claimFidelity.js';
import { buildConversationFacts } from '../knowledgeExtraction/conversationFacts.js';
import { statementPolarity, statementIsPast } from '../../pic/questionShape.js';

const ENTS = [
  { id: 'k', canonical: 'Kubernetes', type: 'name', aliases: [] },
  { id: 's', canonical: 'Stripe', type: 'name', aliases: [] },
  { id: 'self', canonical: 'You', type: 'person', aliases: [], isSelf: true },
  { id: 'dev', canonical: 'Dev', type: 'person', aliases: [] },
];

const build = text => buildConversationFacts(
  { conversationId: 'c', turn: 1, userMessage: text, entities: ENTS },
  { minEntities: 1 },
);
const firstFact = text => build(text).facts?.[0] ?? null;

describe('claim fidelity — reading what a sentence commits to', () => {
  test('negation is read as polarity, not left in the prose', () => {
    assert.equal(readFidelity("I don't use Kubernetes.").polarity, 'negated');
    assert.equal(readFidelity('I no longer work with Kubernetes.').polarity, 'negated');
    assert.equal(readFidelity('We rejected the Stripe migration.').polarity, 'negated');
    assert.equal(readFidelity('I use Kubernetes.').polarity, 'asserted');
  });

  test('an unmarked declarative is a FACT, and that is not a guess', () => {
    // `asserted`/`fact` are what an unmarked declarative sentence MEANS. They
    // are the honest default, not a confidence dressed up as a finding.
    const f = readFidelity('I run product at Nummo.');
    assert.equal(f.polarity, 'asserted');
    assert.equal(f.modality, 'fact');
  });

  test('MODALITY PRECEDENCE: a question overrides everything inside it', () => {
    // Nothing in a question is being claimed at all, so the interrogative
    // frame wins over any intent or report it contains.
    assert.equal(readFidelity("Did she say we'll use Stripe?").modality, 'question');
    assert.equal(readFidelity('Should we move to Stripe?').modality, 'question');
  });

  test('MODALITY PRECEDENCE: reported speech beats the intent it reports', () => {
    // "She said we'll use Stripe" is HER intent, reported. Storing it as the
    // speaker's own plan attributes a commitment to the wrong person.
    assert.equal(readFidelity("Priya said we'll use Stripe.").modality, 'quote');
  });

  test('MODALITY PRECEDENCE: a conditional beats the intent inside it', () => {
    // "If we win we'll hire two" is not a hiring plan. Storing it as one
    // manufactures a decision the user never made.
    assert.equal(readFidelity("If we win the round we'll hire two engineers.").modality, 'hypothetical');
  });

  test('intent is distinguished from accomplished fact', () => {
    assert.equal(readFidelity('I want to migrate to Stripe.').modality, 'intent');
    assert.equal(readFidelity('I migrated to Stripe.').modality, 'fact');
  });

  test('a temporal qualifier is captured rather than dropped', () => {
    // Presence is what matters. Resolving "last month" to an instant needs the
    // turn timestamp and belongs with the claim schema — but a claim that
    // carries a qualifier and stores none has LOST it, which is the failure.
    assert.ok(readFidelity('I moved to Stripe last month.').time);
    assert.ok(readFidelity('We ship in Q3.').time);
    assert.equal(readFidelity('I run product at Nummo.').time, null);
  });

  test('past-tense knowledge is marked as past', () => {
    assert.equal(readFidelity('I used to work at Intercom.').tense, 'past');
    assert.equal(readFidelity('I work at Nummo.').tense, 'present');
  });

  test('malformed input never throws', () => {
    for (const bad of [null, undefined, '', 42, {}]) {
      assert.doesNotThrow(() => readFidelity(bad));
      assert.doesNotThrow(() => isRequest(bad));
    }
  });
});

describe('claim fidelity — what reaches the store', () => {
  test('a negated sentence is STORED negated', () => {
    // The whole point. Not "the text contains a negation" — the DATA says so.
    const f = firstFact("I don't use Kubernetes.");
    assert.ok(f, 'nothing was written');
    assert.equal(f.polarity, 'negated');
  });

  test('modality and time reach the stored fact', () => {
    const f = firstFact('I want to migrate to Stripe next quarter.');
    assert.equal(f.modality, 'intent');
    assert.ok(f.time, 'the temporal qualifier was dropped on write');
  });

  test('NO PREDICATE IS INVENTED', () => {
    // `predicate_accuracy` is 0% and stays 0%. A predicate is a relation from a
    // controlled vocabulary — choosing `works_at` over `role_is` is a semantic
    // judgement belonging to the claim schema. Surface rules guessing predicate
    // names would score against this dataset and transfer nowhere, so the
    // honest report is a real fidelity number beside an unchanged zero.
    const f = firstFact('I run product at Nummo.');
    assert.equal(f.predicate, undefined, 'a predicate appeared — verify it is real, not fitted');
  });

  test('REQUEST GATE: an imperative is not stored as knowledge', () => {
    // "Explain how OAuth works to me." produced a fact because OAuth reads as
    // an entity. Six of ten false positives were this shape. An imperative
    // stored as a fact gets retrieved later as though the user had told us
    // something about themselves.
    assert.equal(build('Explain how Stripe works to me.').facts.length, 0);
    assert.equal(build('Please summarise the Stripe docs.').facts.length, 0);
    assert.equal(build('Can you check the Kubernetes logs?').facts.length, 0);
  });

  test('REQUEST GATE: a claim that merely contains a verb is still stored', () => {
    // The cost of over-gating is a lost claim, so the gate stays narrow: only
    // a LEADING imperative. "We check the logs daily" is a habit worth keeping.
    assert.ok(build('We check the Kubernetes logs daily.').facts.length > 0);
    assert.ok(build('I run product at Stripe.').facts.length > 0);
  });
});

describe('claim fidelity — one canonical polarity, read by retrieval', () => {
  test('the STORED field is preferred over re-deriving from prose', () => {
    // Two places deriving polarity from the same prose is two places that can
    // disagree about what the user said.
    assert.equal(statementPolarity({ statement: 'anything at all', polarity: 'negated' }), 'negated');
    assert.equal(statementPolarity({ statement: "I don't use it", polarity: 'asserted' }), 'affirmed');
    assert.equal(statementIsPast({ statement: 'no wording cue here', tense: 'past' }), true);
  });

  test('prose is still read when the field is absent', () => {
    // Facts written before fidelity landed, and the document lane, which does
    // not run through it. The fallback is not dead code.
    assert.equal(statementPolarity({ statement: 'I no longer own the parser.' }), 'negated');
    assert.equal(statementIsPast({ statement: 'I used to work at Intercom.' }), true);
  });

  test('a fact written by the lane round-trips through the reader', () => {
    const f = firstFact("I don't use Kubernetes.");
    assert.equal(statementPolarity(f), 'negated');
  });
});

// ── Third-person subjects: the user's world is mostly other people ───────────
//
// Tier 2 of the solo-proper-noun pass admitted a sentence-initial capitalised
// word only when a copula followed it (`is/was/are/were/has/have/had`). Sound
// for "Razorpay is our competitor", and it silently rejected every person who
// DOES something:
//
//     "Dev reports to me."                 → `reports`    rejected
//     "Rahul joined the billing team."     → `joined`     rejected
//     "Maya introduced me to an investor." → `introduced` rejected
//
// Measured on `extraction-core.v1`, subject recall split sharply by subject
// kind: 58.9% for the speaker, 18.1% for named third parties. Colleagues,
// reports and counterparties are most of a person's world and the lane could
// not see them unless the sentence happened to be copular.
//
// AFTER, and both directions moved the right way at once:
//     subject_recall        41.3% → 55.7%
//     detection_recall      61.3% → 71.9%
//     silence_on_negatives  80.0% → 87.5%
//     false_positives           8 → 5
//
// BITE, MEASURED (revert the named change → count failures):
//   morphological subject test        → 3 fail
//   wh vs polar question split        → 3 fail
//   interrogative + SQL blocklist     → 2 fail

import { extractWithCurrentEngine, surfacesOf } from '../../../eval/adapters/currentExtractor.mjs';

const subjects = text => surfacesOf(extractWithCurrentEngine(text));

describe('third-person subjects — a subject is followed by a VERB, not a copula', () => {
  test('a person who DOES something is recognised', () => {
    assert.ok(subjects('Dev reports to me.').has('dev'));
    assert.ok(subjects('Rahul joined the billing team in March.').has('rahul'));
    assert.ok(subjects('Maya introduced me to our first investor.').has('maya'));
  });

  test('the copular case that already worked still works', () => {
    assert.ok(subjects('Razorpay is our main competitor.').has('razorpay'));
  });

  test('a common noun opening a sentence is NOT minted as a name', () => {
    // This is the risk the broadening creates, and COMMON_SUBJECT is what
    // holds it. A bad entity is worse than a missing one: it becomes a node
    // other turns attach facts to.
    assert.ok(!subjects('Latency increased last week.').has('latency'));
    assert.ok(!subjects('Onboarding slowed in March.').has('onboarding'));
    assert.ok(!subjects('Payments are our biggest cost.').has('payments'));
  });

  test('interrogatives and SQL keywords are never names', () => {
    // Broadening the verb test began minting these, because they are
    // sentence-initial, capitalised, and followed by a finite verb.
    assert.ok(!subjects('Why did the deploy fail?').has('why'));
    assert.ok(!subjects('What are the trade-offs here?').has('what'));
    assert.ok(!subjects('SELECT * FROM users WHERE id = 1;').has('from'));
  });
});

describe('questions — polar carries a claim, wh does not', () => {
  test('a WH-question yields no stored fact', () => {
    // The thing being asked for is exactly the part that is missing. What is
    // left is a presupposition, and storing a presupposition as a fact is how
    // a guess becomes knowledge the user never gave.
    assert.equal(build('Why did the deploy fail?').facts.length, 0);
    assert.equal(build('What are the trade-offs here?').facts.length, 0);
    assert.equal(build('How do I set up Kubernetes locally?').facts.length, 0);
  });

  test('a POLAR question keeps its claim, marked as a question', () => {
    // "Do I still report to Priya?" puts a specific proposition up for
    // confirmation. Both the proposition and the fact that the user is unsure
    // about it are worth keeping — recorded, and explicitly NOT asserted.
    const f = firstFact('Are we still using Stripe?');
    assert.ok(f, 'a polar question was dropped entirely');
    assert.equal(f.modality, 'question', 'a queried proposition was stored as asserted');
  });

  test('gating BOTH kinds was measurably worse', () => {
    // Blanket question-gating cost 3.7 points of detection recall and bought
    // no honesty, because the negatives it caught were all wh-shaped anyway.
    assert.ok(build('Should I make Dev the tech lead?').facts.length > 0);
  });
});
