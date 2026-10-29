/**
 * Episodic recall (2026-10-20): what the user said in another conversation
 * reaches the answer verbatim — owner-scoped, dated, deletion-proof.
 *
 * The end-to-end tests drive the real prepareTurn (what /chat and /chat/stream
 * hand the model) and assert on `prep.systemPrompt`. Each negative has a
 * positive control first, so none passes because recall found nothing.
 * No database: the World Model's notes are unit-tested through annotate().
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR             = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-recall-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI                 = '';
delete process.env.DATABASE_URL;
delete process.env.AQUA_EPISODIC_RECALL;
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}

const R = await import('../episodicRecall.js');
const RR = await import('../recallRedactions.js');
const store = await import('../conversationStore.js');
const { prepareTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const { forgetInBackground } = await import('../forget.js');

const DAY = 86_400_000;
/** The ranked path; short test histories would otherwise be quoted whole (adaptive mode). */
const RANKED = { allUnderChars: 0 };
const T0 = Date.UTC(2026, 8, 1);

/** A conversations Map shaped like conversationStore's, for the pure tests. */
function convs(spec) {
  const m = new Map();
  for (const [id, { userId = 'u1', title = id, msgs }] of Object.entries(spec)) {
    m.set(id, { meta: { userId, title }, messages: msgs.map(([role, content, day], i) => ({ role, content, ts: T0 + day * DAY + i })) });
  }
  return m;
}

