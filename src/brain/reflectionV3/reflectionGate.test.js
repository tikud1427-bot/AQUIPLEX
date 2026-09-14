import assert from 'node:assert/strict';
import { evaluateReflectionLifecycle, E9_LIFECYCLE_EVENTS } from './reflectionGate.js';

const report = evaluateReflectionLifecycle();
assert.equal(E9_LIFECYCLE_EVENTS.length, 5);
assert.equal(report.schemaVersion, 1);
assert.equal(report.total, 14);
assert.equal(report.passed, 14);
assert.equal(report.failed, 0);
assert.equal(report.passRate, 1);
assert.equal(report.complete, true);

console.log(`E9 PR-9 reflection lifecycle gate: ${report.passed}/${report.total} checks passed`);
