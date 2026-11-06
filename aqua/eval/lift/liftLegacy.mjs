/**
 * The LEGACY PRODUCTION READ for a Lift persona (2026-10-29). Production
 * serves the legacy read: no DATABASE_URL, so no canonical World Model reaches
 * an answer. This is that turn's user context — memoryRetrieve's block (fact
 * store + Mind, legacy mode) + the PIC knowledge block — built by the calls
 * routes/chat.js prepareTurn makes, after replaying every turn through the
 * synchronous legacy writers a chat turn runs (memoryObserve before the
 * answer; memoryAfterTurn, observeConversationTurn, observeTwin after it) and
 * each document through the upload route's two calls. Episodic recall is the
 * caller's (it reads the conversation store, not these writers).
 *
 * One sequential phase with DATABASE_URL blanked, as production has it, under
 * the owner `user:<userIdFor(p)>`, on the clock recall's dates use (each turn
 * at its own time, questions the day after the last session), so fact ages
 * and recency agree with the quotes. LLM-free and deterministic. Keyword path
 * only: fact embeddings are indexed asynchronously and cannot be awaited here
 * (production falls back to the same path when embeddings are unavailable).
 *
 * Shared by scripts/world-model-lift-live.mjs (`legacyProd`) and
 * scripts/lift-legacy-answers.mjs.
 */
import * as Brain from '../../src/brain/index.js';
import * as LR from './liftRecall.mjs';

/** Map<questionId, { memoryBlock, knowledgeBlock, facts, items }>. */
export async function legacyContexts(personas, { userIdFor, traceId = 'lift-legacy' }) {
  const out = new Map();
  const engine = await import('../../src/memory/engine.js');
  const { cognitiveKnowledgeRetrieve } = await import('../../src/cognition/index.js');
  const { sensitivePolicy, redactSensitiveSentences, scrubSensitiveLines } = await import('../../src/memory/sensitivity.js');
  const { formatCitation } = await import('../../src/files/evidence.js');
  const { classifyTask } = await import('../../src/core/classifier.js');
  const { ingestFiles } = await import('../../src/files/fileEngine.js');
  const { observeIngest } = await import('../../src/understanding/observeIngest.js');
  const savedDb = process.env.DATABASE_URL;
  process.env.DATABASE_URL = '';
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    for (const persona of personas) {
      if (!Array.isArray(persona.sessions)) throw new Error(`legacyProd needs multi-session personas (${persona.id})`);
      const userId = userIdFor(persona);
      const ownerId = engine.resolveOwner({ userId, conversationId: null });
      persona.sessions.forEach((turns, s) => {
        const conversationId = `${userId}-s${s + 1}`;
        turns.forEach((text, i) => {
          clock = LR.turnTime(s, i);
          const { task: taskType } = classifyTask(text);
          const writeView = redactSensitiveSentences(text);
          engine.memoryObserve(ownerId, { userMessage: text, taskType, workspaceId: null, conversationId, userId,
            requestId: `lift-legacy-${s + 1}-${i + 1}`, extractMessage: writeView.text, rememberSensitive: false });
          engine.memoryAfterTurn(ownerId, { taskType, workspaceId: null });
          Brain.observeConversationTurn({ ownerId, conversationId, turn: i + 1, userMessage: writeView.text, assistantMessage: '' });
          Brain.observeTwin({ ownerId, userMessage: writeView.text, conversationId });
        });
      });
      for (const doc of persona.documents ?? []) {
        clock = LR.turnTime(doc.afterSession - 1, 0) + 23 * 3_600_000;   // as attachmentsFor dates it
        const r = await ingestFiles({ files: [{ name: doc.name, buffer: Buffer.from(String(doc.text), 'utf8') }],
          ownerId, conversationId: `${userId}-s${doc.afterSession}`, workspaceName: 'Uploaded project', traceId });
        try { observeIngest({ ownerId, ukoIds: r.ukoIds ?? [] }); } catch { /* fail-open, as the route */ }
      }
      clock = LR.askTime(persona);
      for (const question of persona.questions) {
        const q = question.q;
        const { task: taskType } = classifyTask(q);
        const sensitive = sensitivePolicy({ rememberSensitive: false, message: q });
        const retrieved = engine.memoryRetrieve(ownerId, { query: q, taskType, factLimit: 10, requestId: `lift-legacy-${question.id}`,
          semanticScores: null, fileChunks: [], legacyUserMemory: true, legacyVeto: null, sensitive });
        const floorRetrieve = (oid, qq, o) => cognitiveKnowledgeRetrieve(oid, qq, { ...o, plan: null });
        const knowledge = Brain.contextV2Active()
          ? await Brain.assembleContextAsync(ownerId, q, floorRetrieve, { limit: 8, plan: null, taskType, formatCitation,
              conversationId: `${persona.id}-ask`, canonicalOnly: false, semanticScores: null, activeProjectId: null })
          : floorRetrieve(ownerId, q, { limit: 8 });
        const knowledgeBlock = scrubSensitiveLines(knowledge.block ?? '', sensitive).block;
        out.set(question.id, { memoryBlock: retrieved.block ?? '', knowledgeBlock, facts: retrieved.relevantFacts?.length ?? 0,
          items: knowledge.items?.length ?? 0, knowledgeItems: knowledge.items ?? [] });
      }
    }
  } finally {
    Date.now = realNow;
    process.env.DATABASE_URL = savedDb;
  }
  return out;
}
