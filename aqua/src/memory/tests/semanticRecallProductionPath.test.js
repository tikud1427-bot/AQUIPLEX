/**
 * Semantic episodic recall through the real chat turn (routes/chat.js prepareTurn).
 * Private data dir, no provider (deterministic fake embedder), no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-semantic-recall-e2e-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^GEMINI_API|^Gemini_API|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}

const store = await import('../conversationStore.js');
const DE = await import('../../embeddings/dedicatedEmbedder.js');
const { EMBED_DIM } = await import('../../embeddings/embeddingModel.js');
const { prepareTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');

const DAY = 86_400_000;
const FUNDING = ['funding', 'fundraising', 'seed', 'round', 'raised', 'investors', 'sequoia'];
// The dedicated credential's network call, replaced; key selection stays real.
DE.__setDedicatedTransportForTests((key, texts) => ({ embeddings: texts.map(t => {
  const w = String(t).toLowerCase().match(/[a-z]+/g) ?? [];
  const v = new Array(EMBED_DIM).fill(0);
  v[0] = w.filter(x => FUNDING.includes(x)).length; v[1] = w.filter(x => ['pasta', 'dinner', 'sunny', 'weather'].includes(x)).length; v[2] = 0.15;
  return { values: v };
}) }));

let n = 0;
function told(userId, sentences, daysAgo) {
  const id = `told-${userId}-${n++}`;
  store.getOrCreateConversation(id, { userId });
  for (const s of sentences) { store.addMessage(id, 'user', s); store.addMessage(id, 'assistant', 'Got it.'); }
  store.getAllConversations().get(id).messages.forEach(m => { m.ts -= daysAgo * DAY; });
}
const ask = async (userId, q) => {
  const conv = `ask-${userId}-${n++}`;
  store.getOrCreateConversation(conv, { userId });
  return prepareTurn({ userMessage: q, workspaceId: null, conversationId: conv, userId, ctx: createContext({ conversationId: conv, requestId: conv }), requestId: conv, skipReasoningPass: true });
};
const filler = i => `On day ${i} the weather was sunny and I made pasta for dinner, nothing else worth noting today, entry ${i}.`;

for (const [flag, key, expectFound] of [['off', true, false], ['on', false, false], ['on', true, true]]) {
  test(`AQUA_SEMANTIC_RECALL=${flag}, dedicated key ${key ? 'set' : 'MISSING'}: "How's fundraising going?" ${expectFound ? 'quotes' : 'cannot quote'} "We closed our seed round…"`, async () => {
    const user = `e2e-${flag}-${key}`;
    if (flag === 'on') process.env.AQUA_SEMANTIC_RECALL = 'on'; else delete process.env.AQUA_SEMANTIC_RECALL;
    if (key) process.env.AQUA_EMBEDDING_API_KEY = 'test-only-dedicated-recall-key'; else delete process.env.AQUA_EMBEDDING_API_KEY;
    try {
      told(user, ['We closed our seed round with Sequoia.'], 20);
      told(user, Array.from({ length: 70 }, (_, i) => filler(i)), 10);
      // Indexing is bounded (64 passages per turn, newest first) and runs in the
      // background: 71 passages need two turns before the oldest is searchable.
      await ask(user, 'Anything new?');
      await new Promise(r => setTimeout(r, 50));
      await ask(user, 'And otherwise?');
      await new Promise(r => setTimeout(r, 50));
      const p = await ask(user, "How's fundraising going?");
      if (expectFound) assert.match(p.systemPrompt, /We closed our seed round with Sequoia\./);
      else assert.doesNotMatch(p.systemPrompt, /seed round/);
    } finally { delete process.env.AQUA_SEMANTIC_RECALL; delete process.env.AQUA_EMBEDDING_API_KEY; }
  });
}
