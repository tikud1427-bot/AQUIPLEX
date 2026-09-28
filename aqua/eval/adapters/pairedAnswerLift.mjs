/**
 * AQUIPLEX — paired end-to-end World-Model Lift adapter.
 *
 * This is an evidence-controlled answer experiment:
 *   1) seed the SAME world;
 *   2) retrieve the SAME query through the floor and Context Engine;
 *   3) ask the SAME provider/model to answer from each evidence set;
 *   4) score the two answers against the SAME reference judgments.
 *
 * It is intentionally opt-in because it calls a real model provider.
 * Set AQUA_LIFT_PROVIDER=groq|gemini|openrouter and the corresponding key.
 */
import { retrieveWithCurrentEngine as retrieveFloor, seedWorld } from './currentRetrieval.mjs';
import { retrieveWithContextEngine } from './contextEngineRetrieval.mjs';

let router = null;

async function loadRouter() {
  if (router) return router;
  router = await import('../../src/providers/router.js');
  return router;
}

function evidencePrompt(query, statements) {
  const evidence = statements.map((s, i) => `[E${i + 1}] ${s}`).join('\n');
  return [
    'You are answering a personal-assistant evaluation question.',
    'Use ONLY the supplied evidence. Do not invent facts.',
    'If the evidence does not establish the answer, say you do not know.',
    'Answer the user directly and concisely. Do not mention the evaluation.',
    '',
    `Evidence:\n${evidence || '(none)'}`,
  ].join('\n');
}

function messages(query) {
  return [{ role: 'user', content: query }];
}

export async function generatePairedAnswers(ownerId, testCase, { limit = 8 } = {}) {
  if (String(process.env.AQUA_LIFT_LLM ?? '').toLowerCase() !== 'on') {
    return { status: 'skipped', reason: 'set AQUA_LIFT_LLM=on to run the real provider-backed paired-answer experiment' };
  }

  const [floor, worldModel] = await Promise.all([
    retrieveFloor(ownerId, testCase.q, { limit }),
    retrieveWithContextEngine(ownerId, testCase.q, { limit }),
  ]);

  const statementsById = new Map((await import('../datasets/retrieval-core.v1.json', { with: { type: 'json' } })).default.corpus.map(x => [x.id, x.statement]));
  const floorStatements = floor.ranked.map(id => statementsById.get(id)).filter(Boolean);
  const worldStatements = worldModel.ranked.map(id => statementsById.get(id)).filter(Boolean);

  const r = await loadRouter();
  const provider = process.env.AQUA_LIFT_PROVIDER || undefined;
  const call = async statements => r.generateText(
    testCase.q,
    evidencePrompt(testCase.q, statements),
    messages(testCase.q),
    { requestId: `world-model-lift:${testCase.id}:${provider ?? 'auto'}` },
    'personal_info',
    { complexity: 'simple' },
    { maxResponseTokens: 180 },
    provider ? { [provider]: undefined } : {},
  );

  // Provider selection remains the production router when no explicit provider
  // is set. The same router configuration is used for both lanes.
  const [floorAnswer, worldModelAnswer] = await Promise.all([
    call(floorStatements),
    call(worldStatements),
  ]);

  return {
    status: 'ok',
    actual: {
      floor: { answer: floorAnswer.text, provider: floorAnswer.provider, evidenceIds: floor.ranked },
      worldModel: { answer: worldModelAnswer.text, provider: worldModelAnswer.provider, evidenceIds: worldModel.ranked },
    },
  };
}
