/**
AQUA Adaptive Tool Orchestrator — Regression Tests (Phase 6)

Covers the spec's named behaviors: execution profile selection,
workspace-gated project capabilities, the verification strategy's named
trigger conditions, and response budgeting.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate, formatOrchestratorLog } from '../toolOrchestrator.js';

function capability(decision, id) {
  return decision.capabilities.find(c => c.id === id);
}

// ── Execution profile selection ───────────────────────────────────────────────

test('simple conversation selects the Simple Question profile', () => {
  const d = orchestrate({ userMessage: 'Hi there, how are you?', taskType: 'conversation', confidence: 0.85, hasWorkspaceId: false });
  assert.equal(d.profile.id, 'simple_question');
  assert.equal(capability(d, 'long_term_memory_extraction').enabled, false);
  assert.equal(capability(d, 'critic').enabled, false);
  assert.equal(capability(d, 'planning_engine').enabled, false);
});

test('architecture request selects the Architecture Request profile', () => {
  const d = orchestrate({ userMessage: 'Build a scalable authentication system', taskType: 'architecture', confidence: 0.97, hasWorkspaceId: false });
  assert.equal(d.profile.id, 'architecture_request');
  assert.equal(capability(d, 'architecture_planning').enabled, true);
});

test('debugging request selects the Debugging Request profile', () => {
  const d = orchestrate({ userMessage: 'My app crashes when I click submit', taskType: 'debugging', confidence: 0.9, hasWorkspaceId: true });
  assert.equal(d.profile.id, 'debugging_request');
  assert.equal(capability(d, 'debugging').enabled, true);
});

// ── Project capabilities are gated by hasWorkspaceId ──────────────────────────

test('project capabilities stay disabled for a coding profile with no workspace attached', () => {
  const d = orchestrate({ userMessage: 'Write a function to reverse a string', taskType: 'coding', confidence: 0.9, hasWorkspaceId: false });
  assert.equal(d.profile.id, 'coding_request');
  assert.equal(capability(d, 'project_retrieval').enabled, false);
  assert.equal(capability(d, 'workspace_analysis').enabled, false);
});

test('project capabilities enable for a coding profile when a workspace IS attached', () => {
  const d = orchestrate({ userMessage: 'Write a function to reverse a string', taskType: 'coding', confidence: 0.9, hasWorkspaceId: true });
  assert.equal(capability(d, 'project_retrieval').enabled, true);
  assert.equal(capability(d, 'workspace_analysis').enabled, true);
});

test('Simple Question profile never enables project capabilities even with a workspace attached', () => {
  const d = orchestrate({ userMessage: 'What is 9 times 7?', taskType: 'simple_qa', confidence: 0.9, hasWorkspaceId: true });
  assert.equal(capability(d, 'project_retrieval').enabled, false);
});

// ── Verification strategy (spec: "Only enable verification if...") ───────────

test('verification enables for a security-flavored request', () => {
  const d = orchestrate({ userMessage: 'Build a scalable authentication system', taskType: 'architecture', confidence: 0.97, hasWorkspaceId: false });
  assert.equal(d.verification.enabled, true);
  assert.match(d.verification.reason, /security/);
});

test('verification stays disabled for an ordinary simple question', () => {
  const d = orchestrate({ userMessage: 'What is the capital of France?', taskType: 'simple_qa', confidence: 0.9, hasWorkspaceId: false });
  assert.equal(d.verification.enabled, false);
});

test('verification enables for large code generation', () => {
  const longMessage = 'Please write a full implementation of a binary search tree with insert, delete, balance, and traversal methods, fully commented. ' + 'x'.repeat(1200);
  const d = orchestrate({ userMessage: longMessage, taskType: 'coding', confidence: 0.9, hasWorkspaceId: false });
  assert.equal(d.verification.enabled, true);
  assert.match(d.verification.reason, /large code generation/);
});

// ── Response budgeting ────────────────────────────────────────────────────────

test('Simple Question gets a smaller response/context budget than Architecture Request', () => {
  const simple = orchestrate({ userMessage: 'Hi!', taskType: 'conversation', confidence: 0.85, hasWorkspaceId: false });
  const arch   = orchestrate({ userMessage: 'Design a multi-region deployment architecture', taskType: 'architecture', confidence: 0.95, hasWorkspaceId: false });
  assert.ok(simple.budget.maxResponseTokens < arch.budget.maxResponseTokens);
  assert.ok(simple.budget.maxContextTokens < arch.budget.maxContextTokens);
});

// ── Logging ────────────────────────────────────────────────────────────────────

test('formatOrchestratorLog produces the spec-shaped [ORCHESTRATOR] block', () => {
  const d = orchestrate({ userMessage: 'Build a scalable authentication system', taskType: 'architecture', confidence: 0.97, hasWorkspaceId: false });
  const log = formatOrchestratorLog(d);
  assert.match(log, /^\[ORCHESTRATOR\]/);
  assert.match(log, /Profile = Architecture Request/);
  assert.match(log, /Enabled:/);
  assert.match(log, /Skipped:/);
  assert.match(log, /Estimated Cost:/);
  assert.match(log, /Estimated Latency:/);
  assert.match(log, /Reason:/);
});

// ── Determinism (spec: "Keep orchestration deterministic") ───────────────────

test('orchestrate() is a pure function — identical input produces identical output', () => {
  const input = { userMessage: 'Compare PostgreSQL vs MongoDB', taskType: 'research', confidence: 0.97, hasWorkspaceId: false };
  const a = orchestrate({ ...input });
  const b = orchestrate({ ...input });
  assert.deepEqual(a, b);
});
