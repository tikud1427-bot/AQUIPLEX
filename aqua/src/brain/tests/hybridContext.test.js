/**
 * brain/contextEngine/hybridContext.js — Sprint 6 (2026-11-11).
 * The hybrid adds after the existing context (A) and never removes from it.
 * Real conversation/fact stores in an isolated data dir; A's context is given as
 * the strings the route would hold. No network, no model.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-hybrid-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';

const IN = await import('../contextEngine/informationNeeds.js');
const H = await import('../contextEngine/hybridContext.js');
const { getOrCreateConversation, addMessage } = await import('../../memory/conversationStore.js');
const { sensitivePolicy } = await import('../../memory/sensitivity.js');

let n = 0;
let clock = Date.UTC(2026, 0, 1);
const realNow = Date.now;
Date.now = () => (clock += 60_000);
process.on('exit', () => { Date.now = realNow; });

function person(messages) {
  const userId = `hy-${++n}`;
  messages.forEach((m, i) => {
    const { id } = getOrCreateConversation(`${userId}-c${i}`, { userId });
    addMessage(id, 'user', m);
    addMessage(id, 'assistant', 'Noted.');
  });
  return userId;
}
const v2 = (u, question, extra = {}) => IN.analyseInformationNeeds({ ownerId: `user:${u}`, userId: u, conversationId: `${u}-q`, question, sensitive: sensitivePolicy(), ...extra });
/** A's recall block as the route renders quotes: "[date · another conversation] text". */
const recallOf = lines => lines.length ? `WHAT THE USER TOLD YOU BEFORE (…):\n${lines.map(l => `[2026-01-01 · another conversation] ${l}`).join('\n')}` : '';
const hybrid = (u, q, a = {}, opts = {}) => H.hybridContribution({ v2: v2(u, q), aContext: a, maxTokens: 400, maxMs: 1000, ...opts });

describe('never discards and never duplicates the existing context', () => {
  test('strong evidence A lacks is added once; evidence A already shows is not repeated', () => {
    const u = person(['I earn 39k as a lab technician at Nordwell.', 'Corrin Labs offered me 44k for a senior technician role.', 'My manager at Nordwell is really supportive.']);
    const q = 'Should I take the Corrin Labs offer?';
    const lacking = hybrid(u, q, { recallBlock: recallOf(['Corrin Labs offered me 44k for a senior technician role.']) });
    assert.match(lacking.block, /39k/);
    assert.doesNotMatch(lacking.block, /Corrin Labs offered me 44k/, 'already shown above: not repeated');
    assert.ok(lacking.summary.dup >= 1);
    const full = hybrid(u, q, { recallBlock: recallOf(['I earn 39k as a lab technician at Nordwell.', 'Corrin Labs offered me 44k for a senior technician role.', 'My manager at Nordwell is really supportive.']) });
    assert.doesNotMatch(full.block, /39k|44k|supportive/, 'everything relevant is already in A: nothing re-added');
  });

  test('the block is ADDED: hybridContribution never returns A, and its block never contains A\'s headers', () => {
    const u = person(['I live in Bristol.']);
    const a = { memoryBlock: '--- USER PROFILE & MEMORY ---\n- city: Bristol\n--- END PROFILE ---', recallBlock: recallOf(['I live in Bristol.']) };
    const r = hybrid(u, 'Where do I live?', a);
    assert.doesNotMatch(r.block, /USER PROFILE|WHAT THE USER TOLD YOU/);
  });

  test('weak matches are not added (one generic term is not enough)', () => {
    const u = person(['I have a lot of work this week.', 'Corrin Labs offered me 44k for a senior technician role.']);
    const r = hybrid(u, 'Should I take the Corrin Labs offer?', {});
    assert.doesNotMatch(r.block, /a lot of work this week/);
  });
});

