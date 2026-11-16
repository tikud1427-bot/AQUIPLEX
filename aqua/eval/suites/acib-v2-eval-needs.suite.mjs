/**
 * ACIB v2 EVALUATION set — information-needs engine on (ARM B).
 * Frozen before Sprint 4 code changes; never tuned against. See AQUA_ACIB_V2_BENCHMARK.md.
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-v2-eval-needs',
  title: 'ACIB v2 evaluation set — information-needs engine on (ARM B)',
  datasetFile: 'acib.v2.eval.json',
  frozenFile: 'acib.v2.eval.FROZEN.sha256',
  env: { AQUA_INFO_NEEDS: 'on' },
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
