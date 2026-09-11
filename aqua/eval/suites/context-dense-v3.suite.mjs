/**
 * AQUA Eval — Context Engine Retrieval V3 with dense semantic lane
 * Blueprint E7
 *
 * Same 200 labelled queries and world as retrieval-core/retrieval-dense.
 * The PIC floor receives the committed semantic fixture, then the actual
 * Context Engine runs with Retrieval V3 enabled. This measures the path that
 * production chat reads after E7 fusion, rather than measuring the floor alone.
 *
 * The fixture is deterministic and keyed by evidence-store fact id. It is a
 * test stand-in for production semanticScores; no provider call is made here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedWorld } from '../adapters/currentRetrieval.mjs';
import { retrieveWithContextEngine } from '../adapters/contextEngineRetrieval.mjs';
import { loadEmbeddingFixture, factSimilarities } from '../fixtures/embeddingFixture.mjs';
import { K, kindMap, scoreQuery, aggregate } from './retrievalScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const OWNER = 'user:eval-context-dense-v3';
const KIND_OF = kindMap(DS.corpus);

let seeded = false;
let fixture;

export default {
  id: 'context-dense-v3',
  title: 'Context Engine retrieval quality — V3 fusion with dense lane',
  about: [
    'Drives Brain.assembleContext over the same 60-fact world and 200 labelled',
    'queries as retrieval-core, with the PIC floor supplied semantic scores from',
    'the committed embedding fixture and Retrieval V3 enabled. Reports the same',
    'shared scorer so the result can be compared directly with both floor suites.',
    'This is an evaluation configuration, not a claim that production currently',
    'supplies a static fixture; production obtains semantic scores at the chat seam.',
  ].join('\\n'),

  cases: DS.queries,

  async run(testCase) {
    if (fixture === undefined) fixture = loadEmbeddingFixture({ dataset: DS });
    if (!fixture) {
      return { status: 'skipped', reason: 'no embedding fixture — run scripts/build-embedding-fixture.mjs' };
    }
    if (!seeded) { await seedWorld(OWNER, DS.corpus); seeded = true; }
    const semanticScores = factSimilarities(testCase.id, fixture);
    const r = await retrieveWithContextEngine(OWNER, testCase.q, { limit: K, semanticScores, retrievalV3: true });
    return { status: 'ok', actual: { ranked: r.ranked } };
  },

  score(testCase, actual) {
    return scoreQuery(testCase, actual.ranked, KIND_OF);
  },

  metrics(scored) {
    return aggregate(scored);
  },
};