describe('not retrieved vs unknown', () => {
  test('an essential need found nowhere is declared unknown, with one clarifying question', () => {
    const u = person(['A second-hand camper van is about 17,500.']);
    const r = hybrid(u, 'Should we buy the camper van?', { recallBlock: recallOf(['A second-hand camper van is about 17,500.']) });
    assert.match(r.block, /Not known: money available/);
    assert.equal((r.block.match(/ask only this/g) ?? []).length, 1);
    assert.ok(r.summary.unknownsDeclared >= 1);
  });

  test('an essential need V2 missed but A\'s context holds is NOT declared unknown — it is "not matched"', () => {
    const u = person(['A second-hand camper van is about 17,500.']);
    // A's profile lane already shows savings (in words V2's history did not see).
    const a = { memoryBlock: '--- USER PROFILE & MEMORY ---\n- savings: 12,000 in the bank\n--- END PROFILE ---', recallBlock: recallOf(['A second-hand camper van is about 17,500.']) };
    const r = hybrid(u, 'Should we buy the camper van?', a);
    assert.doesNotMatch(r.block, /Not known: money available/);
    assert.match(r.block, /Not matched by the needs check: money available/);
    assert.ok(r.summary.notMatched >= 1);
  });

  test('when V2 retrieves nothing at all, the hybrid adds nothing and counts it as not retrieved', () => {
    const u = person(['I like long walks.']);
    const r = hybrid(u, 'What is my locker number at work?', { recallBlock: recallOf(['I like long walks.']) });
    assert.equal(r.block, '');
    assert.equal(r.summary.reason, 'no-evidence');
    assert.ok(r.summary.notRetrieved >= 1);
    assert.doesNotMatch(JSON.stringify(r), /Not known/);
  });
});

