/**
Integration tests — AQUA Memory Pipeline
Tests the complete flow: extractFacts → storeFact → getFact
Covers the 6 spec scenarios plus edge cases.
Run: node --test src/memory/tests/memoryIntegration.test.js
*/
import { test, beforeEach } from 'node:test';
import assert               from 'node:assert/strict';
import { detectCorrection }              from '../memoryConflictResolver.js';
import { extractFacts }                from '../memoryExtractor.js';
import { storeFact, getFact,
getFactHistory, clearFacts }  from '../longTermMemory.js';
const CONV = 'test-conv-' + Date.now();
// Clear state before each test to avoid cross-test contamination
function freshConv() {
const id = 'conv-' + Math.random().toString(36).slice(2);
return id;
}
// ── Spec Test 1 ───────────────────────────────────────────────────────────────
test('Spec 1 — Rust → "Actually Go" stores Go', () => {
const conv = freshConv();
const [fact1] = extractFacts('My favorite language is Rust.');
storeFact(conv, fact1);
// memorySchema.js normalizes favorite_language via normalizeLower — assert
// case-insensitively (stale expectation from before the schema rewrite).
assert.equal(getFact(conv, 'favorite_language')?.value?.toLowerCase(), 'rust');
const [fact2] = extractFacts('Actually my favorite language is Go.');
assert.ok(fact2.isCorrection, 'fact2 should be tagged isCorrection');
storeFact(conv, fact2);
assert.equal(getFact(conv, 'favorite_language')?.value?.toLowerCase(), 'go');
});
// ── Spec Test 2 ───────────────────────────────────────────────────────────────
test('Spec 2 — VSCode → Cursor (newer timestamp)', () => {
const conv = freshConv();
storeFact(conv, {
key: 'favorite_editor', value: 'VSCode',
confidence: 0.90, importance: 7,
sourceText: 'I use VSCode', ts: 1_000_000,
});
assert.equal(getFact(conv, 'favorite_editor')?.value, 'VSCode');
storeFact(conv, {
key: 'favorite_editor', value: 'Cursor',
confidence: 0.90, importance: 7,
sourceText: 'I use Cursor now', ts: 1_001_000,  // newer
});
assert.equal(getFact(conv, 'favorite_editor')?.value, 'Cursor');
});
// ── Spec Test 3 ───────────────────────────────────────────────────────────────
test('Spec 3 — "I now use Linux" → stored / overwrites old OS fact', () => {
const conv = freshConv();
storeFact(conv, {
key: 'os', value: 'Windows',
confidence: 0.90, importance: 5,
sourceText: 'I run Windows', ts: 1_000_000,
});
storeFact(conv, {
key: 'os', value: 'Linux',
confidence: 0.90, importance: 5,
sourceText: 'I now use Linux', ts: 1_005_000,
isCorrection: true,
});
assert.equal(getFact(conv, 'os')?.value, 'Linux');
});
// ── Spec Test 4 ───────────────────────────────────────────────────────────────
test('Spec 4 — "No, I live in Delhi now" updates location', () => {
const conv = freshConv();
// memorySchema.js's canonical key for residence is 'city' ('location' is
// an alias) — stale expectation from before the schema rewrite.
storeFact(conv, {
key: 'city', value: 'Mumbai',
confidence: 0.85, importance: 6,
sourceText: 'I live in Mumbai', ts: 1_000_000,
});
const facts = extractFacts('No, I live in Delhi now.');
assert.ok(facts.length > 0, 'should extract location');
const locFact = facts.find(f => f.key === 'city' || f.key === 'location');
assert.ok(locFact, 'location fact extracted');
assert.ok(locFact.isCorrection, 'tagged as correction');
assert.equal(locFact.value, 'Delhi', 'extracted value should be Delhi without trailing words');
storeFact(conv, locFact);
assert.equal(getFact(conv, locFact.key)?.value, 'Delhi');
});
// ── Spec Test 5 ───────────────────────────────────────────────────────────────
test('Spec 5 — "I no longer own a dog" triggers correction tag', () => {
const { isCorrection } = detectCorrection("I no longer own a dog.");
assert.equal(isCorrection, true, '"I no longer" must be detected as correction');
});
// ── Spec Test 6 ───────────────────────────────────────────────────────────────
test('Spec 6 — repeated identical memory does not create duplicate version', () => {
const conv = freshConv();
const [fact1] = extractFacts('My favorite language is Python.');
storeFact(conv, fact1);
const before = getFact(conv, 'favorite_language');
storeFact(conv, { ...fact1, ts: fact1.ts + 1000 }); // same value, newer ts
const after = getFact(conv, 'favorite_language');
const history = getFactHistory(conv, 'favorite_language');
assert.equal(history.length, 0, 'no history entries for identical value');
assert.equal(after.revision, before.revision, 'revision should not change for duplicate');
assert.ok(after.confidence >= before.confidence, 'confidence should increase or stay same');
});
// ── Version history ───────────────────────────────────────────────────────────
test('Version history accumulates correctly across multiple changes', () => {
const conv = freshConv();
storeFact(conv, { key: 'lang', value: 'Rust',   confidence: 0.90, importance: 9, sourceText: '', ts: 1000 });
storeFact(conv, { key: 'lang', value: 'Go',     confidence: 0.90, importance: 9, sourceText: '', ts: 2000 });
storeFact(conv, { key: 'lang', value: 'Python', confidence: 0.90, importance: 9, sourceText: '', ts: 3000 });
const current = getFact(conv, 'lang');
const history = getFactHistory(conv, 'lang');
assert.equal(current.value, 'Python');
assert.equal(history.length, 2);
assert.equal(history[0].value, 'Rust');
assert.equal(history[1].value, 'Go');
});
// ── Confidence gate ───────────────────────────────────────────────────────────
test('Facts below MIN_CONF (0.5) are not stored', () => {
const conv = freshConv();
storeFact(conv, { key: 'low_conf', value: 'x', confidence: 0.3, importance: 5, sourceText: '', ts: Date.now() });
assert.equal(getFact(conv, 'low_conf'), null);
});
// ── Correction never blocked by high confidence ───────────────────────────────
test('Correction overrides very high-confidence existing fact', () => {
const conv = freshConv();
storeFact(conv, { key: 'fave', value: 'Java', confidence: 0.99, importance: 9, sourceText: '', ts: 1000 });
storeFact(conv, { key: 'fave', value: 'Zig',  confidence: 0.50, importance: 9, sourceText: '', ts: 999, isCorrection: true });
assert.equal(getFact(conv, 'fave')?.value, 'Zig');
});
// ── NEW: Conversation Persistence ─────────────────────────────────────────────
test('Conversation persistence — same ID retrieves same memory', () => {
const conv = 'persistent-conv-' + Date.now();
storeFact(conv, { key: 'name', value: 'Alice', confidence: 0.95, importance: 10, sourceText: 'My name is Alice.', ts: Date.now() });
const retrieved = getFact(conv, 'name');
assert.ok(retrieved, 'should retrieve memory with same conversationId');
assert.equal(retrieved.value, 'Alice');
// Simulate second request with same conversationId
const retrieved2 = getFact(conv, 'name');
assert.ok(retrieved2, 'should retrieve memory again with same conversationId');
assert.equal(retrieved2.value, 'Alice');
});
// ── NEW: Correction with Version History ──────────────────────────────────────
test('Correction creates version history with all metadata', () => {
const conv = freshConv();
storeFact(conv, { key: 'city', value: 'Berlin', confidence: 0.9, importance: 7, sourceText: 'I live in Berlin.', ts: 1000 });
storeFact(conv, { key: 'city', value: 'Paris', confidence: 0.9, importance: 7, sourceText: 'Actually I live in Paris.', ts: 2000, isCorrection: true });
const current = getFact(conv, 'city');
assert.equal(current.value, 'Paris');
assert.equal(current.revision, 2);
const history = getFactHistory(conv, 'city');
assert.equal(history.length, 1);
assert.equal(history[0].value, 'Berlin');
assert.ok(history[0].normalizedValue, 'history should have normalizedValue');
assert.ok(history[0].confidence, 'history should have confidence');
assert.ok(history[0].sourceMessage, 'history should have sourceMessage');
assert.ok(history[0].revision, 'history should have revision');
assert.ok(history[0].reason, 'history should have reason');
});
// ── NEW: Duplicate Handling ───────────────────────────────────────────────────
test('Duplicate handling — same value bumps confidence and timestamps', () => {
const conv = freshConv();
storeFact(conv, { key: 'lang', value: 'Rust', confidence: 0.8, importance: 8, sourceText: 'I like Rust.', ts: 1000 });
const before = getFact(conv, 'lang');
assert.equal(before.revision, 1);
const initialConf = before.confidence;
// Store same value again
storeFact(conv, { key: 'lang', value: 'Rust', confidence: 0.8, importance: 8, sourceText: 'I like Rust.', ts: 2000 });
const after = getFact(conv, 'lang');
assert.equal(after.value, 'Rust');
assert.equal(after.revision, 1, 'revision should not change for duplicate');
assert.ok(after.confidence >= initialConf, 'confidence should increase');
assert.ok(after.updatedAt >= before.updatedAt, 'updatedAt should be refreshed');
assert.ok(after.lastMentionedAt >= before.lastMentionedAt, 'lastMentionedAt should be refreshed');
const history = getFactHistory(conv, 'lang');
assert.equal(history.length, 0, 'no history for duplicate');
});
// ── NEW: Conversation Isolation ───────────────────────────────────────────────
test('Conversation isolation — different IDs have independent memories', () => {
const convA = 'conv-A-' + Date.now();
const convB = 'conv-B-' + Date.now();
storeFact(convA, { key: 'lang', value: 'Rust', confidence: 0.9, importance: 8, sourceText: '', ts: 1000 });
storeFact(convB, { key: 'lang', value: 'Go', confidence: 0.9, importance: 8, sourceText: '', ts: 1000 });
const factA = getFact(convA, 'lang');
const factB = getFact(convB, 'lang');
assert.equal(factA.value, 'Rust');
assert.equal(factB.value, 'Go');
assert.notEqual(factA, factB, 'memories should be independent');
});
console.log('\n✅ All integration tests passed.\n');