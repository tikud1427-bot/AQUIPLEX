/**
 * AQUIPLEX — World-Model Lift experiment
 *
 * This is deliberately a COMPARATIVE experiment, not a quality gate.
 * It compares the production Context Engine (world-model lane) against the
 * production floor retrieval on the SAME seeded world, SAME queries and SAME
 * scorer. A positive delta is evidence of retrieval/context lift; it is NOT
 * evidence that the full chat response is better.
 *
 * Blueprint thesis: accumulated understanding should improve assistance.
 * This first instrument measures the retrieval half of that thesis while
 * keeping the full end-to-end claim explicitly out of scope.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedWorld, retrieveWithCurrentEngine as retrieveFloor } from '../adapters/currentRetrieval.mjs';
import { retrieveWithContextEngine } from '../adapters/contextEngineRetrieval.mjs';
import { K, kindMap, scoreQuery, aggregate } from './retrievalScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const OWNER = 'user:eval-world-model-lift';
const KIND_OF = kindMap(DS.corpus);
let seeded = false;

export default {
  id: 'world-model-lift',
  title: 'World-Model Lift — production context vs retrieval floor',
  about: [
    'Same 60-fact world, same 200 queries and same scorer as retrieval-core.',
    'The treatment is Brain.assembleContext / Context Engine; the control is the',
    'production floor retrieval supplied to it. This isolates whether the world-model',
    'context stage changes what evidence is selected. It does not claim end-to-end',
    'answer quality, reduced re-explanation or planning lift.',
  ].join('\n'),

  cases: DS.queries,

  async run(testCase) {
    if (!seeded) {
      await seedWorld(OWNER, DS.corpus);
      seeded = true;
    }

    const [floor, worldModel] = await Promise.all([
      retrieveFloor(OWNER, testCase.q, { limit: K }),
      retrieveWithContextEngine(OWNER, testCase.q, { limit: K }),
    ]);

    return {
      status: 'ok',
      actual: {
        floor: floor.ranked,
        worldModel: worldModel.ranked,
      },
    };
  },

  score(testCase, actual) {
    const floor = scoreQuery(testCase, actual.floor, KIND_OF);
    const worldModel = scoreQuery(testCase, actual.worldModel, KIND_OF);
    return { correct: worldModel.correct, cat: testCase.cat, floor, worldModel };
  },

  metrics(scored) {
    const floor = aggregate(scored.map(x => x.floor));
    const worldModel = aggregate(scored.map(x => x.worldModel));

    const delta = {};
    for (const [key, value] of Object.entries(worldModel)) {
      if (typeof value === 'number' && typeof floor[key] === 'number') {
        delta[key] = Number((value - floor[key]).toFixed(6));
      }
    }

    const cats = [...new Set(scored.map(x => x.case?.cat ?? x.cat ?? null).filter(Boolean))];
    const byCategory = {};
    for (const cat of cats) {
      const rows = scored.filter(x => (x.cat) === cat);
      const f = aggregate(rows.map(x => x.floor));
      const w = aggregate(rows.map(x => x.worldModel));
      byCategory[cat] = {
        n: rows.length,
        floor: f,
        worldModel: w,
        delta: Object.fromEntries(Object.keys(w)
          .filter(k => typeof w[k] === 'number' && typeof f[k] === 'number')
          .map(k => [k, Number((w[k] - f[k]).toFixed(6))])),
      };
    }

    return { floor, worldModel, delta, byCategory };
  },
};
