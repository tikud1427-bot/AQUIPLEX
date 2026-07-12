/**
AQUA Debate Panel + Debate Agent — Regression Tests (Phase 6)

Three layers, matching the module split:

  debatePanel.js  — deterministic: panel seating rules (taskType + tags,
                    always exactly 3, skeptic constant), finding
                    normalization, synthesizer escalation rules
  debateAgent.js  — parse hardening (fences, prose, junk entries) and the
                    full loop: consensus, preserved minority disagreement,
                    escalation→revision→re-panel convergence, iteration
                    cap, and fail-open at every step (panel error, garbage
                    JSON, revision error) without ever losing an accepted
                    revision or the original draft
  registry        — self-registration under 'debate'

Same injection pattern as verificationAgent.test.js / confidenceEngine.test.js:
never touches providers/router.js.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONAS, selectPanel, normalizeFinding, synthesizeDebate } from './debatePanel.js';
import { runDebate, parsePanelResponse } from './debateAgent.js';
import { getAgent } from './agentRegistry.js';

/** Sequenced fake: each call consumes the next scripted response (string or Error). */
function fakeGenerateSeq(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (userMessage, systemPrompt, messages, ctx, preTaskType, executionPlan, responseBudget) => {
    calls.push({ userMessage, systemPrompt, messages, preTaskType, responseBudget });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { text: next, provider: 'mock-provider' };
  };
  fn.calls = calls;
  return fn;
}

const panelJSON = (findings) => JSON.stringify({ findings });
const pass = (persona) => ({ persona, verdict: 'pass' });
const issue = (persona, severity, text = 'specific problem') =>
  ({ persona, verdict: 'issue', severity, issue: text, suggestion: 'fix it this way' });

// ═══ Panel seating ════════════════════════════════════════════════════════════

test('seating is deterministic per taskType: skeptic always first, exactly 3 seats', () => {
  assert.deepEqual(selectPanel('coding').map(p => p.id),        ['skeptic', 'coder', 'performance']);
  assert.deepEqual(selectPanel('debugging').map(p => p.id),     ['skeptic', 'coder', 'performance']);
  assert.deepEqual(selectPanel('architecture').map(p => p.id),  ['skeptic', 'architect', 'performance']);
  assert.deepEqual(selectPanel('project_query').map(p => p.id), ['skeptic', 'architect', 'performance']);
  assert.deepEqual(selectPanel('planning').map(p => p.id),      ['skeptic', 'analyst', 'architect']);
  assert.deepEqual(selectPanel('research').map(p => p.id),      ['skeptic', 'analyst', 'architect']); // default seats
  for (const t of ['coding', 'unknown_task', 'architecture']) {
    assert.equal(selectPanel(t).length, 3);
    assert.equal(selectPanel(t)[0].id, 'skeptic');
  }
});

test('security tag seats the security reviewer in the last chair', () => {
  assert.deepEqual(selectPanel('coding', ['security']).map(p => p.id), ['skeptic', 'coder', 'security']);
});

test('financial/medical tag seats compliance; security + financial seats BOTH sensitive voices', () => {
  assert.deepEqual(selectPanel('coding', ['financial']).map(p => p.id),             ['skeptic', 'coder', 'compliance']);
  assert.deepEqual(selectPanel('analysis', ['medical']).map(p => p.id),             ['skeptic', 'analyst', 'compliance']);
  assert.deepEqual(selectPanel('coding', ['security', 'financial']).map(p => p.id), ['skeptic', 'compliance', 'security']);
});

test('every seated persona carries a charter from the roster', () => {
  for (const p of selectPanel('coding', ['security'])) {
    assert.equal(p, PERSONAS[p.id]);
    assert.ok(p.charter.length > 20);
  }
});

// ═══ Finding normalization ════════════════════════════════════════════════════

test('normalizeFinding: unknown persona / unknown verdict → null; issue without severity → medium', () => {
  const allowed = new Set(['skeptic', 'coder']);
  assert.equal(normalizeFinding({ persona: 'intruder', verdict: 'pass' }, allowed), null);
  assert.equal(normalizeFinding({ persona: 'skeptic', verdict: 'maybe' }, allowed), null);
  assert.equal(normalizeFinding(null, allowed), null);
  const f = normalizeFinding({ persona: 'CODER', verdict: 'issue', issue: 'x' }, allowed);
  assert.equal(f.persona, 'coder');       // case-normalized
  assert.equal(f.severity, 'medium');     // defaulted, still an issue
});

// ═══ Synthesizer ══════════════════════════════════════════════════════════════

test('all pass → consensus, no escalation, empty minority report', () => {
  const s = synthesizeDebate([pass('skeptic'), pass('coder'), pass('performance')]);
  assert.deepEqual([s.consensusPass, s.escalate, s.issues.length, s.minorityReport.length], [true, false, 0, 0]);
});

