/**
 * ACIB held-out v1 — ARM A: production defaults on the held-out set
 * (authored and frozen before the information-needs engine existed).
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-heldout-v1',
  title: 'ACIB held-out v1 — production defaults',
  datasetFile: 'acib.heldout.v1.json',
  frozenFile: 'acib.heldout.v1.FROZEN.sha256',
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
