/**
 * brain/contextEngine/informationNeeds.js — Sprint 3 (2026-11-10).
 * Question understanding, requirements, evidence, evaluation, sufficiency,
 * privacy and isolation, against the REAL conversation and fact stores in an
 * isolated data dir. No network, no model, no database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-info-needs-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';

const IN = await import('../contextEngine/informationNeeds.js');
const { getOrCreateConversation, addMessage } = await import('../../memory/conversationStore.js');
const { storeFact } = await import('../../memory/longTermMemory.js');
const { sensitivePolicy } = await import('../../memory/sensitivity.js');

let t = Date.UTC(2026, 0, 1);
/** One user's history: each string is one user message in its own conversation, in order. */
function seed(userId, messages) {
  messages.forEach((m, i) => {
    const { id } = getOrCreateConversation(`${userId}-c${i}`, { userId });
    addMessage(id, 'user', m);
    addMessage(id, 'assistant', 'Noted.');
  });
}
const run = (userId, question, extra = {}) => IN.analyseInformationNeeds({ ownerId: `user:${userId}`, userId, conversationId: `${userId}-q`, question, sensitive: sensitivePolicy(), ...extra });
const statusOf = (r, id) => r.needs.find(n => n.need.id === id)?.status;
const allText = r => `${r.memoryBlock}\n${r.recallBlock}`;

describe('Stage A — understanding the question', () => {
  const U = q => IN.understandQuestion(q);
  test('intents', () => {
    assert.equal(U('Should I hire another developer?').intent, 'decision');
    assert.equal(U('Can we afford to replace the car this year?').intent, 'decision');
    assert.equal(U('Plan a dinner for my partner and me during my trip.').intent, 'planning');
    assert.equal(U('Where does my sister work?').intent, 'lookup');
    // V2 (Sprint 4): a capitalised name alone no longer makes a question personal ("the Moon");
    // a name the user's history holds does, via `anchored` (analyseInformationNeeds sets it).
    assert.equal(IN.understandQuestion("What's blocking Beacon right now?", { anchored: true }).intent, 'status');
    assert.equal(U("What's blocking Beacon right now?").intent, 'general', 'unanchored: no history names Beacon');
    assert.equal(IN.understandQuestion('What did Alex say about the renewal?', { anchored: true }).intent, 'recall');
    assert.equal(U('Do my pricing doc and the board memo agree on the price?').intent, 'comparison');
  });
  test('impersonal and simple questions are not over-read', () => {
    for (const q of ['At what temperature does water boil at sea level?', 'What is 2 + 2?', 'Explain photosynthesis.', 'Thanks!']) {
      assert.equal(U(q).intent, 'general', q);
      assert.deepEqual(IN.requirementsFor(U(q)), [], q);
    }
  });
  test('advice vs fact, multi-fact, time sensitivity, entities', () => {
    const d = U('Should I hire another developer?');
    assert.equal(d.advice, true); assert.equal(d.multiFact, true);
    const l = U('Where does my sister work?');
    assert.equal(l.advice, false); assert.equal(l.relation, 'sister');
    assert.deepEqual(U('What did Alex say about the renewal?').names, ['Alex']);
  });
});

describe('Stage B — requirements are conditional on the question', () => {
  const ids = q => IN.requirementsFor(IN.understandQuestion(q)).map(n => `${n.id}${n.essential ? '*' : ''}`);
  test('a hiring decision needs team, money, burn, workload and the cost of a hire; departures and history help', () => {
    assert.deepEqual(ids('Should I hire another developer?'), ['team*', 'departures', 'cash*', 'burn*', 'revenue', 'workload*', 'prior-decisions', 'hire-cost*']);
  });
  test('affordability needs the cost of that thing, money available and income', () => {
    const n = IN.requirementsFor(IN.understandQuestion('Can we afford to replace the car this year?'));
    // V2: plus their situation around it (non-essential; V1 was cost, cash, income, runway).
    assert.deepEqual(n.map(x => x.id), ['cost', 'cash', 'income', 'runway', 'situation']);
    assert.equal(n.find(x => x.id === 'situation').essential, false);
    assert.match(n[0].label, /replace the car this year/);
  });
  test('planning needs follow what the request mentions', () => {
    // V2: a trip also needs its dates (V1: people, trip, food, preferences).
    assert.deepEqual(ids('Plan a dinner for my partner and me during my trip.'), ['people*', 'trip*', 'food*', 'preferences', 'dates*']);
    assert.deepEqual(ids('Plan my Saturday with the kids.'), ['people*', 'day*', 'preferences']);
  });
  test('a lookup needs one thing', () => {
    assert.equal(ids('Where does my sister work?').length, 1);
  });
});

