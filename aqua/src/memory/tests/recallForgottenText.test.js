/**
 * Forgotten text never ranks (2026-11-05, privacy, UNCONDITIONAL).
 *
 * Quoting always dropped forgotten sentences, but ranking (scoreUnits) and the
 * follow-up step read the raw passage, so a forgotten sentence could match the
 * question and pull its surviving sibling into the prompt, or tie a follow-up
 * through words only it held. Each test runs with the follow-up flag OFF (the
 * default) and ON: the fix does not depend on AQUA_RECALL_FOLLOWUP_V2.
 *
 * Forgets go through the production store (recallRedactions.redactPhrases /
 * redactAllBefore) and, where the turn entry matters, recallForTurn.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR             = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-recall-forgotten-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI                 = '';
delete process.env.DATABASE_URL;
delete process.env.AQUA_SEMANTIC_RECALL;
delete process.env.AQUA_RECALL_ALL_CHARS;

const R = await import('../episodicRecall.js');
const RR = await import('../recallRedactions.js');

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 3, 1);
const FILLER = ['The cat slept on the sofa all afternoon.', 'I watered the tomatoes on the balcony.', 'We watched a documentary about owls.',
  'The kettle whistles very loudly.', 'My neighbour plays the cello in the evenings.', 'I bought green apples at the market.',
  'The bus was crowded this morning.', 'I read a short story about a lighthouse keeper.'];

/** One conversation per statement ([day, text, owner?]), plus filler; returns the conversations map. */
function history(owner, statements) {
  const m = new Map();
  [...statements, ...FILLER.map((t, i) => [60 + i, t])].forEach(([day, content, who = owner], i) => {
    m.set(`${owner}-c${i}`, { meta: { userId: who, title: `c${i}` }, messages: [{ role: 'user', content, ts: T0 + day * DAY }] });
  });
  return m;
}
const turn = (owner, conversations, query, extra = {}) => R.recallForTurn({ ownerId: `user:${owner}`, userId: owner, conversationId: 'none', query, conversations,
  includeFiles: false, allUnderChars: 0, ...extra });
const quoted = r => r.excerpts.map(e => e.text);

