/**
 * AQUA Eval — adapter for the CONTEXT ENGINE retrieval path (Blueprint E8).
 *
 * 🔴 THE GATE HAS BEEN MEASURING A LANE PRODUCTION WRAPS.
 * -------------------------------------------------------
 * `retrieval-core.v1` drives `pic/core retrieveKnowledge` and its adapter says
 * that is "the exact facade the chat spine calls". It was, once. It is not now.
 * `routes/chat.js:587`:
 *
 *     const knowledge = Brain.contextV2Active()
 *       ? Brain.assembleContext(memoryOwner, userMessage, floorRetrieve, {…})
 *       : floorRetrieve(memoryOwner, userMessage, { limit: 8 });
 *
 * `AQUA_CONTEXT_V2=on` ships in the environment template, so the live branch is
 * the first one: PIC retrieval is the FLOOR passed INTO the Context Engine,
 * which then widens the pool with world-model neighbours, rescores on ten
 * dimensions, and re-selects under budget. What reaches the model is the
 * Context Engine's selection, not PIC's.
 *
 * So every number in `retrieval-core.v1` — including the six that moved when
 * lane 5 landed — describes a stage whose output production overrides before
 * anything is rendered. That is the L12 shape ("what is measured and what would
 * ship are the same code") failing in the least visible way available: the
 * measurement is real, the engine is real, and they are different engines.
 *
 * This adapter closes that. Same world, same 200 queries, same scorer — the
 * only change is which function is asked.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not replace `currentRetrieval.mjs`. Both lanes are kept and reported
 * separately, because "the floor got better" and "what the user sees got
 * better" are different claims and folding them into one number is how the
 * difference above stayed invisible. The floor baseline is also the only thing
 * that can attribute a CE regression to the CE.
 *
 * It does not run the CIE broaden wrapper. `cognitiveKnowledgeRetrieve` only
 * acts when a cognition PLAN says `broadenOnEmpty`, and no plan exists outside
 * a live turn — inventing one would measure a policy this harness made up.
 * Declared, not skipped silently.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let engine = null;

/**
 * Import the engine once, against a private data directory.
 *
 * Flags match `currentRetrieval.mjs` EXACTLY, plus AQUA_BRAIN_INGEST — the
 * Context Engine's read switch is `brainEnabled() && AQUA_CONTEXT_V2==='on'`,
 * and a baseline taken with the engine's own gate shut would report the floor
 * twice under two different names.
 */
async function loadEngine() {
  if (engine) return engine;
  process.env.AQUA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'aqua-eval-ce-'));
  process.env.AQUA_BRAIN = 'on';
  process.env.AQUA_PIC = 'on';
  process.env.AQUA_UUS = 'on';
  process.env.AQUA_SELF_ENTITY = 'on';
  process.env.AQUA_CONTEXT_V2 = 'on';

  const [pic, brain, graph, evidenceStore] = await Promise.all([
    import('../../src/pic/core.js'),
    import('../../src/brain/index.js'),
    import('../../src/reasoning/reasoningGraph.js'),
    import('../../src/files/evidenceStore.js'),
  ]);
  engine = { pic, brain, graph, evidenceStore };
  return engine;
}

/**
 * Ask the question the way `routes/chat.js` asks it.
 *
 * `semanticScores: null` and `activeProjectId: null` are what a turn with no
 * embeddings and no open workspace supplies, which is the same condition the
 * floor baseline measures. Passing invented values would make the two lanes
 * incomparable in exactly the dimension being isolated.
 */
export async function retrieveWithContextEngine(ownerId, query, { limit = 8, semanticScores = null, retrievalV3 = false } = {}) {
  if (retrievalV3) process.env.AQUA_RETRIEVAL_V3 = 'on';
  else delete process.env.AQUA_RETRIEVAL_V3;
  const { pic, brain } = await loadEngine();
  if (!brain.contextV2Active()) {
    throw new Error('AQUA_CONTEXT_V2 is off — this adapter would silently measure the PIC floor a second time.');
  }

  const floorRetrieve = (oid, q, o) => pic.retrieveKnowledge(oid, q, { limit: o?.limit ?? limit });
  const out = brain.assembleContext(ownerId, query, floorRetrieve, {
    limit, semanticScores, activeProjectId: null,
  });

  return {
    items: out.items ?? [],
    stats: out.stats ?? {},
    ranked: (out.items ?? [])
      .filter(it => it.kind === 'fact' || it.kind === undefined)
      .map(it => it.factId ?? it.id ?? null)
      .filter(Boolean)
      .map(id => String(id).replace(/^fact:/, '')),
  };
}

export { seedWorld, resetWorld } from './currentRetrieval.mjs';
