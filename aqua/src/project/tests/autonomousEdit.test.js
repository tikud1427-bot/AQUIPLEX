/**
 * Phase 4a — autonomous repair loop tests (offline; proposeEdit injected).
 * Run: node src/project/tests/autonomousEdit.test.js
 */
import assert from 'node:assert';
import { proposeEditWithRepair } from '../autonomousEdit.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

// Build a fake proposeEdit that returns a scripted sequence of proposals (or
// throws), and records the instruction it was called with each time so we can
// assert repair-context was fed back.
function scriptedPropose(script) {
  const calls = [];
  const fn = async ({ instruction }) => {
    calls.push(instruction);
    const step = script[calls.length - 1];
    if (step instanceof Error) throw step;
    return step;
  };
  fn.calls = calls;
  return fn;
}

const clean = (extra = {}) => ({ id: 'p', verification: { passed: true, warnings: [] }, failedOperations: [], ...extra });
const dirty = (warnings, failedOperations = []) => ({ id: 'p', verification: { passed: false, warnings }, failedOperations });

console.log('autonomousEdit — convergence');

await test('clean on first try → no repair, one call', async () => {
  const _propose = scriptedPropose([clean()]);
  const out = await proposeEditWithRepair({ workspaceId: 'w', instruction: 'do X', _propose });
  assert.equal(out.ok, true);
  assert.equal(out.converged, true);
  assert.equal(out.repaired, false);
  assert.equal(out.attemptCount, 1);
  assert.equal(_propose.calls.length, 1, 'only one model call when first attempt is clean');
});

await test('fails once then passes → repaired:true, two calls, converged', async () => {
  const _propose = scriptedPropose([
    dirty(['dispatcher.js: unbalanced brackets — likely syntax error']),
    clean(),
  ]);
  const out = await proposeEditWithRepair({ workspaceId: 'w', instruction: 'do X', _propose });
  assert.equal(out.converged, true);
  assert.equal(out.repaired, true);
  assert.equal(out.attemptCount, 2);
  assert.equal(out.attempts[0].passed, false);
  assert.equal(out.attempts[1].passed, true);
});

await test('repair instruction carries the SPECIFIC verification failure back', async () => {
  const _propose = scriptedPropose([
    dirty(['foo.js imports missing local module(s): ./bar.js']),
    clean(),
  ]);
  await proposeEditWithRepair({ workspaceId: 'w', instruction: 'add a bar import', _propose });
  const repairInstruction = _propose.calls[1];
  assert.ok(repairInstruction.includes('add a bar import'), 'keeps the original instruction');
  assert.ok(repairInstruction.includes('did not pass verification'), 'frames it as a repair');
  assert.ok(repairInstruction.includes('missing local module(s): ./bar.js'), 'includes the exact failure');
  assert.ok(/keep brackets balanced/i.test(repairInstruction), 'includes the correction requirements');
});

await test('failedOperations are fed back as repair context', async () => {
  const _propose = scriptedPropose([
    dirty([], [{ file: 'a.js', error: 'search snippet not found', suggestion: 'snippet drifted' }]),
    clean(),
  ]);
  await proposeEditWithRepair({ workspaceId: 'w', instruction: 'edit a.js', _propose });
  assert.ok(_propose.calls[1].includes('a.js: search snippet not found'), 'failed op surfaced');
  assert.ok(_propose.calls[1].includes('snippet drifted'), 'suggestion surfaced');
});

console.log('autonomousEdit — exhaustion returns best');

await test('never converges → returns last proposal, converged:false, attemptCount=maxAttempts', async () => {
  const _propose = scriptedPropose([
    dirty(['w1']), dirty(['w2']), dirty(['w3']),
  ]);
  const out = await proposeEditWithRepair({ workspaceId: 'w', instruction: 'do X', maxAttempts: 3, _propose });
  assert.equal(out.ok, true, 'still returns a usable proposal');
  assert.equal(out.converged, false);
  assert.equal(out.attemptCount, 3);
  assert.equal(_propose.calls.length, 3, 'stops at the attempt budget');
  assert.equal(out.proposal.verification.warnings[0], 'w3', 'best = last attempt');
});

console.log('autonomousEdit — error handling');

await test('structural error on first attempt → rethrown (unrepairable)', async () => {
  const _propose = scriptedPropose([Object.assign(new Error('no targets'), { code: 'NO_TARGETS' })]);
  await assert.rejects(
    () => proposeEditWithRepair({ workspaceId: 'w', instruction: 'do X', _propose }),
    /no targets/,
  );
  assert.equal(_propose.calls.length, 1, 'no retry on a structural error');
});

await test('repairable error (BAD_EDIT_PLAN) → retried with feedback, then passes', async () => {
  const _propose = scriptedPropose([
    Object.assign(new Error('unparseable plan'), { code: 'BAD_EDIT_PLAN' }),
    clean(),
  ]);
  const out = await proposeEditWithRepair({ workspaceId: 'w', instruction: 'do X', _propose });
  assert.equal(out.converged, true);
  assert.equal(out.attemptCount, 2);
  assert.ok(_propose.calls[1].includes('could not be applied: unparseable plan'), 'error fed back');
});

await test('all attempts throw repairable → ok:false, no proposal, attempts recorded', async () => {
  const _propose = scriptedPropose([
    Object.assign(new Error('e1'), { code: 'ALL_OPS_FAILED' }),
    Object.assign(new Error('e2'), { code: 'ALL_OPS_FAILED' }),
  ]);
  const out = await proposeEditWithRepair({ workspaceId: 'w', instruction: 'do X', maxAttempts: 2, _propose });
  assert.equal(out.ok, false);
  assert.equal(out.proposal, null);
  assert.equal(out.attempts.length, 2);
  assert.ok(out.attempts.every(a => a.error));
});

console.log(`\nautonomousEdit: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
