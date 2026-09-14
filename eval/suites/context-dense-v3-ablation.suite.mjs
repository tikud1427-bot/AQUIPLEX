/**
 * AQUIPLEX Eval — Context Engine V3 lane ablation (E7/PR-7)
 *
 * Same 60-fact world, same 200 labelled queries, same semantic fixture and
 * shared scorer. Each query is run through the same Context Engine five times,
 * with the candidate pool restricted to one lane/configuration:
 *
 *   all            lexical + dense + graph + structured + other existing lanes
 *   lexical        lexical candidates only
 *   dense          dense candidates only
 *   graph          graph candidates only
 *   lexical+dense  lexical OR dense candidates
 *   lexical+graph  lexical OR graph candidates
 *   dense+graph    dense OR graph candidates
 *   lexical+dense+graph  all three explicit retrieval lanes
 *   structured           polarity/structured floor candidates
 *   entity               entity candidates
 *   timeline             event/timeline candidates
 *   plus selected combinations to expose the production-shaped residual
 *
 * This is a candidate-pool ablation, not merely an RRF vote ablation. The
 * engine is therefore measured with the lane actually removed from the pool.
 * `all` is the production-shaped V3 configuration for this fixture.
 *
 * V6 explicitly tests the remaining provenance lanes that the Context Engine
 * already labels (`structured`, `entity`, `timeline`). Self-anchor is still
 * not treated as an independent lane because it is graph-originated in this
 * implementation. The purpose is to account for the residual gap between the
 * explicit lexical+dense+graph configuration and `all`, not to invent a new
 * retrieval implementation.
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
const KIND_OF = kindMap(DS.corpus);

// E7/PR-7 full lane-contribution matrix.
// Keep `all` as the production-shaped reference, then compare every
// implemented retrieval lane and pairwise/triple combination that can
// actually be isolated by the Context Engine candidate-pool contract.
const MODES = [
  ['all', null],
  ['lexical', ['lexical']],
  ['dense', ['dense']],
  ['graph', ['graph']],
  ['structured', ['structured']],
  ['entity', ['entity']],
  ['timeline', ['timeline']],
  ['lexical+dense', ['lexical', 'dense']],
  ['lexical+graph', ['lexical', 'graph']],
  ['dense+graph', ['dense', 'graph']],
  ['lexical+dense+graph', ['lexical', 'dense', 'graph']],
  ['lexical+dense+graph+structured', ['lexical', 'dense', 'graph', 'structured']],
  ['lexical+structured', ['lexical', 'structured']],
  ['lexical+entity', ['lexical', 'entity']],
  ['lexical+timeline', ['lexical', 'timeline']],
  ['lexical+dense+graph+structured+entity+timeline', ['lexical', 'dense', 'graph', 'structured', 'entity', 'timeline']],
];

let fixture;
const seeded = new Set();

async function runMode(testCase, mode, lanes) {
  const owner = `user:eval-context-dense-v3-ablation:${mode}`;
  if (!seeded.has(owner)) {
    await seedWorld(owner, DS.corpus);
    seeded.add(owner);
  }
  const semanticScores = (lanes === null || (Array.isArray(lanes) && lanes.includes('dense')))
    ? factSimilarities(testCase.id, fixture)
    : null;
  const r = await retrieveWithContextEngine(owner, testCase.q, {
    limit: K,
    semanticScores,
    retrievalV3: true,
    retrievalV3Lanes: lanes,
  });
  return scoreQuery(testCase, r.ranked, KIND_OF);
}

export default {
  id: 'context-dense-v3-ablation',
  title: 'Context Engine V3 — retrieval lane ablation',
  about: [
    'Runs the same 200 labelled queries through the same Context Engine and',
    'world, changing only the allowed retrieval candidate lanes. Reports one',
    'metric block per configuration so lane contribution is measured rather',
    'than assumed.',
  ].join('\n'),
  cases: DS.queries,

  async run(testCase) {
    if (fixture === undefined) fixture = loadEmbeddingFixture({ dataset: DS });
    if (!fixture) return { status: 'skipped', reason: 'no embedding fixture — run scripts/build-embedding-fixture.mjs' };

    const modes = {};
    for (const [name, lanes] of MODES) {
      modes[name] = await runMode(testCase, name, lanes);
    }
    return { status: 'ok', actual: modes };
  },

  score(testCase, actual) {
    // Runner contract requires one top-level boolean. The ablation metrics use
    // the full per-mode object; `all` is the production-shaped correctness
    // signal used only for harness completeness.
    return { correct: !!actual.all.correct, ...actual };
  },

  metrics(scored) {
    const out = {};
    for (const [name] of MODES) {
      out[name] = aggregate(scored.map(s => s[name]));
    }
    return out;
  },
};
