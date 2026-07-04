/**
AQUA Memory v3.1 — Integration Tests
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, extractFactsWithReport, extractCandidates } from '../memoryExtractor.js';
import { parseMessage } from '../sentenceParser.js';
import { extractAllCandidates } from '../candidateExtractor.js';
import { normalizeCandidates } from '../entityNormalizer.js';
import { deduplicateIntraMessage } from '../duplicateDetector.js';
import { resolveCandidates, RESOLUTION_ACTIONS } from '../memoryResolver.js';
import { retrieveRelevantFacts, formatFactsForPrompt, isMemoryQuery } from '../memoryRetriever.js';
import { storeFact, storeResolved, getFact, getFacts, getFactHistory, clearFacts } from '../longTermMemory.js';
import { resolveCollectionMerge, detectContradiction, detectCorrection } from '../memoryConflictResolver.js';
import { MEMORY_SCHEMA, getSchema, CATEGORIES } from '../memorySchema.js';

function findByKey(facts, key) { return facts.find((f) => f.key === key); }
function clearAll() { clearFacts('test-conv'); }

// ── 25+ Facts in One Message ──────────────────────────────────────────────────
test('extractor: 25+ facts in one massive message', () => {
  const msg = `My name is John. I'm 27. I live in London, England. My birthday is July 4. 
  My dog Bruno is 6 and my cat Luna is 3. I work as a pediatric doctor at Great Ormond Street. 
  I adore Rust. I can't stand Java. My favorite food is sushi. I hate eating broccoli. 
  I spend weekends hiking and reading. My goal is to build an AI startup. I use Visual Studio Code. 
  I run Ubuntu. My favorite color is blue. I have a son named Leo. My wife is Sarah.`;
  
  const facts = extractFacts(msg);
  assert.ok(facts.length >= 20, `Should extract 20+ facts, got ${facts.length}`);
  
  assert.equal(findByKey(facts, 'name').value, 'John');
  assert.equal(findByKey(facts, 'age').value, 27);
  assert.equal(findByKey(facts, 'city').value, 'London');
  assert.equal(findByKey(facts, 'country').value, 'United Kingdom'); // Location context normalization
  assert.equal(findByKey(facts, 'profession').value, 'pediatric doctor');
  assert.equal(findByKey(facts, 'favorite_language').value, 'rust'); // Semantic "adore"
  assert.ok(findByKey(facts, 'least_favorite_language').value.includes('java')); // Semantic "can't stand"
  assert.equal(findByKey(facts, 'favorite_food').value, 'sushi');
  assert.ok(findByKey(facts, 'disliked_food').value.includes('broccoli'));
  assert.ok(findByKey(facts, 'hobbies').value.includes('hiking'));
  assert.equal(findByKey(facts, 'favorite_editor').value, 'visual studio code'); // Editor normalization
  assert.equal(findByKey(facts, 'favorite_os').value, 'linux'); // OS normalization
  assert.equal(findByKey(facts, 'favorite_color').value, 'blue');
});

// ── Semantic Extraction ───────────────────────────────────────────────────────
test('extractor: semantic extraction for languages', () => {
  const facts = extractFacts('I mainly write Go. I absolutely despise PHP.');
  assert.ok(facts.some(f => f.key === 'languages' && f.value.includes('go')));
  assert.ok(facts.some(f => f.key === 'least_favorite_language' && f.value.includes('php')));
});

// ── Normalization ─────────────────────────────────────────────────────────────
test('normalizer: handles aliases and maps correctly', () => {
  const facts = extractFacts('I use VSCode on my Mac. I code in JS and TS.');
  assert.equal(findByKey(facts, 'favorite_editor').value, 'visual studio code');
  assert.equal(findByKey(facts, 'favorite_os').value, 'macos');
  const langs = findByKey(facts, 'languages').value;
  assert.ok(langs.includes('javascript'));
  assert.ok(langs.includes('typescript'));
});

test('normalizer: country mapping', () => {
  const facts = extractFacts('I am from the USA.');
  assert.equal(findByKey(facts, 'country').value, 'United States');
});

// ── Location Parsing Bug Fix ──────────────────────────────────────────────────
test('extractor: location context parsing (City, Country)', () => {
  const facts = extractFacts('I live in Paris, France.');
  assert.equal(findByKey(facts, 'city').value, 'Paris');
  assert.equal(findByKey(facts, 'country').value, 'France');
  
  const facts2 = extractFacts('I am based in London, England.');
  assert.equal(findByKey(facts2, 'city').value, 'London');
  assert.equal(findByKey(facts2, 'country').value, 'United Kingdom');
});

// ── Unknown Facts (Custom Category) ───────────────────────────────────────────
test('extractor: unknown facts become custom memories', () => {
  const facts = extractFacts('My favorite car is a Tesla Model 3.');
  const custom = facts.find(f => f.category === 'custom');
  assert.ok(custom, 'Should extract custom fact');
  assert.ok(custom.key.includes('car') || custom.value.includes('Tesla'));
});

// ── Confidence Assignment ─────────────────────────────────────────────────────
test('extractor: dynamic confidence adjustment', () => {
  const facts1 = extractFacts('I definitely live in Berlin.');
  const facts2 = extractFacts('I guess I live in Berlin.');
  
  const conf1 = findByKey(facts1, 'city').confidence;
  const conf2 = findByKey(facts2, 'city').confidence;
  assert.ok(conf1 > conf2, 'Explicit statement should have higher confidence than hedging');
});

// ── Previous Tests Compatibility ──────────────────────────────────────────────
test('sentenceParser: splits multi-sentence messages', () => {
  const parsed = parseMessage('My name is Alice. I live in Berlin. I love Rust.');
  assert.equal(parsed.sentences.length, 3);
});

test('extractor: multiple pets in one message', () => {
  const facts = extractFacts('I have a dog named Bruno. My cat is Luna.');
  const pets = findByKey(facts, 'pets');
  assert.ok(Array.isArray(pets.value));
  assert.ok(pets.value.some(p => p.name === 'Bruno'));
  assert.ok(pets.value.some(p => p.name === 'Luna'));
});

test('extractor: family members', () => {
  const facts = extractFacts('My wife Sarah is a teacher. My son Leo is 5.');
  assert.equal(findByKey(facts, 'spouse').value, 'Sarah');
  assert.ok(findByKey(facts, 'children'));
});

test('resolver: duplicate detection returns DUPLICATE action', () => {
  clearAll();
  storeFact('test-conv', { key: 'name', value: 'Alice', confidence: 0.95, importance: 10, sourceText: 'My name is Alice.', ts: 1000 });
  const facts = extractFactsWithReport('My name is Alice.', 'test-conv');
  assert.ok(facts.report.duplicates >= 1);
});

test('cleanup', () => { clearAll(); });