test('single low/medium finding → preserved as minority report, NOT escalated', () => {
  const s = synthesizeDebate([pass('skeptic'), issue('coder', 'low'), pass('performance')]);
  assert.equal(s.consensusPass, false);
  assert.equal(s.escalate, false);
  assert.equal(s.minorityReport.length, 1);
  assert.equal(s.minorityReport[0].persona, 'coder');
});

test('escalation by depth (one high) and by agreement (two DISTINCT personas, any severity)', () => {
  const depth = synthesizeDebate([pass('skeptic'), issue('security', 'high'), pass('coder')]);
  assert.equal(depth.escalate, true);
  const agreement = synthesizeDebate([issue('skeptic', 'low'), issue('coder', 'medium'), pass('performance')]);
  assert.equal(agreement.escalate, true);
  assert.equal(agreement.minorityReport.length, 0); // escalated issues are being resolved, not preserved
});

test('one verbose voice filing two low/medium issues is a minority report, NOT agreement', () => {
  const s = synthesizeDebate([issue('coder', 'low', 'a'), issue('coder', 'medium', 'b'), pass('skeptic'), pass('performance')]);
  assert.equal(s.escalate, false);
  assert.equal(s.consensusPass, false);
  assert.equal(s.minorityReport.length, 2); // both findings preserved, neither empowered to rewrite
});

test('attendance: passes from a partial panel are inconclusive, never consensus — silence is not approval', () => {
  const full    = synthesizeDebate([pass('skeptic'), pass('coder'), pass('performance')], 3);
  const partial = synthesizeDebate([pass('skeptic')], 3);
  assert.deepEqual([full.consensusPass, full.inconclusive, full.attendance],       [true, false, 3]);
  assert.deepEqual([partial.consensusPass, partial.inconclusive, partial.attendance], [false, true, 1]);
  // …but a partial panel that DID find an issue is judged on the issue, not attendance.
  const partialIssue = synthesizeDebate([issue('security', 'high')], 3);
  assert.deepEqual([partialIssue.inconclusive, partialIssue.escalate], [false, true]);
});

// ═══ Parse hardening ══════════════════════════════════════════════════════════

test('parsePanelResponse tolerates fences and surrounding prose, drops junk entries individually', () => {
  const allowed = new Set(['skeptic', 'coder', 'performance']);
  const wrapped = 'Here is my review:\n```json\n' +
    panelJSON([pass('skeptic'), { persona: 'intruder', verdict: 'pass' }, issue('coder', 'high')]) +
    '\n```\nHope that helps!';
  const findings = parsePanelResponse(wrapped, allowed);
  assert.equal(findings.length, 2); // intruder dropped, valid pair kept
  assert.deepEqual(findings.map(f => f.persona), ['skeptic', 'coder']);
});

test('parsePanelResponse throws on no-JSON and on zero valid findings', () => {
  const allowed = new Set(['skeptic']);
  assert.throws(() => parsePanelResponse('I refuse to answer in JSON.', allowed), /panel_unparseable/);
  assert.throws(() => parsePanelResponse(panelJSON([pass('intruder')]), allowed), /panel_unparseable/);
});

// ═══ Agent registration ═══════════════════════════════════════════════════════

test('importing the module registers a debate agent with a run() function', () => {
  const agent = getAgent('debate');
  assert.equal(agent.name, 'debate');
  assert.equal(typeof agent.run, 'function');
});

// ═══ Agent loop — settled paths ═══════════════════════════════════════════════

test('consensus pass: one panel call, draft untouched, converged', async () => {
  const generate = fakeGenerateSeq([panelJSON([pass('skeptic'), pass('coder'), pass('performance')])]);
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 2, generate });
  assert.equal(generate.calls.length, 1);
  assert.deepEqual(
    [r.ran, r.passed, r.revised, r.converged, r.passes, r.finalAnswer, r.agent],
    [true, true, false, true, 1, 'draft', 'debate']
  );
  assert.deepEqual(r.panel, ['skeptic', 'coder', 'performance']);
  assert.equal(r.disagreements.length, 0);
});

test('single minor finding: no revision, converged, minority view shipped as disagreement', async () => {
  const generate = fakeGenerateSeq([
    panelJSON([pass('skeptic'), issue('performance', 'low', 'N+1 in the example loop'), pass('coder')]),
  ]);
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 2, generate });
  assert.equal(generate.calls.length, 1);
  assert.equal(r.revised, false);
  assert.equal(r.passed, false);
  assert.equal(r.converged, true);
  assert.equal(r.finalAnswer, 'draft');
  assert.equal(r.disagreements.length, 1);
  assert.match(r.disagreements[0].issue, /N\+1/);
});

