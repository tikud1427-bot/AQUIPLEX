/**
 * AQUIPLEX Eval — World-Model Lift experiment (research / non-gated)
 *
 * This is deliberately NOT a single "winner" score. It runs the same labelled
 * world and questions through four context conditions:
 *
 *   stateless        — no retrieved personal context
 *   memory           — the existing PIC retrieval floor
 *   worldModel       — the Context Engine path without dense semantic scores
 *   worldModelDense  — the Context Engine path with the E7 dense lane
 *
 * The experiment measures how canonical World-Model context and the E7 dense
 * retrieval lane change the evidence available to the answering layer.
 *
 * The worldModelDense condition uses the committed deterministic embedding
 * fixture as the test stand-in for production semanticScores. No provider
 * call is made by this suite.
 *
 * No baseline file is committed for this suite: it is diagnostic evidence, not
 * a regression gate. The report keeps all conditions side-by-side and does not
 * collapse them into a ranking or composite score.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedWorld, retrieveWithCurrentEngine } from '../adapters/currentRetrieval.mjs';
import { retrieveWithContextEngine } from '../adapters/contextEngineRetrieval.mjs';
import { loadEmbeddingFixture, factSimilarities } from '../fixtures/embeddingFixture.mjs';
import { K, kindMap, scoreQuery, aggregate } from './retrievalScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(
  readFileSync(
    path.join(HERE, '../datasets/retrieval-core.v1.json'),
    'utf8',
  ),
);
const KIND_OF = kindMap(DS.corpus);

const OWNERS = Object.freeze({
  memory: 'user:eval-world-model-lift-memory',
  worldModel: 'user:eval-world-model-lift-world-model',
});

let seeded = false;
let fixture;

async function seedOnce() {
  if (seeded) return;

  await seedWorld(OWNERS.memory, DS.corpus);
  await seedWorld(OWNERS.worldModel, DS.corpus);

  seeded = true;
}

function scoreMode(testCase, ranked) {
  return scoreQuery(testCase, ranked, KIND_OF);
}

export default {
  id: 'world-model-lift',

  title: 'World-Model Lift — context conditions on identical labelled queries',

  about: [
    'Runs the same 60-fact world and 200 labelled questions through stateless,',
    'existing memory retrieval, the canonical World-Model Context Engine without',
    'dense semantic scores, and the same Context Engine with the E7 dense lane.',
    'Reports each condition independently so the experiment measures evidence',
    'lift without inventing a composite score or declaring a winner. The dense',
    'condition uses the committed embedding fixture as a deterministic stand-in',
    'for production semanticScores. This is non-gated research instrumentation',
    'until answer-quality evaluation is wired to the same generated-answer model',
    'under all conditions.',
  ].join(' '),

  cases: DS.queries,

  async run(testCase) {
    await seedOnce();

    const stateless = { ranked: [] };

    // Existing memory/retrieval floor. This is the closest deterministic proxy
    // for "memory-only" without introducing a new policy into the experiment.
    const memoryResult = await retrieveWithCurrentEngine(
      OWNERS.memory,
      testCase.q,
      {
        limit: K,
        semanticScores: null,
      },
    );

    const memory = {
      ranked: memoryResult.ranked,
    };

    // Canonical Context Engine without semantic scores / Retrieval V3.
    // This preserves the original World-Model condition.
    const wmResult = await retrieveWithContextEngine(
      OWNERS.worldModel,
      testCase.q,
      {
        limit: K,
      },
    );

    const worldModel = {
      ranked: wmResult.ranked,
    };

    // E7 + Context Engine condition.
    //
    // The committed embedding fixture is deterministic and keyed by the same
    // evidence-store fact ids used by the retrieval pool. This is deliberately
    // separate from `worldModel` so the experiment can distinguish Context
    // Engine effects from the additional E7 dense retrieval effect.
    if (fixture === undefined) {
      fixture = loadEmbeddingFixture({ dataset: DS });
    }

    let worldModelDense = { ranked: [] };

    if (fixture) {
      const semanticScores = factSimilarities(testCase.id, fixture);

      const denseResult = await retrieveWithContextEngine(
        OWNERS.worldModel,
        testCase.q,
        {
          limit: K,
          semanticScores,
          retrievalV3: true,
        },
      );

      worldModelDense = {
        ranked: denseResult.ranked,
      };
    }

    return {
      status: 'ok',
      actual: {
        stateless,
        memory,
        worldModel,
        worldModelDense,
      },
    };
  },

  score(testCase, actual) {
    const stateless = scoreMode(
      testCase,
      actual.stateless.ranked,
    );

    const memory = scoreMode(
      testCase,
      actual.memory.ranked,
    );

    const worldModel = scoreMode(
      testCase,
      actual.worldModel.ranked,
    );

    const worldModelDense = scoreMode(
      testCase,
      actual.worldModelDense.ranked,
    );

    // Runner compatibility requires one boolean. It is intentionally tied to
    // the original World-Model condition, not the dense condition. All
    // condition scores remain in detail and are aggregated independently.
    // This boolean is NOT used as a quality gate.
    return {
      correct: worldModel.correct,
      conditions: {
        stateless,
        memory,
        worldModel,
        worldModelDense,
      },
    };
  },

  metrics(scored) {
    const modes = [
      'stateless',
      'memory',
      'worldModel',
      'worldModelDense',
    ];

    const out = {};

    for (const mode of modes) {
      out[mode] = aggregate(
        scored.map(row => row.conditions[mode]),
      );
    }

    const keys = [
      'recall_at_8',
      'mrr',
      'ndcg_at_8',
      'top1_correct',
      'top1_kind',
      'unknown_honesty',
    ];

    // Diagnostic delta: original World-Model Context Engine vs memory floor.
    out.worldModelDeltaVsMemory = Object.fromEntries(
      keys
        .filter(
          key =>
            Number.isFinite(out.worldModel[key]) &&
            Number.isFinite(out.memory[key]),
        )
        .map(key => [
          key,
          Number(
            (
              out.worldModel[key] -
              out.memory[key]
            ).toFixed(4),
          ),
        ]),
    );

    // Diagnostic delta: E7 dense Context Engine vs the original Context
    // Engine condition. This isolates the dense retrieval contribution.
    out.worldModelDenseDeltaVsWorldModel = Object.fromEntries(
      keys
        .filter(
          key =>
            Number.isFinite(out.worldModelDense[key]) &&
            Number.isFinite(out.worldModel[key]),
        )
        .map(key => [
          key,
          Number(
            (
              out.worldModelDense[key] -
              out.worldModel[key]
            ).toFixed(4),
          ),
        ]),
    );

    return out;
  },
};