describe('ranking and selection (pure)', () => {
  beforeEach(() => R.__clearCacheForTests());

  test('stem folds inflections onto one term', () => {
    assert.deepEqual(['launching', 'launched', 'launches', 'launch'].map(R.stem), ['launch', 'launch', 'launch', 'launch']);
    assert.equal(R.stem('class'), 'class');
  });

  test('finds the statement from another conversation, newest change included, chronological', () => {
    const c = convs({
      a: { msgs: [['user', 'Splitpay is supposed to launch on November 18.', 0], ['assistant', 'Noted.', 0]] },
      b: { msgs: [['user', "Because of that, Splitpay's launch moved to December 9.", 7]] },
      c: { msgs: [['user', 'Actually, correction: the launch is December 16, not December 9.', 14], ['user', 'I love hiking on weekends.', 14]] },
    });
    const units = R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: c });
    const { excerpts } = R.selectRecall(units, 'When is Splitpay launching?', RANKED);
    const texts = excerpts.map(e => e.text);
    assert.ok(texts.some(t => /December 16/.test(t)), 'the newest change is quoted');
    assert.ok(!texts.some(t => /hiking/.test(t)), 'unrelated sentence stays out');
    const ts = excerpts.map(e => e.ts);
    assert.deepEqual(ts, [...ts].sort((x, y) => x - y), 'oldest first');
  });

  test('follow-up: a later change sharing the subject but not the question\'s words is admitted', () => {
    const c = convs({
      a: { msgs: [['user', 'Our Atlas beta starts March 3.', 0]] },
      b: { msgs: [['user', 'Atlas slipped, now April 10.', 5]] },
      x: { msgs: [['user', 'My dentist appointment is Friday.', 6], ['user', 'Coffee with Sam tomorrow.', 6]] },
    });
    const units = R.collectUnits({ userId: 'u1', conversations: c });
    const { excerpts, stats } = R.selectRecall(units, 'When does the beta start?', RANKED);
    assert.ok(excerpts.some(e => /April 10/.test(e.text)), JSON.stringify(excerpts.map(e => e.text)));
    assert.equal(stats.followUps, 1);
    assert.equal(excerpts.find(e => /April 10/.test(e.text)).why, 'follow-up');
  });

  test('owner-scoped: another user\'s conversations are never read', () => {
    const c = convs({
      mine: { userId: 'u1', msgs: [['user', 'My budget for Atlas is 40k.', 0]] },
      theirs: { userId: 'u2', msgs: [['user', 'My budget for Atlas is 90k.', 0]] },
    });
    const { excerpts } = R.selectRecall(R.collectUnits({ userId: 'u1', conversations: c }), 'What is my Atlas budget?', RANKED);
    assert.deepEqual(excerpts.map(e => e.text), ['My budget for Atlas is 40k.']);
    const conv = R.collectUnits({ userId: null, conversationId: 'theirs', conversations: c });
    assert.ok(conv.every(u => u.conversationId === 'theirs'), 'a conversation-scoped owner reads only its own conversation');
  });

  test('assistant text is never quoted; a short reply carries its question as labelled context', () => {
    const c = convs({ a: { msgs: [
      ['assistant', 'When is the Atlas launch now — still May 2?', 0],
      ['user', 'yes, May 2', 0],
      ['assistant', 'The Atlas launch is definitely June 30.', 0],
    ] } });
    const units = R.collectUnits({ userId: 'u1', conversations: c });
    assert.equal(units.length, 1);
    assert.equal(units[0].text, 'yes, May 2');
    assert.match(units[0].replyTo, /still May 2/);
    assert.ok(!units.some(u => /June 30/.test(u.text)));
  });

  test('messages already in the current window are not repeated', () => {
    const c = convs({ now: { msgs: [['user', 'Atlas launch is May 2.', 0], ['assistant', 'ok', 0], ['user', 'Atlas launch moved to May 9.', 1]] } });
    const units = R.collectUnits({ userId: 'u1', conversationId: 'now', excludeFromIndex: 2, conversations: c });
    assert.deepEqual(units.map(u => u.text), ['Atlas launch is May 2.']);
  });

  test('nothing relevant → nothing quoted', () => {
    const c = convs({ a: { msgs: [['user', 'I prefer short numbered lists.', 0], ['user', 'Splitpay launches in December.', 1]] } });
    const { excerpts } = R.selectRecall(R.collectUnits({ userId: 'u1', conversations: c }), 'What is my blood type?', RANKED);
    assert.deepEqual(excerpts, []);
  });

  test('bounded: k and the character budget hold on a long history', () => {
    const msgs = Array.from({ length: 400 }, (_, i) => ['user', `Atlas note ${i}: the Atlas integration needs work on module ${i}.`, i]);
    const { excerpts } = R.selectRecall(R.collectUnits({ userId: 'u1', conversations: convs({ a: { msgs } }) }), 'Atlas integration status', { k: 8, maxChars: 1200 });
    assert.ok(excerpts.length <= 8);
    assert.ok(excerpts.reduce((n, e) => n + e.text.length, 0) <= 1200);
  });

  test('adaptive: a history that fits the budget is quoted whole, in order, still redacted', () => {
    RR.__resetForTests();
    RR.redactPhrases('user:u1', ['shellfish']);
    const c = convs({
      a: { msgs: [['user', 'I am allergic to shellfish.', 0], ['user', 'I prefer short numbered lists.', 0]] },
      b: { msgs: [['user', 'Splitpay launches in December.', 3]] },
    });
    const { excerpts, stats } = R.selectRecall(R.collectUnits({ userId: 'u1', conversations: c }), 'What is my blood type?', { redaction: RR.redactionsFor('user:u1') });
    assert.equal(stats.mode, 'all');
    assert.deepEqual(excerpts.map(e => e.text), ['I prefer short numbered lists.', 'Splitpay launches in December.']);
    assert.match(R.formatRecall(excerpts), /everything they said in earlier conversations/);
    RR.__resetForTests();
    const big = convs({ a: { msgs: Array.from({ length: 300 }, (_, i) => ['user', `Note ${i} about the quarterly roadmap and hiring plans for the team.`, i]) } });
    assert.equal(R.selectRecall(R.collectUnits({ userId: 'u1', conversations: big }), 'roadmap').stats.mode, 'ranked');
  });

  test('annotate: a quote of a superseded claim carries the current statement', () => {
    const ex = [{ text: 'Pricing is $29 per seat for now.', ts: T0, conversationId: 'a' }];
    const out = R.annotate(ex, [{ quotes: ['Pricing is $29 per seat'], now: 'the price is now $39' }]);
    assert.deepEqual(out[0].changes, ['the price is now $39']);
    const block = R.formatRecall(out);
    assert.match(block, /since changed — now: "the price is now \$39"/);
    assert.match(block, /^\[2026-09-01 · "another conversation"\]|\[2026-09-01 · another conversation\]/m);
  });
});