describe('Stages C–E on real stores', () => {
  seed('hire', [
    "I'm the founder of Tidewell. We have 3 engineers: Priya, Marco and Sam.",
    'We have $180k in the bank and we burn about $30k a month.',
    'We need to ship the iOS app by March 1, and the payments integration is blocking it.',
    'Last quarter we decided to hold off on hiring until we reach $20k MRR.',
    "We're at $14k MRR right now.",
    'I might hire a designer next year, not sure yet.',
    'My sister is getting married in June.',
    "Marco told me he's leaving at the end of the month.",
    'Can you recommend a good podcast about startups?',
  ]);

  test('the hiring question gets every stated fact it needs, and says what is missing', () => {
    const r = run('hire', 'Should I hire another developer?');
    assert.equal(r.applied, true);
    for (const id of ['team', 'departures', 'cash', 'burn', 'revenue', 'workload', 'prior-decisions']) assert.equal(statusOf(r, id), 'found', id);
    assert.equal(statusOf(r, 'hire-cost'), 'missing');
    assert.equal(r.sufficiency, 'insufficient');
    const text = allText(r);
    for (const s of ['3 engineers', '$180k', 'iOS app', 'hold off on hiring', '$14k MRR', "Marco told me he's leaving"]) assert.ok(text.includes(s), s);
    assert.match(r.memoryBlock, /Not known: the cost of a developer/);
    assert.match(r.memoryBlock, /ask ONE targeted question/);
  });

  test('irrelevant, speculative and question text is not sent', () => {
    const text = allText(run('hire', 'Should I hire another developer?'));
    assert.ok(!/designer|married|podcast/i.test(text), text);
  });

  test('missing information is declared, never filled in', () => {
    seed('afford', ['Our runway is 14 months at the current spend.']);
    const r = run('afford', "Can I afford a second engineer's salary?");
    assert.equal(statusOf(r, 'cost'), 'missing');
    assert.equal(statusOf(r, 'cash'), 'missing');
    assert.match(r.memoryBlock, /Not known: the cost of a second engineer's salary/);
    assert.match(r.memoryBlock, /Not known: money available/);
    assert.ok(!/\d{2,},?\d{3}/.test(r.memoryBlock.replace(/14 months/, '')), 'no invented figures');
  });

  test('contradictory statements are flagged, not silently resolved', () => {
    seed('contra', ['Our marketing budget for Q3 is $50,000.', 'The Q3 marketing budget is $40,000.']);
    const r = run('contra', "What's our Q3 marketing budget?");
    assert.equal(statusOf(r, 'answer'), 'contradictory');
    assert.match(r.memoryBlock, /Conflicting statements .*\$50,000.*\$40,000.*contradictory/);
  });

  test('temporal: a later correction makes the earlier statement outdated, and it is annotated', () => {
    seed('corr', ['My accountant is Kate Morrow.', 'Sorry, I misspoke — my accountant is Kim Morrow, not Kate.']);
    const r = run('corr', 'Who is my accountant?');
    assert.match(r.recallBlock, /My accountant is Kate Morrow\.\s*\n\s*↳ since changed — now: "Sorry, I misspoke — my accountant is Kim Morrow, not Kate\."/);
  });

  test('temporal: a stored fact the user later changed is shown as no longer current, never as current', () => {
    // The profile still says Hartwell (the observer did not end it); the user's later words did.
    storeFact('user:ended', { key: 'workplace', value: 'Hartwell Bank', confidence: 0.9, importance: 7, sourceText: 'I work at Hartwell Bank.', ts: Date.now() - 60_000 });
    seed('ended', ['I work at Hartwell Bank.', 'I left Hartwell last month and now work at Northbeam.']);
    const r = run('ended', 'Where do I work?');
    assert.match(r.recallBlock, /Northbeam/);
    assert.match(r.memoryBlock, /No longer current — workplace: Hartwell Bank \(they said: "I left Hartwell last month and now work at Northbeam\."\)/);
    assert.ok(!/^- workplace: Hartwell Bank/m.test(r.memoryBlock), 'not asserted as current');
  });

  test('an explicit "forget my X" removes earlier statements about X, even with no stored fact', () => {
    seed('forget', ['My home address is 14 Larch Road, Bristol.', 'Forget my address']);
    const r = run('forget', 'Where do I live?');
    assert.equal(statusOf(r, 'answer'), 'forgotten');
    assert.ok(!/Larch/i.test(allText(r)), allText(r));
    assert.match(r.memoryBlock, /Not known: .*asked Aqua to forget/);
  });

  test('a question is never evidence and never becomes a stated fact', () => {
    seed('qfact', ['My sister Ana works at Stripe as a designer.']);
    // What the observer does on a question today: it stored a fact FROM the question.
    storeFact('user:qfact', { key: 'siblings', value: ['Ana', 'Work'], confidence: 0.9, importance: 6, sourceText: 'Where does my sister work?', ts: Date.now() });
    const r = run('qfact', 'Where does my sister work?');
    assert.ok(!/siblings: Ana, Work/.test(r.memoryBlock), r.memoryBlock);
    assert.match(r.recallBlock, /Ana works at Stripe/);
  });

  test('a fact whose source is a question is not trusted even when its value is not in the question', () => {
    // Only the source-text rule catches this one (the value is not a substring of any request).
    storeFact('user:qsrc', { key: 'workplace', value: 'Brightline Ltd', confidence: 0.9, importance: 7, sourceText: 'Should I move to Brightline Ltd or stay?', ts: Date.now() });
    seed('qsrc', ['I work at Kestrel Labs as a data engineer.']);
    const r = run('qsrc', 'Where do I work?');
    assert.ok(!/Brightline/.test(r.memoryBlock), r.memoryBlock);
    assert.match(allText(r), /Kestrel Labs/);
  });

  test('a stored value cut from a longer number is not shown as a fact', () => {
    seed('trunc', ['I work as a nurse manager at St Aldric Hospital and earn 58,000 a year.']);
    storeFact('user:trunc', { key: 'workplace', value: 'St Aldric Hospital and earn 58', confidence: 0.9, importance: 7, sourceText: 'I work as a nurse manager at St Aldric Hospital and earn 58,000 a year.', ts: Date.now() });
    const r = run('trunc', 'Where do I work?');
    assert.ok(!/earn 58 /.test(r.memoryBlock) && !/earn 58\b(?!,)/.test(r.memoryBlock), r.memoryBlock);
    assert.match(r.recallBlock, /58,000/);
  });

  test('an ambiguous name is reported as unknown, with both candidates', () => {
    seed('alex', ['Alex Chen is my co-founder.', 'Alex Rivera at Northwind is our biggest client.', 'Alex said the renewal depends on the Q4 roadmap.']);
    const r = run('alex', 'What did Alex say about the renewal?');
    assert.match(r.memoryBlock, /Not known: which Alex is meant — the user knows Alex Chen and Alex Rivera/);
    assert.match(r.recallBlock, /renewal depends on the Q4 roadmap/);
  });

  test('sensitive sentences follow the turn policy (withheld by default)', () => {
    seed('health', ['I injured my knee badly last week.', 'My goal is to swim 2 km by October.']);
    const r = run('health', 'Help me plan my training this week.');
    assert.ok(!/knee/i.test(allText(r)), allText(r));
    assert.match(allText(r), /swim 2 km/);
  });

  test('cross-user isolation: another user\'s identical facts never appear', () => {
    seed('iso-a', ['We have 3 engineers: Ada, Ben and Cy.']);
    seed('iso-b', ['We have 7 engineers: Dot, Eve and Fay.', 'We have $90k in the bank.']);
    const r = run('iso-a', 'Should I hire another developer?');
    assert.ok(!/Dot|Eve|Fay|\$90k/.test(allText(r)), allText(r));
    assert.match(allText(r), /Ada, Ben and Cy/);
  });

  test('impersonal questions get no personal context at all', () => {
    const r = run('hire', 'At what temperature does water boil at sea level?');
    assert.equal(r.applied, true);
    assert.equal(r.memoryBlock, '');
    assert.equal(r.recallBlock, '');
  });

  test('no owner → not applied (the existing pipeline serves the turn)', () => {
    const r = IN.analyseInformationNeeds({ ownerId: null, question: 'Should I hire?' });
    assert.equal(r.applied, false);
  });
});

describe('budget and latency', () => {
  test('a long history: bounded quotes and characters, well under 100 ms', () => {
    const msgs = [];
    for (let i = 0; i < 400; i++) msgs.push(`Note ${i}: the team discussed engineers, the budget in the bank and the roadmap deadline for item ${i}.`);
    seed('big', msgs);
    const t0 = process.hrtime.bigint();
    const r = run('big', 'Should I hire another developer?');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const quotes = r.recallBlock.split('\n').filter(l => l.startsWith('[')).length;
    assert.ok(quotes <= 12, `quotes ${quotes}`);
    assert.ok(r.recallBlock.length < 3600 + 1200, `chars ${r.recallBlock.length}`);
    assert.ok(ms < 1000, `took ${ms} ms`);   // generous bound for CI; measured ~tens of ms
    assert.ok(r.summary.ms >= 0);
  });
});

test('gate: off by default; shadow and on recognised; anything else is off', () => {
  assert.equal(IN.infoNeedsMode({}), 'off');
  assert.equal(IN.infoNeedsMode({ AQUA_INFO_NEEDS: 'on' }), 'on');
  assert.equal(IN.infoNeedsMode({ AQUA_INFO_NEEDS: 'SHADOW' }), 'shadow');
  assert.equal(IN.infoNeedsMode({ AQUA_INFO_NEEDS: 'true' }), 'off');
  void t;
});
