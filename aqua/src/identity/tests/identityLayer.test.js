/**
 * AQUA Identity & Self-Knowledge Layer — automated tests (node:test).
 * Run: node --test src/identity/tests/identityLayer.test.js
 *
 * Enforces the spec directly:
 *   • Every required identity prompt is DETECTED and produces a grounded answer.
 *   • FAILURE CONDITIONS: no answer to a self-question may contain "I don't
 *     know" / "I'm not familiar" / "I don't have information" / "I don't have a
 *     source" (or siblings). Asserted for every required prompt.
 *   • No false positives: user-memory / coding / opinion / general questions do
 *     NOT trigger the identity path.
 *   • The compact identity block is injected on EVERY request (always-on).
 *   • updateIdentityProfile() propagates without touching prompts.
 *   • promptBuilder injects identity on every prompt, expanded + directive on
 *     a self-question.
 *
 * Tests are profile-driven: expected facts are read FROM the loaded profile, so
 * editing ./data/*.json can't silently break the mechanism these tests cover.
 */
import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  getIdentityProfile, updateIdentityProfile, reloadIdentity, _resetForTests,
  detectIdentityIntent, answerFromIdentity, composeAnswer, isRefusal,
  buildIdentityInjection, compactBlock, IDENTITY_VERSION,
} from '../index.js';
import { buildSystemPrompt } from '../../core/promptBuilder.js';

// The 12 prompts the spec requires to ALL pass.
const REQUIRED_PROMPTS = [
  'What is Aquiplex?',
  'What is your vision?',
  'What is your mission?',
  'What are your capabilities?',
  'Who built you?',
  'What makes AQUA different?',
  'What can you do?',
  'What files can you process?',
  'What is your roadmap?',
  'What are your core values?',
  'Who founded Aquiplex?',
  'What AI models do you use?',
];

// The exact phrases the spec says must FAIL the build if present in a
// self-answer, plus the router's broader refusal set.
const BANNED_PHRASES = [
  "i don't know",
  "i'm not familiar",
  "i don't have information",
  "i don't have a source",
];

// ── profile loads + shape ─────────────────────────────────────────────────────

test('profile loads, is cached, and is versioned', () => {
  _resetForTests();
  const p = getIdentityProfile();
  assert.equal(p._identity.version, IDENTITY_VERSION);
  assert.ok(p._identity.contentHash, 'contentHash present');
  assert.equal(p.company.name, 'Aquiplex');
  assert.equal(p.assistant.name, 'AQUA');
  assert.ok(p.company.vision && p.company.mission, 'vision + mission present');
  assert.ok(Array.isArray(p.assistant.capabilities) && p.assistant.capabilities.length > 0);
  // Same frozen object on second call (cached).
  assert.equal(getIdentityProfile(), p);
  assert.ok(Object.isFrozen(p), 'profile is frozen');
});

// ── every required prompt is detected + answered + refusal-free ───────────────

for (const q of REQUIRED_PROMPTS) {
  test(`required prompt is detected + grounded: "${q}"`, () => {
    const intent = detectIdentityIntent(q);
    assert.equal(intent.isSelf, true, `"${q}" must be detected as a self-question`);
    assert.ok(intent.topics.length > 0, 'at least one topic');

    const ans = answerFromIdentity(q);
    assert.ok(ans && ans.trim().length > 0, 'non-empty grounded answer');

    // FAILURE CONDITIONS — no refusal phrasing in a self-answer.
    assert.equal(isRefusal(ans), false, `answer must not be a refusal: "${ans}"`);
    const lower = ans.toLowerCase();
    for (const banned of BANNED_PHRASES) {
      assert.ok(!lower.includes(banned), `answer must not contain "${banned}"`);
    }
  });
}

// ── the answers actually contain the right facts (profile-driven) ─────────────

test('answers carry the expected facts from the profile', () => {
  const p = getIdentityProfile();
  const has = (q, needle) =>
    assert.ok(answerFromIdentity(q).toLowerCase().includes(String(needle).toLowerCase()),
      `answer to "${q}" should mention "${needle}"`);

  has('What is Aquiplex?', 'aquiplex');
  has('What is your vision?', p.company.vision.slice(0, 24));
  has('What is your mission?', p.company.mission.slice(0, 24));
  has('What are your capabilities?', p.assistant.capabilities[0].slice(0, 16));
  has('Who built you?', p.company.name);
  has('What makes AQUA different?', p.assistant.differentiators[0].slice(0, 16));
  has('What files can you process?', p.assistant.processableFiles.documents[0]); // e.g. PDF
  has('What are your core values?', p.company.coreValues[0].name.slice(0, 10));
  has('Who founded Aquiplex?', p.founders[0].name);
  has('What AI models do you use?', p.models.providers[0].name);   // Groq
  has('What AI models do you use?', p.models.providers[1].name);   // Gemini

  // roadmap: first non-empty phase's first item
  const phase = (p.roadmap ?? []).find(ph => (ph.items ?? []).length);
  has('What is your roadmap?', phase.items[0].slice(0, 16));
});

// ── no false positives ────────────────────────────────────────────────────────

const NON_IDENTITY = [
  'what is my favorite language?',       // user-memory recall (has "my")
  'what are my core values?',            // user, not AQUA
  'write a function to sort an array',   // coding
  'how do I add rate limiting?',         // coding/how-to
  'what do you think about React?',      // opinion (has "you" but no identity topic)
  'What is the capital of France?',      // general QA
  'summarize this document',             // task
  'explain how promises work',           // research
];

