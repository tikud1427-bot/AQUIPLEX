/**
 * ACIB v2 DEVELOPMENT set — information-needs engine on (ARM B).
 * Development set: used to build Information Needs V2. See AQUA_ACIB_V2_BENCHMARK.md.
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-v2-dev-needs',
  title: 'ACIB v2 development set — information-needs engine on (ARM B)',
  datasetFile: 'acib.v2.dev.json',
  frozenFile: 'acib.v2.dev.FROZEN.sha256',
  env: { AQUA_INFO_NEEDS: 'on' },
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
