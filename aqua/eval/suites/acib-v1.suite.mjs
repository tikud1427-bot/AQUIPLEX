/**
 * ACIB v1 — ARM A on the dev set: the production pipeline at code defaults
 * (the frozen Sprint 2 baseline, eval/baselines/acib-v1.v1.json).
 * Definition: ./acibSuite.mjs · method: AQUA_ACIB_V1_IMPLEMENTATION.md
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-v1',
  title: 'ACIB v1 — does the production context contain what each question needs, and only that?',
  datasetFile: 'acib.v1.json',
  frozenFile: 'acib.v1.FROZEN.sha256',
  about: [
    'Context-level benchmark over 17 synthetic users (16 required categories + the critical hiring decision),',
    'each in a short and a long (past the recall window) history. Writes every message through the production',
    'write path and reads the production read path at code defaults without Postgres. Reports precision, recall,',
    'evidence coverage, temporal accuracy, contradiction and unknown handling, cross-entity accuracy and',
    'efficiency per lane, plus the question planner\'s need coverage (plan only).',
  ].join(' '),
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