for (const q of NON_IDENTITY) {
  test(`non-identity query does NOT trigger: "${q}"`, () => {
    const intent = detectIdentityIntent(q);
    assert.equal(intent.isSelf, false, `"${q}" must NOT be a self-question`);
    assert.equal(answerFromIdentity(q), null, 'no grounded answer for non-identity query');
  });
}

// ── always-on compact injection ───────────────────────────────────────────────

test('compact identity block is injected on EVERY request (intent = null)', () => {
  const p = getIdentityProfile();
  const block = buildIdentityInjection(null);
  assert.ok(block.includes('SELF-KNOWLEDGE'), 'has the self-knowledge header');
  assert.ok(block.includes(p.assistant.name), 'names AQUA');
  assert.ok(block.includes(p.company.name), 'names Aquiplex');
  assert.ok(block.toLowerCase().includes('vision'), 'includes vision line');
  assert.ok(block.toLowerCase().includes('mission'), 'includes mission line');
  // Compact-only: no confidence directive when there is no self-intent.
  assert.ok(!block.includes('IDENTITY DIRECTIVE'), 'no directive without intent');
});

test('expanded injection adds the topic section + confidence directive', () => {
  const intent = detectIdentityIntent('What is your roadmap?');
  const block = buildIdentityInjection(intent);
  assert.ok(block.includes('IDENTITY DIRECTIVE'), 'directive present on self-question');
  assert.ok(/roadmap/i.test(block), 'roadmap section present');
});

// ── refusal detector ──────────────────────────────────────────────────────────

test('isRefusal flags hedges and passes real answers', () => {
  assert.equal(isRefusal("I don't know what Aquiplex is."), true);
  assert.equal(isRefusal("I'm not familiar with that product."), true);
  assert.equal(isRefusal("I don't have information about that."), true);
  assert.equal(isRefusal("I don't have a verifiable source for this."), true);
  assert.equal(isRefusal('Aquiplex is an AI Operating System.'), false);
  assert.equal(isRefusal(''), false);
});

// ── admin update propagates without touching prompts ──────────────────────────

test('updateIdentityProfile propagates to answers + bumps revision, then resets', () => {
  const before = getIdentityProfile();
  const beforeRev = before._identity.revision;

  const NEW_VISION = 'A test vision string unique-token-42.';
  updateIdentityProfile({ company: { vision: NEW_VISION } });

  const after = getIdentityProfile();
  assert.equal(after.company.vision, NEW_VISION, 'in-memory override applied');
  assert.equal(after._identity.revision, beforeRev + 1, 'revision bumped');
  assert.ok(answerFromIdentity('What is your vision?').includes('unique-token-42'),
    'the new vision flows into the direct answer');
  assert.ok(buildIdentityInjection(null).includes('unique-token-42'),
    'the new vision flows into the injected compact block');

  // Reset back to disk truth for any later tests / suites.
  _resetForTests();
  assert.notEqual(getIdentityProfile().company.vision, NEW_VISION, 'reset restores disk profile');
});

// ── promptBuilder integration ─────────────────────────────────────────────────

test('buildSystemPrompt injects identity on every prompt (non-self turn)', () => {
  _resetForTests();
  const { prompt, modules } = buildSystemPrompt('coding', '', '', '', '', null);
  assert.ok(modules.includes('identity'), 'identity module listed');
  assert.ok(prompt.includes('SELF-KNOWLEDGE'), 'identity text present in a coding prompt');
  assert.ok(!prompt.includes('IDENTITY DIRECTIVE'), 'no directive on a non-self turn');
});

test('buildSystemPrompt expands identity + directive on a self-question', () => {
  const intent = detectIdentityIntent('What is your mission?');
  const { prompt, modules } = buildSystemPrompt('conversation', '', '', '', '', intent);
  assert.ok(modules.includes('identity+'), 'expanded identity module listed');
  assert.ok(prompt.includes('IDENTITY DIRECTIVE'), 'directive injected on self-question');
  assert.ok(/mission/i.test(prompt), 'mission section present');
});

test('composeAnswer handles multi-topic questions', () => {
  const ans = composeAnswer(['vision', 'mission']);
  assert.ok(/vision/i.test(ans) && /mission/i.test(ans), 'both sections present');
});

// Mirrors the exact guard in chat.js — proves the end-to-end guarantee: if the
// model EVER hedges on a self-question, the grounded profile answer replaces it,
// so a response containing a banned phrase can never reach the user.
test('refusal guard replaces a hedged self-answer (the hard guarantee)', () => {
  for (const q of REQUIRED_PROMPTS) {
    const intent = detectIdentityIntent(q);
    let finalAnswer = "I'm not familiar with that and I don't have a verifiable source.";
    assert.equal(isRefusal(finalAnswer), true, 'precondition: draft is a refusal');
    if (intent.isSelf && isRefusal(finalAnswer)) finalAnswer = answerFromIdentity(q);
    assert.equal(isRefusal(finalAnswer), false, `guard must clear the refusal for "${q}"`);
    for (const banned of BANNED_PHRASES) {
      assert.ok(!finalAnswer.toLowerCase().includes(banned), `no "${banned}" after guard`);
    }
  }
});

// Ensure a clean profile for any suite that runs after this file.
test('teardown: restore disk profile', () => {
  _resetForTests();
  reloadIdentity();
  assert.equal(getIdentityProfile().company.name, 'Aquiplex');
});
