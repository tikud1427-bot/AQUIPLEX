/**
 * Adding to a collection is not replacing it (C9, 2026-11-07).
 *
 * memory/engine.js step 4b (AQUA_PROPAGATION off, the default) retires the
 * evidence-lane sentence that stated a value the turn REPLACED. The legacy
 * `goal` fact is a collection, and its value changes every time a goal is
 * added — so stating a second goal archived the first goal's statement as
 * `superseded-by-user`, although it is still the user's goal. Brain/PIC then
 * no longer had it, and the C9 meaning path had nothing to attach to.
 *
 * Now a collection retires only the items it no longer holds; a single value
 * is replaced exactly as before. Synthetic sentences, isolated store.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-collection-supersession-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI|^GOOGLE)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
process.env.AQUA_BRAIN_INGEST = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS = 'on';

const engine = await import('../engine.js');
const Brain = await import('../../brain/index.js');
const ES = await import('../../files/evidenceStore.js');
const LTM = await import('../longTermMemory.js');
const { propagationEnabled } = await import('../propagation.js');

let turn = 0, n = 0;
async function say(owner, text) {
  turn++;
  engine.memoryObserve(owner, { userMessage: text, conversationId: `${owner}-c`, userId: owner, requestId: `r${turn}`, extractMessage: text });
  engine.memoryAfterTurn(owner, {});
  await Brain.observeConversationTurn({ ownerId: owner, conversationId: `${owner}-c`, turn, userMessage: text, assistantMessage: '' });
  await new Promise(r => setTimeout(r, 40));   // step 4b retires in the background
}
const statement = (o, re) => ES.listFacts(o, { limit: 1000 }).find(f => re.test(f.statement));
const fresh = () => `user:collection-${++n}`;

afterEach(() => { delete process.env.AQUA_PROPAGATION; });

describe('several goals stay current, each with its own statement', () => {
  test('control: propagation is off (the default path is the one under test)', () => {
    assert.equal(propagationEnabled(), false);
  });

  test('three goals in three messages: all three are in the profile, all three statements stay live', async () => {
    const o = fresh();
    await say(o, 'My goal is to run the Larkfield Half Marathon in October.');
    await say(o, 'My goal is to learn Spanish this year.');
    await say(o, 'My goal is to get promoted to senior analyst at Brindlewood.');
    const goals = [].concat(LTM.getFact(o, 'goal')?.value ?? []);
    assert.equal(goals.length, 3, JSON.stringify(goals));
    for (const re of [/Larkfield Half Marathon/, /learn Spanish/, /Brindlewood/]) {
      const s = statement(o, re);
      assert.ok(s, `control: ${re} is stored`);
      assert.ok(!s.archived, `${re} archived (${s.archivedReason}) though the goal is still current`);
    }
  });

  test('a goal restated in other words adds nothing and archives nothing', async () => {
    const o = fresh();
    await say(o, 'My goal is to run the Larkfield Half Marathon in October.');
    await say(o, 'My goal is to learn Spanish this year.');
    await say(o, 'I have been using Duolingo every morning.');
    assert.ok(!statement(o, /Larkfield/).archived);
    assert.ok(!statement(o, /learn Spanish/).archived);
  });
});

describe('a genuinely replaced value is still retired', () => {
  test('a single value: "I live in Lisbon." is archived when the city becomes Porto', async () => {
    const o = fresh();
    await say(o, 'I live in Lisbon.');
    assert.ok(statement(o, /Lisbon/) && !statement(o, /Lisbon/).archived, 'control: stored and live');
    await say(o, 'Actually, my city is now Porto.');
    assert.equal(LTM.getFact(o, 'city')?.value, 'Porto');
    assert.equal(statement(o, /I live in Lisbon/).archived, true);
    assert.equal(statement(o, /I live in Lisbon/).archivedReason, 'superseded-by-user');
  });

  test('ending one goal of a collection leaves the goals it still holds live', async () => {
    const o = fresh();
    await say(o, 'My goal is to run the Larkfield Half Marathon in October.');
    await say(o, 'My goal is to learn Spanish this year.');
    // Ended in the user's words, in a turn: memoryObserve's later-word step removes the item.
    await say(o, 'I gave up on the Larkfield Half Marathon.');
    const goal = [].concat(LTM.getFact(o, 'goal')?.value ?? []);
    assert.ok(!goal.some(v => /Larkfield/i.test(v)), `control: the item left the collection — ${JSON.stringify(goal)}`);
    assert.ok(!statement(o, /learn Spanish/).archived, 'the item still held stays live');
  });

  // KNOWN LIMITATION, pinned (unchanged by C9; the code before also left it live): the removed
  // item is handed to brain/index.js retireSupersededStatement, which only retires a sentence
  // found inside the PREVIOUS version's source message — here the Spanish message, not the
  // Larkfield one. A collection keeps no per-item source, so the ended goal's own sentence
  // stays live in the evidence lane. Its state is still right in the profile ("No longer
  // current") and in the Mind.
  test('the sentence of a goal the user ended is retired from the evidence lane', { todo: 'a collection keeps no per-item source sentence (retireSupersededStatement matches the previous version\'s source only)' }, async () => {
    const o = fresh();
    await say(o, 'My goal is to run the Larkfield Half Marathon in October.');
    await say(o, 'My goal is to learn Spanish this year.');
    await say(o, 'I gave up on the Larkfield Half Marathon.');
    assert.equal(statement(o, /Larkfield/).archived, true);
  });
});
