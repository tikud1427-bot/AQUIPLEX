/**
 * Follow-up relevance v2 (memory/followUpRelevance.js, AQUA_RECALL_FOLLOWUP_V2).
 * Pure unit tests of the admission model, plus the selectRecall wiring: the
 * flag gate, anchored vs meaning-only seeds, budgets, and evidence taken only
 * from what would be quoted. The frozen end-to-end set is
 * eval/followup-relevance-v1 (graded separately).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR             = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-followup-v2-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI                 = '';
delete process.env.DATABASE_URL;

const F = await import('../followUpRelevance.js');
const R = await import('../episodicRecall.js');

const idf = new Map();   // every shared word specific unless a test says otherwise
const specific = { get: () => 2 };
const decide = (p, l, anchored = true) => F.decideFollowUp(p, l, { idf: specific, anchored });

describe('the flag', () => {
  test('off unless exactly "on"', () => {
    assert.equal(F.followUpV2Enabled({}), false);
    assert.equal(F.followUpV2Enabled({ AQUA_RECALL_FOLLOWUP_V2: 'true' }), false);
    assert.equal(F.followUpV2Enabled({ AQUA_RECALL_FOLLOWUP_V2: 'ON' }), true);
  });
});

describe('links', () => {
  test('a name is capitalised in both and not sentence-initial in at least one', () => {
    assert.equal(decide('Our accountant is Pellworth.', 'Pellworth raised the fees now.')?.link, 'E1');
    assert.equal(decide('Shipping is slow this year.', 'Shipping was actually fast, I misspoke.')?.link, 'C1', 'sentence-initial in both: a word, not a name');
  });
  test('a name in one statement and a common word in the other does not link as a name', () => {
    assert.equal(decide('Our biggest account is Corvid Shipping.', 'The shipping rates for overseas parcels increased.'), null);
  });
  test('identifiers link; ordinals, months and plain numbers do not', () => {
    assert.equal(decide("I'm entered in the Coldwater 5K next month.", 'I completed the 5K in 27 minutes.')?.link, 'E2');
    assert.equal(decide('Invoice QB-7710 is overdue.', 'QB-7710 was settled, all done.')?.link, 'E2');
    assert.equal(decide('The rent is due on the 1st.', 'The 1st floor flat changed tenants.'), null);
    assert.equal(decide('My dentist appointment is in March.', 'March was rainy, now it is dry again.'), null);
    assert.equal(decide('We paid 40 for the plot.', 'The 40 bus changed its route.'), null);
  });
  test('only specific words count (idf > 0.5)', () => {
    const generic = new Map([['plan', 0.1]]);
    assert.equal(F.decideFollowUp('The plan is pending approval.', 'Correction: the plan was approved.', { idf: generic, anchored: true }), null);
    assert.equal(F.decideFollowUp('The plan is pending approval.', 'Correction: the plan was approved.', { idf: new Map([['plan', 2]]), anchored: true })?.relation, 'correction');
  });
});

describe('relations (stateTransition grammar, vocabulary unchanged)', () => {
  test('correction / closure / update / revalue / change', () => {
    assert.equal(decide('The board report is due on the 12th.', 'Actually I misread it, the report is due on the 19th.')?.relation, 'correction');
    assert.equal(decide('We are waiting on the building inspection.', 'The inspection is done, all clear.')?.relation, 'closure');
    assert.equal(decide('The bridge repair should be done by June 1.', 'The bridge repair is delayed, still waiting on steel.')?.relation, 'update');
    assert.equal(decide('The recital is on April 5.', 'The recital moved to April 12.')?.relation, 'revalue');
    assert.equal(decide('Our team lunch is on Fridays.', 'Team lunch moved to Thursdays now.')?.relation, 'change');
  });
  test('closure needs an OPEN parent; a hedge is only ever speculative and never closes', () => {
    assert.equal(decide('We hired a gardener named Osric.', 'Osric finished the hedges.')?.relation, 'change', 'parent not open → not a closure');
    const h = decide('We are waiting on the gas inspection.', 'The gas inspection might be done by Friday.');
    assert.deepEqual([h?.relation, h?.hedged], ['speculative', true]);
    assert.deepEqual(F.relationsOf({ spec: false }, { spec: true }), ['speculative']);
  });
  test('sarcasm and negation are not closures', () => {
    assert.equal(decide("I'm studying for the actuarial exam.", 'Oh sure, I passed the actuarial exam, yeah right.'), null);
    assert.notEqual(decide('We are waiting on the passport renewal.', "The passport renewal hasn't arrived yet.")?.relation, 'closure');
  });
  test('an intention or a speculative parent is open: its later decision follows', () => {
    assert.equal(decide('My goal is to finish a ceramics course this year.', 'I completed the ceramics course last week.')?.relation, 'closure');
    assert.equal(decide('We might open a branch in Kessling, nothing decided.', 'Kessling is out; we expand elsewhere.')?.relation, 'closure');
  });
});

describe('the admission table', () => {
  test('one shared word + a plain change word is never enough', () => {
    assert.equal(decide('We need to hire an office manager.', 'The office printer was replaced last week.'), null);
    assert.equal(decide('Our office is on Danforth Street.', 'Maybe the office will change next year.'), null);
  });
  test('two shared words need a relation', () => {
    assert.equal(decide('The community garden plot costs $40 a season.', 'The community garden has a new compost bin.'), null);
  });
  test('an incidental name mention after a closed statement is not a follow-up', () => {
    assert.equal(decide('We hired Marisol as our designer.', 'Marisol recommended a great taco place.'), null);
  });
  test('meaning-only seeds get only the strongest links', () => {
    assert.equal(decide('Our team lunch is on Fridays.', 'Team lunch moved to Thursdays now.', false), null, 'C2 + change');
    assert.equal(decide('Our accountant is Pellworth.', 'Pellworth raised the fees now.', false), null, 'E1 + change');
    assert.equal(decide('We signed Brightwater Labs as a pilot customer.', 'Brightwater Labs extended the pilot.', false)?.link, 'E2');
    assert.equal(decide('The quarterly report is due on the 12th.', 'Correction: the report is due on the 19th.', false)?.relation, 'correction');
  });
});

// ── selectRecall wiring ─────────────────────────────────────────────────────
const DAY = 86_400_000, T0 = Date.UTC(2026, 4, 1);
const FILLER = ['The cat slept on the sofa all afternoon.', 'I watered the tomatoes on the balcony.', 'We watched a documentary about owls.',
  'The kettle whistles very loudly.', 'My neighbour plays the cello in the evenings.', 'I bought green apples at the market.',
  'The bus was crowded this morning.', 'I read a short story about a lighthouse keeper.'];
function unitsOf(statements) {
  const m = new Map();
  [...statements, ...FILLER.map((t, i) => [60 + i, t])].forEach(([day, content], i) => m.set(`c${i}`, { meta: { userId: 'w1', title: `c${i}` }, messages: [{ role: 'user', content, ts: T0 + day * DAY }] }));
  R.__clearCacheForTests();
  return R.collectUnits({ userId: 'w1', conversationId: 'none', conversations: m });
}
const pick = (r, re) => r.excerpts.find(e => re.test(e.text));

describe('selectRecall with AQUA_RECALL_FOLLOWUP_V2', () => {
  beforeEach(() => { process.env.AQUA_RECALL_FOLLOWUP_V2 = 'on'; });
  afterEach(() => { delete process.env.AQUA_RECALL_FOLLOWUP_V2; });

  test('off: the legacy step runs unchanged (no relation fields, legacy admits the one-word trap)', () => {
    delete process.env.AQUA_RECALL_FOLLOWUP_V2;
    const u = unitsOf([[1, 'We need to hire an office manager.'], [5, 'The office printer was replaced last week.']]);
    const r = R.selectRecall(u, 'Did we hire an office manager?', { allUnderChars: 0, k: 1 });
    assert.equal(r.stats.followUpMode, undefined);
    assert.equal(pick(r, /printer/)?.why, 'follow-up');
    assert.equal(pick(r, /printer/)?.relation, undefined);
  });

  test('on: the same trap is refused, a correction is admitted with its relation', () => {
    const u = unitsOf([[1, 'We need to hire an office manager.'], [5, 'The office printer was replaced last week.'], [7, 'Correction: we need to hire an office manager and an assistant.']]);
    const r = R.selectRecall(u, 'Did we hire an office manager?', { allUnderChars: 0, k: 1 });
    assert.equal(r.stats.followUpMode, 'v2');
    assert.ok(!pick(r, /printer/));
    assert.ok(r.excerpts.every((e, i, a) => !i || (a[i - 1].ts ?? 0) <= (e.ts ?? 0)), 'date order');
  });

  test('per-root budget: descendants count against their root; hedged ranks last', () => {
    const u = unitsOf([[1, 'The product demo is scheduled for June 3.'], [2, 'Correction: the product demo is June 4, not June 3.'],
      [5, 'The product demo moved to June 10.'], [8, 'The product demo might move again later.']]);
    const r = R.selectRecall(u, 'When is the product demo scheduled?', { allUnderChars: 0, k: 1, followUps: 3 });
    assert.deepEqual(r.excerpts.filter(e => e.why === 'follow-up').map(e => e.relation), ['correction', 'revalue']);
  });

  test('the total budget is the caller\'s followUps', () => {
    const u = unitsOf([[1, 'The product demo is scheduled for June 3.'], [2, 'Correction: the product demo is June 4, not June 3.'], [5, 'The product demo moved to June 10.']]);
    const r = R.selectRecall(u, 'When is the product demo scheduled?', { allUnderChars: 0, k: 1, followUps: 1 });
    assert.equal(r.stats.followUps, 1);
    assert.equal(r.excerpts.find(e => e.why === 'follow-up').relation, 'correction');
  });

  test('a meaning-only seed gets one follow-up and does not chain', () => {
    const u = unitsOf([[1, 'We signed Ostrava Foods as a client.'], [5, 'Ostrava Foods extended their contract.'], [7, 'Correction: Ostrava Foods signed in March, not April.']]);
    const seed = u.find(x => /signed Ostrava/.test(x.text)).key;
    const semantic = new Map(u.map(x => [x.key, x.key === seed ? 0.75 : 0.45]));
    const r = R.selectRecall(u, 'How is our newest partnership going?', { allUnderChars: 0, semantic });
    assert.deepEqual(r.excerpts.filter(e => e.why === 'follow-up').map(e => e.relation), ['correction']);
  });

  test('evidence comes only from what would be quoted: a withheld (sensitive) sentence cannot tie a follow-up', () => {
    const u = unitsOf([[1, 'I go swimming at the Ardley pool.'], [6, 'I was diagnosed with asthma at the Ardley pool clinic, now it changed. Also my bike is fixed.']]);
    const withholdHealth = { isRedacted: s => /asthma/.test(s) };
    const r = R.selectRecall(u, 'Where do I go swimming?', { allUnderChars: 0, k: 1, redaction: withholdHealth, forget: { active: false, isRedacted: () => false } });
    assert.ok(!pick(r, /bike/), JSON.stringify(r.excerpts.map(e => e.text)));
  });

  test('follow-up quotes are never the seed itself, and the seed is kept', () => {
    const u = unitsOf([[1, 'Our accountant is Pellworth.'], [6, 'Pellworth raised the fees now.']]);
    const r = R.selectRecall(u, 'Who is our accountant?', { allUnderChars: 0, k: 1 });
    assert.deepEqual(r.excerpts.map(e => e.why), ['match', 'follow-up']);
  });
});
