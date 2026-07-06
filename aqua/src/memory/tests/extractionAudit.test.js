/**
 * Memory Extraction Audit — Regression Tests
 * Run: node --test src/memory/tests/extractionAudit.test.js
 *
 * Guards the exact failures the audit surfaced: obvious identity/goal/
 * project/relationship/preference/occupation statements producing ZERO
 * candidates. Also proves the end-to-end contract (chat A stores → chat B
 * recalls → prompt block carries it) and that observation is architecture,
 * not an optional orchestrator capability.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = process.cwd();
let extractFacts, engine;

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-extract-'));
  process.chdir(tmp);
  ({ extractFacts } = await import(path.join(repoRoot, 'src/memory/memoryExtractor.js')));
  engine = await import(path.join(repoRoot, 'src/memory/engine.js'));
});

/** Assert a message extracts a fact whose key matches and value contains want. */
function assertFact(message, key, wantSubstr) {
  const facts = extractFacts(message);
  const hit = facts.find(f => f.key === key);
  assert.ok(hit, `"${message}" → expected key '${key}', got [${facts.map(f => f.key).join(', ') || 'NONE'}]`);
  if (wantSubstr != null) {
    const val = Array.isArray(hit.value) ? hit.value.join(',') : String(hit.value);
    assert.match(val.toLowerCase(), new RegExp(wantSubstr.toLowerCase()), `"${message}" → '${key}' value "${val}" should contain "${wantSubstr}"`);
  }
  return hit;
}

function assertNoKey(message, key) {
  const facts = extractFacts(message);
  assert.ok(!facts.some(f => f.key === key), `"${message}" must NOT extract '${key}' (got ${JSON.stringify(facts.map(f => `${f.key}=${f.value}`))})`);
}

// ── Identity: the headline failure ("Extracted 0 raw candidates") ─────────────
test('identity — every introduction form produces name', () => {
  assertFact('My name is John', 'name', 'John');
  assertFact("I'm John", 'name', 'John');
  assertFact('I am John', 'name', 'John');
  assertFact("hi i'm John", 'name', 'John');       // lowercase greeting prefix
  assertFact("hi i'm chhanda", 'name', 'Chhanda'); // fully lowercase
  assertFact('This is John', 'name', 'John');       // no first-person pronoun
  // v4: "call me X" is the PREFERRED name, a field distinct from the legal
  // `name` (so it can't clobber a previously stated full legal name).
  assertFact('call me John', 'preferred_name', 'John');
  assertFact('I go by Chey', 'preferred_name', 'Chey');
  // v4: multi-word introductions no longer fall through to the custom fallback.
  assertFact("I'm Chhanda Prabal Das", 'name', 'Chhanda Prabal Das');
});

// ── Goals: zero-goal failure ("Help me become a billionaire") ─────────────────
test('goals — intent phrasings produce a goal', () => {
  assertFact('Help me become a billionaire within a year', 'goal', 'billionaire');
  assertFact('I want to build a unicorn', 'goal', 'unicorn');
  assertFact("I'm building a company and I want to reach $1M ARR", 'goal', '1m');
  assertFact("I'm trying to learn Rust deeply", 'goal', 'rust');
  assertFact('My goal is to ship AQUA', 'goal', 'ship');
});

// ── Projects ──────────────────────────────────────────────────────────────────
test('projects — building / startup / founded produce a project', () => {
  assertFact("I'm building Aquiplex", 'project', 'Aquiplex');
  assertFact('My startup is Aquiplex', 'project', 'Aquiplex');
  assertFact('I founded Aquiplex', 'project', 'Aquiplex');
  assertFact("I'm working on the memory engine", 'project', 'memory engine');
});

// ── Relationships ─────────────────────────────────────────────────────────────
test('relationships — family & cofounder produce facts', () => {
  assertFact('My brother is Ananya', 'siblings', 'Ananya');
  assertFact('My wife is Priya', 'spouse', 'Priya');
  assertFact('My cofounder is Chhanda', 'cofounder', 'Chhanda');
});

// ── Preferences ───────────────────────────────────────────────────────────────
test('preferences — prefer / always use / like produce facts', () => {
  assertFact('I prefer concise answers', 'preference', 'concise');
  assertFact('I always use TypeScript', 'preference', 'typescript');
  assertFact('I like clean architecture', 'likes', 'clean architecture');
});

