/**
 * Clause-level sensitive redaction (memory/sensitivity.js keptClauses, 2026-11-06).
 *
 * A sentence about health or mood loses only its sensitive clause when what
 * remains is plainly independent of it; any doubt withholds the whole sentence.
 * Synthetic sentences only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveSentences, keptClauses, classifyText, classifySensitivity, sensitivePolicy, withheld } from '../sensitivity.js';
import { splitClauses } from '../sentenceParser.js';

const red = t => redactSensitiveSentences(t);
const SENSITIVE_WORDS = /asthma|therap|depress|anxi|diagnos|medication|doctor|sertraline|clinic|pain|improving|okafor|harlow/i;

describe('mixed sentences keep only the independent clause', () => {
  test('a sensitive clause goes; an unrelated one stays (the 2026-11-04 case)', () => {
    assert.equal(red('My mentor is Grace Liu and my therapist is private. I like tea.').text, 'My mentor is Grace Liu. I like tea.');
  });
  test('either order, any boundary the splitter knows', () => {
    assert.equal(red('I have been feeling depressed lately, and I moved to Leeds in March.').text, 'I moved to Leeds in March.');
    assert.equal(red('I moved to Leeds in March; I have been diagnosed with asthma.').text, 'I moved to Leeds in March.');
  });
  test('the kept text is not corrupted (a trailing "s" survives)', () => {
    assert.equal(red('I was diagnosed with asthma and I run marathons.').text, 'I run marathons.');
  });
  test('what is removed is reported by kind', () => {
    assert.deepEqual(red('My mentor is Grace Liu and my therapist is private.').removed, ['health']);
  });
});

describe('ambiguous boundaries withhold the whole sentence', () => {
  test('no clause boundary: the whole sentence goes', () => {
    assert.equal(red('I was diagnosed with asthma after the Lisbon trip.').text, '');
  });
  test('a causal link is not a boundary ("…, so I …")', () => {
    assert.equal(red('I was diagnosed with cancer, so I left my job at Fintrail.').text, '');
  });
  test('a clause shorter than three words is not split off', () => {
    assert.deepEqual(splitClauses('I have asthma and I ran'), ['I have asthma and I ran']);
    assert.equal(red('I have asthma and I ran.').text, '');
  });
  test('every clause sensitive: nothing stays', () => {
    assert.equal(red('I have asthma and my therapist says I am improving.').text, '');
  });
});

describe('masking and cross-clause context cannot bypass classification', () => {
  test('sensitive only across clauses ("The doctor called, and I was relieved."): withheld whole', () => {
    assert.ok(classifyText('The doctor called, and I was relieved.'), 'control: the sentence classifies');
    assert.equal(keptClauses('The doctor called, and I was relieved.'), null);
    assert.equal(red('The doctor called, and I was relieved.').text, '');
  });
  test('product / app / work framing never makes a sensitive term keepable', () => {
    // A first-person care relationship classifies whatever the framing (CARE_RELATION)…
    assert.equal(classifyText('we are building an app for my therapist'), 'health');
    assert.equal(classifyText('I see a therapist at Harlow Clinic'), 'health');
    // …and a framed clause that only names care-domain words still cannot be kept beside a withheld one.
    for (const s of ['I have been feeling anxious lately and we are building an app for my therapist.',
      'I was diagnosed with asthma and our startup sells inhaler tracking to clinics.',
      'My knee hurts constantly, and my company launched a pain points dashboard for doctors.']) {
      const r = red(s);
      assert.ok(r.removed.length, `control: ${s}`);
      assert.doesNotMatch(r.text, SENSITIVE_WORDS, `${s} → "${r.text}"`);
    }
  });
  test('an unrelated product clause beside a health clause still stays (no false withholding)', () => {
    assert.equal(red('I have asthma, and we are building an app for runners.').text, 'we are building an app for runners.');
  });
});

describe('no fragment reveals the withheld information indirectly', () => {
  test('a clause pointing back at the sensitive one goes with it', () => {
    for (const s of ['I have been seeing a therapist and she says I should rest more.',
      'My sister was diagnosed with cancer and they start treatment in May.',
      'I take sertraline daily, and it makes mornings easier.']) {
      assert.equal(red(s).text, '', s);
    }
  });
  test('a shared name or detail goes with it', () => {
    assert.equal(red('I see a therapist at Harlow Clinic, and I also run at Harlow Park.').text, '');
    assert.equal(red('My doctor is Dr Okafor and my landlord knows Okafor well.').text, '');
  });
  test('the stored text never contains the withheld clause or its details', () => {
    const r = red('My mentor is Grace Liu and my therapist is Dr Okafor. We launch on May 2.');
    assert.equal(r.text, 'My mentor is Grace Liu. We launch on May 2.');
    assert.doesNotMatch(r.text, /therap|okafor/i);
  });
});

describe('ordinary sentences are untouched; existing protections hold', () => {
  test('non-sensitive text passes through byte for byte', () => {
    for (const s of ['We launch on May 2.', 'My manager is Priya Rao and my accountant is Lena Ortiz.', 'I live in Austin and I work at Northbeam.',
      'Help me write a cold email to Acme about our pilot.', 'The pain points dashboard ships Friday.']) {
      assert.equal(red(s).text, s);
      assert.deepEqual(red(s).removed, []);
    }
  });
  test('single-clause health and mood sentences are still withheld whole', () => {
    assert.deepEqual(red("I'm very bored. Help me write a cold email to Acme about our pilot."), { text: 'Help me write a cold email to Acme about our pilot.', removed: ['mood'] });
    assert.equal(red('I was diagnosed with asthma last year.').text, '');
    assert.equal(red('My right eye keeps twitching.').text, '');
  });
});

describe('the fact classifier agrees with redaction', () => {
  const SRC = 'My mentor is Grace Liu and my therapist is private.';
  test('a fact from a kept clause is not sensitive; one from a withheld sentence is', () => {
    assert.equal(classifySensitivity({ key: 'custom_mentor', value: 'Grace Liu', clause: 'My mentor is Grace Liu', sourceText: SRC }), null);
    assert.equal(classifySensitivity({ key: 'custom_mentor', value: 'Grace Liu', clause: 'my landlord knows Okafor well', sourceText: 'My doctor is Dr Okafor and my landlord knows Okafor well.' }), 'health');
    assert.equal(classifySensitivity({ key: 'custom_x', value: 'relieved', clause: 'I was relieved', sourceText: 'The doctor called, and I was relieved.' }), 'health');
  });
  test('without a clause the whole source decides, as before', () => {
    assert.equal(classifySensitivity({ key: 'custom_mentor', value: 'Grace Liu', sourceText: SRC }), 'health');
  });
});

describe('opt-in and topic permission are unchanged', () => {
  const fact = { key: 'custom_condition', value: 'asthma', sourceText: 'I was diagnosed with asthma last year.' };
  test('withheld unless opted in AND the turn is about that kind', () => {
    assert.equal(withheld(fact, sensitivePolicy({ rememberSensitive: false, message: 'How is my asthma?' })), true);
    assert.equal(withheld(fact, sensitivePolicy({ rememberSensitive: true, message: 'What should I cook tonight?' })), true);
    assert.equal(withheld(fact, sensitivePolicy({ rememberSensitive: true, message: 'Is my asthma getting worse?' })), false);
  });
});
