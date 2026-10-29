/**
 * Slot validators that let anything in (2026-10-28).
 *
 * Production: "Least favorite language = loveit" — the language slots took any
 * word after "I hate / I love" ("I hate mondays" → least_favorite_language=
 * mondays; "I hate it, I love it" filled both with "it"). And "Profession:
 * billionaire 90%" — "I am a billionaire" filled the profession slot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-slots-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
const { extractFacts } = await import('../memoryExtractor.js');
const slots = s => Object.fromEntries(extractFacts(s).map(f => [f.key, f.value]));

test('a language slot holds a programming language, not any word after "hate"/"love"', () => {
  for (const s of ['I hate loveit', 'I hate mondays', 'I hate it', 'I despise meetings', "I can't stand when people are late"]) {
    assert.equal(slots(s).least_favorite_language, undefined, s);
  }
  const both = slots('i hate it, i love it');
  assert.equal(both.favorite_language, undefined);
  assert.equal(both.least_favorite_language, undefined);
  // positive controls
  assert.equal(slots('I hate Java').least_favorite_language, 'java');
  assert.equal(slots("I can't stand PHP").least_favorite_language, 'php');
  assert.equal(slots('I love Rust').favorite_language, 'rust');
  assert.equal(slots('My favorite language is TypeScript').favorite_language, 'typescript');
  assert.equal(slots('I mostly use JS').favorite_language, 'javascript');
});

test('a goal never fills the profession slot', () => {
  for (const s of ['I am a billionaire', "I'm a future billionaire", "I'm an aspiring billionaire", 'I work as a millionaire']) {
    assert.equal(slots(s).profession, undefined, s);
  }
  assert.equal(slots('I am a founder').profession, 'founder');
  assert.equal(slots("I'm a software engineer at Acme").profession, 'software engineer');
  assert.equal(slots("I'm a student").profession, 'student');
});
