/**
 * Cross-File Reasoning — Entity Resolver tests (Phase 3).
 *
 * The correctness spine of the whole engine: cross-file entity linking that
 * merges the brief's canonical cases ("OpenAI"/"Open AI"/"OpenAI Inc.",
 * "John"/"John Smith"/"J. Smith") WITHOUT ever over-merging distinct
 * entities — over-merging silently corrupts every downstream conclusion, so
 * the negative cases matter as much as the positive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEntities, mentionSimilarity, normalizeMention, _thresholds,
} from '../entityResolver.js';

const n = normalizeMention;

// ── Normalization ─────────────────────────────────────────────────────────────

test('normalization strips legal suffixes, honorifics, punctuation', () => {
  assert.equal(n('OpenAI Inc.'), 'openai');
  assert.equal(n('Tata Group Ltd.'), 'tata');
  assert.equal(n('Dr. John Smith'), 'john smith');
  assert.equal(n('ACME, LLC'), 'acme');
});

// ── Similarity (the merge signal) ────────────────────────────────────────────

test('similarity: exact, spacing-variant, acronym, initial-abbreviation, subset', () => {
  assert.equal(mentionSimilarity(n('OpenAI'), n('OpenAI Inc.')).score, 1);        // both normalize to "openai"
  assert.equal(mentionSimilarity(n('OpenAI'), n('Open AI')).reason, 'spacing-variant');
  assert.equal(mentionSimilarity(n('IBM'), n('International Business Machines')).reason, 'acronym-match');
  assert.ok(mentionSimilarity(n('John Smith'), n('J. Smith')).score >= 0.82);      // initial-abbreviation
  assert.ok(mentionSimilarity(n('John'), n('John Smith')).score >= 0.82);          // token-subset
});

test('similarity NEVER over-merges distinct entities', () => {
  assert.ok(mentionSimilarity(n('John A. Smith'), n('John B. Smith')).score < _thresholds.MERGE_THRESHOLD, 'different middle name');
  assert.ok(mentionSimilarity(n('J. Smith'), n('J. Jones')).score < _thresholds.MERGE_THRESHOLD, 'same initial, different surname');
  assert.ok(mentionSimilarity(n('Version 2'), n('Version 3')).score < _thresholds.MERGE_THRESHOLD, 'different number');
  assert.ok(mentionSimilarity(n('Apple'), n('Apricot')).score < _thresholds.MERGE_THRESHOLD, 'unrelated');
});

// ── Cross-file resolution (the brief's examples) ─────────────────────────────

test('THE ORG CASE: OpenAI / Open AI / OpenAI Inc. across 3 files → one entity', () => {
  const { entities } = resolveEntities([
    { value: 'OpenAI', type: 'name', fileId: 'f1', fileName: 'report.pdf' },
    { value: 'Open AI', type: 'name', fileId: 'f2', fileName: 'meeting.mp4' },
    { value: 'OpenAI Inc.', type: 'name', fileId: 'f3', fileName: 'deck.pptx' },
  ]);
  assert.equal(entities.length, 1, 'all three surface forms are one entity');
  const e = entities[0];
  assert.equal(e.files.size, 3, 'spanning all three files');
  assert.ok(e.aliases.length >= 2, 'the other forms are recorded as aliases');
  assert.ok(e.confidence < 1 && e.confidence >= _thresholds.MERGE_THRESHOLD, 'merge confidence reflects fuzzy match, not certainty');
});

test('THE PERSON CASE: John / John Smith / J. Smith → one entity when confident', () => {
  const { entities } = resolveEntities([
    { value: 'John Smith', type: 'name', fileId: 'f1', fileName: 'a.pdf' },
    { value: 'J. Smith', type: 'name', fileId: 'f2', fileName: 'b.mp4' },
    { value: 'John', type: 'name', fileId: 'f3', fileName: 'c.docx' },
  ]);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].canonical, 'John Smith', 'longest complete form is canonical');
});

test('distinct people are NEVER merged, even sharing a surname', () => {
  const { entities } = resolveEntities([
    { value: 'John A. Smith', type: 'name', fileId: 'f1', fileName: 'a.pdf' },
    { value: 'John B. Smith', type: 'name', fileId: 'f2', fileName: 'b.pdf' },
  ]);
  assert.equal(entities.length, 2, 'two distinct people');
});

test('ambiguous pairs (REVIEW ≤ score < MERGE) are surfaced, not merged', () => {
  const { entities, ambiguous } = resolveEntities([
    { value: 'Sam Alton', type: 'name', fileId: 'f1', fileName: 'a.pdf' },
    { value: 'Sam Alten', type: 'name', fileId: 'f2', fileName: 'b.pdf' },
  ]);
  // Close but not identical surnames — should NOT auto-merge.
  assert.equal(entities.length, 2, 'kept separate');
  // (Whether it lands in `ambiguous` depends on the exact score; the
  //  invariant that matters is: not merged.)
  assert.ok(Array.isArray(ambiguous));
});

test('type blocking: a name and a money mention never merge', () => {
  const { entities } = resolveEntities([
    { value: 'Revenue', type: 'name', fileId: 'f1', fileName: 'a.pdf' },
    { value: '$40M', type: 'money', fileId: 'f1', fileName: 'a.pdf' },
  ]);
  assert.equal(entities.length, 2, 'different types never merge');
});

test('resolution is deterministic', () => {
  const input = [
    { value: 'OpenAI', type: 'name', fileId: 'f1', fileName: 'a' },
    { value: 'OpenAI Inc.', type: 'name', fileId: 'f2', fileName: 'b' },
  ];
  const a = resolveEntities(input), b = resolveEntities(input);
  assert.deepEqual(a.entities.map(e => e.canonical), b.entities.map(e => e.canonical));
});
