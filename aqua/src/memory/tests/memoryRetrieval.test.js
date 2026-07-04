/**
AQUA Memory v4 — Semantic Retrieval Tests
*/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { storeFact, clearFacts } from '../longTermMemory.js';
import { retrieveRelevantFacts, formatFactsForPrompt } from '../memoryRetriever.js';
import { CATEGORIES } from '../memorySchema.js';

const CONV = 'test-retrieval-' + Date.now();

function clearAll() { clearFacts(CONV); }
beforeEach(() => { clearAll(); });

function store(key, value, category, importance = 5, confidence = 0.9) {
  storeFact(CONV, {
    key, value, category, importance, confidence,
    sourceText: '', ts: Date.now()
  });
}

test('Retrieval: General recall returns top important facts', () => {
  store('name', 'Alice', CATEGORIES.IDENTITY, 10);
  store('hobbies', ['reading'], CATEGORIES.LIFESTYLE, 5);
  store('favorite_food', 'sushi', CATEGORIES.FOOD, 6);
  
  const facts = retrieveRelevantFacts(CONV, 'What do you know about me?');
  assert.ok(facts.length > 0);
  assert.equal(facts[0].key, 'name'); // Highest importance ranks first
});

test('Retrieval: Programming stack semantic match', () => {
  store('favorite_language', 'Rust', CATEGORIES.PREFERENCES, 9);
  store('languages', ['Rust', 'Go'], CATEGORIES.TECHNOLOGY, 7);
  store('favorite_editor', 'VS Code', CATEGORIES.PREFERENCES, 6);
  store('favorite_os', 'Linux', CATEGORIES.PREFERENCES, 5);
  store('favorite_food', 'Pizza', CATEGORIES.FOOD, 8);
  
  const facts = retrieveRelevantFacts(CONV, 'What programming stack do I use?');
  const keys = facts.map(f => f.key);
  assert.ok(keys.includes('favorite_language'));
  assert.ok(keys.includes('languages'));
  assert.ok(keys.includes('favorite_editor'));
  assert.ok(keys.includes('favorite_os'));
  assert.ok(!keys.includes('favorite_food')); // Food correctly excluded
});

test('Retrieval: Category filter - Food', () => {
  store('favorite_food', 'Sushi', CATEGORIES.FOOD, 6);
  store('favorite_language', 'Rust', CATEGORIES.PREFERENCES, 9);
  
  const facts = retrieveRelevantFacts(CONV, 'What food do I like?');
  const keys = facts.map(f => f.key);
  assert.ok(keys.includes('favorite_food'));
  assert.ok(!keys.includes('favorite_language'));
});

test('Retrieval: Context budget limit (Max 15)', () => {
  for (let i = 0; i < 20; i++) {
    store(`custom_${i}`, `value_${i}`, CATEGORIES.CUSTOM, 5);
  }
  const facts = retrieveRelevantFacts(CONV, 'What do you know about me?', 15);
  assert.ok(facts.length <= 15, 'Should respect context budget limit');
});

test('Retrieval: Grouped summaries in prompt injection', () => {
  store('name', 'Alice', CATEGORIES.IDENTITY, 10);
  store('favorite_language', 'Rust', CATEGORIES.PREFERENCES, 9);
  store('favorite_food', 'Sushi', CATEGORIES.FOOD, 6);
  
  const facts = retrieveRelevantFacts(CONV, 'What do you know about me?');
  const prompt = formatFactsForPrompt(facts);
  
  assert.ok(prompt.includes('### Identity'));
  assert.ok(prompt.includes('### Preferences'));
  assert.ok(prompt.includes('### Food'));
  assert.ok(prompt.includes('USER PROFILE & MEMORY'));
});

test('Retrieval: Semantic match - Enjoy', () => {
  store('hobbies', ['hiking'], CATEGORIES.LIFESTYLE, 5);
  store('favorite_movie', 'Inception', CATEGORIES.ENTERTAINMENT, 5);
  store('favorite_language', 'Rust', CATEGORIES.PREFERENCES, 9);
  
  const facts = retrieveRelevantFacts(CONV, 'What do I enjoy?');
  const keys = facts.map(f => f.key);
  assert.ok(keys.includes('hobbies'));
  assert.ok(keys.includes('favorite_movie'));
});

test('Retrieval: Recency boost overrides older facts', () => {
  storeFact(CONV, { key: 'old_fact', value: 'old', category: CATEGORIES.CUSTOM, importance: 5, confidence: 0.9, ts: Date.now() - 1000000 });
  storeFact(CONV, { key: 'new_fact', value: 'new', category: CATEGORIES.CUSTOM, importance: 5, confidence: 0.9, ts: Date.now() });
  
  const facts = retrieveRelevantFacts(CONV, 'Tell me something recent');
  assert.equal(facts[0].key, 'new_fact');
});