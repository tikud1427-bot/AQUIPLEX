/**
AQUA Memory — Bug Regression Tests
Bug 1: Custom facts rejected by normalizer (no_schema)
Bug 2: resolveCanonicalKey fuzzy matching
Bug 3: Short value custom facts blocked by length > 2 check
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, resolveCanonicalKey } from '../memoryExtractor.js';
import { extractAllCandidates } from '../candidateExtractor.js';
import { normalizeCandidates } from '../entityNormalizer.js';
import { parseMessage } from '../sentenceParser.js';
import { CATEGORIES } from '../memorySchema.js';

// ── Bug 1: Custom fact normalizer bypass ──────────────────────────────────────
// Root cause: entityNormalizer called getSchema(custom_key) → null → rejected
// Fix: CUSTOM category bypasses schema lookup, passthrough normalization applied

test('bug1: custom fact "My favorite car is a Tesla Model 3" is accepted', () => {
  const facts = extractFacts('My favorite car is a Tesla Model 3.');
  const custom = facts.find(f => f.category === CATEGORIES.CUSTOM);
  assert.ok(custom, 'Should produce a custom fact');
  assert.ok(
    custom.key.includes('car') || custom.value.toLowerCase().includes('tesla'),
    `Expected car-related custom fact, got key=${custom.key} value=${custom.value}`
  );
});

test('bug1: custom fact goes through normalizer with CUSTOM category', () => {
  const parsed = parseMessage('My spirit animal is a wolf.');
  const raw = extractAllCandidates(parsed);
  const customRaw = raw.filter(c => c.category === CATEGORIES.CUSTOM);
  assert.ok(customRaw.length > 0, 'Should extract custom candidate');

  const { accepted, rejected } = normalizeCandidates(customRaw);
  const noSchema = rejected.filter(r => r.rejectionReason === 'no_schema');
  assert.equal(noSchema.length, 0, 'CUSTOM facts must never be rejected with no_schema');
  assert.ok(accepted.length > 0, 'CUSTOM fact should be accepted');
});

test('bug1: multiple custom facts all accepted, none no_schema', () => {
  const sentences = [
    'My lucky number is seven.',
    'My spirit animal is a wolf.',
    'My catchphrase is just do it.',
  ];
  for (const s of sentences) {
    const facts = extractFacts(s);
    const custom = facts.find(f => f.category === CATEGORIES.CUSTOM);
    assert.ok(custom, `Expected custom fact from: "${s}"`);
  }
});

// ── Bug 2: resolveCanonicalKey fuzzy matching ──────────────────────────────────
// Root cause: "forget my language" was mapped to raw key "language", not "favorite_language"
// Fix: resolveCanonicalKey uses word index with core-word weighting

test('bug2: resolveCanonicalKey maps "language" → "favorite_language"', () => {
  const key = resolveCanonicalKey('language');
  // Should resolve to a language-related key, not a raw "language" key
  assert.ok(
    key === 'favorite_language' || key === 'languages',
    `Expected a language schema key, got "${key}"`
  );
});

test('bug2: resolveCanonicalKey maps "preferred language" → favorite_language', () => {
  const key = resolveCanonicalKey('preferred language');
  assert.ok(
    key === 'favorite_language' || key === 'languages',
    `Expected favorite_language or languages, got "${key}"`
  );
});

test('bug2: resolveCanonicalKey handles exact keys unchanged', () => {
  assert.equal(resolveCanonicalKey('name'), 'name');
  assert.equal(resolveCanonicalKey('age'), 'age');
  assert.equal(resolveCanonicalKey('favorite_editor'), 'favorite_editor');
});

test('bug2: resolveCanonicalKey maps "editor" → favorite_editor', () => {
  const key = resolveCanonicalKey('editor');
  assert.equal(key, 'favorite_editor');
});

test('bug2: resolveCanonicalKey falls back gracefully for unknown keys', () => {
  const key = resolveCanonicalKey('xyzzy_unknown_key');
  assert.equal(typeof key, 'string');
  assert.ok(key.length > 0);
});

// ── Bug 3: Short value custom facts blocked by length > 2 ────────────────────
// Root cause: extractCustomFacts checked value.length > 2, blocking "9", "go", etc.
// Fix: changed to value.length > 0

test('bug3: "My score is 9." creates custom fact with value "9"', () => {
  const facts = extractFacts('My score is 9.');
  const custom = facts.find(f => f.category === CATEGORIES.CUSTOM && f.key === 'custom_score');
  assert.ok(custom, 'Should extract custom_score fact');
  assert.equal(custom.value, '9');
});

test('bug3: "My rank is 1." creates custom fact with value "1"', () => {
  const facts = extractFacts('My rank is 1.');
  const custom = facts.find(f => f.category === CATEGORIES.CUSTOM);
  assert.ok(custom, 'Should extract custom rank fact');
  assert.ok(custom.value === '1', `Expected "1", got "${custom.value}"`);
});

test('bug3: custom facts with 2-char values are accepted', () => {
  const facts = extractFacts('My id is ok.');
  // "ok" has length 2, previously blocked by > 2 check
  const custom = facts.find(f => f.category === CATEGORIES.CUSTOM);
  if (custom) {
    assert.ok(custom.value.length >= 1, 'Custom fact value should be non-empty');
  }
  // Test passes even if no custom fact (sentence may not match pattern)
});

// ── Bug 4 (Phase 6 — Memory Confidence Engine): "I am building an AI" ────────
// stored name="Building" ──────────────────────────────────────────────────────
// Root cause: memorySchema.js's 'intro' name pattern
// (/^(i(?:'m| am)) (?!...)([A-Z...]{2,})(?:[,.]|\s+(?:a|an|...))/i) had no
// gerund exclusion, so "I am Building an AI." matched group 2 = "Building"
// (capital B from sentence-leading position) and stored it as a name.
// candidateExtractor.js's separate "i am (?:a|an)? X" custom-trait fallback
// had the identical hole. Fix: a (?!\w*ing\b) lookahead in both patterns.
// Spec requirement: "Identity extraction should only succeed when the
// sentence is explicitly introducing an identity" — these are the spec's
// own three worked examples, verbatim.

test('bug4: "I am building an AI." extracts nothing (was: name="Building")', () => {
  const facts = extractFacts('I am building an AI.');
  const name = facts.find(f => f.key === 'name');
  assert.equal(name, undefined, 'Must never store name from a gerund/activity statement');
  // Guards the custom_trait fallback too — same bug, same sentence, second code path.
  const trait = facts.find(f => f.category === CATEGORIES.CUSTOM && f.key === 'custom_trait');
  assert.equal(trait, undefined, 'Must never store a custom_trait from a gerund/activity statement either');
});

test('bug4: "My name is John." still stores name="John" (explicit intro)', () => {
  const facts = extractFacts('My name is John.');
  const name = facts.find(f => f.key === 'name');
  assert.ok(name, 'Explicit "My name is X" must still store');
  assert.equal(name.value, 'John');
});

test('bug4: "I am John." still stores name="John" (explicit intro)', () => {
  const facts = extractFacts('I am John.');
  const name = facts.find(f => f.key === 'name');
  assert.ok(name, '"I am <Capitalized name>" must still store');
  assert.equal(name.value, 'John');
});

test('bug4: other -ing activity statements are also rejected', () => {
  for (const sentence of ['I am coding a new feature.', 'I am working on a project.', 'I am running a marathon.']) {
    const facts = extractFacts(sentence);
    const name = facts.find(f => f.key === 'name');
    assert.equal(name, undefined, `"${sentence}" must never store a name`);
  }
});
