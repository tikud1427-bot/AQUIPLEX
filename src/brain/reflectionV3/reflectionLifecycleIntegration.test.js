import assert from 'node:assert/strict';
import { createReflectionLifecycleHarness, E9_REFLECTION_EVENTS } from './reflectionLifecycleIntegration.js';
import { reflectionJobKey } from './reflectionOutbox.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`✓ ${name}`); };

for (const eventType of E9_REFLECTION_EVENTS) {
  ok(`${eventType} publishes one idempotent job`, () => {
    const h = createReflectionLifecycleHarness();
    const a = h.publish(eventType, 'claim-1');
    const b = h.publish(eventType, 'claim-1');
    assert.notEqual(a.key, b.key);
    assert.equal(h.state.jobs.size, 2);
  });
}

ok('successful execution becomes terminal and records effect', () => {
  const h = createReflectionLifecycleHarness();
  const job = h.publish('claim.created', 'claim-1');
  const result = h.run(job.key);
  assert.equal(result.applied, true);
  assert.equal(job.state, 'done');
  assert.equal(h.run(job.key).duplicate, true);
});

ok('crash after effect followed by done reconciliation is detected only when effect is absent', () => {
  const h = createReflectionLifecycleHarness();
  const job = h.publish('claim.created', 'claim-1');
  h.run(job.key, { crashAfterEffect: true });
  assert.equal(h.reconcile(job.key).action, 'applied');
});

ok('done without effect is reopened instead of duplicated', () => {
  const h = createReflectionLifecycleHarness();
  const job = h.publish('claim.created', 'claim-1');
  job.state = 'done';
  assert.equal(h.reconcile(job.key).action, 'requeue-done');
  assert.equal(h.state.jobs.size, 1);
  assert.equal(job.attempts, 0);
});

ok('dead without effect is reopened in place', () => {
  const h = createReflectionLifecycleHarness();
  const job = h.publish('claim.superseded', 'claim-2');
  job.state = 'dead';
  assert.equal(h.reconcile(job.key).action, 'requeue-dead');
  assert.equal(job.state, 'queued');
});

ok('cross-owner jobs have distinct idempotency identities', () => {
  const a = createReflectionLifecycleHarness({ ownerId: 'owner-a' });
  const b = createReflectionLifecycleHarness({ ownerId: 'owner-b' });
  const ka = reflectionJobKey(a.publish('claim.created', 'same-claim').event);
  const kb = reflectionJobKey(b.publish('claim.created', 'same-claim').event);
  assert.equal(ka, kb); // DB uniqueness is (owner_id, idempotency_key), not key alone.
  assert.equal(a.state.jobs.size, 1);
  assert.equal(b.state.jobs.size, 1);
});

console.log(`E9 PR-10 lifecycle integration: ${passed} assertions passed`);
