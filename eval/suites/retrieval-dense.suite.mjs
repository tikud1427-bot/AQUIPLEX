/**
 * AQUA Eval — retrieval WITH the dense lane
 * Blueprint E7
 *
 * Same 200 queries, same world, same shared scorer as `retrieval-core`. The
 * only variable is that `semanticScores` is supplied from the committed
 * embedding fixture, so the delta between the two baselines isolates what dense
 * retrieval does and nothing else.
 *
 * WHY IT IS A SEPARATE LANE AND NOT A CHANGE TO retrieval-core
 * -----------------------------------------------------------
 * Nothing in production supplies `semanticScores` yet — `chat.js` passes null
 * at the Context Engine seam (E7/PR-1) and the PIC floor is never handed a map.
 * `retrieval-core` therefore describes what ships, and folding dense into it
 * would make the committed baseline describe a configuration no user gets.
 * That is the same mistake `context-core` was created to undo, where the gate
 * graded a stage production overrides.
 *
 * NO RUN-TO-RUN VARIANCE, UNLIKE THE E6 HARNESS. The vectors are committed
 * static data, replayed identically every run. Two E6 shadow runs of the same
 * pinned model differed by 16 points; this suite cannot differ at all.
 *
 * SKIPPED, NOT FAILED, WITHOUT THE FIXTURE. It takes one provider run to
 * generate and is optional by design, so a checkout without it reports an
 * incomplete run rather than a wall of zeros.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedWorld, retrieveWithCurrentEngine } from '../adapters/currentRetrieval.mjs';
import { loadEmbeddingFixture, factSimilarities } from '../fixtures/embeddingFixture.mjs';
import { K, kindMap, scoreQuery, aggregate } from './retrievalScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const OWNER = 'user:eval-retrieval-dense';

const KIND_OF = kindMap(DS.corpus);

let seeded = false;
let fixture;

export default {
  id: 'retrieval-dense',
  title: 'retrieval quality WITH the dense lane — E7',
  about: [
    'Drives pic/core retrieveKnowledge over the same 60-fact world and 200 labelled',
    'queries as retrieval-core, with semanticScores supplied from the committed',
    'embedding fixture (keyed by evidence-store fact id). Reports the same metrics',
    'through the same shared scorer, so the delta against retrieval-core.v1 isolates',
    'the dense lane. Production supplies no scores today, so retrieval-core remains',
    'the description of what ships.',
  ].join('\n'),

  cases: DS.queries,

  async run(testCase) {
    if (fixture === undefined) fixture = loadEmbeddingFixture({ dataset: DS });
    if (!fixture) {
      return { status: 'skipped', reason: 'no embedding fixture — run scripts/build-embedding-fixture.mjs' };
    }
    if (!seeded) { await seedWorld(OWNER, DS.corpus); seeded = true; }
    const semanticScores = factSimilarities(testCase.id, fixture);
    const r = await retrieveWithCurrentEngine(OWNER, testCase.q, { limit: K, semanticScores });
    return { status: 'ok', actual: { ranked: r.ranked } };
  },

  score(testCase, actual) {
    return scoreQuery(testCase, actual.ranked, KIND_OF);
  },

  metrics(scored) {
    return aggregate(scored);
  },
};
