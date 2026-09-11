/**
 * Artifact engine — full-pipeline integration, OFFLINE. The injected
 * `generate` stub plays the provider router: first call returns the plan
 * JSON, subsequent calls return per-file content. Asserts the real seams:
 * event ordering, store side effects, fallback error classes, abort
 * behavior, and the detector→registry gate.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-artifact-engine-'));
process.env.AQUA_ARTIFACTS_DIR = TMP;

const store  = await import('../artifactStore.js');
const engine = await import('../engine.js');
const { getAgent } = await import('../../intelligence/agentRegistry.js');

before(() => store._resetForTests());
after(() => {
  store._resetForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const PLAN_JSON = JSON.stringify({
  format: 'md',
  title: 'Meeting Notes',
  intentSummary: 'Summarize the meeting as markdown',
  files: [
    { path: 'notes.md',  role: 'primary', description: 'the meeting notes' },
    { path: 'todos.md',  role: 'doc',     description: 'action items' },
  ],
  packaging: 'auto',
  structure: { sections: ['Summary', 'Decisions', 'Action Items'] },
});

/** Stub generate: 1st call → plan JSON; later calls → file content. */
function makeGenerate({ planText = PLAN_JSON, fileText = null, failPlanTimes = 0 } = {}) {
  let calls = 0;
  let planFails = failPlanTimes;
  const fn = async (userMessage, systemPrompt) => {
    calls += 1;
    fn.calls = calls;
    const isPlanCall = systemPrompt.includes('Artifact Planner');
    if (isPlanCall) {
      if (planFails > 0) { planFails -= 1; return { text: 'sorry, no json here', provider: 'stub' }; }
      return { text: '```json\n' + planText + '\n```', provider: 'stub' }; // fences on purpose — extractJson must strip
    }
    const m = systemPrompt.match(/ONE file: "([^"]+)"/);
    return { text: fileText ?? `# ${m?.[1] ?? 'file'}\n\ngenerated content`, provider: 'stub-builder' };
  };
  fn.calls = 0;
  return fn;
}

const baseArgs = (over = {}) => ({
  userMessage: 'Write my meeting notes as a markdown file',
  prep: { relevantFacts: ['User works at Aquiplex'], attachments: [], projectFiles: [] },
  intent: { wants: true, format: 'md', confidence: 0.95 },
  ownerId: 'user:u1', conversationId: 'conv-1', workspaceId: null, requestId: 'req-e1',
  ...over,
});

test('happy path: plan → build → store, events in order, manifest public', async () => {
  const events = [];
  const res = await engine.execute(baseArgs({
    generate: makeGenerate(),
    onEvent: (ev) => events.push(ev),
  }));

  // Result shape
  assert.equal(res.manifest.format, 'md');
  assert.equal(res.manifest.files.length, 2);
  assert.equal(res.manifest.packaging, 'zip'); // auto + 2 files
  assert.ok(res.manifest.downloadUrl.endsWith(`/artifacts/${res.manifest.id}/download`));
  assert.ok(!('spec' in res.manifest), 'public manifest must not leak the spec');
  assert.match(res.summaryText, /Meeting Notes/);
  assert.deepEqual(res.providers.sort(), ['stub', 'stub-builder']);

  // Event ordering: plan stage → plan → build stage → 2 progress → validate → store → artifact
  const kinds = events.map(e => e.type === 'stage' ? `stage:${e.id}` : e.type);
  assert.deepEqual(kinds, [
    'stage:artifact_plan', 'plan',
    'stage:artifact_build', 'progress', 'progress',
    'stage:artifact_validate', 'stage:artifact_store',
    'artifact',
  ]);
  assert.equal(events.find(e => e.type === 'plan').plan.files.length, 2);

  // Store side effects
  const onDisk = await store.getArtifact(res.manifest.id);
  assert.equal(onDisk.spec.title, 'Meeting Notes');
  assert.ok(fs.existsSync(store.getFileAbsolutePath(onDisk, 'notes.md')));
});

test('planner repair: one bad reply then a good one still succeeds', async () => {
  const gen = makeGenerate({ failPlanTimes: 1 });
  const res = await engine.execute(baseArgs({ requestId: 'req-e2', generate: gen }));
  assert.equal(res.manifest.title, 'Meeting Notes');
  assert.ok(gen.calls >= 3, 'plan + repair + files');
});

test('planner failing twice throws ARTIFACT_PLAN_INVALID (fallback class)', async () => {
  await assert.rejects(
    () => engine.execute(baseArgs({ requestId: 'req-e3', generate: makeGenerate({ failPlanTimes: 2 }) })),
    (err) => err.name === 'ArtifactError' && err.code === 'ARTIFACT_PLAN_INVALID',
  );
});

test('unregistered detector format throws FORMAT_UNAVAILABLE before any LLM call', async () => {
  // As of P3 every detector-mapped format has a live exporter — the gate
  // remains the safety mechanism for FUTURE detector targets, so it's
  // exercised with a fictional format id.
  const gen = makeGenerate();
  await assert.rejects(
    () => engine.execute(baseArgs({ requestId: 'req-e4', intent: { wants: true, format: 'holotape', confidence: 0.9 }, generate: gen })),
    (err) => err.code === 'FORMAT_UNAVAILABLE',
  );
  assert.equal(gen.calls, 0, 'gate fires before spending tokens');
});

test('empty builder output surfaces as a build failure', async () => {
  await assert.rejects(
    () => engine.execute(baseArgs({ requestId: 'req-e5', generate: makeGenerate({ fileText: '   ' }) })),
  );
});

test('pre-aborted client stops after plan, stores nothing', async () => {
  store._resetForTests();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => engine.execute(baseArgs({ requestId: 'req-e6', generate: makeGenerate(), clientSignal: ac.signal })),
    (err) => err.name === 'ArtifactAbortError',
  );
  assert.equal(store.listArtifacts({ ownerId: 'user:u1' }).length, 0, 'no artifact persisted');
});

test('registers as the artifact agent (side-effect import)', () => {
  const agent = getAgent('artifact');
  assert.ok(agent);
  assert.equal(agent.run, engine.execute);
});

test('detector format enforced over planner drift (reconcileFormat)', async () => {
  // Planner returns csv, but the user explicitly said .md (conf 0.95).
  const driftPlan = JSON.stringify({
    format: 'csv', title: 'Notes', files: [{ path: 'notes.csv', role: 'primary' }], packaging: 'auto',
  });
  const res = await engine.execute(baseArgs({
    requestId: 'req-e7',
    generate: makeGenerate({ planText: driftPlan }),
  }));
  assert.equal(res.manifest.format, 'md');
  assert.equal(res.manifest.files[0].path, 'notes.md');
});
