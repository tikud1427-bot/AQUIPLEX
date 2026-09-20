/**
 * AQUIPLEX Eval — World-Model Lift experiment (research / non-gated)
 *
 * This is deliberately NOT a single "winner" score. It runs the same labelled
 * world and questions through three context conditions:
 *
 *   stateless   — no retrieved personal context
 *   memory      — the existing PIC retrieval floor
 *   world_model — the production Context Engine path
 *
 * The experiment measures whether canonical World-Model context changes the
 * evidence available to the answering layer. It is a precursor to the full
 * answer-quality experiment, where the same generated answer model must be
 * evaluated under each context condition.
 *
 * No baseline file is committed for this suite: it is diagnostic evidence, not
 * a regression gate. The report keeps all three conditions side-by-side and
 * does not collapse them into a ranking or composite score.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedWorld } from '../adapters/currentRetrieval.mjs';
import { retrieveWithContextEngine } from '../adapters/contextEngineRetrieval.mjs';
import { K, kindMap, scoreQuery, aggregate } from './retrievalScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const KIND_OF = kindMap(DS.corpus);

const OWNERS = Object.freeze({
  memory: 'user:eval-world-model-lift-memory',
  worldModel: 'user:eval-world-model-lift-world-model',
});

let seeded = false;

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
    'existing memory retrieval, and the canonical World-Model Context Engine.',
    'Reports each condition independently so the experiment measures evidence',
    'lift without inventing a composite score or declaring a winner. This is',
    'non-gated research instrumentation until answer-quality evaluation is wired',
    'to the same generated-answer model under all three conditions.',
  ].join(' '),

  cases: DS.queries,

  async run(testCase) {
    await seedOnce();

    const stateless = { ranked: [] };

    // Existing memory/retrieval floor. This is the closest deterministic proxy
    // for "memory-only" without introducing a new policy into the experiment.
    const { pic } = await import('../../src/pic/core.js');
    const memoryResult = pic.retrieveKnowledge(OWNERS.memory, testCase.q, {
      limit: K,
      semanticScores: null,
    });
    const memory = {
      ranked: (memoryResult?.items ?? [])
        .filter(it => it.kind === 'fact' || it.kind === undefined)
        .map(it => it.factId ?? it.id ?? null)
        .filter(Boolean)
        .map(id => String(id).replace(/^fact:/, '')),
    };

    const wmResult = await retrieveWithContextEngine(OWNERS.worldModel, testCase.q, {
      limit: K,
    });
    const worldModel = { ranked: wmResult.ranked };

    return {
      status: 'ok',
      actual: { stateless, memory, worldModel },
    };
  },

  score(testCase, actual) {
    const stateless = scoreMode(testCase, actual.stateless.ranked);
    const memory = scoreMode(testCase, actual.memory.ranked);
    const worldModel = scoreMode(testCase, actual.worldModel.ranked);

    // Runner compatibility requires one boolean. It is intentionally the
    // World-Model condition only; all three condition scores remain in detail
    // and aggregate below. This boolean is NOT used as a gate.
    return {
      correct: worldModel.correct,
      conditions: { stateless, memory, worldModel },
    };
  },

  metrics(scored) {
    const modes = ['stateless', 'memory', 'worldModel'];
    const out = {};
    for (const mode of modes) {
      out[mode] = aggregate(scored.map(row => row.conditions[mode]));
    }

    // Explicit deltas against the memory floor. These are diagnostic deltas,
    // not a ranking. Positive/negative direction is left to the reader.
    const keys = ['recall_at_8', 'mrr', 'ndcg_at_8', 'top1_correct', 'top1_kind', 'unknown_honesty'];
    out.worldModelDeltaVsMemory = Object.fromEntries(
      keys.filter(k => Number.isFinite(out.worldModel[k]) && Number.isFinite(out.memory[k]))
        .map(k => [k, Number((out.worldModel[k] - out.memory[k]).toFixed(4))]),
    );
    return out;
  },
};
