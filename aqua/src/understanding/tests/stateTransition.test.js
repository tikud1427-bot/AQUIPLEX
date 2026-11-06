/**
 * State transitions between a user's statements (understanding/stateTransition.js).
 *
 * Pure. Each "continues" positive is paired with a near-miss that must NOT
 * link, because a false link costs a line of context in every lane that uses
 * this, and the module's contract is that it never supersedes or hides.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stem, tokens, transitionOf, continues, sharedSubject, specificityOver, strongContinuation, acronymLinks } from '../stateTransition.js';

describe('tokens and stem', () => {
  test('inflections fold onto one term, doubled consonants included', () => {
    assert.deepEqual(['launching', 'launched', 'launches', 'launch'].map(stem), ['launch', 'launch', 'launch', 'launch']);
    assert.deepEqual(['shipping', 'ship'].map(stem), ['ship', 'ship']);
    assert.deepEqual(['planned', 'plan'].map(stem), ['plan', 'plan']);
    assert.equal(stem('stopped'), 'stop');
  });

  test('short words and -ss words are left alone', () => {
    assert.equal(stem('added'), 'add', 'undoubling never leaves a two-letter stem');
    assert.equal(stem('class'), 'class');
    assert.equal(stem('falling'), 'fall', 'l is not undoubled');
  });

  test('an agent noun meets its verb only when five letters remain', () => {
    assert.deepEqual(['blocker', 'blockers', 'blocking', 'blocked'].map(stem), ['block', 'block', 'block', 'block']);
    assert.equal(stem('printer'), 'print');
    for (const w of ['number', 'later', 'water', 'corner', 'user']) assert.equal(stem(w), w, `${w} keeps its identity`);
  });

  test('stop words and punctuation drop out', () => {
    assert.deepEqual(tokens("The zoning permit came through."), ['zon', 'permit', 'came', 'through']);
  });
});

describe('transitionOf: the grammar of a later word', () => {
  const cases = [
    // [sentence, resolves, changes, stillOpen, corrects, pending]
    ['The zoning permit came through.',                                   true,  false, false, false, false],
    ['Good news, FCC signed off on the lamp last night.',                 true,  false, false, false, false],
    ['The roof is repaired, finally dry in there.',                       true,  false, false, false, false],
    ['The audit is done and clean.',                                      true,  false, false, false, false],
    ["Oakline got the production keys, so the checkout isn't blocked anymore.", true, true, false, false, true],
    ['Shipping slips to April 20.',                                       false, true,  false, false, false],
    ['The factory bumped its quote to $16.50 per unit.',                  false, true,  false, false, false],
    ['We dropped Shenzhen Arc and signed with Penang Forge instead.',     false, true,  false, false, false],
    ["I tore a calf muscle, so I'm pulling out of the Berlin Marathon.",  false, true,  false, false, false],
    ['Still no word from the city on the license renewal.',               false, false, true,  false, false],
    ['Sorry, I misspoke — the submission deadline is June 9, not June 2.', false, true,  false, true,  true],
    ['Our Kickstarter campaign is stuck waiting on FCC certification.',   false, false, false, false, true],
    // "fixes" is the open state's condition, not its closing.
    ["We can't open the second bay until the landlord fixes the roof leak.", false, false, false, false, true],
  ];
  for (const [s, resolves, changes, stillOpen, corrects, pending] of cases) {
    test(s, () => {
      const t = transitionOf(s);
      assert.deepEqual({ resolves: t.resolves, changes: t.changes, stillOpen: t.stillOpen, corrects: t.corrects, pending: t.pending },
        { resolves, changes, stillOpen, corrects, pending });
      assert.equal(t.marked, resolves || changes || stillOpen || corrects);
    });
  }

  test('a plain statement and a plan announce no transition', () => {
    for (const s of ['Our head baker is Luis.', 'We plan to ship the first batch on March 3.']) {
      assert.equal(transitionOf(s).marked, false, s);
    }
  });

  test('an undecided idea is a later word on its subject (certainty changed), never a resolution', () => {
    // Recall's original change markers included "decided"; the hedge itself is
    // stored separately (conversationFacts reads modality), so linking it to
    // an earlier plan shows the model the plan is now open, not settled.
    const t = transitionOf("We might add a delivery service, but we haven't decided.");
    assert.equal(t.marked, true);
    assert.equal(t.resolves, false);
  });
});

describe('continues: is a later statement the next word on an earlier one?', () => {
  const pool = [
    'Now the San Antonio opening is blocked by a zoning permit.',
    'The zoning permit came through.',
    'The San Antonio opening depends on getting an SBA loan.',
    'Derek Shaw moved to another branch; our new loan officer is Kim Alvarez.',
    'I want to open a second shop in San Antonio next summer.',
    'We decided not to do wholesale to coffee shops this year.',
    'Our Kickstarter campaign is stuck waiting on FCC certification.',
    'Good news, FCC signed off on the lamp last night.',
    "We're raising a $1.5 million seed round.",
    'We increased the round size to $2 million.',
  ];
  const specific = specificityOver(pool);

  test('resolved blocker in different words: one shared subject word suffices', () => {
    assert.ok(continues('Good news, FCC signed off on the lamp last night.', 'Our Kickstarter campaign is stuck waiting on FCC certification.', { specific }));
    assert.deepEqual(continues('The zoning permit came through.', 'Now the San Antonio opening is blocked by a zoning permit.', { specific }), ['zon', 'permit']);
  });

  test('changed amount: two shared words', () => {
    assert.ok(continues('We increased the round size to $2 million.', "We're raising a $1.5 million seed round.", { specific }));
  });

  test('correction: one shared word suffices', () => {
    assert.ok(continues('Actually, correction: the launch is December 16, not December 9.', "Because of that, Splitpay's launch moved to December 9.",
      { exclude: new Set(tokens('When is Splitpay launching?')) }));
  });

  test('a plain change sharing one word with a blocker is NOT its continuation', () => {
    assert.equal(continues('Derek Shaw moved to another branch; our new loan officer is Kim Alvarez.',
      'The San Antonio opening depends on getting an SBA loan.', { specific }), null);
    assert.equal(continues('We decided not to do wholesale to coffee shops this year.',
      'I want to open a second shop in San Antonio next summer.', { specific }), null);
  });

  test('without a transition marker nothing continues, however much is shared', () => {
    assert.equal(continues('The San Antonio zoning permit office is on Elm Street.', 'Now the San Antonio opening is blocked by a zoning permit.', { specific }), null);
  });

  test('words the question supplied are not shared subject', () => {
    const exclude = new Set(tokens('Is the zoning permit still blocking us?'));
    assert.deepEqual(sharedSubject('The zoning permit came through.', 'Now the San Antonio opening is blocked by a zoning permit.', { exclude }), []);
  });

  test('specificity: a young store still has a shared subject; a word in most statements is not one', () => {
    const young = specificityOver(['Our Kickstarter campaign is stuck waiting on FCC certification.', 'Good news, FCC signed off on the lamp last night.']);
    assert.equal(young('fcc'), true, 'two facts sharing a word: idf alone would call it generic');
    const big = specificityOver(['the bakery a', 'the bakery b', 'the bakery c', 'the bakery d', 'the bakery e', 'zoning f']);
    assert.equal(big('bakery'), false, '5 of 6');
    assert.equal(big('zon'), true);
  });

  test('an acronym and its spelled-out form are one subject, between statements only', () => {
    assert.deepEqual(acronymLinks('I stopped the TA job.', 'I work part-time as a teaching assistant.'), ['ta']);
    assert.ok(continues('I stopped the TA job to focus on applications.', 'I work part-time as a teaching assistant for the algorithms course.'));
    assert.deepEqual(acronymLinks('Our friends visited us in Lisbon.', 'United States'), [], 'lower-case "us" is not an acronym');
    assert.deepEqual(acronymLinks('Meet at 3 PM.', 'the party meeting'), [], 'a clock time is not an acronym');
    assert.deepEqual(acronymLinks('Our PM is Laila.', 'the morning standup'), [], 'no run of content words spells it');
  });

  test('a state that ended, about the same NAME, continues on one shared word', () => {
    assert.deepEqual(continues('I resigned from Hartwell last Friday.', "I'm employed at Hartwell Bank."), ['hartwell']);
    assert.deepEqual(continues('I sold the Civic and bought a used Tesla Model 3.', 'My car is a 2012 Honda Civic.'), ['civic']);
    assert.ok(continues('Shipping slips to April 20, and Boxwell is out.', 'Our warehouse partner is Boxwell Logistics.'));
    assert.equal(continues('I stopped the coffee habit.', 'The coffee machine broke.'), null, 'a common noun is too weak');
  });

  test('numbers are never the shared subject', () => {
    assert.deepEqual(sharedSubject('Tickets went from 30 to 40.', 'We have 30 chairs.'), []);
  });

  test('strength: a correction always; a resolution only of an open state', () => {
    const open = transitionOf('The round is blocked until we finish our financial audit.');
    const closed = transitionOf('Our auditor is Mwangi & Co.');
    assert.equal(strongContinuation(transitionOf('The audit is done and clean.'), open), true);
    assert.equal(strongContinuation(transitionOf('The audit is done and clean.'), closed), false);
    assert.equal(strongContinuation(transitionOf('Actually, the auditor is Grant & Co.'), closed), true);
  });
});

describe('changeKind: a later word only when it is a stated fact (2026-11-02)', () => {
  test('endings, resolutions and changes', async () => {
    const { changeKind } = await import('../stateTransition.js');
    assert.equal(changeKind('I resigned from Hartwell last Friday.'), 'ended');
    assert.equal(changeKind('I passed the CFA level 1 exam!'), 'resolved');
    assert.equal(changeKind('We relocated to Bristol in June.'), 'changed');
    assert.equal(changeKind('Now Mellow is my biggest client'), 'changed');
  });
  test('negated, speculative and hypothetical clauses are not later words', async () => {
    const { changeKind } = await import('../stateTransition.js');
    for (const s of ["I haven't left Hartwell", "I'm thinking about leaving Hartwell next year.", 'I might move to Bristol next year if the job works out.',
      "We haven't decided whether to switch suppliers.", 'Maybe we will cancel the trip.']) assert.equal(changeKind(s), null, s);
  });
  test('a decided future is not speculation', async () => {
    const { speculative } = await import('../stateTransition.js');
    assert.equal(speculative('The launch will be on April 14.'), false);
    assert.equal(speculative('Imran will be the engineering lead from now on.'), false);
  });
});
