import assert from 'node:assert/strict';
import { reflectionEffectKey, hasReflectionEffect, markReflectionEffect, REFLECTION_LEDGER_MAX } from './reflectionIdempotency.js';

const mind = { reflectionLedger: {} };
const key = reflectionEffectKey({ ownerId: 'user:a', outboxId: 42, claimId: 'c1', eventType: 'claim.created' });
assert.equal(key, 'user:a:outbox:42');
assert.equal(markReflectionEffect(mind, key, { claimId: 'c1' }), true);
assert.equal(hasReflectionEffect(mind, key), true);
assert.equal(markReflectionEffect(mind, key), false);

for (let i = 0; i < REFLECTION_LEDGER_MAX + 20; i++) {
  markReflectionEffect(mind, `user:a:outbox:${1000 + i}`, { claimId: `c${i}` });
}
assert.equal(Object.keys(mind.reflectionLedger).length, REFLECTION_LEDGER_MAX);
assert.equal(hasReflectionEffect(mind, key), false);
console.log(`E9 bounded reflection ledger: 5/5 assertions passed (max ${REFLECTION_LEDGER_MAX})`);
