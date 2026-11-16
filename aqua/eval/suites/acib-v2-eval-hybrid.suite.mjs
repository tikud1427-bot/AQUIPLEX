/**
 * ACIB v2 eval set (CONTAMINATED since Sprint 4: regression check only, never an independent result) with the hybrid context on (AQUA_HYBRID_CONTEXT=on, scoped to each scenario run).
 * Sprint 6. Not an independent evaluation — see AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md.
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-v2-eval-hybrid',
  title: 'ACIB v2 eval set (CONTAMINATED since Sprint 4: regression check only, never an independent result) with the hybrid context on',
  datasetFile: 'acib.v2.eval.json',
  frozenFile: 'acib.v2.eval.FROZEN.sha256',
  env: { AQUA_HYBRID_CONTEXT: 'on' },
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
