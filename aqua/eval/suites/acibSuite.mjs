/**
 * ACIB suite factory (2026-11-10, Sprint 3). One definition of how an ACIB
 * dataset is run and scored, shared by:
 *
 *   acib-v1                 dev set,      production defaults (ARM A — the frozen Sprint 2 baseline)
 *   acib-v1-needs           dev set,      AQUA_INFO_NEEDS=on   (ARM B)
 *   acib-heldout-v1         held-out set, production defaults  (ARM A)
 *   acib-heldout-v1-needs   held-out set, AQUA_INFO_NEEDS=on   (ARM B)
 *
 * `env` is applied only while each scenario runs (eval/adapters/acibPipeline.mjs)
 * and restored afterwards, so other suites in the same gate process are
 * unaffected. The dataset and the scorer are shared and unchanged: an arm
 * differs from another ONLY by the pipeline configuration.
 *
 * Not a suite itself (the runner loads *.suite.mjs only).
 */
import '../core/isolateDataDir.mjs';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, nonDefaultGates, closeAcib } from '../adapters/acibPipeline.mjs';
import { armItems, scoreArm, scorePlanner, aggregate, ARMS } from './acibScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BENCHMARK_VERSION = 'acib-1.0.0';

/** sha256 of a dataset with line endings normalised (a checkout's CRLF is not a change). */
export function datasetHash(text) {
  return crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');
}

export function makeAcibSuite({ id, title, datasetFile, frozenFile, env = {}, about }) {
  const RAW = readFileSync(path.join(HERE, '../datasets', datasetFile), 'utf8');
  const DS = JSON.parse(RAW);
  const HASH = datasetHash(RAW);
  let FROZEN = null;
  try { FROZEN = readFileSync(path.join(HERE, '../datasets', frozenFile), 'utf8').trim().split(/\s+/)[0]; } catch { /* absent → refuse */ }
  const DATASET = { id: DS.id, version: DS.version, file: datasetFile, sha256: HASH, frozen: FROZEN, intact: FROZEN === HASH };
  const BY_ID = new Map(DS.scenarios.map(s => [s.id, s]));
  const REGIMES = ['short', 'long'];
  let remaining = DS.scenarios.length * REGIMES.length;

  const suite = {
    id,
    title,
    about: about ?? `ACIB over ${datasetFile} (${DS.scenarios.length} scenarios × short/long), pipeline env ${JSON.stringify(env)}. Shared scorer eval/suites/acibScoring.mjs.`,
    cases: DS.scenarios.flatMap(s => REGIMES.map(regime => ({ id: `${s.id}@${regime}`, scenarioId: s.id, regime }))),

    async run(testCase) {
      try {
        if (!DATASET.intact) {
          return { status: 'skipped', reason: `dataset ${datasetFile} changed (sha256 ${HASH.slice(0, 12)}…, frozen ${String(FROZEN).slice(0, 12)}…) — a dataset edit is a reviewed change; see AQUA_ACIB_V1_IMPLEMENTATION.md §7` };
        }
        const overrides = await nonDefaultGates();
        if (overrides.length) {
          return { status: 'skipped', reason: `non-default flag configuration in the process (${overrides.join(', ')}) — an arm's configuration comes only from its suite` };
        }
        const scenario = BY_ID.get(testCase.scenarioId);
        const userId = `${id}-${testCase.scenarioId}-${testCase.regime}`;
        const r = await runScenario(scenario, { regime: testCase.regime, filler: DS.filler, fillerTargetChars: DS.fillerTargetChars, userId, env });
        return { status: 'ok', actual: { ...r, items: armItems(r.blocks) } };
      } finally {
        if (--remaining <= 0) closeAcib();
      }
    },

    score(testCase, actual) {
      const scenario = BY_ID.get(testCase.scenarioId);
      const arms = Object.fromEntries(ARMS.map(a => [a, scoreArm(scenario, actual.items[a])]));
      const p = arms.production;
      const leaks = (p.forgotten_leaks ?? 0) + (p.failed_turn_leaks ?? 0) + (p.cross_entity_violations ?? 0) + (p.stale_as_current ?? 0);
      return {
        // "Correct" = the production context holds every required need and leaks nothing it must not.
        correct: (p.context_recall ?? 1) === 1 && leaks === 0,
        regime: testCase.regime,
        critical: !!scenario.critical,
        arms,
        planner: scorePlanner(scenario, actual.planner),
        networkBlocked: actual.networkBlocked,
        taskType: actual.taskType,
        confidence: actual.confidence,
        readMode: actual.readMode,
        promptTokens: actual.promptTokens,
        questionMs: actual.questionMs,
        infoNeeds: actual.infoNeeds ?? null,
        hybridTokens: actual.hybridTokens ?? 0,
        plannerSlots: actual.planner.slots,
        // Reproducibility record: what was expected and what the model was actually given.
        expected: {
          needs: (scenario.needs ?? []).map(n => ({ id: n.id, required: !!n.required, match: n.match, evidence: n.evidence })),
          distractors: (scenario.distractors ?? []).map(d => d.id),
          unknowns: (scenario.unknowns ?? []).map(u => u.id),
        },
        retrieved: actual.items.production.map(i => ({ lane: i.lane, structured: i.structured, text: i.text })),
      };
    },

    metrics(scored) {
      return aggregate(scored);
    },
  };
  return { suite, DATASET, env };
}
