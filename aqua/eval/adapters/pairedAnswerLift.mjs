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
 * Set AQUA_LIFT_PROVIDER=groq|gemini|openrouter|nvidia and the corresponding
 * key; AQUA_LIFT_MODEL pins the model (default: that provider's first
 * registered model).
 *
 * 🔴 THE CONTROL WAS NOT CONTROLLED (fixed 2026-10). AQUA_LIFT_PROVIDER used to
 * be passed to the router as `{ [provider]: undefined }` — a deps entry the
 * router ignores — so BOTH lanes went through full production fallback and
 * could be answered by different providers (Groq floor vs NVIDIA world model),
 * a comparison of providers rather than of evidence. Now:
 *   - provider set → both lanes call THAT adapter directly with the SAME pinned
 *     model (a pin throws rather than substitutes);
 *   - provider unset → production router (unchanged), and a case whose two
 *     lanes came back from different provider/models is marked `paired: false`
 *     so it can be excluded rather than silently averaged in.
 */
import { retrieveWithCurrentEngine as retrieveFloor, seedWorld } from './currentRetrieval.mjs';
import { retrieveWithContextEngine } from './contextEngineRetrieval.mjs';

let router = null;

async function loadRouter() {
  if (router) return router;
  router = await import('../../src/providers/router.js');
  return router;
}

export const LIFT_PROVIDERS = Object.freeze(['groq', 'gemini', 'openrouter', 'nvidia']);

const ADAPTERS = {
  groq:       async () => (await import('../../src/providers/groq.js')).generateGroq,
  gemini:     async () => (await import('../../src/providers/gemini.js')).generateGemini,
  openrouter: async () => (await import('../../src/providers/openrouter.js')).generateOpenRouter,
  nvidia:     async () => (await import('../../src/providers/nvidia.js')).generateNvidia,
};

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

/**
 * Which transport answers BOTH lanes.
 *
 * @returns {Promise<{ mode: 'router'|'pinned', provider: string|null, model: string|null }>}
 */
export async function resolveLiftTransport(env = process.env) {
  const provider = String(env.AQUA_LIFT_PROVIDER ?? '').trim().toLowerCase() || null;
  const model = String(env.AQUA_LIFT_MODEL ?? '').trim() || null;
  if (!provider) {
    if (model) throw new Error('AQUA_LIFT_MODEL is set without AQUA_LIFT_PROVIDER — a model pin needs a provider');
    return { mode: 'router', provider: null, model: null };
  }
  if (!LIFT_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown AQUA_LIFT_PROVIDER "${provider}" — expected one of ${LIFT_PROVIDERS.join(', ')}`);
  }
  if (model) return { mode: 'pinned', provider, model };
  const { pickModel } = await import('../../src/providers/modelRegistry.js');
  const first = pickModel(provider);
  if (!first) throw new Error(`AQUA_LIFT_PROVIDER=${provider} has no available registered model`);
  return { mode: 'pinned', provider, model: first.modelId };
}

/**
 * The ONE answering function used for both lanes.
 * `deps.adapters` / `deps.router` are test seams.
 */
// The router-mode budget, kept for every pinned provider except nvidia, whose
// gpt-oss-20b spends output tokens on hidden reasoning before any content
// (1024 was exhausted on E6 prompts, measured 2026-10) — 180 would return
// nothing. The answer itself stays short; only the reasoning headroom differs.
const PINNED_MAX_TOKENS = { nvidia: 2048 };

export async function liftAnswerer(transport, deps = {}) {
  if (transport.mode === 'pinned') {
    const generate = deps.adapters?.[transport.provider] ?? await ADAPTERS[transport.provider]();
    const maxTokens = PINNED_MAX_TOKENS[transport.provider] ?? 180;
    return async (testCase, system) => {
      const r = await generate(system, messages(testCase.q), undefined, maxTokens,
        { model: transport.model, temperature: 0 });
      return { text: r.text, provider: transport.provider, model: r.model ?? null };
    };
  }
  const r = deps.router ?? await loadRouter();
  return async (testCase, system) => {
    const res = await r.generateText(
      testCase.q, system, messages(testCase.q),
      { requestId: `world-model-lift:${testCase.id}:auto` },
      'personal_info', { complexity: 'simple' }, { maxResponseTokens: 180 },
    );
    return { text: res.text, provider: res.provider, model: res.model ?? null };
  };
}

/** Both lanes answered by the same provider AND model — the experiment's control. */
export function isPaired(floorAnswer, worldModelAnswer) {
  return floorAnswer.provider === worldModelAnswer.provider
    && (floorAnswer.model ?? null) === (worldModelAnswer.model ?? null);
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

  const transport = await resolveLiftTransport();
  const answer = await liftAnswerer(transport);
  const [floorAnswer, worldModelAnswer] = await Promise.all([
    answer(testCase, evidencePrompt(testCase.q, floorStatements)),
    answer(testCase, evidencePrompt(testCase.q, worldStatements)),
  ]);

  return {
    status: 'ok',
    actual: {
      transport,
      paired: isPaired(floorAnswer, worldModelAnswer),
      floor: { answer: floorAnswer.text, provider: floorAnswer.provider, model: floorAnswer.model, evidenceIds: floor.ranked },
      worldModel: { answer: worldModelAnswer.text, provider: worldModelAnswer.provider, model: worldModelAnswer.model, evidenceIds: worldModel.ranked },
    },
  };
}