describe('conflict, change, ambiguity', () => {
  test('a contradiction is noted with both statements and one question; A keeps both lines', () => {
    const u = person(['The recital is on the 4th.', 'The recital is on the 6th.']);
    const r = hybrid(u, 'When is the recital?', { recallBlock: recallOf(['The recital is on the 4th.', 'The recital is on the 6th.']) });
    assert.match(r.block, /Conflict .*"The recital is on the 4th\."[^\n]*"The recital is on the 6th\."/);
    assert.match(r.block, /ask only this: "Which is right/);
  });

  test('a change is noted even when A shows only the old statement', () => {
    const u = person(['I drive a VW Polo.', 'Sold the Polo last month, I ride an e-bike now.']);
    const r = hybrid(u, 'What do I drive?', { recallBlock: recallOf(['I drive a VW Polo.']) });
    assert.match(r.block, /Since changed: "I drive a VW Polo\."/);
    assert.match(r.block, /e-bike/);
  });

  test('an ambiguous name is noted and asked about', () => {
    const u = person(['Sam Okoro is my accountant.', 'Sam Lindqvist is my climbing partner.', 'Sam said the tax return is nearly done.']);
    const r = hybrid(u, 'What did Sam say about the tax return?', {});
    assert.match(r.block, /Not known: which Sam is meant \(ambiguous\)/);
    assert.match(r.block, /ask only this: "Which Sam do you mean/);
  });
});

describe('unrelated, impersonal, budgets, failures', () => {
  test('an impersonal question adds nothing', () => {
    const u = person(['I am a pharmacist in Derby and my husband Raj is a nurse.']);
    const r = hybrid(u, 'How far is Mars from the Sun?', { recallBlock: recallOf(['I am a pharmacist in Derby and my husband Raj is a nurse.']) });
    assert.equal(r.block, '');
    assert.equal(r.summary.reason, 'general');
  });

  test('unrelated facts are not added to a decision', () => {
    const u = person(['I earn 39k as a lab technician at Nordwell.', 'Corrin Labs offered me 44k.', 'I painted the fence blue.', 'My cousin loves sailing.']);
    const r = hybrid(u, 'Should I take the Corrin Labs offer?', {});
    assert.doesNotMatch(r.block, /fence|sailing/);
  });

  test('a family member\'s situation is not the user\'s ("My brother Teo is training to be a pilot")', () => {
    const u = person(['The camper van costs 17,500.', 'My brother Teo is training to be a pilot.', 'My manager at Nordwell says I am due a 3,000 bonus.']);
    const r = hybrid(u, 'Should we buy the camper van?', {});
    assert.doesNotMatch(r.block, /Teo|pilot/);
  });

  test('the token budget is never exceeded; notes outrank evidence when trimming', () => {
    const u = person(['The recital is on the 4th.', 'The recital is on the 6th.', 'The recital venue is St Mary\'s hall.', 'The recital starts at 6pm.']);
    const tight = H.hybridContribution({ v2: v2(u, 'When is the recital?'), aContext: {}, maxTokens: 90, maxMs: 1000 });
    if (tight.block) {
      assert.ok(tight.summary.tokens <= 90, `tokens ${tight.summary.tokens}`);
      assert.match(tight.block, /Conflict/, 'the conflict survives trimming');
    } else assert.equal(tight.summary.reason, 'over-budget');
  });

  test('a result over the time budget is discarded', () => {
    const u = person(['I live in Bristol.']);
    const a = v2(u, 'Where do I live?');
    const r = H.hybridContribution({ v2: { ...a, summary: { ...a.summary, ms: 999 } }, aContext: {}, maxTokens: 400, maxMs: 50 });
    assert.equal(r.block, ''); assert.equal(r.summary.reason, 'over-time');
  });

  test('no analysis (engine error upstream) → nothing added', () => {
    assert.equal(H.hybridContribution({ v2: null, aContext: { recallBlock: 'x' } }).block, '');
  });

  test('the work budget: a long history is capped, and an expired deadline aborts with BudgetExceeded', () => {
    const msgs = Array.from({ length: 400 }, (_, i) => `Note ${i}: I tidied shelf ${i}.`);
    const u = person([...msgs, 'A second-hand camper van is about 17,500.']);
    const capped = v2(u, 'Should we buy the camper van?', { budget: { maxSentences: 50 } });
    assert.ok(capped.applied);
    assert.throws(() => v2(u, 'Should we buy the camper van?', { budget: { deadlineMs: -1 } }), e => e.name === 'BudgetExceeded');
  });

  test('settings: defaults and bounds', () => {
    assert.deepEqual(H.hybridSettings({}), { maxTokens: 400, maxMs: 50, maxSentences: 4000 });
    assert.deepEqual(H.hybridSettings({ AQUA_HYBRID_MAX_TOKENS: '9', AQUA_HYBRID_MAX_MS: 'x', AQUA_HYBRID_MAX_SENTENCES: '200' }), { maxTokens: 400, maxMs: 50, maxSentences: 200 });
    assert.equal(H.hybridContextMode({}), 'off');
    assert.equal(H.hybridContextMode({ AQUA_HYBRID_CONTEXT: 'ON' }), 'on');
    assert.equal(H.hybridContextMode({ AQUA_HYBRID_CONTEXT: 'yes' }), 'off');
  });

  test('the summary line is content-free', () => {
    const u = person(['A second-hand camper van is about 17,500.']);
    const line = H.hybridSummaryLine('on', hybrid(u, 'Should we buy the camper van?', {}).summary);
    assert.doesNotMatch(line, /camper|17,500/);
    assert.match(line, /^mode=on reason=\S+ added=\d+ dup=\d+ weak=\d+ conflicts=\d+ changes=\d+ ended=\d+ ambiguous=\d+ unknowns=\d+ not_matched=\d+ not_retrieved=\d+ question=[01] tokens=\d+ trimmed=\d+$/);
  });

  test('contentLines ignores headers and instruction prose (boilerplate is not evidence)', () => {
    const lines = H.contentLines({ memoryBlock: '--- USER PROFILE & MEMORY ---\nGuidelines:\n- Use this memory naturally to personalize responses.\n- city: Bristol\n--- END PROFILE ---' });
    assert.ok(lines.includes('city: Bristol'));
    assert.ok(!lines.some(l => /^---/.test(l)));
  });
});