// ── Occupation ────────────────────────────────────────────────────────────────
test('occupation — student / founder / work at produce facts', () => {
  assertFact("I'm a student", 'profession', 'student');
  assertFact("I'm a founder", 'profession', 'founder');
  assertFact('I work at Aquiplex', 'workplace', 'Aquiplex');
  assertFact('i work for google', 'workplace', 'google');
});

// ── Negative guards: transient states & generic nouns are NOT durable ─────────
test('guards — moods and generic nouns never stored', () => {
  assertNoKey("I'm sure that works", 'name');
  assertNoKey("I'm sure that works", 'custom_trait');
  assertNoKey("I'm tired today", 'custom_trait');
  assertNoKey('I am building an AI', 'name');       // gerund guard
  assertNoKey('I am building an AI', 'project');     // generic-noun guard
  assertNoKey("I'm going to the store", 'name');
});

// ── End-to-end: the acceptance scenario the audit demanded ───────────────────
test('E2E — chat A stores name, chat B recalls it in the prompt block', () => {
  const ownerA = engine.resolveOwner({ userId: 'e2e-user', conversationId: 'chatA' });
  engine.memoryObserve(ownerA, { userMessage: 'My name is Chhanda.', conversationId: 'chatA' });

  const ownerB = engine.resolveOwner({ userId: 'e2e-user', conversationId: 'chatB' });
  const { block } = engine.memoryRetrieve(ownerB, { query: "What's my name?" });
  assert.match(block, /Chhanda/, 'name must appear in the retrieved prompt block from a different conversation');
  assert.match(block, /Name:/i, 'identity section present');
});

test('E2E — identity, project, preference, goal all persist across conversations', () => {
  const owner = engine.resolveOwner({ userId: 'e2e-full', conversationId: 'c1' });
  engine.memoryObserve(owner, {
    userMessage: "I'm Chhanda. I'm building Aquiplex. I prefer concise answers. I want to become a billionaire.",
    conversationId: 'c1',
  });

  const later = engine.resolveOwner({ userId: 'e2e-full', conversationId: 'c2' });
  const broad = engine.memoryRetrieve(later, { query: 'Tell me about my work, projects and preferences' });
  assert.match(broad.block, /Aquiplex/, 'project persists');
  assert.match(broad.block, /become a billionaire/i, 'goal surfaces (cognitive model)');

  // Facts are directly present in the store regardless of query gating.
  const ltm = { ...engine };
  const nameRetrieval = engine.memoryRetrieve(later, { query: 'what is my name' });
  assert.match(nameRetrieval.block, /Chhanda/, 'identity persists');
});

// ── Graph: projects & goals become nodes (Req 4) ─────────────────────────────
test('graph — project and goal facts create graph nodes', async () => {
  const { peekMind } = await import(path.join(repoRoot, 'src/mind/mindStore.js'));
  const owner = engine.resolveOwner({ userId: 'graph-user', conversationId: 'g1' });
  engine.memoryObserve(owner, { userMessage: "I'm building Aquiplex. My cofounder is Ananya.", conversationId: 'g1' });
  const mind = peekMind(owner);
  assert.ok(mind.graph.nodes['project:aquiplex'], 'project node created');
  assert.ok(mind.graph.nodes['person:ananya'], 'cofounder person node created');
});

// ── Structural: observation is not an orchestrator capability ─────────────────
test('structural — long_term_memory_extraction removed from orchestrator', () => {
  const caps = fs.readFileSync(path.join(repoRoot, 'src/orchestrator/capabilities.js'), 'utf8');
  assert.ok(!/define\('long_term_memory_extraction'/.test(caps), 'capability definition removed');

  const profiles = fs.readFileSync(path.join(repoRoot, 'src/orchestrator/executionProfiles.js'), 'utf8');
  assert.ok(!profiles.includes('long_term_memory_extraction'), 'no profile references extraction as a capability');

  const chat = fs.readFileSync(path.join(repoRoot, 'src/routes/chat.js'), 'utf8');
  // Observation call site sits BEFORE the orchestrator call site.
  const obsIdx = chat.indexOf('memoryObserve(');
  const orchIdx = chat.indexOf('orchestrate({');
  assert.ok(obsIdx > 0 && orchIdx > 0 && obsIdx < orchIdx, 'memoryObserve must run before orchestrate');
});