describe('redaction', () => {
  beforeEach(() => RR.__resetForTests());

  test('a forgotten phrase removes only the sentences that state it', () => {
    RR.redactPhrases('user:r1', ['Lisbon']);
    const c = convs({ a: { userId: 'r1', msgs: [['user', 'I live in Lisbon. I work at Nummo as head of product.', 0]] } });
    const { excerpts, stats } = R.selectRecall(R.collectUnits({ userId: 'r1', conversations: c }), 'Where do I live and work?', { ...RANKED, redaction: RR.redactionsFor('user:r1') });
    assert.equal(excerpts.length, 1);
    assert.doesNotMatch(excerpts[0].text, /Lisbon/);
    assert.match(excerpts[0].text, /Nummo/);
    assert.equal(stats.redactedSentences, 1);
  });

  test('whole words only, case-insensitive; too-common words are not redactable', () => {
    RR.redactPhrases('user:r2', ['Ana', 'and', '29']);
    const m = RR.redactionsFor('user:r2');
    assert.equal(m.isRedacted('my mentee ANA got promoted'), true);
    assert.equal(m.isRedacted('Banana bread and tea'), false);
    assert.equal(m.isRedacted('pricing is $29'), true, 'a short number is specific');
  });

  test('forget-all hides everything said before it, nothing after', () => {
    RR.redactAllBefore('user:r3', T0 + 5 * DAY);
    const m = RR.redactionsFor('user:r3');
    assert.equal(m.isRedacted('Atlas launches May 2', T0), true);
    assert.equal(m.isRedacted('Atlas launches May 9', T0 + 6 * DAY), false);
  });

  test('the store keeps hashes, never the forgotten words; purge removes the owner', () => {
    RR.redactPhrases('user:r4', ['Kuala Lumpur']);
    const file = path.join(process.env.AQUA_DATA_DIR, '.aqua-recall-redactions.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(raw.toLowerCase(), /kuala|lumpur/);
    assert.ok(RR.purgeOwner('user:r4') >= 1);
    assert.equal(RR.redactionsFor('user:r4').active, false);
  });
});

describe('uploaded files from other conversations', () => {
  beforeEach(() => { R.__clearCacheForTests(); RR.__resetForTests(); });
  const doc = (name, content, day = 0) => ({ id: name, name, content, uploadedAt: T0 + day * DAY });

  test('a file from another conversation is quoted, labelled as a file; this conversation\'s and other users\' files are not', async () => {
    const c = convs({
      old: { msgs: [['user', 'Here is my dissertation brief.', 0]] },
      now: { msgs: [['user', 'hi', 9]] },
      theirs: { userId: 'u2', msgs: [['user', 'my brief', 0]] },
    });
    const files = {
      old: [doc('brief.txt', 'Dissertation brief\nWord limit: 15,000 words.\nTopic: NEWS2 early warning scores for sepsis.', 0)],
      now: [doc('current.txt', 'Word limit: 9,999 words.', 9)],
      theirs: [doc('other.txt', 'Word limit: 1,234 words.', 0)],
    };
    const r = await R.recallForTurn({ ownerId: 'user:u1', userId: 'u1', conversationId: 'now', query: "What's my dissertation word limit?",
      conversations: c, attachmentsFor: id => files[id] ?? [] });
    assert.match(r.block, /file "brief\.txt" they uploaded\] .*Word limit: 15,000 words/);
    assert.doesNotMatch(r.block, /9,999|1,234/);
    assert.match(r.block, /lines from files they uploaded/);
    assert.equal(r.stats.files.selected >= 1, true);
  });

  test('a forgotten value is redacted from file lines too', async () => {
    RR.redactPhrases('user:u1', ['Brightline Agency']);
    const c = convs({ a: { msgs: [['user', 'plan attached', 0]] } });
    const r = await R.recallForTurn({ ownerId: 'user:u1', userId: 'u1', conversationId: 'x', query: 'Who runs the launch campaign?',
      conversations: c, attachmentsFor: () => [doc('plan.md', 'Launch plan\nMarketing partner: Brightline Agency handles the launch campaign.\nSupport: Lena Park.')] });
    assert.doesNotMatch(r.block, /Brightline/);
  });

  test('a long file is ranked, not quoted whole, and cannot crowd out the user\'s own words', async () => {
    const big = Array.from({ length: 400 }, (_, i) => `Clause ${i}: the supplier shall deliver item ${i} on schedule.`).join('\n') + '\nClause 999: billing is capped at 12 days per month.';
    const c = convs({ a: { msgs: [['user', 'I bill Mellow at a day rate.', 0]] } });
    const r = await R.recallForTurn({ ownerId: 'user:u1', userId: 'u1', conversationId: 'x', query: 'How many days a month can I bill Mellow at most?',
      conversations: c, attachmentsFor: () => [doc('mellow-contract.txt', big)] });
    assert.equal(r.stats.files.mode, 'ranked');
    assert.match(r.block, /capped at 12 days per month/);
    assert.match(r.block, /I bill Mellow at a day rate\./);
    assert.ok(r.block.length < 8000, `bounded: ${r.block.length}`);
  });
});

