/**
 * ACIB held-out v1 (post-hoc, development) with the hybrid context on (AQUA_HYBRID_CONTEXT=on, scoped to each scenario run).
 * Sprint 6. Not an independent evaluation — see AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md.
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-heldout-v1-hybrid',
  title: 'ACIB held-out v1 (post-hoc, development) with the hybrid context on',
  datasetFile: 'acib.heldout.v1.json',
  frozenFile: 'acib.heldout.v1.FROZEN.sha256',
  env: { AQUA_HYBRID_CONTEXT: 'on' },
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