for (const flag of ['off', 'on']) {
  describe(`forgotten text never ranks (AQUA_RECALL_FOLLOWUP_V2=${flag})`, () => {
    beforeEach(() => { RR.__resetForTests(); R.__clearCacheForTests(); if (flag === 'on') process.env.AQUA_RECALL_FOLLOWUP_V2 = 'on'; else delete process.env.AQUA_RECALL_FOLLOWUP_V2; });
    afterEach(() => { delete process.env.AQUA_RECALL_FOLLOWUP_V2; });

    test('a forgotten sentence does not match the question and pull its sibling in (keywords)', async () => {
      const c = history('k1', [[1, 'Our bank appointment is on Monday.'], [3, 'We changed the bank appointment to Wednesday. Also the car needs new tyres.']]);
      const before = await turn('k1', c, 'When is the bank appointment?');
      assert.ok(quoted(before).some(t => /Wednesday/.test(t)), 'control: quoted while not forgotten');
      RR.redactPhrases('user:k1', ['changed the bank appointment to Wednesday']);
      const r = await turn('k1', c, 'When is the bank appointment?');
      assert.deepEqual(quoted(r), ['Our bank appointment is on Monday.']);
      assert.equal(r.stats.redactedSentences, 1, 'the forgotten sentence is counted');
    });

    test('a forgotten sentence contributes no identifier', async () => {
      const c = history('k2', [[1, 'Invoice ZK-7781 is overdue.'], [4, 'ZK-7781 was paid in full. Also the printer needs toner.']]);
      RR.redactPhrases('user:k2', ['ZK-7781 was paid']);
      const r = await turn('k2', c, 'Is invoice ZK-7781 overdue?');
      assert.ok(!quoted(r).some(t => /toner/.test(t)), JSON.stringify(quoted(r)));
    });

    test('a forgotten PARENT sentence does not link a follow-up (names, words)', async () => {
      const c = history('k3', [[1, 'I go swimming on Tuesdays. My cousin Ilse moved to the Harlow district.'], [6, 'Harlow district changed its parking rules now.']]);
      const open = await turn('k3', c, 'When do I go swimming?');
      if (flag === 'off') assert.ok(quoted(open).some(t => /parking/.test(t)), 'control: the legacy step follows it up while nothing is forgotten');
      RR.redactPhrases('user:k3', ['cousin Ilse']);
      const r = await turn('k3', c, 'When do I go swimming?');
      assert.deepEqual(quoted(r), ['I go swimming on Tuesdays.']);
    });

    test('a forgotten CANDIDATE sentence supplies neither the link nor the transition', async () => {
      const c = history('k4', [[1, 'I go swimming at the Ardley pool.'], [6, 'Ardley pool changed its opening hours now. Also my bike is fixed.']]);
      RR.redactPhrases('user:k4', ['Ardley pool changed its opening hours']);
      const r = await turn('k4', c, 'Where do I go swimming?');
      assert.deepEqual(quoted(r), ['I go swimming at the Ardley pool.']);
    });

    test('a forgotten parent seeds nothing', async () => {
      const c = history('k5', [[1, 'The Kestrel project is blocked by the audit.'], [4, 'The audit is done, all clear.']]);
      RR.redactPhrases('user:k5', ['Kestrel project is blocked']);
      const r = await turn('k5', c, 'What is blocking the Kestrel project?');
      assert.deepEqual(quoted(r), []);
    });

    test('forget-everything: nothing said before the cutoff is quoted, by rank or follow-up; later statements still are', async () => {
      const c = history('k6', [[1, 'The Kestrel project is blocked by the audit.'], [3, 'The Kestrel audit is done.'], [8, 'The Kestrel project restarts in May.']]);
      RR.redactAllBefore('user:k6', T0 + 5 * DAY);
      const r = await turn('k6', c, 'What is happening with the Kestrel project?');
      assert.deepEqual(quoted(r), ['The Kestrel project restarts in May.']);
    });

    test("another owner's statements and a deleted conversation never participate", async () => {
      const c = history('k7', [[1, 'Our bank appointment is on Monday.'], [3, 'Correction: the bank appointment moved to Friday.', 'someone-else']]);
      const r = await turn('k7', c, 'When is the bank appointment?');
      assert.deepEqual(quoted(r), ['Our bank appointment is on Monday.']);
      c.set('k7-deleted', { meta: { userId: 'k7', title: 'gone' }, messages: [{ role: 'user', content: 'The bank appointment moved to Thursday.', ts: T0 + 4 * DAY }] });
      assert.ok(quoted(await turn('k7', c, 'When is the bank appointment?')).some(t => /Thursday/.test(t)), 'control: present while it exists');
      c.delete('k7-deleted');
      R.__clearCacheForTests();
      assert.ok(!quoted(await turn('k7', c, 'When is the bank appointment?')).some(t => /Thursday/.test(t)), 'deleted: gone');
    });

    test('a NEW forget takes effect on the next turn (the cleaned-passage cache follows the forget list)', async () => {
      const c = history('k8', [[1, 'Our bank appointment is on Monday.'], [3, 'We changed the bank appointment to Wednesday. Also the car needs new tyres.']]);
      RR.redactPhrases('user:k8', ['an unrelated phrase nobody said']);
      assert.ok(quoted(await turn('k8', c, 'When is the bank appointment?')).some(t => /Wednesday/.test(t)), 'control (forget list active, cache warm)');
      RR.redactPhrases('user:k8', ['changed the bank appointment to Wednesday']);
      assert.ok(!quoted(await turn('k8', c, 'When is the bank appointment?')).some(t => /tyres|Wednesday/.test(t)));
    });
  });
}

describe('scope of the fix: exactly the forget list', () => {
  beforeEach(() => { RR.__resetForTests(); R.__clearCacheForTests(); });

  test('an owner with nothing forgotten pays nothing: the pool is the input', () => {
    const units = R.collectUnits({ userId: 's1', conversationId: 'none', conversations: history('s1', [[1, 'Our bank appointment is on Monday.']]) });
    const { pool, removed } = R.forgetClean(units, RR.redactionsFor('user:s1'));
    assert.equal(pool, units);
    assert.equal(removed, 0);
  });

  test('the sensitivity policy is not folded into forgetting: a health sentence stays in the ranking pool and is still withheld from quotes', async () => {
    const c = history('s2', [[1, 'I was diagnosed with asthma last year. I bought new running shoes.']]);
    RR.redactPhrases('user:s2', ['an unrelated phrase nobody said']);
    const units = R.collectUnits({ userId: 's2', conversationId: 'none', conversations: c });
    const { pool } = R.forgetClean(units, RR.redactionsFor('user:s2'));
    assert.ok(pool.some(u => /asthma/.test(u.text)), 'forgetClean removes only what was forgotten');
    const r = await turn('s2', c, 'What shoes did I buy?');
    assert.ok(!quoted(r).some(t => /asthma/.test(t)), 'quoting still withholds it (no policy this turn)');
  });

  test('forgetting one phrase leaves the rest of the passage rankable', async () => {
    const c = history('s3', [[1, 'I live in Lisbon. I work at Nummo as head of product.']]);
    RR.redactPhrases('user:s3', ['Lisbon']);
    const r = await turn('s3', c, 'Where do I work?');
    assert.deepEqual(quoted(r), ['I work at Nummo as head of product.']);
    assert.deepEqual(quoted(await turn('s3', c, 'Where do I live, Lisbon?')), [], 'the forgotten word no longer matches');
  });
});
