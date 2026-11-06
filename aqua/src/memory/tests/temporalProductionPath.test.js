/**
 * The resolution reaches the PRODUCTION prompt (2026-11-02).
 *
 * The real prepareTurn (what /chat and /chat/stream hand the model) with no
 * DATABASE_URL — the legacy read production serves — and every AQUA_* switch
 * unset, which is what production runs if its environment sets none (its
 * values are not readable from the repo). Under those defaults the evidence
 * lane holds no conversational facts, so this pins the part of the temporal
 * work that is active regardless of flags: episodic recall on a history long
 * enough that it ranks instead of quoting everything. The resolution shares ONE
 * word ("FCC") with the blocker and no change word, which the follow-up rule
 * missed before 2026-11-02.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-temporal-prod-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;

const store = await import('../conversationStore.js');
const { prepareTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const Brain = await import('../../brain/index.js');

const DAY = 86_400_000;
const FILLER = ['How do I convert a CSV file to JSON?', 'What is the capital of Australia?', 'Explain compound interest simply.',
  'Give me a recipe for banana bread.', 'What does HTTP 404 mean?', 'Write a haiku about autumn rain.', 'How do vaccines work?',
  'Explain how a heat pump works.', 'How do I center a div in CSS?', 'What is a Gantt chart used for?', 'Why is the sky blue?',
  'Recommend a podcast about history.', 'How do I remove a coffee stain from a shirt?', 'What is the Pythagorean theorem?'];

function told(userId, id, sentences, daysAgo) {
  store.getOrCreateConversation(id, { userId });
  for (const s of sentences) { store.addMessage(id, 'user', s); store.addMessage(id, 'assistant', 'Got it.'); }
  store.getAllConversations().get(id).messages.forEach(m => { m.ts -= daysAgo * DAY; });
}

test('on the legacy read with default flags, the later resolution is quoted after the blocker', async () => {
  assert.equal(Brain.canonicalReadMode?.() ?? 'legacy', 'legacy', 'control: no World Model without DATABASE_URL');
  const u = 'prod-path-1';
  // Long enough that recall ranks (well past its whole-history budget).
  told(u, 'filler-a', Array.from({ length: 12 }, () => FILLER).flat(), 30);
  told(u, 'mon', ['Our Kickstarter campaign is stuck waiting on FCC certification.'], 14);
  told(u, 'filler-b', Array.from({ length: 6 }, () => FILLER).flat(), 10);
  told(u, 'wed', ['Good news, FCC signed off on the lamp last night.'], 7);

  const conv = 'ask-prod-path-1';
  store.getOrCreateConversation(conv, { userId: u });
  const prep = await prepareTurn({ userMessage: 'Is anything holding up the Kickstarter?', workspaceId: null, conversationId: conv, userId: u,
    ctx: createContext({ conversationId: conv, requestId: conv }), requestId: conv, skipReasoningPass: true });
  const p = prep.systemPrompt;
  assert.match(p, /only excerpts that match this message/, 'control: recall ranked (not whole history)');
  const b = p.indexOf('stuck waiting on FCC certification');
  const r = p.indexOf('FCC signed off');
  assert.ok(b >= 0, 'control: the blocker is quoted');
  assert.ok(r > b, 'the resolution is quoted after it');
});
