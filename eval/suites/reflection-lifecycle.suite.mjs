/**
 * AQUIPLEX Eval — E9 reflection lifecycle gate.
 *
 * Pure policy gate. It is deliberately separate from DB integration tests:
 * this suite must remain runnable in CI without a live PostgreSQL instance.
 */
import { evaluateReflectionLifecycle } from '../../src/brain/reflectionV3/reflectionGate.js';

export default {
  id: 'reflection-lifecycle',
  title: 'E9 — claim reflection lifecycle integrity',
  about: 'Checks deterministic lifecycle mapping, owner isolation, idempotency-key stability, recovery decisions, and refusal of unsupported events.',
  cases: [{ id: 'e9-policy', expected: true }],

  async run() {
    const report = evaluateReflectionLifecycle();
    return { status: 'ok', actual: report };
  },

  score(testCase, actual) {
    return { correct: actual.complete === testCase.expected, passRate: actual.passRate, passed: actual.passed, total: actual.total };
  },

  metrics(scored) {
    const s = scored[0];
    return { lifecycle_gate: s?.passRate ?? 0, checks_passed: s?.passed ?? 0, checks_total: s?.total ?? 0 };
  },
};
