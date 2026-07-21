/**
 * Orchestration 2.0 — task graph, planner, specialists, runtime.
 *
 * Runtime tests inject `generate` (the same seam reasoningAgent /
 * verificationAgent document) with scripted specialists: success paths,
 * a provider that fails twice then recovers (diagnose→retry), a persistently
 * low-quality node that degrades but lets the run continue, a critical
 * first-node failure that aborts into the caller's fallback, mixed
 * capability routing (code + math + evidence + synthesize), and a
 * parallel-wave + perf guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-orch2-'));

const { createGraph, addNode, validateGraph, leafNodes } = await import('../taskGraph.js');
const { planTaskGraph } = await import('../graphPlanner.js');
const { runTaskGraph, getGraphMetrics } = await import('../graphRuntime.js');
const { registerSpecialist, getSpecialist } = await import('../graphSpecialists.js');

// ── Task graph model ─────────────────────────────────────────────────────────

test('taskGraph: validation rejects missing deps and cycles; layers parallelize', () => {
  const g = createGraph();
  addNode(g, { id: 'a', instruction: 'do a' });
  addNode(g, { id: 'b', instruction: 'do b' });
  addNode(g, { id: 'c', instruction: 'do c', deps: ['a', 'b'] });
  const v = validateGraph(g);
  assert.ok(v.valid);
  assert.deepEqual(v.layers, [['a', 'b'], ['c']]);
  assert.deepEqual(leafNodes(g), ['c']);

  const bad = createGraph();
  addNode(bad, { id: 'x', instruction: 'x', deps: ['ghost'] });
  assert.ok(!validateGraph(bad).valid);

  const cyc = createGraph();
  addNode(cyc, { id: 'p', instruction: 'p', deps: ['q'] });
  addNode(cyc, { id: 'q', instruction: 'q', deps: ['p'] });
  const vc = validateGraph(cyc);
  assert.ok(!vc.valid && /cycle/.test(vc.problems[0]));
});

// ── Planner shapes ───────────────────────────────────────────────────────────

test('planner: numbered list → parallel parts + synthesis', () => {
  const { graph, strategy } = planTaskGraph({
    userMessage: 'Please do these:\n1. Summarize the quarterly report numbers\n2. Write a python function to parse the csv\n3. Calculate the percentage change year over year',
    taskType: 'agent_task', complexity: 'high',
  });
  assert.equal(strategy, 'numbered-parts');
  const v = validateGraph(graph);
  assert.ok(v.valid);
  assert.equal(v.layers[0].length, 3, 'parts run in parallel');
  assert.equal(v.layers[1][0], 'synthesize');
  const caps = [...graph.nodes.values()].map(n => n.capability);
  assert.ok(caps.includes('summarize') && caps.includes('code') && caps.includes('math'), 'specialists routed per part');
});

test('planner: "then" chain → sequential refinement; comparison → fan-out; low → single', () => {
  const seq = planTaskGraph({ userMessage: 'Draft an outline for the launch post and then expand it into a full draft and then tighten the tone for engineers', taskType: 'creative_writing', complexity: 'medium' });
  assert.equal(seq.strategy, 'sequence');
  const sv = validateGraph(seq.graph);
  assert.ok(sv.layers.length >= 4, 'chain executes in order');

  const cmp = planTaskGraph({ userMessage: 'Compare PostgreSQL and MongoDB for our workload', taskType: 'analysis', complexity: 'high' });
  assert.equal(cmp.strategy, 'comparison');
  assert.deepEqual(validateGraph(cmp.graph).layers[0].sort(), ['analyze-a', 'analyze-b']);

  const single = planTaskGraph({ userMessage: 'hey what is a mutex', taskType: 'simple_qa', complexity: 'low' });
  assert.equal(single.strategy, 'single');
  assert.equal(single.graph.nodes.size, 1);
});

test('planner: pipeline fallback reuses pipelineRegistry stages', () => {
  const { graph, strategy } = planTaskGraph({ userMessage: 'Design the ingestion service architecture for our platform', taskType: 'architecture', complexity: 'high' });
  assert.equal(strategy, 'pipeline');
  assert.ok(graph.nodes.size >= 5);
  assert.ok(graph.nodes.has('synthesize'));
});

// ── Runtime: scripted generate — routing, recovery, degradation ──────────────

function scriptedGenerate(script) {
  const calls = [];
  const fn = async (userPrompt, systemPrompt, _m, _c, hint) => {
    calls.push({ userPrompt, systemPrompt, hint });
    for (const rule of script) {
      if (rule.match(userPrompt, systemPrompt, hint, calls.length)) return rule.result(userPrompt, calls.length);
    }
    return { text: `OK[${hint}]: grounded result covering ${userPrompt.slice(9, 60)}`, provider: 'fakeA', score: 85, latency: 5 };
  };
  fn.calls = calls;
  return fn;
}

test('runtime: multi-part run routes hints per specialist, synthesizes, reports confidence dims', async () => {
  const generate = scriptedGenerate([]);
  const r = await runTaskGraph({
    userMessage: '1. Summarize the report revenue figures\n2. Write a function to parse totals\n3. Calculate the growth percentage change',
    taskType: 'agent_task', plan: { complexity: 'high' },
    context: { memory: 'User: Ananya, prefers terse output.', evidence: 'report.pdf · Page 2: revenue 4000000 in 2025, 5000000 in 2026.', search: '' },
    deps: { generate },
  });
  assert.equal(r.provider, 'orchestrator');
  assert.ok(r.text.length > 30);
  const hints = generate.calls.map(c => c.hint);
  assert.ok(hints.includes('summarization') && hints.includes('coding'), 'provider-quality hints vary per subtask');
  const dims = r.orchestration2.confidence;
  for (const k of ['plan', 'memory', 'evidence', 'reasoning', 'answer', 'overall']) assert.ok(dims[k] > 0, `dim ${k}`);
  assert.ok(dims.evidence > 0.3, 'evidence grounding raised evidence confidence');
  assert.ok(generate.calls.some(c => c.systemPrompt.includes('UPLOADED-FILE EVIDENCE')), 'evidence injected into grounded specialists');
  assert.equal(r.orchestration2.degraded.length, 0);
});

test('runtime: transient failure → diagnose → adjusted retry recovers (spec 8)', async () => {
  let mathAttempts = 0;
  const generate = scriptedGenerate([{
    match: (u, s) => s.includes('mathematics specialist'),
    result: (u) => {
      mathAttempts += 1;
      if (mathAttempts === 1) throw new Error('TIMEOUT');
      return { text: 'Computation: (5000000-4000000)/4000000 = 25 percent growth for the revenue figures requested.', provider: 'fakeB', score: 80, latency: 4 };
    },
  }]);
  const r = await runTaskGraph({
    userMessage: '1. Summarize the revenue report numbers\n2. Calculate the growth percentage between the two revenue figures',
    taskType: 'agent_task', plan: { complexity: 'high' },
    context: {}, deps: { generate },
  });
  assert.equal(mathAttempts, 2, 'one diagnosed retry');
  const mathNode = r.orchestration2.nodes.find(n => n.capability === 'math');
  assert.equal(mathNode.attempts, 2);
  assert.equal(mathNode.degraded, false, 'recovered — not degraded');
  assert.ok(generate.calls.some(c => c.userPrompt.includes('previous attempt was rejected (timeout)')), 'diagnosis fed into retry prompt');
});

test('runtime: persistently bad non-critical node degrades; run continues; synthesis warned', async () => {
  const generate = scriptedGenerate([{
    match: (u, s) => s.includes('summarization specialist'),
    result: () => ({ text: 'ok', provider: 'fakeC', score: 40, latency: 3 }),   // always too_short
  }]);
  const r = await runTaskGraph({
    userMessage: '1. Summarize the meeting outcome decisions\n2. List the concrete action items with owners assigned',
    taskType: 'agent_task', plan: { complexity: 'high' },
    context: {}, deps: { generate },
  });
  assert.ok(r.text.length > 20, 'run completed despite the bad node');
  const bad = r.orchestration2.nodes.find(n => n.id === 'part-1');
  assert.equal(bad.degraded, true);
  assert.ok(bad.attempts >= 2, 'retry + fallback consumed');
  assert.ok(r.orchestration2.degraded.includes('part-1'));
  assert.equal(bad.capability, 'reason', 'fallback capability engaged (summarize → reason)');
  assert.ok(r.orchestration2.confidence.overall > 0.5, 'fallback recovery keeps confidence honest, not tanked');
});

test('runtime: critical first-node failure with nothing completed throws → caller falls back', async () => {
  const generate = scriptedGenerate([{ match: () => true, result: () => { throw new Error('providers exhausted'); } }]);
  await assert.rejects(
    runTaskGraph({
      userMessage: 'Design the caching layer and then implement the eviction policy for it',
      taskType: 'agent_task', plan: { complexity: 'high' }, context: {}, deps: { generate },
    }),
    /critical node|no answer/,
  );
});

test('runtime: sequential chain feeds each step the previous output (spec 5 refinement)', async () => {
  const generate = scriptedGenerate([]);
  await runTaskGraph({
    userMessage: 'Draft the outline for the migration guide and then expand that outline into full sections with details',
    taskType: 'planning', plan: { complexity: 'medium' }, context: {}, deps: { generate },
  });
  const second = generate.calls.find(c => c.userPrompt.includes('step-2') || c.userPrompt.includes('Inputs from earlier steps'));
  assert.ok(second, 'later stage received earlier output');
  assert.ok(second.userPrompt.includes('OK['), 'dependency text actually forwarded');
});

test('runtime: caller-supplied graph honored; specialist registry extension seam works', async () => {
  registerSpecialist('search', {
    kind: 'internal', taskTypeHint: 'research', fallback: 'reason',
    directive: 'internal search', run: async () => ({ text: 'Live results: 3 relevant items found for the query with details attached.', provider: 'internal:search', score: 90, latency: 2 }),
  });
  const g = createGraph();
  addNode(g, { id: 'find', capability: 'search', instruction: 'find the latest release notes details' });
  addNode(g, { id: 'synthesize', capability: 'synthesize', instruction: 'answer from the findings', deps: ['find'] });
  const generate = scriptedGenerate([]);
  const r = await runTaskGraph({ userMessage: 'latest release notes details', taskType: 'research', plan: { complexity: 'medium' }, graph: g, context: {}, deps: { generate } });
  assert.ok(r.orchestration2.providersUsed.includes('internal:search'), 'internal specialist executed');
  assert.equal(getSpecialist('search').kind, 'internal');
});

test('runtime: parallel waves + perf — 6 parallel parts complete in ~one node latency', async () => {
  const generate = scriptedGenerate([{
    match: () => true,
    result: (u) => new Promise(res => setTimeout(() => res({ text: `Detailed grounded result for: ${u.slice(9, 70)}`, provider: 'fakeP', score: 85, latency: 40 }), 40)),
  }]);
  const msg = Array.from({ length: 6 }, (_, i) => `${i + 1}. Analyze workstream number ${i + 1} deliverables and risks`).join('\n');
  const t0 = performance.now();
  const r = await runTaskGraph({ userMessage: msg, taskType: 'agent_task', plan: { complexity: 'high' }, context: {}, deps: { generate } });
  const ms = performance.now() - t0;
  assert.equal(r.orchestration2.nodes.length, 7);
  assert.ok(ms < 400, `parallel pool kept 6 nodes + synthesis under 400ms (took ${ms.toFixed(0)}ms)`);
  const m = getGraphMetrics();
  assert.ok(m.runs >= 6 && m.nodesExecuted >= 20, 'metrics accumulate');
});
