/**
 * Information Needs V2 (Sprint 4, 2026-11-11) — the general mechanisms added after
 * the independent ACIB v2 sets showed the Sprint 3 engine did not generalise
 * (eval recall 0.63). Real conversation + fact stores in an isolated data dir;
 * no network, no model, no database. Questions and histories here are written for
 * these tests and are NOT taken from the frozen ACIB v2 evaluation set.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-info-needs-v2-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';

const IN = await import('../contextEngine/informationNeeds.js');
const { getOrCreateConversation, addMessage } = await import('../../memory/conversationStore.js');
const { sensitivePolicy } = await import('../../memory/sensitivity.js');

let n = 0;
function person(messages) {
  const userId = `v2-${++n}`;
  messages.forEach((m, i) => {
    const { id } = getOrCreateConversation(`${userId}-c${i}`, { userId });
    addMessage(id, 'user', m);
    addMessage(id, 'assistant', 'Noted.');
  });
  return userId;
}
const run = (userId, question) => IN.analyseInformationNeeds({ ownerId: `user:${userId}`, userId, conversationId: `${userId}-q`, question, sensitive: sensitivePolicy() });
const text = r => `${r.memoryBlock ?? ''}\n${r.recallBlock ?? ''}`;
const status = (r, id) => r.needs.find(x => x.need.id === id)?.status;
const need = (r, id) => r.needs.find(x => x.need.id === id);

describe('personal by reference (anchoring)', () => {
  test('a question with no "I/my" that names something only the user mentioned is personal', () => {
    const u = person(['The allotment committee meets on the first Sunday of the month.', 'I painted the fence blue.']);
    const r = run(u, 'When does the allotment committee meet?');
    assert.equal(r.applied, true);
    assert.notEqual(r.understanding.intent, 'general');
    assert.match(text(r), /first Sunday/);
    assert.doesNotMatch(text(r), /fence/);
  });
  test('an impersonal question stays impersonal — capitalised words alone do not make it personal', () => {
    const u = person(['I am a pharmacist in Derby and my husband Raj is a nurse.']);
    for (const q of ['How far is Mars from the Sun?', 'What is a pension?', 'Why is the sky blue?']) {
      const r = run(u, q);
      assert.equal(r.understanding.intent, 'general', q);
      assert.equal(text(r).trim(), '', q);
    }
  });
});

describe('the decision model: option, situation, resources, criteria', () => {
  test('the situation in the decision\'s domain is found even with no shared word', () => {
    const u = person(['I earn 39k as a lab technician at Nordwell.', 'Corrin Labs offered me 44k for a senior technician role.', 'My manager at Nordwell is really supportive.', 'I repainted the bathroom.']);
    const r = run(u, 'Should I take the Corrin Labs offer?');
    assert.match(text(r), /39k/);
    assert.match(text(r), /supportive/);
    assert.doesNotMatch(text(r), /bathroom/);
  });
  test('a figure is cost evidence; savings are not taken from the option\'s own price', () => {
    const u = person(['A second-hand camper van is about 17,500.']);
    const r = run(u, 'Should we buy the camper van?');          // the affordability template
    assert.match(text(r), /17,500/);
    assert.equal(status(r, 'cost'), 'found', 'a figure beside the thing is its cost');
    assert.equal(status(r, 'cash'), 'missing', 'the price is not their savings');
    assert.match(r.memoryBlock, /Not known: money available/);
    const v = person(['The pottery course is 450 for ten weeks.']);
    const g = run(v, 'Should I sign up for the pottery course?');   // the general decision model
    assert.equal(need(g, 'money').need.essential, true, 'it costs money');
    assert.equal(status(g, 'money'), 'missing', 'the course fee is not their money');
  });
  test('time is essential for something that needs care; ties when it means moving', () => {
    const a = person(['My daughter keeps asking for a kitten.']);
    assert.equal(need(run(a, 'Should we get a kitten?'), 'time').need.essential, true);
    const b = person(['I was offered a transfer to the Dublin office.']);
    const r = run(b, 'Should I move to Dublin?');
    assert.equal(need(r, 'ties').need.essential, true);
    assert.match(r.memoryBlock, /Not known: what ties them/);
  });
  test('what they want is essential only when nothing but the option is known', () => {
    const thin = person(['There is a part-time law degree that costs 9,000 a year.']);
    assert.equal(need(run(thin, 'Should I do the law degree?'), 'criteria').need.essential, true);
    const rich = person(['There is a part-time law degree that costs 9,000 a year.', 'I have 15,000 saved and I work 30 hours a week.']);
    assert.equal(need(run(rich, 'Should I do the law degree?'), 'criteria').need.essential, false);
  });
  test('the option is essential only when the question points at a specific one', () => {
    const u = person(['I charge 40 an hour for tutoring.']);
    const r = run(u, 'Should I put my rates up?');
    assert.equal(need(r, 'subject').need.essential, false);
    assert.doesNotMatch(r.memoryBlock, /Not known: what is known about the option/);
  });
  test('a pricing decision needs how customers respond, not how many there are', () => {
    const u = person(['Our meal kits cost 12 each and we have about 400 subscribers.']);
    const r = run(u, 'Should we raise our prices?');
    assert.equal(status(r, 'effects'), 'missing');
    assert.match(r.memoryBlock, /Not known: how customers would respond/);
  });
});

describe('change, contradiction and remaining', () => {
  test('a later change that shares only a name is followed ("Sold the Polo…")', () => {
    const u = person(['I drive a VW Polo.', 'Sold the Polo last month, I ride an e-bike now.']);
    const r = run(u, 'What do I drive?');
    assert.match(text(r), /e-bike/);
    assert.match(r.recallBlock, /VW Polo\.\s*↳ since changed/, 'the earlier statement is marked as changed');
  });
  test('"left" meaning remaining is not an ending: two figures conflict', () => {
    const u = person(['I have 14 days of holiday left.', 'The HR portal says I have 11 days of holiday left.']);
    const r = run(u, 'How many days of holiday do I have left?');
    assert.equal(status(r, 'answer'), 'contradictory');
    assert.match(r.memoryBlock, /Conflicting statements/);
  });
  test('ordinal days and weekdays can conflict', () => {
    const a = person(['The recital is on the 4th.', 'The recital is on the 6th.']);
    assert.equal(status(run(a, 'When is the recital?'), 'answer'), 'contradictory');
    const b = person(['The quiz night is on Thursday.', 'The quiz night is on Friday.']);
    assert.equal(status(run(b, 'When is the quiz night?'), 'answer'), 'contradictory');
  });
});

describe('one useful clarifying question', () => {
  test('insufficient → exactly one question, about the most important gap', () => {
    const u = person(['A second-hand camper van is about 17,500.']);
    const r = run(u, 'Should we buy the camper van?');
    assert.equal(r.sufficiency, 'insufficient');
    assert.equal((r.memoryBlock.match(/If you ask, ask only this:/g) ?? []).length, 1);
  });
  test('a conflict is asked about as a choice between the two statements', () => {
    const u = person(['The recital is on the 4th.', 'The recital is on the 6th.']);
    assert.match(run(u, 'When is the recital?').memoryBlock, /ask only this: "Which is right: "The recital is on the 4th\."/);
  });
  test('sufficient → no question', () => {
    const u = person(['My sister Ines lives in Faro.']);
    const r = run(u, 'Where does my sister live?');
    assert.equal(r.sufficiency, 'sufficient');
    assert.doesNotMatch(r.memoryBlock, /ask only this/);
  });
  test('clarifyingQuestion: none unless insufficient', () => {
    assert.equal(IN.clarifyingQuestion([], 'sufficient'), null);
    assert.equal(IN.clarifyingQuestion([], 'partial'), null);
  });
});

describe('safety', () => {
  test('a factual question with no evidence at all falls back to the existing pipeline', () => {
    const u = person(['I like long walks.']);
    const r = run(u, 'What is my locker number at work?');
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'no-evidence');
  });
  test('facts about other people travel as the user\'s own sentence', () => {
    const u = person(['My brother Oskar lives in Malmö and works as a chef.', 'I live in Leeds.']);
    const r = run(u, 'Where does my brother live?');
    assert.match(r.recallBlock, /My brother Oskar lives in Malmö/);
    assert.doesNotMatch(r.memoryBlock, /^- siblings:/m);
  });
});