describe('end to end through prepareTurn', () => {
  let n = 0;
  function told(userId, sentences, { daysAgo = 3 } = {}) {
    const id = `told-${userId}-${n++}`;
    store.getOrCreateConversation(id, { userId });
    for (const s of sentences) { store.addMessage(id, 'user', s); store.addMessage(id, 'assistant', 'Got it.'); }
    const conv = store.getAllConversations().get(id);
    conv.messages.forEach(m => { m.ts -= daysAgo * DAY; });
    return id;
  }
  async function ask(userId, question, { rememberSensitive = false } = {}) {
    const conv = `ask-${userId}-${n++}`;
    store.getOrCreateConversation(conv, { userId });
    return prepareTurn({ userMessage: question, workspaceId: null, conversationId: conv, userId,
      ctx: createContext({ conversationId: conv, requestId: conv }), requestId: conv, skipReasoningPass: true, rememberSensitive });
  }

  test('a health or mood sentence is not quoted by default; the rest of the message is', async () => {
    told('s1', ['My right eye is moving automatically. The Tidepool demo is on Friday.', "I'm very bored today."]);
    const p = await ask('s1', 'What do you remember about this week?');
    assert.match(p.systemPrompt, /The Tidepool demo is on Friday\./, 'positive control: the company fact is quoted');
    assert.doesNotMatch(p.systemPrompt, /right eye|very bored/i);
  });

  test('opted in and asking about it: the health sentence may be quoted', async () => {
    told('s2', ['My right eye is moving automatically. The Tidepool demo is on Friday.']);
    const off = await ask('s2', 'Is my right eye still moving automatically?');
    assert.match(off.systemPrompt, /Tidepool demo/, 'positive control: recall ran');
    assert.doesNotMatch(off.systemPrompt, /right eye is moving/i, 'not opted in');
    const on = await ask('s2', 'Is my right eye still moving automatically?', { rememberSensitive: true });
    assert.match(on.systemPrompt, /My right eye is moving automatically\./);
  });

  test('recallRedaction: the forget list still applies, and no policy withholds every sensitive kind', () => {
    const base = { isRedacted: (s) => /Okafor/.test(s) };
    const r = R.recallRedaction(base, null);
    assert.equal(r.isRedacted('My dentist is Dr. Okafor.'), true);
    assert.equal(r.isRedacted("I'm very bored."), true);
    assert.equal(r.isRedacted('The launch is May 2.'), false);
    const allowMood = R.recallRedaction(base, { allows: (k) => k === 'mood' });
    assert.equal(allowMood.isRedacted("I'm very bored."), false);
    assert.equal(allowMood.isRedacted('My right eye is moving automatically.'), true);
  });

  test('said in one conversation, used in another; never in another user\'s prompt', async () => {
    told('e1', ['Our investor update goes out on the first Monday of every month.', 'Kofi is our lead investor at Basalt Ventures.']);
    const p = await ask('e1', 'Who is our lead investor?');
    assert.match(p.systemPrompt, /Kofi is our lead investor at Basalt Ventures\./);
    assert.match(p.systemPrompt, /WHAT THE USER TOLD YOU BEFORE/);
    assert.equal(p.recall.excerpts.length >= 1, true);
    const other = await ask('e2', 'Who is our lead investor?');
    assert.doesNotMatch(other.systemPrompt, /Basalt/);
  });

  test('a chat-path forget stops the quote in the very next prompt (positive control first)', async () => {
    told('e3', ['My dentist is Dr. Okafor on Elm Street.']);
    const before = await ask('e3', 'Who is my dentist?');
    assert.match(before.systemPrompt, /Okafor/);
    forgetInBackground('user:e3', 'dentist', 'Dr. Okafor');
    const after = await ask('e3', 'Who is my dentist?');
    assert.doesNotMatch(after.systemPrompt, /Okafor/);
  });

  test('AQUA_EPISODIC_RECALL=off is a complete rollback', async () => {
    told('e4', ['The Atlas launch is May 2.']);
    process.env.AQUA_EPISODIC_RECALL = 'off';
    try {
      const p = await ask('e4', 'When is the Atlas launch?');
      assert.doesNotMatch(p.systemPrompt, /WHAT THE USER TOLD YOU BEFORE/);
      assert.equal(p.recall.excerpts.length, 0);
    } finally { delete process.env.AQUA_EPISODIC_RECALL; }
  });
});
