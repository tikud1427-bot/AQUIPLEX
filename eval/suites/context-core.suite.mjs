/**
 * AQUA Eval — Context Engine retrieval quality
 * Blueprint E8
 *
 * 🔴 WHY THIS SUITE EXISTS: THE GATE WAS GRADING A STAGE PRODUCTION OVERRIDES.
 * ---------------------------------------------------------------------------
 * `retrieval-core` drives `pic/core retrieveKnowledge` and its adapter calls
 * that "the exact facade the chat spine calls". That was true when it was
 * written. `routes/chat.js:587` now reads:
 *
 *     const knowledge = Brain.contextV2Active()
 *       ? Brain.assembleContext(memoryOwner, userMessage, floorRetrieve, {…})
 *       : floorRetrieve(memoryOwner, userMessage, { limit: 8 });
 *
 * `AQUA_CONTEXT_V2=on` ships in the environment template, so the live branch is
 * the first: PIC is the FLOOR handed INTO the Context Engine, which widens the
 * pool with world-model neighbours, rescores on ten dimensions, and re-selects
 * under budget. The Context Engine's selection is what reaches the model.
 *
 * Every metric in `retrieval-core.v1` therefore describes an intermediate
 * result. Not a wrong measurement — a measurement of the wrong stage, which is
 * harder to notice because the numbers are real and the engine is real and
 * they are different engines.
 *
 * SAME DATASET, SAME SCORER, ONE FUNCTION DIFFERENT
 * ------------------------------------------------
 * 200 queries, one world, `retrievalScoring.mjs` shared verbatim with
 * `retrieval-core`. The only variable is which retrieval function is asked, so
 * the difference between the two baselines is attributable to the Context
 * Engine and to nothing else.
 *
 * BOTH LANES ARE KEPT, AND THAT IS THE POINT
 * ------------------------------------------
 * "The floor improved" and "what the user actually sees improved" are separate
 * claims. Folding them into one number is how the gap above survived this long.
 * The floor baseline is also the only instrument that can attribute a Context
 * Engine regression TO the Context Engine.
 *
 * DECLARED GAP: the CIE broaden wrapper (`cognitiveKnowledgeRetrieve`) sits
 * between chat and the floor in production. It only acts on a cognition PLAN
 * with `broadenOnEmpty`, and no plan exists outside a live turn. Fabricating
 * one would measure a policy this harness invented. Not run, not skipped
 * silently.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedWorld } from '../adapters/currentRetrieval.mjs';
import { retrieveWithContextEngine } from '../adapters/contextEngineRetrieval.mjs';
import { K, kindMap, scoreQuery, aggregate } from './retrievalScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const OWNER = 'user:eval-context';

const KIND_OF = kindMap(DS.corpus);

let seeded = false;

export default {
  id: 'context-core',
  title: 'Context Engine retrieval quality — the path production actually reads',
  about: [
    'Drives Brain.assembleContext over the same 60-fact world and 200 labelled queries',
    'retrieval-core uses, with the PIC lane supplied as the floor exactly as routes/chat.js',
    'supplies it. Reports the same metrics through the same shared scorer, so the delta',
    'against retrieval-core.v1 isolates what the Context Engine does to the floor it was',
    'given — including anything it removes.',
  ].join('\n'),

  cases: DS.queries,

  async run(testCase) {
    if (!seeded) { await seedWorld(OWNER, DS.corpus); seeded = true; }
    const r = await retrieveWithContextEngine(OWNER, testCase.q, { limit: K });
    return { status: 'ok', actual: { ranked: r.ranked } };
  },

  score(testCase, actual) {
    return scoreQuery(testCase, actual.ranked, KIND_OF);
  },

  metrics(scored) {
    return aggregate(scored);
  },
};
