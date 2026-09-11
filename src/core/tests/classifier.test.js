/**
AQUA Task Classifier — v4 Regression Tests

Bug (Phase 6 spec, verbatim): "The current classifier incorrectly labels
coding requests as research. This must be fixed."

Root cause: PATTERNS.research's generic /explain|clarify|elaborate|describe/
pattern had no competing bare "code"/"function" trigger in PATTERNS.coding,
so "Explain this code" / "Describe this function" classified as research.
Fix: project_query gained explicit explain-this-code patterns, plus a
scoring guard (see classifier.js's scoreTask) that demotes research's
generic-explain contribution whenever it's the *only* research signal and a
coding/debugging/project_query signal — or a bare code-context mention — is
already present in the message.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, scoreTask, getTaskComplexity, getEffectiveComplexity } from '../classifier.js';

// ── Bug: coding requests mislabeled as research ──────────────────────────────

test('"Explain this code" classifies as project_query, not research', () => {
  const { task } = classifyTask('Explain this code');
  assert.equal(task, 'project_query');
});

test('"Describe this function please" classifies as project_query, not research', () => {
  const { task } = classifyTask('Describe this function please');
  assert.equal(task, 'project_query');
});

test('"Can you clarify what is happening in my code below?" does not classify as research', () => {
  const { task } = classifyTask('Can you clarify what is happening in my code below?');
  assert.notEqual(task, 'research');
});

test('"break down this bug for me" classifies as project_query', () => {
  const { task } = classifyTask('break down this bug for me');
  assert.equal(task, 'project_query');
});

// ── Guard: generic research patterns still win when there is no code context ─

test('"Explain how dependency injection works in Spring" still classifies as research', () => {
  const { task } = classifyTask('Explain how dependency injection works in Spring');
  assert.equal(task, 'research');
});

test('"Compare PostgreSQL vs MongoDB" still classifies as research', () => {
  const { task } = classifyTask('Compare PostgreSQL vs MongoDB');
  assert.equal(task, 'research');
});

test('"Explain how to implement binary search in Python" classifies as coding', () => {
  const { task } = classifyTask('Explain how to implement binary search in Python');
  assert.equal(task, 'coding');
});

// ── scoreTask export (Adaptive Tool Orchestrator's multi-label dependency) ───

test('scoreTask returns a numeric score for every known category', () => {
  const scores = scoreTask('Build a scalable authentication system');
  assert.ok(scores.architecture > 0);
  for (const v of Object.values(scores)) assert.equal(typeof v, 'number');
});

test('scoreTask and classifyTask agree on the dominant category', () => {
  const cases = ['Build a scalable authentication system', 'Compare PostgreSQL vs MongoDB', 'Explain this code', 'Hi there'];
  for (const msg of cases) {
    const { task } = classifyTask(msg);
    const scores = scoreTask(msg);
    const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (top[1] > 0) assert.equal(task, top[0], `mismatch for "${msg}"`);
  }
});

// ── getEffectiveComplexity (Phase 6 — shared with toolOrchestrator.js) ────────

test('getEffectiveComplexity matches getTaskComplexity at high confidence', () => {
  for (const t of ['architecture', 'coding', 'conversation']) {
    assert.equal(getEffectiveComplexity(t, 0.95), getTaskComplexity(t));
  }
});

test('getEffectiveComplexity escalates one tier under low confidence', () => {
  assert.equal(getEffectiveComplexity('conversation', 0.3), 'medium'); // low -> medium
  assert.equal(getEffectiveComplexity('coding', 0.3), 'high');         // medium -> high
  assert.equal(getEffectiveComplexity('architecture', 0.3), 'high');   // high stays high
});

// ── v5: coding/architecture requests mislabeled as simple_qa (Issue 2) ───────
//
// Bug (verbatim from the fix spec): "Build a production-ready JWT
// authentication system..." classified as simple_qa. It should classify as
// coding or architecture.
//
// Root cause: the message named no specific language/framework, so it
// scored 0 against every PATTERNS category and fell through to
// classifyTask's zero-score fallback, which defaults short messages to
// simple_qa. Fix: coding gained a paired build/create/generate/develop +
// technical-object pattern, plus standalone technical terms (JWT, OAuth,
// Express/NestJS/Fastify, database, Redis, Docker, Kubernetes,
// authentication, authorization, endpoint, API, rust); architecture gained
// multi-tenant and "authentication/authorization architecture" phrasing.

test('"Build a production-ready JWT authentication system..." classifies as coding or architecture, never simple_qa', () => {
  const { task } = classifyTask('Build a production-ready JWT authentication system...');
  assert.notEqual(task, 'simple_qa');
  assert.ok(['coding', 'architecture'].includes(task), `expected coding or architecture, got ${task}`);
});

test('a fuller version of the same request also classifies as coding', () => {
  const { task } = classifyTask('Build a production-ready JWT authentication system with refresh tokens, rate limiting, and OAuth2 support');
  assert.equal(task, 'coding');
});

test('"Create a REST API for user management with a database" classifies as coding', () => {
  const { task } = classifyTask('Create a REST API for user management with a database');
  assert.equal(task, 'coding');
});

test('"Set up Docker and Kubernetes for my Node.js app" classifies as coding', () => {
  const { task } = classifyTask('Set up Docker and Kubernetes for my Node.js app');
  assert.equal(task, 'coding');
});

test('bare JWT/OAuth/authentication/authorization mentions score as coding signals', () => {
  for (const msg of ['I need JWT for this', 'Set up OAuth', 'Add authentication', 'Check authorization']) {
    assert.ok(scoreTask(msg).coding > 0, `"${msg}" should carry a coding signal`);
  }
});

test('"design a multi-tenant authentication architecture" classifies as architecture', () => {
  const { task } = classifyTask('design a multi-tenant authentication architecture');
  assert.equal(task, 'architecture');
});

test('Rust joins the existing language list alongside Go/Java/C++', () => {
  assert.ok(scoreTask('Write a Rust program that parses JSON').coding > 0);
});

// ── v5 regression guards: the new coding keywords must not steal
// unrelated categories that were passing before this change ─────────────

test('"Compare PostgreSQL vs MongoDB" still classifies as research (no false positive from the new coding keywords)', () => {
  const { task } = classifyTask('Compare PostgreSQL vs MongoDB');
  assert.equal(task, 'research');
});

test('"create a poem about love" still classifies as creative_writing (bare "create" alone must not trigger coding)', () => {
  const { task } = classifyTask('create a poem about love');
  assert.equal(task, 'creative_writing');
});

test('"Explain this code" still classifies as project_query (v4 fix unaffected by v5 additions)', () => {
  const { task } = classifyTask('Explain this code');
  assert.equal(task, 'project_query');
});

// ═══ Phase 0 (audit F14) — file_analysis gains real patterns ═══════════════════
// The category had weight/tier entries but ZERO patterns — it could never
// score, so media questions fell to generic categories at low confidence,
// and low confidence triggers verification (the overwrite-bug reviewer
// path). These tests pin BOTH halves: media questions classify strongly,
// and the anchored patterns never leak into other domains.

test('media questions classify as file_analysis with high confidence (verification not triggered by weak classification)', () => {
  const strong = [
    'what happens in this video?',
    'who enters the room first in the video?',
    'transcribe this audio',
    'what does this screenshot show?',
    'summarize the meeting recording',
    'analyze demo.mp4',
    'listen to the voice note and summarize it',
    'look at this photo and tell me where it was taken',
  ];
  for (const msg of strong) {
    const { task, confidence } = classifyTask(msg);
    assert.equal(task, 'file_analysis', `"${msg}" → ${task}`);
    assert.ok(confidence >= 0.5, `"${msg}" confidence ${confidence} must not trip the low-confidence verification gate`);
  }
});

test('anchored media patterns do not leak: docker/code/architecture phrasing keeps its category', () => {
  assert.notEqual(classifyTask('push the docker image to the registry').task, 'file_analysis');
  assert.notEqual(classifyTask('build the image and tag it v2').task,        'file_analysis');
  assert.notEqual(classifyTask('write a for loop in python').task,           'file_analysis');
  assert.notEqual(classifyTask('design an auth architecture').task,          'file_analysis');
  assert.notEqual(classifyTask('my frame of reference for this decision').task, 'file_analysis');
});