/**
 * ACIB held-out v1 — ARM B: the information-needs engine on (AQUA_INFO_NEEDS=on,
 * scoped to each scenario run). Never tuned against: see the dataset's status.
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-heldout-v1-needs',
  title: 'ACIB held-out v1 with the information-needs engine on',
  datasetFile: 'acib.heldout.v1.json',
  frozenFile: 'acib.heldout.v1.FROZEN.sha256',
  env: { AQUA_INFO_NEEDS: 'on' },
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
