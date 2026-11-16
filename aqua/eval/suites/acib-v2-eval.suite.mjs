/**
 * ACIB v2 EVALUATION set — production defaults (ARM A).
 * Frozen before Sprint 4 code changes; never tuned against. See AQUA_ACIB_V2_BENCHMARK.md.
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-v2-eval',
  title: 'ACIB v2 evaluation set — production defaults (ARM A)',
  datasetFile: 'acib.v2.eval.json',
  frozenFile: 'acib.v2.eval.FROZEN.sha256',
  env: {},
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
