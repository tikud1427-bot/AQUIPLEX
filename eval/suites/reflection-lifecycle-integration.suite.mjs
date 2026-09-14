/**
 * E9 / PR-10 — dependency-free lifecycle integration gate.
 * Exercises the same contract as the focused test so CI can invoke it directly.
 */
import { createReflectionLifecycleHarness, E9_REFLECTION_EVENTS } from '../../src/brain/reflectionV3/reflectionLifecycleIntegration.js';

const h = createReflectionLifecycleHarness({ ownerId: 'eval-owner' });
for (const eventType of E9_REFLECTION_EVENTS) {
  const job = h.publish(eventType, `claim-${eventType}`);
  h.run(job.key);
  if (h.state.jobs.get(job.key).state !== 'done') throw new Error(`${eventType} did not complete`);
}
console.log(JSON.stringify({
  suite: 'e9-reflection-lifecycle-integration',
  events: E9_REFLECTION_EVENTS.length,
  jobs: h.state.jobs.size,
  effects: h.state.effects.size,
  pass: h.state.jobs.size === E9_REFLECTION_EVENTS.length && h.state.effects.size === E9_REFLECTION_EVENTS.length,
}, null, 2));
