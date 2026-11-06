/**
 * A forgotten value does not come back through any lane (2026-11-06, C8).
 *
 * forgetMindCleanup.test.js pins the Mind's own state after a forget. This file
 * pins what the NEXT ANSWER is given — the real prepareTurn input (identity,
 * profile, cognitive model, graph, knowledge context from Brain/PIC, episodic
 * recall and its follow-ups) — plus direct reads of PIC, graph recall and the
 * cognitive block, for both forget flows (chat "Forget my workplace." and the
 * Memory page's forgetFact) with AQUA_PROPAGATION unset (the default) and "on".
 *
 * The workplace is the case that matters: unlike a city it has Mind copies —
 * the bridged belief "organization" and the graph edge self → Fintrail. Each
 * test has a positive control (the value IS in the input before the forget) and
 * a later unrelated turn after it (reconciliation and extraction must not bring
 * it back). Another owner who named the same company keeps it.
 *
 * Follow-up retrieval runs as deployed (AQUA_RECALL_FOLLOWUP_V2 unset) and, in
 * this process only, with it on. No database, no network, synthetic sentences.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-forget-reentry-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;               // no canonical store: the legacy read
process.env.AQUA_CANONICAL_READ = 'off';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_BRAIN_INGEST = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS = 'on';

const { prepareTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const engine = await import('../engine.js');
const Brain = await import('../../brain/index.js');
const PIC = await import('../../pic/core.js');
const P = await import('../propagation.js');
const store = await import('../conversationStore.js');
const { forgetFact } = await import('../forget.js');
const { peekMind } = await import('../../mind/mindStore.js');
const { recallGraphPaths, formatGraphRecall } = await import('../../mind/graphRecall.js');

afterEach(() => { delete process.env.AQUA_PROPAGATION; delete process.env.AQUA_RECALL_FOLLOWUP_V2; P.stopPropagationSweeper(); });

const DAY = 86_400_000;
let n = 0;
/** What chat does with each user message: store it, observe it, ingest it. */
async function told(userId, sentences, { daysAgo = 3 } = {}) {
  const owner = `user:${userId}`;
  const id = `told-${userId}-${n++}`;
  store.getOrCreateConversation(id, { userId });
  let turn = 0;
  for (const s of sentences) {
    store.addMessage(id, 'user', s); store.addMessage(id, 'assistant', 'Got it.');
    engine.memoryObserve(owner, { userMessage: s, taskType: 'personal_info', conversationId: id, userId, requestId: `seed-${n}-${turn}` });
    engine.memoryAfterTurn(owner, {});
    await Brain.observeConversationTurn({ ownerId: owner, conversationId: id, turn: turn++, userMessage: s, assistantMessage: 'Got it.' });
  }
  store.getAllConversations().get(id).messages.forEach(m => { m.ts -= daysAgo * DAY; });
  return owner;
}
/** Everything the model is given for a question asked in a NEW conversation. */
async function inputFor(userId, question) {
  const conv = `ask-${userId}-${n++}`;
  store.getOrCreateConversation(conv, { userId });
  const p = await prepareTurn({ userMessage: question, workspaceId: null, conversationId: conv, userId,
    ctx: createContext({ conversationId: conv, requestId: conv }), requestId: conv, skipReasoningPass: true });
  return [p.systemPrompt, ...(p.messages ?? []).map(m => m.content), p.evidenceContext ?? '', p.knowledgeContext ?? ''].map(String).join('\n');
}
const QUESTIONS = ['Where do I work?', 'What is my commute like these days?', 'What do you know about my job and the company?'];
const SEED = ["I'm a data analyst at Fintrail.", 'The commute there takes forty minutes by train.', 'I bought green apples at the market.'];

async function forgetBy(how, owner, userId) {
  if (how === 'chat') {
    engine.memoryObserve(owner, { userMessage: 'Forget my workplace.', taskType: 'personal_info', conversationId: `forget-${userId}`, userId, requestId: `f-${userId}` });
    engine.memoryAfterTurn(owner, {});
  } else {
    await forgetFact(owner, 'workplace');
  }
  await new Promise(r => setTimeout(r, 200));   // the chat path's World Model step runs in the background
}

for (const flag of ['unset', 'on']) {
  for (const how of ['chat', 'page']) {
    describe(`AQUA_PROPAGATION ${flag} · ${how === 'chat' ? 'chat-path forget' : 'Memory-page forget'}`, () => {
      test('the forgotten workplace reaches no lane of the next answer, and a later turn does not bring it back', async () => {
        if (flag === 'on') process.env.AQUA_PROPAGATION = 'on';
        const userId = `re-${flag}-${how}`;
        const other = `re-${flag}-${how}-other`;
        const owner = await told(userId, SEED);
        const otherOwner = await told(other, ["I'm a designer at Fintrail."]);

        // Positive controls: every copy exists, and the value reaches the input.
        const m0 = peekMind(owner);
        assert.ok(m0.facts.workplace, 'control: workplace fact');
        assert.ok(Object.values(m0.beliefs).some(b => /fintrail/i.test(String(b.value))), 'control: bridged belief');
        assert.ok(Object.values(m0.graph.edges).some(e => /fintrail/i.test(m0.graph.nodes[e.to]?.label ?? '')), 'control: graph edge');
        assert.match(await inputFor(userId, 'Where do I work?'), /Fintrail/, 'control: the value reaches the model input');

        await forgetBy(how, owner, userId);
        // A later, unrelated turn: reconciliation (when on) and extraction run again.
        await told(userId, ['I watered the tomatoes on the balcony.'], { daysAgo: 0 });

        for (const q of QUESTIONS) {
          assert.doesNotMatch(await inputFor(userId, q), /Fintrail/i, `"${q}" (follow-up v1)`);
          process.env.AQUA_RECALL_FOLLOWUP_V2 = 'on';
          assert.doesNotMatch(await inputFor(userId, q), /Fintrail/i, `"${q}" (follow-up v2)`);
          delete process.env.AQUA_RECALL_FOLLOWUP_V2;
        }
        // Direct reads of the lanes, not only their rendering in the prompt.
        const m = peekMind(owner);
        assert.equal(m.facts.workplace, undefined);
        assert.doesNotMatch(JSON.stringify(m.beliefs), /fintrail/i, 'Mind beliefs');
        assert.doesNotMatch(JSON.stringify(Object.values(m.graph.edges).map(e => m.graph.nodes[e.to]?.label)), /fintrail/i, 'graph edges');
        assert.doesNotMatch(formatGraphRecall(recallGraphPaths(m, 'Where do I work at Fintrail?')) ?? '', /fintrail/i, 'graph recall');
        assert.doesNotMatch(JSON.stringify(PIC.retrieveKnowledge(owner, 'Where do I work?', { limit: 8 })), /fintrail/i, 'PIC / Brain knowledge');
        assert.doesNotMatch(engine.memoryRetrieve(owner, { query: 'Where do I work?', taskType: 'personal_info' }).block, /fintrail/i, 'identity, profile and cognitive block');
        assert.match(await inputFor(userId, 'What is my commute like these days?'), /forty minutes/, 'only what was forgotten is gone');

        // Owner isolation: the other user's statement about the same company stays.
        assert.match(await inputFor(other, 'Where do I work?'), /Fintrail/, 'another owner keeps their own workplace');
        assert.ok(peekMind(otherOwner).facts.workplace);
        if (flag === 'unset') assert.equal(P.propagationEnabled(), false, 'the forget never turned propagation on');
      });
    });
  }
}
