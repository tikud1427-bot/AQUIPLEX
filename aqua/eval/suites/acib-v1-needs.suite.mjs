/**
 * ACIB v1 — ARM B on the dev set: the same pipeline with the information-needs
 * engine on (AQUA_INFO_NEEDS=on, scoped to each scenario run). Same dataset and
 * scorer as acib-v1; the only difference is the gate.
 */
import { makeAcibSuite, BENCHMARK_VERSION } from './acibSuite.mjs';

const { suite, DATASET } = makeAcibSuite({
  id: 'acib-v1-needs',
  title: 'ACIB v1 (dev set) with the information-needs engine on',
  datasetFile: 'acib.v1.json',
  frozenFile: 'acib.v1.FROZEN.sha256',
  env: { AQUA_INFO_NEEDS: 'on' },
});
export { BENCHMARK_VERSION, DATASET };
export default suite;