test('partial panel with no issues: inconclusive — draft untouched, not counted as a pass', async () => {
  const generate = fakeGenerateSeq([panelJSON([pass('skeptic')])]); // 2 of 3 voices silent
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 2, generate });
  assert.equal(generate.calls.length, 1);
  assert.deepEqual(
    [r.ran, r.passed, r.revised, r.converged, r.inconclusive, r.finalAnswer],
    [true, false, false, true, true, 'draft']
  );
  assert.equal(r.disagreements.length, 0);
});

// ═══ Agent loop — escalation, convergence, cap ════════════════════════════════

test('escalation → revision → clean re-panel: converged on the revision, issues fed to the revision prompt', async () => {
  const generate = fakeGenerateSeq([
    panelJSON([pass('skeptic'), issue('security', 'high', 'SQL string concatenation'), pass('coder')]),
    'Revised answer with parameterized queries.',
    panelJSON([pass('skeptic'), pass('security'), pass('coder')]),
  ]);
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', tags: ['security'], maxPasses: 2, generate });
  assert.equal(generate.calls.length, 3); // panel, revision, re-panel
  assert.deepEqual([r.passed, r.revised, r.converged, r.passes], [true, true, true, 2]);
  assert.equal(r.finalAnswer, 'Revised answer with parameterized queries.');
  assert.equal(r.disagreements.length, 0);
  // Revision call received the escalated issue with persona/severity framing…
  assert.match(generate.calls[1].messages[0].content, /\[security\/high\] SQL string concatenation/);
  // …and the re-panel reviewed the REVISION, not the original draft.
  assert.match(generate.calls[2].messages[0].content, /parameterized queries/);
});

test('iteration cap: still escalating at maxPasses ships the latest revision unreviewed, converged=false', async () => {
  const generate = fakeGenerateSeq([
    panelJSON([issue('skeptic', 'medium'), issue('coder', 'medium'), pass('performance')]),
    'rev one.',
  ]);
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 1, generate });
  assert.equal(generate.calls.length, 2); // panel + revision, no budget to re-panel
  assert.deepEqual([r.revised, r.converged, r.passes, r.finalAnswer], [true, false, 1, 'rev one.']);
});

// ═══ Agent loop — fail-open at every step ═════════════════════════════════════

test('panel call error on first pass: legacy fail-open shape — ran=false, draft untouched', async () => {
  const generate = fakeGenerateSeq([new Error('provider exhausted')]);
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 2, generate });
  assert.deepEqual([r.ran, r.passed, r.revised, r.finalAnswer], [false, null, false, 'draft']);
  assert.match(r.error, /provider exhausted/);
});

test('garbage panel JSON: fail-open, draft untouched, parse error recorded', async () => {
  const generate = fakeGenerateSeq(['As a panel, we think the answer is great!']);
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', generate });
  assert.equal(r.ran, false);
  assert.equal(r.finalAnswer, 'draft');
  assert.match(r.error, /panel_unparseable/);
});

test('revision call error: draft ships, escalated issues preserved as disagreements — objection on the record', async () => {
  const generate = fakeGenerateSeq([
    panelJSON([pass('skeptic'), issue('security', 'high', 'auth bypass'), pass('coder')]),
    new Error('revision provider down'),
  ]);
  // tags seat the security reviewer — without this the persona is unseated
  // and its finding is dropped as junk (see selectPanel / normalizeFinding).
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', tags: ['security'], maxPasses: 2, generate });
  assert.equal(r.ran, true);           // the panel DID run
  assert.equal(r.revised, false);
  assert.equal(r.converged, false);
  assert.equal(r.finalAnswer, 'draft');
  assert.equal(r.disagreements.length, 1);
  assert.match(r.disagreements[0].issue, /auth bypass/);
  assert.match(r.error, /revision call failed/);
});

test('panel error on re-panel after an accepted revision ships the revision, never the stale draft', async () => {
  const generate = fakeGenerateSeq([
    panelJSON([issue('skeptic', 'high', 'unsupported claim'), pass('coder'), pass('performance')]),
    'rev one.',
    new Error('re-panel provider down'),
  ]);
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', maxPasses: 2, generate });
  assert.equal(r.ran, true);
  assert.equal(r.revised, true);
  assert.equal(r.converged, false);
  assert.equal(r.finalAnswer, 'rev one.');
});

// ═══ Confidence-engine shape compatibility ════════════════════════════════════

test('debate result feeds confidenceEngine verification factor without changes', async () => {
  const { assessConfidence } = await import('./confidenceEngine.js');
  const generate = fakeGenerateSeq([panelJSON([pass('skeptic'), pass('coder'), pass('performance')])]);
  const r = await runDebate({ userMessage: 'q', draftAnswer: 'draft', taskType: 'coding', generate });
  const clean = assessConfidence({ classifierConfidence: 0.9, factsInjected: 2, verification: r });
  assert.equal(clean.band, 'high'); // consensus pass reads as a clean verified answer
});
