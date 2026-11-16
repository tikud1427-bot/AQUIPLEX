/**
 * ACIB v2 development set with the hybrid context on (AQUA_HYBRID_CONTEXT=on, scoped to each scenario run).
 * Sprint 6. Not an independent evaluation — see AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md.
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-v2-dev-hybrid',
  title: 'ACIB v2 development set with the hybrid context on',
  datasetFile: 'acib.v2.dev.json',
  frozenFile: 'acib.v2.dev.FROZEN.sha256',
  env: { AQUA_HYBRID_CONTEXT: 'on' },
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
