/**
 * Unit tests — AQUA Memory Conflict Resolver
 *
 * Run: node --test src/memory/tests/memoryConflictResolver.test.js
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { detectCorrection, resolveMemoryConflict } from '../memoryConflictResolver.js';

// ── detectCorrection ──────────────────────────────────────────────────────────

test('detectCorrection — "Actually" at start', () => {
  const r = detectCorrection('Actually my favorite language is Go.');
  assert.equal(r.isCorrection, true);
  assert.ok(r.phrase);
});

test('detectCorrection — "No," at start', () => {
  const r = detectCorrection('No, I live in Delhi now.');
  assert.equal(r.isCorrection, true);
});

test('detectCorrection — "I now use" mid-sentence', () => {
  const r = detectCorrection('I changed my setup, I now use Linux.');
  assert.equal(r.isCorrection, true);
});

test('detectCorrection — "From now on" at start', () => {
  const r = detectCorrection('From now on, call me Alex.');
  assert.equal(r.isCorrection, true);
});

test('detectCorrection — "I no longer" phrase', () => {
  const r = detectCorrection("I no longer own a dog.");
  assert.equal(r.isCorrection, true);
});

test('detectCorrection — neutral statement returns false', () => {
  const r = detectCorrection('My favorite language is Rust.');
  assert.equal(r.isCorrection, false);
});

test('detectCorrection — empty string returns false', () => {
  const r = detectCorrection('');
  assert.equal(r.isCorrection, false);
});

test('detectCorrection — null input returns false gracefully', () => {
  const r = detectCorrection(null);
  assert.equal(r.isCorrection, false);
});

// ── resolveMemoryConflict ─────────────────────────────────────────────────────

const BASE_TS = 1_000_000;

function makeFact(overrides = {}) {
  return {
    key:        'favorite_language',
    value:      'Rust',
    confidence: 0.90,
    ts:         BASE_TS,
    ...overrides,
  };
}

// Test 1 — no existing fact → always overwrite
test('resolveMemoryConflict — no existing → overwrite', () => {
  const r = resolveMemoryConflict(makeFact({ value: 'Go' }), null);
  assert.equal(r.action, 'overwrite');
  assert.equal(r.reason, 'no_existing');
});

// Test 2 — identical value → keep (no spurious history)
test('resolveMemoryConflict — identical value → keep', () => {
  const existing = makeFact({ value: 'Python' });
  const incoming = makeFact({ value: 'Python', ts: BASE_TS + 100 });
  const r = resolveMemoryConflict(incoming, existing);
  assert.equal(r.action, 'keep');
  assert.equal(r.reason, 'identical_value');
});

// Test 3 — explicit correction always wins regardless of confidence
test('resolveMemoryConflict — explicit correction wins even at lower confidence', () => {
  const existing = makeFact({ value: 'Rust', confidence: 0.95, ts: BASE_TS });
  const incoming = makeFact({ value: 'Go',  confidence: 0.75, ts: BASE_TS, isCorrection: true });
  const r = resolveMemoryConflict(incoming, existing);
  assert.equal(r.action, 'overwrite');
  assert.equal(r.reason, 'explicit_correction');
});

// Test 4 — newer timestamp wins (no correction phrase)
test('resolveMemoryConflict — newer timestamp → overwrite', () => {
  const existing = makeFact({ value: 'VSCode', ts: BASE_TS });
  const incoming = makeFact({ value: 'Cursor', ts: BASE_TS + 1000 });
  const r = resolveMemoryConflict(incoming, existing);
  assert.equal(r.action, 'overwrite');
  assert.equal(r.reason, 'newer_timestamp');
});

// Test 5 — older timestamp, same confidence → keep
test('resolveMemoryConflict — older timestamp + same confidence → keep', () => {
  const existing = makeFact({ value: 'Python', confidence: 0.90, ts: BASE_TS + 5000 });
  const incoming = makeFact({ value: 'Go',     confidence: 0.90, ts: BASE_TS });
  const r = resolveMemoryConflict(incoming, existing);
  assert.equal(r.action, 'keep');
  assert.equal(r.reason, 'existing_wins');
});

// Test 6 — higher confidence tiebreaker (same timestamp)
test('resolveMemoryConflict — higher confidence at same ts → overwrite', () => {
  const existing = makeFact({ value: 'Python', confidence: 0.75, ts: BASE_TS });
  const incoming = makeFact({ value: 'Go',     confidence: 0.90, ts: BASE_TS });
  const r = resolveMemoryConflict(incoming, existing);
  assert.equal(r.action, 'overwrite');
  assert.equal(r.reason, 'higher_confidence');
});

// Test 7 — confidence NEVER blocks correction
test('resolveMemoryConflict — correction overrides high-confidence existing', () => {
  const existing = makeFact({ value: 'Java', confidence: 0.99, ts: BASE_TS });
  const incoming = makeFact({ value: 'Zig',  confidence: 0.50, ts: BASE_TS - 1, isCorrection: true });
  const r = resolveMemoryConflict(incoming, existing);
  assert.equal(r.action, 'overwrite');
  assert.equal(r.reason, 'explicit_correction');
});

// Test 8 — case-insensitive identical value check
test('resolveMemoryConflict — same value different case → keep', () => {
  const existing = makeFact({ value: 'python' });
  const incoming = makeFact({ value: 'Python', ts: BASE_TS + 500 });
  const r = resolveMemoryConflict(incoming, existing);
  assert.equal(r.action, 'keep');
  assert.equal(r.reason, 'identical_value');
});

console.log('\n✅ All unit tests passed.\n');
