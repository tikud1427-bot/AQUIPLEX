import assert from 'node:assert/strict';
import { needsReflectionReconciliation, reconciliationDecision } from './reflectionReconciliation.js';

const cases = [
  [{ jobState:'done', hasEffect:false }, true],
  [{ jobState:'dead', hasEffect:false }, true],
  [{ jobState:'queued', hasEffect:false }, false],
  [{ jobState:'done', hasEffect:true }, false],
];
for (const [input, expected] of cases) assert.equal(needsReflectionReconciliation(input), expected);

assert.equal(reconciliationDecision({ eventType:'claim.created', jobState:'done', hasEffect:false }), 'requeue-done');
assert.equal(reconciliationDecision({ eventType:'claim.created', jobState:'dead', hasEffect:false }), 'requeue-dead');
assert.equal(reconciliationDecision({ eventType:'claim.created', jobState:'queued', hasEffect:false }), 'in-flight');
assert.equal(reconciliationDecision({ eventType:'claim.created', jobState:'done', hasEffect:true }), 'applied');
assert.equal(reconciliationDecision({ eventType:'other', jobState:'done', hasEffect:false }), 'ignore');
assert.equal(reconciliationDecision({ eventType:'claim.created', jobState:null, hasEffect:false }), 'missing-job');
console.log('reflectionReconciliation: 10/10 passed');
