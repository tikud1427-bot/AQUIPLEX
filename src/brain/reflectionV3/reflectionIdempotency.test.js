import assert from 'node:assert/strict';
import {
  reflectionEffectKey,
  hasReflectionEffect,
  markReflectionEffect,
} from './reflectionIdempotency.js';

const mind = { reflectionLedger: {} };
const key = reflectionEffectKey({ ownerId: 'user:a', outboxId: 42, claimId: 'c1', eventType: 'claim.created' });
assert.equal(key, 'user:a:outbox:42');
assert.equal(hasReflectionEffect(mind, key), false);
assert.equal(markReflectionEffect(mind, key, { claimId: 'c1' }), true);
assert.equal(markReflectionEffect(mind, key), false);
assert.equal(hasReflectionEffect(mind, key), true);
assert.equal(mind.reflectionLedger[key].claimId, 'c1');

const fallback = reflectionEffectKey({ ownerId: 'user:a', claimId: 'c2', eventType: 'claim.created' });
assert.equal(fallback, 'user:a:claim:c2:event:claim.created');

for (let i = 0; i < 20; i++) markReflectionEffect(mind, `user:a:test:${i}`);
assert.equal(Object.keys(mind.reflectionLedger).length, 21);
assert.equal(hasReflectionEffect(mind, key), true);

console.log('E9 PR-6 reflection idempotency: 4/4 assertions passed');
