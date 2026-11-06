/**
 * The profile, identity card and cognitive model hold the CURRENT state, and
 * keep what was true before (2026-11-02).
 *
 * Through the production writer and reader of the legacy read:
 * memoryObserve (what a chat turn runs) → memoryRetrieve (the block the
 * prompt carries: IDENTITY + USER PROFILE + COGNITIVE MODEL).
 *
 * History of this file: it first pinned the user's later words as NOTES
 * beside the old value ("Company: Hartwell Bank (since changed — …)"). The
 * current-state resolver (memory/factChange.js resolveCurrentState) replaced
 * notes with the current value wherever the user stated it; a note remains
 * only where the new value is not given or the change may not be theirs.
 * Every positive has a control that must stay untouched.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-current-state-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;

const engine = await import('../engine.js');
const { sensitivePolicy } = await import('../sensitivity.js');
const { getFact, getFacts } = await import('../longTermMemory.js');
const { laterWordsOnFacts, resolveCurrentState, preferenceSupersedes } = await import('../factChange.js');

let n = 0;
function say(ownerId, userMessage) {
  engine.memoryObserve(ownerId, { userMessage, taskType: 'conversation', workspaceId: null, conversationId: `${ownerId}-c`, userId: ownerId,
    requestId: `r${n++}`, extractMessage: userMessage, rememberSensitive: false });
}
function owner(...turns) {
  const ownerId = `user:current-state-${n++}`;
  for (const t of turns) say(ownerId, t);
  return ownerId;
}
const block = (ownerId, query) => engine.memoryRetrieve(ownerId, { query, taskType: 'conversation', factLimit: 10, requestId: 'q',
  semanticScores: null, fileChunks: [], legacyUserMemory: true, legacyVeto: null, sensitive: sensitivePolicy({ rememberSensitive: false, message: query }) }).block ?? '';
const line = (b, re) => b.split('\n').find(l => re.test(l)) ?? '';

describe('a stated new value becomes the current value; the old one is history', () => {
  test('employer and role, everywhere the prompt says who the user is', () => {
    const o = owner("I'm a data analyst at Fintrail.", 'I now work at Northbeam as a senior analyst.');
    const b = block(o, 'Where do I work?');
    assert.match(line(b, /^- Company:/), /Northbeam/);
    assert.match(line(b, /workplace:/), /Northbeam \(previously: Fintrail\)/);
    assert.match(line(b, /Profession:/), /senior analyst \(previously: data analyst\)/);
    assert.ok(!b.split('\n').some(l => /^- [^V].*\(since changed/.test(l)), 'no fact line is a note');
    const f = getFact(o, 'workplace');
    assert.equal(f.history.at(-1).value, 'Fintrail', 'the previous value is a revision');
    assert.match(f.history.at(-1).sourceMessage, /Fintrail/, 'with the sentence that stated it');
    assert.match(f.sourceText, /now work at Northbeam/, 'provenance of the current value');
    assert.deepEqual(f.transitions.at(-1).from, 'Fintrail');
  });

  test('a successor named in the same sentence as a departure', () => {
    const o = owner('My bank contact for the loan is Derek Shaw at Lone Star Bank.', 'Derek Shaw moved to another branch; our new loan officer is Kim Alvarez.');
    assert.match(line(block(o, 'Who should I call about the loan?'), /bank contact for the loan/), /: Kim Alvarez \(previously: Derek Shaw at Lone Star Bank\)/);
  });

  test('a stated move to a new employer wins over a goal that shares its words', () => {
    // Architecture probe 2026-11-02: the goal shared "senior analyst" with the
    // move, the match was "ambiguous", and Fintrail stayed the employer.
    const o = owner("I'm a data analyst at Fintrail.", 'My goal is to get promoted to senior analyst at Fintrail.', 'I now work at Northbeam as a senior analyst.');
    assert.match(line(block(o, 'Where do I work?'), /^- Company:/), /Northbeam/);
  });

  test('an intention is not a change: a goal mentioning the employer leaves it current', () => {
    // Architecture probe 2026-11-02: "promoted" read as a change and the card
    // said "Company: Fintrail (since changed — they said: 'My goal is…')".
    const o = owner("I'm a data analyst at Fintrail.", 'My goal is to get promoted to senior analyst at Fintrail.');
    const l = line(block(o, 'Where do I work?'), /^- Company:/);
    assert.match(l, /Fintrail$/);
    assert.equal(getFact(o, 'workplace').laterWord, undefined);
  });

  test('the slot named in full wins over a fact matched by value', () => {
    const o = owner('My biggest client is Oakline.', 'My newest client is Mellow.', 'Mellow is now my biggest client.');
    const b = block(o, 'Who are my clients?');
    assert.match(line(b, /biggest client/), /Mellow \(previously: Oakline\)/);
    assert.match(line(b, /newest client/), /: Mellow$/, 'control: the other slot untouched');
  });

  test('a past-tense relocation sets the city; the identity card agrees', () => {
    const o = owner('I live in Leeds.', 'We relocated to Bristol in June.');
    assert.match(line(block(o, 'Where do I live?'), /^- City:/), /Bristol/);
  });

  test('sold one thing and bought another: the new one is current', () => {
    const o = owner('My car is a 2012 Honda Civic.', 'I sold my Civic and bought a used Tesla Model 3.');
    assert.match(line(block(o, 'What car do I drive?'), /car:/), /a used Tesla Model 3 \(previously: a 2012 Honda Civic\)/);
  });

  test('a CORRECTION is not a change: the wrong value is not offered as "previously"', () => {
    const corrected = owner('I live in Lisbon.', 'Actually, my city is now Porto.');
    const l = line(block(corrected, 'Where do I live?'), /^- City:/);
    assert.match(l, /Porto/);
    assert.doesNotMatch(l, /Lisbon/, 'Lisbon was a mistake, not where they lived');
    const moved = owner('I live in Lisbon.', 'We relocated to Porto in June.');
    assert.match(line(block(moved, 'Where do I live?'), /^- City:/), /Porto/, 'control: a move');
    assert.match(block(moved, 'Where do I live?'), /\(previously: Lisbon\)/, 'control: a move keeps the old city as history');
  });

  test('a changed date shows what it replaced', () => {
    const o = owner('My thesis is due on May 30.', 'My ETH application is due December 15.', 'The thesis deadline moved to June 13.');
    const b = block(o, 'What are my deadlines?');
    assert.match(line(b, /thesis/), /June 13 \(previously: due on May 30\)/);
    assert.match(line(b, /ETH application/), /December 15$/, 'control: the other deadline untouched');
  });
});

describe('an ended state is not current, and is not forgotten', () => {
  test('an employer the user left: none current, previously Hartwell, in their words', () => {
    const o = owner('I work at Hartwell Bank.', 'I no longer work at Hartwell.');
    const b = block(o, 'Where do I work?');
    assert.match(line(b, /^- Company:/), /none current \(previously: Hartwell Bank — they said: "I no longer work at Hartwell\."\)/);
    assert.ok(getFact(o, 'workplace').ended, 'kept, marked ended');
  });

  test('a possession sold with no successor moves to "No longer current"', () => {
    const o = owner('My car is a 2012 Honda Civic.', 'I sold my Civic last month.');
    const b = block(o, 'What car do I have?');
    const i = b.split('\n').findIndex(l => /^### No longer current/.test(l));
    assert.ok(i >= 0);
    assert.match(b.split('\n').slice(i).join('\n'), /car: a 2012 Honda Civic — they said: "I sold my Civic last month\."/);
  });

  test('a completed goal: no longer current in the profile, not active in the cognitive model', () => {
    const o = owner('My goal is to pass the CFA level 1 exam.', 'I passed the CFA level 1 exam!');
    const b = block(o, 'What am I working toward?');
    // 2026-11-04: an achieved goal says so in its history line ("(achieved)"), not merely that it is gone.
    assert.match(b, /No longer current[\s\S]*pass the CFA level 1 exam \(achieved\) — they said: "I passed/);
    assert.doesNotMatch(b, /Active goals: "pass the CFA/);
  });

  test('recall notes carry both the replaced and the ended', () => {
    const replaced = owner('My car is a 2012 Honda Civic.', 'I sold my Civic and bought a used Tesla Model 3.');
    assert.ok(engine.legacySupersessionNotes(replaced).some(x => x.quotes.some(q => /Honda Civic/.test(q)) && /Tesla/.test(x.now)));
    const ended = owner('I work at Hartwell Bank.', 'I no longer work at Hartwell.');
    assert.ok(engine.legacySupersessionNotes(ended).some(x => x.quotes.some(q => /Hartwell Bank/.test(q)) && /no longer work/.test(x.now)));
  });

  test('the cognitive model does not keep a replaced value as who the user is', () => {
    Object.assign(process.env, { AQUA_UUS: 'on', AQUA_SELF_ENTITY: 'on' });
    try {
      const control = owner("I'm employed at Hartwell Bank as a risk analyst.");
      assert.match(line(block(control, 'Where do I work?'), /^Identity:/), /Hartwell Bank/, 'control: the belief is shown');
      const o = owner("I'm employed at Hartwell Bank as a risk analyst.", 'I resigned from Hartwell last Friday.');
      assert.doesNotMatch(line(block(o, 'Where do I work?'), /^Identity:/), /Hartwell/);
    } finally { delete process.env.AQUA_UUS; delete process.env.AQUA_SELF_ENTITY; }
  });
});

describe('scoped and uncertain values never overwrite the broader, current one', () => {
  test('a narrower value is its own fact; the broader one stands, unannotated', () => {
    const o = owner('My day rate is 650 euros.', 'I raised my day rate to 720 euros for new clients.');
    const b = block(o, 'What is my day rate?');
    assert.match(b, /day rate \(new clients\): 720 euros/);
    assert.match(line(b, /day rate: /), /: 650 euros$/);
  });

  test('"We sold the Civic" on MY car: current, flagged uncertain — not ended', () => {
    const o = owner('My car is a 2012 Honda Civic.', 'We sold the Civic.');
    assert.match(line(block(o, 'What car do I have?'), /car:/), /a 2012 Honda Civic \(uncertain whether still current/);
    assert.equal(getFact(o, 'custom_car').ended, undefined);
  });
});

describe('preferences evolve', () => {
  test('a new preference about the same thing replaces the old one; the old one is history', () => {
    const o = owner('I prefer long, detailed answers with lots of background.', 'I now prefer short bullet-point answers.');
    assert.match(line(block(o, 'Explain an index fund.'), /preference:/), /short bullet-point answers \(previously: long, detailed answers with lots of background\)/);
  });

  test('in a collection too: the older item retires, the unrelated one stays', () => {
    const o = owner('I prefer TypeScript over JavaScript.', 'I prefer long, detailed answers.', 'I prefer short bullet-point answers.');
    const pref = getFact(o, 'preference');
    assert.ok(pref.value.includes('TypeScript'), 'control: an unrelated preference stays');
    assert.ok(pref.value.includes('short bullet-point answers'));
    assert.ok(!pref.value.includes('long, detailed answers'));
    assert.equal(pref.retiredItems.at(-1).item, 'long, detailed answers');
  });

  test('a context-specific preference is kept with its context and replaces nothing', () => {
    const o = owner('I prefer short bullet-point answers.', 'For emails, I prefer a warm, formal tone.');
    const l = line(block(o, 'Draft an email.'), /preference:/);
    assert.match(l, /short bullet-point answers; a warm, formal tone \(for emails\)/);
  });

  test('a one-time wish is not a preference, and a moment\'s situation is not a fact', () => {
    const o = owner('I prefer detailed explanations.', "Just give me a short answer this time, I'm in a rush.");
    assert.deepEqual(getFact(o, 'preference').value, 'detailed explanations');
    assert.ok(!getFacts(o).some(f => /rush/.test(f.key)));
  });

  test('"I prefer X this time" is a wish for one answer, not a new preference', () => {
    const o = owner('I prefer detailed explanations.', "I prefer a short answer this time, I'm tired.");
    assert.deepEqual(getFact(o, 'preference').value, 'detailed explanations');
  });

  test('a preference reaches the answer whatever the question', () => {
    const o = owner('I prefer detailed explanations.');
    assert.match(block(o, 'Explain how a mortgage works.'), /preference: detailed explanations/);
  });

  test('supersession needs the same thing and the same context', () => {
    assert.equal(preferenceSupersedes('short bullet-point answers', 'long, detailed answers with lots of background'), true);
    assert.equal(preferenceSupersedes('a warm, formal tone (for emails)', 'short bullet-point answers'), false);
    assert.equal(preferenceSupersedes('short answers (for emails)', 'long answers'), false);
    assert.equal(preferenceSupersedes('TypeScript', 'short bullet-point answers'), false);
  });
});

describe('what must NOT change the current state', () => {
  const current = (b, re) => { const l = line(b, re); assert.ok(l, `present: ${re}`); assert.doesNotMatch(l, /since changed|previously|none current|uncertain/); };

  test('negated: "I haven\'t left Hartwell"', () => {
    current(block(owner('I work at Hartwell Bank.', "People keep asking, but I haven't left Hartwell — I'm still there."), 'Where do I work?'), /^- Company:/);
  });
  test('speculative on change words: "thinking about leaving Hartwell"', () => {
    current(block(owner('I work at Hartwell Bank.', "I'm thinking about leaving Hartwell next year."), 'Where do I work?'), /^- Company:/);
  });
  test('hypothetical future: "I might move to Bristol next year if…"', () => {
    current(block(owner('I live in Leeds.', 'I might move to Bristol next year if the job works out.'), 'Where do I live?'), /^- City:/);
  });
  test('a third party\'s change: "Mei Tan left Coinwise; she joined Stripe"', () => {
    const b = block(owner('I work at Coinwise as a product manager.', 'Mei Tan left Coinwise; she joined Stripe.'), 'Where do I work?');
    current(b, /^- Company:/);
    assert.doesNotMatch(b, /Stripe/);
  });
  test('an open state is a status, not a new value', () => {
    assert.deepEqual(laterWordsOnFacts('Now the San Antonio opening is blocked by a zoning permit.',
      [{ key: 'goals', value: 'open a second shop in San Antonio next summer', sourceText: "I'm planning to open a second shop in San Antonio next summer." }]), []);
  });
  test('ambiguous: one sentence about two stored facts touches neither', () => {
    assert.deepEqual(laterWordsOnFacts('I sold the Civic.', [
      { key: 'custom_car', value: 'a 2012 Honda Civic' }, { key: 'custom_old_car', value: 'a Honda Civic from 2009' }]), []);
  });
  test('a pronoun is never a value: "sold my Civic and bought it back" neither replaces nor ends', () => {
    const lw = { key: 'custom_car', text: 'I sold my Civic and bought it back.', clause: 'I sold my Civic', kind: 'ended' };
    assert.equal(resolveCurrentState(lw, { key: 'custom_car', value: 'a 2012 Honda Civic', sourceText: 'My car is a 2012 Honda Civic.' }).action, 'uncertain');
    const control = { key: 'custom_car', text: 'I sold my Civic and bought a used Tesla Model 3.', clause: 'I sold my Civic', kind: 'ended' };
    assert.equal(resolveCurrentState(control, { key: 'custom_car', value: 'a 2012 Honda Civic', sourceText: 'My car is a 2012 Honda Civic.' }).value, 'a used Tesla Model 3');
  });
  test('restating the old value after an uncertain note clears it', () => {
    const o = owner('My car is a 2012 Honda Civic.', 'We sold the Civic.');
    assert.ok(getFact(o, 'custom_car').laterWord, 'control');
    say(o, 'My car is a 2012 Honda Civic.');
    assert.equal(getFact(o, 'custom_car').laterWord, undefined);
  });
});
