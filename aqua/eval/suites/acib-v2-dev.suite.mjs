/**
 * ACIB v2 DEVELOPMENT set — production defaults (ARM A).
 * Development set: used to build Information Needs V2. See AQUA_ACIB_V2_BENCHMARK.md.
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-v2-dev',
  title: 'ACIB v2 development set — production defaults (ARM A)',
  datasetFile: 'acib.v2.dev.json',
  frozenFile: 'acib.v2.dev.FROZEN.sha256',
  env: {},
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
